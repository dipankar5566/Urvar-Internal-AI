import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKbCallback, normalizeFact, isDuplicate } from '../../src/rag/learned-util.js';

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
