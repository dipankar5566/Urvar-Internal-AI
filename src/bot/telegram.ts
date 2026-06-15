import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { appendHistory, getHistory, clearHistory } from '../db/index.js';
import { getMemories, clearMemories, extractAndSaveMemories } from '../memory/index.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { sendWeeklyReport } from '../scheduler/index.js';
import { cropDoctorAgent, fetchTelegramImage } from '../agents/crop-doctor.js';
import { splitMessage, formatUptime } from '../utils/message.js';
import { proposeLearned, approveLearned, rejectLearned, editLearned, getLearned, listPending } from '../rag/learned.js';
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
    clearMemories(chatId);
    turnCounters.set(chatId, 0);
    await bot.sendMessage(
      msg.chat.id,
      `👋 *Welcome to Urvar AI Assistant!*\n\nI'm your business intelligence hub for Urvar Natural Pvt. Ltd. I can help with:\n\n📈 *Market Research* — market trends, pricing, demand analysis\n🔍 *Competitive Analysis* — competitor profiling, positioning\n🧪 *R&D / Product Development* — new products, formulations, certifications\n📣 *Sales & Marketing* — content creation, Amazon listings, campaigns\n🤝 *Lead Generation* — finding distributors, retailers, FPOs\n🌿 *Crop Doctor* — send a photo of a sick plant for diagnosis and Urvar product recommendations\n\n📊 Weekly business briefings are sent every *Monday at 9:00 AM IST*.\n\nJust ask me anything — or send a crop photo!`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `*Urvar AI Assistant — Available Specialists*\n\n📈 *Market Research*\nask about: market size, trends, pricing, seasonal demand, distribution channels\n\n🔍 *Competitive Analysis*\nask about: Iffco, Coromandel, Biowin, competitor pricing, SWOT analysis\n\n🧪 *R&D / Product Development*\nask about: new formulations, NPOP certification, FCO compliance, packaging ideas\n\n📣 *Sales & Marketing*\nask to: write Amazon listings, Instagram captions, WhatsApp messages, email campaigns\n\n🤝 *Lead Generation*\nask to: find distributors, retailers, FPOs, B2B leads across India\n\n🌿 *Crop Doctor*\nsend a photo of a sick plant or describe symptoms — get a diagnosis and Urvar product treatment plan\n\nCommands: /start /help /clear /report /teach /pending`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.onText(/\/clear/, async (msg) => {
    const chatId = String(msg.chat.id);
    clearHistory(chatId);
    clearMemories(chatId);
    turnCounters.set(chatId, 0);
    await bot.sendMessage(msg.chat.id, '🗑️ Conversation history and memory cleared.');
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
        const fact = await approveLearned(id, userId);
        await bot.sendMessage(msg.chat.id, `✅ Learned and live now:\n\n${fact}`);
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
        const fact = await approveLearned(id, fromId);
        await bot.answerCallbackQuery(q.id, { text: fact ? 'Approved ✅' : 'Already decided.' });
        // No parse_mode: the fact text is unpredictable and would break Markdown.
        if (message) {
          await bot.editMessageText(`✅ Approved & live:\n\n${fact ?? '(already decided)'}`, {
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
  async function processPhotos(chatId: string, caption: string, fileIds: string[]): Promise<void> {
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

      const fullText = `_🌿 Crop Doctor_\n\n${result!.response}`;
      for (const chunk of splitMessage(fullText)) {
        await bot.sendMessage(numericChatId, chunk, { parse_mode: 'Markdown' });
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
    const caption = msg.caption?.trim() ?? '';
    const photos = msg.photo!;
    const bestFileId = photos[photos.length - 1]!.file_id; // highest resolution
    const groupId = msg.media_group_id;

    if (!groupId) {
      await processPhotos(chatId, caption, [bestFileId]);
      return;
    }

    const key = `${chatId}:${groupId}`;
    const flush = (): void => {
      const album = pendingAlbums.get(key);
      if (!album) return;
      pendingAlbums.delete(key);
      void processPhotos(album.chatId, album.caption, album.fileIds);
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
        const fact = await approveLearned(learnedId, fromId);
        await bot.sendMessage(
          msg.chat.id,
          fact ? `✅ Updated & live now:\n\n${fact}` : '⚠️ That item was already decided.',
        );
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
        const memories = getMemories(chatId);
        const history = getHistory(chatId);

        // Prepend persistent memory as a system-like context message if present
        const messagesWithContext = memories
          ? [{ role: 'user' as const, content: `[Context from previous sessions]\n${memories}` },
             { role: 'assistant' as const, content: 'Understood. I have that context in mind.' },
             ...history]
          : history;

        result = await runOrchestrator(userText, messagesWithContext);
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
      const fullText = header + result!.response;

      for (const chunk of splitMessage(fullText)) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
      }

      // Extract memories every 3 turns (async, non-blocking)
      const turns = (turnCounters.get(chatId) ?? 0) + 1;
      turnCounters.set(chatId, turns);
      if (turns % 3 === 0) {
        const recentHistory = getHistory(chatId);
        const conversationText = recentHistory
          .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n');
        void extractAndSaveMemories(chatId, conversationText);
        // Also distil durable, company-wide facts into the shared KB (queued for
        // owner approval). Non-blocking — must never affect the response path.
        void distillConversationToKb(bot, chatId, conversationText);
      }
    } catch (err) {
      console.error(`[bot] Error for chat ${chatId}:`, err);
      // clearInterval already called in finally above
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[bot] Polling error:', err.message);
  });

  return bot;
}
