export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    const cutAt =
      remaining.lastIndexOf('\n', maxLen) > 0
        ? remaining.lastIndexOf('\n', maxLen)
        : maxLen;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return parts;
}

interface UsageLike {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

// Owner-only token/cost footer appended to a reply.
// Sonnet 4.6 pricing (USD per 1M tokens). Update if CLAUDE_MODEL changes.
// input $3, output $15, cache read 0.1x = $0.30, cache write 1.25x = $3.75
export function formatUsageFooter(u: UsageLike): string {
  // The 'general' no-op fallback returns zero usage — show nothing.
  if (u.tokensIn === 0 && u.tokensOut === 0) return '';
  const cost =
    (u.tokensIn * 3 + u.tokensOut * 15 + u.cacheRead * 0.3 + u.cacheWrite * 3.75) / 1_000_000;
  const n = (x: number): string => x.toLocaleString('en-US');
  return `_↳ ${n(u.tokensIn)} in · ${n(u.tokensOut)} out · ${n(u.cacheRead)} cached · ~$${cost.toFixed(4)}_`;
}

export function formatUptime(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
