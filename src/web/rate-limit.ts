// Pure, Express-free login lockout — a 4-6 character shared password has no
// real defense against brute force without this. In-memory only (this is a
// single-process LAN tool; no need for a shared store across instances).

const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 30_000; // 30s
const MAX_LOCKOUT_MS = 15 * 60 * 1000; // 15 min cap, doubling each time the key relocks

interface AttemptState {
  failures: number;
  lockedUntil: number; // epoch ms; 0 = not currently locked
}

export interface LockStatus {
  locked: boolean;
  retryAfterMs: number;
}

export class LoginRateLimiter {
  private attempts = new Map<string, AttemptState>();

  constructor(private readonly now: () => number = Date.now) {}

  checkLocked(key: string): LockStatus {
    const state = this.attempts.get(key);
    if (!state || state.lockedUntil === 0) return { locked: false, retryAfterMs: 0 };
    const remaining = state.lockedUntil - this.now();
    if (remaining <= 0) return { locked: false, retryAfterMs: 0 };
    return { locked: true, retryAfterMs: remaining };
  }

  recordFailure(key: string): void {
    const state = this.attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
    state.failures += 1;
    if (state.failures % MAX_FAILURES === 0) {
      const lockoutCycle = state.failures / MAX_FAILURES - 1;
      const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** lockoutCycle, MAX_LOCKOUT_MS);
      state.lockedUntil = this.now() + lockoutMs;
    }
    this.attempts.set(key, state);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

export const loginRateLimiter = new LoginRateLimiter();
