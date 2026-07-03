import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeadKey, isLeadStatus } from '../../src/leads/util.js';

test('same business with different legal-form suffixes collapses to one key', () => {
  const a = normalizeLeadKey('M/s Green Agro Pvt. Ltd.', 'Kolkata, West Bengal');
  const b = normalizeLeadKey('Green Agro Private Limited', 'Kolkata — West Bengal');
  assert.equal(a, b);
});

test('punctuation, casing, and whitespace noise do not change the key', () => {
  const a = normalizeLeadKey('  SHREE   Balaji Traders ', 'Ranaghat,West Bengal');
  const b = normalizeLeadKey('Shree Balaji  traders', 'Ranaghat, West Bengal');
  assert.equal(a, b);
});

test('different locations produce different keys', () => {
  const a = normalizeLeadKey('Green Agro', 'Kolkata');
  const b = normalizeLeadKey('Green Agro', 'Howrah');
  assert.notEqual(a, b);
});

test('different business names produce different keys', () => {
  const a = normalizeLeadKey('Green Agro', 'Kolkata');
  const b = normalizeLeadKey('Blue Agro', 'Kolkata');
  assert.notEqual(a, b);
});

test('isLeadStatus accepts pipeline statuses and rejects everything else', () => {
  assert.ok(isLeadStatus('new'));
  assert.ok(isLeadStatus('contacted'));
  assert.ok(isLeadStatus('converted'));
  assert.ok(!isLeadStatus('archived'));
  assert.ok(!isLeadStatus(''));
});
