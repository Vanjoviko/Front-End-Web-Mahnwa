'use strict';
// Uji unit Auto-Sync (lib/subscriptions.js) dengan service scan tiruan + db in-memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSubscriptions, normalizeUrl} = require('../lib/subscriptions');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONFIG = {enabled: false, tickS: 60, concurrency: 1, maxNewPerRun: 5, syncTimeoutMs: 2000, defaultInterval: 360, minInterval: 5, maxInterval: 10080, jitterS: 0, maxFailures: 5, pollMs: 5};

function harness({chaptersByUrl = {}} = {}) {
  const db = {comics: [], subscriptions: []};
  let seq = 0;
  const drafts = new Map();
  const service = {
    chaptersByUrl, published: [], patchCalls: [], failPublish: false, failScan: false,
    async scan(url) {
      if (service.failScan) throw Object.assign(new Error('scan gagal'), {status: 502, code: 'WORKER_UNAVAILABLE'});
      const spec = chaptersByUrl[url] || {comic: {title: 'Contoh'}, chapters: []};
      const id = 'd_' + (++seq);
      const chapters = (spec.chapters || []).map((ch, i) => ({
        key: 'c_' + String(i + 1).padStart(4, '0'), flag: ch.flag || 'NEW',
        excluded: ch.excluded !== undefined ? ch.excluded : (ch.flag === 'EXISTS'),
        number: ch.number === null || ch.number === undefined ? null : String(ch.number), numberRaw: ch.number === null || ch.number === undefined ? '' : String(ch.number),
        title: ch.title || '', date: '2026-01-01'
      }));
      const draft = {draftId: id, canonicalUrl: url, existingComicId: spec.existingComicId || null, comic: {title: spec.comic?.title || 'Contoh'}, chapters, downloaded: 0};
      drafts.set(id, draft);
      return draft;
    },
    async discard(id) { drafts.delete(id); },
    async patch(id, body) {
      const d = drafts.get(id);
      if (d && Array.isArray(body?.chapters)) for (const e of body.chapters) { const c = d.chapters.find(x => x.key === e.key); if (c && 'excluded' in e) c.excluded = e.excluded; }
      service.patchCalls.push(body);
      return {};
    },
    async startDownload(id, body) { const d = drafts.get(id); d.downloaded = (body.chapterKeys || []).length; d.state = 'DOWNLOADING'; return {draftId: id}; },
    async progress(id) { drafts.get(id); return {state: 'READY'}; },
    async publish(id) {
      if (service.failPublish) throw Object.assign(new Error('publish gagal'), {status: 409, code: 'CHAPTER_NOT_READY'});
      const d = drafts.get(id); d.published = true; service.published.push(id);
      return {comicId: 'comic-1', created: false, appendedToExisting: true, chaptersPublished: d?.downloaded || 0, pagesPublished: 0};
    }
  };
  const svc = createSubscriptions({getDb: async () => db, saveDb: async () => {}, service, config: CONFIG, logger: {log() {}, warn() {}, error() {}}});
  const idle = async () => { for (let i = 0; i < 200; i++) { if (svc._running.size === 0 && svc._queue.length === 0) return; await sleep(5); } throw new Error('autosync tidak idle'); };
  return {db, service, svc, idle};
}

test('normalizeUrl: buang trailing slash & hash, tolak bukan http(s)', () => {
  assert.equal(normalizeUrl('https://a.example/series/1/'), 'https://a.example/series/1');
  assert.equal(normalizeUrl('https://a.example/x#frag'), 'https://a.example/x');
  assert.equal(normalizeUrl('ftp://a.example/x'), null);
  assert.equal(normalizeUrl('bukan url'), null);
});

test('add: bulk text (baris baru), dedup, dan lewati URL tidak valid', async () => {
  const {db, svc} = harness();
  const out = await svc.add({text: 'https://a.example/series/1\nhttps://a.example/series/2\nbukan-url\nhttps://a.example/series/1/'});
  assert.equal(out.added, 2, 'dua unik ditambah (duplikat trailing-slash digabung)');
  assert.ok(out.skipped.some(s => s.reason === 'URL tidak valid'));
  assert.ok(out.skipped.some(s => s.reason === 'sudah terdaftar'));
  assert.equal(db.subscriptions.length, 2);
  const again = await svc.add({url: 'https://a.example/series/1'});
  assert.equal(again.added, 0);
  assert.equal(again.skipped[0].reason, 'sudah terdaftar');
});

test('patch: ubah enabled & interval (dibatasi)', async () => {
  const {db, svc} = harness();
  await svc.add({url: 'https://a.example/series/1'});
  const id = db.subscriptions[0].id;
  const v = await svc.patch(id, {enabled: false, intervalMinutes: 1});
  assert.equal(v.enabled, false);
  assert.equal(v.intervalMinutes, CONFIG.minInterval, 'interval di bawah minimum dinaikkan');
});

test('syncNow: chapter baru -> diunduh hanya yang BARU lalu dipublikasikan', async () => {
  const {db, service, svc, idle} = harness({chaptersByUrl: {
    'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '3'}, {number: '2'}, {number: '1', flag: 'EXISTS'}]}
  }});
  await svc.add({url: 'https://a.example/series/1', autoPublish: true});
  const id = db.subscriptions[0].id;
  await svc.syncNow(id);
  await idle();
  const sub = db.subscriptions[0];
  assert.equal(sub.lastStatus, 'ok');
  assert.equal(sub.lastNewChapters, 2, 'hanya 2 chapter BARU yang dipublikasikan');
  assert.equal(sub.title, 'Seri A', 'judul terisi dari scan pertama');
  assert.equal(service.published.length, 1);
});

test('syncNow idempoten: sinkronisasi kedua tanpa chapter baru -> noop', async () => {
  const {db, service, svc, idle} = harness({chaptersByUrl: {
    'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '1'}, {number: '2'}]}
  }});
  await svc.add({url: 'https://a.example/series/1'});
  const id = db.subscriptions[0].id;
  await svc.syncNow(id); await idle();
  assert.equal(service.published.length, 1);
  // Sumber kini hanya punya chapter yang sudah ada.
  service.chaptersByUrl['https://a.example/series/1'] = {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '1', flag: 'EXISTS'}, {number: '2', flag: 'EXISTS'}]};
  await svc.syncNow(id); await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'ok');
  assert.equal(db.subscriptions[0].lastNewChapters, 0);
  assert.equal(service.published.length, 1, 'tidak ada publikasi ganda');
});

test('autoPublish=false: chapter baru tertahan sebagai draft untuk review', async () => {
  const {db, service, svc, idle} = harness({chaptersByUrl: {
    'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '1'}]}
  }});
  await svc.add({url: 'https://a.example/series/1', autoPublish: false});
  const id = db.subscriptions[0].id;
  await svc.syncNow(id); await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'draft');
  assert.equal(service.published.length, 0, 'tidak dipublikasikan otomatis');
});

test('preview: daftar chapter baru tanpa mempublikasi', async () => {
  const {svc} = harness({chaptersByUrl: {
    'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '5'}, {number: '4'}, {number: '3', flag: 'EXISTS'}]}
  }});
  const {subscriptions} = await svc.add({url: 'https://a.example/series/1'});
  const pv = await svc.preview(subscriptions[0].id);
  assert.equal(pv.newCount, 2);
  assert.deepEqual(pv.newChapters.map(c => c.number), ['5', '4']);
  assert.equal(pv.existing, true);
});

test('cap per run: kelebihan chapter baru ditunda (excluded) agar publish tidak gagal', async () => {
  const chapters = Array.from({length: 8}, (_, i) => ({number: String(8 - i)}));
  const {db, service, svc, idle} = harness({chaptersByUrl: {'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters}}});
  await svc.add({url: 'https://a.example/series/1', autoPublish: true});
  const id = db.subscriptions[0].id;
  await svc.syncNow(id); await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'ok');
  assert.equal(db.subscriptions[0].lastNewChapters, CONFIG.maxNewPerRun, 'hanya maxNewPerRun yang dipublikasikan');
  assert.ok(service.patchCalls.some(b => Array.isArray(b.chapters) && b.chapters.length === 3), '3 chapter sisanya ditunda');
});

test('chapter tanpa nomor valid -> ditahan sebagai draft, tidak dipublikasikan', async () => {
  const {db, service, svc, idle} = harness({chaptersByUrl: {'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: null}, {number: null}]}}});
  await svc.add({url: 'https://a.example/series/1', autoPublish: true});
  const id = db.subscriptions[0].id;
  await svc.syncNow(id); await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'draft');
  assert.equal(service.published.length, 0);
});

test('gagal sync -> lastStatus "error" dan pesan tercatat', async () => {
  const {db, service, svc, idle} = harness({chaptersByUrl: {'https://a.example/series/1': {comic: {title: 'Seri A'}, chapters: [{number: '1'}]}}});
  await svc.add({url: 'https://a.example/series/1'});
  service.failPublish = true;
  const id = db.subscriptions[0].id;
  await svc.syncNow(id); await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'error');
  assert.match(db.subscriptions[0].lastError, /publish gagal/);
});

test('tick: menjadwalkan ulang dan memproses langganan yang jatuh tempo', async () => {
  const {db, svc, idle} = harness({chaptersByUrl: {
    'https://a.example/series/1': {comic: {title: 'Seri A'}, existingComicId: 'comic-1', chapters: [{number: '1'}]}
  }});
  await svc.add({url: 'https://a.example/series/1'});
  db.subscriptions[0].nextCheckAt = new Date(Date.now() - 1000).toISOString();
  await svc.tick();
  await idle();
  assert.equal(db.subscriptions[0].lastStatus, 'ok');
  assert.ok(Date.parse(db.subscriptions[0].nextCheckAt) > Date.now(), 'nextCheckAt dimajukan');
});
