import ExcelJS from 'exceljs';
import { PHONE_PATTERN, hasPhoneNumber, type LeadLike } from './util.js';

// Pure mapping logic — no DB/network imports beyond exceljs itself, so
// extractPhoneNumber/splitLocation/mapLeadToExportRow stay Tier-1 unit
// testable (same convention as src/leads/util.ts).

// Reuses hasPhoneNumber's exact regex (not a re-typed copy) so the two always
// agree on what "looks like a phone number" means.
export function extractPhoneNumber(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(PHONE_PATTERN);
  if (!match) return null;
  return match[0].replace(/[\s()-]/g, '');
}

// Splits a "City, State" location (the format the lead-gen agent is
// instructed to use, per saveLeadToolDefinition's location description) into
// District/State. Only the first comma is honored — a "Village, District,
// State" string puts everything after it into `state` verbatim. Known,
// deliberate limitation: blank/imperfect beats fabricated for the CRM's
// required State/District columns.
export function splitLocation(location: string): { district: string; state: string } {
  const commaIndex = location.indexOf(',');
  if (commaIndex === -1) return { district: location.trim(), state: '' };
  return {
    district: location.slice(0, commaIndex).trim(),
    state: location.slice(commaIndex + 1).trim(),
  };
}

// Exact header row of the CRM's bulk-import template, in order.
export const LEAD_EXPORT_COLUMNS = [
  'Name *',
  'Phone *',
  'Lead Source',
  'Customer Type',
  'State *',
  'District *',
  'Company Name',
  'Contact Person',
  'WhatsApp Number',
  'Email',
  'Pincode',
  'Address',
  'Interested Products',
  'Expected Quantity',
  'Expected Monthly Value',
  'Estimated Value',
  'Crop Interest',
  'Remarks',
] as const;

export function mapLeadToExportRow(lead: LeadLike): string[] {
  const { district, state } = splitLocation(lead.location);
  const contact = lead.contact?.trim() ?? '';
  const phone = extractPhoneNumber(contact);
  // Address only gets the raw contact text when it isn't phone-shaped — a
  // contact string is either a phone number or free-text (address / stub),
  // never usefully both.
  const address = !phone && contact && !hasPhoneNumber(contact) ? contact : '';

  return [
    lead.name, // Name *
    phone ?? '', // Phone *
    '', // Lead Source
    lead.type, // Customer Type
    state, // State *
    district, // District *
    lead.name, // Company Name
    '', // Contact Person
    '', // WhatsApp Number
    '', // Email
    '', // Pincode
    address, // Address
    '', // Interested Products
    '', // Expected Quantity
    '', // Expected Monthly Value
    '', // Estimated Value
    '', // Crop Interest
    lead.fit_reason?.trim() ?? '', // Remarks
  ];
}

// The only function here that touches exceljs — builds a workbook matching
// the CRM template's shape (single "Template" sheet, one header row, no
// styling/formulas/dropdowns) and returns it as a ready-to-send buffer.
export async function buildLeadExportWorkbook(leads: LeadLike[]): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Template');
  sheet.addRow([...LEAD_EXPORT_COLUMNS]);
  for (const lead of leads) sheet.addRow(mapLeadToExportRow(lead));
  return workbook.xlsx.writeBuffer();
}
