import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
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

const RETRYABLE_STATUSES = new Set([429, 500, 503, 529]);
const RETRYABLE_CODES = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/;

function isRetryable(err: unknown): boolean {
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

  constructor(systemPromptBlocks: TextBlockParam[], tools: Tool[]) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.systemPromptBlocks = systemPromptBlocks;
    this.tools = tools;
  }

  abstract handleToolCall(name: string, input: Record<string, unknown>): Promise<string>;

  async run(userMessage: string, history: MessageParam[]): Promise<AgentRunResult> {
    const context = await retrieveRelevantContext(userMessage);
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
      const response = await this.callWithRetry({
        model: config.claudeModel,
        max_tokens: 4096,
        system: systemBlocks,
        tools: this.tools,
        messages,
      });

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
