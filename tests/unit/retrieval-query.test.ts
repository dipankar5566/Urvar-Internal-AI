import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalQuery } from '../../src/agents/base.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

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
