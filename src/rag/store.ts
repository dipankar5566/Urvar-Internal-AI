import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chunkMarkdown } from './chunker.js';
import { embedTexts } from './embedder.js';
import type { RawChunk } from './chunker.js';

export interface IndexedChunk extends RawChunk {
  id: number;
  embedding: number[];
}

export interface RagIndex {
  docsHash: string;
  indexedAt: string;
  chunks: IndexedChunk[];
}

export function hashDocs(docs: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(docs).sort()) {
    hash.update(key);
    hash.update(docs[key]!);
  }
  return hash.digest('hex');
}

export function loadIndex(indexPath: string): RagIndex | null {
  try {
    const raw = readFileSync(indexPath, 'utf-8');
    return JSON.parse(raw) as RagIndex;
  } catch {
    return null;
  }
}

export async function buildIndex(
  docs: Record<string, string>,
  indexPath: string,
): Promise<RagIndex> {
  const rawChunks: RawChunk[] = [];
  for (const [filename, text] of Object.entries(docs)) {
    rawChunks.push(...chunkMarkdown(text, filename));
  }

  const contents = rawChunks.map((c) => c.content);
  const embeddings = await embedTexts(contents);

  const chunks: IndexedChunk[] = rawChunks.map((chunk, i) => ({
    ...chunk,
    id: i,
    embedding: embeddings[i] ?? [],
  }));

  const index: RagIndex = {
    docsHash: hashDocs(docs),
    indexedAt: new Date().toISOString(),
    chunks,
  };

  writeFileSync(indexPath, JSON.stringify(index));
  return index;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function search(
  index: RagIndex,
  queryEmbedding: number[],
  topK: number,
  minScore = 0,
): IndexedChunk[] {
  return index.chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.chunk);
}
