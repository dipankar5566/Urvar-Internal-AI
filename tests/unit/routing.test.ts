import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeByKeyword } from '../../src/orchestrator/index.js';

const cases: Array<[string, string]> = [
  ['What is the market size for bio-fertilizers in India?', 'market_research'],
  ['Give me a competitor analysis of IFFCO', 'competitive_analysis'],
  ['Should we develop a new product formulation?', 'rd_product_development'],
  ['Write a caption for Instagram', 'sales_marketing'],
  ['Find distributors in Punjab', 'lead_generation'],
  ['My tomato leaves are turning yellow', 'crop_doctor'],
];

for (const [message, expected] of cases) {
  test(`routes "${message}" to ${expected}`, () => {
    assert.equal(routeByKeyword(message), expected);
  });
}

test('returns null for an unmatched message (Stage-2 fallback)', () => {
  assert.equal(routeByKeyword('hello, how are you today?'), null);
});
