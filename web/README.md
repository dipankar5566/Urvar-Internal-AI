# Urvar Dashboard (web UI)

React + Vite + TypeScript SPA for the Urvar AI Assistant's browser dashboard — chat with the specialist agents, manage the B2B leads pipeline, review weekly reports, and (owner only) approve the auto-learned knowledge base. Talks to the Express API in `../src/web/`.

See the root [`CLAUDE.md`](../CLAUDE.md#web-ui) for the full architecture (auth model, routing, design system).

## Development

```bash
npm install
npm run dev     # Vite dev server, proxies /api to the backend (WEB_PORT, default 3001)
npm run build   # outputs to dist/, served by the Express server in production
```

Run the backend separately from the repo root (`npm run dev`) so `/api` has something to proxy to.
