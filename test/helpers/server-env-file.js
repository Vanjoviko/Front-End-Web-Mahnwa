'use strict';
// Menjalankan server.js dari SALINAN aplikasi sementara dengan konfigurasi HANYA dari berkas .env.
// Regresi: LEMBAR_DATA_DIR yang ditulis di .env harus dipakai untuk db.json SEKALIGUS media, supaya
// berkas yang ditulis (sampul & halaman) benar-benar terlayani lewat endpoint /media.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const REPO = path.join(__dirname, '..', '..');

function copyApp(dest) {
  fs.mkdirSync(dest, {recursive: true});
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(dest, 'server.js'));
  fs.cpSync(path.join(REPO, 'lib'), path.join(dest, 'lib'), {recursive: true});
  fs.mkdirSync(path.join(dest, 'public'), {recursive: true}); // dibutuhkan agar path relatif statis valid
}

async function startServerFromEnvFile({env = {}, db, dataDir = 'dev-data', envLines = []} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lembar-env-'));
  const app = path.join(dir, 'app');
  copyApp(app);
  if (db) fs.mkdirSync(path.join(app, dataDir), {recursive: true});
  if (db) fs.writeFileSync(path.join(app, dataDir, 'db.json'), JSON.stringify(db));
  // Relatif (seperti .env developer) supaya menguji resolusi cwd yang sama dengan `npm start`.
  fs.writeFileSync(path.join(app, '.env'), [`LEMBAR_DATA_DIR=${dataDir}`, ...envLines].join('\n') + '\n');

  const port = 3200 + Math.floor(Math.random() * 600);
  const childEnv = {...process.env};
  delete childEnv.LEMBAR_DATA_DIR; // HANYA boleh datang dari .env
  delete childEnv.LEMBAR_SKIP_ENV; // agar .env benar-benar dibaca
  Object.assign(childEnv, {PORT: String(port), HOST: '127.0.0.1', ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw-uji-123'}, env);
  const child = spawn(process.execPath, [path.join(app, 'server.js')], {cwd: app, env: childEnv, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server .env tidak start: ' + log)), 8000);
    child.stdout.on('data', () => { if (log.includes('Lembar siap')) { clearTimeout(t); resolve(); } });
    child.on('exit', code => { clearTimeout(t); reject(new Error('server .env keluar: ' + code + ' ' + log)); });
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const request = async (method, p, body) => {
    const res = await fetch(base + p, {method, headers: {...(body !== undefined ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch {}
    return {status: res.status, json, buf, headers: res.headers};
  };
  return {
    dir, app, base, port, log: () => log, request,
    async login() { const res = await fetch(base + '/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'admin', password: 'pw-uji-123', role: 'admin'})}); cookie = res.headers.get('set-cookie').split(';')[0]; return cookie; },
    rawGet: (p, headers = {}) => new Promise((resolve, reject) => { http.get({host: '127.0.0.1', port, path: p, headers}, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)})); }).on('error', reject); }),
    stop: () => new Promise(r => { child.once('exit', () => { fs.rmSync(dir, {recursive: true, force: true}); r(); }); child.kill(); })
  };
}

module.exports = {startServerFromEnvFile};
