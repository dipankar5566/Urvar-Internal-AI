"""
Data loading utilities — pure functions, no training logic.

Provides:
  - download_kaggle_datasets()  — Kaggle CLI download, skips if already present
  - discover_classes()          — unified sorted class list across all sources
  - build_unified_dataset()     — merged tf.data.Dataset from all sources
  - augment()                   — training-time image augmentation
"""

import os
import re
import random
import subprocess
import sys

import tensorflow as tf
import tensorflow_datasets as tfds
from keras.applications.mobilenet_v2 import preprocess_input as mobilenet_preprocess


# ── Class-name normalisation ───────────────────────────────────────────────────

def auto_normalize(folder_name: str) -> str:
    """Convert a raw folder name to a normalized class-name suffix.

    'Brown spot'            → 'Brown_Spot'
    'Bacterial_leaf_blight' → 'Bacterial_Leaf_Blight'
    'Early Blight (2023)'   → 'Early_Blight_2023'
    """
    words = re.split(r'[\s\-]+', folder_name.strip())
    normalized = '_'.join(w.capitalize() for w in words if w)
    normalized = re.sub(r'[^A-Za-z0-9_]', '', normalized)
    normalized = re.sub(r'_+', '_', normalized).strip('_')
    return normalized


def resolve_class_name(folder_name: str, prefix: str, class_map: dict) -> str:
    """Return unified class label for a folder name.

    Checks class_map first; falls back to auto_normalize + prefix.
    """
    suffix = class_map.get(folder_name, auto_normalize(folder_name))
    return f"{prefix}{suffix}" if prefix else suffix


# ── Kaggle download ────────────────────────────────────────────────────────────

def _kaggle_bin() -> str:
    """Return path to the kaggle CLI in the same venv as the running Python."""
    bin_dir = os.path.dirname(sys.executable)
    candidate = os.path.join(bin_dir, 'kaggle')
    if os.path.isfile(candidate):
        return candidate
    return 'kaggle'  # fall back to PATH


def download_kaggle_datasets(sources: list[dict], force: bool = False) -> None:
    """Download each kaggle_dir source if its data_dir doesn't exist yet."""
    kaggle = _kaggle_bin()
    for src in sources:
        if src['type'] != 'kaggle_dir':
            continue
        data_dir = src['data_dir']
        if not force and os.path.isdir(data_dir):
            print(f"[data_loader] Skip '{src['name']}' — already at {data_dir}")
            continue
        slug = src['slug']
        print(f"[data_loader] Downloading {slug} …")
        subprocess.run(
            [kaggle, 'datasets', 'download', '-d', slug, '-p', 'ml/data/', '--unzip'],
            check=True,
        )
        if not os.path.isdir(data_dir):
            print(
                f"[data_loader] WARNING: expected '{data_dir}' not found after download.\n"
                f"  Run: python ml/verify_datasets.py\n"
                f"  Then update 'data_dir' in ml/dataset_config.py for '{src['name']}'."
            )


# ── Class discovery ────────────────────────────────────────────────────────────

def discover_classes(sources: list[dict]) -> list[str]:
    """Return sorted, deduplicated unified class names across all sources."""
    all_classes: set[str] = set()
    for src in sources:
        if src['type'] == 'tfds':
            _, info = tfds.load(src['tfds_name'], split='train', with_info=True, as_supervised=True)
            for raw in info.features['label'].names:
                all_classes.add(resolve_class_name(raw, src['class_prefix'], src['class_map']))
        elif src['type'] == 'kaggle_dir':
            data_dir = src['data_dir']
            if not os.path.isdir(data_dir):
                print(f"[data_loader] WARNING: '{data_dir}' not found — skipped in class discovery.")
                continue
            for entry in os.listdir(data_dir):
                if os.path.isdir(os.path.join(data_dir, entry)):
                    all_classes.add(resolve_class_name(entry, src['class_prefix'], src['class_map']))
    return sorted(all_classes)


# ── Image preprocessing ────────────────────────────────────────────────────────

def _preprocess_path(path: tf.Tensor, label: tf.Tensor, img_size: int) -> tuple:
    """Load image from path, resize, apply MobileNetV2 preprocessing → [-1, 1]."""
    raw = tf.io.read_file(path)
    img = tf.image.decode_image(raw, channels=3, expand_animations=False)
    img.set_shape([None, None, 3])
    img = tf.image.resize(img, [img_size, img_size])
    img = mobilenet_preprocess(img)
    return img, label


def augment(image: tf.Tensor, label: tf.Tensor) -> tuple:
    """Training-time augmentation. Keeps values in MobileNetV2 range [-1, 1]."""
    image = tf.image.random_flip_left_right(image)
    image = tf.image.random_flip_up_down(image)
    image = tf.image.random_brightness(image, max_delta=0.15)
    image = tf.image.random_contrast(image, lower=0.85, upper=1.15)
    image = tf.clip_by_value(image, -1.0, 1.0)
    return image, label


# ── Per-source dataset builders ────────────────────────────────────────────────

def _build_tfds_source(
    src: dict,
    class_to_idx: dict[str, int],
    img_size: int,
) -> tuple[tf.data.Dataset, int]:
    """Load a TFDS source, remap labels to unified indices."""
    raw_ds, info = tfds.load(src['tfds_name'], split='train', with_info=True, as_supervised=True)
    tfds_names: list[str] = info.features['label'].names
    unified = [resolve_class_name(n, src['class_prefix'], src['class_map']) for n in tfds_names]

    # Build int→int label remap as a Python list (used inside tf.py_function for simplicity)
    remap = [class_to_idx.get(u, 0) for u in unified]
    remap_tensor = tf.constant(remap, dtype=tf.int32)

    def preprocess_tfds(img: tf.Tensor, lbl: tf.Tensor):
        img = tf.cast(img, tf.float32)
        img = tf.image.resize(img, [img_size, img_size])
        img = mobilenet_preprocess(img)
        new_lbl = remap_tensor[tf.cast(lbl, tf.int32)]
        return img, new_lbl

    count = info.splits['train'].num_examples
    ds = raw_ds.map(preprocess_tfds, num_parallel_calls=tf.data.AUTOTUNE)
    print(f"[data_loader] {src['name']} (TFDS): {count} images, "
          f"{len(unified)} classes → mapped to unified indices")
    return ds, count


def _build_kaggle_dir_source(
    src: dict,
    class_to_idx: dict[str, int],
    img_size: int,
) -> tuple[tf.data.Dataset | None, int]:
    """Load a Kaggle directory-based source as a tf.data.Dataset."""
    data_dir = src['data_dir']
    if not os.path.isdir(data_dir):
        print(f"[data_loader] WARNING: '{data_dir}' missing — skipping '{src['name']}'.")
        return None, 0

    pairs: list[tuple[str, int]] = []
    for folder in os.listdir(data_dir):
        folder_path = os.path.join(data_dir, folder)
        if not os.path.isdir(folder_path):
            continue
        class_name = resolve_class_name(folder, src['class_prefix'], src['class_map'])
        if class_name not in class_to_idx:
            print(f"[data_loader] WARNING: '{class_name}' not in unified index — skipping folder.")
            continue
        label_idx = class_to_idx[class_name]
        for fname in os.listdir(folder_path):
            if fname.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp')):
                pairs.append((os.path.join(folder_path, fname), label_idx))

    if not pairs:
        print(f"[data_loader] WARNING: no images found in '{data_dir}'.")
        return None, 0

    random.shuffle(pairs)
    paths, labels = zip(*pairs)
    ds = (
        tf.data.Dataset.from_tensor_slices((list(paths), list(labels)))
        .map(
            lambda p, l: _preprocess_path(p, l, img_size),
            num_parallel_calls=tf.data.AUTOTUNE,
        )
    )
    print(f"[data_loader] {src['name']}: {len(pairs)} images")
    return ds, len(pairs)


# ── Unified dataset builder ────────────────────────────────────────────────────

def build_unified_dataset(
    sources: list[dict],
    class_to_idx: dict[str, int],
    img_size: int = 224,
) -> tuple[tf.data.Dataset, int]:
    """Merge all sources into one tf.data.Dataset.

    Returns (dataset, total_count).
    Dataset yields (image [H,W,3] float32, label int32) pairs.
    Use loss='sparse_categorical_crossentropy' in model.compile().
    """
    all_datasets: list[tf.data.Dataset] = []
    total = 0

    for src in sources:
        if src['type'] == 'tfds':
            ds, count = _build_tfds_source(src, class_to_idx, img_size)
            all_datasets.append(ds)
            total += count
        elif src['type'] == 'kaggle_dir':
            ds, count = _build_kaggle_dir_source(src, class_to_idx, img_size)
            if ds is not None:
                all_datasets.append(ds)
                total += count
        else:
            print(f"[data_loader] Unknown source type '{src['type']}' — skipped.")

    if not all_datasets:
        raise RuntimeError('No data found across any source. Check dataset paths.')

    combined = all_datasets[0]
    for ds in all_datasets[1:]:
        combined = combined.concatenate(ds)

    print(f"[data_loader] Total: {total} images across {len(all_datasets)} sources")
    return combined, total
