'use strict';
const env = require('./env');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createDbWriter} = require('../../lib/db-writer');
const {createWorkerClient} = require('../../lib/scan-worker');
const {createScanService} = require('../../lib/scan-service');
const {scanLimits} = require('../../lib/scan-media');
const {startFakeWorker, scanResult} = require('./fake-worker');

const quiet = {error() {}, warn() {}, log() {}};
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, {timeout = 8000, step = 15, label = 'kondisi'} = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timeout menunggu ${label}`);
    await wait(step);
  }
}

async function makeHarness({worker, config = {}, db, statfs, saveHook} = {}) {
  worker ||= await startFakeWorker();
  const dbFile = path.join(env.dataDir, `db-${Math.random().toString(16).slice(2)}.json`);
  const writer = createDbWriter(dbFile);
  const state = {db: db || {comics: [], announcements: [], ads: [], scanDrafts: []}, dead: false, failSave: 0};
  const saveDb = async next => {
    if (state.failSave > 0) { state.failSave--; throw new Error('simulasi gagal tulis'); }
    if (saveHook) await saveHook(next);
    return writer.save(next);
  };
  const cfg = {
    devMode: true, workerToken: worker.token, limits: scanLimits({}), minFreeBytes: 0, pollMs: 20, workerUnreachableMs: 400, ingestConcurrency: 2, draftExpiryDays: 7,
    ...config
  };
  const client = createWorkerClient({baseUrl: worker.url, token: worker.token, scanTimeoutMs: 3000, fastTimeoutMs: 1500, pageTimeoutMs: 5000});
  const service = createScanService({getDb: async () => { if (state.dead) throw new Error('FE mati (simulasi)'); return state.db; }, saveDb, worker: client, config: cfg, logger: quiet, statfs});
  return {worker, client, service, state, config: cfg, dbFile, writer, saveDb};
}

async function scanAndDownload(h, url, {mode, numbers, extra, title} = {}) {
  h.worker.setScan(url, scanResult({url, numbers, extra, title}));
  const draft = await h.service.scan(url);
  await h.service.startDownload(draft.draftId, {mode: mode || 'new-only'});
  return draft;
}
const waitState = (h, id, states, timeout = 10000) => until(async () => { const v = await h.service.get(id); return states.includes(v.state) ? v : null; }, {timeout, label: `draft ${id} -> ${states}`});

module.exports = {...env, makeHarness, scanAndDownload, waitState, until, wait, scanResult, startFakeWorker, quiet};
