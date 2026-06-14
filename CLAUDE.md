# CLAUDE.md — Urvar AI Assistant v2.0

## Project Overview

Multi-agent Telegram bot for **Urvar Natural Pvt. Ltd.**, an Indian organic bio-fertilizer company. Provides business intelligence (market research, competitive analysis, R&D, sales/marketing, lead generation) and crop disease diagnosis via six specialised AI agents.

- **Stack:** TypeScript (strict ESM), Node 22+, Anthropic SDK, node-telegram-bot-api, node:sqlite, node-cron, Tavily API, Voyage AI
- **Runtime:** Compiled to `dist/` via `tsc`, deployed via PM2

---

## Quick Start

```bash
cp .env.example .env        # fill in all required vars
npm install
npm run dev                  # dev with hot reload (tsx watch)
npm run build && npm start   # production
pm2 start ecosystem.config.cjs  # production via PM2
```

---

## Repo Map

```
src/
  index.ts               # Entry — health checks (SQLite, Anthropic, Tavily, Voyage AI), wires bot + scheduler
  config.ts              # Env var validation; throws at startup if required vars missing
  knowledge.ts           # Legacy doc loader — no longer used by agents; kept as reference
  rag/
    index.ts             # Public API: initVectorStore(), retrieveRelevantContext()
    chunker.ts           # Splits markdown into RawChunk[] at ## boundaries
    embedder.ts          # Voyage AI client — embedTexts() (document) + embedQuery() (query)
    store.ts             # JSON persistence + in-memory cosine similarity search
  agents/
    base.ts              # Abstract BaseAgent — agentic loop, retry, token tracking
    crop-doctor.ts       # Vision agent — runWithImage(), image optimization + ML hint
    market-research.ts
    competitive-analysis.ts
    rd-product-development.ts
    sales-marketing.ts
    lead-generation.ts
  orchestrator/
    index.ts             # 2-stage routing: regex KEYWORD_RULES → Haiku classifier fallback
  bot/
    telegram.ts          # All Telegram handlers (/start /help /clear /ping /report, message, photo)
  scheduler/
    index.ts             # Weekly cron Monday 09:00 IST; exports sendWeeklyReport()
  db/
    index.ts             # node:sqlite schema, prepared statements, appendHistory/getHistory
  memory/
    index.ts             # Haiku-powered memory extraction + storage; pruned at 100 per session
  tools/
    web-search.ts        # Tavily search (returns {answer, results}) + formatSearchResponse() + webSearchToolDefinition
    image-optimizer.ts   # Sharp variants (denoised/saturated/grayscale); graceful fallback
    crop-classifier.ts   # TensorFlow crop classifier; graceful fallback if model/tfjs absent
  utils/
    message.ts           # splitMessage(), formatUptime()
  types/
    optional-deps.d.ts   # Ambient declarations for sharp and @tensorflow/tfjs-node (typed as any)
RAG/
  docs/                  # 7 markdown knowledge files: company.md, products.md, pricing.md,
                         # customers.md, urvar-summary.md, crop-guide.md, disease-guide.md
tests/
  setup.ts               # Env preload — dotenv + placeholder fallbacks so unit tests import config-validated modules without real keys
  unit/                  # Tier 1: deterministic, no-keys regression tests (node:test) — npm test
  integration/           # Tier 2: opt-in live-API smoke tests (RUN_INTEGRATION) — npm run test:integration
  eval/                  # Tier 3: manual A/B quality runner (no assertions) — npm run test:eval
data/                    # SQLite DB + rag-index.json (runtime, gitignored)
logs/                    # PM2 logs (runtime, gitignored)
ecosystem.config.cjs     # PM2 process config (CommonJS — required by PM2)
tsconfig.test.json       # tsc project for type-checking src/ + tests/ together
```

---

## Architecture Rules

### Agent System

- All agents extend `BaseAgent` (`src/agents/base.ts`).
- Each agent needs: class extending `BaseAgent`, singleton instance export, `SYSTEM_BLOCKS` as `TextBlockParam[]` (1 block — instructions only), `handleToolCall()` implementation.
- **`SYSTEM_BLOCKS` contains the instructions block only.** The knowledge block is assembled dynamically at query time by `BaseAgent.run()` via `retrieveRelevantContext()` from `src/rag/index.ts`.
- **The dynamically-inserted knowledge block MUST have `cache_control: { type: 'ephemeral' }`.** This is set automatically in `BaseAgent.runAgenticLoop()` — do not remove it.
- The instructions block in each agent's `SYSTEM_BLOCKS` also carries `cache_control: { type: 'ephemeral' }`.
- Every text agent uses `webSearchToolDefinition` from `src/tools/web-search.ts`.
- `CropDoctorAgent` is the only vision agent — uses `runWithImage()`, which calls `retrieveRelevantContext()` directly before calling `runAgenticLoop()`.
- New agents must be registered in the `agents` map and `AgentType` union in `src/orchestrator/index.ts`.
- New agents do **not** need a knowledge bundle in `src/knowledge.ts` — RAG handles retrieval automatically.
- **Per-agent generation tuning** is passed as the optional 3rd `AgentOptions` arg to the `BaseAgent` constructor (`{ temperature?, thinkingBudget?, maxTokens? }`), applied in `runAgenticLoop()`:
  - `market_research`, `competitive_analysis`, `rd_product_development`: **extended thinking** on (`thinkingBudget: 3000`, `maxTokens: 8000`).
  - `crop_doctor`, `lead_generation`: `temperature: 0.3` (factual consistency), `max_tokens` default 4096.
  - `sales_marketing`: no options — default temperature (creative copy), 4096.
  - **Extended thinking and a non-default `temperature` are mutually exclusive** — the API requires default temperature when `thinking` is enabled. `runAgenticLoop()` enforces this (thinking wins; temperature is only applied when no thinking budget is set). Never set both on one agent.
  - When thinking is enabled, `max_tokens` MUST exceed `thinkingBudget` (budget min 1024). Pushing the full `response.content` back across tool turns preserves the required `thinking` blocks — do not strip them.
- `max_tokens` defaults to 4096; agents may override via `AgentOptions.maxTokens` (analytical agents use 8000). Do not raise the default without testing.
- Max loop iterations: `config.maxAgentIterations` (default 8) — never hardcode.
- Retry in `BaseAgent.callWithRetry()` handles: status 429/500/503/529 + `ECONNRESET/ETIMEDOUT/ENOTFOUND/ECONNREFUSED`. Max 3 retries, exponential backoff + 30% jitter.

### RAG System

- **Index file:** `data/rag-index.json` — generated at first startup, reloaded from disk on subsequent starts.
- **Cache invalidation:** SHA-256 hash of all doc content stored in the index. If the hash matches on startup, the index is reused (no Voyage API call). Any doc edit triggers a full re-index.
- **Embeddings:** Voyage AI `voyage-3-lite` (512-dim). `VOYAGE_API_KEY` is required. `embedTexts()` uses `input_type: 'document'`; `embedQuery()` uses `input_type: 'query'`.
- **Search:** Pure cosine similarity in `src/rag/store.ts`. 80 chunks × 512 floats — microseconds. No external vector DB.
- **Chunking:** Markdown split at `##` boundaries in `src/rag/chunker.ts`. Sections >4000 chars sub-split at `###` (labeled `## X > ### Y`). Sections <100 chars merged upward. Files with no `##` (e.g. `urvar-summary.md`) become one chunk. Content outside any `##` heading — a heading-less file, or the preamble before a file's first `##` — is labeled by the doc's first `# h1` heading (falling back to the filename). Each chunk's `section` is metadata only — it is **not** embedded (embeddings come from `content`), it's shown to the model as the `### {section} ({sourceFile})` header in the knowledge block.
- **Adding new docs:** Add the filename to `DOC_FILES` in `src/rag/index.ts` and place the file in `RAG/docs/`. Next startup auto-reindexes (hash mismatch).
- **`retrieveRelevantContext()` returns empty string on any error** — agents still run, just without RAG context (graceful degradation).
- **Conversation-aware retrieval:** `BaseAgent.run()` (and `CropDoctorAgent.runWithImage()`) build the embedding query via `buildRetrievalQuery()` in `src/agents/base.ts`, which prepends the most recent prior user turn so follow-ups ("what about its pricing?") keep their referent. The conversation query is used **only** for retrieval — the message sent to the model is unchanged.
- **Similarity floor:** `search()` in `src/rag/store.ts` drops chunks scoring below `config.ragMinScore` before returning, so off-topic queries don't inject low-relevance "knowledge". Default `0.3` (conservative), tunable via `RAG_MIN_SCORE`.
- **`RAG_TOP_K`** controls how many chunks are retrieved per query (default 5, configurable via env var).

### Routing (Orchestrator)

- Stage 1: `KEYWORD_RULES` in `src/orchestrator/index.ts` — regex matching, no API call.
- Stage 2: Claude Haiku classifier fallback (`max_tokens: 20`, `temperature: 0` for deterministic routing).
- Update `KEYWORD_RULES` when adding a new agent.
- Keyword patterns use `/regex/i`. Use `\b` word boundaries for acronyms.
- `AgentType` values are **snake_case strings**: `'market_research'`, `'crop_doctor'` — NOT camelCase.
- The `'general'` type is a no-op fallback — returns a static string, does not call any agent.

### Database

- Use `db.prepare()` for all queries — never template literals with user data.
- New tables require `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- History retrieval controlled by `config.historyTurns` — do not change the limit directly.
- Rows come back newest-first from DB; `getHistory()` reverses to chronological order.
- Memory pruned at 100 entries per session (`MAX_MEMORIES` in `src/memory/index.ts`).

### Config

- All new env vars must be added to `src/config.ts`.
- Required vars: use `require_env()` helper — throws at startup if missing.
- Optional vars: `process.env.VAR ?? 'default'` pattern.
- Config object is `as const` — never mutate it.

### TypeScript

- ESM format — all imports use `.js` extension even for `.ts` source files (e.g., `'../config.js'`).
- Strict mode on — no `any` except in `src/types/optional-deps.d.ts`.
- Never use `require()` — pure ESM project (`"type": "module"` in package.json).
- Use `node:sqlite` (Node 22+ built-in), not `better-sqlite3`.
- Target: `ES2022`, `moduleResolution: bundler`.

### Optional Dependencies (sharp, @tensorflow/tfjs-node)

- Both may fail to install (native C++ bindings).
- Always check availability at runtime via dynamic `import()` in try/catch before use.
- Return graceful fallback: `optimizeImage` → original image; `classifyCropImage` → `{ available: false }`.
- Declared in `src/types/optional-deps.d.ts` as `any` — do not add `@types/` packages for them.

---

## Naming Conventions

### Files
- kebab-case: `crop-doctor.ts`, `web-search.ts`, `rd-product-development.ts`
- Directories: lowercase — `agents/`, `tools/`, `db/`, `memory/`
- Each directory has a single `index.ts` as its entry point

### Classes and Interfaces
- Agent classes: `[Domain]Agent` — `CropDoctorAgent`, `MarketResearchAgent`
- Singleton instances: camelCase — `cropDoctorAgent` (exported alongside class)
- Result interfaces: `[Domain]Result` — `AgentRunResult`, `OrchestratorResult`
- Type unions: PascalCase — `AgentType`, `CropClassification`

### Functions and Variables
- Functions: camelCase verbs — `runOrchestrator()`, `webSearch()`, `appendHistory()`
- Module-level constants: `UPPER_SNAKE_CASE` — `KEYWORD_RULES`, `AGENT_TIMEOUT_MS`
- Agent type strings: snake_case — `'market_research'`, `'crop_doctor'`
- DB column names: snake_case — `session_id`, `tokens_in`, `cache_read`
- Env vars: `UPPER_SNAKE_CASE` — `ANTHROPIC_API_KEY`

---

## Logging Conventions

Use `console.log` / `console.error` only — no external logger. Prefix format:

| Prefix | Context |
|--------|---------|
| `[startup]` | Startup + health checks |
| `[rag]` | Vector store init + retrieval errors |
| `[scheduler]` | Cron job events |
| `[bot]` | Telegram handler errors |
| `[fatal]` | Uncaught errors in `main()` |
| `[shutdown]` | SIGINT/SIGTERM handlers |

---

## Common Commands

```bash
npm run dev        # tsx watch src/index.ts — hot reload
npm run build      # tsc — compiles to dist/
npm start          # node dist/index.js
npm run typecheck  # tsc --noEmit — type check only (src/)
npm run typecheck:test           # tsc -p tsconfig.test.json — type check src/ + tests/
npm test           # Tier 1 unit tests — no keys, no cost
npm run test:integration         # Tier 2 live-API smoke tests (needs real .env)
npm run test:eval                # Tier 3 manual A/B quality runner (needs real .env)
pm2 start ecosystem.config.cjs   # production deploy
pm2 logs urvar-bot               # tail logs
pm2 restart urvar-bot            # restart
```

---

## Deployment

- PM2 app name: `urvar-bot`
- Config: `ecosystem.config.cjs` (CommonJS — PM2 requires CJS config files even in ESM projects)
- Restart policy: 5s delay, max 20 restarts, no watch mode
- Logs: `./logs/bot-out.log` (stdout), `./logs/bot-error.log` (stderr)
- Start sequence: `npm run build` then `pm2 start ecosystem.config.cjs`

### Auto-start on boot (macOS / launchd)

The production Mac is configured so `urvar-bot` restarts automatically. This is a **launchd LaunchAgent**, not a LaunchDaemon — the bot starts on **user login** (`dipankarchanda`), not at the pre-login boot screen. For an unattended/headless server, a LaunchDaemon in `/Library/LaunchDaemons/` would be required instead.

- **Agent plist:** `~/Library/LaunchAgents/pm2.dipankarchanda.plist` (launchd label `com.PM2`). `RunAtLoad=true` runs `pm2 resurrect` on login, which restores processes from the saved dump.
- **Saved process list:** `~/.pm2/dump.pm2`. **After any `pm2 start` / `delete` / config change, run `pm2 save`** — otherwise a reboot resurrects the stale list.
- **pm2 install note:** pm2 (v7.x) is installed at the user-level npm prefix `~/.npm-global` (full binary path `~/.npm-global/lib/node_modules/pm2/bin/pm2`); `~/.zshrc` adds `~/.npm-global/bin` to PATH.
- **(Re)install the hook:** `pm2 startup` prints a `sudo env PATH=...` command — run it in a terminal (needs an interactive sudo password), then `pm2 save`.
- **Verify resurrect** without rebooting: `pm2 kill && pm2 resurrect` should bring `urvar-bot` back online.
- **Remove the hook:** `pm2 unstartup launchd`.

---

## Test Expectations

Two-tier suite under `tests/`, using Node's built-in `node:test` + `node:assert` run through `tsx` — **no new dependencies** (mirrors the `node:sqlite` "use built-ins" ethos).

- **`npm test`** — Tier 1 deterministic unit tests (`tests/unit/`). **No API keys, no cost, no network.** Covers the pure logic: `splitMessage`/`formatUptime`, `chunkMarkdown`, `hashDocs`/`search` (incl. the `minScore` floor), `formatSearchResponse`, `buildRetrievalQuery`, `routeByKeyword`, `isRetryable`. This is the regression backbone — run it before every commit.
- **`npm run test:integration`** — Tier 2 live-API smoke tests (`tests/integration/`). Opt-in only (gated on `RUN_INTEGRATION`, set automatically by the script); needs a real `.env`; makes paid calls. Asserts structural invariants (routing, non-empty grounded response, RAG returns knowledge), not exact text. **Still never mocks the Anthropic SDK** — the value is live behaviour.
- **`npm run test:eval`** — Tier 3 manual A/B runner (`tests/eval/run.ts`, no assertions). Prints responses + token/cache/iteration stats for representative prompts to compare answer quality before/after a change. Needs a real `.env`.
- **Env preload:** `tests/setup.ts` (loaded via `--import`) runs `dotenv/config` then fills only *missing* required env vars with placeholders (`??=`). This lets unit tests import modules whose `config.ts` validates env at load time, without real keys; real keys (when a `.env` exists) are never overwritten, so integration/eval still hit live APIs.
- **Type-checking & build:** tests live outside `rootDir: src`, so `npm run build` never emits them to `dist/`. The base `npm run typecheck` covers `src/` only; **`npm run typecheck:test`** (`tsconfig.test.json`) type-checks `src/` + `tests/` together.
- **Two source symbols are exported solely for testing** (additive, non-breaking): `routeByKeyword` (`src/orchestrator/index.ts`) and `isRetryable` (`src/agents/base.ts`).
- Health checks in `src/index.ts` (SQLite ping, Anthropic API ping, Tavily ping, Voyage AI ping) remain the primary startup smoke tests.

---

## Key Invariants — Never Break These

1. **RAG index loaded once.** `initVectorStore()` runs at startup, loads `data/rag-index.json` into memory, and rebuilds only if the docs hash changed. Never call Voyage AI per-request for indexing.

2. **Agents instantiated once.** All singletons are created at module load in `src/orchestrator/index.ts`. `SYSTEM_BLOCKS` (instructions only) are built once and cached in memory.

3. **Prompt cache control is mandatory.** The dynamically-built knowledge block in `BaseAgent.runAgenticLoop()` and the instructions block in every agent's `SYSTEM_BLOCKS` MUST have `cache_control: { type: 'ephemeral' }`. Removing this breaks Anthropic prompt caching and increases cost.

4. **Memory extraction is non-blocking.** The `void extractAndSaveMemories(...)` call in `src/bot/telegram.ts` must remain `void`-prefixed and must never block or throw on the response path.

5. **splitMessage duplication is known.** `splitMessage()` exists in both `src/utils/message.ts` (canonical) and `src/scheduler/index.ts` (duplicate to fix). Import from utils in the scheduler — do not add a third copy.

6. **Typing indicator at 4s.** Telegram clears the typing indicator after 5s. The `setInterval` at 4000ms in `src/bot/telegram.ts` is intentional.

7. **Weekly report uses Promise.allSettled.** In `src/scheduler/index.ts` — do not change to `Promise.all`. A single agent failure must not abort the full report.

8. **Model assignment by cost.** Claude Haiku for cheap tasks (routing, memory extraction). `config.claudeModel` (Sonnet) for all main agent responses.

9. **RAG files are mapped.** Every file in `/RAG/docs/` that should be indexed must be listed in `DOC_FILES` in `src/rag/index.ts`. Renaming a doc file without updating this array silently drops it from the index.

10. **ecosystem.config.cjs stays CJS.** PM2 cannot load ESM config files. This file must remain `.cjs` with `module.exports =` syntax.

---

## Environment Variables

**Required** (throws at startup if missing):
```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...
TAVILY_API_KEY=tvly-...
VOYAGE_API_KEY=pa-...
```

**Optional** (defaults shown):
```
TELEGRAM_GROUP_ID=                  # unset = /report and weekly scheduler skip gracefully
SQLITE_DB_PATH=./data/urvar.db
CLAUDE_MODEL=claude-sonnet-4-6
HISTORY_TURNS=10
MAX_AGENT_ITERATIONS=8
RAG_TOP_K=5
RAG_MIN_SCORE=0.3
RAG_INDEX_PATH=./data/rag-index.json
```

---

## Adding a New Agent — Checklist

1. Create `src/agents/[name].ts` — extend `BaseAgent`, export class + singleton, define `SYSTEM_BLOCKS` as a **single-element array** (instructions block only, with `cache_control: ephemeral`). RAG context is injected automatically by `BaseAgent.run()`.
2. Add agent type to `AgentType` union in `src/orchestrator/index.ts`.
3. Instantiate singleton in the `agents` map in `src/orchestrator/index.ts`.
4. Add `KEYWORD_RULES` patterns in `src/orchestrator/index.ts`.
5. Add an `AGENT_LABELS` entry in `src/bot/telegram.ts`.
6. If the agent needs domain-specific docs not already in `RAG/docs/`: add the file there and list it in `DOC_FILES` in `src/rag/index.ts`.
