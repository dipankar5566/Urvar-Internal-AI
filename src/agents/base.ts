import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages.js';
import { config } from '../config.js';
import { retrieveRelevantContext } from '../rag/index.js';

export interface AgentRunResult {
  response: string;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

// Per-agent generation tuning. Extended thinking and a non-default temperature
// are mutually exclusive (the API requires default temperature when thinking is
// enabled), so agents set one or the other — never both.
export interface AgentOptions {
  temperature?: number;
  thinkingBudget?: number;
  maxTokens?: number;
}

// Builds the RAG retrieval query. Embedding only the latest message loses the
// referent on follow-ups ("what about its pricing?"), so we prepend the most
// recent prior user turn. Zero extra API calls.
export function buildRetrievalQuery(current: string, history: MessageParam[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      const block = m.content.find((b) => b.type === 'text');
      if (block && 'text' in block) text = (block as { text: string }).text;
    }
    if (text) return `${text}\n${current}`;
  }
  return current;
}

const RETRYABLE_STATUSES = new Set([429, 500, 503, 529]);
const RETRYABLE_CODES = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/;

export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return RETRYABLE_STATUSES.has(err.status);
  if (err instanceof Error) return RETRYABLE_CODES.test(err.message);
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class BaseAgent {
  protected readonly client: Anthropic;
  protected readonly systemPromptBlocks: TextBlockParam[];
  protected readonly tools: Tool[];
  protected readonly options: AgentOptions;

  constructor(systemPromptBlocks: TextBlockParam[], tools: Tool[], options: AgentOptions = {}) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.systemPromptBlocks = systemPromptBlocks;
    this.tools = tools;
    this.options = options;
  }

  abstract handleToolCall(name: string, input: Record<string, unknown>): Promise<string>;

  async run(userMessage: string, history: MessageParam[]): Promise<AgentRunResult> {
    const context = await retrieveRelevantContext(buildRetrievalQuery(userMessage, history));
    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: userMessage },
    ];
    return this.runAgenticLoop(messages, context);
  }

  protected async runAgenticLoop(messages: MessageParam[], context = ''): Promise<AgentRunResult> {
    const systemBlocks: TextBlockParam[] = context
      ? [
          { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
          ...this.systemPromptBlocks,
        ]
      : this.systemPromptBlocks;

    let iteration = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    while (iteration < config.maxAgentIterations) {
      const params: MessageCreateParamsNonStreaming = {
        model: config.claudeModel,
        max_tokens: this.options.maxTokens ?? 4096,
        system: systemBlocks,
        tools: this.tools,
        messages,
      };
      // Extended thinking and temperature are mutually exclusive — thinking wins.
      if (this.options.thinkingBudget) {
        params.thinking = { type: 'enabled', budget_tokens: this.options.thinkingBudget };
      } else if (this.options.temperature !== undefined) {
        params.temperature = this.options.temperature;
      }
      const response = await this.callWithRetry(params);

      tokensIn += response.usage.input_tokens;
      tokensOut += response.usage.output_tokens;
      const usage = response.usage as unknown as Record<string, number>;
      cacheRead += usage['cache_read_input_tokens'] ?? 0;
      cacheWrite += usage['cache_creation_input_tokens'] ?? 0;

      if (response.stop_reason === 'end_turn') {
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('');
        return { response: text, iterations: iteration + 1, tokensIn, tokensOut, cacheRead, cacheWrite };
      }

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        // stop_reason was tool_use but no tool blocks — treat as end_turn
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('');
        return { response: text, iterations: iteration + 1, tokensIn, tokensOut, cacheRead, cacheWrite };
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
        const result = await this.handleToolCall(toolBlock.name, toolBlock.input);
        toolResults.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: result });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      iteration++;
    }

    return {
      response: 'I was unable to complete the research within the allowed steps. Please try rephrasing your question.',
      iterations: iteration,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
    };
  }

  private async callWithRetry(
    params: Parameters<Anthropic['messages']['create']>[0],
    attempt = 0,
  ): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(params) as Anthropic.Message;
    } catch (err) {
      if (attempt >= 3 || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      const jitter = Math.random() * 0.3 * delay;
      await sleep(delay + jitter);
      return this.callWithRetry(params, attempt + 1);
    }
  }
}
