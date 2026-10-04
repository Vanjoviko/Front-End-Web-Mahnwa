'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);
const MEDIA_ROOT = path.resolve(process.env.LEMBAR_DATA_DIR || path.join(__dirname, '..', 'data'), 'media');
const MAX_COVER_BYTES = 5_000_000;
const MAX_PDF_BYTES = 20_000_000;
const MAX_RENDERED_PAGES = 80;
const MAX_CHAPTER_IMAGE_BYTES = 28_000_000;

function comicStorageKey(comic) {
  if (comic.storageKey && /^[a-z0-9-]{1,120}$/i.test(comic.storageKey)) return comic.storageKey;
  const slug = String(comic.title || 'comic')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'comic';
  const id = String(comic.id || crypto.randomUUID()).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
  return `${slug}-${id || crypto.randomUUID().slice(0, 8)}`;
}

function chapterFolderName(chapterNumber) {
  const number = String(chapterNumber ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(number)) throw new Error('Nomor chapter tidak valid.');
  return `chapter-${number.replace('.', '-')}`;
}

function chapterDirectory(storageKey, chapterNumber) {
  return path.join(MEDIA_ROOT, storageKey, 'chapters', chapterFolderName(chapterNumber));
}

function publicMediaUrl(filePath) {
  const relative = path.relative(MEDIA_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path media berada di luar direktori penyimpanan.');
  return `/media/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function resolveMediaUrl(mediaUrl) {
  if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('/media/')) throw new Error('URL media tidak valid.');
  const segments = mediaUrl.slice('/media/'.length).split('/').map(decodeURIComponent);
  if (segments.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
    throw new Error('Path media tidak valid.');
  }
  const result = path.resolve(MEDIA_ROOT, ...segments);
  if (!result.startsWith(MEDIA_ROOT + path.sep)) throw new Error('Path media berada di luar direktori penyimpanan.');
  return result;
}

function decodeUpload(dataUrl, kind) {
  const pattern = kind === 'pdf'
    ? /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/
    : /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
  const match = String(dataUrl || '').match(pattern);
  if (!match) throw new Error(kind === 'pdf' ? 'File harus berupa PDF.' : 'Sampul harus berupa PNG, JPEG, atau WebP.');

  const mime = kind === 'pdf' ? 'application/pdf' : `image/${match[1]}`;
  const bytes = Buffer.from(kind === 'pdf' ? match[1] : match[2], 'base64');
  const limit = kind === 'pdf' ? MAX_PDF_BYTES : MAX_COVER_BYTES;
  if (!bytes.length || bytes.length > limit) throw new Error(`Ukuran ${kind === 'pdf' ? 'PDF' : 'sampul'} melewati batas.`);

  if (kind === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Isi file PDF tidak valid.');
  if (kind === 'image') {
    const signatures = {
      'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'image/jpeg': bytes[0] === 255 && bytes[1] === 216,
      'image/webp': bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
    };
    if (!signatures[mime]) throw new Error('Isi gambar sampul tidak sesuai dengan format filenya.');
  }

  const extension = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'application/pdf': '.pdf'}[mime];
  return {bytes, extension};
}

async function saveCover(dataUrl, storageKey) {
  const {bytes, extension} = decodeUpload(dataUrl, 'image');
  const directory = path.join(MEDIA_ROOT, storageKey);
  await fs.mkdir(directory, {recursive: true});
  const filePath = path.join(directory, `cover-${crypto.randomUUID()}${extension}`);
  await fs.writeFile(filePath, bytes, {flag: 'wx'});
  return publicMediaUrl(filePath);
}

async function saveChapterPdf(dataUrl, storageKey, chapterNumber) {
  const {bytes} = decodeUpload(dataUrl, 'pdf');
  const directory = chapterDirectory(storageKey, chapterNumber);
  await fs.mkdir(directory, {recursive: true});
  const filePath = path.join(directory, 'original.pdf');
  await fs.writeFile(filePath, bytes, {flag: 'wx'});
  return {filePath, url: publicMediaUrl(filePath)};
}

async function saveChapterImages(dataUrls, storageKey, chapterNumber) {
  if (!Array.isArray(dataUrls) || dataUrls.length < 1 || dataUrls.length > MAX_RENDERED_PAGES) {
    throw new Error(`Pilih 1–${MAX_RENDERED_PAGES} gambar untuk satu chapter.`);
  }

  const images = dataUrls.map(dataUrl => decodeUpload(dataUrl, 'image'));
  const totalBytes = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (totalBytes > MAX_CHAPTER_IMAGE_BYTES) throw new Error('Total ukuran gambar chapter maksimal 28 MB.');

  const directory = chapterDirectory(storageKey, chapterNumber);
  await fs.mkdir(directory, {recursive: true});
  const pages = [];
  try {
    for (const [index, image] of images.entries()) {
      const filename = `${String(index + 1).padStart(3, '0')}${image.extension}`;
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, image.bytes, {flag: 'wx'});
      pages.push({page_number: index + 1, image_url: publicMediaUrl(filePath)});
    }
    return pages;
  } catch (error) {
    await Promise.all(pages.map(page => fs.rm(resolveMediaUrl(page.image_url), {force: true})));
    throw error.code === 'EEXIST' ? new Error('Berkas halaman chapter sudah ada. Hapus chapter lama sebelum mengunggah ulang.') : error;
  }
}

async function saveDownloadedChapterImages(images, storageKey, chapterNumber) {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_RENDERED_PAGES) {
    throw new Error(`Sumber harus menyediakan 1–${MAX_RENDERED_PAGES} gambar halaman.`);
  }
  const extensions = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'};
  let totalBytes = 0;
  for (const image of images) {
    const bytes = Buffer.from(image?.bytes || []);
    const mimeType = String(image?.mimeType || '').toLowerCase();
    const valid = mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216
      : mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      : false;
    if (!valid || !bytes.length || bytes.length > MAX_COVER_BYTES) throw new Error('Sumber mengembalikan gambar dengan format atau ukuran yang tidak valid.');
    totalBytes += bytes.length;
  }
  if (totalBytes > MAX_CHAPTER_IMAGE_BYTES) throw new Error('Total ukuran gambar chapter melebihi batas 28 MB.');

  const directory = chapterDirectory(storageKey, chapterNumber);
  await fs.mkdir(directory, {recursive: true});
  const pages = [];
  try {
    for (const [index, image] of images.entries()) {
      const filename = `${String(index + 1).padStart(3, '0')}${extensions[image.mimeType]}`;
      const filePath = path.join(directory, filename);
      await fs.writeFile(filePath, image.bytes, {flag: 'wx'});
      pages.push({page_number: index + 1, image_url: publicMediaUrl(filePath)});
    }
    return pages;
  } catch (error) {
    await Promise.all(pages.map(page => fs.rm(resolveMediaUrl(page.image_url), {force: true})));
    throw error.code === 'EEXIST' ? new Error('Berkas halaman chapter sudah ada. Hapus chapter lama sebelum mencoba ulang.') : error;
  }
}

async function renderPdfPages(pdfPath, storageKey, chapterNumber) {
  const directory = chapterDirectory(storageKey, chapterNumber);
  try {
    const oldPages = (await fs.readdir(directory)).filter(name => /^\d{3}\.jpg$/i.test(name));
    await Promise.all(oldPages.map(name => fs.rm(path.join(directory, name), {force: true})));
    const {stdout} = await execFileAsync('pdfinfo', [pdfPath], {windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000});
    const pageCount = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF tidak memiliki halaman yang dapat dibaca.');
    if (pageCount > MAX_RENDERED_PAGES) throw new Error(`PDF melebihi batas ${MAX_RENDERED_PAGES} halaman untuk reader gambar.`);

    const temporaryPrefix = path.join(directory, 'render-page');
    await execFileAsync('pdftoppm', [
      '-f', '1', '-l', String(pageCount), '-jpeg', '-jpegopt', 'quality=88',
      '-scale-to-x', '1440', '-scale-to-y', '-1', pdfPath, temporaryPrefix
    ], {windowsHide: true, timeout: 120_000, maxBuffer: 1_000_000});

    const rendered = (await fs.readdir(directory))
      .filter(name => /^render-page-\d+\.jpg$/i.test(name))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    if (rendered.length !== pageCount) throw new Error('Konversi PDF tidak menghasilkan semua halaman.');

    const pages = [];
    for (let index = 0; index < rendered.length; index++) {
      const filename = `${String(index + 1).padStart(3, '0')}.jpg`;
      const target = path.join(directory, filename);
      await fs.rename(path.join(directory, rendered[index]), target);
      pages.push({page_number: index + 1, image_url: publicMediaUrl(target)});
    }
    return pages;
  } catch (error) {
    const files = await fs.readdir(directory).catch(() => []);
    await Promise.all(files.filter(name => /^render-page-\d+\.jpg$/i.test(name) || /^\d{3}\.jpg$/i.test(name)).map(name => fs.rm(path.join(directory, name), {force: true})));
    throw error;
  }
}

async function migrateLegacyComicMedia(comic) {
  const chapters = comic.chapters || [];
  const hasLegacyUploads = comic.source === 'Unggah PDF'
    || String(comic.cover || '').startsWith('/media/uploads/')
    || chapters.some(chapter => String(chapter.fileUrl || chapter.pdfUrl || '').startsWith('/media/uploads/')
      || (chapter.pages || []).some(page => String(page).startsWith('/media/uploads/')));
  if (!hasLegacyUploads) return false;

  comic.storageKey = comicStorageKey(comic);
  let changed = true;
  if (String(comic.cover || '').startsWith('/media/uploads/')) {
    try {
      const source = resolveMediaUrl(comic.cover);
      const extension = path.extname(source).toLowerCase();
      const target = path.join(MEDIA_ROOT, comic.storageKey, `cover${extension}`);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.copyFile(source, target).catch(error => { if (error.code !== 'EEXIST') throw error; });
      comic.cover = publicMediaUrl(target);
    } catch {}
  }

  for (const chapter of chapters) {
    const chapterNumber = chapter.number ?? chapter.chapter_number;
    let pages = Array.isArray(chapter.pages) ? chapter.pages : [];
    const legacyFileUrl = chapter.fileUrl || chapter.pdfUrl;
    if (String(legacyFileUrl || '').startsWith('/media/uploads/')) {
      try {
        const source = resolveMediaUrl(legacyFileUrl);
        const directory = chapterDirectory(comic.storageKey, chapterNumber);
        const target = path.join(directory, 'original.pdf');
        await fs.mkdir(directory, {recursive: true});
        await fs.copyFile(source, target).catch(error => { if (error.code !== 'EEXIST') throw error; });
        chapter.fileUrl = publicMediaUrl(target);
      } catch {}
    }

    const legacyPages = pages.filter(page => typeof page === 'string' && page.startsWith('/media/uploads/'));
    if (legacyPages.length) {
      try {
        const directory = chapterDirectory(comic.storageKey, chapterNumber);
        await fs.mkdir(directory, {recursive: true});
        const movedPages = [];
        for (const [index, oldUrl] of pages.entries()) {
          if (typeof oldUrl !== 'string' || !oldUrl.startsWith('/media/uploads/')) {
            movedPages.push(oldUrl);
            continue;
          }
          const source = resolveMediaUrl(oldUrl);
          const target = path.join(directory, `${String(index + 1).padStart(3, '0')}.jpg`);
          await fs.copyFile(source, target).catch(error => { if (error.code !== 'EEXIST') throw error; });
          movedPages.push(publicMediaUrl(target));
        }
        chapter.pages = movedPages;
      } catch {}
    }

    if (chapter.pages?.length) {
      chapter.status = 'COMPLETED';
      chapter.errorMessage = null;
      chapter.pdfUrl = '';
    } else if (chapter.fileUrl && chapter.status !== 'COMPLETED') {
      chapter.status = 'QUEUED';
    }
    if (!chapter.fileUrl && String(chapter.pdfUrl || '').startsWith('/media/')) chapter.fileUrl = chapter.pdfUrl;
  }
  return changed;
}

async function removeComicStorage(storageKey) {
  if (!storageKey || !/^[a-z0-9-]{1,120}$/i.test(storageKey)) return;
  const directory = path.resolve(MEDIA_ROOT, storageKey);
  if (directory.startsWith(MEDIA_ROOT + path.sep)) await fs.rm(directory, {recursive: true, force: true});
}

async function removeChapterStorage(storageKey, chapterNumber) {
  const directory = chapterDirectory(storageKey, chapterNumber);
  if (directory.startsWith(MEDIA_ROOT + path.sep)) await fs.rm(directory, {recursive: true, force: true});
}

module.exports = {
  MEDIA_ROOT,
  comicStorageKey,
  chapterFolderName,
  publicMediaUrl,
  resolveMediaUrl,
  saveCover,
  saveChapterPdf,
  saveChapterImages,
  saveDownloadedChapterImages,
  renderPdfPages,
  migrateLegacyComicMedia,
  removeComicStorage,
  removeChapterStorage
};
