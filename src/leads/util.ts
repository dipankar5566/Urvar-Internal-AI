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

// True when the text contains something that looks like a phone number: 10+
// digits in a row, allowing spaces/dashes/parens between them ("+91 89109
// 63144", "033-2654 3210"). Commas break a match on purpose, so an address
// like "12, Palghat Lane … 711202" (house number + PIN) doesn't false-match.
const PHONE_PATTERN = /(?:\+?\d[\s()-]?){9}\d/;

export function hasPhoneNumber(text: string): boolean {
  return PHONE_PATTERN.test(text);
}

// Minimal lead shape the prompt builders need — kept structural (not LeadRow)
// so these helpers stay importable without the DB module.
export interface LeadLike {
  id: number;
  name: string;
  type: string;
  location: string;
  contact?: string | null;
  fit_reason?: string | null;
  status?: string;
}

function leadLine(l: LeadLike): string {
  const contact = l.contact?.trim() ? ` · contact: ${l.contact.trim()}` : '';
  const fit = l.fit_reason?.trim() ? ` · fit: ${l.fit_reason.trim()}` : '';
  return `- lead #${l.id}: ${l.name} — ${l.type}, ${l.location}${contact}${fit}`;
}

// Prompt for /pitch <id>: a ready-to-send WhatsApp intro + call opener for one
// specific pipeline lead. Pure string-building so Tier-1 tests cover it.
export function buildPitchPrompt(lead: LeadLike): string {
  return `OUTREACH DRAFT TASK. Write first-contact outreach for this specific B2B lead from our pipeline:

${leadLine(lead)}

Produce exactly two pieces, personalized to this business's type and location:
1. **WhatsApp intro** — ready to send as-is: 3-5 short lines, plain language, no placeholders like [Name]. Introduce Urvar Natural, lead with the benefit most relevant to a ${lead.type}, end with one easy question to answer.
2. **Call opener** — a 30-second phone script: who we are, why we're calling THEM specifically, and the one question to ask.

Match the angle to the lead type (retailer → margin & fast-moving organic category; FPO → bulk pricing & farmer welfare; nursery → home-gardener demand & repeat purchases; distributor → territory & growing organic segment). Keep claims grounded in Urvar's actual products from the knowledge context — no invented prices or certifications.`;
}

// Prompt for the call sheet: turns the top call-ready leads into a compact,
// phone-in-hand briefing. Pure string-building so Tier-1 tests cover it.
export function buildCallSheetPrompt(leads: LeadLike[]): string {
  const list = leads.map(leadLine).join('\n');
  return `CALL SHEET TASK. These are today's priority leads from our pipeline — the sales owner will work through them by phone/WhatsApp right now:

${list}

For EACH lead, output exactly this compact format (no extra sections, no preamble):

#<id> <name> — <type>, <location>
📞 <phone number, extracted from the contact details above>
💡 <ONE line: the strongest reason this lead fits Urvar>
🗣 <ONE or TWO sentences: a personalized opening line for the call or WhatsApp message>

Order the leads exactly as given. Use only phone numbers present in the contact details above — never invent one. Keep the whole sheet scannable on a phone screen.`;
}

// One-line pipeline funnel, shown in /leads and the weekly report.
export function formatFunnel(counts: Partial<Record<LeadStatus, number>>): string {
  const n = (s: LeadStatus): number => counts[s] ?? 0;
  const active = `🆕 ${n('new')} new · 📞 ${n('contacted')} contacted · 💬 ${n('responded')} responded · ✅ ${n('converted')} converted`;
  const dead = n('dead') > 0 ? ` · ✖️ ${n('dead')} dead` : '';
  return active + dead;
}

// Prompt for the /enrich flow: sends the lead agent hunting for phone numbers
// of pipeline leads saved without one. Pure string-building so Tier-1 tests
// cover it.
export function buildEnrichmentPrompt(
  leads: Array<{ id: number; name: string; type: string; location: string; contact?: string | null }>,
): string {
  const list = leads
    .map((l) => {
      const known = l.contact?.trim() ? ` (known so far: ${l.contact.trim()})` : '';
      return `- lead id ${l.id}: ${l.name} — ${l.type}, ${l.location}${known}`;
    })
    .join('\n');
  return `CONTACT ENRICHMENT TASK. The following leads are already in our pipeline but have NO phone number. For each one, search the web for a phone number (and address/email/website if available). Search business directories first (justdial.com, indiamart.com), then the open web with the business name + location + "phone" / "contact".

${list}

For every lead where you find a phone number, call the update_lead tool with its lead id. The contact you pass REPLACES the stored one, so include the details already known (shown above) plus what you found. Do NOT call save_lead — these leads already exist. If you cannot find a phone number for a lead after searching, say so in your summary rather than guessing. Finish with a short summary: which leads were enriched (with the number found) and which remain without a phone.`;
}
