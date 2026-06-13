"""
Convert the trained Keras SavedModel to a TF.js frozen GraphModel.

Run after: python ml/train.py

Output:
  ml/models/tfjs_crop_classifier/model.json   ← topology
  ml/models/tfjs_crop_classifier/*.bin        ← weights shards

These files are committed to git and expected by src/tools/crop-classifier.ts.
"""

import argparse
import os
import subprocess
import sys


OUTPUT_DIR = 'ml/models/tfjs_crop_classifier'
SAVED_MODEL_DIR = 'ml/saved_model'


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Export Keras SavedModel to TF.js GraphModel')
    p.add_argument(
        '--quantize', action='store_true',
        help='Quantize weights to uint8 (~4x size reduction, slight accuracy loss)',
    )
    p.add_argument(
        '--saved-model', default=SAVED_MODEL_DIR,
        help=f'Path to Keras SavedModel directory (default: {SAVED_MODEL_DIR})',
    )
    p.add_argument(
        '--output', default=OUTPUT_DIR,
        help=f'Output directory for TF.js model (default: {OUTPUT_DIR})',
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not os.path.isdir(args.saved_model):
        print(f'ERROR: SavedModel not found at {args.saved_model}')
        print('Run `python ml/train.py` first.')
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    cmd = [
        'tensorflowjs_converter',
        '--input_format=tf_saved_model',
        '--output_format=tfjs_graph_model',
        '--signature_name=serving_default',
        '--saved_model_tags=serve',
    ]

    if args.quantize:
        cmd.append('--quantize_uint8=*')
        print('[export] Quantization enabled — weights will be uint8 (~4x smaller).')

    cmd += [args.saved_model, args.output]

    print(f'[export] Running: {" ".join(cmd)}')
    subprocess.run(cmd, check=True)

    # Print output file sizes
    total_bytes = 0
    for fname in sorted(os.listdir(args.output)):
        fpath = os.path.join(args.output, fname)
        size  = os.path.getsize(fpath)
        total_bytes += size
        print(f'  {fname:50s}  {size / 1024:.1f} KB')

    print(f'\n[export] Done. Total model size: {total_bytes / 1_048_576:.1f} MB')
    print(f'[export] Output: {args.output}')
    print('\nNext step: npm run build && node -e "<see ml/README.md for integration test>"')


if __name__ == '__main__':
    main()
