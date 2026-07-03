import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashDocs, search, cosineSimilarity } from '../../src/rag/store.js';
import type { RagIndex, IndexedChunk } from '../../src/rag/store.js';

test('hashDocs is deterministic and order-independent', () => {
  const a = hashDocs({ 'a.md': 'one', 'b.md': 'two' });
  const b = hashDocs({ 'b.md': 'two', 'a.md': 'one' });
  assert.equal(a, b);
});

test('hashDocs changes when any content changes', () => {
  const base = hashDocs({ 'a.md': 'one', 'b.md': 'two' });
  const edited = hashDocs({ 'a.md': 'one', 'b.md': 'two!' });
  assert.notEqual(base, edited);
});

function chunk(id: number, embedding: number[]): IndexedChunk {
  return { id, embedding, sourceFile: `f${id}.md`, section: `s${id}`, content: `c${id}` };
}

// query [1,0]: exact=1.0 (id0), diagonal≈0.707 (id2), orthogonal=0 (id1)
const index: RagIndex = {
  docsHash: 'h',
  indexedAt: new Date().toISOString(),
  chunks: [chunk(0, [1, 0]), chunk(1, [0, 1]), chunk(2, [1, 1])],
};
const query = [1, 0];

test('search returns chunks ordered by descending cosine similarity', () => {
  const ids = search(index, query, 3).map((c) => c.id);
  assert.deepEqual(ids, [0, 2, 1]);
});

test('search respects topK', () => {
  const ids = search(index, query, 2).map((c) => c.id);
  assert.deepEqual(ids, [0, 2]);
});

test('search drops chunks below the minScore floor', () => {
  const ids = search(index, query, 3, 0.5).map((c) => c.id);
  assert.deepEqual(ids, [0, 2]); // orthogonal (score 0) filtered out
});

test('search returns empty when nothing clears the floor', () => {
  assert.deepEqual(search(index, query, 3, 1.1), []);
});

test('cosineSimilarity: identical=1, orthogonal=0, zero-vector=0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('search filters learned chunks by category; curated (no category) always pass', () => {
  const catIndex: RagIndex = {
    docsHash: 'h',
    indexedAt: new Date().toISOString(),
    chunks: [
      { id: 0, embedding: [1, 0], sourceFile: 'company.md', section: 's', content: 'curated' },
      { id: 1, embedding: [1, 0], sourceFile: 'learned', section: 's', content: 'biz', category: 'business' },
      { id: 2, embedding: [1, 0], sourceFile: 'learned', section: 's', content: 'agro', category: 'agronomy' },
    ],
  };
  // business request: curated + business learned, agronomy dropped
  const biz = search(catIndex, [1, 0], 10, 0, 'business').map((c) => c.id).sort();
  assert.deepEqual(biz, [0, 1]);
  // agronomy request: curated + agronomy learned, business dropped
  const agro = search(catIndex, [1, 0], 10, 0, 'agronomy').map((c) => c.id).sort();
  assert.deepEqual(agro, [0, 2]);
  // no category filter: everything eligible
  const all = search(catIndex, [1, 0], 10, 0).map((c) => c.id).sort();
  assert.deepEqual(all, [0, 1, 2]);
});
