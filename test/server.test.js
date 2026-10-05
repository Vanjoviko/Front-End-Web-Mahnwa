'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {startServer} = require('./helpers/server');
const {startFakeWorker, scanResult} = require('./helpers/fake-worker');
const {makeImage, dataUrl} = require('./helpers/images');

const URL1 = 'https://sumber.example/seri-http/manifest.json';
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); } };

function bigDb() { // 20 komik x 100 chapter x 30 halaman (fixture NFR-06)
  const comics = Array.from({length: 20}, (_, c) => ({
    id: `komik-${c}`, title: `Komik Uji ${c}`, alt: 'Alt', type: 'Manhwa', status: 'Berjalan', genres: ['Aksi', 'Drama'], rating: 8.1, year: 2025, author: 'Penulis', synopsis: 'Sinopsis uji orisinal. '.repeat(10),
    cover: `/media/komik-${c}/cover.png`, storageKey: `komik-${c}`, source: 'Scan Import · Manifest JSON', sourceUrl: 'https://rahasia.example/seri', scanSource: {adapter: 'manifest', canonicalUrl: 'https://rahasia.example/seri', importedAt: '2026-01-01'},
    chapters: Array.from({length: 100}, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(c * 100 + n).padStart(12, '0')}`, number: String(100 - n), title: `Judul chapter ${100 - n}`, date: '2026-09-01', status: 'COMPLETED', errorMessage: 'rahasia internal', seriesUrl: 'https://rahasia.example/x', importMethod: 'x', fileUrl: '/media/x.pdf',
      pages: Array.from({length: 30}, (_, p) => ({page_number: p + 1, image_url: `/media/komik-${c}/chapters/chapter-${100 - n}/${String(p + 1).padStart(3, '0')}.webp`}))
    }))
  }));
  return {comics, announcements: [], connectors: [], settings: {adProvider: '', adUnit: '', scheduleEnabled: false}, ads: [], users: []};
}
function fullDb() { const db = bigDb(); db.connectors = [{id: 'kiryuu', name: 'Kiryuu', method: 'x', enabled: false, state: 'nonaktif', message: '', lastSync: null, feedUrl: 'https://v7.kiryuu.to/manga/x/', intervalMinutes: 1440}, {id: 'demo-source', name: 'Demo', method: 'x', enabled: true, state: 'siap', message: '', lastSync: null, feedUrl: 'local:x', intervalMinutes: 5}]; return db; }

test('NFR-03: semua /api/admin/scan* tanpa sesi admin -> 401 (semua metode)', async () => {
  const w = await startFakeWorker(); const s = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: w.token}});
  try {
    for (const [m, p] of [['GET', '/api/admin/scan'], ['POST', '/api/admin/scan'], ['GET', '/api/admin/scan/d_x'], ['PATCH', '/api/admin/scan/d_x'], ['DELETE', '/api/admin/scan/d_x'], ['POST', '/api/admin/scan/d_x/download'], ['GET', '/api/admin/scan/d_x/progress'], ['POST', '/api/admin/scan/d_x/cancel'], ['POST', '/api/admin/scan/d_x/publish'], ['POST', '/api/admin/scan/d_x/chapters/c_1/retry'], ['GET', '/api/admin/scanx']]) {
      const r = await s.request(m, p, m === 'GET' ? undefined : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    assert.equal(w.state.requests.length, 0, 'worker tidak boleh dihubungi tanpa auth');
    // pembaca biasa (bukan admin) juga ditolak
    await s.request('POST', '/api/auth/register', {username: 'pembaca1', password: 'sandi-panjang-1'});
    const reg = await fetch(s.base + '/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'pembaca1', password: 'sandi-panjang-1', role: 'user'})});
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const r = await fetch(s.base + '/api/admin/scan', {headers: {cookie}});
    assert.equal(r.status, 401);
  } finally { await s.stop(); await w.close(); }
});

test('NFR-03: path traversal / ID tidak valid -> 404 dan tidak pernah sampai ke worker', async () => {
  const w = await startFakeWorker(); const s = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: w.token}});
  try {
    const cookie = await s.login();
    for (const p of ['/api/admin/scan/../../health', '/api/admin/scan/%2e%2e/%2e%2e/etc/passwd', '/api/admin/scan/d_x/download/../../..', '/api/admin/scan/d%2f..%2fx', '/api/admin/scan/d_x/chapters/..%2f..%2fjobs/retry', '/api/admin/scan/d_x/chapters/c_1/retry/extra', '/api/admin/scan/' + 'a'.repeat(65), '/api/admin/scan/d_x/unknown', '/api/admin/scan/a%00b', '/api/admin/scan//']) {
      const r = await s.rawGet(p, {cookie}); // http mentah: path tidak dinormalisasi klien
      const resolvesOutside = /\.\.\/\.\.\/health$/.test(p) || /download\/\.\.\/\.\.\/\.\.$/.test(p) || p.endsWith('/etc/passwd');
      assert.ok([404, 400].includes(r.status) || (resolvesOutside && r.status < 500), `${p} -> ${r.status}`);
      assert.ok(!r.body.toString().includes('root:'), 'tidak boleh membocorkan berkas');
    }
    const bad = await s.request('POST', '/api/admin/scan/d_x/chapters/%2e%2e/retry', {});
    assert.equal(bad.status, 404);
    assert.equal(w.state.requests.length, 0);
    // metode salah pada rute valid
    assert.equal((await s.request('PUT', '/api/admin/scan/d_x', {})).status, 405);
  } finally { await s.stop(); await w.close(); }
});

test('alur lengkap via HTTP: scan -> draft tersembunyi -> download -> progress -> publish -> katalog & reader', async () => {
  const w = await startFakeWorker(); w.setScan(URL1, scanResult({url: URL1, numbers: [12, 11, 2], title: 'Seri HTTP Uji'}));
  const s = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: w.token, SCAN_DEV_MODE: 'true', SCAN_POLL_MS: '30', SCAN_MIN_FREE_BYTES: '1'}});
  try {
    await s.login();
    const scan = await s.request('POST', '/api/admin/scan', {url: URL1});
    assert.equal(scan.status, 201, JSON.stringify(scan.json));
    const id = scan.json.draftId;
    // draft tidak bocor ke katalog publik / admin lama / konektor
    const pub = await fetch(s.base + '/api/catalog').then(r => r.json());
    assert.ok(!pub.comics.some(c => c.title === 'Seri HTTP Uji'));
    const admin = await s.request('GET', '/api/admin');
    assert.ok(!JSON.stringify(admin.json).includes(id));
    assert.ok(!JSON.stringify(pub).includes(id));
    // berkas sampul draft hanya untuk admin
    const coverUrl = scan.json.comic.cover;
    assert.equal((await fetch(s.base + coverUrl)).status, 401);
    const withAuth = await s.request('GET', coverUrl);
    assert.equal(withAuth.status, 200);
    // duplikat
    assert.equal((await s.request('POST', '/api/admin/scan', {url: URL1})).json.code, 'DRAFT_EXISTS');
    const dl = await s.request('POST', `/api/admin/scan/${id}/download`, {});
    assert.equal(dl.status, 202);
    assert.equal((await s.request('POST', `/api/admin/scan/${id}/download`, {})).json.code, 'JOB_ALREADY_RUNNING');
    await until(async () => (await s.request('GET', `/api/admin/scan/${id}/progress`)).json.state === 'READY');
    const progress = (await s.request('GET', `/api/admin/scan/${id}/progress`)).json;
    assert.equal(progress.totals.completed, 3);
    const pub1 = await s.request('POST', `/api/admin/scan/${id}/publish`, {});
    assert.equal(pub1.status, 201, JSON.stringify(pub1.json));
    const cat = await fetch(s.base + '/api/catalog').then(r => r.json());
    const comic = cat.comics.find(c => c.title === 'Seri HTTP Uji');
    assert.ok(comic);
    assert.deepEqual(comic.chapters.map(c => c.number), ['12', '11', '2']);
    for (const key of ['storageKey', 'scanSource', 'sourceUrl']) assert.ok(!(key in comic), key);
    for (const ch of comic.chapters) for (const key of ['pages', 'fileUrl', 'errorMessage', 'seriesUrl', 'importMethod']) assert.ok(!(key in ch), key);
    assert.ok(comic.chapters.every(c => c.pageCount >= 3));
    // reader: endpoint halaman baru (publik) + berkas gambar terlayani
    const pages = await fetch(`${s.base}/api/comics/${comic.id}/chapters/${comic.chapters[0].id}/pages`).then(r => r.json());
    assert.equal(pages.pages.length, comic.chapters[0].pageCount);
    assert.deepEqual(Object.keys(pages.pages[0]).sort(), ['image_url', 'page_number']);
    const img = await fetch(s.base + pages.pages[0].image_url);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /^image\//);
    assert.equal((await fetch(`${s.base}/api/comics/${comic.id}/chapters/nope/pages`)).status, 404);
    assert.equal(s.log().includes('pw-uji-123'), false);
  } finally { await s.stop(); await w.close(); }
});

test('worker mati -> POST scan memberi 502 WORKER_UNAVAILABLE (bukan hang / bukan 500)', async () => {
  const s = await startServer({env: {SCAN_WORKER_URL: 'http://127.0.0.1:1', SCAN_WORKER_TOKEN: 'x', SCAN_DEV_MODE: 'true'}});
  try {
    await s.login();
    const r = await s.request('POST', '/api/admin/scan', {url: URL1});
    assert.equal(r.status, 502); assert.equal(r.json.code, 'WORKER_UNAVAILABLE');
  } finally { await s.stop(); }
});

test('mode non-dev tanpa SCAN_WORKER_TOKEN -> 503 WORKER_NOT_CONFIGURED; URL privat -> 400', async () => {
  const w = await startFakeWorker();
  const s1 = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: ''}});
  const s2 = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: w.token}});
  try {
    await s1.login(); await s2.login();
    assert.equal((await s1.request('POST', '/api/admin/scan', {url: 'https://x.example/a.json'})).json.code, 'WORKER_NOT_CONFIGURED');
    const r = await s2.request('POST', '/api/admin/scan', {url: 'https://169.254.169.254/latest/meta-data'});
    assert.equal(r.status, 400); assert.ok(['SSRF_BLOCKED', 'INVALID_URL'].includes(r.json.code));
    assert.equal((await s2.request('POST', '/api/admin/scan', {url: 'http://example.org/a.json'})).status, 400);
    assert.equal(w.state.requests.length, 0);
  } finally { await s1.stop(); await s2.stop(); await w.close(); }
});

test('NFR-06: /api/catalog 20x100x30 <= 1 MB mentah, <= 200 KB gzip, tanpa field internal; /api/admin tanpa pages', async () => {
  const s = await startServer({db: fullDb()});
  try {
    const raw = await s.rawGet('/api/catalog');
    assert.equal(raw.status, 200);
    assert.ok(!raw.headers['content-encoding']);
    const gz = await s.rawGet('/api/catalog', {'accept-encoding': 'gzip'});
    assert.equal(gz.headers['content-encoding'], 'gzip');
    const body = JSON.parse(zlib.gunzipSync(gz.body).toString());
    const text = raw.body.toString();
    console.log(`# /api/catalog: raw=${raw.body.length} B, gzip=${gz.body.length} B (fixture 20x100x30)`);
    assert.ok(raw.body.length <= 1_000_000, `mentah ${raw.body.length}`);
    assert.ok(gz.body.length <= 200_000, `gzip ${gz.body.length}`);
    for (const forbidden of ['"pages"', 'storageKey', 'scanSource', 'sourceUrl', 'errorMessage', 'seriesUrl', 'importMethod', 'fileUrl', 'rahasia']) assert.ok(!text.includes(forbidden), forbidden);
    const demo = body.comics.find(c => c.id === 'komik-3');
    assert.equal(demo.chapters.length, 100);
    assert.equal(demo.chapters[0].pageCount, 30);
    await s.login();
    const admin = await s.request('GET', '/api/admin');
    assert.ok(!JSON.stringify(admin.json.comics).includes('"pages"'));
    assert.equal(admin.json.comics.find(c => c.id === 'komik-3').chapters[0].pageCount, 30);
    assert.ok(JSON.stringify(admin.json).length < 1_500_000);
  } finally { await s.stop(); }
});

test('regresi: halaman lama dari chapter PDF/upload tetap terbaca lewat endpoint halaman; chapter tanpa halaman -> pages kosong', async () => {
  const db = fullDb();
  db.comics = db.comics.slice(0, 1);
  db.comics[0].chapters = [{id: 'ch-a', number: 3, title: '', date: 'x', status: 'COMPLETED', pages: ['/media/lama/001.jpg', '/media/lama/002.jpg'], pdfUrl: '', fileUrl: '/media/lama/original.pdf'}, {id: 'ch-b', number: 2, title: '', date: 'x', status: 'FAILED', errorMessage: 'Proses konversi gagal.', pages: []}, {id: 'ch-c', number: 1, title: 'meta', date: 'x'}];
  const s = await startServer({db});
  try {
    const a = await fetch(`${s.base}/api/comics/komik-0/chapters/ch-a/pages`).then(r => r.json());
    assert.deepEqual(a.pages.map(p => p.image_url), ['/media/lama/001.jpg', '/media/lama/002.jpg']);
    assert.equal(a.fileUrl, '/media/lama/original.pdf');
    const b = await fetch(`${s.base}/api/comics/komik-0/chapters/ch-b/pages`).then(r => r.json());
    assert.equal(b.status, 'FAILED'); assert.equal(b.errorMessage, 'Proses konversi gagal.'); assert.deepEqual(b.pages, []);
    const cat = await fetch(s.base + '/api/catalog').then(r => r.json());
    assert.equal(cat.comics.find(c => c.id === 'komik-0').chapters.find(c => c.id === 'ch-a').pageCount, 2);
    assert.equal(cat.comics.find(c => c.id === 'komik-0').chapters.find(c => c.id === 'ch-b').status, 'FAILED');
  } finally { await s.stop(); }
});

// ---- Regresi FR-16 / NFR-01: limit upload manual TIDAK berubah ----
function manualDb() { return {comics: [{id: 'manual', title: 'Komik Manual', type: 'Manhwa', status: 'Berjalan', genres: [], chapters: []}], announcements: [], connectors: fullDb().connectors, settings: {}, ads: [], users: []}; }
test('regresi upload manual: 81 gambar ditolak, >28 MB ditolak, nomor 1.5 -> folder chapter-1-5, sampul >5 MB ditolak, PDF >20 MB ditolak', async () => {
  const s = await startServer({db: manualDb()});
  try {
    await s.login();
    const tiny = dataUrl('png', 600, 1);
    const r81 = await s.request('POST', '/api/admin/comics/manual/chapters/images', {number: '1', images: Array.from({length: 81}, () => tiny)});
    assert.equal(r81.status, 400, JSON.stringify(r81.json));
    const r80 = await s.request('POST', '/api/admin/comics/manual/chapters/images', {number: '1.5', images: Array.from({length: 80}, () => tiny)});
    assert.equal(r80.status, 201, JSON.stringify(r80.json));
    assert.equal(r80.json.pages.length, 80);
    assert.ok(r80.json.pages[0].image_url.includes('/chapters/chapter-1-5/'), r80.json.pages[0].image_url);
    const big = dataUrl('png', 4_900_000, 2);
    const rBig = await s.request('POST', '/api/admin/comics/manual/chapters/images', {number: '2', images: Array.from({length: 6}, () => big)}); // 29.4 MB > 28 MB
    assert.equal(rBig.status, 400, JSON.stringify(rBig.json).slice(0, 200));
    const rOne = await s.request('POST', '/api/admin/comics/manual/chapters/images', {number: '3', images: [dataUrl('png', 5_000_100, 3)]});
    assert.equal(rOne.status, 400);
    const rCover = await s.request('POST', '/api/admin/comics', {title: 'Sampul besar', synopsis: 's', mode: 'source', sourceId: 'demo-source', coverData: dataUrl('png', 5_000_100, 4)});
    assert.ok(rCover.status >= 400 && rCover.status < 500, `sampul >5MB: ${rCover.status}`);
    const pdf = 'data:application/pdf;base64,' + Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20_000_100, 32)]).toString('base64');
    const rPdf = await s.request('POST', '/api/admin/comics', {title: 'PDF besar', synopsis: 's', mode: 'pdf', chapterNumber: '1', coverData: dataUrl('png', 800, 5), pdfData: pdf});
    assert.ok(rPdf.status >= 400 && rPdf.status < 500, `PDF >20MB: ${rPdf.status} ${JSON.stringify(rPdf.json)}`);
    assert.match(rPdf.json.error, /PDF|20/i);
  } finally { await s.stop(); }
});

test('FR-17: tidak ada teks robots.txt/anti-bot pada README, app.js, dan pesan server', () => {
  const root = path.join(__dirname, '..');
  const files = ['README.md', 'public/app.js', 'public/scan-import.js'];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/robots/i.test(txt), `${f} masih menyebut robots`);
    assert.ok(!/anti-bot/i.test(txt), `${f} masih menyebut anti-bot`);
  }
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(!/Server akan memeriksa robots\.txt/.test(serverJs));
});

// ---------------------------------------------------------------------------------------------
// QA D-01: proteksi /media/_drafts/ tidak boleh dilewati lewat variasi path.
test('QA D-01: /media/_drafts/ hanya admin — varian //, /./, %2e, %2f, %5c, \\, huruf besar, trailing, ../ semuanya 401 tanpa sesi', async () => {
  const s = await startServer({db: bigDb()});
  try {
    const dir = path.join(s.dir, 'media', '_drafts', 'd_abc123');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'cover-x.png'), makeImage('png', 8, 8));
    fs.mkdirSync(path.join(s.dir, 'media', 'publik'), {recursive: true});
    fs.writeFileSync(path.join(s.dir, 'media', 'publik', 'a.png'), makeImage('png', 8, 8));
    const variants = [
      '/media/_drafts/d_abc123/cover-x.png', '/media//_drafts/d_abc123/cover-x.png', '/media///_drafts/d_abc123/cover-x.png',
      '//media/_drafts/d_abc123/cover-x.png', '/media/./_drafts/d_abc123/cover-x.png', '/media/%2e/_drafts/d_abc123/cover-x.png',
      '/media/%2F_drafts/d_abc123/cover-x.png', '/media/%2f%2f_drafts/d_abc123/cover-x.png', '/media/%5c_drafts/d_abc123/cover-x.png',
      '/media/\\_drafts/d_abc123/cover-x.png', '/media/publik/../_drafts/d_abc123/cover-x.png', '/media/publik/%2e%2e/_drafts/d_abc123/cover-x.png',
      '/media/publik/..%2f_drafts/d_abc123/cover-x.png', '/media/%5Fdrafts/d_abc123/cover-x.png', '/media/_DRAFTS/d_abc123/cover-x.png',
      '/MEDIA/_Drafts/d_abc123/cover-x.png', '/media/_drafts/d_abc123//cover-x.png', '/media/_drafts/./d_abc123/cover-x.png',
      '/media/_drafts/d_abc123/%2e/cover-x.png', '/media/%255fdrafts/d_abc123/cover-x.png', '/media/_drafts', '/media/_drafts/', '/media/_drafts//'
    ];
    for (const v of variants) {
      const r = await s.rawGet(v);
      assert.equal(r.status, 401, `tanpa sesi harus 401: ${v} -> ${r.status}`);
      assert.ok(!r.body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `isi berkas bocor: ${v}`);
    }
    // sesi pembaca (bukan admin) juga ditolak
    await s.request('POST', '/api/auth/register', {username: 'pembaca9', password: 'sandi-panjang-9'});
    const reg = await fetch(s.base + '/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'pembaca9', password: 'sandi-panjang-9', role: 'user'})});
    const readerCookie = reg.headers.get('set-cookie').split(';')[0];
    for (const v of ['/media/_drafts/d_abc123/cover-x.png', '/media//_drafts/d_abc123/cover-x.png', '/media/%2F_drafts/d_abc123/cover-x.png']) {
      assert.equal((await s.rawGet(v, {cookie: readerCookie})).status, 401, `pembaca: ${v}`);
    }
    // media publik tetap terbuka (tanpa sesi), termasuk varian // yang menunjuk ke berkas publik
    assert.equal((await s.rawGet('/media/publik/a.png')).status, 200);
    assert.equal((await s.rawGet('/media//publik/a.png')).status, 200);
    // admin tetap dapat membaca draft, dengan cache-control private
    const cookie = await s.login();
    const ok = await s.rawGet('/media/_drafts/d_abc123/cover-x.png', {cookie});
    assert.equal(ok.status, 200); assert.match(ok.headers['cache-control'], /private, no-store/);
    const ok2 = await s.rawGet('/media//_drafts/d_abc123/cover-x.png', {cookie});
    assert.equal(ok2.status, 200); assert.match(ok2.headers['cache-control'], /private, no-store/);
    // path tidak valid -> 400; traversal keluar media tidak pernah membaca db.json
    assert.equal((await s.rawGet('/media/%zz')).status, 400);
    assert.equal((await s.rawGet('/media/a%00b')).status, 400);
    for (const v of ['/media/..%2fdb.json', '/media/../db.json', '/media/%2e%2e/db.json']) {
      const r = await s.rawGet(v);
      assert.ok([403, 404].includes(r.status), `${v} -> ${r.status}`);
      assert.ok(!r.body.toString().includes('"comics"'), `db.json bocor lewat ${v}`);
    }
  } finally { await s.stop(); }
});

// QA D-03: kontrak FR-03 / §4.1 — field respons scan + endpoint cover.
test('QA D-03: respons scan memuat chaptersTotal/sourceCanonicalUrl/coverPreviewUrl/publishable/blockers; GET .../cover mengembalikan gambar (hanya admin)', async () => {
  const w = await startFakeWorker(); w.setScan(URL1, scanResult({url: URL1, numbers: [12, 11, 2], title: 'Seri Kontrak Uji'}));
  const s = await startServer({env: {SCAN_WORKER_URL: w.url, SCAN_WORKER_TOKEN: w.token, SCAN_DEV_MODE: 'true', SCAN_POLL_MS: '30', SCAN_MIN_FREE_BYTES: '1'}});
  try {
    await s.login();
    const scan = await s.request('POST', '/api/admin/scan', {url: URL1});
    assert.equal(scan.status, 201);
    const d = scan.json, id = d.draftId;
    assert.equal(d.chaptersTotal, d.chapters.length);
    assert.equal(d.chaptersTotal, 3);
    assert.equal(typeof d.sourceCanonicalUrl, 'string');
    assert.ok(d.sourceCanonicalUrl.startsWith('https://sumber.example/'));
    assert.equal(d.comic.coverPreviewUrl, `/api/admin/scan/${id}/cover`);
    assert.equal(d.publishable, false);
    assert.ok(Array.isArray(d.blockers));
    assert.equal(d.blockers[0].code, 'CHAPTER_NOT_READY');
    assert.deepEqual([...d.blockers[0].keys].sort(), d.chapters.map(c => c.key).sort());
    // GET detail juga memuat field yang sama
    const det = (await s.request('GET', `/api/admin/scan/${id}`)).json;
    assert.equal(det.chaptersTotal, 3); assert.equal(det.comic.coverPreviewUrl, d.comic.coverPreviewUrl);
    // cover: tanpa sesi 401, admin 200 + content-type gambar + magic byte, metode lain 405, draft lain 404
    s.logout();
    assert.equal((await fetch(s.base + d.comic.coverPreviewUrl)).status, 401);
    await s.login();
    const cover = await s.request('GET', d.comic.coverPreviewUrl);
    assert.equal(cover.status, 200);
    assert.match(cover.headers.get('content-type'), /^image\/(png|jpeg|webp)$/);
    assert.match(cover.headers.get('cache-control'), /private, no-store/);
    assert.ok(cover.buf.length > 8);
    assert.equal((await s.request('POST', d.comic.coverPreviewUrl, {})).status, 405);
    assert.equal((await s.request('GET', '/api/admin/scan/d_tidakada/cover')).status, 404);
    // selesai diunduh -> publishable true, blockers kosong; nomor kosong/ganda memunculkan blocker yang sesuai
    assert.equal((await s.request('POST', `/api/admin/scan/${id}/download`, {})).status, 202);
    await until(async () => (await s.request('GET', `/api/admin/scan/${id}/progress`)).json.state === 'READY');
    const ready = (await s.request('GET', `/api/admin/scan/${id}`)).json;
    assert.equal(ready.publishable, true); assert.deepEqual(ready.blockers, []);
    const k = ready.chapters.map(c => c.key);
    const dup = (await s.request('PATCH', `/api/admin/scan/${id}`, {chapters: [{key: k[1], number: ready.chapters[0].number}]})).json;
    assert.equal(dup.publishable, false);
    assert.equal(dup.blockers[0].code, 'DUPLICATE_CHAPTER_NUMBER');
    assert.deepEqual(dup.blockers[0].keys.sort(), [k[0], k[1]].sort());
    const nonum = (await s.request('PATCH', `/api/admin/scan/${id}`, {chapters: [{key: k[1], number: null}]})).json;
    assert.ok(nonum.blockers.some(b => b.code === 'CHAPTER_NUMBER_REQUIRED' && b.keys.includes(k[1])));
    // setelah dibuang, cover 404
    assert.equal((await s.request('DELETE', `/api/admin/scan/${id}`)).status, 200);
    assert.equal((await s.request('GET', d.comic.coverPreviewUrl)).status, 404);
  } finally { await s.stop(); await w.close(); }
});
