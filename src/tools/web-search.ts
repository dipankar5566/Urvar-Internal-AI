import { config } from '../config.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

export interface WebSearchOptions {
  includeDomains?: string[];
  // Full page text per result (truncated in formatSearchResponse). Tavily snippets
  // often cut off contact details — lead generation needs the raw page.
  includeRawContent?: boolean;
  // Restrict to the last N days via Tavily's news-focused search. Without this,
  // "this week" queries happily return year-old market-report blog posts.
  recencyDays?: number;
}

export interface WebSearchResponse {
  answer: string | null;
  results: SearchResult[];
}

// Bounded in-memory log of recent web searches that produced a synthesized
// answer. The periodic learning job (src/learning/index.ts) drains this to
// propose grounded findings as KB candidates. In-memory only — lost on restart,
// which is fine (best-effort capture, no durability guarantee needed).
export interface RecentSearch {
  query: string;
  answer: string;
  // Top result snippets — the concrete numbers (prices, ratings, market sizes)
  // usually live here, not in Tavily's synthesized answer.
  snippets: string;
}

const RECENT_SEARCH_CAP = 50;
const SNIPPETS_PER_SEARCH = 3;
const recentSearches: RecentSearch[] = [];

function recordSearch(query: string, answer: string | null, results: SearchResult[]): void {
  if (!answer) return;
  const snippets = results
    .slice(0, SNIPPETS_PER_SEARCH)
    .map((r) => `${r.title}: ${r.content.slice(0, 300)}`)
    .join('\n');
  recentSearches.push({ query, answer, snippets });
  if (recentSearches.length > RECENT_SEARCH_CAP) {
    recentSearches.splice(0, recentSearches.length - RECENT_SEARCH_CAP);
  }
}

// Returns and clears the buffered searches, so each is proposed at most once.
export function drainRecentSearches(): RecentSearch[] {
  return recentSearches.splice(0, recentSearches.length);
}

export async function webSearch(
  query: string,
  maxResults = 5,
  searchDepth: 'basic' | 'advanced' = 'basic',
  options: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: true,
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
        ...(options.includeRawContent ? { include_raw_content: true } : {}),
        ...(options.recencyDays ? { topic: 'news', days: options.recencyDays } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { answer?: string; results?: SearchResult[] };
    const answer = data.answer ?? null;
    const results = data.results ?? [];
    recordSearch(query, answer, results);
    return { answer, results };
  } finally {
    clearTimeout(timeout);
  }
}

// Raw page text is capped per result so a handful of directory pages can't blow
// up the tool result (and every subsequent loop turn's input tokens).
const RAW_CONTENT_CAP = 1500;

// Shared formatter for agent tool results — surfaces Tavily's synthesized
// answer (highest-signal field) ahead of the raw result snippets.
export function formatSearchResponse({ answer, results }: WebSearchResponse): string {
  if (!answer && results.length === 0) return 'No search results found.';

  const parts: string[] = [];
  if (answer) parts.push(`**Answer summary:** ${answer}`);
  if (results.length > 0) {
    parts.push(
      results
        .map((r) => {
          const base = `**${r.title}**\n${r.url}\n${r.content}`;
          if (!r.raw_content) return base;
          const raw = r.raw_content.slice(0, RAW_CONTENT_CAP);
          const ellipsis = r.raw_content.length > RAW_CONTENT_CAP ? '…' : '';
          return `${base}\nPage content: ${raw}${ellipsis}`;
        })
        .join('\n\n---\n\n'),
    );
  }
  return parts.join('\n\n---\n\n');
}

// Shared web_search tool-call handler for agents. Per-agent defaults (search
// depth, result count, raw content) come from `defaults`; the model may narrow
// results to specific sites via the optional include_domains input.
export async function runWebSearchTool(
  input: Record<string, unknown>,
  defaults: { maxResults?: number; searchDepth?: 'basic' | 'advanced'; includeRawContent?: boolean } = {},
): Promise<string> {
  const includeDomains = Array.isArray(input['include_domains'])
    ? (input['include_domains'] as unknown[]).filter((d): d is string => typeof d === 'string')
    : undefined;
  const recencyDays =
    typeof input['recency_days'] === 'number' && input['recency_days'] > 0
      ? Math.min(Math.round(input['recency_days']), 365)
      : undefined;
  const response = await webSearch(
    input['query'] as string,
    (input['max_results'] as number) ?? defaults.maxResults ?? 5,
    defaults.searchDepth ?? 'basic',
    { includeDomains, includeRawContent: defaults.includeRawContent, recencyDays },
  );
  return formatSearchResponse(response);
}

export const webSearchToolDefinition: Tool = {
  name: 'web_search',
  description:
    'Search the web for current information about markets, competitors, agricultural trends, products, pricing, regulations, or any external data. Use this to get up-to-date facts that are not in the knowledge base.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific and targeted.',
      },
      max_results: {
        type: 'number',
        description: 'Number of results to return (1–10). Default is 5.',
      },
      include_domains: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of domains to restrict results to (e.g. ["indiamart.com", "justdial.com"]). Use when searching business directories or a specific site.',
      },
      recency_days: {
        type: 'number',
        description:
          'Optional: restrict to news from the last N days (e.g. 7 for "this week"). Use for current events, launches, price changes, or regulatory news — NOT for evergreen facts.',
      },
    },
    required: ['query'],
  },
};
