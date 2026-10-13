'use strict';
// Auto-Sync (Fase 1): registri "langganan" sumber seri + sinkronisasi.
//
// Menyimpan langganan di `db.subscriptions` dan memakai ulang scan-service yang
// sudah ada: scan -> unduh HANYA chapter baru -> publish (append ke komik yang ada).
// Idempoten: sinkronisasi kedua tidak menemukan chapter baru -> no-op.
//
// Scheduler hanya aktif bila AUTO_SYNC_ENABLED=true; endpoint "sync sekarang"
// tetap bisa dipakai tanpa scheduler.
const crypto = require('node:crypto');
const {WorkerError} = require('./scan-worker');

const nowIso = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
const MAX_SUBSCRIPTIONS = 1000;

// Normalisasi URL seri: buang hash & trailing slash agar dedup stabil.
function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

function createSubscriptions({getDb, saveDb, service, config, logger = console}) {
  const running = new Set();   // id yang sedang diproses
  const queue = [];            // {id, sub, why}
  let timer = null;
  let stopped = false;

  const minInterval = Math.max(1, config.minInterval || 5);
  const maxInterval = Math.max(minInterval, config.maxInterval || 10080);

  function view(sub) {
    const inFlight = running.has(sub.id) || queue.some(q => q.id === sub.id);
    return {
      id: sub.id, title: sub.title || null, seriesUrl: sub.seriesUrl, canonicalUrl: sub.canonicalUrl || null,
      adapter: sub.adapter || 'auto', intervalMinutes: sub.intervalMinutes, enabled: Boolean(sub.enabled), autoPublish: Boolean(sub.autoPublish),
      nextCheckAt: sub.nextCheckAt || null, lastCheckedAt: sub.lastCheckedAt || null, lastSyncedAt: sub.lastSyncedAt || null,
      lastStatus: inFlight ? 'running' : (sub.lastStatus || 'pending'), lastError: sub.lastError || null,
      consecutiveFailures: sub.consecutiveFailures || 0, lastNewChapters: sub.lastNewChapters || 0, running: inFlight
    };
  }

  function nextCheckIso(sub, from = Date.now()) {
    const minutes = Math.min(maxInterval, Math.max(minInterval, Number(sub.intervalMinutes) || config.defaultInterval));
    const jitterMs = Math.floor(Math.random() * Math.max(0, config.jitterS || 0)) * 1000;
    return new Date(from + minutes * 60_000 + jitterMs).toISOString();
  }

  async function freshDraft(url) {
    try {
      return await service.scan(url);
    } catch (error) {
      // Draft aktif untuk URL yang sama -> buang lalu pindai ulang (sinkronisasi bersifat idempoten).
      if (error?.code === 'DRAFT_EXISTS' && error.extra?.draftId) {
        await service.discard(error.extra.draftId).catch(() => {});
        return service.scan(url);
      }
      throw error;
    }
  }

  async function waitForDraft(draftId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await service.progress(draftId);
      if (p.state !== 'DOWNLOADING') return p.state;
      if (Date.now() > deadline) return 'TIMEOUT';
      await sleep(Math.max(500, config.pollMs || 1000));
    }
  }

  // Inti sinkronisasi satu seri. Melempar error agar pemanggil (manual) bisa melaporkan.
  async function doSync(sub, why) {
    const db = await getDb();
    try {
      const draft = await freshDraft(sub.seriesUrl);
      sub.canonicalUrl = draft.canonicalUrl || sub.canonicalUrl || null;
      if (!sub.title && draft.comic?.title) sub.title = str(draft.comic.title, 140);
      sub.lastCheckedAt = nowIso();

      const allNew = (draft.chapters || []).filter(c => c.flag === 'NEW' && !c.excluded);
      if (!allNew.length) {
        await service.discard(draft.draftId).catch(() => {});
        Object.assign(sub, {lastStatus: 'ok', lastError: null, consecutiveFailures: 0, lastNewChapters: 0});
        await saveDb(db);
        logger.log?.(`[autosync] ${sub.id} (${why}): tidak ada chapter baru`);
        return {id: sub.id, status: 'noop', newChapters: 0};
      }

      // Hanya chapter yang punya nomor valid dapat dipublikasikan; sisanya ditunda
      // (ditandai excluded agar publish tidak menunggu). Sisa akan diambil pada sinkronisasi berikutnya.
      const max = Math.max(1, config.maxNewPerRun || 5);
      const publishable = allNew.filter(c => c.number !== null && c.number !== undefined);
      const chosen = publishable.slice(0, max).map(c => c.key);
      const deferKeys = allNew.filter(c => !chosen.includes(c.key)).map(c => c.key);
      if (deferKeys.length) await service.patch(draft.draftId, {chapters: deferKeys.map(key => ({key, excluded: true}))});

      if (!chosen.length) {
        // Ada chapter baru tetapi belum ada nomor valid -> biarkan sebagai draft untuk review.
        Object.assign(sub, {lastStatus: 'draft', lastError: null, consecutiveFailures: 0, lastNewChapters: allNew.length, lastSyncedAt: nowIso()});
        await saveDb(db);
        return {id: sub.id, status: 'draft', draftId: draft.draftId, newChapters: allNew.length, note: 'chapter tanpa nomor valid'};
      }

      await service.startDownload(draft.draftId, {mode: 'new-only', chapterKeys: chosen});
      const state = await waitForDraft(draft.draftId, config.syncTimeoutMs || 1_800_000);

      if (state !== 'READY') {
        Object.assign(sub, {lastStatus: 'error', lastError: `Unduhan berakhir: ${state}`, consecutiveFailures: (sub.consecutiveFailures || 0) + 1});
        if (sub.consecutiveFailures >= (config.maxFailures || 5)) sub.enabled = false;
        await saveDb(db);
        return {id: sub.id, status: 'error', state, newChapters: allNew.length};
      }

      if (!sub.autoPublish) {
        Object.assign(sub, {lastStatus: 'draft', lastError: null, consecutiveFailures: 0, lastNewChapters: chosen.length, lastSyncedAt: nowIso()});
        await saveDb(db);
        logger.log?.(`[autosync] ${sub.id} (${why}): ${allNew.length} chapter baru menunggu review (draft ${draft.draftId})`);
        return {id: sub.id, status: 'draft', draftId: draft.draftId, newChapters: allNew.length};
      }

      const result = await service.publish(draft.draftId, {onExistingComic: 'append'});
      Object.assign(sub, {lastStatus: 'ok', lastError: null, consecutiveFailures: 0, lastSyncedAt: nowIso(), lastNewChapters: result.chaptersPublished});
      await saveDb(db);
      logger.log?.(`[autosync] ${sub.id} (${why}): publikasi ${result.chaptersPublished} chapter`);
      return {id: sub.id, status: 'published', ...result, remaining: Math.max(0, allNew.length - chosen.length)};
    } catch (error) {
      Object.assign(sub, {lastStatus: 'error', lastError: str(error?.message || error, 300), consecutiveFailures: (sub.consecutiveFailures || 0) + 1});
      if (sub.consecutiveFailures >= (config.maxFailures || 5)) sub.enabled = false;
      await saveDb(db).catch(() => {});
      throw error;
    }
  }

  function drain() {
    while (running.size < Math.max(1, config.concurrency || 1) && queue.length) {
      const job = queue.shift();
      if (running.has(job.id)) continue;
      running.add(job.id);
      doSync(job.sub, job.why)
        .catch(error => logger.warn?.(`[autosync] ${job.sub.id} gagal:`, error?.message || error))
        .finally(() => { running.delete(job.id); drain(); });
    }
  }

  function enqueue(sub, why) {
    if (running.has(sub.id) || queue.some(q => q.id === sub.id)) return false;
    queue.push({id: sub.id, sub, why});
    drain();
    return true;
  }

  async function list() {
    const db = await getDb();
    db.subscriptions ||= [];
    return {schedulerEnabled: Boolean(config.enabled), concurrency: config.concurrency || 1, subscriptions: db.subscriptions.map(view)};
  }

  async function get(id) {
    const db = await getDb();
    const sub = (db.subscriptions || []).find(s => s.id === id);
    if (!sub) throw new WorkerError(404, 'SUBSCRIPTION_NOT_FOUND', 'Langganan tidak ditemukan.');
    return view(sub);
  }

  function collectUrls(body) {
    const out = [];
    const push = value => { for (const part of String(value || '').split(/[\s,]+/)) if (part.trim()) out.push(part.trim()); };
    if (body && typeof body === 'object') {
      if (Array.isArray(body.urls)) body.urls.forEach(push);
      if (body.url) push(body.url);
      if (body.text) push(body.text);
    }
    return out;
  }

  async function add(body = {}) {
    const db = await getDb();
    db.subscriptions ||= [];
    const rawUrls = collectUrls(body);
    if (!rawUrls.length) throw new WorkerError(400, 'INVALID_REQUEST', 'Masukkan setidaknya satu URL sumber.');
    if (rawUrls.length > 200) throw new WorkerError(400, 'INVALID_REQUEST', 'Maksimal 200 URL per permintaan.');
    const intervalMinutes = Math.min(maxInterval, Math.max(minInterval, Number(body.intervalMinutes) || config.defaultInterval));
    const autoPublish = body.autoPublish === undefined ? true : Boolean(body.autoPublish);
    const existing = new Set(db.subscriptions.map(s => s.seriesUrl));
    const added = [], skipped = [];
    for (const raw of rawUrls) {
      const url = normalizeUrl(raw);
      if (!url) { skipped.push({url: str(raw, 300), reason: 'URL tidak valid'}); continue; }
      if (existing.has(url)) { skipped.push({url, reason: 'sudah terdaftar'}); continue; }
      if (db.subscriptions.length >= MAX_SUBSCRIPTIONS) { skipped.push({url, reason: 'batas langganan tercapai'}); break; }
      const sub = {
        id: 'sub_' + crypto.randomBytes(6).toString('hex'), seriesUrl: url, canonicalUrl: null, adapter: 'auto',
        title: null, intervalMinutes, enabled: true, autoPublish, nextCheckAt: nowIso(),
        createdAt: nowIso(), lastCheckedAt: null, lastSyncedAt: null, lastStatus: 'pending', lastError: null,
        consecutiveFailures: 0, lastNewChapters: 0
      };
      db.subscriptions.push(sub);
      existing.add(url);
      added.push(view(sub));
    }
    await saveDb(db);
    return {added: added.length, skipped, subscriptions: added};
  }

  async function patch(id, body = {}) {
    const db = await getDb();
    const sub = (db.subscriptions || []).find(s => s.id === id);
    if (!sub) throw new WorkerError(404, 'SUBSCRIPTION_NOT_FOUND', 'Langganan tidak ditemukan.');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new WorkerError(400, 'INVALID_REQUEST', 'Permintaan tidak valid.');
    if ('enabled' in body) sub.enabled = Boolean(body.enabled);
    if ('autoPublish' in body) sub.autoPublish = Boolean(body.autoPublish);
    if ('intervalMinutes' in body) {
      const n = Number(body.intervalMinutes);
      if (!Number.isFinite(n)) throw new WorkerError(400, 'INVALID_REQUEST', 'intervalMinutes tidak valid.');
      sub.intervalMinutes = Math.min(maxInterval, Math.max(minInterval, Math.floor(n)));
    }
    if (sub.enabled && !sub.nextCheckAt) sub.nextCheckAt = nowIso();
    await saveDb(db);
    return view(sub);
  }

  async function remove(id) {
    const db = await getDb();
    const before = (db.subscriptions || []).length;
    db.subscriptions = (db.subscriptions || []).filter(s => s.id !== id);
    if (db.subscriptions.length === before) throw new WorkerError(404, 'SUBSCRIPTION_NOT_FOUND', 'Langganan tidak ditemukan.');
    await saveDb(db);
    return {ok: true};
  }

  // Sinkronisasi manual (async di latar belakang; UI memantau via list()).
  async function syncNow(id) {
    const db = await getDb();
    const sub = (db.subscriptions || []).find(s => s.id === id);
    if (!sub) throw new WorkerError(404, 'SUBSCRIPTION_NOT_FOUND', 'Langganan tidak ditemukan.');
    if (running.has(id) || queue.some(q => q.id === id)) throw new WorkerError(409, 'SYNC_IN_PROGRESS', 'Sinkronisasi untuk seri ini sedang berjalan.');
    sub.lastStatus = 'running'; sub.lastError = null;
    await saveDb(db);
    enqueue(sub, 'manual');
    return {ok: true, id, queued: true};
  }

  // Pratinjau (dry-run): daftar chapter baru tanpa mengunduh.
  async function preview(id) {
    const db = await getDb();
    const sub = (db.subscriptions || []).find(s => s.id === id);
    if (!sub) throw new WorkerError(404, 'SUBSCRIPTION_NOT_FOUND', 'Langganan tidak ditemukan.');
    const draft = await freshDraft(sub.seriesUrl);
    const newChapters = (draft.chapters || []).filter(c => c.flag === 'NEW' && !c.excluded)
      .map(c => ({number: c.number, numberRaw: c.numberRaw, title: c.title, date: c.date}));
    await service.discard(draft.draftId).catch(() => {});
    return {
      id, title: draft.comic?.title || sub.title || null, canonicalUrl: draft.canonicalUrl, existing: Boolean(draft.existingComicId),
      newChapters: newChapters.slice(0, 50), newCount: newChapters.length
    };
  }

  async function tick() {
    if (stopped) return;
    const db = await getDb();
    db.subscriptions ||= [];
    const now = Date.now();
    let changed = false;
    for (const sub of db.subscriptions) {
      if (!sub.enabled) continue;
      if (sub.nextCheckAt && Date.parse(sub.nextCheckAt) > now) continue;
      sub.nextCheckAt = nextCheckIso(sub, now);
      changed = true;
      enqueue(sub, 'schedule');
    }
    if (changed) await saveDb(db);
  }

  function start() {
    if (!config.enabled || timer) return stop;
    timer = setInterval(() => { tick().catch(error => logger.warn?.('[autosync-tick]', error?.message || error)); }, Math.max(5, config.tickS || 60) * 1000);
    timer.unref?.();
    // Jalankan sekali di awal agar langganan yang sudah jatuh tempo langsung diproses.
    const kick = setTimeout(() => { tick().catch(() => {}); }, 5_000);
    kick.unref?.();
    logger.log?.('[autosync] scheduler aktif');
    return stop;
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {list, get, add, patch, remove, syncNow, preview, tick, start, stop, _running: running, _queue: queue, _view: view};
}

module.exports = {createSubscriptions, normalizeUrl};
