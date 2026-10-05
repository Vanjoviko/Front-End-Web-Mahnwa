'use strict';
// Worker palsu (HTTP) yang meniru kontrak /worker/v1/* untuk pengujian FE. Seluruh konten dibangkitkan program.
const http = require('node:http');
const crypto = require('node:crypto');
const {makeImage, sha256, MIME} = require('./images');

function startFakeWorker({token = 'test-token', stepMs = 15, port = 0} = {}) {
  const st = {
    jobs: new Map(), requests: [], scanResults: new Map(), plans: {}, held: false, cover: makeImage('png', 4096, 99),
    staged: new Map(), deletedChapters: [], deletedJobs: [], cancelled: [], diskFree: 10 ** 12, scanCalls: 0, startCalls: 0
  };
  const defaultPlan = key => ({pages: 3 + (parseInt(key.slice(2), 10) % 3), kind: 'png'});
  const planFor = key => ({...defaultPlan(key), ...(st.plans[key] || {})});

  function buildChapter(key) {
    const plan = planFor(key);
    const files = [];
    for (let n = 1; n <= plan.pages; n++) {
      const kind = plan.kinds ? plan.kinds[(n - 1) % plan.kinds.length] : plan.kind;
      const data = makeImage(kind, plan.pageBytes || 1500 + n * 37, n + key.length);
      files.push({number: n, kind, data, sha256: sha256(data)});
    }
    return files;
  }

  function tick(job) {
    if (st.held || job.state === 'CANCELLED') return;
    const next = [...job.chapters.values()].find(c => c.status === 'QUEUED' || c.status === 'DOWNLOADING');
    if (!next) { job.state = 'COMPLETED'; return; }
    const plan = planFor(next.key);
    if (next.status === 'QUEUED') { next.status = 'DOWNLOADING'; next.attempts = 1; next.pages_total = plan.pages; return; }
    if (plan.fail) { next.status = 'FAILED'; next.error_code = plan.fail; next.error_message = `Gagal (${plan.fail})`; return; }
    next.pages_done = Math.min(next.pages_total, next.pages_done + 2);
    if (next.pages_done >= next.pages_total) { next.status = 'COMPLETED'; next.files = buildChapter(next.key); }
  }
  const timer = setInterval(() => { for (const job of st.jobs.values()) tick(job); }, stepMs);
  timer.unref();

  const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(b)}); res.end(b); };
  const err = (res, status, code, msg) => send(res, status, {error: msg || code, code});
  async function readJson(req) { let b = ''; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    st.requests.push({method: req.method, path: url.pathname, headers: {...req.headers}});
    if (url.pathname === '/health') return send(res, 200, {ok: true, version: 'fake', adapters: ['manifest']});
    if (req.headers['x-worker-token'] !== token) return err(res, 401, 'UNAUTHORIZED', 'Token worker tidak valid.');
    const parts = url.pathname.split('/').filter(Boolean); // worker v1 ...
    try {
      if (req.method === 'GET' && parts[2] === 'status') return send(res, 200, {disk_free_bytes: st.diskFree, min_free_disk_bytes: 0, active_jobs: st.jobs.size, limits: {}});
      if (req.method === 'POST' && parts[2] === 'scan') {
        st.scanCalls++;
        const body = await readJson(req);
        if (st.scanDelayMs) await new Promise(r => setTimeout(r, st.scanDelayMs));
        const result = st.scanResults.get(body.url) || st.scanResults.get('*');
        if (!result) return err(res, 422, 'SOURCE_NOT_SUPPORTED', 'Sumber tidak didukung.');
        if (result.__error) return err(res, result.__error.status, result.__error.code, result.__error.message);
        const copy = structuredClone(result);
        if (copy.cover === 'stage') { const id = 's_' + crypto.randomBytes(8).toString('hex'); st.staged.set(id, st.cover); copy.cover = {staged_id: id, content_type: 'image/png', bytes: st.cover.length}; }
        return send(res, 200, copy);
      }
      if (parts[2] === 'staging') {
        const id = parts[3];
        if (req.method === 'GET') { const buf = st.staged.get(id); if (!buf) return err(res, 404, 'STAGED_NOT_FOUND'); res.writeHead(200, {'content-type': 'image/png', 'content-length': buf.length}); return res.end(buf); }
        if (req.method === 'DELETE') { st.staged.delete(id); return send(res, 200, {ok: true}); }
      }
      if (req.method === 'POST' && parts[2] === 'jobs' && parts.length === 3) {
        st.startCalls++;
        const body = await readJson(req);
        if (st.jobs.has(body.job_id)) return err(res, 409, 'JOB_EXISTS', 'Job sudah ada.');
        const job = {id: body.job_id, state: 'RUNNING', body, chapters: new Map(), updated: Date.now()};
        for (const c of body.chapters) job.chapters.set(c.key, {key: c.key, ref: c.ref, status: 'QUEUED', pages_total: 0, pages_done: 0, attempts: 0, error_code: null, error_message: null, files: []});
        st.jobs.set(job.id, job);
        return send(res, 202, {job_id: job.id, state: job.state, chapters: job.chapters.size});
      }
      const job = st.jobs.get(parts[3]);
      if (parts[2] === 'jobs') {
        if (!job) return err(res, 404, 'JOB_NOT_FOUND', 'Job tidak ditemukan.');
        const action = parts[4];
        if (req.method === 'GET' && action === 'progress') return send(res, 200, {job_id: job.id, state: job.state, updated_at: new Date().toISOString(), chapters: [...job.chapters.values()].map(({files, ref, ...c}) => c)});
        if (req.method === 'POST' && action === 'cancel') { st.cancelled.push(job.id); job.state = 'CANCELLED'; for (const c of job.chapters.values()) if (c.status === 'QUEUED' || c.status === 'DOWNLOADING') c.status = 'CANCELLED'; return send(res, 200, {job_id: job.id, state: job.state, chapters: []}); }
        if (req.method === 'DELETE' && parts.length === 4) { st.deletedJobs.push(job.id); st.jobs.delete(job.id); return send(res, 200, {ok: true}); }
        if (action === 'chapters') {
          const chapter = job.chapters.get(parts[5]);
          if (!chapter) return err(res, 404, 'CHAPTER_NOT_FOUND');
          if (req.method === 'DELETE') { st.deletedChapters.push(`${job.id}/${chapter.key}`); chapter.released = true; return send(res, 200, {ok: true}); }
          if (chapter.status !== 'COMPLETED' || chapter.released) return err(res, 409, 'CHAPTER_NOT_READY');
          if (parts[6] === 'manifest') {
            const plan = planFor(chapter.key);
            return send(res, 200, {key: chapter.key, status: 'COMPLETED', pages: chapter.files.map(f => ({page_number: f.number, content_type: MIME[f.kind], bytes: plan.lieBytes ? f.data.length + 1 : f.data.length, sha256: plan.badSha ? '0'.repeat(64) : f.sha256, url: `http://evil.invalid/pages/${f.number}`}))});
          }
          if (parts[6] === 'pages') {
            const f = chapter.files[Number(parts[7]) - 1];
            if (!f) return err(res, 404, 'PAGE_NOT_FOUND');
            const plan = planFor(chapter.key);
            const data = plan.notImage ? Buffer.from('<html>bukan gambar sama sekali</html>'.padEnd(f.data.length, ' ')) : f.data;
            res.writeHead(200, {'content-type': MIME[f.kind], 'content-length': data.length});
            return res.end(data);
          }
        }
      }
      return err(res, 404, 'NOT_FOUND');
    } catch (e) { return err(res, 500, 'INTERNAL_ERROR', e.message); }
  });

  const api = {
    state: st, token,
    get url() { return `http://127.0.0.1:${server.address().port}`; },
    hold() { st.held = true; }, release() { st.held = false; },
    restart() { st.jobs.clear(); },
    close: () => new Promise(r => { clearInterval(timer); server.closeAllConnections?.(); server.close(() => r()); }),
    async stopListening() { server.closeAllConnections?.(); await new Promise(r => server.close(() => r())); },
    async listenAgain(p) { await new Promise(r => server.listen(p, '127.0.0.1', r)); },
    setScan(url, result) { st.scanResults.set(url, result); },
    plan(key, plan) { st.plans[key] = {...(st.plans[key] || {}), ...plan}; }
  };
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(api)));
}

// Hasil scan standar: n chapter bernomor + (opsional) 1 "Extra" tanpa nomor.
function scanResult({title = 'Seri Uji Orisinal', url = 'https://sumber.example/seri/manifest.json', numbers = [3, 2, 1], extra = false, cover = 'stage', status = 'Berjalan'} = {}) {
  const chapters = numbers.map(n => ({ref: `ref-${n}`, number_raw: `Chapter ${n}`, number: String(n), title: `Judul ${n}`, date: '2026-09-0' + (1 + (Number(n) % 8)), issues: []}));
  if (extra) chapters.push({ref: 'ref-extra', number_raw: 'Extra', number: null, title: 'Cerita tambahan', date: '', issues: ['needs_number']});
  return {
    adapter: 'manifest', adapter_label: 'Manifest JSON', canonical_url: url,
    comic: {title, alt: 'Alt', synopsis: 'Sinopsis orisinal untuk pengujian.', status, author: 'Studio Uji', type: 'Manhwa', genres: ['Fantasi', 'Drama'], year: 2026},
    cover, chapters, permission_note: 'izin uji dicatat', warnings: []
  };
}

module.exports = {startFakeWorker, scanResult};
