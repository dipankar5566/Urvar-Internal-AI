import { config } from '../config.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export async function webSearch(
  query: string,
  maxResults = 5,
  searchDepth: 'basic' | 'advanced' = 'basic',
): Promise<SearchResult[]> {
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

    const data = (await response.json()) as { results?: SearchResult[] };
    return data.results ?? [];
  } finally {
    clearTimeout(timeout);
  }
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
