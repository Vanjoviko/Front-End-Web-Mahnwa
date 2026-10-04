'use strict';
// E2E opsional terhadap worker Python sungguhan + sumber fixture. Dilewati bila variabel lingkungan tidak ada.
//   SCAN_E2E_WORKER_URL=http://127.0.0.1:8000 SCAN_E2E_WORKER_TOKEN=dev-token SCAN_E2E_SOURCE_URL=http://127.0.0.1:9100/menara-biru/manifest.json npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {startServer} = require('./helpers/server');
const url = process.env.SCAN_E2E_WORKER_URL, token = process.env.SCAN_E2E_WORKER_TOKEN, source = process.env.SCAN_E2E_SOURCE_URL;
const until = async (fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)); } };

test('E2E worker sungguhan: scan -> Download All -> finalisasi -> publish', {skip: !(url && token && source) && 'SCAN_E2E_* tidak diatur'}, async () => {
  const s = await startServer({env: {SCAN_WORKER_URL: url, SCAN_WORKER_TOKEN: token, SCAN_DEV_MODE: 'true', SCAN_POLL_MS: '100', SCAN_MIN_FREE_BYTES: '1'}});
  try {
    await s.login();
    const scan = await s.request('POST', '/api/admin/scan', {url: source});
    assert.equal(scan.status, 201, JSON.stringify(scan.json));
    const id = scan.json.draftId;
    assert.equal(scan.json.comic.title, 'Menara Biru Mekar');
    assert.equal(scan.json.counts.total, 11);
    assert.equal((await s.request('POST', `/api/admin/scan/${id}/download`, {})).status, 202);
    const done = await until(async () => { const p = (await s.request('GET', `/api/admin/scan/${id}/progress`)).json; return p.state === 'READY' ? p : null; });
    assert.equal(done.totals.completed, 11);
    await s.request('PATCH', `/api/admin/scan/${id}`, {chapters: [{key: 'c_0011', number: '9'}]});
    const pub = await s.request('POST', `/api/admin/scan/${id}/publish`, {});
    assert.equal(pub.status, 201, JSON.stringify(pub.json));
    const cat = await fetch(s.base + '/api/catalog').then(r => r.json());
    const comic = cat.comics.find(c => c.id === pub.json.comicId);
    assert.equal(comic.chapters.length, 11);
    const pages = await fetch(`${s.base}/api/comics/${comic.id}/chapters/${comic.chapters[0].id}/pages`).then(r => r.json());
    for (const p of pages.pages) assert.equal((await fetch(s.base + p.image_url)).status, 200);
  } finally { await s.stop(); }
});
