import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { db } from '../db/index.js';
import { normalizeLeadKey, isLeadStatus, hasPhoneNumber, LEAD_STATUSES, type LeadStatus } from './util.js';

// Persistent B2B lead pipeline. The Lead Generation agent saves each qualified
// lead via the save_lead tool; the dedup_key UNIQUE constraint stops the same
// business from re-entering the pipeline across sessions.

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    location    TEXT NOT NULL,
    contact     TEXT,
    source_url  TEXT,
    fit_reason  TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    dedup_key   TEXT NOT NULL UNIQUE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
`);

export interface LeadInput {
  name: string;
  type: string;
  location: string;
  contact?: string;
  source_url?: string;
  fit_reason?: string;
}

export interface LeadRow extends LeadInput {
  id: number;
  status: LeadStatus;
  created_at: string;
}

const stmtInsert = db.prepare(`
  INSERT INTO leads (name, type, location, contact, source_url, fit_reason, dedup_key)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtByKey = db.prepare(`SELECT id, status FROM leads WHERE dedup_key = ?`);
const stmtList = db.prepare(`
  SELECT id, name, type, location, contact, source_url, fit_reason, status, created_at
  FROM leads ORDER BY created_at DESC, id DESC LIMIT ?
`);
const stmtListByStatus = db.prepare(`
  SELECT id, name, type, location, contact, source_url, fit_reason, status, created_at
  FROM leads WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);
const stmtUpdateStatus = db.prepare(
  `UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
);
const stmtUpdateContact = db.prepare(
  `UPDATE leads SET contact = ?, source_url = COALESCE(?, source_url), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
);
const stmtActive = db.prepare(`
  SELECT id, name, type, location, contact, source_url, fit_reason, status, created_at
  FROM leads
  WHERE status NOT IN ('converted', 'dead')
  ORDER BY created_at DESC, id DESC LIMIT ?
`);
const stmtKeys = db.prepare(`SELECT name, location, status FROM leads ORDER BY id DESC LIMIT ?`);
const stmtById = db.prepare(`
  SELECT id, name, type, location, contact, source_url, fit_reason, status, created_at
  FROM leads WHERE id = ?
`);
const stmtWorkable = db.prepare(`
  SELECT id, name, type, location, contact, source_url, fit_reason, status, created_at, updated_at
  FROM leads
  WHERE status IN ('new', 'contacted', 'responded')
  ORDER BY created_at ASC, id ASC LIMIT ?
`);
const stmtFunnel = db.prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status`);
const stmtNewThisWeek = db.prepare(
  `SELECT COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', '-7 days')`,
);

export type SaveLeadResult =
  | { saved: true; id: number }
  | { saved: false; existingId: number; existingStatus: LeadStatus };

export function saveLead(input: LeadInput): SaveLeadResult {
  const key = normalizeLeadKey(input.name, input.location);
  const existing = stmtByKey.get(key) as { id: number; status: LeadStatus } | undefined;
  if (existing) return { saved: false, existingId: existing.id, existingStatus: existing.status };
  const info = stmtInsert.run(
    input.name.trim().slice(0, 200),
    input.type.trim().slice(0, 60),
    input.location.trim().slice(0, 120),
    input.contact?.trim().slice(0, 300) ?? null,
    input.source_url?.trim().slice(0, 500) ?? null,
    input.fit_reason?.trim().slice(0, 500) ?? null,
    key,
  );
  return { saved: true, id: Number(info.lastInsertRowid) };
}

export function listLeads(status?: LeadStatus, limit = 30): LeadRow[] {
  const rows = status ? stmtListByStatus.all(status, limit) : stmtList.all(limit);
  return rows as unknown as LeadRow[];
}

// Returns true if the row existed and was updated.
export function updateLeadStatus(id: number, status: LeadStatus): boolean {
  return stmtUpdateStatus.run(status, id).changes > 0;
}

// Fills in contact details on an existing lead (the /enrich flow). Keeps the
// original source_url unless a new one is provided.
export function updateLeadContact(id: number, contact: string, sourceUrl?: string): boolean {
  return (
    stmtUpdateContact.run(contact.trim().slice(0, 300), sourceUrl?.trim().slice(0, 500) ?? null, id)
      .changes > 0
  );
}

// Active-pipeline leads with no phone number in their contact — the /enrich
// flow's work queue. "Missing" means no detectable phone (the agent often
// stores an address or a "View Mobile Number on IndiaMART" stub), not just an
// empty column. Converted/dead leads are excluded (no point enriching them).
const ENRICH_SCAN_LIMIT = 200;

export function listLeadsMissingContact(limit = 8): LeadRow[] {
  const rows = stmtActive.all(ENRICH_SCAN_LIMIT) as unknown as LeadRow[];
  return rows.filter((r) => !hasPhoneNumber(r.contact ?? '')).slice(0, limit);
}

export function getLead(id: number): LeadRow | undefined {
  return stmtById.get(id) as LeadRow | undefined;
}

// The call sheet's work queue: workable leads (new/contacted/responded) that
// have an actual phone number, ordered by call priority — responded first
// (they replied; strike while warm), then new (never touched), then contacted
// (follow-up). Within a group, oldest first, so nothing rots at the bottom.
const CALL_PRIORITY: Record<string, number> = { responded: 0, new: 1, contacted: 2 };
const CALL_SHEET_SCAN_LIMIT = 200;

export function listCallReadyLeads(limit = 5): LeadRow[] {
  const rows = stmtWorkable.all(CALL_SHEET_SCAN_LIMIT) as unknown as LeadRow[];
  return rows
    .filter((r) => hasPhoneNumber(r.contact ?? ''))
    .sort((a, b) => (CALL_PRIORITY[a.status] ?? 9) - (CALL_PRIORITY[b.status] ?? 9))
    .slice(0, limit);
}

export function leadFunnelCounts(): Partial<Record<LeadStatus, number>> {
  const rows = stmtFunnel.all() as Array<{ status: LeadStatus; n: number }>;
  const counts: Partial<Record<LeadStatus, number>> = {};
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export function countLeadsAddedThisWeek(): number {
  return (stmtNewThisWeek.get() as { n: number }).n;
}

// Detailed pipeline block for the Sales & Marketing agent's context, so pitch
// and call-sheet requests ("draft a WhatsApp intro for lead #12") are grounded
// in the actual lead rows instead of generic copy.
export function salesLeadsContext(limit = 40): string {
  const rows = stmtActive.all(limit) as unknown as LeadRow[];
  if (rows.length === 0) return '';
  const lines = rows.map((l) => {
    const contact = l.contact ? ` · contact: ${l.contact}` : ' · no contact yet';
    const fit = l.fit_reason ? ` · fit: ${l.fit_reason}` : '';
    return `- #${l.id} [${l.status}] ${l.name} — ${l.type}, ${l.location}${contact}${fit}`;
  });
  return `## Current B2B lead pipeline (for personalizing outreach — reference leads by #id)\n${lines.join('\n')}`;
}

// Compact "already in the pipeline" block injected into the Lead Generation
// agent's context so it skips known businesses instead of re-listing them.
export function knownLeadsContext(limit = 60): string {
  const rows = stmtKeys.all(limit) as Array<{ name: string; location: string; status: string }>;
  if (rows.length === 0) return '';
  const lines = rows.map((r) => `- ${r.name} (${r.location}) — ${r.status}`);
  return `## Leads already in the pipeline (do NOT re-list these as new leads)\n${lines.join('\n')}`;
}

export const saveLeadToolDefinition: Tool = {
  name: 'save_lead',
  description:
    'Save a qualified B2B lead to the persistent pipeline. Call this once per qualified lead you find via web search. Duplicates (same business + location already saved) are rejected automatically.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Business/organization name.' },
      type: {
        type: 'string',
        description: 'Lead type: distributor, retailer, dealer, FPO, nursery, organic store, export agent, etc.',
      },
      location: { type: 'string', description: 'City and state, e.g. "Ranaghat, West Bengal".' },
      contact: {
        type: 'string',
        description:
          'Phone / email / website / street address, if found in search results. Phone numbers are the most valuable — the sales team contacts leads by phone and WhatsApp.',
      },
      source_url: { type: 'string', description: 'URL of the search result the lead came from.' },
      fit_reason: { type: 'string', description: 'One line on why this lead fits Urvar.' },
    },
    required: ['name', 'type', 'location'],
  },
};

export const updateLeadToolDefinition: Tool = {
  name: 'update_lead',
  description:
    'Add contact details to a lead that already exists in the pipeline. Use only when your task lists existing leads by id (contact enrichment) — for new leads use save_lead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The pipeline lead id, as given in the task.' },
      contact: {
        type: 'string',
        description:
          'Contact details found via web search: phone (most valuable), email, website, street address. Replaces the stored contact — include any details already known for the lead.',
      },
      source_url: { type: 'string', description: 'URL of the page where the contact details were found.' },
    },
    required: ['id', 'contact'],
  },
};

export { LEAD_STATUSES, isLeadStatus, type LeadStatus };
