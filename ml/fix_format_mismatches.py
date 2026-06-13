"""
Find image files whose actual format doesn't match their extension
(e.g. a .jpg that is actually WebP internally). TF's decoder rejects
these; Pillow handles them fine. We convert them to real JPEG in-place.

Run AFTER clean_images.py.
"""

import os
from PIL import Image, UnidentifiedImageError

TF_SUPPORTED = {'JPEG', 'PNG', 'BMP', 'GIF'}
EXTENSIONS    = ('.jpg', '.jpeg', '.png', '.bmp')

data_dir  = 'ml/data'
converted = 0
removed   = 0
scanned   = 0

for root, dirs, files in os.walk(data_dir):
    for fname in files:
        if not fname.lower().endswith(EXTENSIONS):
            continue
        path = os.path.join(root, fname)
        scanned += 1
        try:
            with Image.open(path) as img:
                actual = img.format  # e.g. 'WEBP', 'TIFF', 'JPEG', 'PNG'
                if actual not in TF_SUPPORTED:
                    # Convert to JPEG in-place
                    rgb = img.convert('RGB')
                    rgb.save(path, 'JPEG')
                    print(f'CONVERTED {actual}→JPEG: {path}')
                    converted += 1
        except (UnidentifiedImageError, Exception) as e:
            print(f'REMOVING unreadable: {path}  ({e})')
            os.remove(path)
            removed += 1
        if scanned % 50000 == 0:
            print(f'  checked {scanned} files, converted {converted}, removed {removed}…', flush=True)

print(f'\nDone. Checked {scanned} files → converted {converted}, removed {removed}.')
