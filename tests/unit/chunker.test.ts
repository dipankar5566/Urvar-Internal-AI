import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../../src/rag/chunker.js';

// Bodies must exceed 100 chars, otherwise the chunker merges them upward.
const bodyA = 'A'.repeat(150);
const bodyB = 'B'.repeat(150);
const bodyC = 'C'.repeat(150);

test('splits at ## boundaries into separate, correctly-labeled chunks', () => {
  const md = `## Section A\n${bodyA}\n## Section B\n${bodyB}\n## Section C\n${bodyC}`;
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.equal(chunks.length, 3);
  // content is partitioned one section per chunk
  assert.ok(chunks[0]!.content.includes(bodyA));
  assert.ok(chunks[1]!.content.includes(bodyB));
  assert.ok(chunks[2]!.content.includes(bodyC));
  // every section labels correctly, including the first
  assert.equal(chunks[0]!.section, '## Section A');
  assert.equal(chunks[1]!.section, '## Section B');
  assert.equal(chunks[2]!.section, '## Section C');
  assert.equal(chunks[0]!.sourceFile, 'doc.md');
});

test('merges a tiny (<100 char) trailing section upward', () => {
  const md = `## Section A\n${bodyA}\n## Section B\nshort tail`;
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.content.includes('short tail'));
  assert.ok(chunks[0]!.content.includes(bodyA));
});

test('sub-splits a ## section over 4000 chars at ### boundaries', () => {
  const big = 'x'.repeat(4001);
  const tail = 'y'.repeat(150);
  const md = `## Big\n${big}\n### Sub\n${tail}`;
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.content.length > 4000);
  assert.equal(chunks[0]!.section, '## Big');
  assert.equal(chunks[1]!.section, '## Big > ### Sub');
});

test('labels the preamble before the first ## heading by the doc h1', () => {
  const preamble = `# Doc Title\n${bodyA}`;
  const md = `${preamble}\n## Section One\n${bodyB}`;
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.equal(chunks.length, 2);
  // preamble (h1 + intro, before any ##) is labeled by the h1, not ''
  assert.ok(chunks[0]!.content.includes('# Doc Title'));
  assert.equal(chunks[0]!.section, '# Doc Title');
  assert.equal(chunks[1]!.section, '## Section One');
});

test('preamble with no h1 falls back to the filename', () => {
  const md = `intro prose with no heading ${bodyA}\n## Section One\n${bodyB}`;
  const chunks = chunkMarkdown(md, 'doc.md');
  assert.equal(chunks[0]!.section, 'doc.md');
  assert.equal(chunks[1]!.section, '## Section One');
});

test('a file with no ## headers becomes one chunk labeled by its # h1', () => {
  const md = `# Title\n${bodyA}`;
  const chunks = chunkMarkdown(md, 'summary.md');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.section, '# Title');
  assert.ok(chunks[0]!.content.includes('# Title'));
  assert.ok(chunks[0]!.content.includes(bodyA));
});

test('a heading-less file with no # h1 falls back to the filename as section', () => {
  const md = `just some plain prose without any headings ${bodyA}`;
  const chunks = chunkMarkdown(md, 'notes.md');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.section, 'notes.md');
});

test('empty / whitespace-only input produces no chunks', () => {
  assert.deepEqual(chunkMarkdown('   \n  \n', 'empty.md'), []);
});
