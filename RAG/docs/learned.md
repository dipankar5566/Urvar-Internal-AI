# Learned Knowledge (machine-written mirror)

This file is an **append-only, human-readable mirror** of facts the bot has learned
and the owner has approved. It exists for transparency and review only.

**It is deliberately NOT listed in `DOC_FILES` (`src/rag/index.ts`)** — the live
retrieval store for learned facts is the `learned_knowledge` SQLite table (with
persisted embeddings), injected into the in-memory index at approval time and at
startup. Adding this file to `DOC_FILES` would change the curated-docs hash and
force a full re-embed of every curated chunk on restart. Don't do that.

Edits here do not affect retrieval. To change a learned fact, use the Telegram
approval flow (`/teach`, or the ✏️ Edit button).

---

- Urvar vermicompost price is 250 rupees per 25 kg bag  _(source: teach, approved 2026-06-15)_

- enriched vermicompost is also available is 25 kg pack size  _(source: teach, approved 2026-06-15)_

- Urvar Natural manufactures 8 FCO-registered organic fertilizer products: Enriched Vermicompost (5kg), Cow Dung Manure/FYM (5kg), PROM (50kg), PROM Humic Enriched (5kg), PROM Humic Based Flowering Booster (250ml), Humic Acid Liquid Bio-Stimulant (1L), Zinc EDTA 12% (250g), and Boron EDTA (250g).  _(source: conversation, approved 2026-06-15)_

- Urvar Natural products span 4 categories: Organic Manures (Vermicompost, FYM), Phosphate Fertilizers (PROM variants), Bio-Stimulants (Humic Acid Liquid), and Chelated Micronutrients (Zinc EDTA, Boron EDTA).  _(source: conversation, approved 2026-06-15)_

- Urvar Natural is an FCO 1985-registered organic fertilizer manufacturer based in Kolkata, selling vermicompost and other inputs through Amazon, Flipkart, urvarindia.com, and B2B dealer channels.  _(source: conversation, approved 2026-06-15)_

- Urvar Humic acid ships in 250ml and 1 Liter Bottle  _(source: teach, approved 2026-06-15)_

- Rose stem dieback with brown discolouration indicates Botrytis canker infection; remove affected bud and stem tissue by cutting well below the brown zone into clean green stem, then sterilise pruning tools to prevent spore spread.  _(source: crop_doctor, approved 2026-06-15)_

- Botrytis cinerea thrives in high humidity, poor air circulation, and cool-to-warm temperature fluctuations; prevent by avoiding overhead watering, improving ventilation, and watering only at the plant base in morning.  _(source: crop_doctor, approved 2026-06-15)_

- Boron deficiency reduces bud opening and petal strength in roses; treat with Boron EDTA foliar spray (2–3 g per 20 L water) at bud formation to strengthen cell walls and reduce balling susceptibility.  _(source: crop_doctor, approved 2026-06-15)_

- Botrytis blight causes rose bud balling, brown papery outer petals, and stem dieback; treat with Humic Acid Liquid Bio-Stimulant foliar spray (3 ml/L every 7–10 days) and Enriched Vermicompost (200–250 g per pot) to suppress fungus.  _(source: crop_doctor, approved 2026-06-15)_
