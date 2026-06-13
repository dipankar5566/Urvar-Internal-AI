"""
Scan all images in ml/data/ and remove any that Pillow can't decode.
Run once before training to eliminate corrupt / wrong-format files.
"""

import os
import sys
from PIL import Image, UnidentifiedImageError

data_dir = 'ml/data'
removed = 0
scanned = 0
extensions = ('.jpg', '.jpeg', '.png', '.bmp')

for root, dirs, files in os.walk(data_dir):
    for fname in files:
        if not fname.lower().endswith(extensions):
            continue
        path = os.path.join(root, fname)
        scanned += 1
        try:
            with Image.open(path) as img:
                img.convert('RGB')  # forces full pixel decode — catches truncated/misformatted files
        except (UnidentifiedImageError, Exception) as e:
            print(f'REMOVING corrupt: {path}  ({e})')
            os.remove(path)
            removed += 1
        if scanned % 10000 == 0:
            print(f'  scanned {scanned} files, removed {removed} so far…', flush=True)

print(f'\nDone. Scanned {scanned} files, removed {removed} corrupt files.')
