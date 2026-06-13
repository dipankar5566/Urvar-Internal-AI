import { BaseAgent, type AgentRunResult } from './base.js';
import { webSearch, webSearchToolDefinition } from '../tools/web-search.js';
import { optimizeImage } from '../tools/image-optimizer.js';
import { classifyCropImage } from '../tools/crop-classifier.js';
import { retrieveRelevantContext } from '../rag/index.js';
import type { MessageParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.js';

const SYSTEM_BLOCKS = [
  {
    type: 'text' as const,
    text: `You are an expert Crop Doctor for Urvar Natural Pvt. Ltd., with 20 years of field experience in Indian agriculture. You diagnose crop diseases, pest damage, nutrient deficiencies, and soil problems — and recommend treatment using Urvar products.

**Diagnostic workflow:**
1. Identify the crop species (ask if unclear from the image or description)
2. Analyze visible symptoms: leaf patterns, stem condition, root signs, color changes, spots, wilting
3. Determine if the issue is: fungal / bacterial / viral / pest / nutrient deficiency / abiotic stress
4. For nutrient deficiencies: distinguish mobile (N, P, K, Mg — symptoms on old leaves first) vs immobile (Ca, B, Fe, Zn — symptoms on new leaves first)
5. Search Indian agricultural databases (ICAR, KVK, NBSS&LUP) to confirm diagnosis
6. Recommend specific Urvar products with dosage, application method, and timing

**Product recommendations must come ONLY from Urvar's catalogue:**
- Enriched Vermicompost (5 kg) — soil health, organic matter, all crops
- Cow Dung Manure/FYM (5 kg) — basal application, soil amendment
- PROM (50 kg) — phosphorus-rich organic, legumes and field crops
- PROM Humic Based Flowering Booster (250 ml) — fruit and flower set
- PROM Humic Enriched (5 kg) — humic acid + phosphorus, all stages
- Humic Acid Liquid Bio-Stimulant (1 L) — stress recovery, root development
- Zinc EDTA 12% (250 g) — zinc deficiency, paddy, maize, vegetables
- Boron EDTA (250 g) — boron deficiency, flowering crops, oilseeds

**Response format:**
🌿 **Diagnosis:** [disease/deficiency name] — Confidence: [High/Medium/Low]
🔍 **Symptoms observed:** [what you see]
⚠️ **Cause:** [pathogen, pest, or nutrient]
💊 **Treatment with Urvar Products:**
  - [Product]: [dosage and method]
🌱 **Prevention tips:** [cultural practices]
📞 **When to seek further help:** [if symptoms worsen or diagnosis is uncertain]

If the image is unclear or the crop is unidentifiable, ask a specific follow-up question.
Never recommend chemical pesticides — Urvar is an organic bio-fertilizer brand.`,
    cache_control: { type: 'ephemeral' as const },
  },
];

export class CropDoctorAgent extends BaseAgent {
  constructor() {
    super(SYSTEM_BLOCKS, [webSearchToolDefinition]);
  }

  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'web_search') {
      const results = await webSearch(
        input['query'] as string,
        (input['max_results'] as number) ?? 5,
        'advanced',
      );
      if (results.length === 0) return 'No search results found.';
      return results
        .map((r) => `**${r.title}**\n${r.url}\n${r.content}`)
        .join('\n\n---\n\n');
    }
    return `Unknown tool: ${name}`;
  }

  async runWithImage(
    caption: string,
    imageBase64: string,
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
    history: MessageParam[],
  ): Promise<AgentRunResult> {
    // Run image optimization and ML classification in parallel (both gracefully degrade)
    const [variants, classification] = await Promise.all([
      optimizeImage(imageBase64, mediaType),
      classifyCropImage(imageBase64),
    ]);

    // Use the denoised variant as the primary image if available
    const primary = variants.find((v) => v.label === 'denoised') ?? variants[0]!;

    // Build classification hint for Claude if the ML model was available
    let classificationHint = '';
    if (classification.available && classification.topConfidence > 0.4) {
      classificationHint =
        `\n\n[ML pre-classification: "${classification.topLabel}" ` +
        `(${Math.round(classification.topConfidence * 100)}% confidence). ` +
        `Other candidates: ${classification.top3
          .slice(1)
          .map((p) => `${p.label} (${Math.round(p.confidence * 100)}%)`)
          .join(', ')}. Use this as a starting hypothesis, not a definitive answer.]`;
    }

    const imageBlock: ImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: primary.mediaType,
        data: primary.base64,
      },
    };

    const promptText =
      (caption || 'Please diagnose the crop issue shown in this photo and recommend Urvar products for treatment.') +
      classificationHint;

    const textBlock: TextBlockParam = {
      type: 'text',
      text: promptText,
    };

    const context = await retrieveRelevantContext(promptText);

    const messages: MessageParam[] = [
      ...history,
      { role: 'user', content: [imageBlock, textBlock] },
    ];

    return this.runAgenticLoop(messages, context);
  }

  // Text-only fallback (user describes symptoms without a photo)
  async run(userMessage: string, history: MessageParam[]): Promise<AgentRunResult> {
    return super.run(userMessage, history);
  }
}

// Singleton — system prompt blocks are built once at startup
export const cropDoctorAgent = new CropDoctorAgent();

// Helper: download a Telegram photo and return base64 + mediaType
export async function fetchTelegramImage(
  fileUrl: string,
): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(fileUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const mediaType = contentType.includes('png')
      ? 'image/png'
      : contentType.includes('webp')
        ? 'image/webp'
        : 'image/jpeg';

    return { base64, mediaType };
  } finally {
    clearTimeout(timeout);
  }
}
