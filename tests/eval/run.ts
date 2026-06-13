// Manual quality / A-B runner — NOT part of the automated suite (no assertions).
// Fires representative prompts through the live orchestrator and prints the
// response plus token/cache/iteration stats so answer quality can be compared
// before/after a change. Operationalizes CLAUDE.md's "Functional A/B" note.
//
// Usage: npm run test:eval   (requires a real .env — makes live API calls)
import { initVectorStore } from '../../src/rag/index.js';
import { runOrchestrator } from '../../src/orchestrator/index.js';

const PROMPTS: string[] = [
  'What is the market size and growth rate for bio-fertilizers in India?',
  'Give me a SWOT analysis of Urvar against IFFCO and Coromandel.',
  'My paddy leaves have yellow streaks. What is wrong and which Urvar product helps?',
];

async function main(): Promise<void> {
  console.log('[eval] Initializing vector store…');
  await initVectorStore();

  for (const prompt of PROMPTS) {
    console.log('\n' + '='.repeat(80));
    console.log(`PROMPT: ${prompt}`);
    console.log('='.repeat(80));
    const t0 = Date.now();
    const r = await runOrchestrator(prompt, []);
    const ms = Date.now() - t0;
    console.log(
      `[agent=${r.agentUsed}] iterations=${r.iterations} ` +
        `tokensIn=${r.tokensIn} tokensOut=${r.tokensOut} ` +
        `cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite} ${ms}ms\n`,
    );
    console.log(r.response);
  }
}

main().catch((err) => {
  console.error('[eval] failed:', err);
  process.exit(1);
});
