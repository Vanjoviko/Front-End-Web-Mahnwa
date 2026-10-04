'use strict';
const H = require('./helpers/harness');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {publicCatalog} = require('../lib/public-catalog');
const {makeImage} = require('./helpers/images');

const URL1 = 'https://sumber.example/seri-a/manifest.json';
const exists = p => fs.access(p).then(() => true, () => false);
const media = (...p) => path.join(H.mediaDir, ...p);
let cleanups = [];
test.afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
async function harness(opts) { const h = await H.makeHarness(opts); cleanups.push(() => h.worker.close()); return h; }

test('scan menghasilkan draft tersembunyi: tidak masuk katalog publik; DRAFT_EXISTS pada scan ulang URL yang sama', async () => {
  const h = await harness();
  h.worker.setScan(URL1, H.scanResult({url: URL1, numbers: [3, 2, 1]}));
  const d = await h.service.scan(URL1);
  assert.match(d.draftId, /^d_[0-9a-f]{16}$/);
  assert.equal(d.state, 'SCANNED');
  assert.equal(d.adapterLabel, 'Manifest JSON');
  assert.equal(d.counts.total, 3);
  assert.ok(d.comic.cover.startsWith('/media/_drafts/' + d.draftId + '/cover-'));
  assert.equal(await exists(media('_drafts', d.draftId, path.basename(d.comic.cover))), true);
  const cat = publicCatalog(h.state.db);
  assert.equal(cat.comics.length, 0, 'draft tidak boleh muncul di katalog');
  assert.ok(!JSON.stringify(cat).includes(d.draftId));
  assert.ok(!('ref' in d.chapters[0]), 'ref internal tidak boleh bocor ke browser');
  await assert.rejects(h.service.scan(URL1), e => e.status === 409 && e.code === 'DRAFT_EXISTS' && e.extra.draftId === d.draftId);
  assert.equal(h.worker.state.staged.size, 0, 'staging cover worker dibersihkan');
});

test('Download All -> READY; hanya status disimpan saat transisi; staging chapter worker dihapus setelah ingest', async () => {
  const saves = [];
  const h = await harness({saveHook: () => saves.push(1)});
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  await assert.rejects(h.service.startDownload(d.draftId, {}), e => e.status === 409 && e.code === 'JOB_ALREADY_RUNNING');
  const done = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(done.counts.completed, 3);
  assert.ok(done.chapters.every(c => c.status === 'COMPLETED' && c.pageCount >= 3));
  for (const c of done.chapters) assert.equal(await exists(media('_drafts', d.draftId, c.key, '001.png')), true);
  assert.equal(h.worker.state.deletedChapters.length, 3);
  await H.until(() => h.worker.state.deletedJobs.length === 1, {label: 'job dihapus di worker'});
  // 1 scan + 1 start + (3 DOWNLOADING + 3 COMPLETED) + finish; tidak ada tulis per-halaman/per-tick
  assert.ok(saves.length <= 14, `terlalu banyak penulisan db: ${saves.length}`);
  const prog = await h.service.progress(d.draftId);
  assert.equal(prog.state, 'READY');
  assert.equal(prog.totals.completed, 3);
  assert.equal(prog.totals.pagesDone, prog.totals.pagesTotal);
});

test('permintaan ke worker membawa X-Worker-Token, tanpa Cookie; URL halaman dari manifest tidak diikuti', async () => {
  const h = await harness();
  const d = await H.scanAndDownload(h, URL1, {numbers: [1]});
  await H.waitState(h, d.draftId, ['READY']);
  const reqs = h.worker.state.requests.filter(r => r.path.startsWith('/worker/v1'));
  assert.ok(reqs.length > 5);
  assert.ok(reqs.every(r => r.headers['x-worker-token'] === 'test-token' && !r.headers.cookie && !r.headers.authorization));
  assert.ok(!h.worker.state.requests.some(r => r.headers.host?.includes('evil.invalid')));
});

test('worker menolak token -> 502 WORKER_UNAVAILABLE (bukan 401 yang akan dikira logout admin)', async () => {
  const h = await harness();
  const bad = require('../lib/scan-worker').createWorkerClient({baseUrl: h.worker.url, token: 'salah'});
  await assert.rejects(bad.scan('https://x.example/a.json'), e => e.status === 502 && e.code === 'WORKER_UNAVAILABLE');
});

test('chapter gagal di worker -> FAILED; retry per chapter berhasil tanpa EEXIST; lalu publish', async () => {
  const h = await harness();
  h.worker.plan('c_0002', {fail: 'HTTP_ERROR'});
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  let v = await H.waitState(h, d.draftId, ['READY']);
  assert.deepEqual(v.chapters.map(c => c.status), ['COMPLETED', 'FAILED', 'COMPLETED']);
  assert.equal(v.chapters[1].errorCode, 'HTTP_ERROR');
  await assert.rejects(h.service.publish(d.draftId), e => e.code === 'CHAPTER_NOT_READY' && e.extra.keys.includes('c_0002'));
  h.worker.plan('c_0002', {fail: null});
  await h.service.retryChapter(d.draftId, 'c_0002');
  v = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v.chapters[1].status, 'COMPLETED');
  const retryAgain = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(retryAgain.counts.completed, 3);
  const r = await h.service.publish(d.draftId);
  assert.equal(r.chaptersPublished, 3);
});

test('mode failed-only hanya mengunduh yang gagal; chapter selesai tidak diunduh ulang', async () => {
  const h = await harness();
  h.worker.plan('c_0001', {fail: 'HTTP_ERROR'}); h.worker.plan('c_0003', {fail: 'HTTP_ERROR'});
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  await H.waitState(h, d.draftId, ['READY']);
  h.worker.plan('c_0001', {fail: null}); h.worker.plan('c_0003', {fail: null});
  const r = await h.service.startDownload(d.draftId, {mode: 'failed-only'});
  assert.deepEqual(r.keys.sort(), ['c_0001', 'c_0003']);
  const v = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v.counts.completed, 3);
});

test('publish: validasi (nomor wajib, ganda, belum siap, kosong) lalu kontrak data + berkas + urutan numerik', async () => {
  const h = await harness();
  const d = await H.scanAndDownload(h, URL1, {numbers: [10, 9, 2, 1], extra: true});
  await H.waitState(h, d.draftId, ['READY']);
  await assert.rejects(h.service.publish(d.draftId), e => e.status === 409 && e.code === 'CHAPTER_NUMBER_REQUIRED' && e.extra.keys.length === 1);
  // dua chapter bernomor sama 5 -> 409 + keys
  await h.service.patch(d.draftId, {chapters: [{key: 'c_0005', number: '5'}, {key: 'c_0004', number: '5'}, {key: 'c_0003', number: '2'}]});
  await assert.rejects(h.service.publish(d.draftId), e => e.code === 'DUPLICATE_CHAPTER_NUMBER' && e.extra.keys.sort().join() === 'c_0004,c_0005');
  // perbaiki: beri nomor, Extra dikeluarkan
  await h.service.patch(d.draftId, {chapters: [{key: 'c_0004', number: '1.5'}, {key: 'c_0005', excluded: true}]});
  const draftChapterFiles = media('_drafts', d.draftId);
  const res = await h.service.publish(d.draftId, {});
  assert.equal(res.created, true);
  assert.equal(res.chaptersPublished, 4);
  const comic = h.state.db.comics.find(c => c.id === res.comicId);
  assert.ok(comic);
  assert.deepEqual(comic.chapters.map(c => c.number), ['10', '9', '2', '1.5']); // numerik menurun, bukan leksikografis
  assert.equal(comic.source, 'Scan Import · Manifest JSON');
  assert.ok(comic.storageKey && comic.id.startsWith('seri-uji-orisinal-'));
  assert.deepEqual(comic.scanSource.adapter, 'manifest');
  for (const ch of comic.chapters) {
    assert.equal(ch.status, 'COMPLETED');
    assert.equal(typeof ch.number, 'string');
    assert.match(ch.id, /^[0-9a-f-]{36}$/);
    assert.ok(ch.pages.length >= 3);
    for (const [i, p] of ch.pages.entries()) {
      assert.deepEqual(Object.keys(p).sort(), ['image_url', 'page_number']); // kontrak: bukan {page,url}
      assert.equal(p.page_number, i + 1);
      assert.ok(p.image_url.startsWith(`/media/${comic.storageKey}/chapters/chapter-${ch.number.replace('.', '-')}/`), p.image_url);
      assert.equal(await exists(path.join(H.dataDir, p.image_url)), true, p.image_url + ' harus ada di disk');
    }
  }
  assert.ok(comic.cover.startsWith(`/media/${comic.storageKey}/cover-`));
  assert.equal(await exists(path.join(H.dataDir, comic.cover)), true);
  assert.equal(await exists(draftChapterFiles), false, 'direktori draft dibersihkan setelah publish');
  assert.equal(publicCatalog(h.state.db).comics.length, 1);
  await assert.rejects(h.service.publish(d.draftId), e => e.status === 409 && e.code === 'ALREADY_PUBLISHED');
  await assert.rejects(h.service.startDownload(d.draftId, {}), e => e.code === 'ALREADY_PUBLISHED');
});

test('publish atomik: gagal simpan db -> komik tidak muncul, berkas kembali ke draft, draft tetap READY', async () => {
  const h = await harness();
  const d = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.waitState(h, d.draftId, ['READY']);
  await H.wait(60);
  const publicBefore = (await fs.readdir(H.mediaDir)).filter(x => x !== '_drafts').sort();
  h.state.failSave = 1;
  await assert.rejects(h.service.publish(d.draftId), e => e.code === 'PUBLISH_FAILED' && e.status === 500);
  assert.equal(h.state.db.comics.length, 0);
  const v = await h.service.get(d.draftId);
  assert.equal(v.state, 'READY');
  assert.equal(v.counts.completed, 2);
  for (const c of v.chapters) assert.equal(await exists(media('_drafts', d.draftId, c.key, '001.png')), true, 'berkas harus dikembalikan ke draft');
  assert.deepEqual((await fs.readdir(H.mediaDir)).filter(x => x !== '_drafts').sort(), publicBefore, 'tidak ada sisa berkas publik');
  const ok = await h.service.publish(d.draftId); // percobaan ulang berhasil
  assert.equal(ok.chaptersPublished, 2);
});

test('re-scan komik yang sudah terpublish: chapter lama EXISTS, hanya yang baru ditambahkan; metadata tidak ditimpa; mengganti butuh konfirmasi', async () => {
  const h = await harness();
  const d1 = await H.scanAndDownload(h, URL1, {numbers: [5, 4, 3, 2, 1]});
  await H.waitState(h, d1.draftId, ['READY']);
  await h.service.patch(d1.draftId, {comic: {title: 'Judul Hasil Edit Admin', synopsis: 'Edit admin'}});
  const p1 = await h.service.publish(d1.draftId);
  const comic = h.state.db.comics[0];
  assert.equal(comic.chapters.length, 5);
  const oldIds = comic.chapters.map(c => c.id);

  H.scanResult; h.worker.setScan(URL1, H.scanResult({url: URL1, numbers: [8, 7, 6, 5, 4, 3, 2, 1], title: 'Judul dari Sumber (berubah)'}));
  const d2 = await h.service.scan(URL1);
  assert.equal(d2.existingComicId, p1.comicId);
  assert.equal(d2.counts.exists, 5);
  assert.equal(d2.counts.new, 3);
  assert.deepEqual(d2.chapters.filter(c => c.flag === 'EXISTS').every(c => c.excluded), true);
  const startsBefore = h.worker.state.startCalls;
  // mode all tanpa konfirmasi -> 409
  await assert.rejects(h.service.startDownload(d2.draftId, {mode: 'all'}), e => e.status === 409 && e.code === 'CONFIRM_REPLACE_REQUIRED' && e.extra.keys.length === 5);
  assert.equal(h.worker.state.startCalls, startsBefore, 'tidak ada job baru yang dibuat tanpa konfirmasi');
  const r = await h.service.startDownload(d2.draftId, {mode: 'new-only'});
  assert.equal(r.chaptersQueued, 3);
  await H.waitState(h, d2.draftId, ['READY']);
  const p2 = await h.service.publish(d2.draftId);
  assert.equal(p2.appendedToExisting, true);
  assert.equal(p2.chaptersPublished, 3);
  assert.equal(h.state.db.comics.length, 1);
  assert.deepEqual(comic.chapters.map(c => c.number), ['8', '7', '6', '5', '4', '3', '2', '1']);
  assert.deepEqual(comic.chapters.slice(3).map(c => c.id), oldIds, 'chapter lama tidak diubah');
  assert.equal(comic.title, 'Judul Hasil Edit Admin');
  assert.equal(comic.synopsis, 'Edit admin');
});

test('mengganti chapter yang sudah ada (konfirmasi) memakai id lama dan berkas baru', async () => {
  const h = await harness();
  const d1 = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.waitState(h, d1.draftId, ['READY']);
  await h.service.publish(d1.draftId);
  const comic = h.state.db.comics[0];
  const id1 = comic.chapters.find(c => c.number === '1').id;
  const d2 = await h.service.scan(URL1);
  await h.service.startDownload(d2.draftId, {mode: 'all', confirmReplace: true});
  await H.waitState(h, d2.draftId, ['READY']);
  const r = await h.service.publish(d2.draftId);
  assert.equal(r.chaptersPublished, 2);
  assert.equal(comic.chapters.length, 2);
  assert.equal(comic.chapters.find(c => c.number === '1').id, id1);
  const leftovers = (await fs.readdir(media(comic.storageKey, 'chapters'))).filter(n => n.includes('replaced'));
  assert.deepEqual(leftovers, []);
});

test('cancel: chapter yang belum selesai menjadi CANCELLED dan job dibatalkan di worker', async () => {
  const h = await harness();
  h.worker.hold();
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  await H.wait(60);
  await h.service.cancel(d.draftId);
  const v = await H.waitState(h, d.draftId, ['CANCELLED']);
  assert.ok(v.chapters.every(c => c.status === 'CANCELLED'));
  assert.equal(h.worker.state.cancelled.length, 1);
  await assert.rejects(h.service.cancel(d.draftId), e => e.code === 'NO_ACTIVE_JOB');
  h.worker.release();
  // CANCELLED dapat dilanjutkan dengan failed-only
  const r = await h.service.startDownload(d.draftId, {mode: 'failed-only'});
  assert.equal(r.chaptersQueued, 3);
  await H.waitState(h, d.draftId, ['READY']);
});

test('worker mati saat unduhan: chapter FAILED WORKER_UNAVAILABLE setelah batas waktu, draft tidak macet', async () => {
  const h = await harness({config: {workerUnreachableMs: 250}});
  h.worker.hold();
  const d = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.wait(60);
  const port = new URL(h.worker.url).port;
  await h.worker.stopListening();
  const v = await H.waitState(h, d.draftId, ['READY'], 6000);
  assert.ok(v.chapters.every(c => c.status === 'FAILED' && c.errorCode === 'WORKER_UNAVAILABLE'));
  await h.worker.listenAgain(Number(port));
  h.worker.release();
});

test('worker restart (job hilang): chapter FAILED WORKER_RESTARTED', async () => {
  const h = await harness();
  h.worker.hold();
  const d = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.wait(60);
  h.worker.restart();
  const v = await H.waitState(h, d.draftId, ['READY']);
  assert.ok(v.chapters.every(c => c.errorCode === 'WORKER_RESTARTED'));
});

test('FE restart: monitor dilanjutkan dari db (recover) dan unduhan selesai', async () => {
  const h = await harness();
  h.worker.hold();
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  await H.wait(60);
  h.state.dead = true; // "FE crash": monitor lama berhenti
  await H.wait(100);
  const snapshot = JSON.parse(JSON.stringify(h.state.db));
  const h2 = await H.makeHarness({worker: h.worker, db: snapshot});
  await h2.service.recover();
  h.worker.release();
  const v = await H.waitState(h2, d.draftId, ['READY']);
  assert.equal(v.counts.completed, 3);
});

test('retry setelah kegagalan ingest tidak menyisakan berkas parsial', async () => {
  const h = await harness();
  h.worker.plan('c_0001', {badSha: true});
  const d = await H.scanAndDownload(h, URL1, {numbers: [1]});
  const v = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v.chapters[0].status, 'FAILED');
  assert.equal(v.chapters[0].errorCode, 'INTEGRITY');
  assert.equal(await exists(media('_drafts', d.draftId, 'c_0001')), false);
  h.worker.plan('c_0001', {badSha: false});
  // staging worker sudah dihapus? tidak: ingest gagal => tidak dihapus; job baru memulai ulang
  await h.service.retryChapter(d.draftId, 'c_0001');
  const v2 = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v2.chapters[0].status, 'COMPLETED');
});

test('ingest menolak gambar yang isinya bukan gambar (HTML/captcha) -> UNSUPPORTED_IMAGE_FORMAT', async () => {
  const h = await harness();
  h.worker.plan('c_0001', {notImage: true});
  const d = await H.scanAndDownload(h, URL1, {numbers: [1]});
  const v = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v.chapters[0].errorCode, 'UNSUPPORTED_IMAGE_FORMAT');
});

test('PATCH: validasi judul/sinopsis/nomor/sampul', async () => {
  const h = await harness();
  h.worker.setScan(URL1, H.scanResult({url: URL1, numbers: [3, 2, 1], extra: true}));
  const d = await h.service.scan(URL1);
  const bad = (body, code, msg) => assert.rejects(h.service.patch(d.draftId, body), e => e.status >= 400 && (!code || e.code === code) && (!msg || e.message.includes(msg)));
  await bad({comic: {title: '   '}}, 'INVALID_REQUEST', 'Judul wajib diisi.');
  await bad({comic: {title: 'x'.repeat(141)}}, 'INVALID_REQUEST', '140');
  await bad({comic: {synopsis: 'x'.repeat(2001)}}, 'INVALID_REQUEST', '2000');
  await bad({comic: {status: 'Aneh'}}, 'INVALID_REQUEST');
  await bad({chapters: [{key: 'c_0001', number: 'abc'}]}, 'INVALID_CHAPTER_NUMBER');
  await bad({chapters: [{key: 'c_9999', number: '1'}]}, 'CHAPTER_NOT_FOUND');
  await bad({comic: {coverData: 'data:image/png;base64,' + Buffer.from('bukan gambar').toString('base64')}}, 'UNSUPPORTED_IMAGE_FORMAT');
  await bad({comic: {coverData: 'data:image/png;base64,' + makeImage('png', 5_000_100, 1).toString('base64')}}, 'COVER_TOO_LARGE');
  const ok = await h.service.patch(d.draftId, {comic: {title: ' Judul Baru '}, chapters: [{key: 'c_0001', number: '007'}, {key: 'c_0004', number: '3.50'}]});
  assert.equal(ok.comic.title, 'Judul Baru');
  assert.equal(ok.chapters[0].number, '7');
  assert.equal(ok.chapters[3].number, '3.5');
  const cover = await h.service.patch(d.draftId, {comic: {coverData: 'data:image/png;base64,' + makeImage('png', 800, 3).toString('base64')}});
  assert.ok(cover.comic.cover.endsWith('.png'));
  const covers = (await fs.readdir(media('_drafts', d.draftId))).filter(n => n.startsWith('cover-'));
  assert.equal(covers.length, 1, 'sampul lama diganti');
  const del = await h.service.patch(d.draftId, {chapters: [{key: 'c_0002', delete: true}]});
  assert.equal(del.counts.total, 3);
});

test('discard menghapus draft beserta berkasnya (dan membatalkan job yang berjalan)', async () => {
  const h = await harness();
  h.worker.hold();
  const d = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.wait(50);
  await h.service.discard(d.draftId);
  assert.equal(h.state.db.scanDrafts.length, 0);
  assert.equal(await exists(media('_drafts', d.draftId)), false);
  assert.equal(h.worker.state.cancelled.length, 1);
  await assert.rejects(h.service.get(d.draftId), e => e.status === 404 && e.code === 'DRAFT_NOT_FOUND');
  await H.until(() => h.service._monitors.size === 0, {label: 'monitor berhenti'});
});

test('INSUFFICIENT_DISK: unduhan tidak dimulai bila ruang bebas di bawah minimum', async () => {
  const h = await harness({config: {minFreeBytes: 1_000_000_000}, statfs: async () => ({bavail: 10, bsize: 4096})});
  h.worker.setScan(URL1, H.scanResult({url: URL1, numbers: [1]}));
  const d = await h.service.scan(URL1);
  await assert.rejects(h.service.startDownload(d.draftId, {}), e => e.status === 507 && e.code === 'INSUFFICIENT_DISK');
  assert.equal(h.worker.state.startCalls, 0);
});

test('Download All dinonaktifkan secara logika bila 0 chapter; scan 0 chapter memberi peringatan', async () => {
  const h = await harness();
  const r = H.scanResult({url: URL1, numbers: []}); r.warnings = ['NO_CHAPTERS'];
  h.worker.setScan(URL1, r);
  const d = await h.service.scan(URL1);
  assert.equal(d.counts.total, 0);
  assert.ok(d.warnings.includes('NO_CHAPTERS'));
  await assert.rejects(h.service.startDownload(d.draftId, {}), e => e.code === 'NO_CHAPTERS_TO_DOWNLOAD');
});

test('SSRF di FE: URL privat ditolak tanpa menghubungi worker (mode produksi)', async () => {
  const h = await harness({config: {devMode: false}});
  for (const url of ['http://127.0.0.1/x.json', 'https://127.0.0.1/x.json', 'https://[::1]/x', 'https://10.0.0.5/a', 'https://169.254.169.254/latest', 'ftp://example.org/a', 'https://user:pw@example.org/a'])
    await assert.rejects(h.service.scan(url), e => e.status === 400 && ['INVALID_URL', 'SSRF_BLOCKED'].includes(e.code), url);
  assert.equal(h.worker.state.scanCalls, 0);
});

test('galat scan dari worker diteruskan dengan kode (SOURCE_NOT_SUPPORTED, SCAN_TIMEOUT)', async () => {
  const h = await harness();
  await assert.rejects(h.service.scan('https://tidak-ada.example/x.json'), e => e.status === 422 && e.code === 'SOURCE_NOT_SUPPORTED');
  h.worker.setScan('https://lambat.example/x.json', {__error: {status: 504, code: 'SCAN_TIMEOUT', message: 'timeout'}});
  await assert.rejects(h.service.scan('https://lambat.example/x.json'), e => e.status === 504 && e.code === 'SCAN_TIMEOUT');
});

test('FE-side timeout: worker tidak merespons -> 504 WORKER_TIMEOUT dalam batas waktu', async () => {
  const h = await harness();
  const slow = require('../lib/scan-worker').createWorkerClient({baseUrl: h.worker.url, token: h.worker.token, scanTimeoutMs: 150});
  h.worker.state.scanDelayMs = 600;
  h.worker.setScan('*', H.scanResult({url: URL1}));
  const t0 = Date.now();
  await assert.rejects(slow.scan(URL1), e => e.status === 504 && e.code === 'WORKER_TIMEOUT');
  assert.ok(Date.now() - t0 < 500);
});

test('draft SCANNED kedaluwarsa dibuang oleh sweep beserta berkasnya; DOWNLOADING tidak', async () => {
  const h = await harness();
  h.worker.setScan(URL1, H.scanResult({url: URL1}));
  const d = await h.service.scan(URL1);
  h.state.db.scanDrafts[0].updatedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  assert.equal(await h.service.sweepExpired(), 1);
  assert.equal(h.state.db.scanDrafts.length, 0);
  assert.equal(await exists(media('_drafts', d.draftId)), false);
});

test('cover tidak tersedia: peringatan COVER_UNAVAILABLE dan publish tetap bisa tanpa sampul', async () => {
  const h = await harness();
  const r = H.scanResult({url: URL1, numbers: [1], cover: null}); r.warnings = ['COVER_UNAVAILABLE'];
  h.worker.setScan(URL1, r);
  const d = await h.service.scan(URL1);
  assert.ok(d.warnings.includes('COVER_UNAVAILABLE'));
  assert.equal(d.comic.cover, '');
  await h.service.startDownload(d.draftId, {});
  await H.waitState(h, d.draftId, ['READY']);
  const p = await h.service.publish(d.draftId);
  assert.equal(h.state.db.comics.find(c => c.id === p.comicId).cover, '');
});

test('judul sama tapi URL berbeda -> peringatan TITLE_EXISTS (bukan blokir)', async () => {
  const h = await harness({db: {comics: [{id: 'lama', title: 'Seri Uji Orisinal', chapters: []}], announcements: [], ads: [], scanDrafts: []}});
  h.worker.setScan(URL1, H.scanResult({url: URL1}));
  const d = await h.service.scan(URL1);
  assert.ok(d.warnings.includes('TITLE_EXISTS'));
  assert.equal(d.existingComicId, null);
});

test('NFR-07: 50 chapter selesai hampir bersamaan -> db.json valid dan jumlah saveDb dibatasi transisi status', async () => {
  const h = await harness();
  const numbers = Array.from({length: 50}, (_, i) => 50 - i);
  for (const n of numbers) h.worker.plan('c_' + String(numbers.indexOf(n) + 1).padStart(4, '0'), {pages: 2});
  let saves = 0;
  h.saveHook; // (hook dipasang lewat factory lain; di sini hitung lewat writer.stats)
  const d = await H.scanAndDownload(h, URL1, {numbers});
  await H.waitState(h, d.draftId, ['READY'], 20000);
  await H.wait(100);
  const raw = await fs.readFile(h.dbFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.scanDrafts[0].chapters.filter(c => c.status === 'COMPLETED').length, 50);
  const transitions = 50 * 2; // QUEUED->DOWNLOADING->COMPLETED
  assert.ok(h.writer.stats.requests <= transitions + 4, `saveDb dipanggil ${h.writer.stats.requests}x untuk ${transitions} transisi`);
  assert.equal(h.writer.stats.concurrentPeak, 1);
  console.log(`# 50 chapters: saveDb requests=${h.writer.stats.requests}, actual file writes=${h.writer.stats.writes}, transitions=${transitions}`);
});

test('FR-02/NFR-01: scan dengan 1000 chapter diterima (tanpa batas jumlah chapter)', async () => {
  const h = await harness();
  h.worker.setScan(URL1, H.scanResult({url: URL1, numbers: Array.from({length: 1000}, (_, i) => 1000 - i)}));
  const d = await h.service.scan(URL1);
  assert.equal(d.counts.total, 1000);
});

// QA D-02: publish bersamaan pada draft yang sama.
test('QA D-02: publish paralel (5x) -> tepat satu sukses, sisanya 409 ALREADY_PUBLISHED; tanpa duplikasi/berkas yatim; draft PUBLISHED', async () => {
  for (let round = 0; round < 3; round++) {
    const h = await harness();
    const u = `https://sumber.example/seri-race-${round}/manifest.json`;
    const d = await H.scanAndDownload(h, u, {numbers: [3, 2, 1]});
    await H.waitState(h, d.draftId, ['READY']);
    await H.wait(60);
    const mediaBefore = (await fs.readdir(H.mediaDir)).filter(x => x !== '_drafts');
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => h.service.publish(d.draftId)));
    const ok = results.filter(r => r.status === 'fulfilled');
    const bad = results.filter(r => r.status === 'rejected');
    assert.equal(ok.length, 1, `harus tepat 1 sukses: ${JSON.stringify(results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason.code))}`);
    assert.equal(bad.length, 4);
    for (const r of bad) assert.ok(r.reason.status === 409 && r.reason.code === 'ALREADY_PUBLISHED', `kalah harus 409 ALREADY_PUBLISHED, dapat ${r.reason.status} ${r.reason.code}`);
    assert.equal(h.state.db.comics.length, 1, 'tidak boleh ada komik ganda');
    const comic = h.state.db.comics[0];
    assert.equal(comic.chapters.length, 3);
    const v = await h.service.get(d.draftId);
    assert.equal(v.state, 'PUBLISHED');
    assert.equal(v.publishedComicId, comic.id);
    // tidak ada berkas yatim: semua halaman ada, folder draft hilang, hanya satu folder komik
    for (const ch of comic.chapters) for (const p of ch.pages) assert.equal(await exists(path.join(H.mediaDir, p.image_url.replace(/^\/media\//, ''))), true, p.image_url);
    assert.equal(await exists(media('_drafts', d.draftId)), false, 'folder draft harus bersih');
    assert.deepEqual((await fs.readdir(H.mediaDir)).filter(x => x !== '_drafts' && !mediaBefore.includes(x)), [comic.storageKey], 'hanya satu folder komik baru');
    // mutasi saat/ sesudah publish tidak mengubah state
    await assert.rejects(h.service.publish(d.draftId), e => e.code === 'ALREADY_PUBLISHED');
  }
});

test('QA D-02: selama publish berjalan, patch/discard/download ditolak 409 PUBLISH_IN_PROGRESS dan draft tidak rusak', async () => {
  const h = await harness();
  const d = await H.scanAndDownload(h, URL1, {numbers: [2, 1]});
  await H.waitState(h, d.draftId, ['READY']);
  await H.wait(60);
  const p = h.service.publish(d.draftId);
  const attempts = await Promise.allSettled([h.service.discard(d.draftId), h.service.patch(d.draftId, {comic: {title: 'Ubah'}}), h.service.startDownload(d.draftId, {})]);
  await p;
  for (const a of attempts) assert.ok(a.status === 'rejected' && a.reason.status === 409 && a.reason.code === 'PUBLISH_IN_PROGRESS', JSON.stringify(a.status === 'rejected' ? a.reason.code : 'ok'));
  assert.equal(h.state.db.comics.length, 1);
  assert.equal((await h.service.get(d.draftId)).state, 'PUBLISHED');
});

// QA D-07: chapter FAILED/CANCELLED tidak melaporkan jumlah halaman parsial pada tampilan draft.
test('QA D-07: pageCount chapter FAILED = 0 (bukan hitungan parsial); COMPLETED tetap jumlah halaman', async () => {
  const h = await harness();
  h.worker.plan('c_0002', {fail: 'HTTP_ERROR'});
  const d = await H.scanAndDownload(h, URL1, {numbers: [3, 2, 1]});
  const v = await H.waitState(h, d.draftId, ['READY']);
  assert.equal(v.chapters[1].status, 'FAILED');
  assert.equal(v.chapters[1].pageCount, 0);
  assert.ok(v.chapters[0].pageCount >= 3 && v.chapters[2].pageCount >= 3);
});
