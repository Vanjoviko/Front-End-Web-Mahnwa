'use strict';
// Pencarian judul untuk endpoint /api/search (PRD "Fitur Pencarian Judul", F3-F6).
// Fungsi murni tanpa I/O agar mudah diuji dan dipakai ulang. Pencocokan hanya pada
// judul utama (bukan judul alternatif/penulis/genre), case-insensitive, cocok di posisi mana pun.
const MAX_QUERY = 100;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// q dipangkas dan dibersihkan dari karakter kontrol; dipotong maksimal 100 karakter.
function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_QUERY);
}

// Batas hasil: bawaan 5, minimal 1, maksimal 10.
function normalizeLimit(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Kata kunci < 2 karakter -> daftar kosong (bukan galat). Urutan: judul yang diawali
// kata kunci lebih dulu, lalu yang mengandungnya; di tiap kelompok urut abjad.
function searchComics(comics, q, limit) {
  const query = normalizeQuery(q);
  if (query.length < 2) return [];
  const needle = query.toLowerCase();
  const matches = [];
  for (const comic of Array.isArray(comics) ? comics : []) {
    const title = typeof comic?.title === 'string' ? comic.title : '';
    if (!title) continue;
    const at = title.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    matches.push({id: comic.id, title, cover: typeof comic.cover === 'string' ? comic.cover : '', starts: at === 0});
  }
  matches.sort((a, b) => (a.starts === b.starts ? a.title.localeCompare(b.title, 'id') : a.starts ? -1 : 1));
  return matches.slice(0, normalizeLimit(limit)).map(({id, title, cover}) => ({id, title, cover}));
}

module.exports = {searchComics, normalizeQuery, normalizeLimit, MAX_QUERY, DEFAULT_LIMIT, MAX_LIMIT};
