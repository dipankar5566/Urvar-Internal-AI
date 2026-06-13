"""
Train a MobileNetV2 crop-disease classifier on all configured datasets.

Usage:
  python ml/train.py              # full training pipeline
  python ml/train.py --download-only   # download Kaggle datasets then exit
"""

import argparse
import json
import os
import sys

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')  # suppress verbose TF logs

import tensorflow as tf
import keras

# Add ml/ to path so relative imports work whether run from project root or ml/
sys.path.insert(0, os.path.dirname(__file__))
from dataset_config import (
    DATASET_SOURCES, VAL_SPLIT, BATCH_SIZE,
    PHASE1_EPOCHS, PHASE2_EPOCHS, FINE_TUNE_LAYERS, IMAGE_SIZE,
)
from data_loader import (
    download_kaggle_datasets, discover_classes, build_unified_dataset, augment,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Train Urvar crop disease classifier')
    p.add_argument('--download-only', action='store_true',
                   help='Download Kaggle datasets then exit without training')
    p.add_argument('--skip-download', action='store_true',
                   help='Skip Kaggle downloads (use if already downloaded)')
    p.add_argument('--phase1-only', action='store_true',
                   help='Run phase 1 only (faster, for debugging)')
    p.add_argument('--resume', action='store_true',
                   help='Resume phase 2 fine-tuning from ml/checkpoints/phase2_best.keras, skipping phase 1')
    p.add_argument('--initial-epoch', type=int, default=0,
                   help='Number of phase-2 epochs already completed (for --resume)')
    return p.parse_args()


def build_model(num_classes: int) -> tuple[tf.keras.Model, tf.keras.Model]:
    """Returns (full_model, base_model). Keep base_model reference for phase-2 unfreezing."""
    base = keras.applications.MobileNetV2(
        input_shape=(IMAGE_SIZE, IMAGE_SIZE, 3),
        include_top=False,
        weights='imagenet',
    )
    base.trainable = False

    x = keras.layers.GlobalAveragePooling2D()(base.output)
    x = keras.layers.BatchNormalization()(x)
    x = keras.layers.Dropout(0.3)(x)
    out = keras.layers.Dense(num_classes, activation='softmax')(x)

    model = keras.Model(base.input, out)
    return model, base


def main() -> None:
    args = parse_args()

    # ── Step 1: Download ───────────────────────────────────────────────────────
    if not args.skip_download:
        print('\n[train] Downloading missing Kaggle datasets…')
        download_kaggle_datasets(DATASET_SOURCES)

    if args.download_only:
        print('[train] --download-only flag set. Exiting.')
        print('[train] Next: run `python ml/verify_datasets.py` to inspect folder names.')
        return

    # ── Step 2: Discover unified classes ──────────────────────────────────────
    print('\n[train] Discovering class names across all sources…')
    class_names = discover_classes(DATASET_SOURCES)
    class_to_idx = {c: i for i, c in enumerate(class_names)}
    NUM_CLASSES = len(class_names)
    print(f'[train] Total unified classes: {NUM_CLASSES}')
    print(f'[train] First 5: {class_names[:5]}')

    # ── Step 3: Build merged dataset ──────────────────────────────────────────
    print('\n[train] Building unified tf.data.Dataset…')
    ds, total = build_unified_dataset(DATASET_SOURCES, class_to_idx, img_size=IMAGE_SIZE)

    val_size   = int(total * VAL_SPLIT)
    train_size = total - val_size
    print(f'[train] Train: {train_size} | Val: {val_size}')

    ds_val = (
        ds.take(val_size)
        .batch(BATCH_SIZE)
        .prefetch(tf.data.AUTOTUNE)
    )
    ds_train = (
        ds.skip(val_size)
        .shuffle(min(train_size, 10_000))
        .map(augment, num_parallel_calls=tf.data.AUTOTUNE)
        .batch(BATCH_SIZE)
        .prefetch(tf.data.AUTOTUNE)
    )

    os.makedirs('ml/checkpoints', exist_ok=True)

    # ── Step 4: Build or load model ───────────────────────────────────────────
    if args.resume:
        print('\n[train] Resuming: loading ml/checkpoints/phase2_best.keras …')
        model = keras.models.load_model('ml/checkpoints/phase2_best.keras')
        model.summary(line_length=100)
    else:
        print(f'\n[train] Building MobileNetV2 model ({NUM_CLASSES} output classes)…')
        model, base = build_model(NUM_CLASSES)
        model.summary(line_length=100)

        # ── Step 5: Phase 1 — feature extraction (base frozen) ─────────────────
        print(f'\n[train] Phase 1: training head ({PHASE1_EPOCHS} epochs, base frozen)…')
        model.compile(
            optimizer=keras.optimizers.Adam(1e-3),
            loss='sparse_categorical_crossentropy',
            metrics=['accuracy'],
        )
        model.fit(
            ds_train,
            validation_data=ds_val,
            epochs=PHASE1_EPOCHS,
            callbacks=[
                keras.callbacks.ModelCheckpoint(
                    'ml/checkpoints/phase1_best.keras', save_best_only=True,
                    monitor='val_accuracy', verbose=1,
                ),
                keras.callbacks.ReduceLROnPlateau(
                    monitor='val_loss', factor=0.5, patience=3, verbose=1,
                ),
            ],
        )

    if args.phase1_only:
        print('[train] --phase1-only flag set. Skipping phase 2.')
    else:
        # ── Step 6: Phase 2 — fine-tuning ─────────────────────────────────────
        print(f'\n[train] Phase 2: fine-tuning last {FINE_TUNE_LAYERS} MobileNetV2 layers '
              f'({PHASE2_EPOCHS} epochs, lr=1e-5)…')

        if not args.resume:
            # Unfreeze base — keep reference from build_model(), no reload needed
            base.trainable = True
            for layer in base.layers[:-FINE_TUNE_LAYERS]:
                layer.trainable = False

        model.compile(
            optimizer=keras.optimizers.Adam(1e-5),
            loss='sparse_categorical_crossentropy',
            metrics=['accuracy'],
        )
        model.fit(
            ds_train,
            validation_data=ds_val,
            initial_epoch=args.initial_epoch,
            epochs=PHASE2_EPOCHS,
            callbacks=[
                keras.callbacks.ModelCheckpoint(
                    'ml/checkpoints/phase2_best.keras', save_best_only=True,
                    monitor='val_accuracy', verbose=1,
                ),
                keras.callbacks.EarlyStopping(
                    monitor='val_loss', patience=4, restore_best_weights=True, verbose=1,
                ),
            ],
        )

    # ── Step 7: Export TF SavedModel + labels.json ────────────────────────────
    # Use model.export() (Keras 3) — produces a TF SavedModel that tensorflowjs_converter reads.
    # Do NOT use model.save() which in Keras 3 writes .keras format, not a SavedModel dir.
    print('\n[train] Exporting SavedModel to ml/saved_model/ …')
    os.makedirs('ml/saved_model', exist_ok=True)
    model.export('ml/saved_model/')

    labels_path = 'ml/labels.json'
    with open(labels_path, 'w') as f:
        json.dump(class_names, f, indent=2)

    print(f'\n[train] Done.')
    print(f'  {NUM_CLASSES} classes → {labels_path}')
    print(f'  SavedModel    → ml/saved_model/')
    print(f'\nNext step: python ml/export.py')


if __name__ == '__main__':
    main()
