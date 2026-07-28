// Route-level tests for the web dashboard's non-LLM endpoints (auth, leads,
// kb browse/reject, reports read paths). Deliberately excludes anything that
// calls a real LLM/embedding API (chat, kb approve, report generation) —
// Tier 1 must stay no-keys/no-cost/no-network. tests/setup.ts points
// SQLITE_DB_PATH at a fresh temp file for this whole run, so this never
// touches the real database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { login, logout, me, requireAuth } from '../../src/web/auth.js';
import { createLeadsRouter } from '../../src/web/routes/leads.js';
import { createKbRouter } from '../../src/web/routes/kb.js';
import { createReportsRouter } from '../../src/web/routes/reports.js';
import { proposeLearned, getLearned } from '../../src/rag/learned.js';

process.env['WEB_OWNER_PASSWORD'] ??= 'test-owner-pw';
process.env['WEB_TEAM_PASSWORD'] ??= 'test-team-pw';
process.env['WEB_SESSION_SECRET'] ??= 'test-session-secret-not-for-prod';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', login);
  app.post('/api/auth/logout', logout);
  app.get('/api/auth/me', requireAuth(), me);
  app.use('/api/leads', createLeadsRouter());
  app.use('/api/kb', createKbRouter());
  app.use('/api/reports', createReportsRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

function cookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie()[0];
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

async function loginAs(role: 'owner' | 'member'): Promise<string> {
  const password = role === 'owner' ? process.env['WEB_OWNER_PASSWORD'] : process.env['WEB_TEAM_PASSWORD'];
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

// ---------------------------------------------------------------------------
// Auth

test('login rejects a wrong password', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  assert.equal(res.status, 401);
});

test('login accepts the owner and team passwords with the right role', async () => {
  const ownerRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env['WEB_OWNER_PASSWORD'] }),
  });
  assert.equal((await ownerRes.json()).role, 'owner');

  const memberRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env['WEB_TEAM_PASSWORD'] }),
  });
  assert.equal((await memberRes.json()).role, 'member');
});

test('/me is 401 without a session cookie and returns the role with one', async () => {
  const anon = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(anon.status, 401);

  const cookie = await loginAs('member');
  const authed = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(authed.status, 200);
  assert.equal((await authed.json()).role, 'member');
});

test('logout clears the session', async () => {
  const cookie = await loginAs('member');
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logoutRes.status, 204);
});

// ---------------------------------------------------------------------------
// Leads

test('leads endpoints require authentication', async () => {
  const res = await fetch(`${baseUrl}/api/leads`);
  assert.equal(res.status, 401);
});

test('create, list, search, update status/contact, and reject duplicates', async () => {
  const cookie = await loginAs('member');
  const authed = { Cookie: cookie, 'Content-Type': 'application/json' };

  const create = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ name: 'Test Agro Traders', type: 'retailer', location: 'Kolkata, West Bengal' }),
  });
  assert.equal(create.status, 201);
  const { id } = (await create.json()) as { id: number };

  const dup = await fetch(`${baseUrl}/api/leads`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ name: 'Test Agro Traders', type: 'retailer', location: 'Kolkata, West Bengal' }),
  });
  assert.equal(dup.status, 409);

  const search = await fetch(`${baseUrl}/api/leads?search=Test+Agro`, { headers: { Cookie: cookie } });
  const searchBody = (await search.json()) as { leads: Array<{ id: number }> };
  assert.ok(searchBody.leads.some((l) => l.id === id));

  const statusRes = await fetch(`${baseUrl}/api/leads/${id}/status`, {
    method: 'PATCH',
    headers: authed,
    body: JSON.stringify({ status: 'contacted' }),
  });
  assert.equal(statusRes.status, 200);

  const badStatus = await fetch(`${baseUrl}/api/leads/${id}/status`, {
    method: 'PATCH',
    headers: authed,
    body: JSON.stringify({ status: 'not-a-real-status' }),
  });
  assert.equal(badStatus.status, 400);

  const contactRes = await fetch(`${baseUrl}/api/leads/${id}/contact`, {
    method: 'PATCH',
    headers: authed,
    body: JSON.stringify({ contact: '+91 98300 12345' }),
  });
  assert.equal(contactRes.status, 200);

  const detail = await fetch(`${baseUrl}/api/leads/${id}`, { headers: { Cookie: cookie } });
  const detailBody = (await detail.json()) as { lead: { status: string; contact: string } };
  assert.equal(detailBody.lead.status, 'contacted');
  assert.equal(detailBody.lead.contact, '+91 98300 12345');

  const missing = await fetch(`${baseUrl}/api/leads/999999/status`, {
    method: 'PATCH',
    headers: authed,
    body: JSON.stringify({ status: 'dead' }),
  });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// Knowledge base (read + reject only — approve hits the Voyage API)

test('kb endpoints are owner-only', async () => {
  const memberCookie = await loginAs('member');
  const res = await fetch(`${baseUrl}/api/kb/pending`, { headers: { Cookie: memberCookie } });
  assert.equal(res.status, 403);

  const ownerCookie = await loginAs('owner');
  const ownerRes = await fetch(`${baseUrl}/api/kb/pending`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerRes.status, 200);
});

test('browse/search and reject a pending fact (no network — reject is pure DB)', async () => {
  const id = proposeLearned('Test-only fact for route coverage', 'teach', null, 'test-suite');
  assert.ok(id !== null);

  const ownerCookie = await loginAs('owner');
  const browse = await fetch(`${baseUrl}/api/kb?status=pending&search=route+coverage`, {
    headers: { Cookie: ownerCookie },
  });
  const browseBody = (await browse.json()) as { facts: Array<{ id: number }> };
  assert.ok(browseBody.facts.some((f) => f.id === id));

  const reject = await fetch(`${baseUrl}/api/kb/${id}/reject`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(reject.status, 200);
  assert.equal(getLearned(id!)?.status, 'rejected');

  const rejectAgain = await fetch(`${baseUrl}/api/kb/${id}/reject`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(rejectAgain.status, 409);
});

// ---------------------------------------------------------------------------
// Reports (read paths only — /generate hits an LLM agent)

test('reports/weekly and callsheet-leads are readable with no archived data', async () => {
  const cookie = await loginAs('member');
  const weekly = await fetch(`${baseUrl}/api/reports/weekly`, { headers: { Cookie: cookie } });
  assert.equal(weekly.status, 200);
  const weeklyBody = (await weekly.json()) as { market: string | null; competitive: string | null };
  assert.equal(weeklyBody.market, null);
  assert.equal(weeklyBody.competitive, null);

  const callsheet = await fetch(`${baseUrl}/api/reports/callsheet-leads`, { headers: { Cookie: cookie } });
  assert.equal(callsheet.status, 200);

  const kbstatsMember = await fetch(`${baseUrl}/api/reports/kbstats`, { headers: { Cookie: cookie } });
  assert.equal(kbstatsMember.status, 403);

  const ownerCookie = await loginAs('owner');
  const kbstatsOwner = await fetch(`${baseUrl}/api/reports/kbstats`, { headers: { Cookie: ownerCookie } });
  assert.equal(kbstatsOwner.status, 200);
});
