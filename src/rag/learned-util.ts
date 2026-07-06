// Pure helpers for the learned-knowledge feature. No DB, network, or env
// dependencies — kept separate from learned.ts so the Tier-1 unit tests can
// exercise them without opening SQLite or touching any API key.

// Sentinel sourceFile marking a chunk as learned (vs. a curated doc filename).
// retrieveRelevantContext() keys off this to label the chunk "(unverified)".
export const LEARNED_SOURCE_FILE = 'learned';

// Knowledge categories. Learned facts (and the agents that retrieve them) are
// split so crop agronomy doesn't crowd business intelligence in retrieval.
export type KbCategory = 'business' | 'agronomy';

// Derive a fact's category from where it came from. Crop Doctor diagnoses yield
// agronomy; everything else (conversation/web/periodic distillation, /teach) is
// treated as business intelligence.
export function categoryForSource(source: string): KbCategory {
  return source === 'crop_doctor' ? 'agronomy' : 'business';
}

export type KbAction = 'approve' | 'edit' | 'reject';

const KB_ACTIONS: ReadonlySet<string> = new Set(['approve', 'edit', 'reject']);

// Inline-button callback_data is encoded as `kb:<action>:<id>`. Returns null for
// anything that isn't a well-formed kb callback (so the handler can ignore it).
export function parseKbCallback(data: string | undefined): { action: KbAction; id: number } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'kb') return null;
  const action = parts[1] ?? '';
  if (!KB_ACTIONS.has(action)) return null;
  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id < 0) return null;
  return { action: action as KbAction, id };
}

// Normalize a fact for dedupe comparison: lowercase, collapse whitespace, trim,
// drop a trailing period. Case/spacing/punctuation differences shouldn't create
// duplicate KB entries.
export function normalizeFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

// Parse the distiller's response into fact strings. The contract is a JSON
// array, possibly wrapped in prose or a code fence. Returns null when no
// complete array is present at all — the model ignored the output format (or
// hit the token cap mid-array) — which callers must treat as a distiller
// failure worth logging, NOT as "no facts found" ([] means that).
export function parseFactsResponse(text: string): string[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  } catch {
    return null;
  }
}

// A candidate is a duplicate if its normalized form exactly matches, or is fully
// contained in / contains, any existing normalized fact. Cheap substring check —
// good enough to stop obvious repeats without embedding every proposal.
export function isDuplicate(candidate: string, existing: string[]): boolean {
  const c = normalizeFact(candidate);
  if (!c) return true; // empty/whitespace-only is never worth storing
  return existing.some((e) => {
    const n = normalizeFact(e);
    return n === c || n.includes(c) || c.includes(n);
  });
}
