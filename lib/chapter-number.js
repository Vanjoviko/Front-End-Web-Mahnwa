'use strict';
// Kebijakan nomor chapter jalur scan-import (kontrak bersama dengan BE-13). Tidak memakai float.
const CANONICAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;

function isCanonical(value) { return typeof value === 'string' && CANONICAL.test(value); }

// "007" -> "7", "10.0" -> "10", "10.50" -> "10.5"; null bila bukan angka desimal non-negatif.
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [intPart, frac = ''] = text.split('.');
  const i = intPart.replace(/^0+/, '') || '0', f = frac.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

// Bandingkan dua string kanonik tanpa float. Mengembalikan -1/0/1; non-angka dianggap paling kecil.
function compare(a, b) {
  const ca = canonicalize(a), cb = canonicalize(b);
  if (ca === null && cb === null) return 0;
  if (ca === null) return -1;
  if (cb === null) return 1;
  const [ai, af = ''] = ca.split('.'), [bi, bf = ''] = cb.split('.');
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const len = Math.max(af.length, bf.length), pa = af.padEnd(len, '0'), pb = bf.padEnd(len, '0');
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}

// Urut menurun numerik (terbaru dulu), tanpa angka di akhir; stabil.
function sortDesc(items, key = x => x.number) {
  return items.map((item, index) => ({item, index, n: canonicalize(key(item))}))
    .sort((x, y) => (x.n === null && y.n === null) ? x.index - y.index : x.n === null ? 1 : y.n === null ? -1 : (compare(y.n, x.n) || x.index - y.index))
    .map(x => x.item);
}

module.exports = {CANONICAL, isCanonical, canonicalize, compare, sortDesc};
