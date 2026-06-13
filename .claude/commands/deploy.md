# Deploy

Use this command when deploying or redeploying the Urvar AI Assistant v2.0 to the server.

## Pre-flight Checklist

### 1. Verify environment variables
```bash
grep -E '^(ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|TAVILY_API_KEY|VOYAGE_API_KEY)=' .env
```
All four must be set. Bot exits immediately at startup if any are missing.

### 2. Install / update dependencies
```bash
npm ci             # clean install from package-lock.json
```

### 3. Compile TypeScript
```bash
npm run build      # outputs to dist/
npm run typecheck  # optional but recommended before deploy
```
The `dist/` directory must exist before PM2 can start the bot.

### 4. Check RAG docs
```bash
ls RAG/docs/       # all 7 .md files should be present
```
Missing docs won't block startup but will reduce RAG coverage.

## Deploy Commands

### First-time setup
```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

### Redeploy after code changes
```bash
npm ci
npm run build
pm2 restart urvar-ai
```

### Redeploy after env changes only
```bash
pm2 restart urvar-ai   # PM2 re-reads .env on restart
```

## Post-deploy Verification

```bash
pm2 status
pm2 logs urvar-ai --lines 50
```

Expected startup sequence in logs:
```
[startup] Urvar AI Assistant v2.0 starting…
[rag] Index is current. Skipping re-indexing.   ← or [rag] Building vector index… on first run
[startup] SQLite OK
[startup] Anthropic API OK
[startup] Tavily API OK
[startup] Voyage AI OK
[startup] All health checks passed.
[startup] Bot is running. Press Ctrl+C to stop.
```

If the RAG index does not exist yet, the first deploy will call the Voyage AI API to build it (~60-80 chunk embeddings). This takes 5-10 seconds and costs < $0.01. Subsequent restarts skip this step via SHA-256 hash check.

## PM2 Configuration

`ecosystem.config.cjs` (must remain CJS — `.cjs` extension):
- Entry: `dist/index.js`
- Interpreter: `node`
- Watch: disabled (manual restart after deploy)
- Env file: `.env`

## Rollback

```bash
git stash                  # or git checkout <previous-commit>
npm run build
pm2 restart urvar-ai
```

## Environment Variables Reference

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `TELEGRAM_BOT_TOKEN` | Yes | — | BotFather token |
| `TAVILY_API_KEY` | Yes | — | Web search API |
| `VOYAGE_API_KEY` | Yes | — | Embedding API (Voyage AI) |
| `RAG_TOP_K` | No | `5` | Chunks retrieved per query |
| `RAG_INDEX_PATH` | No | `./data/rag-index.json` | Vector index file path |
