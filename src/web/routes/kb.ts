import { Router } from 'express';
import {
  listPending,
  queryLearned,
  approveLearned,
  rejectLearned,
  editLearned,
  getLearned,
  type LearnedStatus,
  type LearnedSource,
} from '../../rag/learned.js';
import type { KbCategory } from '../../rag/learned-util.js';
import { requireOwner } from '../auth.js';

export function createKbRouter(): Router {
  const router = Router();
  router.use(requireOwner());

  router.get('/pending', (_req, res) => {
    res.json({ pending: listPending() });
  });

  // General browse across all statuses — filters are read-only query params,
  // an invalid value just yields zero rows (no validation needed beyond that;
  // every value is bound, never string-interpolated into SQL).
  router.get('/', (req, res) => {
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '30', 10) || 30, 100);
    const offset = Math.max(parseInt((req.query['offset'] as string) ?? '0', 10) || 0, 0);
    const { facts, total } = queryLearned({
      status: req.query['status'] as LearnedStatus | undefined,
      category: req.query['category'] as KbCategory | undefined,
      source: req.query['source'] as LearnedSource | undefined,
      search: req.query['search'] as string | undefined,
      limit,
      offset,
    });
    res.json({ facts, total, limit, offset });
  });

  router.post('/:id/approve', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return;
    }
    const result = await approveLearned(id, `web:${req.webRole}`);
    res.json(result);
  });

  router.post('/:id/reject', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return;
    }
    const row = getLearned(id);
    if (!row || row.status !== 'pending') {
      res.status(409).json({ error: 'Not a pending item.' });
      return;
    }
    rejectLearned(id);
    res.json({ ok: true });
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const { fact } = req.body as { fact?: string };
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid id.' });
      return;
    }
    if (!fact || !fact.trim()) {
      res.status(400).json({ error: 'fact is required.' });
      return;
    }
    const row = getLearned(id);
    if (!row || row.status !== 'pending') {
      res.status(409).json({ error: 'Not a pending item.' });
      return;
    }
    editLearned(id, fact);
    res.json({ ok: true, fact: getLearned(id) });
  });

  return router;
}
