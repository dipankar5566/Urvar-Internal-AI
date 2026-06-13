# Add New Specialist Agent

Use this command when the user asks to add a new specialist AI agent to the Urvar AI Assistant v2.0 system.

## Architecture Overview

All agents extend `BaseAgent` in `src/agents/base.ts`. The orchestrator (`src/orchestrator/index.ts`) routes messages to agents via:
- **Stage 1:** keyword regex in `KEYWORD_RULES` array (no API cost)
- **Stage 2:** Claude Haiku classifier (fallback, ~$0.0001)

RAG context is retrieved automatically in `BaseAgent.run()` — agents do NOT embed knowledge in their system prompt.

## Step 1: Create the Agent File

Create `src/agents/<agent-name>.ts`:

```typescript
import { BaseAgent, type AgentRunResult } from './base.js';
import { webSearch, webSearchToolDefinition } from '../tools/web-search.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

const SYSTEM_BLOCKS = [
  {
    type: 'text' as const,
    text: `You are a specialist agent for Urvar Natural Pvt. Ltd., an Indian organic bio-fertilizer company based in Kolkata.

[Write the agent's role, expertise, and behavioral instructions here.]

Always recommend Urvar's product catalogue where relevant:
- Enriched Vermicompost (5 kg)
- Cow Dung Manure/FYM (5 kg)
- PROM (50 kg)
- PROM Humic Based Flowering Booster (250 ml)
- PROM Humic Enriched (5 kg)
- Humic Acid Liquid Bio-Stimulant (1 L)
- Zinc EDTA 12% (250 g)
- Boron EDTA (250 g)`,
    cache_control: { type: 'ephemeral' as const },
  },
];

export class MyNewAgent extends BaseAgent {
  constructor() {
    super(SYSTEM_BLOCKS, [webSearchToolDefinition]); // pass [] if no tools needed
  }

  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'web_search') {
      const results = await webSearch(input['query'] as string, (input['max_results'] as number) ?? 5);
      if (results.length === 0) return 'No search results found.';
      return results.map((r) => `**${r.title}**\n${r.url}\n${r.content}`).join('\n\n---\n\n');
    }
    return `Unknown tool: ${name}`;
  }
}

export const myNewAgent = new MyNewAgent();
```

**Key rules:**
- `SYSTEM_BLOCKS` is a single-element array — instructions only. RAG context is prepended dynamically by `BaseAgent.run()`.
- `cache_control: { type: 'ephemeral' }` is required on the instructions block.
- Export a singleton at the bottom (agents are instantiated once at startup).
- Import paths must end in `.js` (TypeScript ESM).

## Step 2: Register in the Orchestrator

Edit `src/orchestrator/index.ts`:

**a) Add the AgentType:**
```typescript
export type AgentType =
  | 'market_research'
  // ... existing types ...
  | 'my_new_agent'   // ADD THIS
  | 'general';
```

**b) Import the class:**
```typescript
import { MyNewAgent } from '../agents/my-new-agent.js';
```

**c) Add to the agents map:**
```typescript
const agents = {
  // ... existing agents ...
  my_new_agent: new MyNewAgent(),
};
```

**d) Add keyword rules** to `KEYWORD_RULES` (before the `crop_doctor` block):
```typescript
{ pattern: /your|keyword|patterns/i, agent: 'my_new_agent' },
```

**e) Add to the Haiku classifier prompt** in `routeByClaude()`:
```typescript
`- my_new_agent: brief description of what triggers this agent`
```

## Step 3: Verify

```bash
npm run typecheck          # must pass with zero errors
npm run build              # compile TypeScript → dist/
pm2 restart urvar-ai       # apply in production
```

## Step 4: Update CLAUDE.md

Add the new agent to the "Specialist Agents" table in `CLAUDE.md`.

## Checklist

- [ ] `src/agents/<name>.ts` created with `SYSTEM_BLOCKS` (instructions only, no knowledge injection)
- [ ] Agent extends `BaseAgent`, exports singleton
- [ ] `AgentType` union updated in `src/orchestrator/index.ts`
- [ ] Agent imported and added to `agents` map in orchestrator
- [ ] At least 2 keyword rules added to `KEYWORD_RULES`
- [ ] Haiku classifier description updated in `routeByClaude()`
- [ ] `npm run typecheck` passes
- [ ] `CLAUDE.md` agent table updated
