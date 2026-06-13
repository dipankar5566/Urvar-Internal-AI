# ML Training Pipeline

Trains a MobileNetV2 crop disease classifier on 14 datasets (~350K images) and exports it to TF.js GraphModel format for use in the Urvar AI Assistant Crop Doctor agent.

## Datasets

| Source | Covers | Images |
|--------|--------|--------|
| PlantVillage (TFDS) | 14 crops, 38 disease classes | ~54K |
| New Plant Diseases (Kaggle) | Same 38 classes, augmented | ~87K |
| Rice Leaf Diseases | Brown Spot, Blast, Smut | ~120 |
| Wheat Rust | Yellow/Brown Rust | varies |
| Sugarcane | Red Rot, Smut, Yellow Leaf | varies |
| Cashew/Cassava/Maize/Tomato | 22 pest+disease classes | ~103K |
| Banana/Chilli/Radish/Groundnut/Cauliflower | 5 crops | ~67K |
| Mango | Leaf diseases | varies |
| Cotton | Bacterial blight, wilt, virus | varies |
| Rose | Leaf diseases | ~15K |
| Cucumber | Powdery mildew, downy mildew | varies |
| Peanut/Groundnut | Leaf disease | varies |
| Banana (supplementary) | Field diseases | ~408 |
| Diverse multi-crop | Mixed diseases | ~20K |

## Setup

```bash
# From the project root
python -m venv ml/.venv
source ml/.venv/bin/activate        # macOS/Linux
# ml\.venv\Scripts\activate         # Windows

pip install -r ml/requirements.txt
```

Requires Python 3.9–3.11. GPU strongly recommended (NVIDIA with CUDA 11.8+).

## Step 1 — Download datasets

```bash
# Make sure kaggle.json is at ~/.kaggle/kaggle.json (chmod 600)
python ml/train.py --download-only
```

Downloads all 13 Kaggle datasets to `ml/data/`. Skips any already downloaded.

## Step 2 — Verify folder names

```bash
python ml/verify_datasets.py --show-normalized
```

Inspect the printed folder names for each dataset. If any look wrong (e.g., unexpected casing or naming), add overrides to the `class_map` dict for that source in `ml/dataset_config.py`.

Example: if Wheat dataset has folder `'yellow_rust'` but you want `'Wheat___Yellow_Rust'`:
```python
# ml/dataset_config.py — wheat entry
'class_map': {
    'yellow_rust': 'Yellow_Rust',
}
```

## Step 3 — Train

```bash
python ml/train.py
```

Training phases:
- **Phase 1** (15 epochs): MobileNetV2 base frozen, only the classification head trains
- **Phase 2** (10 epochs): Last 50 MobileNetV2 layers unfrozen, fine-tuned at lr=1e-5

Best checkpoints saved to `ml/checkpoints/`. On an NVIDIA RTX 3060:
- Phase 1: ~30–45 minutes
- Phase 2: ~20–30 minutes

For debugging, run phase 1 only:
```bash
python ml/train.py --phase1-only
```

## Step 4 — Export to TF.js

```bash
python ml/export.py
```

Output in `ml/models/tfjs_crop_classifier/`:
- `model.json` — model topology
- `group1-shard*.bin` — weight shards (~14 MB total unquantized)

To shrink model size ~4x at the cost of slight accuracy loss:
```bash
python ml/export.py --quantize
```

## Step 5 — Integration test

```bash
cd /path/to/project-root
npm run build

node -e "
import('./dist/tools/crop-classifier.js').then(async ({ classifyCropImage }) => {
  const { readFileSync } = await import('fs');
  // Replace with an actual leaf image path:
  const b64 = readFileSync('ml/test.jpg').toString('base64');
  console.log(await classifyCropImage(b64));
});
"
```

Expected output:
```json
{
  "available": true,
  "topLabel": "Tomato___Early_blight",
  "topConfidence": 0.92,
  "top3": [...]
}
```

## Updating the model

1. Edit `ml/dataset_config.py` — add/remove sources or adjust `class_map`
2. Re-run Steps 1–4
3. Restart PM2: `pm2 restart urvar-ai`

No TypeScript changes are needed — the bot reads `ml/labels.json` and `ml/models/tfjs_crop_classifier/model.json` at startup.

## Files reference

| File | Purpose |
|------|---------|
| `dataset_config.py` | All 14 dataset entries + hyperparameters |
| `data_loader.py` | Download, class discovery, tf.data pipeline |
| `train.py` | MobileNetV2 training script |
| `export.py` | Keras SavedModel → TF.js GraphModel |
| `verify_datasets.py` | Inspect downloaded folder names |
| `labels.json` | Class name list (pre-seeded; overwritten by train.py) |
| `models/tfjs_crop_classifier/` | TF.js model output (committed to git) |
| `data/` | Dataset files (gitignored, downloaded at training time) |
