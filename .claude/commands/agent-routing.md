# Agent Routing Reference

Use this command to understand how user messages are routed to specialist agents in the Urvar AI Assistant v2.0.

## Two-Stage Routing Pipeline

All routing logic lives in `src/orchestrator/index.ts`.

### Stage 1: Keyword Regex (Zero API Cost)

`KEYWORD_RULES` array at `src/orchestrator/index.ts:38`. Tested in order — **first match wins**.

| Agent | Example Trigger Patterns |
|-------|--------------------------|
| `market_research` | "market size", "consumer insight", "pricing strategy", "distribution channel", "kharif demand", "target audience" |
| `competitive_analysis` | "competitor", "SWOT", "IFFCO", "Coromandel", "how does Urvar compare", "market leader" |
| `rd_product_development` | "new product", "R&D", "formulation", "NPOP certification", "nano fertilizer", "mycorrhiza", "packaging innovation" |
| `sales_marketing` | "write a post", "Amazon listing", "Instagram caption", "WhatsApp message", "marketing campaign", "brand voice" |
| `lead_generation` | "find distributors", "IndiaMART leads", "FPO", "B2B prospect", "outreach email for dealer" |
| `crop_doctor` | "yellow leaves", "crop disease", "nutrient deficiency", "diagnose", "what's wrong with my plant" |

### Stage 2: Claude Haiku Classifier (Fallback)

Called only when no keyword pattern matches. Uses `claude-haiku-4-5-20251001`. Costs ~$0.0001 per routing decision. Adds ~300ms latency.

Defined at `src/orchestrator/index.ts:96`. Classifies into the same 7 types plus `general`.

### `general` Responses

When the classifier returns `general` (greetings, off-topic, ambiguous), the orchestrator returns a static fallback message — no agent API call is made.

## Routing Decision Flow

```
User message
    │
    ▼
KEYWORD_RULES (38 patterns, O(n) scan)
    │
    ├─ Match found → agent selected (no API call)
    │
    └─ No match → Haiku classifier
                    │
                    └─ Returns: market_research | competitive_analysis |
                                rd_product_development | sales_marketing |
                                lead_generation | crop_doctor | general
```

## Common Routing Issues

**Message goes to wrong agent:**
- Check if a higher-priority keyword rule is matching first (rules are tested top-to-bottom)
- Add a more specific pattern earlier in `KEYWORD_RULES`
- Or add a disambiguating keyword to the Haiku prompt

**All messages hit Stage 2 (slow routing):**
- Your message type has no keyword coverage
- Add patterns to `KEYWORD_RULES` for common phrasings

**Haiku returns `general` for a valid query:**
- The query is genuinely ambiguous — this is expected behaviour
- User should rephrase to include a domain keyword (e.g., "diagnose" → Stage 1 → `crop_doctor`)

## Adding/Modifying Routes

To add keyword rules:
```typescript
// src/orchestrator/index.ts — inside KEYWORD_RULES
{ pattern: /your_new_pattern/i, agent: 'target_agent' },
```

To adjust Haiku classification, edit the category list in `routeByClaude()` at `src/orchestrator/index.ts:102`.

## Monitoring Which Agent Was Used

Every response includes `agentUsed` in the `OrchestratorResult`. The Telegram bot logs this — check with:
```bash
pm2 logs urvar-ai | grep 'agentUsed\|routing'
```
