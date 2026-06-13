import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'RAG', 'docs');

function load(filename: string): string {
  return readFileSync(join(ROOT, filename), 'utf-8');
}

// Loaded once at process startup — never re-read per request
const COMPANY = load('company.md');
const PRODUCTS = load('products.md');
const PRICING = load('pricing.md');
const CUSTOMERS = load('customers.md');
const SUMMARY = load('urvar-summary.md');
const CROP_GUIDE = load('crop-guide.md');
const DISEASE_GUIDE = load('disease-guide.md');

function combine(header: string, ...docs: string[]): string {
  return `${header}\n\n` + docs.join('\n\n---\n\n');
}

export const knowledge = {
  marketResearch: combine(
    '# Urvar Natural — Company & Product Knowledge',
    COMPANY, PRODUCTS, PRICING, CUSTOMERS, SUMMARY,
  ),
  competitiveAnalysis: combine(
    '# Urvar Natural — Company & Product Knowledge',
    COMPANY, PRODUCTS, PRICING, SUMMARY,
  ),
  rdProductDevelopment: combine(
    '# Urvar Natural — Product & Agronomy Knowledge',
    COMPANY, PRODUCTS, CROP_GUIDE, DISEASE_GUIDE, PRICING,
  ),
  salesMarketing: combine(
    '# Urvar Natural — Company & Product Knowledge',
    COMPANY, PRODUCTS, PRICING, CUSTOMERS, SUMMARY,
  ),
  leadGeneration: combine(
    '# Urvar Natural — Company & Product Knowledge',
    COMPANY, PRODUCTS, PRICING, SUMMARY,
  ),
};
