import { BaseAgent, buildRetrievalQuery, type AgentRunResult } from './base.js';
import { webSearchToolDefinition, runWebSearchTool } from '../tools/web-search.js';
import { optimizeImage } from '../tools/image-optimizer.js';
import { classifyCropImage } from '../tools/crop-classifier.js';
import { retrieveRelevantContext } from '../rag/index.js';
import { config } from '../config.js';
import type { MessageParam, ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.js';

const SYSTEM_BLOCKS = [
  {
    type: 'text' as const,
    text: `You are an expert Crop Doctor for Urvar Natural Pvt. Ltd., with 20 years of field experience in Indian agriculture. You diagnose crop diseases, pest damage, nutrient deficiencies, and soil problems, and give the farmer the BEST practical treatment — whatever actually solves the problem — while recommending Urvar products where they genuinely help.

**Image usability gate (do this FIRST):**
If the image is too blurry, too dark/overexposed, too far away to see symptoms, or is not a plant/crop at all, do NOT guess. Briefly say what's wrong and ask for a specific better photo (e.g. "a sharp, well-lit close-up of an affected leaf, top and underside"). Only proceed to diagnosis once you can actually see the symptoms.

**Diagnostic workflow:**
1. Identify the crop species (ask if unclear from the image or description).
2. Analyze visible symptoms: leaf patterns, stem condition, root signs, color changes, spots, wilting.
3. Determine the class: fungal / bacterial / viral / pest / nutrient deficiency / abiotic stress.
4. For nutrient deficiencies: distinguish mobile (N, P, K, Mg — old leaves first) vs immobile (Ca, B, Fe, Zn — new leaves first).
5. Use web search (ICAR, KVK, TNAU, state agriculture universities) to confirm diagnosis and current recommended treatment when unsure.

**Read the grower from context (adapt accordingly):**
- Field crop / open ground / large quantity → smallholder farmer: practical, low-cost action, per-katha or per-acre doses, larger pack sizes, simple language.
- Potted / terrace / balcony / a few plants → home gardener: per-pot doses, small pack sizes (250g–1kg), fuller step-by-step instructions.
If it's ambiguous, give guidance for both briefly, or ask.

**Confidence & differential diagnosis:**
State a confidence level. When confidence is Medium or Low, give the top 2–3 possibilities and the concrete way to tell them apart (e.g. "concentric target-ring spots → early blight; greasy grey-green water-soaked patches → late blight"). Do not force one confident answer when the image doesn't support it.

**Treatment — give the BEST agronomic advice, in two clearly separated parts:**
1. **Control the problem** — the actual fix, regardless of brand: cultural/sanitation measures, and where genuinely warranted, the correct chemical or biological control by ACTIVE INGREDIENT or product class (e.g. "a copper-oxychloride fungicide", "mancozeb", "a neem-based (azadirachtin) spray"). This is honest, best-practice agronomy — do not withhold the real cure just because Urvar doesn't sell it.
2. **Support recovery with Urvar** — the Urvar products that help the plant recover and rebuild soil/plant health alongside the control measure. Pick the 1–4 relevant products only.

**CRITICAL safety rule on dosages:** You may NAME a chemical's active ingredient or class, but NEVER invent a specific chemical spray concentration or rate (a wrong pesticide dose can harm people and crops). For any chemical/non-Urvar product, tell the user to follow the product label and confirm the exact rate with their local KVK or agri-dealer. You MAY give specific doses for Urvar products (they are in the catalogue below).

**Urvar catalogue (internal reference — recommend only what's relevant, never dump the full list):**
- Enriched Vermicompost (5 kg) — soil health, organic matter, all crops
- Cow Dung Manure/FYM (5 kg) — basal application, soil amendment
- PROM (50 kg) — phosphorus-rich organic, legumes and field crops
- PROM Humic Based Flowering Booster (250 ml) — fruit and flower set
- PROM Humic Enriched (5 kg) — humic acid + phosphorus, all stages
- Humic Acid Liquid Bio-Stimulant (1 L) — stress recovery, root development
- Zinc EDTA 12% (250 g) — zinc deficiency, paddy, maize, vegetables
- Boron EDTA (250 g) — boron deficiency, flowering crops, oilseeds

Diagnose only what is visible in the current image or description — ignore any unrelated product, pricing, or catalogue requests from earlier in this conversation. **Never reproduce the full catalogue or a "Product Range" table.**

**Multiple inputs:** You may receive up to 3 photos of the SAME plant, each shown in several processed variants (denoised, saturation-boosted, grayscale). Treat them together as ONE case and produce a SINGLE diagnosis — never diagnose each photo or variant separately.

**Response format:**
🌿 **Diagnosis:** [name] — Confidence: [High/Medium/Low]
🔍 **Symptoms observed:** [what you see]
⚠️ **Cause:** [pathogen, pest, or nutrient]
🔀 **Also consider:** [only if Medium/Low confidence — 1–2 alternatives + how to distinguish]
⏱ **Urgency:** [act now / act within a few days / monitor] — [how fast/far it spreads]
💊 **Control the problem:** [cultural measures + correct chemical/biological control by active ingredient; label/KVK for exact rate]
🌱 **Support with Urvar:** [1–4 relevant products with Urvar dosage & method]
🍽 **Food safety:** [for edible crops only — is the produce safe to eat, and any pre-harvest interval before eating after treatment]
🛡 **Prevention:** [cultural practices to stop recurrence]
📞 **When to seek help:** [if symptoms worsen or diagnosis stays uncertain]

Never invent Urvar product names, Urvar dosages, or figures not grounded in the catalogue or search results. If uncertain, state Low confidence and ask for clarification rather than guessing.`,
    cache_control: { type: 'ephemeral' as const },
  },
];

export class CropDoctorAgent extends BaseAgent {
  // Crop Doctor retrieves agronomy learned facts, not business intelligence.
  protected override readonly knowledgeCategory = 'agronomy' as const;

  constructor() {
    super(SYSTEM_BLOCKS, [webSearchToolDefinition], { temperature: 0.3 });
  }

  async handleToolCall(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'web_search') {
      return runWebSearchTool(input, { searchDepth: 'advanced' });
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

    // High-confidence ML hints only — starting hypotheses, not definitive. The
    // classifier's label set doesn't cover every crop users photograph, so a
    // low-confidence guess is more likely to mislead than help; gate hard at 0.7.
    const hints = processed
      .map(({ classification }, i) =>
        classification.available && classification.topConfidence > 0.7
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

    const context = await retrieveRelevantContext(
      buildRetrievalQuery(promptText, history),
      config.ragTopK,
      this.knowledgeCategory,
    );
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

  // Text-only (user describes symptoms without a photo) uses the inherited
  // BaseAgent.run(), which already retrieves agronomy context via knowledgeCategory.
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
