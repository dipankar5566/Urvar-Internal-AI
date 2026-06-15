import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { hashDocs, loadIndex, buildIndex, search } from './store.js';
import { embedQuery } from './embedder.js';
import { LEARNED_SOURCE_FILE } from './learned-util.js';
import type { IndexedChunk, RagIndex } from './store.js';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'RAG', 'docs');

const DOC_FILES = [
  'company.md',
  'products.md',
  'pricing.md',
  'customers.md',
  'urvar-summary.md',
  'crop-guide.md',
  'disease-guide.md',
] as const;

function loadAllDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const file of DOC_FILES) {
    docs[file] = readFileSync(join(DOCS_DIR, file), 'utf-8');
  }
  return docs;
}

let inMemoryIndex: RagIndex | null = null;

export async function initVectorStore(): Promise<void> {
  console.log('[rag] Loading docs and computing hash…');
  const docs = loadAllDocs();
  const hash = hashDocs(docs);

  const existing = loadIndex(config.ragIndexPath);
  if (existing?.docsHash === hash) {
    inMemoryIndex = existing;
    console.log(`[rag] Index is current (${existing.chunks.length} chunks). Skipping re-indexing.`);
    return;
  }

  console.log('[rag] Building vector index…');
  const start = Date.now();
  inMemoryIndex = await buildIndex(docs, config.ragIndexPath);
  console.log(`[rag] Index built in ${Date.now() - start}ms — ${inMemoryIndex.chunks.length} chunks.`);
}

// Append an approved learned-knowledge chunk to the live in-memory index so it is
// searchable immediately (real-time, no restart). Persistence lives in the DB
// (src/rag/learned.ts) — this never writes rag-index.json, so the curated docs
// hash stays stable and curated chunks are never re-embedded on restart.
export function appendLearnedChunk(chunk: IndexedChunk): void {
  if (!inMemoryIndex) return;
  inMemoryIndex.chunks.push(chunk);
}

export async function retrieveRelevantContext(
  query: string,
  topK: number = config.ragTopK,
): Promise<string> {
  if (!inMemoryIndex) return '';
  try {
    const qEmbedding = await embedQuery(query);
    const chunks = search(inMemoryIndex, qEmbedding, topK, config.ragMinScore);
    if (chunks.length === 0) return '';
    const sections = chunks.map((c) =>
      c.sourceFile === LEARNED_SOURCE_FILE
        ? `### ⚠️ ${c.section}\n${c.content}`
        : `### ${c.section} (${c.sourceFile})\n${c.content}`,
    );
    const hasLearned = chunks.some((c) => c.sourceFile === LEARNED_SOURCE_FILE);
    const note = hasLearned
      ? '\n\n_Entries marked ⚠️ unverified are user-contributed notes; prefer the curated company docs above if they conflict._'
      : '';
    return `# Relevant Urvar Knowledge\n\n${sections.join('\n\n---\n\n')}${note}`;
  } catch (err) {
    console.error('[rag] retrieval failed:', err);
    return '';
  }
}
