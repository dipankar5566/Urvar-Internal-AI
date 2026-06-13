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
