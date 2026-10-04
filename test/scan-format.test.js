'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/scan-format');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('QA D-07: label halaman — "halaman" (bukan "hlm"), hanya untuk chapter COMPLETED', () => {
  assert.equal(F.pagesLabel({status: 'COMPLETED', pageCount: 24}), '24 halaman');
  assert.equal(F.pagesLabel({status: 'FAILED', pageCount: 2}), '');
  assert.equal(F.pagesLabel({status: 'CANCELLED', pageCount: 4}), '');
  assert.equal(F.pagesLabel({status: null, pageCount: 4}), '');
  assert.equal(F.pagesLabel({status: 'COMPLETED', pageCount: 0}), '');
});

test('QA D-07: progres per chapter — FAILED/CANCELLED tidak menampilkan hitungan parsial; total halaman mengabaikannya', () => {
  assert.equal(F.progressCount({status: 'FAILED', pagesDone: 1, pagesTotal: 2}), '—');
  assert.equal(F.progressCount({status: 'CANCELLED', pagesDone: 4, pagesTotal: 6}), '—');
  assert.equal(F.progressCount({status: 'DOWNLOADING', pagesDone: 4, pagesTotal: 6}), '4/6');
  assert.equal(F.progressCount({status: 'COMPLETED', pagesDone: 6, pagesTotal: 6}), '6/6');
  assert.equal(F.progressCount({status: 'QUEUED', pagesDone: 0, pagesTotal: 0}), '—');
  const t = F.displayTotals({chapters: [{status: 'COMPLETED', pagesDone: 6, pagesTotal: 6}, {status: 'FAILED', pagesDone: 1, pagesTotal: 2}, {status: 'CANCELLED', pagesDone: 4, pagesTotal: 6}, {status: 'DOWNLOADING', pagesDone: 2, pagesTotal: 5}]});
  assert.deepEqual(t, {pagesDone: 8, pagesTotal: 11});
});

test('QA D-08: badge "perlu nomor" dan "nomor wajib diisi" tidak ditampilkan bersamaan; duplikat dibuang', () => {
  assert.deepEqual(F.visibleIssues(['needs_number', 'number_required']), ['number_required']);
  assert.deepEqual(F.visibleIssues(['needs_number']), ['needs_number']);
  assert.deepEqual(F.visibleIssues(['duplicate_number', 'duplicate_number', 'prolog']), ['duplicate_number', 'prolog']);
  assert.deepEqual(F.visibleIssues(undefined), []);
});

test('QA D-07/D-08: UI memakai ScanFormat, label spec, dan urutan konfirmasi-sebelum-simpan pada Publish', () => {
  const ui = read('scan-import.js');
  assert.equal(F.RETRY_ALL_LABEL, 'Coba ulang semua yang gagal');
  assert.ok(ui.includes('ScanFormat.RETRY_ALL_LABEL'));
  assert.ok(!ui.includes('Ulangi semua yang gagal'));
  assert.ok(!/\bhlm\b/.test(ui), 'label "hlm" harus diganti "halaman"');
  assert.ok(ui.includes('ScanFormat.pagesLabel') && ui.includes('ScanFormat.progressCount') && ui.includes('ScanFormat.displayTotals') && ui.includes('ScanFormat.visibleIssues'));
  // badge dipisah spasi (tidak menyatu "perlu nomornomor wajib diisi")
  assert.match(ui, /visibleIssues\(list\)\.map\([^)]*\)[^;]*\.join\(' '\)/);
  // Publish: confirm() dipanggil SEBELUM save() (Batal tidak menyimpan perubahan)
  const pub = ui.slice(ui.indexOf("b.id==='fin-publish'"), ui.indexOf("b.id==='fin-discard'"));
  assert.ok(pub.indexOf('confirm(') > -1 && pub.indexOf('await save(') > pub.indexOf('confirm('), 'confirm harus sebelum save');
  // kesalahan polling ditampilkan ke pengguna
  assert.ok(ui.includes('S.pollError') && ui.includes('Gagal memuat progres'));
  // skrip dimuat sebelum scan-import.js
  const html = read('index.html');
  assert.ok(html.indexOf('/scan-format.js') > -1 && html.indexOf('/scan-format.js') < html.indexOf('/scan-import.js'));
});

test('QA D-06: CSS finalisasi mencegah grid item melebar di layar sempit (verifikasi visual: mockups/check_mobile_overflow.py)', () => {
  const css = read('styles.css');
  assert.match(css, /#fin-root \.detail-hero>\.detail-copy\{[^}]*min-width:0/);
  assert.match(css, /#fin-root \.fin-facts\{[^}]*flex-wrap:wrap/);
  assert.match(css, /@media\(max-width:560px\)\{#fin-root \.detail-hero\{grid-template-columns:1fr/);
});

test('QA D-09 (opsional): galat polling selalu berbahasa Indonesia', () => {
  assert.equal(F.pollErrorMessage(new TypeError('Failed to fetch')), 'Tidak dapat terhubung ke server.');
  assert.equal(F.pollErrorMessage(new Error('NetworkError when attempting to fetch resource.')), 'Tidak dapat terhubung ke server.');
  assert.equal(F.pollErrorMessage(Object.assign(new Error('Layanan scan tidak dapat dihubungi.'), {code: 'WORKER_UNAVAILABLE', status: 502})), 'Layanan scan tidak dapat dihubungi.');
  assert.equal(F.pollErrorMessage(Object.assign(new Error('Silakan masuk menggunakan akun admin.'), {status: 401})), 'Silakan masuk menggunakan akun admin.');
  assert.equal(F.pollErrorMessage(new SyntaxError('Unexpected token < in JSON')), 'Terjadi kesalahan saat memuat progres.');
  assert.equal(F.pollErrorMessage(undefined), 'Tidak dapat terhubung ke server.');
  assert.ok(read('scan-import.js').includes('ScanFormat.pollErrorMessage(e)'));
});
