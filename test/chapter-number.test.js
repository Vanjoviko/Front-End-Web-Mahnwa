'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {canonicalize, compare, sortDesc, isCanonical} = require('../lib/chapter-number');

test('kanonikalisasi tanpa float', () => {
  const table = {'7': '7', '007': '7', '10.0': '10', '10.50': '10.5', '1.10': '1.1', '0': '0', '00': '0', '8.5': '8.5', '12345678901234567890.5': '12345678901234567890.5'};
  for (const [input, want] of Object.entries(table)) assert.equal(canonicalize(input), want, input);
  for (const bad of ['', 'abc', '-1', '1,5', '1e3', ' ', null, undefined, '1.', '.5', '1.2.3']) assert.equal(canonicalize(bad), null, String(bad));
});
test('isCanonical', () => {
  assert.ok(isCanonical('10.5')); assert.ok(isCanonical('0'));
  assert.ok(!isCanonical('010')); assert.ok(!isCanonical('1.0')); assert.ok(!isCanonical(5));
});
test('urutan numerik menurun: 10 > 9 > 2 > 1.5 dan null di akhir', () => {
  const items = ['1', '10', '2', '9', '1.5', null, '0', '10.5'].map(number => ({number}));
  assert.deepEqual(sortDesc(items).map(x => x.number), ['10.5', '10', '9', '2', '1.5', '1', '0', null]);
});
test('compare 1.10 == 1.1 dan 2 < 10', () => {
  assert.equal(compare('1.10', '1.1'), 0);
  assert.equal(compare('2', '10'), -1);
  assert.equal(compare('10', '2'), 1);
});
