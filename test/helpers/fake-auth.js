'use strict';
// Backend auth palsu (HTTP) yang meniru kontrak auth BE Python sehingga BFF di FE dapat diuji
// tanpa menjalankan layanan Python sungguhan. Seluruh isi dibangkitkan program.
const http = require('node:http');

const publicUser = u => ({id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, role: u.role || 'user', providers: u.providers.slice()});

function startFakeAuth({users = []} = {}) {
  const st = {
    users: new Map(users.map(u => [String(u.username).toLowerCase(), {id: u.id || ('u-' + u.username), username: String(u.username).toLowerCase(), display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, password: u.password === undefined ? null : u.password, role: u.role || 'user', providers: (u.providers || []).slice()}])),
    sessions: new Map(), handoffs: new Map(), requests: []
  };
  let seq = 0;
  const issue = user => { const token = 'tok-' + (++seq); st.sessions.set(token, user); return token; };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj, extra = {}) => { res.writeHead(code, {'content-type': 'application/json', ...extra}); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
      st.requests.push({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body});

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const key = String(body.username || '').toLowerCase();
        let u = st.users.get(key);
        if (!u) { u = {id: 'u-' + key, username: key, display_name: key, avatar_url: null, password: body.password, role: 'user', providers: []}; st.users.set(key, u); }
        else if (u.password !== null && u.password !== body.password) return send(401, {error: 'Nama pengguna atau kata sandi tidak cocok.'});
        return send(200, {authenticated: true, session_token: issue(u), user: publicUser(u)});
      }
      if (req.method === 'GET' && url.pathname === '/me') {
        const u = st.sessions.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        return u ? send(200, publicUser(u)) : send(401, {error: 'Sesi tidak valid.'});
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') return send(200, {ok: true});
      if (req.method === 'POST' && url.pathname === '/auth/handoff') {
        const u = st.handoffs.get(String(body.code || ''));
        if (!u) return send(400, {error: 'Kode handoff tidak valid atau kedaluwarsa.'});
        st.handoffs.delete(String(body.code));
        return send(200, {session_token: issue(u), user: publicUser(u)});
      }
      const start = url.pathname.match(/^\/auth\/([a-z]+)\/start$/);
      if (req.method === 'GET' && start) return send(200, {provider: start[1], return_to: url.searchParams.get('return_to') || '/'});
      return send(404, {error: 'Rute auth palsu tidak ditemukan.'});
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`, port, requests: st.requests,
        seedHandoff(code, user = {}) { const u = {id: user.id || ('u-' + code), username: user.username || code, display_name: user.display_name || user.username || code, avatar_url: user.avatar_url || null, password: null, role: user.role || 'user', providers: user.providers || ['google']}; st.handoffs.set(String(code), u); return u; },
        addUser(user) { st.users.set(String(user.username).toLowerCase(), {id: user.id || ('u-' + user.username), username: String(user.username).toLowerCase(), display_name: user.display_name || user.username, avatar_url: user.avatar_url || null, password: user.password === undefined ? null : user.password, role: user.role || 'user', providers: (user.providers || []).slice()}); },
        close: () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); })
      });
    });
  });
}

module.exports = {startFakeAuth};
