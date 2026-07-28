import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type TelegramBot from 'node-telegram-bot-api';
import { appendHistory, clearHistory, getHistory, getLastAgentUsed, listSessionsByPrefix } from '../../db/index.js';
import { runOrchestrator, type AgentType } from '../../orchestrator/index.js';
import { cropDoctorAgent } from '../../agents/crop-doctor.js';
import { distillConversationToKb } from '../../learning/index.js';
import { requireAuth } from '../auth.js';

// Web-chat sessions are prefixed so they never collide with Telegram chat ids
// (plain numeric strings) or the report/* synthetic sessions.
const WEB_SESSION_PREFIX = 'web:';

function mintSessionId(existing?: string): string {
  if (existing && existing.startsWith(WEB_SESSION_PREFIX)) return existing;
  return `${WEB_SESSION_PREFIX}${randomUUID()}`;
}

// Mirrors bot/telegram.ts's per-chat turn counter — every 3 turns the
// conversation is distilled into KB fact candidates for owner review. Kept
// separate from the Telegram counter (module-private there) since sessions
// never overlap between the two surfaces.
const turnCounters = new Map<string, number>();

function maybeDistill(bot: TelegramBot, sessionId: string): void {
  const turns = (turnCounters.get(sessionId) ?? 0) + 1;
  turnCounters.set(sessionId, turns);
  if (turns % 3 !== 0) return;
  const recentHistory = getHistory(sessionId);
  const conversationText = recentHistory
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  void distillConversationToKb(bot, sessionId, conversationText);
}

const VALID_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Matches MAX_PHOTOS_PER_DIAGNOSIS in bot/telegram.ts — Crop Doctor diagnoses
// up to this many photos of one plant as a single case.
const MAX_IMAGES = 3;

export function createChatRouter(bot: TelegramBot): Router {
  const router = Router();
  router.use(requireAuth());

  // Sidebar conversation list — most recently active web: session first, with
  // a preview of its opening message.
  router.get('/sessions', (_req, res) => {
    res.json({ sessions: listSessionsByPrefix(WEB_SESSION_PREFIX, 30) });
  });

  router.delete('/sessions/:id', (req, res) => {
    const sessionId = req.params.id;
    if (!sessionId.startsWith(WEB_SESSION_PREFIX)) {
      res.status(400).json({ error: 'Invalid session id.' });
      return;
    }
    clearHistory(sessionId);
    res.status(204).end();
  });

  // Lets a reloaded page re-hydrate the visible transcript for a session it
  // already knows the id of. Restricted to web: sessions — getHistory() takes
  // any session id, and this endpoint must not become a way to read Telegram
  // chat histories or the report:* archives by guessing/passing their ids.
  router.get('/history', (req, res) => {
    const sessionId = req.query['sessionId'] as string | undefined;
    if (!sessionId || !sessionId.startsWith(WEB_SESSION_PREFIX)) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: getHistory(sessionId) });
  });

  router.post('/', async (req, res) => {
    const { sessionId: rawSessionId, message } = req.body as { sessionId?: string; message?: string };
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'message is required.' });
      return;
    }
    const sessionId = mintSessionId(rawSessionId);
    const userText = message.trim();

    const history = getHistory(sessionId);
    const lastAgent = getLastAgentUsed(sessionId) as AgentType | null;
    const result = await runOrchestrator(userText, history, lastAgent);

    appendHistory(sessionId, 'user', userText);
    appendHistory(sessionId, 'assistant', result.response, result.agentUsed, {
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cache_read: result.cacheRead,
      cache_write: result.cacheWrite,
    });

    maybeDistill(bot, sessionId);

    res.json({
      sessionId,
      response: result.response,
      agentUsed: result.agentUsed,
      usage: {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
      },
    });
  });

  router.post('/image', async (req, res) => {
    const { sessionId: rawSessionId, caption, images } = req.body as {
      sessionId?: string;
      caption?: string;
      images?: Array<{ base64: string; mediaType: string }>;
    };
    if (!images || images.length === 0) {
      res.status(400).json({ error: 'At least one image is required.' });
      return;
    }
    if (images.length > MAX_IMAGES) {
      res.status(400).json({ error: `At most ${MAX_IMAGES} images per diagnosis.` });
      return;
    }
    for (const img of images) {
      if (!img.base64 || !VALID_MEDIA_TYPES.has(img.mediaType)) {
        res.status(400).json({ error: 'Each image needs base64 data and mediaType image/jpeg|png|webp.' });
        return;
      }
    }
    const sessionId = mintSessionId(rawSessionId);
    const validatedImages = images as Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }>;

    const history = getHistory(sessionId);
    const result = await cropDoctorAgent.runWithImages(caption ?? '', validatedImages, history);

    const userLabel = caption?.trim() ? `[photo] ${caption.trim()}` : '[photo]';
    appendHistory(sessionId, 'user', userLabel);
    appendHistory(sessionId, 'assistant', result.response, 'crop_doctor', {
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cache_read: result.cacheRead,
      cache_write: result.cacheWrite,
    });

    maybeDistill(bot, sessionId);

    res.json({
      sessionId,
      response: result.response,
      agentUsed: 'crop_doctor',
      usage: {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
      },
    });
  });

  return router;
}
