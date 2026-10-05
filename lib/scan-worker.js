'use strict';
// Klien ke worker Python (hanya rute tertentu; tidak ada forwarding path bebas dari browser — NFR-03).
class WorkerError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

const enc = encodeURIComponent;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STAGED = /^s_[0-9a-f]{16}$/;

function createWorkerClient({baseUrl, token, fetchImpl = fetch, scanTimeoutMs = 95_000, fastTimeoutMs = 10_000, pageTimeoutMs = 120_000}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  function checkId(id, pattern = ID) { if (!pattern.test(String(id))) throw new WorkerError(400, 'INVALID_REQUEST', 'ID tidak valid.'); return String(id); }

  async function raw(method, path, {body, timeoutMs = fastTimeoutMs} = {}) {
    const headers = {accept: 'application/json'};
    if (token) headers['x-worker-token'] = token; // Cookie browser TIDAK diteruskan
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(base + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new WorkerError(504, 'WORKER_TIMEOUT', 'Layanan scan tidak merespons dalam batas waktu.');
      throw new WorkerError(502, 'WORKER_UNAVAILABLE', 'Layanan scan tidak tersedia.');
    }
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch {}
      const code = typeof data.code === 'string' ? data.code.slice(0, 40) : 'WORKER_ERROR';
      const message = typeof data.error === 'string' ? data.error.slice(0, 300) : 'Layanan scan mengembalikan galat.';
      if (response.status === 401) throw new WorkerError(502, 'WORKER_UNAVAILABLE', 'Layanan scan menolak token (periksa SCAN_WORKER_TOKEN).');
      const extra = {};
      if (Array.isArray(data.adapters)) extra.adapters = data.adapters.filter(x => typeof x === 'string').slice(0, 20);
      throw new WorkerError(response.status >= 500 && response.status !== 504 && response.status !== 507 ? 502 : response.status, code, message, extra);
    }
    return response;
  }
  const json = async (method, path, opts) => { const r = await raw(method, path, opts); try { return await r.json(); } catch { throw new WorkerError(502, 'WORKER_ERROR', 'Respons layanan scan tidak valid.'); } };

  return {
    health: () => json('GET', '/health'),
    status: () => json('GET', '/worker/v1/status'),
    scan: url => json('POST', '/worker/v1/scan', {body: {url}, timeoutMs: scanTimeoutMs}),
    startJob: payload => json('POST', '/worker/v1/jobs', {body: payload, timeoutMs: fastTimeoutMs}),
    progress: jobId => json('GET', `/worker/v1/jobs/${enc(checkId(jobId))}/progress`),
    cancel: jobId => json('POST', `/worker/v1/jobs/${enc(checkId(jobId))}/cancel`, {body: {}}),
    manifest: (jobId, key) => json('GET', `/worker/v1/jobs/${enc(checkId(jobId))}/chapters/${enc(checkId(key))}/manifest`),
    // URL halaman dibangun dari jobId/key/nomor — `url` dari manifest worker sengaja TIDAK diikuti.
    openPage: (jobId, key, n) => raw('GET', `/worker/v1/jobs/${enc(checkId(jobId))}/chapters/${enc(checkId(key))}/pages/${Number(n) | 0}`, {timeoutMs: pageTimeoutMs}),
    stagedCover: stagedId => raw('GET', `/worker/v1/staging/${enc(checkId(stagedId, STAGED))}`, {timeoutMs: 30_000}),
    deleteStaged: stagedId => json('DELETE', `/worker/v1/staging/${enc(checkId(stagedId, STAGED))}`),
    deleteChapter: (jobId, key) => json('DELETE', `/worker/v1/jobs/${enc(checkId(jobId))}/chapters/${enc(checkId(key))}`),
    deleteJob: jobId => json('DELETE', `/worker/v1/jobs/${enc(checkId(jobId))}`)
  };
}

module.exports = {createWorkerClient, WorkerError};
