import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const MODEL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'ml', 'models', 'tfjs_crop_classifier', 'model.json',
);
const LABELS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'ml', 'labels.json',
);

export interface ClassifierResult {
  available: true;
  topLabel: string;
  topConfidence: number;
  top3: Array<{ label: string; confidence: number }>;
}

export interface ClassifierUnavailable {
  available: false;
}

export type CropClassification = ClassifierResult | ClassifierUnavailable;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelCache: any = null;
let labelsCache: string[] | null = null;
let tfjsAvailable: boolean | null = null;
let modelLoadAttempted = false;

async function isTfjsAvailable(): Promise<boolean> {
  if (tfjsAvailable !== null) return tfjsAvailable;
  try {
    await import('@tensorflow/tfjs-node');
    tfjsAvailable = true;
  } catch {
    tfjsAvailable = false;
  }
  return tfjsAvailable;
}

async function loadModel(): Promise<boolean> {
  if (modelLoadAttempted) return modelCache !== null;
  modelLoadAttempted = true;

  if (!existsSync(MODEL_PATH) || !existsSync(LABELS_PATH)) return false;
  if (!(await isTfjsAvailable())) return false;

  try {
    const tf = await import('@tensorflow/tfjs-node');
    modelCache = await tf.loadGraphModel(`file://${MODEL_PATH}`);
    const raw = await import(LABELS_PATH, { with: { type: 'json' } });
    labelsCache = Object.values(raw.default) as string[];
    return true;
  } catch {
    modelCache = null;
    return false;
  }
}

export async function classifyCropImage(imageBase64: string): Promise<CropClassification> {
  if (!(await loadModel()) || !modelCache || !labelsCache) {
    return { available: false };
  }

  try {
    const tf = await import('@tensorflow/tfjs-node');
    const imgBuffer = Buffer.from(imageBase64, 'base64');

    const tensor = tf.node
      .decodeImage(imgBuffer, 3)
      .resizeBilinear([224, 224])
      .toFloat()
      .div(127.5)
      .sub(1)
      .expandDims(0);

    const predictions = modelCache.predict(tensor);
    const probabilities: number[] = Array.from(await predictions.data() as Float32Array);

    const indexed = probabilities.map((p: number, i: number) => ({
      label: labelsCache![i] ?? `class_${i}`,
      confidence: p,
    }));
    const top3 = indexed.sort((a, b) => b.confidence - a.confidence).slice(0, 3);

    tensor.dispose();
    predictions.dispose();

    return {
      available: true,
      topLabel: top3[0]!.label,
      topConfidence: top3[0]!.confidence,
      top3,
    };
  } catch {
    return { available: false };
  }
}
