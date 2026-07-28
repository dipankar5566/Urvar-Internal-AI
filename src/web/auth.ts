import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { loginRateLimiter } from './rate-limit.js';

// No per-user accounts (see CLAUDE.md "Web UI" section) — two shared
// passwords determine role, and the session is a stateless HMAC-signed
// cookie (no session store / DB table).

export type WebRole = 'owner' | 'member';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webRole?: WebRole;
    }
  }
}

const COOKIE_NAME = 'urvar_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(payload: string): string {
  return createHmac('sha256', config.webSessionSecret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function issueCookie(res: Response, role: WebRole): void {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + SESSION_TTL_MS })).toString(
    'base64url',
  );
  const value = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
}

// Hand-rolled single-cookie read — avoids adding a cookie-parser dependency
// for one cookie.
function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rawVal] = part.trim().split('=');
    if (rawName === COOKIE_NAME) return rawVal.join('=');
  }
  return null;
}

function verifyCookie(value: string): WebRole | null {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  if (!safeEqual(sign(payload), signature)) return null;
  try {
    const { role, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role: WebRole;
      exp: number;
    };
    if (Date.now() > exp) return null;
    if (role !== 'owner' && role !== 'member') return null;
    return role;
  } catch {
    return null;
  }
}

export function webAuthConfigured(): boolean {
  return !!config.webOwnerPassword && !!config.webTeamPassword && !!config.webSessionSecret;
}

export function login(req: Request, res: Response): void {
  const key = req.ip ?? 'unknown';
  const lock = loginRateLimiter.checkLocked(key);
  if (lock.locked) {
    const retryAfterSec = Math.ceil(lock.retryAfterMs / 1000);
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: `Too many attempts. Try again in ${retryAfterSec}s.` });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: 'Password required.' });
    return;
  }
  let role: WebRole | null = null;
  if (safeEqual(password, config.webOwnerPassword)) role = 'owner';
  else if (safeEqual(password, config.webTeamPassword)) role = 'member';

  if (!role) {
    loginRateLimiter.recordFailure(key);
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }
  loginRateLimiter.recordSuccess(key);
  issueCookie(res, role);
  res.json({ role });
}

// Lets the SPA discover the current session's role on load — the session
// cookie is httpOnly, so the frontend can't read it directly.
export function me(req: Request, res: Response): void {
  res.json({ role: req.webRole });
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
}

export function requireAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookie = readSessionCookie(req);
    const role = cookie ? verifyCookie(cookie) : null;
    if (!role) {
      res.status(401).json({ error: 'Not authenticated.' });
      return;
    }
    req.webRole = role;
    next();
  };
}

export function requireOwner() {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireAuth()(req, res, () => {
      if (req.webRole !== 'owner') {
        res.status(403).json({ error: 'Owner only.' });
        return;
      }
      next();
    });
  };
}
