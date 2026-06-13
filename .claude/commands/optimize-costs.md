# Optimize Costs

Use this command to analyze and reduce the API costs of the Urvar AI Assistant v2.0.

## Cost Sources

The bot uses three paid APIs:

### 1. Anthropic (Claude)
Primary cost driver. Two usage patterns:
- **Routing (Stage 2):** `claude-haiku-4-5-20251001` — ~$0.0001 per classification. Only called when keyword routing fails.
- **Agent responses:** `claude-sonnet-4-6` (or configured model) — tokens in + tokens out + cache tokens.

### 2. Tavily (Web Search)
Per-search cost. `advanced` search mode is used for Crop Doctor; `basic` for other agents. Reduce by:
- Lowering `max_results` in tool calls
- Switching from `advanced` to `basic` mode where deep research isn't needed

### 3. Voyage AI (Embeddings)
**One-time cost at index build time.** Query-time embedding costs are minimal (~512-dim, single vector per query).
- Index build: ~60-80 chunks × `voyage-3-lite` → < $0.01 total
- Per-query: 1 embedding call → fractional cent
- No rebuild unless `RAG/docs/*.md` files change

## Cost Reduction Strategies

### A. Prompt Caching (Already Implemented)
All agent `SYSTEM_BLOCKS` use `cache_control: { type: 'ephemeral' }`. This caches system prompts for 5 minutes, reducing input token costs on repeated queries to the same agent by ~80%.

The RAG context block is prepended with `cache_control: { type: 'ephemeral' }` in `src/agents/base.ts:runAgenticLoop()`. Caching is most effective when users ask multiple questions to the same agent in a session.

### B. RAG Reduces Token Bloat (Already Implemented)
Before vector RAG, all 7 knowledge docs (~103KB) were injected into every call. Now only the top-5 relevant chunks (~5KB) are retrieved per query — a **~70-80% token reduction** on knowledge context.

To tune: reduce `RAG_TOP_K` (default: 5) if answers are accurate enough with fewer chunks:
```bash
# .env
RAG_TOP_K=3
```

### C. Keyword Routing Reduces Haiku Calls
Every keyword match in Stage 1 (`src/orchestrator/index.ts:38`) saves one Haiku API call. If you notice many messages going through Stage 2, add keyword patterns for common phrasings.

Check how often Stage 2 is hit:
```bash
pm2 logs urvar-ai | grep -c 'routeByClaude'  # approximate — add explicit logging if needed
```

### D. Reduce Agentic Loop Iterations
Each loop iteration = one Anthropic API call. Check `src/agents/base.ts` for `max_iterations`. Reduce if agents are running many tool-call rounds unnecessarily.

### E. Use Haiku for Simple Agents
If an agent doesn't need Sonnet's reasoning depth, override the model in the constructor:
```typescript
super(SYSTEM_BLOCKS, [webSearchToolDefinition], 'claude-haiku-4-5-20251001');
```
Check `src/agents/base.ts` to see how the model parameter is passed.

## Monitoring Token Usage

Each `AgentRunResult` includes:
- `tokensIn` / `tokensOut` — billable tokens
- `cacheRead` — tokens served from cache (discounted ~90%)
- `cacheWrite` — tokens written to cache (slight surcharge)

The bot currently logs these per-request. To aggregate:
```bash
pm2 logs urvar-ai | grep 'tokensIn'
```

## Cost Estimation (Rough)

| Component | Cost per interaction |
|-----------|---------------------|
| Haiku routing (Stage 2) | ~$0.0001 |
| Sonnet agent response (cached system) | ~$0.001–0.01 |
| Tavily search (basic, 3 results) | ~$0.002 |
| Voyage AI query embedding | ~$0.000005 |
| Voyage AI index rebuild (full) | < $0.01 one-time |
