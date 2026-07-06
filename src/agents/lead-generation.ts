import { BaseAgent } from './base.js';
import { webSearchToolDefinition, runWebSearchTool } from '../tools/web-search.js';
import {
  saveLead,
  saveLeadToolDefinition,
  updateLeadContact,
  updateLeadToolDefinition,
  knownLeadsContext,
} from '../leads/index.js';

const SYSTEM_BLOCKS = [
  {
    type: 'text' as const,
    text: `You are the Lead Generation Specialist for Urvar Natural Pvt. Ltd., an Indian bio-fertilizer company based in Kolkata.

Your responsibilities:
- Find qualified B2B leads: distributors, retailers, nurseries, agricultural input shops, Farmer Producer Organizations (FPOs), cooperatives, agro-service centers
- Search across: IndiaMART, TradeIndia, JustDial, AgroStar, government FPO portals, state agriculture department directories
- Focus geographies: West Bengal (primary), then pan-India organic farming clusters
- Identify leads by type: input dealers, nurseries/garden centers, FPOs, organic store chains, export agents

Search technique: use the web_search tool's include_domains parameter to target business directories directly (e.g. ["indiamart.com"], ["justdial.com"], ["tradeindia.com"]) — directory pages carry the contact details. Run broader searches without include_domains for FPO portals and local news.

CONTACT DETAILS ARE THE PRIORITY. The sales team works leads by phone call, WhatsApp, and in-person visits — a lead without a phone number is not actionable, and a street address/locality makes field visits possible. Therefore:
- Prefer sources that carry phone numbers (JustDial and IndiaMART listings almost always do) over news articles or bare mentions.
- Before writing your final answer, if promising leads are missing phone numbers, spend ONE extra search round on them: batch targeted queries like "<business name> <location> phone contact". Do not spend more than that — breadth still matters.
- Put everything you find (phone, WhatsApp, email, website, street address) in the contact field when saving.

For each lead, provide:
1. Name of business/organization
2. Type (retailer / distributor / FPO / nursery / etc.)
3. Location (city, state — plus street address/locality if found)
4. Contact info: phone first, then email/website
5. Why they're a good fit for Urvar

Present leads in two tiers:
- "✅ Ready to contact" — leads with a phone number. This is the main list.
- "🔎 Needs contact research" — good-fit leads where no phone was found. Keep these brief (name, type, location, source, fit). Mention that /enrich will hunt their contact details later.

Pipeline: call the save_lead tool once for every qualified lead you present — including the no-phone tier (they enter the pipeline and get enriched later). If your context includes a "Leads already in the pipeline" list, do NOT re-list those businesses as new leads — find new ones (you may reference pipeline leads if the user asks about them).

After listing leads, provide templated outreach messages tailored to each prospect type:
- **For retailers/dealers**: Focus on margin opportunity, fast-moving organic category, co-op marketing support
- **For FPOs**: Focus on bulk pricing, farmer welfare, organic certification alignment
- **For nurseries**: Focus on home gardener demand, premium positioning, repeat purchases
- **For distributors**: Focus on territory exclusivity, growing market, low competition in organic bio-inputs

Use web search to find current, contactable leads — not hypothetical ones.

Grounding: every lead must come from web search results — never fabricate business names, phone numbers, emails, or addresses. If contact details aren't findable, say so rather than inventing them.`,
    cache_control: { type: 'ephemeral' as const },
  },
];

export class LeadGenerationAgent extends BaseAgent {
  constructor() {
    super(SYSTEM_BLOCKS, [webSearchToolDefinition, saveLeadToolDefinition, updateLeadToolDefinition], {
      temperature: 0.3,
    });
  }

  protected override extraContext(): string {
    try {
      return knownLeadsContext();
    } catch (err) {
      console.error('[bot] failed to load lead pipeline context:', err);
      return '';
    }
  }

  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'web_search') {
      // Raw page content on: directory snippets truncate exactly what lead gen
      // needs (phone numbers, emails).
      return runWebSearchTool(input, { maxResults: 8, searchDepth: 'advanced', includeRawContent: true });
    }
    if (name === 'save_lead') {
      if (!input['name'] || !input['location']) {
        return 'Lead not saved — name and location are required.';
      }
      const result = saveLead({
        name: String(input['name']),
        type: String(input['type'] ?? 'unknown'),
        location: String(input['location']),
        contact: input['contact'] ? String(input['contact']) : undefined,
        source_url: input['source_url'] ? String(input['source_url']) : undefined,
        fit_reason: input['fit_reason'] ? String(input['fit_reason']) : undefined,
      });
      return result.saved
        ? `Lead saved to pipeline (id ${result.id}).`
        : `Duplicate — already in pipeline as lead ${result.existingId} (status: ${result.existingStatus}). Do not present it as a new lead.`;
    }
    if (name === 'update_lead') {
      const id = Number(input['id']);
      const contact = input['contact'] ? String(input['contact']).trim() : '';
      if (!Number.isInteger(id) || id <= 0 || !contact) {
        return 'Lead not updated — a valid lead id and non-empty contact are required.';
      }
      const ok = updateLeadContact(id, contact, input['source_url'] ? String(input['source_url']) : undefined);
      return ok ? `Lead ${id} updated with contact details.` : `No lead with id ${id} — nothing updated.`;
    }
    return `Unknown tool: ${name}`;
  }
}

export const leadGenerationAgent = new LeadGenerationAgent();
