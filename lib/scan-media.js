'use strict';
// Penyimpanan media jalur scan-import: ingest streaming dari worker, cover draft, dan perpindahan atomik saat publish.
// Limit scan (300 halaman / 150 MiB per chapter / 15 MiB per gambar) memakai konstanta TERPISAH dari upload manual (NFR-01).
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {MEDIA_ROOT, chapterFolderName} = require('./chapter-media');

const DRAFTS_DIR = '_drafts';
const MAX_SCAN_COVER_BYTES = 5_000_000; // cover tetap <= 5 MB

class ScanMediaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function scanLimits(env = process.env) {
  const n = (name, def) => { const v = Number(env[name]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : def; };
  return {
    maxPages: n('SCAN_MAX_PAGES_PER_CHAPTER', 300),
    maxChapterBytes: n('SCAN_MAX_BYTES_PER_CHAPTER', 157_286_400),
    maxImageBytes: n('SCAN_MAX_BYTES_PER_IMAGE', 15_728_640),
    maxCoverBytes: MAX_SCAN_COVER_BYTES
  };
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function sniffImage(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return {ext: '.jpg', mime: 'image/jpeg'};
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) return {ext: '.png', mime: 'image/png'};
  if (head.length >= 12 && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return {ext: '.webp', mime: 'image/webp'};
  return null;
}

const draftRoot = draftId => path.join(MEDIA_ROOT, DRAFTS_DIR, draftId);
const draftChapterDir = (draftId, key) => path.join(draftRoot(draftId), key);
const draftMediaUrl = (draftId, ...parts) => `/media/${DRAFTS_DIR}/${draftId}/${parts.join('/')}`;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function assertSafeId(id) { if (!SAFE_ID.test(String(id))) throw new ScanMediaError('INVALID_REQUEST', 'ID tidak valid.'); return id; }

async function removeDraftDir(draftId) { assertSafeId(draftId); await fs.rm(draftRoot(draftId), {recursive: true, force: true}); }
async function removeDraftChapter(draftId, key) { assertSafeId(draftId); assertSafeId(key); await fs.rm(draftChapterDir(draftId, key), {recursive: true, force: true}); }

// Simpan cover draft dari bytes (PNG/JPEG/WebP bermagic benar, <= 5 MB). Mengganti cover lama.
async function saveDraftCover(draftId, bytes) {
  assertSafeId(draftId);
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > MAX_SCAN_COVER_BYTES) throw new ScanMediaError('COVER_TOO_LARGE', 'Ukuran sampul melewati batas 5 MB.');
  const fmt = sniffImage(buf);
  if (!fmt) throw new ScanMediaError('UNSUPPORTED_IMAGE_FORMAT', 'Sampul harus berupa PNG, JPEG, atau WebP.');
  const dir = draftRoot(draftId);
  await fs.mkdir(dir, {recursive: true});
  for (const name of await fs.readdir(dir).catch(() => [])) if (/^cover-/.test(name)) await fs.rm(path.join(dir, name), {force: true});
  const name = `cover-${crypto.randomUUID()}${fmt.ext}`;
  await fs.writeFile(path.join(dir, name), buf, {flag: 'wx'});
  return draftMediaUrl(draftId, name);
}

function decodeCoverDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new ScanMediaError('UNSUPPORTED_IMAGE_FORMAT', 'Sampul harus berupa PNG, JPEG, atau WebP.');
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_SCAN_COVER_BYTES) throw new ScanMediaError('COVER_TOO_LARGE', 'Ukuran sampul melewati batas 5 MB.');
  const fmt = sniffImage(bytes);
  if (!fmt || fmt.mime !== `image/${m[1]}`) throw new ScanMediaError('UNSUPPORTED_IMAGE_FORMAT', 'Isi gambar sampul tidak sesuai dengan format filenya.');
  return bytes;
}

// Ingest satu chapter secara streaming: per halaman ke berkas .part -> verifikasi bytes/sha256/magic -> rename NNN.ext.
// Tidak pernah menahan satu chapter penuh di memori. Limit divalidasi ulang di sisi FE (NFR-01).
async function ingestChapter({draftId, key, manifest, openPage, limits}) {
  assertSafeId(draftId); assertSafeId(key);
  const pages = Array.isArray(manifest?.pages) ? manifest.pages : null;
  if (!pages || !pages.length) throw new ScanMediaError('NO_PAGES', 'Chapter tidak memiliki halaman.');
  if (pages.length > limits.maxPages) throw new ScanMediaError('LIMIT_PAGES', `Chapter memiliki ${pages.length} halaman (maksimal ${limits.maxPages}).`);
  let declaredTotal = 0;
  pages.forEach((p, i) => {
    if (p?.page_number !== i + 1) throw new ScanMediaError('INTEGRITY', 'Nomor halaman dari worker tidak berurutan.');
    if (!Number.isInteger(p.bytes) || p.bytes < 1) throw new ScanMediaError('INTEGRITY', `Ukuran halaman ${i + 1} tidak valid.`);
    if (p.bytes > limits.maxImageBytes) throw new ScanMediaError('LIMIT_IMAGE_BYTES', `Halaman ${i + 1} melebihi ${Math.round(limits.maxImageBytes / 1048576)} MB.`);
    if (!/^[0-9a-f]{64}$/i.test(String(p.sha256 || ''))) throw new ScanMediaError('INTEGRITY', `Checksum halaman ${i + 1} tidak valid.`);
    declaredTotal += p.bytes;
  });
  if (declaredTotal > limits.maxChapterBytes) throw new ScanMediaError('LIMIT_CHAPTER_BYTES', `Total ukuran chapter melebihi ${Math.round(limits.maxChapterBytes / 1048576)} MB.`);

  const dir = draftChapterDir(draftId, key);
  await fs.rm(dir, {recursive: true, force: true});
  await fs.mkdir(dir, {recursive: true});
  const result = [];
  let total = 0;
  try {
    for (const [index, page] of pages.entries()) {
      const number = index + 1, part = path.join(dir, `${String(number).padStart(3, '0')}.part`);
      const response = await openPage(number);
      if (!response.body) throw new ScanMediaError('INTEGRITY', `Halaman ${number} kosong.`);
      const hash = crypto.createHash('sha256');
      let size = 0, head = Buffer.alloc(0), fmt = null;
      const handle = await fs.open(part, 'w');
      try {
        for await (const chunk of response.body) {
          const buf = Buffer.from(chunk);
          if (!fmt) {
            head = Buffer.concat([head, buf]);
            if (head.length >= 12) { fmt = sniffImage(head); if (!fmt) throw new ScanMediaError('UNSUPPORTED_IMAGE_FORMAT', `Halaman ${number} bukan JPEG/PNG/WebP.`); }
          }
          size += buf.length; total += buf.length;
          if (size > page.bytes || size > limits.maxImageBytes) throw new ScanMediaError(size > limits.maxImageBytes ? 'LIMIT_IMAGE_BYTES' : 'INTEGRITY', `Ukuran halaman ${number} tidak sesuai manifest.`);
          if (total > limits.maxChapterBytes) throw new ScanMediaError('LIMIT_CHAPTER_BYTES', `Total ukuran chapter melebihi ${Math.round(limits.maxChapterBytes / 1048576)} MB.`);
          hash.update(buf);
          await handle.write(buf);
        }
      } finally { await handle.close(); }
      if (!fmt) fmt = sniffImage(head);
      if (!fmt) throw new ScanMediaError('UNSUPPORTED_IMAGE_FORMAT', `Halaman ${number} bukan JPEG/PNG/WebP.`);
      if (size !== page.bytes) throw new ScanMediaError('INTEGRITY', `Ukuran halaman ${number} tidak cocok dengan manifest.`);
      if (hash.digest('hex') !== String(page.sha256).toLowerCase()) throw new ScanMediaError('INTEGRITY', `Checksum halaman ${number} tidak cocok.`);
      if (page.content_type && page.content_type !== fmt.mime) throw new ScanMediaError('INTEGRITY', `Tipe halaman ${number} tidak cocok dengan isinya.`);
      const final = `${String(number).padStart(3, '0')}${fmt.ext}`;
      await fs.rename(part, path.join(dir, final));
      result.push({page_number: number, image_url: draftMediaUrl(draftId, key, final)});
    }
    return {pages: result, bytes: total};
  } catch (error) {
    await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

// Transaksi file untuk publish: semua perpindahan dapat dibatalkan (rollback) bila langkah berikutnya gagal.
function createFileTransaction() {
  const undo = [], commits = [];
  return {
    async move(from, to) {
      const created = await fs.mkdir(path.dirname(to), {recursive: true}); // direktori pertama yang dibuat (bila ada)
      if (created) undo.push(() => fs.rm(created, {recursive: true, force: true}));
      await fs.rename(from, to);
      undo.push(async () => { await fs.mkdir(path.dirname(from), {recursive: true}); await fs.rename(to, from); });
    },
    async stash(dir) { // sisihkan direktori lama (mis. chapter yang diganti); dihapus permanen saat commit
      try { await fs.access(dir); } catch { return; }
      const aside = `${dir}.replaced-${crypto.randomBytes(4).toString('hex')}`;
      await fs.rename(dir, aside);
      undo.push(async () => { await fs.rm(dir, {recursive: true, force: true}); await fs.rename(aside, dir); });
      commits.push(() => fs.rm(aside, {recursive: true, force: true}));
    },
    async rollback() { for (const fn of undo.reverse()) { try { await fn(); } catch {} } },
    async commit() { for (const fn of commits) { try { await fn(); } catch {} } }
  };
}

module.exports = {
  DRAFTS_DIR, MAX_SCAN_COVER_BYTES, ScanMediaError, scanLimits, sniffImage, draftRoot, draftChapterDir, draftMediaUrl,
  removeDraftDir, removeDraftChapter, saveDraftCover, decodeCoverDataUrl, ingestChapter, createFileTransaction, assertSafeId, chapterFolderName
};
