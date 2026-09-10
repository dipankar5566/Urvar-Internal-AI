import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPhoneNumber } from '../../src/leads/util.js';
import {
  extractPhoneNumber,
  splitLocation,
  mapLeadToExportRow,
  LEAD_EXPORT_COLUMNS,
} from '../../src/leads/export.js';

test('extractPhoneNumber agrees with hasPhoneNumber and returns digits only', () => {
  const phoneStrings = [
    'Parameswar Mondal (Director): 8910963144 | parameswar921@gmail.com',
    '+91 89109 63144',
    '033-2654 3210',
  ];
  for (const s of phoneStrings) {
    assert.equal(hasPhoneNumber(s), true);
    const phone = extractPhoneNumber(s);
    assert.notEqual(phone, null);
    assert.ok(/^\+?\d+$/.test(phone as string));
  }
});

test('extractPhoneNumber returns null for addresses, PIN codes, and directory stubs', () => {
  const nonPhoneStrings = [
    '12, Palghat Lane, Belur, Howrah — 711202',
    'Listed on IndiaMART — View Mobile Number on IndiaMART profile',
    'Near Zumarjala Stadium, Chakraberia, Howrah',
    '',
  ];
  for (const s of nonPhoneStrings) {
    assert.equal(hasPhoneNumber(s), false);
    assert.equal(extractPhoneNumber(s), null);
  }
  assert.equal(extractPhoneNumber(null), null);
  assert.equal(extractPhoneNumber(undefined), null);
});

test('splitLocation splits "City, State" into district and state', () => {
  assert.deepEqual(splitLocation('Kolkata, West Bengal'), { district: 'Kolkata', state: 'West Bengal' });
});

test('splitLocation with no comma puts everything in district', () => {
  assert.deepEqual(splitLocation('Howrah'), { district: 'Howrah', state: '' });
});

test('splitLocation trims surrounding whitespace', () => {
  assert.deepEqual(splitLocation('  Ranaghat ,  West Bengal  '), { district: 'Ranaghat', state: 'West Bengal' });
});

test('splitLocation only honors the first comma (known limitation)', () => {
  assert.deepEqual(splitLocation('Bally, Howrah, West Bengal'), {
    district: 'Bally',
    state: 'Howrah, West Bengal',
  });
});

test('mapLeadToExportRow maps a full lead to the CRM column order', () => {
  const row = mapLeadToExportRow({
    id: 1,
    name: 'Green Agro Traders',
    type: 'distributor',
    location: 'Ranaghat, West Bengal',
    contact: '+91 89109 63144',
    fit_reason: 'Strong reach into local FPOs',
  });
  assert.equal(row.length, 18);
  assert.equal(row[0], 'Green Agro Traders'); // Name *
  assert.ok(row[1] && /^\+?\d+$/.test(row[1])); // Phone *
  assert.equal(row[2], ''); // Lead Source
  assert.equal(row[3], 'distributor'); // Customer Type
  assert.equal(row[4], 'West Bengal'); // State *
  assert.equal(row[5], 'Ranaghat'); // District *
  assert.equal(row[6], 'Green Agro Traders'); // Company Name
  assert.equal(row[7], ''); // Contact Person
  assert.equal(row[8], ''); // WhatsApp Number
  assert.equal(row[9], ''); // Email
  assert.equal(row[10], ''); // Pincode
  assert.equal(row[11], ''); // Address (contact was a phone, so blank)
  assert.equal(row[12], ''); // Interested Products
  assert.equal(row[13], ''); // Expected Quantity
  assert.equal(row[14], ''); // Expected Monthly Value
  assert.equal(row[15], ''); // Estimated Value
  assert.equal(row[16], ''); // Crop Interest
  assert.equal(row[17], 'Strong reach into local FPOs'); // Remarks
});

test('mapLeadToExportRow puts a non-phone contact into Address and leaves Phone blank', () => {
  const row = mapLeadToExportRow({
    id: 2,
    name: 'Howrah Agro Centre',
    type: 'retailer',
    location: 'Howrah',
    contact: 'Near Zumarjala Stadium, Chakraberia, Howrah',
  });
  assert.equal(row[1], '');
  assert.equal(row[11], 'Near Zumarjala Stadium, Chakraberia, Howrah');
});

test('mapLeadToExportRow leaves Phone/Address/Remarks blank when there is nothing to map', () => {
  const row = mapLeadToExportRow({ id: 3, name: 'Bally Nursery', type: 'nursery', location: 'Bally' });
  assert.equal(row[1], '');
  assert.equal(row[11], '');
  assert.equal(row[17], '');
});

test('LEAD_EXPORT_COLUMNS matches the CRM template header row exactly', () => {
  assert.deepEqual([...LEAD_EXPORT_COLUMNS], [
    'Name *',
    'Phone *',
    'Lead Source',
    'Customer Type',
    'State *',
    'District *',
    'Company Name',
    'Contact Person',
    'WhatsApp Number',
    'Email',
    'Pincode',
    'Address',
    'Interested Products',
    'Expected Quantity',
    'Expected Monthly Value',
    'Estimated Value',
    'Crop Interest',
    'Remarks',
  ]);
});
