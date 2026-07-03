import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { MarketResearchAgent } from '../agents/market-research.js';
import { CompetitiveAnalysisAgent } from '../agents/competitive-analysis.js';
import { LeadGenerationAgent } from '../agents/lead-generation.js';
import { splitMessage, sendMarkdownSafe } from '../utils/message.js';
import { config } from '../config.js';

const marketAgent = new MarketResearchAgent();
const competitiveAgent = new CompetitiveAnalysisAgent();
const leadAgent = new LeadGenerationAgent();

const MARKET_QUERY =
  'Provide a weekly market intelligence briefing for the Indian organic fertilizer and bio-input market. Cover: key trends this week, Amazon/Flipkart pricing movements, regulatory news, seasonal demand outlook, and top growth opportunities for a small vermicompost manufacturer in West Bengal.';

const COMPETITIVE_QUERY =
  'Provide a weekly competitive intelligence briefing for the Indian organic fertilizer market. Cover: any new competitor product launches, changes in competitor Amazon/Flipkart listings or pricing, competitor marketing activity, and identified market gaps that Urvar Natural can exploit this week.';

const LEADS_QUERY =
  'Find up to 5 NEW qualified B2B leads for Urvar Natural this week — distributors, retailers, nurseries, agri-input shops, or FPOs, prioritising West Bengal and nearby states. Skip any business already in the pipeline. Save each qualified lead with save_lead, and present them with contact details and a one-line outreach angle each. Keep the briefing concise.';

const AGENT_TIMEOUT_MS = 240_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

async function sendSection(bot: TelegramBot, chatId: TelegramBot.ChatId, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await sendMarkdownSafe(bot, chatId, chunk);
  }
}

export async function sendWeeklyReport(bot: TelegramBot, chatId: TelegramBot.ChatId): Promise<void> {
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata',
  });

  await bot.sendMessage(chatId, `📊 *Weekly Business Intelligence Briefing*\n_${today}_`, {
    parse_mode: 'Markdown',
  });

  const start = Date.now();
  const [marketResult, competitiveResult, leadsResult] = await Promise.allSettled([
    withTimeout(marketAgent.run(MARKET_QUERY, []), AGENT_TIMEOUT_MS, 'Market Research'),
    withTimeout(competitiveAgent.run(COMPETITIVE_QUERY, []), AGENT_TIMEOUT_MS, 'Competitive Analysis'),
    withTimeout(leadAgent.run(LEADS_QUERY, []), AGENT_TIMEOUT_MS, 'Lead Generation'),
  ]);
  console.log(
    `[scheduler] Market Research: ${marketResult.status}, Competitive Analysis: ${competitiveResult.status}, Lead Generation: ${leadsResult.status} (${Date.now() - start}ms)`,
  );

  const sectionText = <T extends { response: string }>(
    result: PromiseSettledResult<T>,
    label: string,
  ): string =>
    result.status === 'fulfilled'
      ? result.value.response
      : `⚠️ ${label} unavailable: ${(result.reason as Error).message}`;

  await sendSection(bot, chatId, `*📈 Market Intelligence*\n\n${sectionText(marketResult, 'Market intelligence')}`);
  await sendSection(bot, chatId, `*🔍 Competitive Intelligence*\n\n${sectionText(competitiveResult, 'Competitive intelligence')}`);
  await sendSection(bot, chatId, `*🤝 New Leads This Week*\n\n${sectionText(leadsResult, 'Lead generation')}`);
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
