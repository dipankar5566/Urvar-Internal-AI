import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSearchResponse, isTransientFetchError } from '../../src/tools/web-search.js';
import type { SearchResult } from '../../src/tools/web-search.js';

const results: SearchResult[] = [
  { title: 'Title One', url: 'https://a.test', content: 'Body one.', score: 0.9 },
  { title: 'Title Two', url: 'https://b.test', content: 'Body two.', score: 0.8 },
];

test('surfaces the Tavily answer ahead of the raw results', () => {
  const out = formatSearchResponse({ answer: 'The synthesized answer.', results });
  assert.ok(out.startsWith('**Answer summary:** The synthesized answer.'));
  assert.ok(out.includes('Title One'));
  assert.ok(out.includes('https://b.test'));
});

test('answer-only response omits the results block', () => {
  const out = formatSearchResponse({ answer: 'Just the answer.', results: [] });
  assert.equal(out, '**Answer summary:** Just the answer.');
});

test('results-only response omits the answer summary', () => {
  const out = formatSearchResponse({ answer: null, results });
  assert.ok(!out.includes('Answer summary'));
  assert.ok(out.includes('Title One'));
  assert.ok(out.includes('Title Two'));
});

test('empty response returns the no-results sentinel', () => {
  assert.equal(formatSearchResponse({ answer: null, results: [] }), 'No search results found.');
});

test('raw page content is included and truncated at the cap', () => {
  const long = 'x'.repeat(2000);
  const out = formatSearchResponse({
    answer: null,
    results: [{ title: 'Dir', url: 'https://d.test', content: 'Snippet.', score: 0.7, raw_content: long }],
  });
  assert.ok(out.includes('Page content: '));
  assert.ok(out.includes('x'.repeat(1500) + '…'));
  assert.ok(!out.includes('x'.repeat(1501)));
});

test('results without raw content render unchanged', () => {
  const out = formatSearchResponse({ answer: null, results });
  assert.ok(!out.includes('Page content:'));
});

test('isTransientFetchError: abort timeout and network drops are transient', () => {
  assert.equal(isTransientFetchError(new DOMException('This operation was aborted', 'AbortError')), true);
  const fetchFailed = new TypeError('fetch failed');
  (fetchFailed as Error & { cause?: { code?: string } }).cause = { code: 'ECONNRESET' };
  assert.equal(isTransientFetchError(fetchFailed), true);
  assert.equal(isTransientFetchError(new Error('read ETIMEDOUT')), true);
});

test('isTransientFetchError: application errors fail fast', () => {
  assert.equal(isTransientFetchError(new Error('Tavily API error: 401 Unauthorized')), false);
  assert.equal(isTransientFetchError('not an error'), false);
});
