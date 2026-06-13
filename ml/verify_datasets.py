"""
Inspect downloaded Kaggle dataset folder structures.

Run AFTER downloading datasets (train.py --download-only) and BEFORE training.
Use the output to populate the class_map entries in ml/dataset_config.py.

Usage:
  python ml/verify_datasets.py
  python ml/verify_datasets.py --source rice_diseases   # single source only
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from dataset_config import DATASET_SOURCES
from data_loader import resolve_class_name


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Inspect downloaded dataset folder structures')
    p.add_argument('--source', help='Inspect only this source name (default: all)')
    p.add_argument('--show-normalized', action='store_true',
                   help='Also show the normalized class name that will be used in training')
    return p.parse_args()


def inspect_source(src: dict, show_normalized: bool = False) -> None:
    if src['type'] == 'tfds':
        print(f'\n[{src["name"]}]  type=tfds  tfds_name={src["tfds_name"]}')
        print('  (class names loaded from TensorFlow Datasets at training time)')
        return

    data_dir = src['data_dir']
    print(f'\n[{src["name"]}]  slug={src["slug"]}')
    print(f'  data_dir : {data_dir}')
    print(f'  prefix   : {src["class_prefix"]!r}')

    if not os.path.isdir(data_dir):
        print('  STATUS   : NOT DOWNLOADED')
        print(f'  Download : kaggle datasets download -d {src["slug"]} -p ml/data/ --unzip')
        return

    entries = sorted(
        e for e in os.listdir(data_dir)
        if os.path.isdir(os.path.join(data_dir, e))
    )

    if not entries:
        print(f'  STATUS   : directory exists but contains no subdirectories')
        print('  Check if images are at the correct nesting level (may need to adjust data_dir)')
        return

    print(f'  STATUS   : {len(entries)} class folder(s) found')
    print()
    for folder in entries:
        folder_path = os.path.join(data_dir, folder)
        img_count = sum(
            1 for f in os.listdir(folder_path)
            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.webp'))
        )
        if show_normalized:
            normalized = resolve_class_name(folder, src['class_prefix'], src['class_map'])
            print(f'  {folder!r:45s}  {img_count:6d} images  →  {normalized!r}')
        else:
            print(f'  {folder!r:45s}  {img_count:6d} images')


def main() -> None:
    args = parse_args()
    sources = DATASET_SOURCES

    if args.source:
        sources = [s for s in sources if s['name'] == args.source]
        if not sources:
            print(f'ERROR: No source named {args.source!r}.')
            print('Available names:', [s['name'] for s in DATASET_SOURCES])
            sys.exit(1)

    print('=' * 70)
    print('Dataset Verification Report')
    print('=' * 70)

    for src in sources:
        inspect_source(src, show_normalized=args.show_normalized)

    print('\n' + '=' * 70)
    print('Tips:')
    print('  • If data_dir is wrong, update it in ml/dataset_config.py')
    print('  • Use --show-normalized to preview class names before training')
    print('  • Add class_map entries for any folder names that need renaming')
    print('  • Run: python ml/train.py --download-only  to download missing datasets')


if __name__ == '__main__':
    main()
