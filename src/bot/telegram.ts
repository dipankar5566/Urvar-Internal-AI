import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { appendHistory, getHistory, clearHistory } from '../db/index.js';
import { getMemories, clearMemories, extractAndSaveMemories } from '../memory/index.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { sendWeeklyReport } from '../scheduler/index.js';
import { cropDoctorAgent, fetchTelegramImage } from '../agents/crop-doctor.js';
import { splitMessage, formatUptime } from '../utils/message.js';

const START_TIME = Date.now();

const AGENT_LABELS: Record<string, string> = {
  market_research: '📈 Market Research',
  competitive_analysis: '🔍 Competitive Analysis',
  rd_product_development: '🧪 R&D / Product Development',
  sales_marketing: '📣 Sales & Marketing',
  lead_generation: '🤝 Lead Generation',
  crop_doctor: '🌿 Crop Doctor',
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
      `*Urvar AI Assistant — Available Specialists*\n\n📈 *Market Research*\nask about: market size, trends, pricing, seasonal demand, distribution channels\n\n🔍 *Competitive Analysis*\nask about: Iffco, Coromandel, Biowin, competitor pricing, SWOT analysis\n\n🧪 *R&D / Product Development*\nask about: new formulations, NPOP certification, FCO compliance, packaging ideas\n\n📣 *Sales & Marketing*\nask to: write Amazon listings, Instagram captions, WhatsApp messages, email campaigns\n\n🤝 *Lead Generation*\nask to: find distributors, retailers, FPOs, B2B leads across India\n\n🌿 *Crop Doctor*\nsend a photo of a sick plant or describe symptoms — get a diagnosis and Urvar product treatment plan\n\nCommands: /start /help /clear /report`,
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

  // Photo handler — routes to Crop Doctor
  bot.on('photo', async (msg) => {
    const chatId = String(msg.chat.id);
    const caption = msg.caption?.trim() ?? '';

    try {
      await bot.sendChatAction(msg.chat.id, 'typing');
      const typingInterval = setInterval(() => {
        bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      }, 4000);

      let result;
      try {
        // Use the highest-resolution photo
        const photos = msg.photo!;
        const bestPhoto = photos[photos.length - 1]!;
        const fileLink = await bot.getFileLink(bestPhoto.file_id);
        const { base64, mediaType } = await fetchTelegramImage(fileLink);

        const history = getHistory(chatId);
        result = await cropDoctorAgent.runWithImage(caption, base64, mediaType, history);
      } finally {
        clearInterval(typingInterval);
      }

      appendHistory(chatId, 'user', caption || '[photo]');
      appendHistory(chatId, 'assistant', result!.response, 'crop_doctor', {
        tokens_in: result!.tokensIn,
        tokens_out: result!.tokensOut,
        cache_read: result!.cacheRead,
        cache_write: result!.cacheWrite,
      });

      const fullText = `_🌿 Crop Doctor_\n\n${result!.response}`;
      for (const chunk of splitMessage(fullText)) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error(`[bot] Photo error for chat ${chatId}:`, err);
      await bot.sendMessage(msg.chat.id, getUserFacingError(err));
    }
  });

  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = String(msg.chat.id);
    const userText = msg.text.trim();

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
