import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { embedTexts, EMBED_DIMENSION } from './embedder.js';
import { appendLearnedChunk } from './index.js';
import { LEARNED_SOURCE_FILE, isDuplicate } from './learned-util.js';
import type { IndexedChunk } from './store.js';

export type LearnedSource = 'teach' | 'conversation' | 'web_research' | 'periodic' | 'crop_doctor';
export type LearnedStatus = 'pending' | 'approved' | 'rejected';

export interface LearnedRow {
  id: number;
  fact: string;
  source: LearnedSource;
  source_detail: string | null;
  status: LearnedStatus;
}

const LEARNED_DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'RAG',
  'docs',
  'learned.md',
);

db.exec(`
  CREATE TABLE IF NOT EXISTS learned_knowledge (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fact          TEXT NOT NULL,
    source        TEXT NOT NULL,
    source_detail TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    embedding     TEXT,
    proposed_by   TEXT,
    approved_by   TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at    DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_learned_status ON learned_knowledge(status);
`);

const stmtInsert = db.prepare(
  `INSERT INTO learned_knowledge (fact, source, source_detail, proposed_by) VALUES (?, ?, ?, ?)`,
);
const stmtGet = db.prepare(`SELECT id, fact, source, source_detail, status FROM learned_knowledge WHERE id = ?`);
const stmtListPending = db.prepare(
  `SELECT id, fact, source, source_detail, status FROM learned_knowledge WHERE status = 'pending' ORDER BY created_at ASC`,
);
// Existing facts to dedupe against — everything not rejected.
const stmtActiveFacts = db.prepare(
  `SELECT fact FROM learned_knowledge WHERE status != 'rejected'`,
);
const stmtApprove = db.prepare(
  `UPDATE learned_knowledge SET status = 'approved', embedding = ?, approved_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`,
);
const stmtReject = db.prepare(
  `UPDATE learned_knowledge SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ?`,
);
const stmtEdit = db.prepare(`UPDATE learned_knowledge SET fact = ? WHERE id = ?`);
const stmtApproved = db.prepare(
  `SELECT id, fact, source_detail, embedding FROM learned_knowledge WHERE status = 'approved' AND embedding IS NOT NULL`,
);

// Learned chunk ids live in a high range so they never collide with the curated
// index's sequential ids (id isn't used by search(), but keep them distinct).
const LEARNED_ID_OFFSET = 1_000_000;

function toIndexedChunk(id: number, fact: string, detail: string | null, embedding: number[]): IndexedChunk {
  return {
    sourceFile: LEARNED_SOURCE_FILE,
    section: detail ? `Learned (unverified) — ${detail}` : 'Learned (unverified)',
    content: fact,
    id: LEARNED_ID_OFFSET + id,
    embedding,
  };
}

// Insert a candidate fact as `pending`. Returns the new row id, or null if it was
// dropped as a duplicate of an existing (non-rejected) fact.
export function proposeLearned(
  fact: string,
  source: LearnedSource,
  sourceDetail: string | null,
  proposedBy: string | null,
): number | null {
  const trimmed = fact.trim();
  if (!trimmed) return null;
  const existing = (stmtActiveFacts.all() as Array<{ fact: string }>).map((r) => r.fact);
  if (isDuplicate(trimmed, existing)) return null;
  const info = stmtInsert.run(trimmed.slice(0, 500), source, sourceDetail, proposedBy);
  return Number(info.lastInsertRowid);
}

export function getLearned(id: number): LearnedRow | null {
  return (stmtGet.get(id) as LearnedRow | undefined) ?? null;
}

export function listPending(): LearnedRow[] {
  return stmtListPending.all() as unknown as LearnedRow[];
}

export function editLearned(id: number, newText: string): void {
  stmtEdit.run(newText.trim().slice(0, 500), id);
}

export function rejectLearned(id: number): void {
  stmtReject.run(id);
}

// Approve a pending fact: embed it (document-type, matching curated chunks),
// persist the embedding, append it to the live in-memory index (real-time, no
// restart), and mirror it into RAG/docs/learned.md for human review. Returns the
// approved fact text, or null if the id wasn't a pending row.
export async function approveLearned(id: number, approvedBy: string): Promise<string | null> {
  const row = getLearned(id);
  if (!row || row.status !== 'pending') return null;

  const [embedding] = await embedTexts([row.fact]);
  if (!embedding || embedding.length !== EMBED_DIMENSION) {
    throw new Error(`Embedding failed for learned fact ${id} (got length ${embedding?.length ?? 0})`);
  }

  stmtApprove.run(JSON.stringify(embedding), approvedBy, id);
  appendLearnedChunk(toIndexedChunk(id, row.fact, row.source_detail, embedding));

  try {
    appendFileSync(LEARNED_DOC, `\n- ${row.fact}  _(source: ${row.source}, approved ${new Date().toISOString().slice(0, 10)})_\n`);
  } catch (err) {
    console.error('[rag] failed to mirror learned fact to learned.md:', err);
  }

  return row.fact;
}

// Load approved facts as IndexedChunks for startup injection into the in-memory
// index. Reuses stored embeddings — no Voyage call.
export function loadApprovedLearned(): IndexedChunk[] {
  const rows = stmtApproved.all() as Array<{
    id: number;
    fact: string;
    source_detail: string | null;
    embedding: string;
  }>;
  const chunks: IndexedChunk[] = [];
  for (const r of rows) {
    try {
      const embedding = JSON.parse(r.embedding) as number[];
      if (embedding.length === EMBED_DIMENSION) {
        chunks.push(toIndexedChunk(r.id, r.fact, r.source_detail, embedding));
      }
    } catch {
      // Skip a corrupt embedding rather than crash startup.
    }
  }
  return chunks;
}
