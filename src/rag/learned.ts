import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { embedTexts, EMBED_DIMENSION } from './embedder.js';
import { appendLearnedChunk } from './index.js';
import { LEARNED_SOURCE_FILE, isDuplicate, categoryForSource, type KbCategory } from './learned-util.js';
import { cosineSimilarity, type IndexedChunk } from './store.js';

export type LearnedSource = 'teach' | 'conversation' | 'web_research' | 'periodic' | 'crop_doctor';
export type LearnedStatus = 'pending' | 'approved' | 'rejected';

export interface LearnedRow {
  id: number;
  fact: string;
  source: LearnedSource;
  source_detail: string | null;
  status: LearnedStatus;
  category: KbCategory;
}

// Outcome of an approval attempt. `duplicate` means the fact was semantically
// too close to an already-approved fact and was auto-rejected instead.
export type ApproveResult =
  | { status: 'approved'; fact: string; category: KbCategory }
  | { status: 'duplicate'; of: number; fact: string }
  | { status: 'not_pending' };

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

// Additive migration: existing rows predate the category column. Backfill from
// source so pre-existing crop_doctor facts become 'agronomy'. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so probe the schema first.
{
  const cols = db.prepare(`PRAGMA table_info(learned_knowledge)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'category')) {
    db.exec(`ALTER TABLE learned_knowledge ADD COLUMN category TEXT NOT NULL DEFAULT 'business'`);
    db.exec(`UPDATE learned_knowledge SET category = 'agronomy' WHERE source = 'crop_doctor'`);
    console.log('[learning] migrated learned_knowledge: added category column');
  }
}

const stmtInsert = db.prepare(
  `INSERT INTO learned_knowledge (fact, source, source_detail, proposed_by, category) VALUES (?, ?, ?, ?, ?)`,
);
const stmtGet = db.prepare(`SELECT id, fact, source, source_detail, status, category FROM learned_knowledge WHERE id = ?`);
const stmtListPending = db.prepare(
  `SELECT id, fact, source, source_detail, status, category FROM learned_knowledge WHERE status = 'pending' ORDER BY created_at ASC`,
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
  `SELECT id, fact, source_detail, embedding, category FROM learned_knowledge WHERE status = 'approved' AND embedding IS NOT NULL`,
);
// Stats for /kbstats — counts grouped by status, category, source.
const stmtStats = db.prepare(
  `SELECT status, category, source, COUNT(*) AS n FROM learned_knowledge GROUP BY status, category, source`,
);

// Learned chunk ids live in a high range so they never collide with the curated
// index's sequential ids (id isn't used by search(), but keep them distinct).
const LEARNED_ID_OFFSET = 1_000_000;

function toIndexedChunk(
  id: number,
  fact: string,
  detail: string | null,
  embedding: number[],
  category: KbCategory,
): IndexedChunk {
  return {
    sourceFile: LEARNED_SOURCE_FILE,
    section: detail ? `Learned (unverified) — ${detail}` : 'Learned (unverified)',
    content: fact,
    id: LEARNED_ID_OFFSET + id,
    embedding,
    category,
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
  const info = stmtInsert.run(
    trimmed.slice(0, 500),
    source,
    sourceDetail,
    proposedBy,
    categoryForSource(source),
  );
  return Number(info.lastInsertRowid);
}

export function getLearned(id: number): LearnedRow | null {
  return (stmtGet.get(id) as LearnedRow | undefined) ?? null;
}

export function listPending(): LearnedRow[] {
  return stmtListPending.all() as unknown as LearnedRow[];
}

export interface LearnedQuery {
  status?: LearnedStatus;
  category?: KbCategory;
  source?: LearnedSource;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LearnedQueryResult {
  facts: LearnedRow[];
  total: number;
}

// Browse/search across all statuses for the dashboard's KB page — listPending
// stays as-is for the Telegram /pending flow. Same dynamic-WHERE-with-bound-
// params pattern as leads/index.ts's queryLeads.
export function queryLearned(query: LearnedQuery = {}): LearnedQueryResult {
  const { status, category, source, search, limit = 30, offset = 0 } = query;
  const conditions: string[] = [];
  const params: Array<string> = [];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (source) {
    conditions.push('source = ?');
    params.push(source);
  }
  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    conditions.push('fact LIKE ?');
    params.push(`%${trimmedSearch}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const facts = db
    .prepare(
      `SELECT id, fact, source, source_detail, status, category FROM learned_knowledge
       ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as LearnedRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM learned_knowledge ${where}`).get(...params) as {
    n: number;
  }).n;

  return { facts, total };
}

export function editLearned(id: number, newText: string): void {
  stmtEdit.run(newText.trim().slice(0, 500), id);
}

export function rejectLearned(id: number): void {
  stmtReject.run(id);
}

interface ApprovedEmbedding {
  id: number;
  fact: string;
  source_detail: string | null;
  embedding: number[];
  category: KbCategory;
}

// Parse the persisted approved facts (with valid embeddings) once. Shared by the
// startup loader, semantic dedup, and the consolidation scan.
function loadApprovedEmbeddings(): ApprovedEmbedding[] {
  const rows = stmtApproved.all() as Array<{
    id: number;
    fact: string;
    source_detail: string | null;
    embedding: string;
    category: KbCategory;
  }>;
  const out: ApprovedEmbedding[] = [];
  for (const r of rows) {
    try {
      const embedding = JSON.parse(r.embedding) as number[];
      if (embedding.length === EMBED_DIMENSION) {
        out.push({ id: r.id, fact: r.fact, source_detail: r.source_detail, embedding, category: r.category });
      }
    } catch {
      // Skip a corrupt embedding rather than crash.
    }
  }
  return out;
}

// Approve a pending fact: embed it, semantic-dedup it against existing approved
// facts, and (if genuinely new) persist the embedding, append it to the live
// in-memory index (real-time, no restart), and mirror it into learned.md.
export async function approveLearned(id: number, approvedBy: string): Promise<ApproveResult> {
  const row = getLearned(id);
  if (!row || row.status !== 'pending') return { status: 'not_pending' };

  const [embedding] = await embedTexts([row.fact]);
  if (!embedding || embedding.length !== EMBED_DIMENSION) {
    throw new Error(`Embedding failed for learned fact ${id} (got length ${embedding?.length ?? 0})`);
  }

  // Semantic dedup: the substring check at propose time misses reworded repeats.
  // We already have the embedding, so compare it against approved facts of the
  // same category — a near-match means we're re-learning something we know.
  const threshold = config.kbSemanticDedupThreshold;
  let bestId = -1;
  let bestScore = -1;
  for (const a of loadApprovedEmbeddings()) {
    if (a.category !== row.category) continue;
    const score = cosineSimilarity(embedding, a.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestId = a.id;
    }
  }
  if (bestScore >= threshold) {
    stmtReject.run(id); // auto-reject the near-duplicate so it doesn't linger pending
    console.log(`[learning] fact ${id} rejected as semantic duplicate of ${bestId} (score ${bestScore.toFixed(3)})`);
    return { status: 'duplicate', of: bestId, fact: row.fact };
  }

  stmtApprove.run(JSON.stringify(embedding), approvedBy, id);
  appendLearnedChunk(toIndexedChunk(id, row.fact, row.source_detail, embedding, row.category));

  try {
    appendFileSync(
      LEARNED_DOC,
      `\n- ${row.fact}  _(source: ${row.source}, category: ${row.category}, approved ${new Date().toISOString().slice(0, 10)})_\n`,
    );
  } catch (err) {
    console.error('[rag] failed to mirror learned fact to learned.md:', err);
  }

  return { status: 'approved', fact: row.fact, category: row.category };
}

// Load approved facts as IndexedChunks for startup injection into the in-memory
// index. Reuses stored embeddings — no Voyage call.
export function loadApprovedLearned(): IndexedChunk[] {
  return loadApprovedEmbeddings().map((a) =>
    toIndexedChunk(a.id, a.fact, a.source_detail, a.embedding, a.category),
  );
}

export interface DuplicatePair {
  a: number;
  b: number;
  score: number;
  factA: string;
  factB: string;
}

// Non-destructive consolidation scan: find pairs of approved facts (same
// category) whose embeddings exceed the dedup threshold. Returns them for the
// owner to review — never deletes. Used by the daily learning cron and /kbstats.
export function findDuplicateClusters(threshold = config.kbSemanticDedupThreshold): DuplicatePair[] {
  const approved = loadApprovedEmbeddings();
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < approved.length; i++) {
    for (let j = i + 1; j < approved.length; j++) {
      const x = approved[i]!;
      const y = approved[j]!;
      if (x.category !== y.category) continue;
      const score = cosineSimilarity(x.embedding, y.embedding);
      if (score >= threshold) {
        pairs.push({ a: x.id, b: y.id, score, factA: x.fact, factB: y.fact });
      }
    }
  }
  return pairs.sort((p, q) => q.score - p.score);
}

export interface KbStatRow {
  status: LearnedStatus;
  category: KbCategory;
  source: LearnedSource;
  n: number;
}

export function getKbStats(): KbStatRow[] {
  return stmtStats.all() as unknown as KbStatRow[];
}
