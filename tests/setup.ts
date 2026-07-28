// Test preload — loaded via `node --import tsx --import ./tests/setup.ts`.
//
// src/config.ts validates the 5 required env vars at *module load* and throws
// if any is missing. Almost every source module transitively imports config.js,
// so even pure-function unit tests can't import their target without env present.
//
// We load any real .env FIRST (so integration runs and dev machines keep real
// keys), then fill only the gaps with harmless placeholders. Pure unit tests
// never make a network call, so placeholder keys are safe; `??=` guarantees a
// real key is never overwritten.
import 'dotenv/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const placeholders: Record<string, string> = {
  ANTHROPIC_API_KEY: 'test',
  TELEGRAM_BOT_TOKEN: 'test',
  TAVILY_API_KEY: 'test',
  TELEGRAM_GROUP_ID: '0',
  VOYAGE_API_KEY: 'test',
};

for (const [key, value] of Object.entries(placeholders)) {
  process.env[key] ??= value;
}

// Force-override (not ??=) — Tier-1 tests that import src/db/index.ts (or
// anything that transitively does) must NEVER touch the real SQLite file,
// even if a developer's real .env happens to set SQLITE_DB_PATH. Each test
// run gets its own throwaway file.
process.env['SQLITE_DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'urvar-test-')), 'test.db');
