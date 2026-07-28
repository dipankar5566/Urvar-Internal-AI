import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import type TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { login, logout, me, requireAuth, webAuthConfigured } from './auth.js';
import { createChatRouter } from './routes/chat.js';
import { createLeadsRouter } from './routes/leads.js';
import { createKbRouter } from './routes/kb.js';
import { createReportsRouter } from './routes/reports.js';

// Two directories up from either src/web/server.ts or the compiled
// dist/web/server.js lands at the project root, where the built frontend
// (web/dist, from `npm run build:web`) lives, and package.json.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_DIST = join(PROJECT_ROOT, 'web', 'dist');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const WEB_START = Date.now();
const VERSION = readVersion();

export function startWebServer(bot: TelegramBot): void {
  if (!config.webEnabled) {
    console.log('[web] WEB_ENABLED=false — skipping web UI.');
    return;
  }
  if (!webAuthConfigured()) {
    console.warn(
      '[web] WEB_OWNER_PASSWORD / WEB_TEAM_PASSWORD / WEB_SESSION_SECRET not fully set — skipping web UI.',
    );
    return;
  }

  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Lightweight request log — method, path, status, duration — under the
  // same [web] prefix as startup/shutdown logging. API requests only; static
  // asset/SPA-fallback hits would just be noise.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[web] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.post('/api/auth/login', login);
  app.post('/api/auth/logout', logout);
  app.get('/api/auth/me', requireAuth(), me);
  app.get('/api/health', requireAuth(), (_req, res) => {
    res.json({ uptimeMs: Date.now() - WEB_START, version: VERSION });
  });
  // Each router is mounted at its own specific prefix (not a shared '/api')
  // so Express only ever dispatches a request into a router whose path
  // actually matches — a router-wide auth middleware that terminates the
  // response (e.g. requireOwner()'s 403) must not be able to swallow
  // requests meant for a sibling router mounted at the same prefix.
  app.use('/api/chat', createChatRouter(bot));
  app.use('/api/leads', createLeadsRouter());
  app.use('/api/kb', createKbRouter());
  app.use('/api/reports', createReportsRouter());

  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    // SPA fallback: any non-API GET serves index.html so client-side routing works.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(WEB_DIST, 'index.html'));
    });
  } else {
    console.warn(`[web] ${WEB_DIST} not found — run "npm run build:web" to serve the dashboard UI.`);
  }

  // Keep API errors JSON instead of Express's default HTML error page.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[web] request error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  const server = app.listen(config.webPort, () => {
    console.log(`[web] Web UI listening on port ${config.webPort}.`);
  });
  // An unhandled 'error' event (e.g. EADDRINUSE) would otherwise throw and
  // crash the whole process, taking the Telegram bot down with it — this is
  // an additive feature, so it must degrade instead.
  server.on('error', (err) => {
    console.error('[web] Web server failed to start:', err);
  });
}
