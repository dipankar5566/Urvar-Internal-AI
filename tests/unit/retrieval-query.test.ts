import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalQuery, currentDateLine } from '../../src/agents/base.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

test('currentDateLine renders a fixed date in IST', () => {
  // 2026-07-03T20:00:00Z is already 2026-07-04 in IST (+05:30).
  const line = currentDateLine(new Date('2026-07-03T20:00:00Z'));
  assert.equal(line, 'Current date: Saturday, 4 July 2026 (IST)');
});

test('returns the current message verbatim when there is no history', () => {
  assert.equal(buildRetrievalQuery('what about pricing?', []), 'what about pricing?');
});

test('prepends the previous user turn (string content)', () => {
  const history: MessageParam[] = [
    { role: 'user', content: 'tell me about Enriched Vermicompost' },
    { role: 'assistant', content: 'It improves soil health...' },
  ];
  assert.equal(
    buildRetrievalQuery('what about pricing?', history),
    'tell me about Enriched Vermicompost\nwhat about pricing?',
  );
});

test('extracts text from a block-array user turn', () => {
  const history: MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: 'diagnose this leaf' }] },
  ];
  assert.equal(buildRetrievalQuery('and for paddy?', history), 'diagnose this leaf\nand for paddy?');
});

test('skips assistant turns and uses the most recent user turn', () => {
  const history: MessageParam[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ];
  assert.equal(buildRetrievalQuery('follow up', history), 'second question\nfollow up');
});

test('falls back to current when history has no user turn', () => {
  const history: MessageParam[] = [{ role: 'assistant', content: 'greeting' }];
  assert.equal(buildRetrievalQuery('hello', history), 'hello');
});
