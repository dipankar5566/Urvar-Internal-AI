# Update Knowledge Base

Use this command when the user wants to update the knowledge base (RAG docs) that all agents use for product, market, and agronomic knowledge.

## How the RAG System Works

Knowledge lives in `RAG/docs/*.md` as markdown files. At startup:
1. Bot reads all 7 docs listed in `src/rag/index.ts:DOC_FILES`
2. Computes SHA-256 hash of all doc content
3. If hash matches `data/rag-index.json:docsHash` → skips rebuild (uses cached index)
4. If hash differs → calls Voyage AI to re-embed all chunks → writes new `data/rag-index.json`

At query time, the top-K most relevant chunks are retrieved via cosine similarity and prepended to the agent's context.

## Updating Existing Docs

1. Edit the relevant file in `RAG/docs/`:
   - `products.md` — product catalogue, dosages, applications
   - `market-guide.md` — market segments, distribution, pricing
   - `crop-guide.md` — crop-specific recommendations
   - `disease-guide.md` — disease/pest diagnosis and treatment
   - `sales-playbook.md` — sales scripts, objection handling
   - `competitor-intel.md` — competitor analysis data
   - `urvar-summary.md` — company overview, vision, values

2. Restart the bot to trigger reindex:
   ```bash
   pm2 restart urvar-ai
   ```

3. Verify the index rebuilt:
   ```bash
   pm2 logs urvar-ai --lines 20 | grep '\[rag\]'
   ```
   You should see:
   ```
   [rag] Building vector index…
   [rag] Index built: XX chunks.
   ```

## Adding a New Doc

1. Create the file in `RAG/docs/<new-file>.md`

2. Add the filename to `DOC_FILES` in `src/rag/index.ts`:
   ```typescript
   const DOC_FILES = [
     'products.md',
     'market-guide.md',
     // ... existing files ...
     'new-file.md',   // ADD HERE
   ];
   ```

3. Compile and restart:
   ```bash
   npm run build
   pm2 restart urvar-ai
   ```

## Removing a Doc

1. Remove the filename from `DOC_FILES` in `src/rag/index.ts`
2. Optionally delete the file from `RAG/docs/`
3. `npm run build && pm2 restart urvar-ai`

## Markdown Structure Tips

The chunker (`src/rag/chunker.ts`) splits docs at `##` headers:
- Use `##` for major sections (one chunk each)
- Use `###` for sub-sections within a chunk (auto-split if section > 4000 chars)
- Keep each `##` section focused on one topic for better retrieval precision
- Sections < 100 chars are merged into the next chunk

**Good structure:**
```markdown
# Products Overview

## Enriched Vermicompost
5 kg bags. Use for all crops as basal application...
Recommended dosage: 100g per plant...

## Cow Dung Manure / FYM
...
```

**Poor structure (too granular):**
```markdown
## Price
₹120 per bag

## Weight
5 kg
```
Small fragments like these will be merged, but they dilute retrieval quality.

## Force a Full Reindex Without Editing Docs

```bash
rm data/rag-index.json
pm2 restart urvar-ai
```

## Testing Retrieval Quality

```bash
node -e "
import('./dist/rag/index.js').then(async ({ initVectorStore, retrieveRelevantContext }) => {
  await initVectorStore();
  const result = await retrieveRelevantContext('your test query here');
  console.log(result);
});
"
```

If the returned chunks are not relevant to the query, check:
- Section headers are descriptive (not generic like `## Section 1`)
- Content under each `##` is focused on one topic
- The most relevant information is in `RAG/docs/` (not buried in comments or formatting)
