'use strict';
// Pengurai metadata halaman seri Kiryuu (mode metadata-saja) untuk konektor "Kiryuu".
// Murni fungsi atas HTML yang sudah diambil pemanggil: tidak ada request keluar di sini
// dan tidak pernah mengambil gambar/chapter.

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

const TYPES = {manhwa: 'Manhwa', manhua: 'Manhua', manga: 'Manga'};

// Tipe komik dari baris info `<h4>…Type…</h4> + <div class="inline">…Manhua…</div>`,
// dengan fallback nama ikon svg (…/static/svg/manhua.svg). None bila tak dikenali.
function parseType(html, getText) {
  const block = html.match(/>\s*Type\s*<\/span>[\s\S]{0,600}?<div[^>]*class=["'][^"']*\binline\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const label = block ? getText(block[1]).trim().toLowerCase() : '';
  if (TYPES[label]) return TYPES[label];
  const svg = html.match(/static\/svg\/(manhwa|manhua|manga)\.svg/i);
  return svg ? TYPES[svg[1].toLowerCase()] : null;
}

function parseKiryuuMetadata(html, pageUrl) {
  const attr = (s, n) => { const m = s.match(new RegExp(`\\b${n}\\s*=\\s*(["'])(.*?)\\1`, 'i')); return m ? decodeEntities(m[2]) : ''; };
  const meta = {};
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) { const name = (attr(m[1], 'property') || attr(m[1], 'name')).toLowerCase(); if (name) meta[name] = attr(m[1], 'content'); }
  const getText = s => decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  let title = meta['og:title'] || '';
  if (!title) { const h = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i); title = h ? getText(h[1]) : ''; }
  title = title.replace(/^Baca\s+/i, '').replace(/\s+Bahasa Indonesia.*$/i, '').replace(/\s*[|–-]\s*Kiryuu.*$/i, '').trim().slice(0, 140);
  const synopsis = (meta.description || meta['og:description'] || '').slice(0, 900);
  const plain = getText(html).toLowerCase();
  const genres = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) { const href = attr(m[1], 'href'); if (/\/genre\//i.test(href)) { const g = getText(m[2]); if (g && !genres.includes(g)) genres.push(g); } }
  if (!title || !/^https:\/\/(?:www\.)?v7\.kiryuu\.to\/manga\//i.test(pageUrl)) throw Error('Halaman tidak dikenali sebagai halaman seri Kiryuu publik.');

  const ratingMatch = plain.match(/([0-9]+(?:\.[0-9]+)?)\s*ratings?/i);
  const yearMatch = plain.match(/\breleased\s+(20\d{2})\b/i);
  const status = /\b(completed|complete|tamat)\b/i.test(plain) ? 'Tamat' : /\b(hiatus|on hold)\b/i.test(plain) ? 'Hiatus' : 'Berjalan';
  const type = parseType(html, getText) || 'Manhwa';
  return {id: 'kiryuu-' + pageUrl.match(/\/manga\/([^/]+)/i)[1].toLowerCase().replace(/[^a-z0-9-]/g, '-'), title, type, status, genres: genres.slice(0, 8), rating: ratingMatch ? Number(ratingMatch[1]) : null, year: yearMatch ? Number(yearMatch[1]) : null, author: '', synopsis: synopsis || 'Sinopsis tersedia di halaman seri sumber.', cover: '', source: 'Kiryuu ID', sourceUrl: pageUrl, externalContent: true, chapters: []};
}

module.exports = {parseKiryuuMetadata};
