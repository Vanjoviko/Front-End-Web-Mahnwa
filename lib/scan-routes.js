'use strict';
// Rute /api/admin/scan* (setelah guard sesi admin). Hanya pola ID ketat yang diterima; selainnya 404 (NFR-03).
// FE memanggil metode worker yang tetap — tidak ada forwarding path/header/cookie dari browser.
const {WorkerError} = require('./scan-worker');

const ROUTE = /^\/api\/admin\/scan(?:\/([A-Za-z0-9_-]{1,64})(?:\/(download|progress|cancel|publish|cover)|\/chapters\/([A-Za-z0-9_-]{1,64})\/(retry))?)?$/;

function createScanHandler({service, config, json, readBody, logger = console}) {
  const send = (res, status, obj) => json(res, status, obj);
  function sendError(res, error) {
    if (error instanceof WorkerError) {
      const headers = {};
      return send(res, error.status, {error: error.message, code: error.code, ...(error.extra || {})}, headers);
    }
    if (error?.message === 'Ukuran permintaan terlalu besar') return send(res, 413, {error: 'Ukuran permintaan terlalu besar.', code: 'PAYLOAD_TOO_LARGE'});
    if (error?.message === 'Format JSON tidak valid') return send(res, 400, {error: 'Format JSON tidak valid.', code: 'INVALID_REQUEST'});
    logger.error?.('[scan-route]', error?.stack || error);
    return send(res, 500, {error: 'Terjadi kesalahan server.', code: 'INTERNAL_ERROR'});
  }

  return async function handle(req, res, url) {
    const m = ROUTE.exec(url.pathname);
    if (!m) return send(res, 404, {error: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND'});
    const [, id, action, chapterKey] = m;
    const sub = action || (chapterKey ? 'retry' : null);
    const method = req.method;
    const allowed = !id ? ['GET', 'POST'] : sub ? (['progress', 'cover'].includes(sub) ? ['GET'] : ['POST']) : ['GET', 'PATCH', 'DELETE'];
    if (!allowed.includes(method)) return send(res, 405, {error: 'Metode tidak diizinkan.', code: 'METHOD_NOT_ALLOWED'});
    try {
      if (!config.workerToken && !config.devMode && (method !== 'GET' || sub === 'progress')) {
        throw new WorkerError(503, 'WORKER_NOT_CONFIGURED', 'SCAN_WORKER_TOKEN belum dikonfigurasi di server.');
      }
      if (!id) {
        if (method === 'GET') return send(res, 200, await service.list());
        const b = await readBody(req);
        return send(res, 201, await service.scan(b?.url));
      }
      if (!sub) {
        if (method === 'GET') return send(res, 200, await service.get(id));
        if (method === 'DELETE') return send(res, 200, await service.discard(id));
        return send(res, 200, await service.patch(id, await readBody(req)));
      }
      if (sub === 'cover') {
        const {buf, type} = await service.coverFile(id);
        res.writeHead(200, {'content-type': type, 'content-length': buf.length, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store'});
        return res.end(buf);
      }
      if (sub === 'progress') return send(res, 200, await service.progress(id));
      if (sub === 'download') return send(res, 202, await service.startDownload(id, await readBody(req)));
      if (sub === 'cancel') return send(res, 200, await service.cancel(id));
      if (sub === 'publish') return send(res, 201, await service.publish(id, await readBody(req)));
      if (sub === 'retry') return send(res, 202, await service.retryChapter(id, chapterKey));
      return send(res, 404, {error: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND'});
    } catch (error) { return sendError(res, error); }
  };
}

module.exports = {createScanHandler, ROUTE};
