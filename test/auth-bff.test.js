'use strict';
// Uji BFF login di FE: FE hanya proksi ke backend auth Python; cookie sesi tetap milik FE.
const test = require('node:test');
const assert = require('node:assert/strict');
const {startServer} = require('./helpers/server');
const {startFakeAuth} = require('./helpers/fake-auth');

const redirect = (s, p, opts = {}) => fetch(s.base + p, {redirect: 'manual', ...opts});

test('Login pembaca nonaktif: /api/auth/me melaporkan nonaktif, login 503, register dihapus', async () => {
  const s = await startServer();
  try {
    const me = await s.request('GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.authenticated, false);
    assert.equal(me.json.enabled, false);
    assert.equal((await s.request('POST', '/api/auth/login', {username: 'x', password: 'y'})).status, 503);
    assert.equal((await s.request('POST', '/api/auth/register', {username: 'x', password: 'rahasia123'})).status, 404);
    assert.equal((await s.request('GET', '/api/auth/social/google/start')).status, 503);
  } finally { await s.stop(); }
});

test('Login kata sandi pembaca lewat BFF: sesi FE memakai token backend, /me & logout benar', async () => {
  const a = await startFakeAuth(); const s = await startServer({auth: a});
  try {
    const me0 = await s.request('GET', '/api/auth/me');
    assert.equal(me0.json.authenticated, false);
    assert.equal(me0.json.enabled, true);
    assert.deepEqual(me0.json.social, ['google', 'discord', 'x']);

    const login = await s.readerLogin('budi', 'rahasia-budi-1');
    assert.equal(login.status, 200);
    assert.match(login.cookie, /^akuma_session=/);
    assert.equal(login.json.role, 'user');
    assert.equal(login.json.username, 'budi');

    // Cookie pembaca: Lax + masa hidup 30 hari (bukan Strict/8 jam milik admin).
    const setCookie = (await fetch(s.base + '/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'budi', password: 'rahasia-budi-1', role: 'user'})})).headers.get('set-cookie');
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);

    const me = await s.request('GET', '/api/auth/me', undefined, {headers: {cookie: login.cookie}});
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.role, 'user');
    assert.equal(me.json.username, 'budi');
    assert.equal(me.json.user.id, 'u-budi');

    // Kata sandi salah diteruskan sebagai 401 dari backend, bukan 200.
    const bad = await s.readerLogin('budi', 'kata-sandi-salah');
    assert.equal(bad.status, 401);
    assert.match(bad.json.error, /tidak cocok/i);

    // Logout membuang sesi FE dan mengosongkan cookie.
    const out = await s.request('POST', '/api/auth/logout', {}, {headers: {cookie: login.cookie}});
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await s.request('GET', '/api/auth/me', undefined, {headers: {cookie: login.cookie}})).json.authenticated, false);
  } finally { await s.stop(); await a.close(); }
});

test('Sosial: /api/auth/social/:provider/start meneruskan ke backend dengan return_to relatif yang aman', async () => {
  const a = await startFakeAuth(); const s = await startServer({auth: a});
  try {
    const ok = await redirect(s, '/api/auth/social/google/start?return_to=' + encodeURIComponent('/#detail/abc'));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), `${a.url}/auth/google/start?return_to=${encodeURIComponent('/#detail/abc')}`);

    // return_to tidak boleh mutlak/protokol-relatif.
    for (const evil of ['//evil.example/x', 'https://evil.example/', '\\\\evil']) {
      const r = await redirect(s, '/api/auth/social/discord/start?return_to=' + encodeURIComponent(evil));
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), `${a.url}/auth/discord/start?return_to=%2F`);
    }

    assert.equal((await s.request('GET', '/api/auth/social/tiktok/start')).status, 404);
  } finally { await s.stop(); await a.close(); }
});

test('Callback OAuth: menukar handoff jadi sesi FE lalu mengalihkan ke return_to', async () => {
  const a = await startFakeAuth(); const s = await startServer({auth: a});
  try {
    a.seedHandoff('ho-uji-1', {username: 'sosial-budi', avatar_url: 'https://cdn.example/a.png', providers: ['google']});
    const res = await redirect(s, '/api/auth/callback?handoff=ho-uji-1&return_to=' + encodeURIComponent('/#account'));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/#account');
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /^akuma_session=/);
    assert.match(setCookie, /SameSite=Lax/);

    const cookie = setCookie.split(';')[0];
    const me = await fetch(s.base + '/api/auth/me', {headers: {cookie}});
    const data = await me.json();
    assert.equal(data.authenticated, true);
    assert.equal(data.username, 'sosial-budi');
    assert.equal(data.user.avatar_url, 'https://cdn.example/a.png');
    assert.deepEqual(data.user.providers, ['google']);

    // Handoff tidak valid -> kembali ke rute asal dengan penanda modal login (bukan halaman /#login).
    const bad = await redirect(s, '/api/auth/callback?handoff=tidak-ada');
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get('location'), '/#home?auth=error&error=failed');

    // return_to asal dipertahankan supaya modal login muncul di halaman yang sama.
    const badWithReturn = await redirect(s, '/api/auth/callback?handoff=tidak-ada&return_to=' + encodeURIComponent('/#detail/abc'));
    assert.equal(badWithReturn.headers.get('location'), '/#detail/abc?auth=error&error=failed');

    // Pembatalan dari penyedia diteruskan apa adanya.
    const cancelled = await redirect(s, '/api/auth/callback?error=cancelled');
    assert.equal(cancelled.headers.get('location'), '/#home?auth=error&error=cancelled');

    // return_to berbahaya pada callback juga dinetralkan.
    a.seedHandoff('ho-uji-2', {username: 'sosial-ani'});
    const evil = await redirect(s, '/api/auth/callback?handoff=ho-uji-2&return_to=' + encodeURIComponent('//evil.example'));
    assert.equal(evil.headers.get('location'), '/');
  } finally { await s.stop(); await a.close(); }
});

test('Admin tetap lokal: login admin tidak menyentuh backend auth', async () => {
  const a = await startFakeAuth(); const s = await startServer({auth: a});
  try {
    await s.login();
    const me = await s.request('GET', '/api/auth/me');
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.role, 'admin');
    assert.equal(a.requests.filter(r => r.path === '/auth/login').length, 0, 'login admin tidak boleh memanggil backend');
  } finally { await s.stop(); await a.close(); }
});

test('RBAC: pembaca ber-role admin bisa /api/admin; role user ditolak 401', async () => {
  const a = await startFakeAuth(); const s = await startServer({auth: a});
  try {
    a.addUser({username: 'boss', password: 'rahasia-boss-1', role: 'admin', providers: ['google']});
    const boss = await s.readerLogin('boss', 'rahasia-boss-1');
    assert.equal(boss.status, 200);
    assert.equal(boss.json.role, 'admin');
    const meBoss = await s.request('GET', '/api/auth/me', undefined, {headers: {cookie: boss.cookie}});
    assert.equal(meBoss.json.role, 'admin');
    assert.equal(meBoss.json.user.role, 'admin');
    assert.equal((await s.request('GET', '/api/admin', undefined, {headers: {cookie: boss.cookie}})).status, 200);

    const budi = await s.readerLogin('budi', 'rahasia-budi-1');
    assert.equal(budi.json.role, 'user');
    assert.equal((await s.request('GET', '/api/auth/me', undefined, {headers: {cookie: budi.cookie}})).json.role, 'user');
    assert.equal((await s.request('GET', '/api/admin', undefined, {headers: {cookie: budi.cookie}})).status, 401);
  } finally { await s.stop(); await a.close(); }
});
