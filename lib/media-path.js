'use strict';
// Normalisasi path permintaan statis SEBELUM keputusan akses (D-01). Keputusan akses dan pembacaan berkas memakai
// path yang sama (hasil normalisasi) sehingga `//`, `/./`, `%2e`, `%2f`, `\` , huruf besar/kecil, dan trailing slash
// tidak dapat melewati proteksi `/media/_drafts/` (khusus admin).

const MAX_DECODE_PASSES = 4;

function decodeFully(raw) {
  let cur = String(raw);
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next;
    try { next = decodeURIComponent(cur); } catch (error) {
      if (i === 0) return null;     // persen-encoding rusak pada lapisan pertama
      return cur;                    // lapisan berikutnya: pakai hasil terakhir yang valid
    }
    if (next === cur) return cur;
    cur = next;
  }
  return null;                       // di-encode berlapis berlebihan
}

// Mengembalikan {path, isDraft, isMedia} atau null bila path tidak valid (-> 400).
function resolveRequestPath(rawPathname) {
  const decoded = decodeFully(rawPathname);
  if (decoded === null || decoded.includes('\0')) return null;
  const segments = [];
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); continue; }
    segments.push(part);
  }
  const lower = segments.map(s => s.toLowerCase());
  const isMedia = lower[0] === 'media';
  // `_drafts` dicocokkan tanpa membedakan huruf besar/kecil (FS case-insensitive) dan tanpa syarat trailing slash.
  const isDraft = isMedia && lower[1] === '_drafts';
  return {path: '/' + segments.join('/'), segments, isMedia, isDraft};
}

module.exports = {resolveRequestPath};
