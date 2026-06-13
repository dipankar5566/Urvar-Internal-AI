// Wraps sharp for image preprocessing before Claude vision analysis.
// Graceful fallback: if sharp is not installed, returns the original image unchanged.

export interface OptimizedImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  label: string;
}

let sharpAvailable: boolean | null = null;

async function isSharpAvailable(): Promise<boolean> {
  if (sharpAvailable !== null) return sharpAvailable;
  try {
    await import('sharp');
    sharpAvailable = true;
  } catch {
    sharpAvailable = false;
  }
  return sharpAvailable;
}

export async function optimizeImage(
  inputBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
): Promise<OptimizedImage[]> {
  const original: OptimizedImage = { base64: inputBase64, mediaType, label: 'original' };

  if (!(await isSharpAvailable())) {
    return [original];
  }

  try {
    const { default: sharp } = await import('sharp');
    const inputBuffer = Buffer.from(inputBase64, 'base64');
    const results: OptimizedImage[] = [];

    // Variant 1: denoised + normalised (primary)
    const primary = await sharp(inputBuffer)
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .median(3)           // noise reduction
      .gamma(1.2)          // mild brightness normalisation
      .jpeg({ quality: 90 })
      .toBuffer();
    results.push({ base64: primary.toString('base64'), mediaType: 'image/jpeg', label: 'denoised' });

    // Variant 2: saturation-boosted (makes pathogen pigments more distinct)
    const saturated = await sharp(inputBuffer)
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .modulate({ saturation: 1.8 })
      .jpeg({ quality: 90 })
      .toBuffer();
    results.push({ base64: saturated.toString('base64'), mediaType: 'image/jpeg', label: 'saturated' });

    // Variant 3: grayscale (emphasises texture and lesion spread)
    const grey = await sharp(inputBuffer)
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .grayscale()
      .jpeg({ quality: 90 })
      .toBuffer();
    results.push({ base64: grey.toString('base64'), mediaType: 'image/jpeg', label: 'grayscale' });

    return results;
  } catch {
    // If sharp fails at runtime (e.g. path issue), fall back to original
    return [original];
  }
}
