import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { drainRecentSearches } from '../tools/web-search.js';
import { proposeLearned, getLearned } from '../rag/learned.js';
import type { LearnedSource } from '../rag/learned.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Pull recent assistant/user turns across all sessions for the periodic distill.
const stmtRecentConversations = db.prepare(`
  SELECT role, content FROM conversation_history
  ORDER BY created_at DESC
  LIMIT ?
`);

// Distil durable, company-wide knowledge worth promoting to the shared KB. This
// is intentionally stricter than the per-session memory extractor: we only want
// facts useful to *every* future conversation, not one user's preferences.
export async function distillKbFacts(
  content: string,
  kind: 'conversation' | 'web_research' | 'agronomy',
): Promise<string[]> {
  const focus =
    kind === 'web_research'
      ? 'verified external facts: market data, competitor moves, pricing, regulations, agronomic findings'
      : kind === 'agronomy'
        ? 'general, reusable agronomy facts that apply to ANY farmer — e.g. which deficiency/disease/pest causes which symptoms, and which Urvar product treats it. Phrase each as a general rule (e.g. "Boron deficiency causes bud blast in roses; treat with Boron EDTA foliar spray"). STRICTLY EXCLUDE anything specific to this user\'s individual plant, pot, photo, or this one case'
        : 'durable company-wide facts: confirmed product details, pricing decisions, market insights, competitor intelligence';
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `From the material below, extract 0–5 ${focus} that belong in a shared company knowledge base used to answer future questions for everyone.

Only include facts that are concrete, durable, and broadly useful. Exclude one-off requests, personal preferences, speculation, and anything you are unsure is true.

Return ONLY a JSON array of short factual strings (each under 200 chars). If nothing qualifies, return [].

Material:
${content}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
  } catch {
    // Best-effort — distillation must never crash the caller.
    return [];
  }
}

// Send a pending fact to the owner with Approve / Edit / Reject inline buttons.
// No-op (logs only) if no owner is configured — graceful degradation.
export async function notifyOwnerOfPending(
  bot: TelegramBot,
  id: number,
  fact: string,
  source: LearnedSource,
): Promise<void> {
  if (!config.ownerTelegramId) {
    console.log(`[learning] Pending KB fact #${id} (no owner configured to review): ${fact}`);
    return;
  }
  try {
    // No parse_mode: fact/source text is unpredictable and would break Telegram's
    // Markdown parser (e.g. the underscore in "crop_doctor" → 400 can't-parse).
    await bot.sendMessage(
      config.ownerTelegramId,
      `🧠 New knowledge candidate (${source.replace(/_/g, ' ')})\n\n${fact}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `kb:approve:${id}` },
              { text: '✏️ Edit', callback_data: `kb:edit:${id}` },
              { text: '❌ Reject', callback_data: `kb:reject:${id}` },
            ],
          ],
        },
      },
    );
  } catch (err) {
    console.error('[learning] Failed to notify owner of pending fact:', err);
  }
}

// Propose a fact and, if it's genuinely new, route it to the owner for review.
export async function proposeAndNotify(
  bot: TelegramBot,
  fact: string,
  source: LearnedSource,
  detail: string | null,
  proposedBy: string | null,
): Promise<void> {
  if (!config.kbLearningEnabled) return;
  const id = proposeLearned(fact, source, detail, proposedBy);
  if (id === null) return; // deduped
  await notifyOwnerOfPending(bot, id, fact, source);
}

// Distil durable facts from a single conversation and queue them for review.
// Called non-blocking (void) from the Telegram message handler.
export async function distillConversationToKb(
  bot: TelegramBot,
  sessionId: string,
  conversationText: string,
): Promise<void> {
  if (!config.kbLearningEnabled) return;
  const facts = await distillKbFacts(conversationText, 'conversation');
  for (const fact of facts) {
    await proposeAndNotify(bot, fact, 'conversation', sessionId, sessionId);
  }
}

// Distil ONLY general, reusable agronomy facts from a Crop Doctor diagnosis —
// case-specific details about the user's individual plant are excluded by the
// 'agronomy' prompt. Called non-blocking (void) from the photo handler.
export async function distillAgronomyToKb(
  bot: TelegramBot,
  sessionId: string,
  diagnosisText: string,
): Promise<void> {
  if (!config.kbLearningEnabled) return;
  const facts = await distillKbFacts(diagnosisText, 'agronomy');
  for (const fact of facts) {
    await proposeAndNotify(bot, fact, 'crop_doctor', sessionId, sessionId);
  }
}

// Periodic job: distil recent conversations + captured web searches into KB
// candidates, then notify the owner. Skips quietly if learning is disabled.
async function runPeriodicDistill(bot: TelegramBot): Promise<void> {
  if (!config.kbLearningEnabled) return;
  console.log('[learning] Running periodic KB distillation…');

  // 1. Captured web research.
  const searches = drainRecentSearches();
  if (searches.length > 0) {
    const block = searches.map((s) => `Q: ${s.query}\nA: ${s.answer}`).join('\n\n');
    const facts = await distillKbFacts(block, 'web_research');
    for (const fact of facts) await proposeAndNotify(bot, fact, 'web_research', null, 'periodic');
  }

  // 2. Recent conversations across all sessions.
  const rows = stmtRecentConversations.all(40) as Array<{ role: string; content: string }>;
  if (rows.length > 0) {
    const convo = rows.reverse().map((r) => `${r.role}: ${r.content}`).join('\n');
    const facts = await distillKbFacts(convo, 'conversation');
    for (const fact of facts) await proposeAndNotify(bot, fact, 'periodic', null, 'periodic');
  }

  console.log('[learning] Periodic KB distillation complete.');
}

export function startLearningScheduler(bot: TelegramBot): void {
  if (!config.kbLearningEnabled) {
    console.log('[learning] KB learning disabled — periodic distillation not scheduled.');
    return;
  }
  cron.schedule(
    config.kbDistillCron,
    () => {
      runPeriodicDistill(bot).catch((err) =>
        console.error('[learning] Periodic distillation failed:', err),
      );
    },
    { timezone: 'Asia/Kolkata' },
  );
  console.log(`[learning] KB distillation scheduled — cron "${config.kbDistillCron}" IST.`);
}

// Re-exported so the Telegram callback handler can resolve a fact for the edit
// flow without importing the data layer directly.
export { getLearned };
