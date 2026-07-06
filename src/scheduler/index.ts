import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { MarketResearchAgent } from '../agents/market-research.js';
import { CompetitiveAnalysisAgent } from '../agents/competitive-analysis.js';
import { LeadGenerationAgent } from '../agents/lead-generation.js';
import { salesMarketingAgent } from '../agents/sales-marketing.js';
import { appendHistory, getHistory } from '../db/index.js';
import { splitMessage, sendMarkdownSafe } from '../utils/message.js';
import { listCallReadyLeads, listLeadsMissingContact, leadFunnelCounts, countLeadsAddedThisWeek } from '../leads/index.js';
import { buildCallSheetPrompt, buildEnrichmentPrompt, formatFunnel } from '../leads/util.js';
import { config } from '../config.js';

const marketAgent = new MarketResearchAgent();
const competitiveAgent = new CompetitiveAnalysisAgent();
const leadAgent = new LeadGenerationAgent();

// Weekly deltas: each report section is archived under a synthetic session id
// and last week's exchange is passed back as history, so the agents can report
// what CHANGED instead of re-surveying from scratch every Monday.
const DELTA_INSTRUCTION =
  ' If a previous briefing is present in this conversation, focus on what has CHANGED since it (use recency-filtered searches) and do not repeat unchanged facts — a short "unchanged since last week" note is enough.';

const MARKET_QUERY =
  'Provide a weekly market intelligence briefing for the Indian organic fertilizer and bio-input market. Cover: key trends this week, Amazon/Flipkart pricing movements, regulatory news, seasonal demand outlook, and top growth opportunities for a small vermicompost manufacturer in West Bengal.' +
  DELTA_INSTRUCTION;

const COMPETITIVE_QUERY =
  'Provide a weekly competitive intelligence briefing for the Indian organic fertilizer market. Cover: any new competitor product launches, changes in competitor Amazon/Flipkart listings or pricing, competitor marketing activity, and identified market gaps that Urvar Natural can exploit this week.' +
  DELTA_INSTRUCTION;

const LEADS_QUERY =
  'Find up to 5 NEW qualified B2B leads for Urvar Natural this week — distributors, retailers, nurseries, agri-input shops, or FPOs, prioritising West Bengal and nearby states. Skip any business already in the pipeline. Save each qualified lead with save_lead, and present them with contact details and a one-line outreach angle each. Keep the briefing concise.';

const REPORT_SESSIONS = {
  market: 'report:market_research',
  competitive: 'report:competitive_analysis',
} as const;

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

  // Last week's exchange (1 turn) gives each analytical agent a baseline to
  // diff against; lead gen dedups via its pipeline instead.
  const timeoutMs = config.reportAgentTimeoutMs;
  const start = Date.now();
  const [marketResult, competitiveResult, leadsResult] = await Promise.allSettled([
    withTimeout(marketAgent.run(MARKET_QUERY, getHistory(REPORT_SESSIONS.market, 1)), timeoutMs, 'Market Research'),
    withTimeout(competitiveAgent.run(COMPETITIVE_QUERY, getHistory(REPORT_SESSIONS.competitive, 1)), timeoutMs, 'Competitive Analysis'),
    withTimeout(leadAgent.run(LEADS_QUERY, []), timeoutMs, 'Lead Generation'),
  ]);
  console.log(
    `[scheduler] Market Research: ${marketResult.status}, Competitive Analysis: ${competitiveResult.status}, Lead Generation: ${leadsResult.status} (${Date.now() - start}ms)`,
  );

  // Archive successful sections so next week's run sees them as history.
  if (marketResult.status === 'fulfilled') {
    appendHistory(REPORT_SESSIONS.market, 'user', MARKET_QUERY);
    appendHistory(REPORT_SESSIONS.market, 'assistant', marketResult.value.response, 'market_research');
  }
  if (competitiveResult.status === 'fulfilled') {
    appendHistory(REPORT_SESSIONS.competitive, 'user', COMPETITIVE_QUERY);
    appendHistory(REPORT_SESSIONS.competitive, 'assistant', competitiveResult.value.response, 'competitive_analysis');
  }

  const sectionText = <T extends { response: string }>(
    result: PromiseSettledResult<T>,
    label: string,
  ): string =>
    result.status === 'fulfilled'
      ? result.value.response
      : `⚠️ ${label} unavailable: ${(result.reason as Error).message}`;

  await sendSection(bot, chatId, `*📈 Market Intelligence*\n\n${sectionText(marketResult, 'Market intelligence')}`);
  await sendSection(bot, chatId, `*🔍 Competitive Intelligence*\n\n${sectionText(competitiveResult, 'Competitive intelligence')}`);
  const funnel = `${formatFunnel(leadFunnelCounts())}  (+${countLeadsAddedThisWeek()} added this week)`;
  await sendSection(bot, chatId, `*🤝 New Leads This Week*\n${funnel}\n\n${sectionText(leadsResult, 'Lead generation')}`);
}

// ---------------------------------------------------------------------------
// Call sheet: the weekly bridge from "leads in the pipeline" to "calls made".
// Enriches missing phone numbers first (when the sheet would otherwise run
// short), then has the sales agent turn the top leads into a phone-in-hand
// briefing with a pitch line per lead.

const CALL_SHEET_SIZE = 5;

export async function sendCallSheet(bot: TelegramBot, chatId: TelegramBot.ChatId): Promise<void> {
  let ready = listCallReadyLeads(CALL_SHEET_SIZE);

  // Not enough phone-ready leads? Spend one enrichment round hunting numbers
  // before building the sheet (same flow as /enrich, off the interactive path).
  if (ready.length < CALL_SHEET_SIZE) {
    const missing = listLeadsMissingContact();
    if (missing.length > 0) {
      console.log(`[scheduler] Call sheet: enriching ${missing.length} lead(s) missing a phone first…`);
      try {
        await withTimeout(
          leadAgent.run(buildEnrichmentPrompt(missing), []),
          config.reportAgentTimeoutMs,
          'Call-sheet enrichment',
        );
        ready = listCallReadyLeads(CALL_SHEET_SIZE);
      } catch (err) {
        console.error('[scheduler] Call-sheet enrichment failed (continuing with what we have):', err);
      }
    }
  }

  if (ready.length === 0) {
    await bot.sendMessage(
      chatId,
      '📞 Call sheet: no phone-ready leads in the pipeline. Ask me to find leads, or run /enrich to hunt numbers for the ones already saved.',
    );
    return;
  }

  const result = await withTimeout(
    salesMarketingAgent.run(buildCallSheetPrompt(ready), []),
    config.reportAgentTimeoutMs,
    'Call sheet',
  );

  // Deterministic footer: the exact status commands, so updating the pipeline
  // after each call is copy-paste instead of recall.
  const statusLines = ready.map((l) => `/leads ${l.id} contacted`).join('\n');
  const text = `📞 *Call sheet — ${ready.length} lead(s) to work today*\n\n${result.response}\n\nAfter each call, update the pipeline (tap to copy):\n${statusLines}`;
  await sendSection(bot, chatId, text);
}

// ---------------------------------------------------------------------------
// Content draft: one website SEO article per week, seasonally chosen by the
// agent (it knows today's date from the dynamic system block) and grounded in
// the RAG knowledge docs.

const CONTENT_QUERY =
  'Write this week\'s SEO article for the Urvar Natural website. Pick ONE seasonally relevant topic for Indian gardeners or farmers right now (check the current date; think monsoon/kharif/rabi timing, current planting and disease pressure) that naturally leads to an Urvar product. Deliver: a search-friendly headline, the full 600-900 word article with skimmable subheadings, one Urvar product woven in with a clear call-to-action, and a 150-character meta description at the end. Use web search only if you need to verify something seasonal or current.';

export async function sendContentDraft(bot: TelegramBot, chatId: TelegramBot.ChatId): Promise<void> {
  const result = await withTimeout(
    salesMarketingAgent.run(CONTENT_QUERY, []),
    config.reportAgentTimeoutMs,
    'Content draft',
  );
  await sendSection(bot, chatId, `📝 *Weekly website article draft*\n\n${result.response}`);
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

  // Sales cadence — both go to the owner directly (the founder works the
  // leads), unlike the report which goes to the group.
  const toOwner = (label: string, send: (bot: TelegramBot, chatId: TelegramBot.ChatId) => Promise<void>) =>
    async (): Promise<void> => {
      if (!config.ownerTelegramId) {
        console.log(`[scheduler] OWNER_TELEGRAM_ID not configured — skipping ${label}.`);
        return;
      }
      console.log(`[scheduler] Sending ${label}…`);
      try {
        await send(bot, config.ownerTelegramId);
        console.log(`[scheduler] ${label} sent.`);
      } catch (err) {
        console.error(`[scheduler] Failed to send ${label}:`, err);
      }
    };

  cron.schedule(config.callSheetCron, toOwner('call sheet', sendCallSheet), { timezone: 'Asia/Kolkata' });
  cron.schedule(config.contentCron, toOwner('content draft', sendContentDraft), { timezone: 'Asia/Kolkata' });
  console.log(`[scheduler] Call sheet scheduled — cron "${config.callSheetCron}" IST; content draft — cron "${config.contentCron}" IST.`);
}
