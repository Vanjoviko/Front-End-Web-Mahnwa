'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createDbWriter} = require('../lib/db-writer');

test('50 saveDb hampir bersamaan: file selalu JSON valid, tidak ada tulis paralel, tulis digabung', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbw-'));
  const file = path.join(dir, 'db.json');
  const writer = createDbWriter(file);
  const db = {comics: [], n: 0};
  // pembaca bersamaan memastikan tidak pernah melihat file setengah tertulis
  let reading = true, badReads = 0;
  const reader = (async () => { while (reading) { try { JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') badReads++; } await new Promise(r => setTimeout(r, 1)); } })();
  const saves = [];
  for (let i = 0; i < 50; i++) { db.n = i + 1; db.comics.push({id: 'c' + i, pad: 'x'.repeat(2000)}); saves.push(writer.save(db)); }
  await Promise.all(saves);
  reading = false; await reader;
  assert.equal(badReads, 0);
  assert.equal(writer.stats.concurrentPeak, 1, 'tidak boleh ada dua tulis bersamaan');
  assert.equal(writer.stats.requests, 50);
  assert.ok(writer.stats.writes <= 3, `tulis harus digabung, terjadi ${writer.stats.writes}`);
  const final = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(final.n, 50);
  assert.equal(final.comics.length, 50);
  assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.tmp')), [], 'tidak ada berkas tmp tertinggal');
  await fs.rm(dir, {recursive: true, force: true});
});
test('kegagalan tulis tidak merusak berkas lama dan tidak mematikan antrean', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbw-'));
  const file = path.join(dir, 'db.json');
  const writer = createDbWriter(file);
  await writer.save({ok: 1});
  await fs.mkdir(file + '.blocker').catch(() => {});
  const bad = {toJSON() { throw new Error('boom'); }};
  await assert.rejects(writer.save(bad));
  await writer.save({ok: 2});
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).ok, 2);
  await fs.rm(dir, {recursive: true, force: true});
});
