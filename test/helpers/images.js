'use strict';
// Gambar placeholder minimal (hanya magic byte + isi acak deterministik). Konten orisinal, bukan karya nyata.
const crypto = require('node:crypto');

const HEAD = {
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
};
const MIME = {png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp'};

function makeImage(kind = 'png', size = 2048, seed = 1) {
  const head = HEAD[kind];
  const body = Buffer.alloc(Math.max(0, size - head.length));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < body.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; body[i] = x >>> 24; }
  return Buffer.concat([head, body]);
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const dataUrl = (kind, size, seed) => `data:${MIME[kind]};base64,${makeImage(kind, size, seed).toString('base64')}`;

module.exports = {makeImage, sha256, dataUrl, MIME};
