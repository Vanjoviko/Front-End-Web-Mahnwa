'use strict';
// Layanan scan-import sisi FE: draft (db.scanDrafts), monitor job worker, ingest media, dan publish atomik.
// Draft TIDAK pernah tampil di katalog publik/konektor/admin lama sampai di-publish (FR-12).
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {WorkerError} = require('./scan-worker');
const {assertPublicUrl, GuardError} = require('./net-guard');
const {canonicalize, compare, sortDesc} = require('./chapter-number');
const media = require('./scan-media');
const {MEDIA_ROOT, comicStorageKey} = require('./chapter-media');

const TYPES = ['Manhwa', 'Manhua', 'Manga'];
const STATUSES = ['Berjalan', 'Tamat', 'Hiatus'];
const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const ACTIVE_STATES = new Set(['SCANNED', 'DOWNLOADING', 'READY', 'CANCELLED']);

const fail = (status, code, message, extra) => new WorkerError(status, code, message, extra);
const hex = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();

function slug(title) {
  return String(title || 'komik').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'komik';
}

function createScanService({getDb, saveDb, worker, config, logger = console, statfs = fs.statfs}) {
  const limits = config.limits;
  const live = new Map();       // draftId -> {reachable, unreachableSince, chapters: Map(key -> {pagesDone,pagesTotal,attempts,phase}), updatedAt}
  const monitors = new Set();   // draftId yang sedang dipantau
  let scanChain = Promise.resolve();

  const findDraft = (db, id) => (db.scanDrafts || []).find(d => d.id === id);
  async function mustDraft(id) {
    const db = await getDb();
    const draft = findDraft(db, id);
    if (!draft) throw fail(404, 'DRAFT_NOT_FOUND', 'Draft scan tidak ditemukan.');
    return {db, draft};
  }
  const touch = draft => { draft.updatedAt = nowIso(); };

  // ---------- tampilan (proyeksi aman untuk browser: tanpa ref/URL asal chapter/path internal) ----------
  function chapterIssues(draft) {
    const seen = new Map();
    for (const c of draft.chapters) if (!c.excluded && c.number !== null) seen.set(c.number, (seen.get(c.number) || 0) + 1);
    return seen;
  }
  // FR-03/§4.1: alasan draft belum dapat dipublish (kode sama dengan galat publish). Hanya memeriksa isi draft.
  function blockersOf(draft) {
    if (draft.state === 'PUBLISHED') return [{code: 'ALREADY_PUBLISHED'}];
    if (draft.state === 'DOWNLOADING') return [{code: 'JOB_ALREADY_RUNNING'}];
    const included = draft.chapters.filter(c => !c.excluded);
    if (!included.length) return [{code: 'NO_CHAPTERS'}];
    const out = [];
    const notReady = included.filter(c => c.status !== 'COMPLETED' || !c.pages?.length);
    if (notReady.length) out.push({code: 'CHAPTER_NOT_READY', keys: notReady.map(c => c.key)});
    const noNumber = included.filter(c => c.number === null);
    if (noNumber.length) out.push({code: 'CHAPTER_NUMBER_REQUIRED', keys: noNumber.map(c => c.key)});
    const byNumber = new Map();
    for (const c of included) if (c.number !== null) byNumber.set(c.number, [...(byNumber.get(c.number) || []), c.key]);
    const dups = [...byNumber.values()].filter(k => k.length > 1).flat();
    if (dups.length) out.push({code: 'DUPLICATE_CHAPTER_NUMBER', keys: dups});
    return out;
  }
  function draftView(draft) {
    const dup = chapterIssues(draft);
    const chapters = draft.chapters.map(c => {
      const issues = new Set(c.issues || []);
      if (!c.excluded && c.number !== null && dup.get(c.number) > 1) issues.add('duplicate_number');
      if (c.number === null && !c.excluded) issues.add('number_required');
      const liveInfo = live.get(draft.id)?.chapters.get(c.key);
      return {
        key: c.key, numberRaw: c.numberRaw, number: c.number, title: c.title, date: c.date, flag: c.flag, issues: [...issues],
        excluded: Boolean(c.excluded), status: c.status || null,
        // chapter FAILED/CANCELLED: berkas dibersihkan (FR-08) -> pageCount 0, bukan hitungan parsial/menyesatkan (QA D-07)
        pageCount: (c.status === 'FAILED' || c.status === 'CANCELLED') ? 0 : (c.pages?.length || liveInfo?.pagesTotal || 0),
        attempts: c.attempts || 0, errorCode: c.errorCode || null, errorMessage: c.errorMessage || null
      };
    });
    const included = chapters.filter(c => !c.excluded);
    return {
      draftId: draft.id, state: draft.state, adapter: draft.adapter, adapterLabel: draft.adapterLabel, canonicalUrl: draft.canonicalUrl, sourceCanonicalUrl: draft.canonicalUrl,
      createdAt: draft.createdAt, updatedAt: draft.updatedAt, existingComicId: draft.existingComicId || null, publishedComicId: draft.publishedComicId || null,
      warnings: draft.warnings || [], permissionNote: draft.permissionNote || null,
      comic: {...draft.comic, coverPreviewUrl: draft.comic?.cover ? `/api/admin/scan/${draft.id}/cover` : null},
      chaptersTotal: chapters.length, chapters,
      publishable: blockersOf(draft).length === 0, blockers: blockersOf(draft),
      counts: {
        total: chapters.length, new: chapters.filter(c => c.flag === 'NEW').length, exists: chapters.filter(c => c.flag === 'EXISTS').length,
        included: included.length, completed: chapters.filter(c => c.status === 'COMPLETED').length,
        failed: chapters.filter(c => c.status === 'FAILED').length, cancelled: chapters.filter(c => c.status === 'CANCELLED').length
      },
      job: draft.job ? {startedAt: draft.job.startedAt, finishedAt: draft.job.finishedAt} : null,
      cancelRequested: Boolean(draft.cancelRequested), confirmReplace: Boolean(draft.confirmReplace)
    };
  }
  function summary(draft) {
    const v = draftView(draft);
    return {draftId: v.draftId, title: v.comic.title, cover: v.comic.cover, state: v.state, adapterLabel: v.adapterLabel, createdAt: v.createdAt, updatedAt: v.updatedAt, chapters: v.counts.total, completed: v.counts.completed, publishedComicId: v.publishedComicId};
  }
  async function list() {
    const db = await getDb();
    return {drafts: (db.scanDrafts || []).map(summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))};
  }
  async function get(id) { const {draft} = await mustDraft(id); return draftView(draft); }
  // GET /api/admin/scan/:id/cover — berkas sampul draft (hanya admin; route yang menjaga sesi).
  async function coverFile(id) {
    const {draft} = await mustDraft(id);
    const cover = String(draft.comic?.cover || '');
    const prefix = `/media/${media.DRAFTS_DIR}/${draft.id}/`;
    const name = cover.startsWith(prefix) ? path.basename(cover) : '';
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw fail(404, 'COVER_NOT_FOUND', 'Sampul draft tidak tersedia.');
    const type = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}[path.extname(name).toLowerCase()];
    if (!type) throw fail(404, 'COVER_NOT_FOUND', 'Sampul draft tidak tersedia.');
    try { return {buf: await fs.readFile(path.join(MEDIA_ROOT, media.DRAFTS_DIR, draft.id, name)), type}; }
    catch { throw fail(404, 'COVER_NOT_FOUND', 'Sampul draft tidak tersedia.'); }
  }

  // ---------- scan ----------
  function normalizeTitle(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  async function scan(rawUrl) {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!url) throw fail(400, 'INVALID_URL', 'Masukkan URL sumber.');
    try { await assertPublicUrl(url, {allowDev: config.devMode}); }
    catch (error) { if (error instanceof GuardError) throw fail(error.status || 400, error.code, error.message); throw error; }
    const result = await worker.scan(url);
    const run = async () => {
      const db = await getDb();
      db.scanDrafts ||= [];
      const canonicalUrl = String(result.canonical_url || url);
      const dupe = db.scanDrafts.find(d => ACTIVE_STATES.has(d.state) && d.canonicalUrl === canonicalUrl);
      if (dupe) {
        if (result.cover?.staged_id) await worker.deleteStaged(result.cover.staged_id).catch(() => {});
        throw fail(409, 'DRAFT_EXISTS', 'Draft untuk URL ini sudah ada. Lanjutkan atau buang draft tersebut.', {draftId: dupe.id});
      }
      const existing = db.comics.find(c => c.scanSource?.canonicalUrl === canonicalUrl);
      const existingNumbers = new Set((existing?.chapters || []).map(c => canonicalize(c.number)).filter(Boolean));
      const draftId = 'd_' + hex(8);
      const warnings = [...(result.warnings || [])].filter(w => typeof w === 'string').slice(0, 20);
      let cover = '';
      if (result.cover?.staged_id) {
        try {
          const response = await worker.stagedCover(result.cover.staged_id);
          const declared = Number(response.headers.get('content-length') || 0);
          if (declared > limits.maxCoverBytes) throw new Error('cover terlalu besar');
          const chunks = []; let size = 0;
          for await (const chunk of response.body) { size += chunk.length; if (size > limits.maxCoverBytes) throw new Error('cover terlalu besar'); chunks.push(Buffer.from(chunk)); }
          cover = await media.saveDraftCover(draftId, Buffer.concat(chunks));
        } catch (error) {
          logger.warn?.(`[scan] cover tidak dapat disimpan: ${error.code || error.message}`);
          if (!warnings.includes('COVER_UNAVAILABLE')) warnings.push('COVER_UNAVAILABLE');
        } finally { await worker.deleteStaged(result.cover.staged_id).catch(() => {}); }
      }
      const c = result.comic || {};
      const titleDup = !existing && db.comics.some(x => normalizeTitle(x.title) === normalizeTitle(c.title));
      if (titleDup) warnings.push('TITLE_EXISTS');
      const chapters = (Array.isArray(result.chapters) ? result.chapters : []).map((ch, index) => {
        const number = ch.number === null || ch.number === undefined ? null : canonicalize(ch.number);
        const exists = number !== null && existingNumbers.has(number);
        return {
          key: 'c_' + String(index + 1).padStart(4, '0'), ref: str(ch.ref, 512), numberRaw: str(ch.number_raw, 120), number, title: str(ch.title, 140),
          date: str(ch.date, 40), issues: (ch.issues || []).filter(x => typeof x === 'string').slice(0, 8),
          flag: exists ? 'EXISTS' : 'NEW', excluded: exists, status: null, attempts: 0, errorCode: null, errorMessage: null, pages: [], bytes: 0
        };
      });
      const draft = {
        id: draftId, state: 'SCANNED', adapter: str(result.adapter, 64), adapterLabel: str(result.adapter_label || result.adapter, 80), canonicalUrl,
        createdAt: nowIso(), updatedAt: nowIso(), existingComicId: existing?.id || null, warnings, permissionNote: result.permission_note ? str(result.permission_note, 500) : null,
        job: null, cancelRequested: false, confirmReplace: false,
        comic: {
          title: str(c.title, 140), alt: str(c.alt, 140), synopsis: str(c.synopsis, 2000), status: STATUSES.includes(c.status) ? c.status : null,
          author: str(c.author, 140), type: TYPES.includes(c.type) ? c.type : null,
          genres: (Array.isArray(c.genres) ? c.genres : []).map(g => str(g, 40)).filter(Boolean).slice(0, 12), year: Number.isInteger(c.year) ? c.year : null, cover
        },
        chapters
      };
      db.scanDrafts.push(draft);
      await saveDb(db);
      return draftView(draft);
    };
    const next = scanChain.then(run, run);
    scanChain = next.catch(() => {});
    return next;
  }

  // ---------- download ----------
  async function diskGuard() {
    try {
      const s = await statfs(path.dirname(MEDIA_ROOT));
      const free = Number(s.bavail) * Number(s.bsize);
      if (free < config.minFreeBytes) throw fail(507, 'INSUFFICIENT_DISK', 'Ruang disk tidak cukup untuk mengunduh chapter.');
    } catch (error) { if (error instanceof WorkerError) throw error; /* statfs tidak tersedia: lewati */ }
  }

  async function startDownload(draftId, body = {}) {
    notPublishing(draftId);
    const {db, draft} = await mustDraft(draftId);
    if (draft.state === 'PUBLISHED') throw fail(409, 'ALREADY_PUBLISHED', 'Draft ini sudah dipublikasikan.');
    if (draft.state === 'DOWNLOADING') throw fail(409, 'JOB_ALREADY_RUNNING', 'Unduhan untuk draft ini sedang berjalan.');
    const mode = body.mode === undefined ? 'new-only' : body.mode;
    if (!['new-only', 'all', 'failed-only'].includes(mode)) throw fail(400, 'INVALID_REQUEST', 'Mode unduhan tidak valid.');
    let pool = draft.chapters;
    if (body.chapterKeys !== undefined) {
      if (!Array.isArray(body.chapterKeys) || body.chapterKeys.length > 2000 || body.chapterKeys.some(k => typeof k !== 'string')) throw fail(400, 'INVALID_REQUEST', 'chapterKeys tidak valid.');
      const wanted = new Set(body.chapterKeys);
      pool = draft.chapters.filter(c => wanted.has(c.key));
      if (pool.length !== wanted.size) throw fail(400, 'INVALID_REQUEST', 'Ada chapter yang tidak dikenal.');
    }
    let selected;
    if (mode === 'failed-only') selected = pool.filter(c => c.status === 'FAILED' || c.status === 'CANCELLED');
    else if (mode === 'new-only') selected = pool.filter(c => c.flag === 'NEW' && !c.excluded && c.status !== 'COMPLETED' && (c.status === null || c.status === 'FAILED' || c.status === 'CANCELLED'));
    else {
      selected = pool.filter(c => c.status !== 'COMPLETED');
      const replacing = selected.filter(c => c.flag === 'EXISTS');
      if (replacing.length && body.confirmReplace !== true) {
        throw fail(409, 'CONFIRM_REPLACE_REQUIRED', `${replacing.length} chapter sudah ada di komik. Konfirmasi untuk mengunduh ulang dan menggantinya.`, {keys: replacing.map(c => c.key)});
      }
    }
    if (!selected.length) throw fail(409, 'NO_CHAPTERS_TO_DOWNLOAD', 'Tidak ada chapter yang perlu diunduh.');
    await diskGuard();

    const jobId = 'j_' + hex(8);
    const payload = {
      job_id: jobId, adapter: draft.adapter, source_url: draft.canonicalUrl, chapters: selected.map(c => ({key: c.key, ref: c.ref})),
      limits: {max_pages: limits.maxPages, max_chapter_bytes: limits.maxChapterBytes, max_image_bytes: limits.maxImageBytes}
    };
    await worker.startJob(payload);
    if (mode === 'all') { draft.confirmReplace = true; for (const c of selected) if (c.flag === 'EXISTS') c.excluded = false; }
    for (const c of selected) {
      await media.removeDraftChapter(draft.id, c.key).catch(() => {});
      Object.assign(c, {status: 'QUEUED', attempts: 0, errorCode: null, errorMessage: null, pages: [], bytes: 0});
    }
    draft.state = 'DOWNLOADING';
    draft.cancelRequested = false;
    draft.job = {jobId, startedAt: nowIso(), finishedAt: null};
    live.delete(draft.id);
    touch(draft);
    await saveDb(db);
    monitor(draft.id);
    return {draftId: draft.id, jobId, state: draft.state, chaptersQueued: selected.length, keys: selected.map(c => c.key)};
  }

  async function retryChapter(draftId, key) {
    notPublishing(draftId);
    const {draft} = await mustDraft(draftId);
    const chapter = draft.chapters.find(c => c.key === key);
    if (!chapter) throw fail(404, 'CHAPTER_NOT_FOUND', 'Chapter tidak ditemukan pada draft.');
    if (draft.state === 'DOWNLOADING') throw fail(409, 'JOB_ALREADY_RUNNING', 'Unduhan untuk draft ini sedang berjalan.');
    if (chapter.status !== 'FAILED' && chapter.status !== 'CANCELLED') throw fail(409, 'NO_CHAPTERS_TO_DOWNLOAD', 'Hanya chapter gagal/dibatalkan yang dapat diulang.');
    return startDownload(draftId, {mode: 'failed-only', chapterKeys: [key]});
  }

  // ---------- progress ----------
  async function progress(draftId) {
    const {draft} = await mustDraft(draftId);
    const info = live.get(draft.id);
    const chapters = draft.chapters.filter(c => c.status).map(c => {
      const l = info?.chapters.get(c.key);
      const done = c.status === 'COMPLETED' ? (c.pages.length || l?.pagesTotal || 0) : (l?.pagesDone || 0);
      return {key: c.key, number: c.number, title: c.title, status: c.status, pagesDone: done, pagesTotal: c.status === 'COMPLETED' ? done : (l?.pagesTotal || 0), attempts: Math.max(c.attempts || 0, l?.attempts || 0), phase: l?.phase || null, errorCode: c.errorCode || null, errorMessage: c.errorMessage || null};
    });
    const count = s => chapters.filter(c => c.status === s).length;
    return {
      draftId: draft.id, state: draft.state, cancelRequested: Boolean(draft.cancelRequested), worker: {reachable: info ? info.reachable : true},
      totals: {chapters: chapters.length, queued: count('QUEUED'), downloading: count('DOWNLOADING'), completed: count('COMPLETED'), failed: count('FAILED'), cancelled: count('CANCELLED'),
        pagesDone: chapters.reduce((a, c) => a + c.pagesDone, 0), pagesTotal: chapters.reduce((a, c) => a + c.pagesTotal, 0)},
      chapters, updatedAt: info?.updatedAt || draft.updatedAt
    };
  }

  // ---------- monitor ----------
  async function ingest(draft, chapter, jobId, info) {
    const key = chapter.key;
    const l = info.chapters.get(key) || {};
    l.phase = 'saving'; info.chapters.set(key, l);
    try {
      const manifest = await worker.manifest(jobId, key);
      const result = await media.ingestChapter({draftId: draft.id, key, manifest, limits, openPage: n => worker.openPage(jobId, key, n)});
      chapter.pages = result.pages; chapter.bytes = result.bytes; chapter.status = 'COMPLETED'; chapter.errorCode = null; chapter.errorMessage = null;
      l.pagesDone = l.pagesTotal = result.pages.length;
      worker.deleteChapter(jobId, key).catch(() => {}); // staging worker dibersihkan setelah tersimpan lokal
    } catch (error) {
      chapter.status = 'FAILED'; chapter.pages = [];
      chapter.errorCode = error instanceof WorkerError ? (error.code === 'CHAPTER_NOT_READY' ? 'WORKER_RESTARTED' : error.code) : (error.code || 'INGEST_ERROR');
      chapter.errorMessage = str(error.message, 300) || 'Penyimpanan chapter gagal.';
      if (!(error instanceof WorkerError) && !error.code) logger.error?.('[scan] ingest', error.message);
    } finally { l.phase = null; }
  }

  function monitor(draftId) {
    if (monitors.has(draftId)) return;
    monitors.add(draftId);
    runMonitor(draftId).catch(error => logger.error?.('[scan-monitor]', error.message)).finally(() => monitors.delete(draftId));
  }

  async function finish(db, draft, state) {
    draft.state = state;
    if (draft.job) draft.job.finishedAt = nowIso();
    touch(draft);
    await saveDb(db);
    if (draft.job) worker.deleteJob(draft.job.jobId).catch(() => {});
  }

  async function runMonitor(draftId) {
    const inflight = new Set();
    for (;;) {
      const db = await getDb();
      const draft = findDraft(db, draftId);
      if (!draft || draft.state !== 'DOWNLOADING' || !draft.job) return;
      const jobId = draft.job.jobId;
      const info = live.get(draftId) || {reachable: true, unreachableSince: null, chapters: new Map(), updatedAt: nowIso()};
      live.set(draftId, info);
      let remote = null, transitions = false, restarted = false;
      try {
        remote = await worker.progress(jobId);
        info.reachable = true; info.unreachableSince = null; info.updatedAt = nowIso();
      } catch (error) {
        if (error instanceof WorkerError && error.code === 'JOB_NOT_FOUND') restarted = true;
        else { info.reachable = false; info.unreachableSince ||= Date.now(); }
      }
      if (restarted) {
        await Promise.allSettled([...inflight]);
        for (const c of draft.chapters) if (c.status === 'QUEUED' || c.status === 'DOWNLOADING') {
          c.status = 'FAILED'; c.errorCode = 'WORKER_RESTARTED'; c.errorMessage = 'Worker dimulai ulang saat unduhan berjalan. Coba lagi.';
        }
        await finish(db, draft, 'READY');
        return;
      }
      if (remote) {
        for (const r of remote.chapters || []) {
          const c = draft.chapters.find(x => x.key === r.key);
          if (!c) continue;
          const l = info.chapters.get(r.key) || {};
          l.pagesTotal = Math.max(l.pagesTotal || 0, r.pages_total || 0); l.pagesDone = Math.max(l.pagesDone || 0, r.pages_done || 0); l.attempts = r.attempts || 0;
          info.chapters.set(r.key, l);
          if (c.status === 'QUEUED' && r.status === 'DOWNLOADING') { c.status = 'DOWNLOADING'; transitions = true; }
          if ((c.status === 'QUEUED' || c.status === 'DOWNLOADING') && r.status === 'FAILED') {
            Object.assign(c, {status: 'FAILED', attempts: r.attempts || 0, errorCode: str(r.error_code, 40) || 'DOWNLOAD_FAILED', errorMessage: str(r.error_message, 300) || 'Unduhan chapter gagal.'}); transitions = true;
          }
          if ((c.status === 'QUEUED' || c.status === 'DOWNLOADING') && r.status === 'CANCELLED') { c.status = 'CANCELLED'; c.attempts = r.attempts || 0; transitions = true; }
          if ((c.status === 'QUEUED' || c.status === 'DOWNLOADING') && r.status === 'COMPLETED' && !inflight.has(c.key) && inflight.size < config.ingestConcurrency) {
            c.status = 'DOWNLOADING';
            const p = ingest(draft, c, jobId, info).then(async () => {
              c.attempts = Math.max(c.attempts || 0, r.attempts || 0); touch(draft);
              if (!findDraft(db, draftId)) { await media.removeDraftDir(draftId).catch(() => {}); return; } // draft dibuang saat ingest berjalan
              await saveDb(db);
            }).finally(() => inflight.delete(c.key));
            p.catch(() => {});
            inflight.add(c.key);
          }
        }
      } else if (info.unreachableSince && Date.now() - info.unreachableSince >= config.workerUnreachableMs && !inflight.size) {
        for (const c of draft.chapters) if (c.status === 'QUEUED' || c.status === 'DOWNLOADING') {
          c.status = 'FAILED'; c.errorCode = 'WORKER_UNAVAILABLE'; c.errorMessage = 'Layanan scan tidak dapat dihubungi. Coba lagi setelah layanan aktif.';
        }
        await finish(db, draft, 'READY');
        return;
      }
      if (transitions) { touch(draft); await saveDb(db); }
      const pending = draft.chapters.some(c => c.status === 'QUEUED' || c.status === 'DOWNLOADING');
      if (!pending && !inflight.size) {
        await finish(db, draft, draft.cancelRequested ? 'CANCELLED' : 'READY');
        return;
      }
      await sleep(config.pollMs);
    }
  }

  async function cancel(draftId) {
    const {db, draft} = await mustDraft(draftId);
    if (draft.state !== 'DOWNLOADING' || !draft.job) throw fail(409, 'NO_ACTIVE_JOB', 'Tidak ada unduhan yang sedang berjalan.');
    draft.cancelRequested = true;
    touch(draft);
    await saveDb(db);
    try { await worker.cancel(draft.job.jobId); } catch (error) { logger.warn?.('[scan] cancel worker gagal:', error.code); }
    monitor(draft.id);
    return {draftId: draft.id, state: draft.state, cancelRequested: true};
  }

  // ---------- edit draft ----------
  async function patch(draftId, body) {
    notPublishing(draftId);
    const {db, draft} = await mustDraft(draftId);
    if (draft.state === 'PUBLISHED') throw fail(409, 'ALREADY_PUBLISHED', 'Draft ini sudah dipublikasikan.');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_REQUEST', 'Permintaan tidak valid.');
    const next = {...draft.comic};
    let coverBytes = null;
    const input = body.comic && typeof body.comic === 'object' ? body.comic : {};
    if ('title' in input) { const t = str(input.title, 141); if (!t) throw fail(400, 'INVALID_REQUEST', 'Judul wajib diisi.'); if (t.length > 140) throw fail(400, 'INVALID_REQUEST', 'Judul maksimal 140 karakter.'); next.title = t; }
    if ('alt' in input) next.alt = str(input.alt, 140);
    if ('synopsis' in input) { const s = String(input.synopsis ?? '').trim(); if (s.length > 2000) throw fail(400, 'INVALID_REQUEST', 'Sinopsis maksimal 2000 karakter.'); next.synopsis = s; }
    if ('author' in input) next.author = str(input.author, 140);
    if ('status' in input) { if (input.status !== null && !STATUSES.includes(input.status)) throw fail(400, 'INVALID_REQUEST', 'Status tidak valid.'); next.status = input.status; }
    if ('type' in input) { if (input.type !== null && !TYPES.includes(input.type)) throw fail(400, 'INVALID_REQUEST', 'Tipe tidak valid.'); next.type = input.type; }
    if ('genres' in input) { if (!Array.isArray(input.genres) || input.genres.length > 12) throw fail(400, 'INVALID_REQUEST', 'Genre tidak valid.'); next.genres = input.genres.map(g => str(g, 40)).filter(Boolean); }
    if ('year' in input) { const y = input.year === null || input.year === '' ? null : Number(input.year); if (y !== null && (!Number.isInteger(y) || y < 1900 || y > 2100)) throw fail(400, 'INVALID_REQUEST', 'Tahun tidak valid.'); next.year = y; }
    if (input.coverData) {
      try { coverBytes = media.decodeCoverDataUrl(input.coverData); } catch (error) { throw fail(error.code === 'COVER_TOO_LARGE' ? 413 : 400, error.code || 'INVALID_REQUEST', error.message); }
    }
    const edits = Array.isArray(body.chapters) ? body.chapters : [];
    if (body.chapters !== undefined && !Array.isArray(body.chapters)) throw fail(400, 'INVALID_REQUEST', 'chapters harus berupa array.');
    if (edits.length > 5000) throw fail(400, 'INVALID_REQUEST', 'Terlalu banyak perubahan.');
    const planned = [];
    for (const e of edits) {
      if (!e || typeof e !== 'object' || typeof e.key !== 'string') throw fail(400, 'INVALID_REQUEST', 'Perubahan chapter tidak valid.');
      const c = draft.chapters.find(x => x.key === e.key);
      if (!c) throw fail(404, 'CHAPTER_NOT_FOUND', `Chapter ${e.key} tidak ditemukan.`);
      if (draft.state === 'DOWNLOADING' && (c.status === 'QUEUED' || c.status === 'DOWNLOADING') && (e.delete || 'number' in e)) throw fail(409, 'CHAPTER_BUSY', 'Chapter sedang diunduh.');
      const plan = {c};
      if ('number' in e) {
        if (e.number === null || String(e.number).trim() === '') plan.number = null;
        else { const n = canonicalize(String(e.number)); if (n === null) throw fail(400, 'INVALID_CHAPTER_NUMBER', 'Nomor chapter harus angka desimal non-negatif (mis. 12 atau 12.5).'); plan.number = n; }
      }
      if ('title' in e) plan.title = str(e.title, 140);
      if ('excluded' in e) plan.excluded = Boolean(e.excluded);
      if (e.delete === true) plan.delete = true;
      planned.push(plan);
    }
    if (coverBytes) next.cover = await media.saveDraftCover(draft.id, coverBytes);
    draft.comic = next;
    for (const p of planned) {
      if ('number' in p) { p.c.number = p.number; p.c.issues = (p.c.issues || []).filter(i => !['ambiguous_number', 'number_collision', 'needs_number', 'duplicate_number'].includes(i)); }
      if ('title' in p) p.c.title = p.title;
      if ('excluded' in p) p.c.excluded = p.excluded;
      if (p.delete) { draft.chapters = draft.chapters.filter(x => x !== p.c); await media.removeDraftChapter(draft.id, p.c.key).catch(() => {}); }
    }
    touch(draft);
    await saveDb(db);
    return draftView(draft);
  }

  // ---------- discard ----------
  async function discard(draftId) {
    notPublishing(draftId);
    const {db, draft} = await mustDraft(draftId);
    if (draft.state === 'DOWNLOADING' && draft.job) {
      draft.state = 'CANCELLED'; // hentikan monitor
      await worker.cancel(draft.job.jobId).catch(() => {});
      worker.deleteJob(draft.job.jobId).catch(() => {});
    }
    db.scanDrafts = db.scanDrafts.filter(d => d !== draft);
    live.delete(draft.id);
    await saveDb(db);
    if (draft.state !== 'PUBLISHED') await media.removeDraftDir(draft.id).catch(() => {});
    return {ok: true};
  }

  // ---------- publish ----------
  function isoDate(raw) {
    const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toLocaleDateString('id-ID');
  }

  // D-02: publish diserialkan per draft. Panggilan yang kalah menunggu giliran, lalu melihat state PUBLISHED dan
  // mendapat 409 ALREADY_PUBLISHED (bukan 500 / draft menggantung). Selama publish berjalan, mutasi lain ditolak.
  const publishLocks = new Map();   // draftId -> Promise (ekor antrean)
  const publishing = new Map();     // draftId -> jumlah panggilan publish aktif/antre (ditandai sinkron saat dipanggil)
  const notPublishing = draftId => { if (publishing.get(draftId)) throw fail(409, 'PUBLISH_IN_PROGRESS', 'Publikasi sedang berjalan untuk draft ini.'); };
  async function publish(draftId, body = {}) {
    publishing.set(draftId, (publishing.get(draftId) || 0) + 1);
    const prev = publishLocks.get(draftId) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = prev.then(() => gate);
    publishLocks.set(draftId, tail);
    try {
      await prev;
      return await publishLocked(draftId, body);
    } finally {
      const left = (publishing.get(draftId) || 1) - 1;
      if (left) publishing.set(draftId, left); else publishing.delete(draftId);
      release();
      if (publishLocks.get(draftId) === tail) publishLocks.delete(draftId);
    }
  }

  async function publishLocked(draftId, body = {}) {
    const {db, draft} = await mustDraft(draftId);
    if (draft.state === 'PUBLISHED') throw fail(409, 'ALREADY_PUBLISHED', 'Draft ini sudah dipublikasikan.');
    if (draft.state === 'DOWNLOADING') throw fail(409, 'JOB_ALREADY_RUNNING', 'Tunggu unduhan selesai atau batalkan terlebih dahulu.');
    const onExisting = body.onExistingComic === undefined ? 'append' : body.onExistingComic;
    if (!['append', 'cancel'].includes(onExisting)) throw fail(400, 'INVALID_REQUEST', 'Pilihan onExistingComic tidak valid.');
    const title = str(draft.comic.title, 141);
    if (!title) throw fail(400, 'INVALID_REQUEST', 'Judul wajib diisi.');
    const included = draft.chapters.filter(c => !c.excluded);
    if (!included.length) throw fail(409, 'NO_CHAPTERS', 'Pilih setidaknya satu chapter yang akan dipublikasikan.');
    const notReady = included.filter(c => c.status !== 'COMPLETED' || !c.pages?.length);
    if (notReady.length) throw fail(409, 'CHAPTER_NOT_READY', `${notReady.length} chapter belum selesai diunduh.`, {keys: notReady.map(c => c.key)});
    const noNumber = included.filter(c => c.number === null);
    if (noNumber.length) throw fail(409, 'CHAPTER_NUMBER_REQUIRED', 'Isi nomor untuk chapter yang akan dipublikasikan.', {keys: noNumber.map(c => c.key)});
    const byNumber = new Map();
    for (const c of included) byNumber.set(c.number, [...(byNumber.get(c.number) || []), c.key]);
    const dups = [...byNumber.values()].filter(k => k.length > 1).flat();
    if (dups.length) throw fail(409, 'DUPLICATE_CHAPTER_NUMBER', 'Ada nomor chapter ganda. Ubah nomor atau keluarkan salah satunya.', {keys: dups});
    // setiap berkas halaman harus benar-benar ada
    for (const c of included) for (const page of c.pages) {
      try { await fs.access(path.join(MEDIA_ROOT, media.DRAFTS_DIR, draft.id, c.key, path.basename(page.image_url))); }
      catch { throw fail(409, 'CHAPTER_NOT_READY', `Berkas chapter ${c.number} hilang di disk; unduh ulang.`, {keys: [c.key]}); }
    }
    let existing = draft.existingComicId ? db.comics.find(x => x.id === draft.existingComicId) : null;
    if (!existing) existing = db.comics.find(x => x.scanSource?.canonicalUrl === draft.canonicalUrl) || null;
    if (existing && onExisting === 'cancel') throw fail(409, 'PUBLISH_CANCELLED', 'Publikasi dibatalkan: komik sudah ada.');
    const existingNumbers = new Set((existing?.chapters || []).map(c => canonicalize(c.number)).filter(Boolean));
    const collisions = included.filter(c => existingNumbers.has(c.number));
    if (collisions.length && !draft.confirmReplace) throw fail(409, 'DUPLICATE_CHAPTER_NUMBER', 'Nomor chapter sudah ada di komik. Gunakan unduh ulang dengan konfirmasi untuk menggantinya.', {keys: collisions.map(c => c.key)});

    const snapshot = existing ? {chapters: existing.chapters, storageKey: existing.storageKey, scanSource: existing.scanSource} : null;
    const draftSnapshot = {state: draft.state, publishedComicId: draft.publishedComicId, chapters: draft.chapters, updatedAt: draft.updatedAt};
    let pushed = null;
    const tx = media.createFileTransaction();
    try {
      let comic = existing;
      const created = !comic;
      if (created) {
        let id; do { id = `${slug(title)}-${hex(3)}`; } while (db.comics.some(x => x.id === id));
        comic = {id, title, alt: draft.comic.alt || '', type: draft.comic.type || 'Manhwa', status: draft.comic.status || 'Berjalan', genres: draft.comic.genres || [], rating: null, year: draft.comic.year, author: draft.comic.author || '', synopsis: draft.comic.synopsis || '', cover: '', source: `Scan Import · ${draft.adapterLabel || draft.adapter}`, storageKey: undefined, scanSource: {adapter: draft.adapter, canonicalUrl: draft.canonicalUrl, importedAt: nowIso()}, chapters: []};
        comic.storageKey = comic.id;
        if (!/^[a-z0-9-]{1,120}$/.test(comic.storageKey)) comic.storageKey = comicStorageKey(comic);
      } else if (!comic.storageKey) comic.storageKey = comicStorageKey(comic);
      const storageKey = comic.storageKey;
      // cover (hanya komik baru; komik yang sudah ada tidak ditimpa metadatanya)
      if (created && draft.comic.cover) {
        const from = path.join(MEDIA_ROOT, media.DRAFTS_DIR, draft.id, path.basename(draft.comic.cover));
        const name = `cover-${crypto.randomUUID()}${path.extname(from)}`;
        await tx.move(from, path.join(MEDIA_ROOT, storageKey, name));
        comic.cover = `/media/${storageKey}/${name}`;
      }
      const newChapters = [];
      for (const c of included) {
        const folder = `chapter-${c.number.replace('.', '-')}`;
        const target = path.join(MEDIA_ROOT, storageKey, 'chapters', folder);
        await tx.stash(target);
        await tx.move(path.join(MEDIA_ROOT, media.DRAFTS_DIR, draft.id, c.key), target);
        newChapters.push({
          id: crypto.randomUUID(), number: c.number, title: c.title || '', date: isoDate(c.date), status: 'COMPLETED', errorMessage: null,
          pages: c.pages.map(p => ({page_number: p.page_number, image_url: `/media/${storageKey}/chapters/${folder}/${path.basename(p.image_url)}`})), source: 'Scan Import'
        });
      }
      let merged = [...(comic.chapters || [])];
      for (const nc of newChapters) {
        const idx = merged.findIndex(x => canonicalize(x.number) === nc.number);
        if (idx >= 0) { nc.id = merged[idx].id; merged[idx] = nc; } else merged.push(nc);
      }
      merged = sortDesc(merged, x => canonicalize(x.number));
      comic.chapters = merged;
      if (created) { db.comics.push(comic); pushed = comic; } else { comic.scanSource = {...(comic.scanSource || {}), lastImportedAt: nowIso()}; }
      draft.state = 'PUBLISHED'; draft.publishedComicId = comic.id; touch(draft);
      draft.chapters = draft.chapters.map(c => ({...c, pages: [], ref: undefined}));
      await saveDb(db);
      await tx.commit();
      await media.removeDraftDir(draft.id).catch(() => {});
      return {comicId: comic.id, created, appendedToExisting: !created, chaptersPublished: newChapters.length, pagesPublished: newChapters.reduce((a, c) => a + c.pages.length, 0)};
    } catch (error) {
      await tx.rollback();
      if (pushed) db.comics = db.comics.filter(c => c !== pushed);
      if (snapshot) Object.assign(existing, snapshot);
      Object.assign(draft, draftSnapshot);
      if (error instanceof WorkerError) throw error;
      logger.error?.('[scan] publish gagal:', error.message);
      throw fail(500, 'PUBLISH_FAILED', 'Publikasi gagal dan semua perubahan dibatalkan.');
    }
  }

  // ---------- pemulihan & housekeeping ----------
  async function recover() {
    const db = await getDb();
    db.scanDrafts ||= [];
    for (const d of db.scanDrafts) if (d.state === 'DOWNLOADING') monitor(d.id);
  }
  async function sweepExpired() {
    const db = await getDb();
    const cutoff = Date.now() - config.draftExpiryDays * 86_400_000;
    const stale = (db.scanDrafts || []).filter(d => d.state !== 'DOWNLOADING' && Date.parse(d.updatedAt) < cutoff);
    for (const d of stale) { db.scanDrafts = db.scanDrafts.filter(x => x !== d); if (d.state !== 'PUBLISHED') await media.removeDraftDir(d.id).catch(() => {}); }
    if (stale.length) await saveDb(db);
    return stale.length;
  }
  async function health() { try { return {...(await worker.health()), reachable: true}; } catch (error) { return {reachable: false, code: error.code}; } }

  return {scan, list, get, coverFile, startDownload, retryChapter, progress, cancel, patch, discard, publish, recover, sweepExpired, health, _live: live, _monitors: monitors, draftView};
}

module.exports = {createScanService, TYPES, STATUSES};
