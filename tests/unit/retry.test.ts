import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { isRetryable } from '../../src/agents/base.js';

test('retryable Anthropic API statuses', () => {
  for (const status of [429, 500, 503, 529]) {
    const err = new Anthropic.APIError(status, undefined, 'boom', undefined);
    assert.equal(isRetryable(err), true, `status ${status} should be retryable`);
  }
});

test('non-retryable Anthropic API statuses', () => {
  for (const status of [400, 401, 404]) {
    const err = new Anthropic.APIError(status, undefined, 'nope', undefined);
    assert.equal(isRetryable(err), false, `status ${status} should not be retryable`);
  }
});

test('retryable transient network error codes', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']) {
    assert.equal(isRetryable(new Error(`socket failure ${code}`)), true, code);
  }
});

test('non-retryable generic errors and non-Error values', () => {
  assert.equal(isRetryable(new Error('something unexpected')), false);
  assert.equal(isRetryable('a string'), false);
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable(undefined), false);
});
