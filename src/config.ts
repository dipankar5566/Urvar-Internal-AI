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
} as const;
