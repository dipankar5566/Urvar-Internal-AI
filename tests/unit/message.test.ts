import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, formatUptime } from '../../src/utils/message.js';

test('splitMessage returns input unchanged when under the limit', () => {
  assert.deepEqual(splitMessage('hello', 4096), ['hello']);
  assert.deepEqual(splitMessage('', 4096), ['']);
});

test('splitMessage prefers a newline boundary over a hard cut', () => {
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10);
  assert.deepEqual(splitMessage(text, 15), ['a'.repeat(10), 'b'.repeat(10)]);
});

test('splitMessage hard-cuts at maxLen when no newline is available', () => {
  const parts = splitMessage('a'.repeat(20), 10);
  assert.deepEqual(parts, ['a'.repeat(10), 'a'.repeat(10)]);
  for (const p of parts) assert.ok(p.length <= 10);
});

test('splitMessage trims leading whitespace on continuation parts', () => {
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(20);
  const parts = splitMessage(text, 12);
  // continuation must not start with the stripped newline
  assert.ok(!parts[1]!.startsWith('\n'));
});

test('formatUptime formats seconds-only durations', () => {
  assert.equal(formatUptime(Date.now()), '0s');
  assert.match(formatUptime(Date.now() - 5_000), /^\d+s$/);
});

test('formatUptime includes minutes and hours when present', () => {
  assert.match(formatUptime(Date.now() - 90_000), /^1m \d+s$/);
  assert.match(formatUptime(Date.now() - 3_661_000), /^1h 1m \d+s$/);
});
