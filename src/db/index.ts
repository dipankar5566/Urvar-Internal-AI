import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

mkdirSync(dirname(config.sqliteDbPath), { recursive: true });

export const db = new DatabaseSync(config.sqliteDbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    agent_used  TEXT,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    cache_read  INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_session_created
    ON conversation_history(session_id, created_at DESC);
`);

const stmtInsert = db.prepare(`
  INSERT INTO conversation_history
    (session_id, role, content, agent_used, tokens_in, tokens_out, cache_read, cache_write)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetHistory = db.prepare(`
  SELECT role, content FROM conversation_history
  WHERE session_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const stmtClear = db.prepare(`DELETE FROM conversation_history WHERE session_id = ?`);

const stmtLastAgent = db.prepare(`
  SELECT agent_used FROM conversation_history
  WHERE session_id = ? AND role = 'assistant' AND agent_used IS NOT NULL AND agent_used != 'general'
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`);

// Session list for a prefix (e.g. the web UI's 'web:' chat sessions) — most
// recently active first, each with a preview of its first user message.
const stmtListSessions = db.prepare(`
  WITH sessions AS (
    SELECT session_id, MAX(created_at) AS last_at
    FROM conversation_history
    WHERE session_id LIKE ?
    GROUP BY session_id
  ),
  first_user AS (
    SELECT session_id, content,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, id ASC) AS rn
    FROM conversation_history
    WHERE role = 'user'
  )
  SELECT s.session_id AS sessionId, s.last_at AS lastAt, fu.content AS preview
  FROM sessions s
  LEFT JOIN first_user fu ON fu.session_id = s.session_id AND fu.rn = 1
  ORDER BY s.last_at DESC
  LIMIT ?
`);

export interface TokenUsage {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
}

export function appendHistory(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  agentUsed?: string,
  usage?: TokenUsage,
): void {
  stmtInsert.run(
    sessionId,
    role,
    content,
    agentUsed ?? null,
    usage?.tokens_in ?? 0,
    usage?.tokens_out ?? 0,
    usage?.cache_read ?? 0,
    usage?.cache_write ?? 0,
  );
}

export function getHistory(sessionId: string, turns = config.historyTurns): MessageParam[] {
  const rows = stmtGetHistory.all(sessionId, turns * 2) as Array<{
    role: string;
    content: string;
  }>;
  // rows come back newest-first; reverse for chronological order
  return rows.reverse().map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));
}

export function clearHistory(sessionId: string): void {
  stmtClear.run(sessionId);
}

// Most recent specialist that answered in this session — used by the
// orchestrator's classifier so short follow-ups stay with the same agent.
export function getLastAgentUsed(sessionId: string): string | null {
  const row = stmtLastAgent.get(sessionId) as { agent_used: string } | undefined;
  return row?.agent_used ?? null;
}

export interface SessionSummary {
  sessionId: string;
  lastAt: string;
  preview: string | null;
}

export function listSessionsByPrefix(prefix: string, limit = 30): SessionSummary[] {
  return stmtListSessions.all(`${prefix}%`, limit) as unknown as SessionSummary[];
}
