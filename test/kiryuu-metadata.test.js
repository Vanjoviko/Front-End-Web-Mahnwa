'use strict';
// Tes unit pengurai metadata halaman seri Kiryuu (konektor "Kiryuu"), termasuk tipe komik.
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseKiryuuMetadata} = require('../lib/kiryuu-metadata');

const URL = 'https://v7.kiryuu.to/manga/magic-emperor/';

// Blok info nyata Kiryuu: <h4>…Type…</h4> + <div class="inline">…nilai…</div>.
const typeRow = (label, icon = 'manhua') => `
<div class="flex sm:justify-between justify-start items-center gap-2">
  <h4 class="font-semibold text-base text-gray-100 flex items-center justify-start">
    <span data-lucide="type-outline" class="mx-1 inline-block w-6 h-6"></span>
    <span class="font-semibold">Type</span>
  </h4>
  <div class="inline">
    ${icon ? `<img src="https://v7.kiryuu.to/wp-content/themes/kiryuu/static/svg/${icon}.svg" width="24" height="24" alt="">` : ''}
    <p class="font-normal text-sm inline ml-1">${label}</p>
  </div>
</div>`;

const page = ({title = 'Baca Magic Emperor Bahasa Indonesia - Kiryuu ID', extra = ''} = {}) => `
<html><head>
  <meta property="og:title" content="${title}">
  <meta name="description" content="Sinopsis uji dari halaman seri.">
</head><body>
  <a href="https://v7.kiryuu.to/genre/action/">Action</a>
  <a href="https://v7.kiryuu.to/genre/fantasy/">Fantasy</a>
  8.4 ratings released 2019 completed
  ${extra}
</body></html>`;

test('tipe diambil dari baris info, bukan diasumsikan Manhwa', () => {
  const item = parseKiryuuMetadata(page({extra: typeRow('Manhua')}), URL);
  assert.equal(item.type, 'Manhua');
});

test('pemetaan Manhwa/Manhua/Manga tidak peduli kapitalisasi', () => {
  assert.equal(parseKiryuuMetadata(page({extra: typeRow('manhwa')}), URL).type, 'Manhwa');
  assert.equal(parseKiryuuMetadata(page({extra: typeRow('MANHUA')}), URL).type, 'Manhua');
  assert.equal(parseKiryuuMetadata(page({extra: typeRow('Manga')}), URL).type, 'Manga');
});

test('fallback nama ikon svg saat label tidak terbaca', () => {
  const svgOnly = `<img src="https://v7.kiryuu.to/wp-content/themes/kiryuu/static/svg/manhua.svg" alt="">`;
  assert.equal(parseKiryuuMetadata(page({extra: svgOnly}), URL).type, 'Manhua');
});

test('tipe tak dikenali -> ikon svg bila ada, selain itu bawaan Manhwa', () => {
  // label tak dikenal + ikon jelas -> pakai ikon
  assert.equal(parseKiryuuMetadata(page({extra: typeRow('Webtoon', 'manhwa')}), URL).type, 'Manhwa');
  // label tak dikenal tanpa ikon -> bawaan
  assert.equal(parseKiryuuMetadata(page({extra: typeRow('Webtoon', null)}), URL).type, 'Manhwa');
  // tidak ada blok tipe sama sekali -> bawaan
  assert.equal(parseKiryuuMetadata(page(), URL).type, 'Manhwa');
});

test('metadata lain tetap utuh: judul, id, genre, status, rating, tahun', () => {
  const item = parseKiryuuMetadata(page({extra: typeRow('Manhua')}), URL);
  assert.equal(item.title, 'Magic Emperor');
  assert.equal(item.id, 'kiryuu-magic-emperor');
  assert.deepEqual(item.genres, ['Action', 'Fantasy']);
  assert.equal(item.status, 'Tamat');
  assert.equal(item.rating, 8.4);
  assert.equal(item.year, 2019);
  assert.equal(item.source, 'Kiryuu ID');
  assert.equal(item.externalContent, true);
});

test('URL bukan halaman seri Kiryuu -> error', () => {
  assert.throws(() => parseKiryuuMetadata(page(), 'https://v7.kiryuu.to/chapter-1/'), /halaman seri Kiryuu publik/);
});
