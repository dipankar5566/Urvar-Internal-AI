"""
Central configuration for all training datasets and hyperparameters.

To add a new dataset:
  1. Add an entry to DATASET_SOURCES below.
  2. Run: python ml/verify_datasets.py
  3. Update class_map if folder names need renaming.
  4. Re-run training.

class_map format: {exact_folder_name: suffix_after_prefix}
  → 'Brown spot' maps to f"{class_prefix}Brown_Spot"
  → Unspecified folders are auto-normalized (spaces→_, non-alphanum stripped).
"""

DATASET_SOURCES: list[dict] = [
    # ── TensorFlow Datasets ────────────────────────────────────────────────────
    {
        'name': 'plant_village',
        'type': 'tfds',
        'tfds_name': 'plant_village',
        'class_prefix': '',     # class names used as-is: 'Tomato___Early_blight', etc.
        'class_map': {},
    },

    # ── Kaggle: PlantVillage augmented (same 38 classes, ~87K images) ─────────
    # Actual extracted path: ml/data/New Plant Diseases Dataset(Augmented)/...
    {
        'name': 'new_plant_diseases',
        'type': 'kaggle_dir',
        'slug': 'vipoooool/new-plant-diseases-dataset',
        'data_dir': 'ml/data/New Plant Diseases Dataset(Augmented)/New Plant Diseases Dataset(Augmented)/train',
        'class_prefix': '',     # same naming as TFDS → merged into same class indices
        'class_map': {},
    },

    # ── Kaggle: Rice leaf diseases ────────────────────────────────────────────
    {
        'name': 'rice_diseases',
        'type': 'kaggle_dir',
        'slug': 'vbookshelf/rice-leaf-diseases',
        'data_dir': 'ml/data/rice_leaf_diseases',
        'class_prefix': 'Rice___',
        'class_map': {
            'Bacterial leaf blight': 'Bacterial_Leaf_Blight',
            'Brown spot':            'Brown_Spot',
            'Leaf smut':             'Leaf_Smut',
        },
    },

    # ── Kaggle: Wheat rust diseases ───────────────────────────────────────────
    {
        'name': 'wheat_diseases',
        'type': 'kaggle_dir',
        'slug': 'sabaunnisa/wheat-rust-disease',
        'data_dir': 'ml/data/wheat_rust',
        'class_prefix': 'Wheat___',
        'class_map': {
            'leaf rust':   'Leaf_Rust',
            'stem rust':   'Stem_Rust',
            'stripe rust': 'Stripe_Rust',
        },
    },

    # ── Kaggle: Sugarcane leaf diseases ──────────────────────────────────────
    # Folders: Mosaic, RedRot, Rust, Yellow
    {
        'name': 'sugarcane_diseases',
        'type': 'kaggle_dir',
        'slug': 'nirmalsankalana/sugarcane-leaf-disease-dataset',
        'data_dir': 'ml/data/sugarcane',
        'class_prefix': 'Sugarcane___',
        'class_map': {
            'Mosaic': 'Mosaic',
            'RedRot': 'Red_Rot',
            'Rust':   'Rust',
            'Yellow': 'Yellow_Leaf',
        },
    },

    # ── Kaggle: Cashew (CCMT) ─────────────────────────────────────────────────
    # Folders have numbers embedded (e.g. 'anthracnose3102') — strip via class_map
    {
        'name': 'ccmt_cashew',
        'type': 'kaggle_dir',
        'slug': 'irakozekelly/crop-pest-and-disease-dataset',
        'data_dir': 'ml/data/Dataset for Crop Pest and Disease Detection/CCMT Dataset-Augmented/Cashew/train_set',
        'class_prefix': 'Cashew___',
        'class_map': {
            'anthracnose3102':  'Anthracnose',
            'gumosis1714':      'Gummosis',
            'healthy5877':      'healthy',
            'leaf miner3466':   'Leaf_Miner',
            'red rust4751':     'Red_Rust',
        },
    },

    # ── Kaggle: Cassava (CCMT) ────────────────────────────────────────────────
    # 'bacterial blight3241' is same disease as 'bacterial blight' — map to same class
    {
        'name': 'ccmt_cassava',
        'type': 'kaggle_dir',
        'slug': 'irakozekelly/crop-pest-and-disease-dataset',
        'data_dir': 'ml/data/Dataset for Crop Pest and Disease Detection/CCMT Dataset-Augmented/Cassava/train_set',
        'class_prefix': 'Cassava___',
        'class_map': {
            'bacterial blight':     'Bacterial_Blight',
            'bacterial blight3241': 'Bacterial_Blight',
            'brown spot':           'Brown_Spot',
            'green mite':           'Green_Mite',
            'healthy':              'healthy',
            'mosaic':               'Mosaic',
        },
    },

    # ── Kaggle: Maize (CCMT) ─────────────────────────────────────────────────
    # Separate from PlantVillage Corn_(maize)___ — covers different pest/disease classes
    {
        'name': 'ccmt_maize',
        'type': 'kaggle_dir',
        'slug': 'irakozekelly/crop-pest-and-disease-dataset',
        'data_dir': 'ml/data/Dataset for Crop Pest and Disease Detection/CCMT Dataset-Augmented/Maize/train_set',
        'class_prefix': 'Maize___',
        'class_map': {
            'fall armyworm': 'Fall_Armyworm',
            'grasshoper':    'Grasshopper',
            'healthy':       'healthy',
            'leaf beetle':   'Leaf_Beetle',
            'leaf blight':   'Leaf_Blight',
            'leaf spot':     'Leaf_Spot',
            'streak virus':  'Streak_Virus',
        },
    },

    # ── Kaggle: Tomato (CCMT) ─────────────────────────────────────────────────
    # Uses Tomato_CCMT___ prefix to distinguish from PlantVillage Tomato___ classes
    {
        'name': 'ccmt_tomato',
        'type': 'kaggle_dir',
        'slug': 'irakozekelly/crop-pest-and-disease-dataset',
        'data_dir': 'ml/data/Dataset for Crop Pest and Disease Detection/CCMT Dataset-Augmented/Tomato/train_set',
        'class_prefix': 'Tomato_CCMT___',
        'class_map': {
            'healthy':              'healthy',
            'leaf blight':          'Leaf_Blight',
            'leaf curl':            'Leaf_Curl',
            'septoria leaf spot':   'Septoria_Leaf_Spot',
            'verticulium wilt':     'Verticillium_Wilt',
        },
    },

    # ── Kaggle: Mango leaf diseases ───────────────────────────────────────────
    # Folders: Anthracnose, Bacterial Canker, Cutting Weevil, Die Back,
    #          Gall Midge, Powdery Mildew, Sooty Mould, healthy
    {
        'name': 'mango_diseases',
        'type': 'kaggle_dir',
        'slug': 'aryashah2k/mango-leaf-disease-dataset',
        'data_dir': 'ml/data/mango',
        'class_prefix': 'Mango___',
        'class_map': {
            'Bacterial Canker': 'Bacterial_Canker',
            'Cutting Weevil':   'Cutting_Weevil',
            'Die Back':         'Die_Back',
            'Gall Midge':       'Gall_Midge',
            'Powdery Mildew':   'Powdery_Mildew',
            'Sooty Mould':      'Sooty_Mould',
            'healthy':          'healthy',
        },
    },

    # ── Kaggle: Cotton diseases ───────────────────────────────────────────────
    # Folders: diseased cotton leaf, diseased cotton plant,
    #          fresh cotton leaf, fresh cotton plant
    {
        'name': 'cotton_diseases',
        'type': 'kaggle_dir',
        'slug': 'janmejaybhoi/cotton-disease-dataset',
        'data_dir': 'ml/data/Cotton Disease/train',
        'class_prefix': 'Cotton___',
        'class_map': {
            'diseased cotton leaf':  'Diseased_Leaf',
            'diseased cotton plant': 'Diseased_Plant',
            'fresh cotton leaf':     'Healthy_Leaf',
            'fresh cotton plant':    'Healthy_Plant',
        },
    },

    # ── Kaggle: Rose leaf diseases (~15K images) ──────────────────────────────
    # Folders: Healthy_Leaf_Rose, Rose_Rust, Rose_sawfly_Rose_slug
    {
        'name': 'rose_diseases',
        'type': 'kaggle_dir',
        'slug': 'shuvokumarbasak4004/rose-leaf-disease-dataset',
        'data_dir': 'ml/data/Rose/train',
        'class_prefix': 'Rose___',
        'class_map': {
            'Healthy_Leaf_Rose':    'healthy',
            'Rose_Rust':            'Rust',
            'Rose_sawfly_Rose_slug':'Sawfly_Slug',
        },
    },

    # ── Kaggle: Cucumber diseases ─────────────────────────────────────────────
    # Folders: Ill_cucumber, good_Cucumber
    {
        'name': 'cucumber_diseases',
        'type': 'kaggle_dir',
        'slug': 'kareem3egm/cucumber-plant-diseases-dataset',
        'data_dir': 'ml/data/Cucumber plant diseases dataset/training',
        'class_prefix': 'Cucumber___',
        'class_map': {
            'Ill_cucumber':  'Diseased',
            'good_Cucumber': 'healthy',
        },
    },

    # ── Kaggle: Peanut / Groundnut leaf disease ───────────────────────────────
    # Folders: Background_without_leaves, Dead Leaf, Diseased Leaf, Normal Leaf
    {
        'name': 'peanut_diseases',
        'type': 'kaggle_dir',
        'slug': 'abhimanuer/peanut-plant-leaf-disease',
        'data_dir': 'ml/data/Data',
        'class_prefix': 'Peanut___',
        'class_map': {
            'Background_without_leaves': 'Background',
            'Dead Leaf':                 'Dead_Leaf',
            'Diseased Leaf':             'Diseased',
            'Normal Leaf':               'healthy',
        },
    },

    # ── Kaggle: Banana disease recognition ────────────────────────────────────
    {
        'name': 'banana_diseases',
        'type': 'kaggle_dir',
        'slug': 'sujaykapadnis/banana-disease-recognition-dataset',
        'data_dir': 'ml/data/Banana Disease Recognition Dataset/Original Images/Original Images',
        'class_prefix': 'Banana___',
        'class_map': {
            'Banana Black Sigatoka Disease':    'Black_Sigatoka',
            'Banana Bract Mosaic Virus Disease':'Bract_Mosaic_Virus',
            'Banana Healthy Leaf':              'healthy',
            'Banana Insect Pest Disease':       'Insect_Pest',
            'Banana Moko Disease':              'Moko',
            'Banana Panama Disease':            'Panama',
            'Banana Yellow Sigatoka Disease':   'Yellow_Sigatoka',
        },
    },

    # ── Kaggle: Diverse multi-crop (~20K images, jawadali) ────────────────────
    # 41 classes covering Cotton, Rice, Sugarcane, Wheat, Maize pests + diseases
    # auto_normalize handles all folder names — no class_map overrides needed
    {
        'name': 'multi_crop_diverse',
        'type': 'kaggle_dir',
        'slug': 'jawadali1045/20k-multi-class-crop-disease-images',
        'data_dir': 'ml/data/Train',
        'class_prefix': '',
        'class_map': {},
    },
]

# ── Hyperparameters ────────────────────────────────────────────────────────────
VAL_SPLIT        = 0.2   # fraction of total data reserved for validation
BATCH_SIZE       = 32
PHASE1_EPOCHS    = 15    # feature extraction: base frozen, head trained
PHASE2_EPOCHS    = 15    # fine-tuning: last FINE_TUNE_LAYERS unfrozen
FINE_TUNE_LAYERS = 100   # number of MobileNetV2 layers to unfreeze in phase 2
IMAGE_SIZE       = 224   # must match crop-classifier.ts (224×224)
