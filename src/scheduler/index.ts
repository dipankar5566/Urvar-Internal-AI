import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { MarketResearchAgent } from '../agents/market-research.js';
import { CompetitiveAnalysisAgent } from '../agents/competitive-analysis.js';
import { config } from '../config.js';

const marketAgent = new MarketResearchAgent();
const competitiveAgent = new CompetitiveAnalysisAgent();

const MARKET_QUERY =
  'Provide a weekly market intelligence briefing for the Indian organic fertilizer and bio-input market. Cover: key trends this week, Amazon/Flipkart pricing movements, regulatory news, seasonal demand outlook, and top growth opportunities for a small vermicompost manufacturer in West Bengal.';

const COMPETITIVE_QUERY =
  'Provide a weekly competitive intelligence briefing for the Indian organic fertilizer market. Cover: any new competitor product launches, changes in competitor Amazon/Flipkart listings or pricing, competitor marketing activity, and identified market gaps that Urvar Natural can exploit this week.';

const AGENT_TIMEOUT_MS = 240_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    const cutAt = remaining.lastIndexOf('\n', maxLen) > 0
      ? remaining.lastIndexOf('\n', maxLen)
      : maxLen;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return parts;
}

export async function sendWeeklyReport(bot: TelegramBot, chatId: TelegramBot.ChatId): Promise<void> {
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata',
  });

  await bot.sendMessage(chatId, `📊 *Weekly Business Intelligence Briefing*\n_${today}_`, {
    parse_mode: 'Markdown',
  });

  const start = Date.now();
  const [marketResult, competitiveResult] = await Promise.allSettled([
    withTimeout(marketAgent.run(MARKET_QUERY, []), AGENT_TIMEOUT_MS, 'Market Research'),
    withTimeout(competitiveAgent.run(COMPETITIVE_QUERY, []), AGENT_TIMEOUT_MS, 'Competitive Analysis'),
  ]);
  console.log(
    `[scheduler] Market Research: ${marketResult.status}, Competitive Analysis: ${competitiveResult.status} (${Date.now() - start}ms)`,
  );

  // Market Intelligence section
  const marketText =
    marketResult.status === 'fulfilled'
      ? marketResult.value.response
      : `⚠️ Market intelligence unavailable: ${(marketResult.reason as Error).message}`;

  await bot.sendMessage(chatId, `*📈 Market Intelligence*\n\n${marketText}`.slice(0, 4096), {
    parse_mode: 'Markdown',
  });

  // Competitive Intelligence section
  const compText =
    competitiveResult.status === 'fulfilled'
      ? competitiveResult.value.response
      : `⚠️ Competitive intelligence unavailable: ${(competitiveResult.reason as Error).message}`;

  for (const chunk of splitMessage(`*🔍 Competitive Intelligence*\n\n${compText}`)) {
    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
  }
}

export function startScheduler(bot: TelegramBot): void {
  // Every Monday at 09:00 AM IST
  cron.schedule(
    '0 9 * * 1',
    async () => {
      const groupId = config.telegramGroupId;
      if (!groupId) {
        console.log('[scheduler] TELEGRAM_GROUP_ID not configured — skipping weekly report.');
        return;
      }
      console.log('[scheduler] Sending weekly report…');
      try {
        await sendWeeklyReport(bot, groupId);
        console.log('[scheduler] Weekly report sent.');
      } catch (err) {
        console.error('[scheduler] Failed to send weekly report:', err);
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  console.log('[scheduler] Weekly report scheduled — every Monday 09:00 IST.');
}
