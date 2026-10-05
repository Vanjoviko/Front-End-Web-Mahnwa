'use strict';
// Diuji di proses terpisah agar baseline RSS bersih (tidak terpengaruh tes lain).
const {mediaDir} = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable} = require('node:stream');
const {ingestChapter, scanLimits} = require('../lib/scan-media');
const {makeImage} = require('./helpers/images');
const LIM = scanLimits({});

// Bangkitkan stream besar tanpa menahan seluruhnya di memori; hitung sha256 sambil jalan.
function generated(size, chunk = 64 * 1024, seed = 1) {
  const head = makeImage('png', 16, seed).subarray(0, 8);
  const hash = crypto.createHash('sha256');
  const block = Buffer.alloc(chunk, seed);
  const pieces = [];
  let sent = 0;
  const first = Buffer.concat([head, block.subarray(0, chunk - 8)]);
  const plan = [];
  let left = size;
  while (left > 0) { const take = Math.min(left, chunk); plan.push(take); left -= take; }
  plan.forEach((take, i) => { const piece = i === 0 ? first.subarray(0, take) : block.subarray(0, take); hash.update(piece); });
  const digest = hash.digest('hex');
  const stream = () => Readable.from((async function* () { for (const [i, take] of plan.entries()) { yield i === 0 ? first.subarray(0, take) : block.subarray(0, take); await new Promise(r => setImmediate(r)); } })());
  return {size, sha: digest, response: () => new Response(Readable.toWeb(stream()))};
}

test('ingest streaming: chapter ~120 MB tidak menaikkan memori proses mendekati ukuran chapter', async () => {
  const gens = Array.from({length: 10}, (_, i) => generated(12 * 1048576, 65536, i + 1)); // 10 x 12 MiB = 120 MiB
  const manifest = {pages: gens.map((g, i) => ({page_number: i + 1, content_type: 'image/png', bytes: g.size, sha256: g.sha}))};
  if (global.gc) global.gc();
  const base = process.memoryUsage().rss;
  let peak = base;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const r = await ingestChapter({draftId: 'd_mem', key: 'c_0001', manifest, limits: LIM, openPage: async n => gens[n - 1].response()});
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const growthMB = Math.round((peak - base) / 1048576);
  console.log(`# RSS growth during 120 MiB chapter ingest: ${growthMB} MB (chapter size 120 MiB)`);
  assert.equal(r.bytes, 120 * 1048576);
  assert.ok(growthMB < 80, `pertumbuhan RSS ${growthMB} MB terlalu besar untuk streaming`);
  await fs.rm(path.join(mediaDir, '_drafts', 'd_mem'), {recursive: true, force: true});
});

