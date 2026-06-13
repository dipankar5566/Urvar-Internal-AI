import './config.js'; // validates env vars at startup — throws if anything missing
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { db } from './db/index.js';
import { webSearch } from './tools/web-search.js';
import { embedQuery } from './rag/embedder.js';
import { initVectorStore } from './rag/index.js';
import { createBot } from './bot/telegram.js';
import { startScheduler } from './scheduler/index.js';

async function healthCheck(): Promise<void> {
  // 1. SQLite
  db.prepare('SELECT 1').get();
  console.log('[startup] SQLite OK');

  // 2. Anthropic API
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [{ role: 'user', content: 'ping' }],
  });
  console.log('[startup] Anthropic API OK');

  // 3. Tavily API
  await webSearch('test', 1);
  console.log('[startup] Tavily API OK');

  // 4. Voyage AI
  await embedQuery('ping');
  console.log('[startup] Voyage AI OK');

  // 5. Telegram token (validated by createBot starting polling — checked implicitly)
  console.log('[startup] All health checks passed.');
}

async function main(): Promise<void> {
  console.log('[startup] Urvar AI Assistant v2.0 starting…');

  try {
    await initVectorStore();
  } catch (err) {
    console.error('[startup] Vector store initialization failed:', err);
    process.exit(1);
  }

  try {
    await healthCheck();
  } catch (err) {
    console.error('[startup] Health check failed:', err);
    process.exit(1);
  }

  const bot = createBot();
  startScheduler(bot);

  console.log('[startup] Bot is running. Press Ctrl+C to stop.');

  process.on('SIGINT', () => {
    console.log('\n[shutdown] Stopping…');
    bot.stopPolling();
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stopPolling();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
