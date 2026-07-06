import 'dotenv/config';

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

export const config = {
  anthropicApiKey: require_env('ANTHROPIC_API_KEY'),
  telegramBotToken: require_env('TELEGRAM_BOT_TOKEN'),
  tavilyApiKey: require_env('TAVILY_API_KEY'),
  voyageApiKey: require_env('VOYAGE_API_KEY'),

  telegramGroupId: process.env['TELEGRAM_GROUP_ID'] ?? '',
  sqliteDbPath: process.env['SQLITE_DB_PATH'] ?? './data/urvar.db',
  claudeModel: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-6',
  historyTurns: parseInt(process.env['HISTORY_TURNS'] ?? '10', 10),
  maxAgentIterations: parseInt(process.env['MAX_AGENT_ITERATIONS'] ?? '8', 10),
  ragTopK: parseInt(process.env['RAG_TOP_K'] ?? '5', 10),
  ragMinScore: parseFloat(process.env['RAG_MIN_SCORE'] ?? '0.3'),
  ragIndexPath: process.env['RAG_INDEX_PATH'] ?? './data/rag-index.json',
  // Per-agent wall-clock budget for the weekly report. The analytical agents run
  // extended thinking + multiple searches; 240s proved too tight in production.
  reportAgentTimeoutMs: parseInt(process.env['REPORT_AGENT_TIMEOUT_MS'] ?? '360000', 10),

  // Sales cadence crons (IST). Call sheet: prioritized phone-ready leads with
  // pitch lines, sent to the owner. Content draft: one SEO article for the
  // website. Both skip gracefully when OWNER_TELEGRAM_ID is unset.
  callSheetCron: process.env['CALL_SHEET_CRON'] ?? '30 8 * * 1', // Monday 08:30 IST
  contentCron: process.env['CONTENT_CRON'] ?? '0 9 * * 3', // Wednesday 09:00 IST

  // Auto-learning knowledge base. ownerTelegramId is the only user allowed to
  // approve learned facts; if unset, auto-learning degrades gracefully (proposals
  // are stored as pending and logged, but no approval routing happens).
  ownerTelegramId: process.env['OWNER_TELEGRAM_ID'] ?? '',
  kbLearningEnabled: (process.env['KB_LEARNING_ENABLED'] ?? 'true') !== 'false',
  kbDistillCron: process.env['KB_DISTILL_CRON'] ?? '0 8 * * *', // daily 08:00 IST
  // Cosine-similarity ceiling for learned facts. At approval a candidate scoring
  // above this against any existing approved fact is dropped as a near-duplicate;
  // the daily consolidation pass uses the same threshold to flag clusters.
  kbSemanticDedupThreshold: parseFloat(process.env['KB_SEMANTIC_DEDUP_THRESHOLD'] ?? '0.92'),
} as const;
