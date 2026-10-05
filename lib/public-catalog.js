'use strict';
// Proyeksi publik katalog (NFR-09 / Q7): hanya field yang dibutuhkan UI; tidak ada daftar halaman, storageKey,
// sumber, URL asal, maupun pesan galat internal. Daftar halaman diambil reader lewat endpoint terpisah.
const zlib = require('node:zlib');

const COMIC_FIELDS = ['id', 'title', 'alt', 'type', 'status', 'genres', 'rating', 'year', 'author', 'synopsis', 'cover', 'banner', 'source', 'externalContent', 'metadataCheckedAt'];
const isMedia = v => typeof v === 'string' && v.startsWith('/media/');

function pageCount(chapter) { return Array.isArray(chapter?.pages) ? chapter.pages.length : 0; }

function publicChapter(chapter) {
  const out = {id: chapter.id, number: chapter.number, title: chapter.title || '', date: chapter.date || '', pageCount: pageCount(chapter)};
  if (chapter.status) out.status = chapter.status;
  if (isMedia(chapter.pdfUrl)) out.pdfUrl = chapter.pdfUrl;
  return out;
}

function publicComic(comic) {
  const out = {};
  for (const field of COMIC_FIELDS) if (comic[field] !== undefined) out[field] = comic[field];
  // sourceUrl hanya relevan untuk tautan "sumber" milik komik non-scan yang sudah ada; jalur scan tidak menyimpannya.
  out.chapters = (comic.chapters || []).map(publicChapter);
  return out;
}

function publicCatalog(db) {
  return {comics: db.comics.map(publicComic), announcements: db.announcements, ads: db.ads.filter(ad => ad.enabled)};
}

// Proyeksi admin: sama seperti komik lengkap tetapi `pages` diganti `pageCount` agar payload tetap kecil (NFR-09).
function adminComic(comic) {
  const out = {...comic, chapters: (comic.chapters || []).map(chapter => {
    const {pages, ...rest} = chapter;
    return {...rest, pageCount: pageCount(chapter)};
  })};
  return out;
}

function detailForReader(comic, chapter) {
  const kind = chapter.importMethod ? 'import' : (chapter.fileUrl || chapter.pdfUrl) && !pageCount(chapter) ? 'pdf' : 'images';
  const pages = (chapter.pages || []).map((page, index) => {
    const image = typeof page === 'string' ? page : (page?.image_url || page?.url || '');
    return {page_number: Number(page?.page_number) || index + 1, image_url: image};
  }).filter(page => isMedia(page.image_url));
  const out = {comicId: comic.id, chapterId: chapter.id, number: chapter.number, status: chapter.status || (pages.length ? 'COMPLETED' : undefined), kind, pages};
  if (chapter.status === 'FAILED' && chapter.errorMessage) out.errorMessage = String(chapter.errorMessage).slice(0, 300);
  if (isMedia(chapter.fileUrl)) out.fileUrl = chapter.fileUrl;
  if (isMedia(chapter.pdfUrl)) out.pdfUrl = chapter.pdfUrl;
  return out;
}

// Kirim JSON; gzip bila klien menerima dan payload cukup besar.
function sendJson(res, status, obj, {minGzip = 1400} = {}) {
  const raw = Buffer.from(JSON.stringify(obj));
  const headers = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding'};
  const accepts = String(res.req?.headers?.['accept-encoding'] || '');
  if (raw.length >= minGzip && /\bgzip\b/i.test(accepts)) {
    const body = zlib.gzipSync(raw);
    res.writeHead(status, {...headers, 'content-encoding': 'gzip', 'content-length': body.length});
    return res.end(body);
  }
  res.writeHead(status, {...headers, 'content-length': raw.length});
  return res.end(raw);
}

module.exports = {publicCatalog, publicComic, publicChapter, adminComic, detailForReader, sendJson, pageCount};
