import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKbCallback, normalizeFact, isDuplicate, categoryForSource, parseFactsResponse } from '../../src/rag/learned-util.js';

test('parseFactsResponse extracts a clean JSON array', () => {
  assert.deepEqual(parseFactsResponse('["fact one", "fact two"]'), ['fact one', 'fact two']);
});

test('parseFactsResponse tolerates prose and code fences around the array', () => {
  assert.deepEqual(parseFactsResponse('Here are the facts:\n```json\n["a"]\n```'), ['a']);
});

test('parseFactsResponse returns [] for an explicit empty array (nothing qualified)', () => {
  assert.deepEqual(parseFactsResponse('[]'), []);
});

test('parseFactsResponse drops non-string and blank entries', () => {
  assert.deepEqual(parseFactsResponse('["ok", 42, "", "  ", null]'), ['ok']);
});

test('parseFactsResponse returns null when the model ignored the format', () => {
  // The failure mode that silently killed learning: a prose reply, no array.
  assert.equal(parseFactsResponse('I cannot provide a market briefing because…'), null);
  // Truncated mid-array (max_tokens) — unparseable, must read as failure.
  assert.equal(parseFactsResponse('["fact one", "fact tw'), null);
  assert.equal(parseFactsResponse(''), null);
});

test('categoryForSource maps crop_doctor to agronomy and everything else to business', () => {
  assert.equal(categoryForSource('crop_doctor'), 'agronomy');
  assert.equal(categoryForSource('conversation'), 'business');
  assert.equal(categoryForSource('web_research'), 'business');
  assert.equal(categoryForSource('periodic'), 'business');
  assert.equal(categoryForSource('teach'), 'business');
});

test('parseKbCallback accepts well-formed kb callbacks', () => {
  assert.deepEqual(parseKbCallback('kb:approve:42'), { action: 'approve', id: 42 });
  assert.deepEqual(parseKbCallback('kb:edit:0'), { action: 'edit', id: 0 });
  assert.deepEqual(parseKbCallback('kb:reject:7'), { action: 'reject', id: 7 });
});

test('parseKbCallback rejects malformed or foreign callbacks', () => {
  assert.equal(parseKbCallback(undefined), null);
  assert.equal(parseKbCallback(''), null);
  assert.equal(parseKbCallback('kb:approve'), null); // missing id
  assert.equal(parseKbCallback('kb:approve:42:extra'), null); // too many parts
  assert.equal(parseKbCallback('other:approve:42'), null); // wrong prefix
  assert.equal(parseKbCallback('kb:delete:42'), null); // unknown action
  assert.equal(parseKbCallback('kb:approve:abc'), null); // non-numeric id
  assert.equal(parseKbCallback('kb:approve:-1'), null); // negative id
});

test('normalizeFact lowercases, collapses whitespace, trims, drops trailing period', () => {
  assert.equal(normalizeFact('  Hello   World.  '), 'hello world');
  assert.equal(normalizeFact('Neem\tOil\nBulk'), 'neem oil bulk');
});

test('isDuplicate catches exact, case, and substring matches', () => {
  const existing = ['Urvar neem oil is FCO certified'];
  assert.equal(isDuplicate('Urvar neem oil is FCO certified', existing), true); // exact
  assert.equal(isDuplicate('urvar NEEM oil is fco certified.', existing), true); // case + period
  assert.equal(isDuplicate('neem oil is FCO certified', existing), true); // substring of existing
  assert.equal(isDuplicate('Urvar neem oil is FCO certified for all crops', existing), true); // superstring
});

test('isDuplicate allows genuinely new facts', () => {
  const existing = ['Urvar neem oil is FCO certified'];
  assert.equal(isDuplicate('Vermicompost ships in 5kg bags', existing), false);
  assert.equal(isDuplicate('anything', []), false);
});

test('isDuplicate treats empty/whitespace candidates as duplicates (not worth storing)', () => {
  assert.equal(isDuplicate('   ', ['x']), true);
  assert.equal(isDuplicate('', []), true);
});
