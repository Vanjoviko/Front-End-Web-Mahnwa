'use strict';
// Rute /api/admin/subscriptions* (setelah guard sesi admin). Pola ID ketat.
const ROUTE = /^\/api\/admin\/subscriptions(?:\/([A-Za-z0-9_-]{1,64})(?:\/(sync|preview))?)?$/;

function createSubscriptionRoutes({service, json, readBody, logger = console}) {
  const send = (res, status, obj) => json(res, status, obj);

  function sendError(res, error) {
    if (error && typeof error.status === 'number' && error.code) {
      return send(res, error.status, {error: error.message, code: error.code, ...(error.extra || {})});
    }
    if (error?.message === 'Ukuran permintaan terlalu besar') return send(res, 413, {error: 'Ukuran permintaan terlalu besar.', code: 'PAYLOAD_TOO_LARGE'});
    if (error?.message === 'Format JSON tidak valid') return send(res, 400, {error: 'Format JSON tidak valid.', code: 'INVALID_REQUEST'});
    logger.error?.('[subscriptions-route]', error?.stack || error);
    return send(res, 500, {error: 'Terjadi kesalahan server.', code: 'INTERNAL_ERROR'});
  }

  return async function handle(req, res, url) {
    const m = ROUTE.exec(url.pathname);
    if (!m) return send(res, 404, {error: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND'});
    const [, id, action] = m;
    const method = req.method;
    const allowed = !id ? ['GET', 'POST'] : action ? ['GET', 'POST'] : ['GET', 'PATCH', 'DELETE'];
    if (!allowed.includes(method)) return send(res, 405, {error: 'Metode tidak diizinkan.', code: 'METHOD_NOT_ALLOWED'});
    try {
      if (!id) {
        if (method === 'GET') return send(res, 200, await service.list());
        const body = await readBody(req);
        return send(res, 201, await service.add(body));
      }
      if (action === 'sync') return send(res, 202, await service.syncNow(id));
      if (action === 'preview') return send(res, 200, await service.preview(id));
      if (method === 'GET') return send(res, 200, await service.get(id));
      if (method === 'PATCH') return send(res, 200, await service.patch(id, await readBody(req)));
      return send(res, 200, await service.remove(id));
    } catch (error) {
      return sendError(res, error);
    }
  };
}

module.exports = {createSubscriptionRoutes};
