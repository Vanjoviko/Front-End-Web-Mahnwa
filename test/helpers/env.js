'use strict';
// HARUS di-require paling awal: menetapkan direktori data sementara sebelum modul media dimuat.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lembar-test-'));
process.env.LEMBAR_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
module.exports = {dataDir: dir, mediaDir: path.join(dir, 'media')};
