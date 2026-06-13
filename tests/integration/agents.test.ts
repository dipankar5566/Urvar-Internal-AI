// Live-API smoke tests. Opt-in only — gated on RUN_INTEGRATION so `npm test`
// never triggers paid calls. Per CLAUDE.md we never mock the Anthropic SDK; the
// value is in live behaviour. Assertions check structural invariants, not exact
// text (LLM output is non-deterministic).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runOrchestrator } from '../../src/orchestrator/index.js';
import { initVectorStore, retrieveRelevantContext } from '../../src/rag/index.js';

const skip = !process.env['RUN_INTEGRATION'];

before(async () => {
  if (skip) return;
  await initVectorStore();
});

test('orchestrator routes a market question and returns a grounded answer', { skip }, async () => {
  const result = await runOrchestrator(
    'What is the market size for bio-fertilizers in India?',
    [],
  );
  assert.equal(result.agentUsed, 'market_research');
  assert.ok(result.response.trim().length > 0, 'response should be non-empty');
  assert.ok(result.iterations >= 1);
  assert.ok(result.tokensIn > 0);
});

test('RAG retrieval returns Urvar knowledge for an on-topic query', { skip }, async () => {
  const context = await retrieveRelevantContext('Urvar product pricing');
  assert.ok(context.includes('# Relevant Urvar Knowledge'));
});

test('orchestrator handles a general/greeting message without crashing', { skip }, async () => {
  const result = await runOrchestrator('hi there', []);
  assert.ok(result.response.trim().length > 0);
});
