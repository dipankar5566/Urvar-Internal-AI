import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeadKey, isLeadStatus, buildEnrichmentPrompt, buildPitchPrompt, buildCallSheetPrompt, formatFunnel, hasPhoneNumber } from '../../src/leads/util.js';

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

test('hasPhoneNumber detects Indian mobiles and landlines in contact strings', () => {
  assert.ok(hasPhoneNumber('Parameswar Mondal (Director): 8910963144 | parameswar921@gmail.com'));
  assert.ok(hasPhoneNumber('+91 89109 63144'));
  assert.ok(hasPhoneNumber('033-2654 3210'));
});

test('hasPhoneNumber ignores addresses, PIN codes, and directory stubs', () => {
  assert.ok(!hasPhoneNumber('12, Palghat Lane, Belur, Howrah — 711202'));
  assert.ok(!hasPhoneNumber('Listed on IndiaMART — View Mobile Number on IndiaMART profile'));
  assert.ok(!hasPhoneNumber('Near Zumarjala Stadium, Chakraberia, Howrah'));
  assert.ok(!hasPhoneNumber(''));
});

test('buildPitchPrompt identifies the lead and asks for WhatsApp intro + call opener', () => {
  const prompt = buildPitchPrompt({
    id: 12,
    name: 'Bally Nursery',
    type: 'nursery',
    location: 'Bally, West Bengal',
    contact: '+91 89109 63144',
    fit_reason: 'Sells organic inputs to home gardeners',
  });
  assert.ok(prompt.includes('lead #12: Bally Nursery — nursery, Bally, West Bengal'));
  assert.ok(prompt.includes('contact: +91 89109 63144'));
  assert.ok(prompt.includes('fit: Sells organic inputs to home gardeners'));
  assert.ok(prompt.includes('WhatsApp intro'));
  assert.ok(prompt.includes('Call opener'));
  assert.ok(prompt.includes('nursery')); // type-matched angle
});

test('buildPitchPrompt omits contact/fit lines when the lead has none', () => {
  const prompt = buildPitchPrompt({ id: 4, name: 'Green Agro', type: 'retailer', location: 'Howrah' });
  assert.ok(prompt.includes('lead #4: Green Agro — retailer, Howrah'));
  assert.ok(!prompt.includes('contact:'));
  assert.ok(!prompt.includes('fit:'));
});

test('buildCallSheetPrompt lists all leads in order and forbids invented numbers', () => {
  const prompt = buildCallSheetPrompt([
    { id: 3, name: 'Howrah Agro Centre', type: 'retailer', location: 'Howrah', contact: '9830012345' },
    { id: 9, name: 'Nadia FPO', type: 'FPO', location: 'Nadia', contact: '+91 98300 54321' },
  ]);
  assert.ok(prompt.indexOf('lead #3') < prompt.indexOf('lead #9'));
  assert.ok(prompt.includes('never invent one'));
  assert.ok(prompt.includes('Order the leads exactly as given'));
});

test('formatFunnel shows all active stages and hides dead when zero', () => {
  const line = formatFunnel({ new: 5, contacted: 2, converted: 1 });
  assert.ok(line.includes('5 new'));
  assert.ok(line.includes('2 contacted'));
  assert.ok(line.includes('0 responded'));
  assert.ok(line.includes('1 converted'));
  assert.ok(!line.includes('dead'));
  assert.ok(formatFunnel({ new: 1, dead: 3 }).includes('3 dead'));
});

test('buildEnrichmentPrompt lists every lead with its id and directs to update_lead', () => {
  const prompt = buildEnrichmentPrompt([
    { id: 3, name: 'Howrah Agro Centre', type: 'retailer', location: 'Howrah, West Bengal' },
    { id: 7, name: 'Bally Nursery', type: 'nursery', location: 'Bally, West Bengal' },
  ]);
  assert.ok(prompt.includes('lead id 3: Howrah Agro Centre — retailer, Howrah, West Bengal'));
  assert.ok(prompt.includes('lead id 7: Bally Nursery — nursery, Bally, West Bengal'));
  assert.ok(prompt.includes('update_lead'));
  assert.ok(prompt.includes('Do NOT call save_lead'));
});
