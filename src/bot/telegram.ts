import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { appendHistory, getHistory, clearHistory, getLastAgentUsed } from '../db/index.js';
import { runOrchestrator, type AgentType } from '../orchestrator/index.js';
import { sendWeeklyReport } from '../scheduler/index.js';
import { cropDoctorAgent, fetchTelegramImage } from '../agents/crop-doctor.js';
import { splitMessage, formatUptime, formatUsageFooter, sendMarkdownSafe } from '../utils/message.js';
import { listLeads, updateLeadStatus, isLeadStatus, LEAD_STATUSES, listLeadsMissingContact, getLead, leadFunnelCounts } from '../leads/index.js';
import { buildEnrichmentPrompt, buildPitchPrompt, formatFunnel, hasPhoneNumber } from '../leads/util.js';
import { leadGenerationAgent } from '../agents/lead-generation.js';
import { salesMarketingAgent } from '../agents/sales-marketing.js';
import { sendCallSheet, sendContentDraft } from '../scheduler/index.js';
import { proposeLearned, approveLearned, rejectLearned, editLearned, getLearned, listPending, getKbStats, findDuplicateClusters } from '../rag/learned.js';
import { proposeAndNotify, distillConversationToKb, distillAgronomyToKb, notifyOwnerOfPending } from '../learning/index.js';
import { parseKbCallback } from '../rag/learned-util.js';

const START_TIME = Date.now();

const AGENT_LABELS: Record<string, string> = {
  market_research: '📈 Market Research',
  competitive_analysis: '🔍 Competitive Analysis',
  rd_product_development: '🧪 R&D / Product Development',
  sales_marketing: '📣 Sales & Marketing',
  lead_generation: '🤝 Lead Generation',
  crop_doctor: '🌿 Crop Doctor',
  product_info: '📦 Product & Company Info',
};

function getUserFacingError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    return '⚠️ Too many requests right now. Please try again in a moment.';
  }
  if (err instanceof Anthropic.APIError && err.status >= 500) {
    return '⚠️ The AI service is temporarily unavailable. Please try again shortly.';
  }
  return '⚠️ Something went wrong. Please try again.';
}

const turnCounters = new Map<string, number>();

// Owner id → learned_knowledge id awaiting a corrected wording (the ✏️ Edit
// flow). In-memory, like turnCounters; a missed edit just falls back to a normal
// message, which is acceptable.
const pendingEdits = new Map<string, number>();

// Album buffering for multi-photo diagnosis. Telegram sends an album as separate
// photo messages sharing a media_group_id; we collect them for a short debounce
// window, then diagnose all of them together as one plant.
const MAX_PHOTOS_PER_DIAGNOSIS = 3;
const ALBUM_DEBOUNCE_MS = 1200;

interface PendingAlbum {
  chatId: string;
  fromId: string;
  caption: string;
  fileIds: string[];
  timer: NodeJS.Timeout;
}
// key: `${chatId}:${media_group_id}`
const pendingAlbums = new Map<string, PendingAlbum>();

function isOwner(id: string | number | undefined): boolean {
  return !!config.ownerTelegramId && String(id) === config.ownerTelegramId;
}

export function createBot(): TelegramBot {
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    clearHistory(chatId);
    turnCounters.set(chatId, 0);
    await bot.sendMessage(
      msg.chat.id,
      `👋 *Welcome to Urvar AI Assistant!*\n\nI'm your business intelligence hub for Urvar Natural Pvt. Ltd. I can help with:\n\n📈 *Market Research* — market trends, pricing, demand analysis\n🔍 *Competitive Analysis* — competitor profiling, positioning\n🧪 *R&D / Product Development* — new products, formulations, certifications\n📣 *Sales & Marketing* — WhatsApp outreach drafts, call scripts, website articles\n🤝 *Lead Generation* — finding distributors, retailers, FPOs\n🌿 *Crop Doctor* — send a photo of a sick plant for diagnosis and Urvar product recommendations\n\n📊 Weekly business briefings are sent every *Monday at 9:00 AM IST*.\n\nJust ask me anything — or send a crop photo!`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `*Urvar AI Assistant — Available Specialists*\n\n📈 *Market Research*\nask about: market size, trends, pricing, seasonal demand, distribution channels\n\n🔍 *Competitive Analysis*\nask about: Iffco, Coromandel, Biowin, competitor pricing, SWOT analysis\n\n🧪 *R&D / Product Development*\nask about: new formulations, NPOP certification, FCO compliance, packaging ideas\n\n📣 *Sales & Marketing*\nask to: draft WhatsApp outreach, call scripts, dealer pitches (/pitch <id>), website SEO articles (/article), campaigns\n\n🤝 *Lead Generation*\nask to: find distributors, retailers, FPOs, B2B leads across India — found leads are saved to a pipeline, view with /leads, fill in missing contact details with /enrich, get a prioritized calling list with /callsheet\n\n🌿 *Crop Doctor*\nsend a photo of a sick plant or describe symptoms — get a diagnosis and Urvar product treatment plan\n\nCommands: /start /help /clear /report /leads /enrich /callsheet /pitch /article /teach /pending /kbstats`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.onText(/\/clear/, async (msg) => {
    const chatId = String(msg.chat.id);
    clearHistory(chatId);
    turnCounters.set(chatId, 0);
    await bot.sendMessage(msg.chat.id, '🗑️ Conversation history cleared.');
  });

  bot.onText(/\/ping/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `🟢 *Bot is running*\n⏱ Uptime: ${formatUptime(START_TIME)}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.onText(/\/report/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '📊 Generating weekly business briefing… this may take a minute.');
    try {
      await sendWeeklyReport(bot, msg.chat.id);
    } catch (err) {
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /leads — view the persistent B2B lead pipeline saved by the Lead Generation
  // agent. Forms: `/leads` (recent), `/leads contacted` (filter by status),
  // `/leads 12 contacted` (update lead 12's status).
  bot.onText(/^\/leads(?:\s+(\S+))?(?:\s+(\S+))?$/, async (msg, match) => {
    const arg1 = match?.[1]?.toLowerCase() ?? '';
    const arg2 = match?.[2]?.toLowerCase() ?? '';
    try {
      // Status update: /leads <id> <status>
      if (/^\d+$/.test(arg1)) {
        if (!isLeadStatus(arg2)) {
          await bot.sendMessage(msg.chat.id, `Usage: /leads <id> <${LEAD_STATUSES.join('|')}>`);
          return;
        }
        const ok = updateLeadStatus(Number(arg1), arg2);
        await bot.sendMessage(msg.chat.id, ok ? `✅ Lead ${arg1} → ${arg2}` : `⚠️ No lead with id ${arg1}.`);
        return;
      }

      const status = isLeadStatus(arg1) ? arg1 : undefined;
      if (arg1 && !status) {
        await bot.sendMessage(msg.chat.id, `Unknown status "${arg1}". Statuses: ${LEAD_STATUSES.join(', ')}`);
        return;
      }
      const leads = listLeads(status);
      if (leads.length === 0) {
        await bot.sendMessage(msg.chat.id, status ? `No leads with status "${status}".` : '📭 No leads in the pipeline yet — ask me to find some!');
        return;
      }
      const lines = leads.map((l) => {
        const contact = l.contact ? `\n   ${l.contact}` : '';
        const flag = hasPhoneNumber(l.contact ?? '') ? '' : '\n   📵 no phone yet';
        return `#${l.id} [${l.status}] ${l.name} — ${l.type}, ${l.location}${contact}${flag}`;
      });
      const missingCount = leads.filter((l) => !hasPhoneNumber(l.contact ?? '')).length;
      const header = `🤝 Lead pipeline (${leads.length}${status ? ` ${status}` : ''})\n${formatFunnel(leadFunnelCounts())}\n\n`;
      const enrichHint = missingCount > 0 ? `\n${missingCount} lead(s) missing a phone number — run /enrich to hunt them down.` : '';
      const footer = `\n\nUpdate: /leads <id> <${LEAD_STATUSES.join('|')}>${enrichHint}`;
      // Plain text — lead names/contacts routinely break Markdown parsing.
      for (const chunk of splitMessage(header + lines.join('\n\n') + footer)) {
        await bot.sendMessage(msg.chat.id, chunk);
      }
    } catch (err) {
      console.error(`[bot] /leads error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /enrich — send the lead agent hunting for contact details of active
  // pipeline leads that were saved without any (max 8 per run to stay within
  // the agent's iteration budget). Results are written back via update_lead.
  bot.onText(/^\/enrich$/, async (msg) => {
    try {
      const missing = listLeadsMissingContact();
      if (missing.length === 0) {
        await bot.sendMessage(msg.chat.id, '✅ All active pipeline leads already have a phone number.');
        return;
      }
      await bot.sendMessage(
        msg.chat.id,
        `🔎 Hunting phone numbers for ${missing.length} lead(s)… this may take a few minutes.`,
      );
      const result = await leadGenerationAgent.run(buildEnrichmentPrompt(missing), []);
      for (const chunk of splitMessage(result.response)) {
        await sendMarkdownSafe(bot, msg.chat.id, chunk);
      }
    } catch (err) {
      console.error(`[bot] /enrich error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /pitch <id> — ready-to-send WhatsApp intro + call opener for one pipeline
  // lead, drafted by the sales agent grounded in the actual lead row.
  bot.onText(/^\/pitch(?:\s+#?(\d+))?$/, async (msg, match) => {
    const idArg = match?.[1];
    try {
      if (!idArg) {
        await bot.sendMessage(msg.chat.id, 'Usage: /pitch <lead id> — see ids in /leads');
        return;
      }
      const lead = getLead(Number(idArg));
      if (!lead) {
        await bot.sendMessage(msg.chat.id, `⚠️ No lead with id ${idArg}. See /leads.`);
        return;
      }
      await bot.sendMessage(msg.chat.id, `✍️ Drafting outreach for #${lead.id} ${lead.name}…`);
      const result = await salesMarketingAgent.run(buildPitchPrompt(lead), []);
      for (const chunk of splitMessage(result.response)) {
        await sendMarkdownSafe(bot, msg.chat.id, chunk);
      }
    } catch (err) {
      console.error(`[bot] /pitch error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /callsheet — on-demand version of the scheduled call sheet: top phone-ready
  // leads with a pitch line each (enriches missing numbers first if short).
  bot.onText(/^\/callsheet$/, async (msg) => {
    try {
      await bot.sendMessage(msg.chat.id, '📞 Building your call sheet… this may take a few minutes.');
      await sendCallSheet(bot, msg.chat.id);
    } catch (err) {
      console.error(`[bot] /callsheet error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /article [topic] — website SEO article draft; no topic = the agent picks a
  // seasonally relevant one (same prompt as the weekly content cron).
  bot.onText(/^\/article(?:\s+([\s\S]+))?$/, async (msg, match) => {
    const topic = match?.[1]?.trim();
    try {
      await bot.sendMessage(msg.chat.id, '📝 Drafting the article… this may take a few minutes.');
      if (topic) {
        const result = await salesMarketingAgent.run(
          `Write an SEO article for the Urvar Natural website on: ${topic}. Deliver: a search-friendly headline, the full 600-900 word article with skimmable subheadings, one Urvar product woven in with a clear call-to-action, and a 150-character meta description at the end.`,
          [],
        );
        for (const chunk of splitMessage(result.response)) {
          await sendMarkdownSafe(bot, msg.chat.id, chunk);
        }
      } else {
        await sendContentDraft(bot, msg.chat.id);
      }
    } catch (err) {
      console.error(`[bot] /article error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /teach <fact> — add knowledge to the shared KB. Owner's input is approved
  // immediately (typing /teach is the approval); anyone else's is queued for the
  // owner to review via inline buttons.
  bot.onText(/^\/teach(?:\s+([\s\S]+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id ?? msg.chat.id);
    const text = match?.[1]?.trim() ?? '';

    try {
      if (!config.kbLearningEnabled) {
        await bot.sendMessage(msg.chat.id, '⚠️ Knowledge base learning is currently disabled.');
        return;
      }
      if (!config.ownerTelegramId) {
        await bot.sendMessage(msg.chat.id, '⚠️ Set OWNER_TELEGRAM_ID to enable knowledge-base learning and approvals.');
        return;
      }
      if (!text) {
        await bot.sendMessage(msg.chat.id, 'Usage: `/teach <fact to remember>`', { parse_mode: 'Markdown' });
        return;
      }

      if (isOwner(userId)) {
        const id = proposeLearned(text, 'teach', chatId, userId);
        if (id === null) {
          await bot.sendMessage(msg.chat.id, 'ℹ️ I already know that (or something very similar).');
          return;
        }
        const result = await approveLearned(id, userId);
        if (result.status === 'approved') {
          await bot.sendMessage(msg.chat.id, `✅ Learned and live now (${result.category}):\n\n${result.fact}`);
        } else if (result.status === 'duplicate') {
          await bot.sendMessage(msg.chat.id, `ℹ️ I already know that — too similar to an existing fact (#${result.of}).`);
        } else {
          await bot.sendMessage(msg.chat.id, '⚠️ That item was already decided.');
        }
      } else {
        await proposeAndNotify(bot, text, 'teach', chatId, userId);
        await bot.sendMessage(msg.chat.id, '🧠 Thanks — sent to the owner for approval.');
      }
    } catch (err) {
      console.error(`[bot] /teach error for chat ${chatId}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // /pending — owner lists all queued knowledge candidates and gets a fresh card
  // (with Approve/Edit/Reject buttons) for each.
  bot.onText(/^\/pending$/, async (msg) => {
    const fromId = String(msg.from?.id ?? msg.chat.id);
    if (!isOwner(fromId)) {
      await bot.sendMessage(msg.chat.id, 'Only the owner can review knowledge.');
      return;
    }
    const pending = listPending();
    if (pending.length === 0) {
      await bot.sendMessage(msg.chat.id, '✅ No pending knowledge candidates.');
      return;
    }
    await bot.sendMessage(msg.chat.id, `🧠 ${pending.length} pending candidate(s):`);
    for (const row of pending) {
      await notifyOwnerOfPending(bot, row.id, row.fact, row.source);
    }
  });

  // /kbstats — owner sees the shape of the knowledge base: counts by category,
  // status, and source, plus any near-duplicate approved pairs to consolidate.
  bot.onText(/^\/kbstats$/, async (msg) => {
    const fromId = String(msg.from?.id ?? msg.chat.id);
    if (!isOwner(fromId)) {
      await bot.sendMessage(msg.chat.id, 'Only the owner can view knowledge stats.');
      return;
    }
    try {
      const stats = getKbStats();
      if (stats.length === 0) {
        await bot.sendMessage(msg.chat.id, '📊 The knowledge base is empty.');
        return;
      }
      const approved = stats.filter((s) => s.status === 'approved');
      const pending = stats.filter((s) => s.status === 'pending');
      const sum = (rows: typeof stats): number => rows.reduce((n, r) => n + r.n, 0);
      const byCat = (cat: string): number => sum(approved.filter((s) => s.category === cat));

      const lines: string[] = [
        `📊 Knowledge base`,
        ``,
        `Approved: ${sum(approved)}  (business ${byCat('business')}, agronomy ${byCat('agronomy')})`,
        `Pending: ${sum(pending)}`,
        ``,
        `Approved by source:`,
        ...approved
          .slice()
          .sort((a, b) => b.n - a.n)
          .map((s) => `  • ${s.source} [${s.category}]: ${s.n}`),
      ];

      const dupes = findDuplicateClusters();
      if (dupes.length > 0) {
        lines.push('', `🧹 ${dupes.length} near-duplicate approved pair(s):`);
        for (const d of dupes.slice(0, 5)) {
          lines.push(`  #${d.a} ↔ #${d.b} (${d.score.toFixed(2)})`);
        }
        if (dupes.length > 5) lines.push(`  …and ${dupes.length - 5} more.`);
      }

      // Plain text — fact-derived content can break Markdown.
      for (const chunk of splitMessage(lines.join('\n'))) {
        await bot.sendMessage(msg.chat.id, chunk);
      }
    } catch (err) {
      console.error(`[bot] /kbstats error for chat ${msg.chat.id}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // Inline-button decisions on pending knowledge candidates (owner only).
  bot.on('callback_query', async (q) => {
    const parsed = parseKbCallback(q.data);
    if (!parsed) return;
    const fromId = String(q.from.id);

    if (!isOwner(fromId)) {
      await bot.answerCallbackQuery(q.id, { text: 'Only the owner can review knowledge.' });
      return;
    }

    const { action, id } = parsed;
    const message = q.message;
    try {
      if (action === 'approve') {
        const result = await approveLearned(id, fromId);
        const toast =
          result.status === 'approved' ? 'Approved ✅' : result.status === 'duplicate' ? 'Duplicate — skipped' : 'Already decided.';
        await bot.answerCallbackQuery(q.id, { text: toast });
        // No parse_mode: the fact text is unpredictable and would break Markdown.
        if (message) {
          const body =
            result.status === 'approved'
              ? `✅ Approved & live (${result.category}):\n\n${result.fact}`
              : result.status === 'duplicate'
                ? `ℹ️ Skipped as a near-duplicate of #${result.of}:\n\n${result.fact}`
                : '⚠️ Already decided.';
          await bot.editMessageText(body, {
            chat_id: message.chat.id,
            message_id: message.message_id,
          });
        }
      } else if (action === 'reject') {
        rejectLearned(id);
        await bot.answerCallbackQuery(q.id, { text: 'Rejected ❌' });
        if (message) {
          await bot.editMessageText('❌ Rejected — not added to the knowledge base.', {
            chat_id: message.chat.id,
            message_id: message.message_id,
          });
        }
      } else {
        // edit
        pendingEdits.set(fromId, id);
        const row = getLearned(id);
        await bot.answerCallbackQuery(q.id, { text: 'Send the corrected wording.' });
        if (message) {
          await bot.sendMessage(
            message.chat.id,
            `✏️ Reply with the corrected wording for:\n\n${row?.fact ?? '(unknown)'}`,
          );
        }
      }
    } catch (err) {
      console.error('[bot] callback_query error:', err);
      await bot.answerCallbackQuery(q.id, { text: 'Something went wrong.' });
    }
  });

  // Diagnose one or more photos (of the same plant) as a single case.
  async function processPhotos(chatId: string, fromId: string, caption: string, fileIds: string[]): Promise<void> {
    const numericChatId = Number(chatId);
    console.log(`[bot] Crop Doctor: diagnosing ${fileIds.length} photo(s) for chat ${chatId}`);
    try {
      await bot.sendChatAction(numericChatId, 'typing');
      const typingInterval = setInterval(() => {
        bot.sendChatAction(numericChatId, 'typing').catch(() => {});
      }, 4000);

      let result;
      try {
        const images = await Promise.all(
          fileIds.map(async (fileId) => {
            const fileLink = await bot.getFileLink(fileId);
            return fetchTelegramImage(fileLink);
          }),
        );
        const history = getHistory(chatId);
        result = await cropDoctorAgent.runWithImages(caption, images, history);
      } finally {
        clearInterval(typingInterval);
      }

      const userLabel = caption || (fileIds.length > 1 ? `[${fileIds.length} photos]` : '[photo]');
      appendHistory(chatId, 'user', userLabel);
      appendHistory(chatId, 'assistant', result!.response, 'crop_doctor', {
        tokens_in: result!.tokensIn,
        tokens_out: result!.tokensOut,
        cache_read: result!.cacheRead,
        cache_write: result!.cacheWrite,
      });

      const footer = isOwner(fromId) ? formatUsageFooter(result!) : '';
      const fullText = `_🌿 Crop Doctor_\n\n${result!.response}` + (footer ? `\n\n${footer}` : '');
      for (const chunk of splitMessage(fullText)) {
        await sendMarkdownSafe(bot, numericChatId, chunk);
      }

      // Distil only general, reusable agronomy facts from the diagnosis (gated by
      // owner approval). Non-blocking — must never affect the response path.
      void distillAgronomyToKb(bot, chatId, `${userLabel}\n${result!.response}`);
    } catch (err) {
      console.error(`[bot] Photo error for chat ${chatId}:`, err);
      await bot.sendMessage(numericChatId, getUserFacingError(err));
    }
  }

  // Photo handler — routes to Crop Doctor. Telegram delivers an album as separate
  // photo messages sharing a media_group_id; buffer them over a short window and
  // diagnose together (up to MAX_PHOTOS_PER_DIAGNOSIS of the same plant).
  bot.on('photo', async (msg) => {
    const chatId = String(msg.chat.id);
    const fromId = String(msg.from?.id ?? msg.chat.id);
    const caption = msg.caption?.trim() ?? '';
    const photos = msg.photo!;
    const bestFileId = photos[photos.length - 1]!.file_id; // highest resolution
    const groupId = msg.media_group_id;

    if (!groupId) {
      await processPhotos(chatId, fromId, caption, [bestFileId]);
      return;
    }

    const key = `${chatId}:${groupId}`;
    const flush = (): void => {
      const album = pendingAlbums.get(key);
      if (!album) return;
      pendingAlbums.delete(key);
      void processPhotos(album.chatId, album.fromId, album.caption, album.fileIds);
    };

    const existing = pendingAlbums.get(key);
    if (existing) {
      if (existing.fileIds.length < MAX_PHOTOS_PER_DIAGNOSIS) existing.fileIds.push(bestFileId);
      if (caption && !existing.caption) existing.caption = caption;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(flush, ALBUM_DEBOUNCE_MS);
    } else {
      pendingAlbums.set(key, {
        chatId,
        fromId,
        caption,
        fileIds: [bestFileId],
        timer: setTimeout(flush, ALBUM_DEBOUNCE_MS),
      });
    }
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = String(msg.chat.id);
    const userText = msg.text.trim();
    const fromId = String(msg.from?.id ?? msg.chat.id);

    // Owner is mid ✏️ Edit flow — treat this message as the corrected fact.
    if (pendingEdits.has(fromId)) {
      const learnedId = pendingEdits.get(fromId)!;
      pendingEdits.delete(fromId);
      try {
        editLearned(learnedId, userText);
        const result = await approveLearned(learnedId, fromId);
        const body =
          result.status === 'approved'
            ? `✅ Updated & live now (${result.category}):\n\n${result.fact}`
            : result.status === 'duplicate'
              ? `ℹ️ That's now a near-duplicate of #${result.of}, so I didn't add it again.`
              : '⚠️ That item was already decided.';
        await bot.sendMessage(msg.chat.id, body);
      } catch (err) {
        console.error(`[bot] KB edit error for ${fromId}:`, err);
        await bot.sendMessage(msg.chat.id, getUserFacingError(err));
      }
      return;
    }

    try {
      await bot.sendChatAction(msg.chat.id, 'typing');
      const typingInterval = setInterval(() => {
        bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      }, 4000);

      let result;
      try {
        // Institutional memory lives in the shared KB (injected via RAG), not a
        // per-session store — so the agent just needs this chat's history.
        const history = getHistory(chatId);
        const lastAgent = getLastAgentUsed(chatId) as AgentType | null;
        result = await runOrchestrator(userText, history, lastAgent);
      } finally {
        clearInterval(typingInterval);
      }

      // Persist this turn
      appendHistory(chatId, 'user', userText);
      appendHistory(chatId, 'assistant', result!.response, result!.agentUsed, {
        tokens_in: result!.tokensIn,
        tokens_out: result!.tokensOut,
        cache_read: result!.cacheRead,
        cache_write: result!.cacheWrite,
      });

      // Send response (split if too long)
      const agentLabel = AGENT_LABELS[result!.agentUsed] ?? '';
      const header = agentLabel ? `_${agentLabel}_\n\n` : '';
      const footer = isOwner(fromId) ? formatUsageFooter(result!) : '';
      const fullText = header + result!.response + (footer ? `\n\n${footer}` : '');

      for (const chunk of splitMessage(fullText)) {
        await sendMarkdownSafe(bot, msg.chat.id, chunk);
      }

      // Every 3 turns, distil durable company-wide facts into the shared KB
      // (queued for owner approval). Non-blocking — must never affect the
      // response path. This is the single learning path (agent_memory retired).
      const turns = (turnCounters.get(chatId) ?? 0) + 1;
      turnCounters.set(chatId, turns);
      if (turns % 3 === 0) {
        const recentHistory = getHistory(chatId);
        const conversationText = recentHistory
          .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n');
        void distillConversationToKb(bot, chatId, conversationText);
      }
    } catch (err) {
      console.error(`[bot] Error for chat ${chatId}:`, err);
      // clearInterval already called in finally above
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  // Self-healing polling. node-telegram-bot-api can stop its internal polling
  // loop after a fatal network error (EFATAL: ENOTFOUND/ECONNRESET/ETIMEDOUT —
  // e.g. a transient DNS/connectivity drop) and never resume, leaving the
  // process alive but deaf (Telegram's getUpdates is never called again). Detect
  // those and restart polling with exponential backoff.
  const POLLING_BACKOFF_MIN_MS = 5_000;
  const POLLING_BACKOFF_MAX_MS = 300_000;
  let pollingRestartTimer: NodeJS.Timeout | null = null;
  let pollingBackoffMs = 0;

  function schedulePollingRestart(): void {
    if (pollingRestartTimer) return; // a restart is already pending
    pollingBackoffMs = pollingBackoffMs
      ? Math.min(pollingBackoffMs * 2, POLLING_BACKOFF_MAX_MS)
      : POLLING_BACKOFF_MIN_MS;
    const delay = pollingBackoffMs;
    console.error(`[bot] Fatal polling error — restarting polling in ${Math.round(delay / 1000)}s…`);
    pollingRestartTimer = setTimeout(async () => {
      pollingRestartTimer = null;
      try {
        await bot.stopPolling({ cancel: true });
        await bot.startPolling({ restart: true });
        console.log('[bot] Polling restarted.');
      } catch (restartErr) {
        console.error(
          '[bot] Polling restart failed:',
          restartErr instanceof Error ? restartErr.message : restartErr,
        );
        schedulePollingRestart(); // keep retrying with escalating backoff
      }
    }, delay);
  }

  bot.on('polling_error', (err) => {
    console.error('[bot] Polling error:', err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EFATAL' || /EFATAL/.test(err.message)) {
      schedulePollingRestart();
    }
  });

  // Any received update means polling has recovered — reset the backoff so the
  // next incident starts fresh from the minimum delay.
  bot.on('message', () => {
    pollingBackoffMs = 0;
  });

  return bot;
}
