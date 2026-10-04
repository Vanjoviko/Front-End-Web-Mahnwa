'use strict';
const {mediaDir} = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {ingestChapter, scanLimits, sniffImage, decodeCoverDataUrl, draftChapterDir} = require('../lib/scan-media');
const {makeImage, sha256} = require('./helpers/images');

const LIM = scanLimits({});
const resp = buf => new Response(buf);
const page = (buf, n, extra = {}) => ({page_number: n, content_type: 'image/png', bytes: buf.length, sha256: sha256(buf), ...extra});
const exists = p => fs.access(p).then(() => true, () => false);

test('limit default scan = 300 / 150 MiB / 15 MiB (terpisah dari upload manual)', () => {
  assert.deepEqual(LIM, {maxPages: 300, maxChapterBytes: 157286400, maxImageBytes: 15728640, maxCoverBytes: 5_000_000});
});

test('ingest sukses: urutan 001..N, ekstensi dari magic byte, bukan dari content-type/URL', async () => {
  const bufs = [makeImage('png', 1000, 1), makeImage('jpg', 1200, 2), makeImage('webp', 1400, 3)];
  const manifest = {pages: bufs.map((b, i) => page(b, i + 1, {content_type: ['image/png', 'image/jpeg', 'image/webp'][i]}))};
  const r = await ingestChapter({draftId: 'd_ok', key: 'c_0001', manifest, limits: LIM, openPage: async n => resp(bufs[n - 1])});
  assert.deepEqual(r.pages.map(p => p.image_url), ['/media/_drafts/d_ok/c_0001/001.png', '/media/_drafts/d_ok/c_0001/002.jpg', '/media/_drafts/d_ok/c_0001/003.webp']);
  assert.deepEqual(Object.keys(r.pages[0]).sort(), ['image_url', 'page_number']);
  const files = (await fs.readdir(draftChapterDir('d_ok', 'c_0001'))).sort();
  assert.deepEqual(files, ['001.png', '002.jpg', '003.webp']);
  assert.equal(r.bytes, 3600);
});

async function expectFail(code, manifest, openPage, label) {
  const dir = draftChapterDir('d_fail', 'c_0001');
  await assert.rejects(ingestChapter({draftId: 'd_fail', key: 'c_0001', manifest, limits: LIM, openPage}), e => e.code === code, label);
  assert.equal(await exists(dir), false, `${label}: berkas harus dibersihkan`);
}

test('LIMIT_PAGES: halaman ke-301 ditolak sebelum ada unduhan; 300 halaman diterima', async () => {
  const buf = makeImage('png', 100, 5);
  let calls = 0;
  await expectFail('LIMIT_PAGES', {pages: Array.from({length: 301}, (_, i) => page(buf, i + 1))}, async () => { calls++; return resp(buf); }, '301 halaman');
  assert.equal(calls, 0);
  const ok = await ingestChapter({draftId: 'd_300', key: 'c_0001', manifest: {pages: Array.from({length: 300}, (_, i) => page(buf, i + 1))}, limits: LIM, openPage: async () => resp(buf)});
  assert.equal(ok.pages.length, 300);
});
test('LIMIT_IMAGE_BYTES: satu gambar > 15 MiB ditolak (deklarasi dan stream)', async () => {
  const buf = makeImage('png', 100, 5);
  await expectFail('LIMIT_IMAGE_BYTES', {pages: [{...page(buf, 1), bytes: 15 * 1048576 + 1}]}, async () => resp(buf), 'deklarasi');
  // manifest berbohong kecil, stream sebenarnya besar -> berhenti saat streaming
  const big = makeImage('png', 15 * 1048576 + 10, 6);
  await expectFail('LIMIT_IMAGE_BYTES', {pages: [{...page(buf, 1), bytes: 15 * 1048576}]}, async () => resp(big), 'stream');
});
test('LIMIT_CHAPTER_BYTES: total melebihi 150 MiB ditolak', async () => {
  const buf = makeImage('png', 100, 5);
  const pages = Array.from({length: 11}, (_, i) => ({...page(buf, i + 1), bytes: 14 * 1048576}));
  await expectFail('LIMIT_CHAPTER_BYTES', {pages}, async () => resp(buf), '11 x 14 MiB');
});
test('INTEGRITY: sha256 tidak cocok / ukuran tidak cocok / nomor halaman loncat', async () => {
  const buf = makeImage('png', 500, 7);
  await expectFail('INTEGRITY', {pages: [{...page(buf, 1), sha256: '0'.repeat(64)}]}, async () => resp(buf), 'sha');
  await expectFail('INTEGRITY', {pages: [{...page(buf, 1), bytes: buf.length + 5}]}, async () => resp(buf), 'ukuran lebih besar dari stream');
  await expectFail('INTEGRITY', {pages: [{...page(buf, 1), bytes: buf.length - 5}]}, async () => resp(buf), 'ukuran lebih kecil dari stream');
  await expectFail('INTEGRITY', {pages: [page(buf, 2)]}, async () => resp(buf), 'nomor loncat');
});
test('UNSUPPORTED_IMAGE_FORMAT: isi bukan JPEG/PNG/WebP (mis. HTML/GIF) ditolak', async () => {
  const html = Buffer.from('<html>captcha</html>'.padEnd(200, ' '));
  await expectFail('UNSUPPORTED_IMAGE_FORMAT', {pages: [page(html, 1)]}, async () => resp(html), 'html');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
  await expectFail('UNSUPPORTED_IMAGE_FORMAT', {pages: [page(gif, 1)]}, async () => resp(gif), 'gif');
});
test('INTEGRITY: content_type manifest tidak cocok dengan isi', async () => {
  const buf = makeImage('png', 500, 7);
  await expectFail('INTEGRITY', {pages: [{...page(buf, 1), content_type: 'image/jpeg'}]}, async () => resp(buf), 'ct');
});
test('kegagalan di halaman ke-3 membersihkan seluruh chapter (all-or-nothing)', async () => {
  const bufs = [makeImage('png', 300, 1), makeImage('png', 300, 2), makeImage('png', 300, 3)];
  const bad = {pages: bufs.map((b, i) => page(b, i + 1))};
  await expectFail('INTEGRITY', {pages: [bad.pages[0], bad.pages[1], {...bad.pages[2], sha256: 'f'.repeat(64)}]}, async n => resp(bufs[n - 1]), 'p3');
});

// Bangkitkan stream besar tanpa menahan seluruhnya di memori; hitung sha256 sambil jalan.
function generated(size, chunk = 64 * 1024, seed = 1) {
  const head = makeImage('png', 16, seed).subarray(0, 8);
  const hash = crypto.createHash('sha256');
  const block = Buffer.alloc(chunk, seed);
  const pieces = [];
  let sent = 0;
  const first = Buffer.concat([head, block.subarray(0, chunk - 8)]);
  const plan = [];
  let left = size;
  while (left > 0) { const take = Math.min(left, chunk); plan.push(take); left -= take; }
  plan.forEach((take, i) => { const piece = i === 0 ? first.subarray(0, take) : block.subarray(0, take); hash.update(piece); });
  const digest = hash.digest('hex');
  const stream = () => Readable.from((async function* () { for (const [i, take] of plan.entries()) { yield i === 0 ? first.subarray(0, take) : block.subarray(0, take); await new Promise(r => setImmediate(r)); } })());
  return {size, sha: digest, response: () => new Response(Readable.toWeb(stream()))};
}

test('chapter 300 halaman total tepat 150 MiB (tiap gambar 512 KiB) -> COMPLETED', async () => {
  const gens = Array.from({length: 300}, (_, i) => generated(524288, 65536, (i % 200) + 1));
  const manifest = {pages: gens.map((g, i) => ({page_number: i + 1, content_type: 'image/png', bytes: g.size, sha256: g.sha}))};
  assert.equal(gens.reduce((a, g) => a + g.size, 0), LIM.maxChapterBytes);
  const r = await ingestChapter({draftId: 'd_150', key: 'c_0001', manifest, limits: LIM, openPage: async n => gens[n - 1].response()});
  assert.equal(r.pages.length, 300);
  assert.equal(r.bytes, 157286400);
  await fs.rm(path.join(mediaDir, '_drafts', 'd_150'), {recursive: true, force: true});
});

test('sniffImage & decodeCoverDataUrl', () => {
  assert.equal(sniffImage(makeImage('jpg', 20, 1)).ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.throws(() => decodeCoverDataUrl('data:image/png;base64,' + Buffer.from('bukan png').toString('base64')), e => e.code === 'UNSUPPORTED_IMAGE_FORMAT');
  const big = 'data:image/png;base64,' + makeImage('png', 5_000_001, 1).toString('base64');
  assert.throws(() => decodeCoverDataUrl(big), e => e.code === 'COVER_TOO_LARGE');
  assert.ok(decodeCoverDataUrl('data:image/png;base64,' + makeImage('png', 400, 1).toString('base64')).length === 400);
});
