'use strict';
// Tes unit logika pencarian judul (PRD "Fitur Pencarian Judul", F3-F6).
const test = require('node:test');
const assert = require('node:assert/strict');
const {searchComics, normalizeQuery, normalizeLimit} = require('../lib/search');

const comics = [
  {id: 'langkah-kedua', title: 'Langkah Kedua', cover: '/media/a.png'},
  {id: 'senja-di-ujung-langit', title: 'Senja di Ujung Langit', cover: '/media/b.png'},
  {id: 'arsip-bulan-biru', title: 'Arsip Bulan Biru', cover: ''},
  {id: 'tanpa-sampul', title: 'Tanpa Sampul'},
  {id: 'diskon-50', title: 'Diskon 50% Spesial', cover: '/media/c.png'}
];

test('F3: kata kunci kurang dari 2 karakter setelah dipangkas -> tidak ada hasil', () => {
  assert.deepEqual(searchComics(comics, 'l'), []);
  assert.deepEqual(searchComics(comics, '  a  '), []);
  assert.deepEqual(searchComics(comics, ''), []);
  assert.deepEqual(searchComics(comics, null), []);
  assert.deepEqual(searchComics(comics, undefined), []);
});

test('F4/F5: cocok tanpa peduli huruf besar-kecil; diawali kata kunci lebih dulu', () => {
  assert.deepEqual(searchComics(comics, 'lang').map(r => r.id), ['langkah-kedua', 'senja-di-ujung-langit']);
  assert.deepEqual(searchComics(comics, 'BULAN').map(r => r.id), ['arsip-bulan-biru']);
});

test('F5: dalam kelompok "mengandung" hasil urut abjad', () => {
  assert.deepEqual(searchComics(comics, 'an').map(r => r.title), ['Arsip Bulan Biru', 'Langkah Kedua', 'Senja di Ujung Langit', 'Tanpa Sampul']);
});

test('F13: tidak ada yang cocok -> daftar kosong (bukan galat)', () => {
  assert.deepEqual(searchComics(comics, 'xyz'), []);
});

test('F6: hasil hanya id/title/cover; diawali keywords lalu urut; limit bawaan 5, maks 10', () => {
  const many = Array.from({length: 12}, (_, i) => ({id: `komik-${i}`, title: `Komik Nomor ${i}`, cover: `/c${i}.png`}));
  const res = searchComics(many, 'komik');
  assert.equal(res.length, 5, 'limit bawaan 5');
  assert.equal(searchComics(many, 'komik', 3).length, 3);
  assert.equal(searchComics(many, 'komik', 99).length, 10, 'limit maksimal 10');
  assert.deepEqual(Object.keys(res[0]).sort(), ['cover', 'id', 'title']);
  assert.deepEqual(searchComics(many, 'komik', 0).length, 5, 'limit tak valid -> bawaan');
  assert.deepEqual(searchComics(many, 'komik', '2').length, 2, 'limit string diparse');
});

test('% dan _ diperlakukan sebagai teks biasa, bukan wildcard', () => {
  assert.deepEqual(searchComics(comics, '50%').map(r => r.id), ['diskon-50']);
  assert.deepEqual(searchComics(comics, '%%'), []);
  assert.deepEqual(searchComics(comics, '__'), []);
});

test('q dipotong maksimal 100 karakter; spasi tepi dibuang', () => {
  assert.equal(normalizeQuery('a'.repeat(150)).length, 100);
  assert.equal(normalizeQuery('  kata  '), 'kata');
  assert.equal(normalizeLimit(undefined), 5);
  assert.equal(normalizeLimit('7'), 7);
  assert.equal(normalizeLimit(50), 10);
});

test('judul tanpa cover -> cover string kosong (placeholder CSS di UI)', () => {
  assert.deepEqual(searchComics(comics, 'tanpa')[0], {id: 'tanpa-sampul', title: 'Tanpa Sampul', cover: ''});
});
