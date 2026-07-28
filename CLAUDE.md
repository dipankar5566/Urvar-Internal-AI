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
npm run dev                  # dev with hot reload (tsx watch) — Telegram bot + web API
npm run build && npm start   # production (builds src/ AND web/)
pm2 start ecosystem.config.cjs  # production via PM2
```

The lightweight web UI (chat + admin dashboard) has its own `package.json` under `web/` — run `cd web && npm install` once as well. `npm run dev:web` (root) starts its Vite dev server separately; see the Web UI section below.

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
    index.ts             # 2-stage routing: regex KEYWORD_RULES → Haiku classifier fallback (with last-agent follow-up hint)
  bot/
    telegram.ts          # All Telegram handlers (/start /help /clear /ping /report /leads /enrich /callsheet /pitch /article, message, photo)
  scheduler/
    index.ts             # Crons: weekly report Mon 09:00 IST (group), call sheet + content draft (owner); exports sendWeeklyReport()/sendCallSheet()/sendContentDraft()
  db/
    index.ts             # node:sqlite schema, prepared statements, appendHistory/getHistory/getLastAgentUsed
  leads/
    index.ts             # Persistent B2B lead pipeline (leads table) + save_lead tool definition
    util.ts              # Pure helpers: normalizeLeadKey(), statuses, pitch/call-sheet/enrichment prompt builders, formatFunnel() — no DB imports (unit-testable)
  tools/
    web-search.ts        # Tavily search + formatSearchResponse() + runWebSearchTool() shared handler + webSearchToolDefinition
    image-optimizer.ts   # Sharp variants (denoised/saturated/grayscale); graceful fallback
    crop-classifier.ts   # TensorFlow crop classifier; graceful fallback if model/tfjs absent
  utils/
    message.ts           # splitMessage(), formatUptime(), sendMarkdownSafe()
  types/
    optional-deps.d.ts   # Ambient declarations for sharp and @tensorflow/tfjs-node (typed as any)
  web/
    server.ts            # startWebServer(bot) — Express app (each router mounted at its own prefix), static serving of web/dist, request logging, /api/health, graceful skip if unconfigured
    auth.ts               # Shared-password login (owner/member), stateless HMAC-signed session cookie, requireAuth()/requireOwner()
    rate-limit.ts          # LoginRateLimiter — pure in-memory lockout for /api/auth/login, no Express dependency
    routes/
      chat.ts             # POST /api/chat, /api/chat/image (up to 3 photos), GET /api/chat/history, GET/DELETE /api/chat/sessions — mirrors bot/telegram.ts's message/photo handlers
      leads.ts            # GET/POST/PATCH /api/leads (search/pagination/create/detail/status/contact), POST /:id/pitch, POST /enrich
      kb.ts               # GET/POST/PATCH /api/kb (general browse+search+pagination, plus /pending/:id/approve/:id/reject) — owner-only
      reports.ts          # GET /api/reports/* (archived weekly report, kbstats, call-ready leads) + POST .../generate (on-demand call sheet / article drafting)
web/                      # Separate React + Vite SPA (own package.json/node_modules) — Notion-derived design system, sidebar shell, chat/leads/reports/kb pages
RAG/
  docs/                  # 8 markdown knowledge files: company.md, products.md, pricing.md,
                         # customers.md, competitors.md, urvar-summary.md, crop-guide.md, disease-guide.md
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
- Every text agent uses `webSearchToolDefinition` from `src/tools/web-search.ts`, and handles the call via the shared `runWebSearchTool()` (per-agent defaults for depth/result count/raw content; plumbs the model-supplied `include_domains` through to Tavily).
- `BaseAgent.extraContext()` is an overridable hook — agent-specific context appended after the RAG knowledge block (Lead Generation uses it to inject the known-leads pipeline).
- `runAgenticLoop()` keeps exactly one message-history cache breakpoint on the newest `tool_result` (moved each iteration) so multi-iteration tool runs read prior turns from prompt cache. Do not add more breakpoints — Anthropic allows max 4 total (2 are used by system blocks).
- **The dynamic system block always exists** and starts with `currentDateLine()` (IST) so agents know today's date; RAG context follows. Never move the date into `SYSTEM_BLOCKS` — that would invalidate the cached instructions block daily.
- **Budget-exhausted synthesis:** when `maxAgentIterations` runs out, `runAgenticLoop()` makes one final call with `tool_choice: none` asking the model to synthesize from the research already gathered (the instruction is appended to the last tool_result user message — roles must alternate). The old "unable to complete" apology is only the fallback if that call fails.
- `runWebSearchTool()` per-agent defaults: `market_research` advanced; `competitive_analysis` and `crop_doctor` advanced (+ raw content for competitive); `lead_generation` advanced + raw content, 8 results. The model may pass `include_domains` and `recency_days` (news-filtered, capped 365) on any search.
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
- **Category-scoped learned retrieval:** `search()` takes an optional `learnedCategory` (`business` | `agronomy`). Learned chunks carry a `category`; those of the other category are dropped, while **curated doc chunks (no category) always pass**. Each agent's `knowledgeCategory` (default `business`; `CropDoctorAgent` overrides to `agronomy`) is threaded through `retrieveRelevantContext()`. This keeps crop agronomy out of business-intelligence retrieval and vice versa.
- **Similarity floor:** `search()` in `src/rag/store.ts` drops chunks scoring below `config.ragMinScore` before returning, so off-topic queries don't inject low-relevance "knowledge". Default `0.3` (conservative), tunable via `RAG_MIN_SCORE`.
- **`RAG_TOP_K`** controls how many chunks are retrieved per query (default 5, configurable via env var).

### Learned Knowledge (auto-learning KB)

- **This is the bot's single memory.** There is no per-session memory store — the old `agent_memory` module was **retired**. Institutional knowledge lives only in the shared KB and reaches the model via RAG retrieval. Per-chat continuity within a session still comes from `conversation_history`.
- **Goal:** the bot grows a shared KB from real usage, gated behind **owner approval** to prevent poisoning. Disable entirely with `KB_LEARNING_ENABLED=false`.
- **Runtime store is DB-backed, not a curated doc.** Approved facts live in the `learned_knowledge` SQLite table **with their 512-dim embedding persisted** (`src/rag/learned.ts`). They are injected into the in-memory index via `appendLearnedChunk()` (`src/rag/index.ts`) at approval time (real-time, no restart) and at startup (`loadApprovedLearned()` → wired from `src/index.ts`, not `rag/index.ts`, to avoid a circular import).
- **Category (`business` | `agronomy`).** Every fact carries a category, derived from its source by `categoryForSource()` (`crop_doctor` → agronomy, all else → business). Retrieval is category-scoped (see RAG section) so agronomy facts don't crowd business-intelligence retrieval. The column is added by an additive migration that backfills existing rows from `source`.
- **Never written to `rag-index.json`.** Only `buildIndex` writes that file. Learned chunks augment the in-memory copy only, so the curated docs hash stays stable and curated chunks are never re-embedded. `RAG/docs/learned.md` is a human-readable **mirror only — NOT in `DOC_FILES`** (adding it would force a full curated re-embed).
- **Sources** (all funnel into `proposeLearned` → pending → owner review): `/teach` command; per-conversation distillation (every 3 turns, `distillConversationToKb`, `void`-prefixed — the single non-blocking learning call on the response path); captured web research (ring buffer in `src/tools/web-search.ts`, now capturing the top result snippets too, drained by the cron); periodic self-summary (`KB_DISTILL_CRON`, `src/learning/index.ts`). All distillation uses Haiku and logs failures under `[learning]` (no longer silently swallowed). **The distiller prompt is instruction-hardened:** extraction rules live in the `system` prompt and are repeated after the material, and the material block is capped (`MATERIAL_CHAR_CAP`, tail-kept) — a single instruction above a ~30k-token report-laden history got drowned and Haiku replied to the conversation instead of extracting (silent zero-fact runs for weeks). A response with no parseable JSON array (`parseFactsResponse` → `null`, pure helper in `learned-util.ts`) is logged as a distiller failure, distinct from `[]` = "nothing qualified"; every stage logs `distilled/proposed/deduped` counts.
- **Approval is owner-only.** `OWNER_TELEGRAM_ID` is the sole approver. `/teach` by the owner auto-approves; everyone else's input is queued and sent to the owner with inline ✅/✏️/❌ buttons (`callback_data` = `kb:<action>:<id>`, parsed by `parseKbCallback`). If `OWNER_TELEGRAM_ID` is unset, learning degrades gracefully: proposals stay `pending`, `/teach` tells the user no owner is configured.
- **Two-stage dedup.** At propose time a cheap substring check (`isDuplicate`) drops obvious repeats. At **approval** time, `approveLearned()` embeds the fact (needed anyway) and rejects it as a near-duplicate if its cosine similarity to any existing approved fact **of the same category** exceeds `config.kbSemanticDedupThreshold` (default `0.92`). `approveLearned` returns a tagged `ApproveResult` (`approved` | `duplicate` | `not_pending`) — all three call sites in `telegram.ts` handle each case.
- **Consolidation (non-destructive).** `findDuplicateClusters()` flags approved near-duplicate pairs; the daily cron reports them to the owner and `/kbstats` shows counts by category/source/status plus flagged pairs. Nothing is auto-deleted.
- **Precedence: curated wins.** Learned chunks (sentinel `sourceFile: 'learned'`) are retrieved alongside curated ones but labeled `⚠️ unverified`, with a note instructing the model to prefer curated docs on conflict (`retrieveRelevantContext`).
- **Pure helpers** (`parseKbCallback`, `normalizeFact`, `isDuplicate`, `categoryForSource`) live in `src/rag/learned-util.ts` — no DB/network imports, so Tier-1 unit tests cover them with no keys. `cosineSimilarity` is exported from `src/rag/store.ts` and reused for dedup.
- `[learning]` is the log prefix for distillation/approval/consolidation events.

### Lead Pipeline

- **Store:** `leads` SQLite table (`src/leads/index.ts`), UNIQUE on `dedup_key` = `normalizeLeadKey(name, location)` (pure helper in `src/leads/util.ts` — keep it DB-free for unit tests).
- **Write path:** the Lead Generation agent calls the `save_lead` tool once per qualified lead; duplicates are rejected by key and reported back to the model.
- **Read path:** `knownLeadsContext()` is injected via `LeadGenerationAgent.extraContext()` so the agent skips businesses already in the pipeline; `/leads` in Telegram lists the pipeline (flagging entries with no contact) and `/leads <id> <status>` updates status (`new|contacted|responded|converted|dead`).
- **Contact-first output:** phone numbers are the priority (sales works leads via calls/WhatsApp/field visits). The agent presents leads in two tiers — "✅ Ready to contact" (phone found) and "🔎 Needs contact research" — and saves both tiers to the pipeline. It spends at most one extra batched search round hunting phones before answering (interactive queries stay within the normal iteration budget).
- **Enrichment (`/enrich`):** off the interactive path. `listLeadsMissingContact()` (active leads whose contact has no detectable phone number per `hasPhoneNumber()` — the agent often stores an address or an IndiaMART "View Mobile Number" stub, so an empty-column check is not enough; max 8/run) feeds `buildEnrichmentPrompt()` (pure helper in `src/leads/util.ts`); the lead agent researches phone numbers and writes them back via the `update_lead` tool (`updateLeadContact()` — **replaces** `contact`, so the prompt tells the model to merge in the details already known; keeps existing `source_url` unless a new one is given). `update_lead` is only for existing leads listed by id; new leads always go through `save_lead`.
- The weekly report's third section runs the lead agent (`LEADS_QUERY` in `src/scheduler/index.ts`), which dedups against the pipeline automatically; its header shows the funnel counts (`formatFunnel(leadFunnelCounts())` + leads added this week), as does `/leads`.
- **Sales outreach (the pipeline's read-out-loud path):** the Sales & Marketing agent is the B2B outreach + website-SEO copywriter (WhatsApp intros, call scripts, dealer pitches, articles — NOT marketplace/social listings unless explicitly asked). It grounds pitches in the pipeline via `SalesMarketingAgent.extraContext()` → `salesLeadsContext()`.
- **Call sheet** (`/callsheet` + `CALL_SHEET_CRON`, default Monday 08:30 IST to the owner): `listCallReadyLeads()` picks workable leads **with a phone number**, priority `responded > new > contacted` (oldest first within a group); if short, it runs one `/enrich`-style round first. `buildCallSheetPrompt()` (pure, `src/leads/util.ts`) formats the briefing task; a deterministic footer prints the exact `/leads <id> contacted` commands.
- **`/pitch <id>`**: `getLead()` + `buildPitchPrompt()` (pure) → sales agent drafts a ready-to-send WhatsApp intro + 30s call opener for that specific lead.
- **Content engine** (`/article [topic]` + `CONTENT_CRON`, default Wednesday 09:00 IST to the owner): the sales agent writes one seasonal website SEO article grounded in RAG docs (`sendContentDraft()`).

### Routing (Orchestrator)

- Stage 1: `KEYWORD_RULES` in `src/orchestrator/index.ts` — regex matching, no API call.
- Stage 2: Claude Haiku classifier fallback (`max_tokens: 20`, `temperature: 0` for deterministic routing). It receives the session's last-used agent (`getLastAgentUsed()` from `src/db/index.ts`) as a hint so short follow-ups ("more", "contact details for #2") stay with the same specialist instead of falling to `general`.
- Update `KEYWORD_RULES` when adding a new agent.
- Keyword patterns use `/regex/i`. Use `\b` word boundaries for acronyms.
- `AgentType` values are **snake_case strings**: `'market_research'`, `'crop_doctor'` — NOT camelCase.
- The `'general'` type is a no-op fallback — returns a static string, does not call any agent.

### Database

- Use `db.prepare()` for all queries — never template literals with user data.
- New tables require `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- History retrieval controlled by `config.historyTurns`; `getHistory(sessionId, turns?)` accepts an optional per-call override (the scheduler passes `1` for report deltas).
- Rows come back newest-first from DB; `getHistory()` reverses to chronological order.

### Web UI

- **Purpose:** a browser chat + admin dashboard (leads pipeline, KB approval queue, reports, on-demand drafting) so the sales team doesn't need to be in the bot's Telegram chat, and the owner can review KB facts in a browser. **LAN-only for now** — no HTTPS/reverse proxy, no per-user accounts (both deliberate scope calls, not oversights).
- **Auth is two shared passwords, not accounts.** `WEB_OWNER_PASSWORD` and `WEB_TEAM_PASSWORD` map to roles `'owner' | 'member'` (`src/web/auth.ts`). Sessions are a **stateless HMAC-signed cookie** (`WEB_SESSION_SECRET`, 7-day TTL) — no session table. `requireAuth()` gates any logged-in user; `requireOwner()` (used for `/api/kb/*` and `GET /api/reports/kbstats`) mirrors the Telegram `isOwner()` gate.
- **Login is rate-limited.** `src/web/rate-limit.ts`'s `LoginRateLimiter` (pure, injectable clock, no Express dependency) locks a key out after every 5 consecutive failures, doubling the lockout (30s → capped at 15min) each time it relocks; `recordSuccess` clears it. Wired into `login()` keyed on `req.ip` — necessary because a short shared password has no other brute-force defense.
- **Each route file is mounted at its own specific prefix** in `src/web/server.ts` (`/api/chat`, `/api/leads`, `/api/kb`, `/api/reports` — not a shared `/api`), with routes defined relative to that prefix (`/`, `/:id`, …). This is load-bearing, not stylistic: a router's `router.use(requireOwner())` runs for *every* request that reaches that router, and if two routers shared a mount prefix, one router's auth middleware could terminate (401/403) a request actually meant for a sibling router registered after it, before Express ever checked whether a matching route existed. (Caught in testing: `member` requests to `/api/reports/*` were being swallowed by the KB router's `requireOwner()` when both were mounted at `/api`.)
- **`startWebServer(bot)` needs the live Telegram `bot` instance**, not just a fresh Express app — the chat route (`src/web/routes/chat.ts`) calls `distillConversationToKb(bot, sessionId, conversationText)` every 3 turns, same as `bot/telegram.ts`, so the shared KB (see Learned Knowledge above) doesn't have a blind spot for web-originated conversations. In `src/index.ts`, `createBot()` must run before `startWebServer(bot)`.
- **Chat sessions are prefixed `web:<uuid>`** (`src/db/index.ts`'s `conversation_history.session_id` is just `TEXT`, so this is a plain convention, not a schema change) so they can never collide with Telegram's numeric chat ids or the `report:*` synthetic sessions. `GET /api/chat/history` and the `listSessionsByPrefix()`-backed `GET /api/chat/sessions` (sidebar conversation switcher, most-recent-first with a first-message preview via a `ROW_NUMBER()` window query) both refuse/scope to `web:` ids, so the dashboard can't read Telegram chat histories or the archived weekly-report sessions. `DELETE /api/chat/sessions/:id` wraps `clearHistory`. Up to 3 images per diagnosis (`MAX_IMAGES`, matches Telegram's `MAX_PHOTOS_PER_DIAGNOSIS`).
- **Leads and KB have general query functions** (`queryLeads()` in `src/leads/index.ts`, `queryLearned()` in `src/rag/learned.ts`) built alongside the existing `listLeads()`/`listPending()` rather than widening their positional params — the WHERE clause is genuinely dynamic (status/category/source/search, all optional), built as a string but with every value bound as a parameter, never interpolated. Powers the dashboard's search/filter/pagination; `listLeads()`/`listPending()` are untouched, so no existing caller (Telegram, scheduler) is affected.
- **On-demand drafting reuses the cron's own logic.** `sendCallSheet()`/`sendContentDraft()` in `src/scheduler/index.ts` are split into a compute-and-draft half (`draftCallSheet()`, `draftContentArticle(topic?)` — no Telegram send, returns the LLM's text) and a thin Telegram-formatting wrapper around it. `POST /api/reports/callsheet/generate` and `/api/reports/article/generate` call the draft functions directly; the Monday/Wednesday cron behavior is byte-for-byte unchanged. `bot/telegram.ts`'s `/article <topic>` handler also now calls `draftContentArticle(topic)` instead of duplicating the prompt inline.
- **Reports also serve archived data with no LLM call for the always-visible sections.** `GET /api/reports/weekly` reads the same synthetic sessions (`report:market_research`, `report:competitive_analysis`) the Monday cron archives to (invariant #7) via `getHistory(sessionId, 1)`, instead of re-running the analytical agents on every dashboard load; `listCallReadyLeads()`/`getKbStats()`/`findDuplicateClusters()` are likewise cheap reads. Only the explicit "Generate call sheet"/"Generate article" actions trigger a real agent run.
- **Startup must degrade, not crash.** If `WEB_ENABLED=false`, or any of `WEB_OWNER_PASSWORD`/`WEB_TEAM_PASSWORD`/`WEB_SESSION_SECRET` is unset, `startWebServer()` logs a `[web]` warning and returns without starting a server — it must never take the Telegram bot down. The `app.listen()` return value's `'error'` event (e.g. `EADDRINUSE`) is also caught for the same reason (an unhandled `'error'` event on an `http.Server` throws otherwise).
- **Request logging.** A `[web]` request-log middleware in `server.ts` logs method/path/status/duration for every `/api/*` request (skips static asset/SPA-fallback hits).
- **`GET /api/health`** (any authenticated role) returns `{uptimeMs, version}` — `version` is read from `package.json` at startup, `uptimeMs` from a module-level start timestamp. Shown in the sidebar footer.
- **Frontend build lives outside `src/`.** `web/` is a separate Vite + React + TypeScript app with its own `package.json`/`node_modules` (not an npm workspace) — `npm run build` (root) runs `tsc && npm run build:web`, which builds `web/dist`. `src/web/server.ts` serves it via `express.static` + an SPA fallback route; if `web/dist` doesn't exist (frontend never built), the API still comes up, just without the static UI. `npm run dev:web` runs the Vite dev server, which proxies `/api` to `WEB_PORT` so cookies stay same-origin without needing CORS.
- **Design system (`web/src/index.css`)** is derived from Notion's own published palette (`#37352F` text, `#787774` secondary, warm off-white ground) with Urvar's organic green as the accent instead of a generic blue, and a left sidebar layout (Notion's structural signature) instead of top tabs. Semantic status colors (lead/KB status pills) are a distinct hue family from the accent. Everything is CSS custom properties on `:root`, redefined under `@media (prefers-color-scheme: dark)` and `:root[data-theme]` so both the OS preference and an in-app toggle work.
- **Chat markdown rendering is hand-rolled** (`web/src/lib/markdown-lite.tsx`) — emits React nodes directly (bold/italic/code/links/lists/headings), never `dangerouslySetInnerHTML` or an HTML string, so there is no HTML-injection surface regardless of model output; link hrefs are checked against `^https?://` before being rendered as `<a>`, otherwise shown as plain text (blocks `javascript:` URI clicks).
- **Tier-1 tests exist for this module** (`tests/unit/rate-limit.test.ts`, `tests/unit/web-routes.test.ts`) covering everything that doesn't call a real LLM/embedding API — auth (login/logout/me/role-gating), leads CRUD, KB browse+reject, reports read paths. KB approve, chat, and the on-demand generate endpoints are excluded (they call Anthropic/Voyage). **`tests/setup.ts` force-overrides `SQLITE_DB_PATH` to a fresh temp file for the whole test run** (not `??=` — unlike the API-key placeholders, this must win even over a real `.env` value), so these route tests can never touch the real database.

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
- Directories: lowercase — `agents/`, `tools/`, `db/`, `leads/`
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
| `[learning]` | Auto-learning KB — distillation + approval events |
| `[scheduler]` | Cron job events |
| `[bot]` | Telegram handler errors |
| `[fatal]` | Uncaught errors in `main()` |
| `[shutdown]` | SIGINT/SIGTERM handlers |

---

## Common Commands

```bash
npm run dev        # tsx watch src/index.ts — hot reload (Telegram bot + web API)
npm run dev:web    # Vite dev server for web/ (proxies /api to WEB_PORT) — run alongside npm run dev
npm run build      # tsc && npm run build:web — compiles to dist/ and web/dist
npm run build:web  # cd web && npm run build — frontend only
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

- **`npm test`** — Tier 1 deterministic unit tests (`tests/unit/`). **No API keys, no cost, no network.** Covers the pure logic: `splitMessage`/`formatUptime`, `chunkMarkdown`, `hashDocs`/`search` (incl. the `minScore` floor and `learnedCategory` filtering), `cosineSimilarity`, `formatSearchResponse` (incl. raw-content truncation), `buildRetrievalQuery`, `currentDateLine`, `routeByKeyword`, `isRetryable`, `normalizeLeadKey`/`isLeadStatus`, `categoryForSource`, `sendMarkdownSafe` (fake bot), `LoginRateLimiter` (`rate-limit.test.ts`), and route-level coverage for the web dashboard's non-LLM endpoints (`web-routes.test.ts`: auth, leads CRUD, KB browse/reject, reports read paths — spins up a real Express app + `node:sqlite` against an isolated temp DB, asserting over real HTTP via `fetch`). This is the regression backbone — run it before every commit.
- **`npm run test:integration`** — Tier 2 live-API smoke tests (`tests/integration/`). Opt-in only (gated on `RUN_INTEGRATION`, set automatically by the script); needs a real `.env`; makes paid calls. Asserts structural invariants (routing, non-empty grounded response, RAG returns knowledge), not exact text. **Still never mocks the Anthropic SDK** — the value is live behaviour.
- **`npm run test:eval`** — Tier 3 manual A/B runner (`tests/eval/run.ts`, no assertions). Prints responses + token/cache/iteration stats for representative prompts to compare answer quality before/after a change. Needs a real `.env`.
- **Env preload:** `tests/setup.ts` (loaded via `--import`) runs `dotenv/config` then fills only *missing* required env vars with placeholders (`??=`). This lets unit tests import modules whose `config.ts` validates env at load time, without real keys; real keys (when a `.env` exists) are never overwritten, so integration/eval still hit live APIs. **`SQLITE_DB_PATH` is the one exception — force-overridden (plain `=`, not `??=`) to a fresh `mkdtempSync` temp file for the whole run**, so any test that imports `src/db/index.ts` (directly or transitively, e.g. `src/leads/index.ts`, `src/rag/learned.ts`) can never open the real production database, even if a developer's `.env` happens to set that var.
- **Type-checking & build:** tests live outside `rootDir: src`, so `npm run build` never emits them to `dist/`. The base `npm run typecheck` covers `src/` only; **`npm run typecheck:test`** (`tsconfig.test.json`) type-checks `src/` + `tests/` together.
- **Two source symbols are exported solely for testing** (additive, non-breaking): `routeByKeyword` (`src/orchestrator/index.ts`) and `isRetryable` (`src/agents/base.ts`).
- Health checks in `src/index.ts` (SQLite ping, Anthropic API ping, Tavily ping, Voyage AI ping) remain the primary startup smoke tests.

---

## Key Invariants — Never Break These

1. **RAG index loaded once.** `initVectorStore()` runs at startup, loads `data/rag-index.json` into memory, and rebuilds only if the docs hash changed. Never call Voyage AI per-request for indexing.

2. **Agents instantiated once.** All singletons are created at module load in `src/orchestrator/index.ts`. `SYSTEM_BLOCKS` (instructions only) are built once and cached in memory.

3. **Prompt cache control is mandatory.** The dynamically-built knowledge block in `BaseAgent.runAgenticLoop()` and the instructions block in every agent's `SYSTEM_BLOCKS` MUST have `cache_control: { type: 'ephemeral' }`. Removing this breaks Anthropic prompt caching and increases cost.

4. **Learning is non-blocking.** The `void distillConversationToKb(...)` call in `src/bot/telegram.ts` (the single learning call on the response path, every 3 turns) must remain `void`-prefixed and must never block or throw on the response path. (The old per-session `extractAndSaveMemories`/`agent_memory` path was retired — the shared KB is the only memory now.)

5. **One `splitMessage()`.** The only copy lives in `src/utils/message.ts`; the scheduler imports it from there. Do not re-introduce a local duplicate.

6. **Typing indicator at 4s.** Telegram clears the typing indicator after 5s. The `setInterval` at 4000ms in `src/bot/telegram.ts` is intentional.

7. **Weekly report uses Promise.allSettled.** In `src/scheduler/index.ts` (market + competitive + leads) — do not change to `Promise.all`. A single agent failure must not abort the full report. Per-agent timeout comes from `config.reportAgentTimeoutMs` (default 360s — 240s proved too tight in production for the thinking-enabled agents). Successful market/competitive sections are archived under synthetic sessions (`report:market_research`, `report:competitive_analysis`) and last week's exchange is passed back as history so the agents report week-over-week deltas.

8. **Model assignment by cost.** Claude Haiku for cheap tasks (routing, memory extraction). `config.claudeModel` (Sonnet) for all main agent responses.

9. **RAG files are mapped.** Every file in `/RAG/docs/` that should be indexed must be listed in `DOC_FILES` in `src/rag/index.ts`. Renaming a doc file without updating this array silently drops it from the index.

10. **ecosystem.config.cjs stays CJS.** PM2 cannot load ESM config files. This file must remain `.cjs` with `module.exports =` syntax.

11. **`RAG/docs/learned.md` is NOT in `DOC_FILES`.** It is a human-readable mirror of approved learned facts. The live store is the `learned_knowledge` table; learned chunks augment the in-memory index only and are never written to `rag-index.json`. Adding learned.md to `DOC_FILES` would force a full curated re-embed on every restart — do not.

12. **Learned knowledge requires owner approval.** Every candidate fact (from `/teach`, conversation/web/periodic distillation) is stored `pending` and only influences answers after the `OWNER_TELEGRAM_ID` user approves it. Never auto-approve non-owner input. The conversation distiller (`void distillConversationToKb(...)`) must stay `void`-prefixed and non-blocking (#4). Semantic dedup at approval and the consolidation report are advisory; they must never delete an approved fact automatically.

13. **Agent-generated replies go through `sendMarkdownSafe()`.** Agent output contains unpredictable `_`/`*` (URLs, business names) that 400s Telegram's Markdown parser. `sendMarkdownSafe()` (`src/utils/message.ts`) retries as plain text on an entity-parse error — never call `bot.sendMessage(..., { parse_mode: 'Markdown' })` directly with agent-generated text. (Static, known-good strings like /start and /help are fine.)

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
REPORT_AGENT_TIMEOUT_MS=360000      # per-agent wall-clock budget in the weekly report
OWNER_TELEGRAM_ID=                  # unset = auto-learning degrades; proposals stay pending, no approval routing
KB_LEARNING_ENABLED=true            # false disables /teach + all distillation
KB_DISTILL_CRON=0 8 * * *           # periodic distillation schedule (IST)
KB_SEMANTIC_DEDUP_THRESHOLD=0.92    # cosine ceiling; approvals above it are auto-rejected as near-duplicates
CALL_SHEET_CRON=30 8 * * 1          # prioritized calling list to the owner (IST); skipped if OWNER_TELEGRAM_ID unset
CONTENT_CRON=0 9 * * 3              # weekly website SEO article draft to the owner (IST); skipped if OWNER_TELEGRAM_ID unset

# Web UI (LAN-only, shared-password auth — see Web UI section above)
WEB_ENABLED=true                    # false = skip starting the web server entirely
WEB_PORT=3001
WEB_OWNER_PASSWORD=                 # unset = web server logs a warning and doesn't start
WEB_TEAM_PASSWORD=                  # unset = web server logs a warning and doesn't start
WEB_SESSION_SECRET=                 # unset = web server logs a warning and doesn't start; HMAC key for session cookies
```

---

## Adding a New Agent — Checklist

1. Create `src/agents/[name].ts` — extend `BaseAgent`, export class + singleton, define `SYSTEM_BLOCKS` as a **single-element array** (instructions block only, with `cache_control: ephemeral`). RAG context is injected automatically by `BaseAgent.run()`.
2. Add agent type to `AgentType` union in `src/orchestrator/index.ts`.
3. Instantiate singleton in the `agents` map in `src/orchestrator/index.ts`.
4. Add `KEYWORD_RULES` patterns in `src/orchestrator/index.ts`.
5. Add an `AGENT_LABELS` entry in `src/bot/telegram.ts`.
6. If the agent needs domain-specific docs not already in `RAG/docs/`: add the file there and list it in `DOC_FILES` in `src/rag/index.ts`.
