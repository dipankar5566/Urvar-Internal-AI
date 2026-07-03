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
  ['humic acid size', 'product_info'],
  ['What size does humic acid come in?', 'product_info'],
  ['dosage of vermicompost', 'product_info'],
  ['price of neem oil', 'product_info'],
  // product_info rules must NOT steal market-analysis or new-product queries
  ['What is the market size for bio-fertilizers in India?', 'market_research'],
  ['Should we develop a new vermicompost formulation?', 'rd_product_development'],
  // Indian trade vocabulary routes to lead_generation without a "find" verb
  ['stockists in Nadia district', 'lead_generation'],
  ['any wholesalers for vermicompost near Ranchi?', 'lead_generation'],
  ['dealership enquiry from Hooghly', 'lead_generation'],
  ['agro dealers in North 24 Parganas', 'lead_generation'],
  ['list of krishi seva kendras in West Bengal', 'lead_generation'],
  // ...but market-research channel-strategy phrasing stays put
  ['what distribution channel strategy should we use?', 'market_research'],
  // competitor-flavored pricing goes to competitive_analysis (rule order),
  // while plain pricing strategy stays with market_research
  ['what is our competitors pricing strategy?', 'competitive_analysis'],
  ['pricing strategy for our vermicompost line', 'market_research'],
];

for (const [message, expected] of cases) {
  test(`routes "${message}" to ${expected}`, () => {
    assert.equal(routeByKeyword(message), expected);
  });
}

test('returns null for an unmatched message (Stage-2 fallback)', () => {
  assert.equal(routeByKeyword('hello, how are you today?'), null);
});
