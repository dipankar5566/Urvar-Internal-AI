import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { db } from '../db/index.js';
import { normalizeLeadKey, isLeadStatus, LEAD_STATUSES, type LeadStatus } from './util.js';

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
const stmtKeys = db.prepare(`SELECT name, location, status FROM leads ORDER BY id DESC LIMIT ?`);

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
      contact: { type: 'string', description: 'Phone / email / website, if found in search results.' },
      source_url: { type: 'string', description: 'URL of the search result the lead came from.' },
      fit_reason: { type: 'string', description: 'One line on why this lead fits Urvar.' },
    },
    required: ['name', 'type', 'location'],
  },
};

export { LEAD_STATUSES, isLeadStatus, type LeadStatus };
