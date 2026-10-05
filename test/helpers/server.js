'use strict';
// Menjalankan server.js sungguhan sebagai proses anak dengan direktori data sementara.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

async function startServer({env = {}, db} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lembar-srv-'));
  if (db) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db));
  const port = 3200 + Math.floor(Math.random() * 600);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: {...process.env, LEMBAR_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw-uji-123', ...env}, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server tidak start: ' + log)), 8000);
    child.stdout.on('data', () => { if (log.includes('Lembar siap')) { clearTimeout(t); resolve(); } });
    child.on('exit', code => { clearTimeout(t); reject(new Error('server keluar: ' + code + ' ' + log)); });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (method, p, body, {headers = {}, raw = false} = {}) => {
    const res = await fetch(base + p, {method, headers: {...(body !== undefined && !raw ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...headers}, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body))});
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch {}
    return {status: res.status, json, buf, headers: res.headers};
  };
  return {
    dir, base, port, log: () => log,
    request,
    async login() { const res = await fetch(base + '/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'admin', password: 'pw-uji-123', role: 'admin'})}); cookie = res.headers.get('set-cookie').split(';')[0]; return cookie; },
    logout() { cookie = ''; },
    rawGet: (p, headers = {}) => new Promise((resolve, reject) => { http.get({host: '127.0.0.1', port, path: p, headers}, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)})); }).on('error', reject); }),
    stop: () => new Promise(r => { child.once('exit', () => { fs.rmSync(dir, {recursive: true, force: true}); r(); }); child.kill(); })
  };
}
module.exports = {startServer};
