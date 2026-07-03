// Pure helpers for the leads pipeline — no DB/network imports, so Tier-1 unit
// tests cover them without keys (same pattern as src/rag/learned-util.ts).

export const LEAD_STATUSES = ['new', 'contacted', 'responded', 'converted', 'dead'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

// Legal-form suffixes that don't distinguish one business from another.
const NAME_NOISE = /\b(pvt|private|ltd|limited|llp|inc|co|company|enterprises?|traders?|agencies|agency)\b/g;

// Dedup key for a lead: lowercase name + location with punctuation, legal-form
// suffixes, and whitespace noise removed, so "M/s Green Agro Pvt. Ltd, Kolkata"
// and "Green Agro Private Limited — Kolkata" collapse to the same key.
export function normalizeLeadKey(name: string, location: string): string {
  const clean = (s: string): string =>
    s
      .toLowerCase()
      .replace(/m\/s\.?/g, ' ')
      .replace(NAME_NOISE, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  return `${clean(name)}|${clean(location)}`;
}
