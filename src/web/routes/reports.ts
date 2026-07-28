import { Router } from 'express';
import { getHistory } from '../../db/index.js';
import { leadFunnelCounts, countLeadsAddedThisWeek, listCallReadyLeads } from '../../leads/index.js';
import { getKbStats, findDuplicateClusters } from '../../rag/learned.js';
import { draftCallSheet, draftContentArticle } from '../../scheduler/index.js';
import { requireAuth, requireOwner } from '../auth.js';

// Same synthetic session ids the weekly-report cron archives successful
// sections under (src/scheduler/index.ts REPORT_SESSIONS) — reading them back
// here avoids re-running the expensive market/competitive agents on every
// dashboard page load.
const REPORT_SESSIONS = {
  market: 'report:market_research',
  competitive: 'report:competitive_analysis',
} as const;

function lastAssistantText(sessionId: string): string | null {
  const history = getHistory(sessionId, 1);
  const last = [...history].reverse().find((m) => m.role === 'assistant');
  if (!last) return null;
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

export function createReportsRouter(): Router {
  const router = Router();

  router.get('/weekly', requireAuth(), (_req, res) => {
    res.json({
      market: lastAssistantText(REPORT_SESSIONS.market),
      competitive: lastAssistantText(REPORT_SESSIONS.competitive),
      funnel: leadFunnelCounts(),
      addedThisWeek: countLeadsAddedThisWeek(),
    });
  });

  router.get('/kbstats', requireOwner(), (_req, res) => {
    res.json({ stats: getKbStats(), duplicates: findDuplicateClusters() });
  });

  router.get('/callsheet-leads', requireAuth(), (_req, res) => {
    res.json({ leads: listCallReadyLeads() });
  });

  // On-demand LLM drafting — not owner-gated, matching the Telegram
  // /callsheet and /article commands (both open to any chat member today).
  router.post('/callsheet/generate', requireAuth(), async (_req, res) => {
    const draft = await draftCallSheet();
    if (!draft) {
      res.json({ ready: [], text: null });
      return;
    }
    res.json({ ready: draft.ready, text: draft.text });
  });

  router.post('/article/generate', requireAuth(), async (req, res) => {
    const { topic } = req.body as { topic?: string };
    const text = await draftContentArticle(topic?.trim() || undefined);
    res.json({ text });
  });

  return router;
}
