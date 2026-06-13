import { VoyageAIClient } from 'voyageai';
import { config } from '../config.js';

export const EMBED_DIMENSION = 512;

const VOYAGE_MODEL = 'voyage-3-lite';
const MAX_BATCH_SIZE = 128;

let _client: VoyageAIClient | null = null;

function getClient(): VoyageAIClient {
  if (!_client) _client = new VoyageAIClient({ apiKey: config.voyageApiKey });
  return _client;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await getClient().embed({
      input: batch,
      model: VOYAGE_MODEL,
      inputType: 'document',
    });
    for (const item of response.data ?? []) {
      results.push(item.embedding ?? []);
    }
  }
  return results;
}

export async function embedQuery(text: string): Promise<number[]> {
  const response = await getClient().embed({
    input: text,
    model: VOYAGE_MODEL,
    inputType: 'query',
  });
  return response.data?.[0]?.embedding ?? [];
}
