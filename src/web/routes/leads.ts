import { Router } from 'express';
import {
  queryLeads,
  updateLeadStatus,
  updateLeadContact,
  leadFunnelCounts,
  saveLead,
  getLead,
  listLeadsMissingContact,
  type LeadInput,
} from '../../leads/index.js';
import { isLeadStatus, buildPitchPrompt, buildEnrichmentPrompt, type LeadStatus } from '../../leads/util.js';
import { salesMarketingAgent } from '../../agents/sales-marketing.js';
import { leadGenerationAgent } from '../../agents/lead-generation.js';
import { requireAuth } from '../auth.js';

export function createLeadsRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get('/', (req, res) => {
    const rawStatus = req.query['status'] as string | undefined;
    let status: LeadStatus | undefined;
    if (rawStatus !== undefined) {
      if (!isLeadStatus(rawStatus)) {
        res.status(400).json({ error: `Invalid status: ${rawStatus}` });
        return;
      }
      status = rawStatus;
    }
    const search = (req.query['search'] as string | undefined)?.trim() || undefined;
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '30', 10) || 30, 100);
    const offset = Math.max(parseInt((req.query['offset'] as string) ?? '0', 10) || 0, 0);
    const { leads, total } = queryLeads({ status, search, limit, offset });
    res.json({ leads, total, limit, offset, funnel: leadFunnelCounts() });
  });

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid lead id.' });
      return;
    }
    const lead = getLead(id);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }
    res.json({ lead });
  });

  // Contact-hunting round for leads saved without a phone number — mirrors
  // the Telegram /enrich flow. Not owner-gated, matching /enrich today.
  router.post('/enrich', async (_req, res) => {
    const missing = listLeadsMissingContact();
    if (missing.length === 0) {
      res.json({ enriched: 0, response: null });
      return;
    }
    const result = await leadGenerationAgent.run(buildEnrichmentPrompt(missing), []);
    res.json({ enriched: missing.length, response: result.response });
  });

  router.post('/:id/pitch', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid lead id.' });
      return;
    }
    const lead = getLead(id);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }
    const result = await salesMarketingAgent.run(buildPitchPrompt(lead), []);
    res.json({ response: result.response });
  });

  router.post('/', (req, res) => {
    const { name, type, location, contact, source_url, fit_reason } = req.body as Partial<LeadInput>;
    if (!name?.trim() || !type?.trim() || !location?.trim()) {
      res.status(400).json({ error: 'name, type, and location are required.' });
      return;
    }
    const result = saveLead({ name, type, location, contact, source_url, fit_reason });
    if (!result.saved) {
      res.status(409).json({
        error: 'A lead with this name and location already exists.',
        existingId: result.existingId,
        existingStatus: result.existingStatus,
      });
      return;
    }
    res.status(201).json({ id: result.id });
  });

  router.patch('/:id/status', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body as { status?: string };
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid lead id.' });
      return;
    }
    if (!status || !isLeadStatus(status)) {
      res.status(400).json({ error: `Invalid status: ${status}` });
      return;
    }
    const updated = updateLeadStatus(id, status);
    if (!updated) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.patch('/:id/contact', (req, res) => {
    const id = Number(req.params.id);
    const { contact, sourceUrl } = req.body as { contact?: string; sourceUrl?: string };
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid lead id.' });
      return;
    }
    if (!contact || !contact.trim()) {
      res.status(400).json({ error: 'contact is required.' });
      return;
    }
    const updated = updateLeadContact(id, contact, sourceUrl);
    if (!updated) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
