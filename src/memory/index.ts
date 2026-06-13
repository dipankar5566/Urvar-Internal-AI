import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { config } from '../config.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });
const MAX_MEMORIES = 100;

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    memory_text TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_memory_session ON agent_memory(session_id);
`);

const stmtInsertMemory = db.prepare(
  `INSERT INTO agent_memory (session_id, memory_text) VALUES (?, ?)`,
);
const stmtGetMemories = db.prepare(
  `SELECT memory_text FROM agent_memory WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
);
const stmtCountMemories = db.prepare(
  `SELECT COUNT(*) as cnt FROM agent_memory WHERE session_id = ?`,
);
const stmtDeleteOldest = db.prepare(`
  DELETE FROM agent_memory WHERE id IN (
    SELECT id FROM agent_memory WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
  )
`);
const stmtClearMemories = db.prepare(`DELETE FROM agent_memory WHERE session_id = ?`);

export function getMemories(sessionId: string): string {
  const rows = stmtGetMemories.all(sessionId, MAX_MEMORIES) as Array<{ memory_text: string }>;
  if (rows.length === 0) return '';
  return rows
    .reverse()
    .map((r) => `- ${r.memory_text}`)
    .join('\n');
}

export function clearMemories(sessionId: string): void {
  stmtClearMemories.run(sessionId);
}

export async function extractAndSaveMemories(
  sessionId: string,
  conversation: string,
): Promise<void> {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Extract 1–5 important business facts from this conversation worth remembering for future sessions. Focus on: strategic decisions, pricing targets, product plans, market insights, competitor intelligence, or user preferences.

Return ONLY a JSON array of short strings (each under 100 chars). If nothing is worth remembering, return [].

Conversation:
${conversation}`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;

    const facts: unknown = JSON.parse(match[0]);
    if (!Array.isArray(facts)) return;

    const strings = (facts as unknown[]).filter((f): f is string => typeof f === 'string');
    if (strings.length === 0) return;

    for (const item of strings) {
      stmtInsertMemory.run(sessionId, item.slice(0, 200));
    }

    // Prune oldest if over limit
    const row = stmtCountMemories.get(sessionId) as { cnt: number };
    if (row.cnt > MAX_MEMORIES) {
      stmtDeleteOldest.run(sessionId, row.cnt - MAX_MEMORIES);
    }
  } catch {
    // Memory extraction is best-effort; never crash the bot
  }
}
