import { config } from '../config.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
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
}

const RECENT_SEARCH_CAP = 50;
const recentSearches: RecentSearch[] = [];

function recordSearch(query: string, answer: string | null): void {
  if (!answer) return;
  recentSearches.push({ query, answer });
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
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { answer?: string; results?: SearchResult[] };
    const answer = data.answer ?? null;
    recordSearch(query, answer);
    return { answer, results: data.results ?? [] };
  } finally {
    clearTimeout(timeout);
  }
}

// Shared formatter for agent tool results — surfaces Tavily's synthesized
// answer (highest-signal field) ahead of the raw result snippets.
export function formatSearchResponse({ answer, results }: WebSearchResponse): string {
  if (!answer && results.length === 0) return 'No search results found.';

  const parts: string[] = [];
  if (answer) parts.push(`**Answer summary:** ${answer}`);
  if (results.length > 0) {
    parts.push(
      results.map((r) => `**${r.title}**\n${r.url}\n${r.content}`).join('\n\n---\n\n'),
    );
  }
  return parts.join('\n\n---\n\n');
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
    },
    required: ['query'],
  },
};
