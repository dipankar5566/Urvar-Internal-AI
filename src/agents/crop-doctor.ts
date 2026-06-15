import { BaseAgent, buildRetrievalQuery, type AgentRunResult } from './base.js';
import { webSearch, webSearchToolDefinition, formatSearchResponse } from '../tools/web-search.js';
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

**Multiple inputs:** You may receive up to 3 photos of the SAME plant, each shown in several processed variants (denoised, saturation-boosted, grayscale). Treat them together as one case and produce a SINGLE diagnosis — never diagnose each photo or variant separately.

**Product recommendations must come ONLY from Urvar's catalogue:**
- Enriched Vermicompost (5 kg) — soil health, organic matter, all crops
- Cow Dung Manure/FYM (5 kg) — basal application, soil amendment
- PROM (50 kg) — phosphorus-rich organic, legumes and field crops
- PROM Humic Based Flowering Booster (250 ml) — fruit and flower set
- PROM Humic Enriched (5 kg) — humic acid + phosphorus, all stages
- Humic Acid Liquid Bio-Stimulant (1 L) — stress recovery, root development
- Zinc EDTA 12% (250 g) — zinc deficiency, paddy, maize, vegetables
- Boron EDTA (250 g) — boron deficiency, flowering crops, oilseeds

This catalogue is your INTERNAL reference for selecting treatments. Recommend only the 1–4 products relevant to the specific diagnosis. **Never reproduce the full catalogue, a "Complete Product Range" / "Product Range" table, or products unrelated to the diagnosis.** Diagnose only what is visible in the current image or description — ignore any unrelated product, pricing, or catalogue requests from earlier in this conversation, even if the retrieved knowledge or prior turns list the full product range.

**Response format:**
🌿 **Diagnosis:** [disease/deficiency name] — Confidence: [High/Medium/Low]
🔍 **Symptoms observed:** [what you see]
⚠️ **Cause:** [pathogen, pest, or nutrient]
💊 **Treatment with Urvar Products:**
  - [Product]: [dosage and method]
🌱 **Prevention tips:** [cultural practices]
📞 **When to seek further help:** [if symptoms worsen or diagnosis is uncertain]

If the image is unclear or the crop is unidentifiable, ask a specific follow-up question.
Never recommend chemical pesticides — Urvar is an organic bio-fertilizer brand.
Grounding: recommend only products from the catalogue above. Never invent product names, dosages, or figures not grounded in the catalogue or search results — if the diagnosis is uncertain, state Low confidence and ask for clarification.`,
    cache_control: { type: 'ephemeral' as const },
  },
];

export class CropDoctorAgent extends BaseAgent {
  constructor() {
    super(SYSTEM_BLOCKS, [webSearchToolDefinition], { temperature: 0.3 });
  }

  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'web_search') {
      const response = await webSearch(
        input['query'] as string,
        (input['max_results'] as number) ?? 5,
        'advanced',
      );
      return formatSearchResponse(response);
    }
    return `Unknown tool: ${name}`;
  }

  // Diagnose up to a few photos of the SAME plant as one case. Every photo is run
  // through the Sharp optimizer and ALL variants of ALL photos are sent to Claude
  // in a single multi-image call (the model synthesizes one diagnosis).
  async runWithImages(
    caption: string,
    images: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }>,
    history: MessageParam[],
  ): Promise<AgentRunResult> {
    // Optimize + ML-classify every image in parallel (both gracefully degrade).
    const processed = await Promise.all(
      images.map(async (img) => {
        const [variants, classification] = await Promise.all([
          optimizeImage(img.base64, img.mediaType),
          classifyCropImage(img.base64),
        ]);
        return { variants, classification };
      }),
    );

    // Visibility: how many Sharp variants per image (1 = Sharp unavailable, 3 = on)
    // and the CNN classifier result per image (or unavailable).
    const variantCount = processed[0]?.variants.length ?? 0;
    const mlSummary = processed
      .map((p, i) =>
        p.classification.available
          ? `#${i + 1} ${p.classification.topLabel} ${Math.round(p.classification.topConfidence * 100)}%`
          : `#${i + 1} ml-unavailable`,
      )
      .join(', ');
    console.log(`[crop-doctor] ${images.length} img × ${variantCount} Sharp variant(s); CNN: ${mlSummary}`);

    // Interleave a label + image block for every variant of every photo, so the
    // model knows which variants belong to which photo of the same plant.
    const content: Array<TextBlockParam | ImageBlockParam> = [];
    processed.forEach(({ variants }, i) => {
      for (const v of variants) {
        content.push({ type: 'text', text: `Photo ${i + 1} — ${v.label}:` });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: v.mediaType, data: v.base64 },
        });
      }
    });

    // Confident ML hints only — starting hypotheses, not definitive.
    const hints = processed
      .map(({ classification }, i) =>
        classification.available && classification.topConfidence > 0.4
          ? `Photo ${i + 1}: "${classification.topLabel}" (${Math.round(classification.topConfidence * 100)}%)`
          : null,
      )
      .filter((h): h is string => h !== null);
    const hintText = hints.length
      ? `\n\n[ML pre-classification (starting hypotheses, not definitive): ${hints.join('; ')}]`
      : '';

    const plantNote =
      images.length === 1
        ? 'The photo above is shown in multiple processed variants (denoised, saturation-boosted, grayscale) of the same image — produce ONE diagnosis.'
        : `The ${images.length} photos above are of the SAME plant, each shown in multiple processed variants (denoised, saturation-boosted, grayscale). Synthesize them into ONE diagnosis.`;

    const promptText =
      (caption || 'Diagnose the crop issue shown and recommend Urvar products for treatment.') +
      `\n\n${plantNote}` +
      hintText;
    content.push({ type: 'text', text: promptText });

    const context = await retrieveRelevantContext(buildRetrievalQuery(promptText, history));
    const messages: MessageParam[] = [...history, { role: 'user', content }];
    return this.runAgenticLoop(messages, context);
  }

  // Single-photo convenience wrapper.
  async runWithImage(
    caption: string,
    imageBase64: string,
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
    history: MessageParam[],
  ): Promise<AgentRunResult> {
    return this.runWithImages(caption, [{ base64: imageBase64, mediaType }], history);
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
