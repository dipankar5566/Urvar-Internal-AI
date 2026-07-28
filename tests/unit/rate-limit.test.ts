import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../../src/web/rate-limit.js';

test('a key under the failure threshold is never locked', () => {
  const limiter = new LoginRateLimiter();
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.checkLocked('1.2.3.4').locked, false);
});

test('the 5th consecutive failure locks the key', () => {
  const limiter = new LoginRateLimiter();
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  const status = limiter.checkLocked('1.2.3.4');
  assert.equal(status.locked, true);
  assert.ok(status.retryAfterMs > 0);
});

test('a lock expires once the clock passes lockedUntil', () => {
  let now = 0;
  const limiter = new LoginRateLimiter(() => now);
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.checkLocked('1.2.3.4').locked, true);
  now += 31_000; // past the 30s base lockout
  assert.equal(limiter.checkLocked('1.2.3.4').locked, false);
});

test('repeated lockout cycles back off exponentially, capped at 15 minutes', () => {
  let now = 0;
  const limiter = new LoginRateLimiter(() => now);
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  const first = limiter.checkLocked('1.2.3.4').retryAfterMs;
  now += first + 1; // let the first lock expire
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4'); // second cycle of 5
  const second = limiter.checkLocked('1.2.3.4').retryAfterMs;
  assert.ok(second > first, `expected second lockout (${second}ms) to exceed first (${first}ms)`);
  assert.ok(second <= 15 * 60 * 1000);
});

test('recordSuccess clears failures for a key', () => {
  const limiter = new LoginRateLimiter();
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
  limiter.recordSuccess('1.2.3.4');
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4'); // would have locked at 5 without the reset
  assert.equal(limiter.checkLocked('1.2.3.4').locked, false);
});

test('keys are independent of each other', () => {
  const limiter = new LoginRateLimiter();
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.checkLocked('1.2.3.4').locked, true);
  assert.equal(limiter.checkLocked('5.6.7.8').locked, false);
});
