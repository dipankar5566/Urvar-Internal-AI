# Debug Bot

Use this command when the user reports an issue with the Urvar AI Assistant v2.0. Work through these checks systematically.

## 1. Check PM2 Status

```bash
pm2 status
pm2 logs urvar-ai --lines 100
pm2 logs urvar-ai --err --lines 50
```

## 2. TypeScript Build Errors

If the bot won't start after a code change:
```bash
npm run typecheck   # find type errors without emitting
npm run build       # compile TypeScript → dist/
```

All source is in `src/`. Compiled output goes to `dist/`. PM2 runs `dist/index.js`.

## 3. Startup Health Check Failures

The bot runs health checks in `src/index.ts:main()`. If startup fails, the log shows which check failed:

| Log message | Cause | Fix |
|-------------|-------|-----|
| `SQLite` error | `data/urvar.db` missing or corrupt | Delete and restart (DB is auto-created) |
| `Anthropic API` error | `ANTHROPIC_API_KEY` wrong or quota exceeded | Check `.env`, verify key at console.anthropic.com |
| `Tavily API` error | `TAVILY_API_KEY` wrong | Check `.env` |
| `Voyage AI` error | `VOYAGE_API_KEY` wrong | Check `.env`, verify key at dash.voyageai.com |
| `[rag]` error at startup | `RAG/docs/` files missing or Voyage API issue | Check docs exist, check VOYAGE_API_KEY |

## 4. RAG / Vector Store Issues

**Index not building:**
```bash
ls -la data/rag-index.json          # should exist after first run
ls RAG/docs/                         # all 7 .md files should be present
```

**Force a full reindex** (delete the cached index):
```bash
rm data/rag-index.json
pm2 restart urvar-ai
```
The bot will rebuild the index on next startup. Look for:
```
[rag] Building vector index…
[rag] Index built: XX chunks.
```

**Retrieve a specific topic to test RAG:**
```bash
node -e "
import('./dist/rag/index.js').then(async ({ retrieveRelevantContext }) => {
  const ctx = await retrieveRelevantContext('yellow leaves tomato');
  console.log(ctx.slice(0, 500));
});
"
```

## 5. Agent / Routing Issues

**Wrong agent selected:**
- Check `src/orchestrator/index.ts:38` keyword rules — first match wins
- Run `/agent-routing` for full routing reference

**Agent not responding / hanging:**
- Check Anthropic API status at status.anthropic.com
- Check token limits — each agent loop has `max_iterations = 10` in `src/agents/base.ts`

**Agent tool call failing (web_search):**
- Tavily key expired or quota exceeded
- Check `src/tools/web-search.ts` — uses `TAVILY_API_KEY` from config

## 6. Telegram Bot Issues

**Bot not receiving messages:**
- Polling mode — the bot keeps an open connection. If it crashes, polling stops.
- `pm2 restart urvar-ai` to restore

**Message truncated:**
- Telegram limit is 4096 chars. Bot truncates in `src/bot/telegram.ts`
- If content is legitimately long, check the chunk size logic there

**Image analysis not working (crop doctor):**
- Verify the user sent a photo, not a file/document
- Check `src/agents/crop-doctor.ts:runWithImage()` — requires `ANTHROPIC_API_KEY` with vision access

## 7. Environment Variables

```bash
cat .env | grep -v '^#' | grep '='   # list all set vars (values visible — avoid on shared screens)
```

Required vars (bot exits with error if missing):
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TAVILY_API_KEY`
- `VOYAGE_API_KEY`

Optional:
- `RAG_TOP_K` (default: 5)
- `RAG_INDEX_PATH` (default: `./data/rag-index.json`)

## 8. Common Code Locations

| Issue | File | Line |
|-------|------|------|
| Startup / health check | `src/index.ts` | L11–35 |
| RAG retrieval | `src/rag/index.ts` | — |
| Cosine similarity search | `src/rag/store.ts` | — |
| Keyword routing rules | `src/orchestrator/index.ts` | L38 |
| Haiku classifier | `src/orchestrator/index.ts` | L96 |
| Telegram message handling | `src/bot/telegram.ts` | — |
| Base agent loop | `src/agents/base.ts` | — |
| Web search tool | `src/tools/web-search.ts` | — |
