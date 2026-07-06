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

// Today's date (IST), injected into the dynamic knowledge block so agents
// reason about "this week" / seasonal timing correctly. Lives in the per-query
// block — putting it in the cached SYSTEM_BLOCKS would invalidate that cache.
export function currentDateLine(now = new Date()): string {
  const formatted = now.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  return `Current date: ${formatted} (IST)`;
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

  // Which learned-knowledge category this agent should retrieve. Business by
  // default; Crop Doctor overrides to 'agronomy' so the two pools stay separate.
  protected readonly knowledgeCategory: 'business' | 'agronomy' = 'business';

  // Agent-specific context appended after the RAG knowledge block (e.g. the lead
  // pipeline for Lead Generation). Empty by default.
  protected extraContext(): string {
    return '';
  }

  async run(userMessage: string, history: MessageParam[]): Promise<AgentRunResult> {
    const context = await retrieveRelevantContext(
      buildRetrievalQuery(userMessage, history),
      config.ragTopK,
      this.knowledgeCategory,
    );
    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: userMessage },
    ];
    const extra = this.extraContext();
    return this.runAgenticLoop(messages, [context, extra].filter(Boolean).join('\n\n'));
  }

  protected async runAgenticLoop(messages: MessageParam[], context = ''): Promise<AgentRunResult> {
    // The dynamic block always exists now (date line at minimum) and keeps its
    // mandatory ephemeral cache_control — stable within a run, changes daily.
    const dynamicBlock = [currentDateLine(), context].filter(Boolean).join('\n\n');
    const systemBlocks: TextBlockParam[] = [
      { type: 'text', text: dynamicBlock, cache_control: { type: 'ephemeral' } },
      ...this.systemPromptBlocks,
    ];

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
        // A failed tool call (e.g. a Tavily timeout on a flaky network) must not
        // discard the whole run — report it as an errored tool_result so the
        // model can retry the call or synthesize from what it already has.
        let result: string;
        let isError = false;
        try {
          result = await this.handleToolCall(toolBlock.name, toolBlock.input);
        } catch (err) {
          isError = true;
          const reason = err instanceof Error ? err.message : String(err);
          result = `Tool "${toolBlock.name}" failed: ${reason}. You may retry it (perhaps with a different query) or continue with the information already gathered.`;
          console.error(`[bot] tool ${toolBlock.name} failed:`, err);
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result,
          ...(isError ? { is_error: true } : {}),
        });
      }

      // Keep exactly one message-history cache breakpoint, on the newest
      // tool_result, so each loop turn reads all prior turns (system + tool
      // results) from cache instead of re-billing them as fresh input.
      for (const m of messages) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type === 'tool_result' && b.cache_control) delete b.cache_control;
        }
      }
      toolResults[toolResults.length - 1]!.cache_control = { type: 'ephemeral' };

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      iteration++;
    }

    // Iteration budget exhausted. Rather than discarding everything gathered,
    // make one final tool-free call so the model synthesizes an answer from the
    // research it already has. The synthesis prompt rides in the same user
    // message as the last tool results (roles must alternate).
    try {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === 'user' && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({
          type: 'text',
          text: 'You have used all available research steps. Using ONLY the information gathered above, write your best final answer now. Briefly note anything you could not verify.',
        });
      }
      const params: MessageCreateParamsNonStreaming = {
        model: config.claudeModel,
        max_tokens: this.options.maxTokens ?? 4096,
        system: systemBlocks,
        tools: this.tools,
        tool_choice: { type: 'none' },
        messages,
      };
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
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');
      if (text) {
        return { response: text, iterations: iteration + 1, tokensIn, tokensOut, cacheRead, cacheWrite };
      }
    } catch (err) {
      console.error('[bot] budget-exhausted synthesis call failed:', err);
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
