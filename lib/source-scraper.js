'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');

const USER_AGENT = 'LembarChapterImporter/1.0';
const MAX_HTML_BYTES = 3_000_000;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_TOTAL_BYTES = 28_000_000;
const MAX_PAGES = 80;
const robotsCache = new Map();
const lastRequestByOrigin = new Map();

class SourceAccessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SourceAccessError';
    this.accessRestricted = true;
    this.retryAfter = options.retryAfter || null;
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    return address.startsWith('10.') || address.startsWith('127.') || address.startsWith('169.254.') ||
      address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address === '0.0.0.0';
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('::ffff:127.');
  }
  return true;
}

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL sumber tidak valid.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Sumber harus memakai URL HTTPS publik.');
  if (net.isIP(url.hostname)) {
    if (isPrivateAddress(url.hostname)) throw new Error('URL sumber mengarah ke jaringan privat.');
    return url;
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('URL sumber mengarah ke host lokal.');
  }
  let addresses;
  try { addresses = await dns.lookup(url.hostname, {all: true, verbatim: true}); }
  catch { throw new Error('Host sumber tidak dapat ditemukan.'); }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('Host sumber tidak diizinkan karena mengarah ke jaringan privat.');
  }
  return url;
}

function retryAfterHeader(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return `${Math.max(0, seconds)} detik`;
  const date = Date.parse(value);
  return Number.isNaN(date) ? value : new Date(date).toISOString();
}

function parseRobots(text) {
  const groups = [];
  let group = null;
  let hasDirectives = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (hasDirectives && group) { groups.push(group); group = null; hasDirectives = false; }
      if (!group) group = {agents: [], rules: [], delay: 0};
      group.agents.push(value.toLowerCase());
      continue;
    }
    if (!group) continue;
    hasDirectives = true;
    if (key === 'allow' || key === 'disallow') {
      if (value) group.rules.push({type: key, value});
    } else if (key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) group.delay = Math.max(group.delay, delay);
    }
  }
  if (group) groups.push(group);
  return groups;
}

function robotsDecision(groups, url) {
  const agent = USER_AGENT.toLowerCase();
  const specific = groups.filter(group => group.agents.some(value => value !== '*' && agent.includes(value)));
  const selected = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  if (!selected.length) return {allowed: true, delay: 1.2};
  const rules = selected.flatMap(group => group.rules);
  const path = `${url.pathname}${url.search}`;
  const matched = rules.filter(rule => path.startsWith(rule.value.replace(/\*.*$/, '')));
  matched.sort((a, b) => b.value.replace(/[\*$]/g, '').length - a.value.replace(/[\*$]/g, '').length);
  const winner = matched[0];
  const delay = Math.max(1.2, ...selected.map(group => group.delay));
  return {allowed: !winner || winner.type === 'allow', delay};
}

async function waitForRateLimit(origin, delay) {
  const previous = lastRequestByOrigin.get(origin) || 0;
  const remaining = previous + delay * 1000 - Date.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  lastRequestByOrigin.set(origin, Date.now());
}

async function robotsRules(url) {
  if (robotsCache.has(url.origin)) return robotsCache.get(url.origin);
  const robotsUrl = new URL('/robots.txt', url.origin);
  await validatePublicUrl(robotsUrl.href);
  await waitForRateLimit(url.origin, 1.2);
  let response;
  try {
    response = await fetch(robotsUrl, {
      headers: {'user-agent': USER_AGENT, accept: 'text/plain'},
      signal: AbortSignal.timeout(12000), redirect: 'error'
    });
  } catch {
    throw new SourceAccessError(`Tidak dapat memeriksa robots.txt pada ${url.hostname}; sumber tidak diakses.`);
  }
  if (response.status === 404 || response.status === 410) {
    const empty = {groups: [], missing: true};
    robotsCache.set(url.origin, empty);
    return empty;
  }
  if ([401, 403, 407, 429, 451].includes(response.status)) {
    throw new SourceAccessError(`robots.txt membatasi akses (HTTP ${response.status}).`, {retryAfter: retryAfterHeader(response)});
  }
  if (!response.ok) throw new SourceAccessError(`robots.txt gagal diperiksa (HTTP ${response.status}); sinkronisasi dihentikan.`);
  const rules = {groups: parseRobots((await response.text()).slice(0, 200_000)), missing: false};
  robotsCache.set(url.origin, rules);
  return rules;
}

async function assertAllowedByRobots(url) {
  const rules = await robotsRules(url);
  if (rules.missing) return 1.2;
  const decision = robotsDecision(rules.groups, url);
  if (!decision.allowed) throw new SourceAccessError(`robots.txt melarang akses ke ${url.pathname}.`);
  return decision.delay;
}

function decodeHtml(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function parseChapterNumber(value) {
  const match = String(value || '').match(/chapter[-\s]*(\d+(?:\.\d+)?)/i) || String(value || '').match(/(?:^|\D)(\d+(?:\.\d+)?)(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function extractChapterLinks(html, seriesUrl) {
  const result = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = htmlAttribute(match[1], 'href');
    if (!href || !/chapter[-/]/i.test(href)) continue;
    const visibleText = decodeHtml(match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    const number = parseChapterNumber(visibleText) ?? parseChapterNumber(href.replace(/chapter[-/](\d+)\.\d{5,}/i, 'chapter-$1'));
    if (number === null) continue;
    let chapterUrl;
    try { chapterUrl = new URL(href, seriesUrl).href; } catch { continue; }
    result.set(`${number}:${chapterUrl}`, {chapter_number: number, title: visibleText, source_url: chapterUrl});
  }
  return [...result.values()];
}

function isChallengePage(html) {
  return /captcha|verify you are human|access denied|cloudflare|checking your browser|security challenge/i.test(html);
}

async function getHtml(url) {
  const delay = await assertAllowedByRobots(url);
  await waitForRateLimit(url.origin, delay);
  let response;
  try {
    response = await fetch(url, {
      headers: {'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml'},
      signal: AbortSignal.timeout(20000), redirect: 'error'
    });
  } catch (error) {
    throw new Error(`Halaman sumber tidak dapat diakses: ${error.message}`);
  }
  if ([401, 403, 407, 429, 451].includes(response.status)) {
    throw new SourceAccessError(`Sumber membatasi akses (HTTP ${response.status}).`, {retryAfter: retryAfterHeader(response)});
  }
  if (!response.ok) throw new Error(`Halaman sumber merespons HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) throw new Error('Respons URL bukan halaman HTML.');
  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('Halaman sumber melebihi batas 3 MB.');
  if (isChallengePage(html)) throw new SourceAccessError('Sumber menampilkan CAPTCHA atau halaman anti-bot. Sinkronisasi dihentikan.');
  return html;
}

function extractImageUrls(html, chapterUrl) {
  const preferred = [];
  const fallback = [];
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1];
    const label = `${htmlAttribute(attrs, 'class')} ${htmlAttribute(attrs, 'alt')} ${htmlAttribute(attrs, 'title')}`.toLowerCase();
    if (/banner|advert|\bad\b|logo|avatar|icon|sprite|placeholder|loading/.test(label)) continue;
    const src = htmlAttribute(attrs, 'data-src') || htmlAttribute(attrs, 'data-lazy-src') ||
      htmlAttribute(attrs, 'data-original') || htmlAttribute(attrs, 'src');
    if (!src || src.startsWith('data:')) continue;
    let imageUrl;
    try { imageUrl = new URL(src, chapterUrl); } catch { continue; }
    if (imageUrl.protocol !== 'https:') continue;
    if (/banner|advert|\/ads?\/|logo|avatar|icon|sprite|placeholder|loading/i.test(`${imageUrl.pathname} ${imageUrl.hostname}`)) continue;
    const preferredImage = /chapter|reader|page|image/i.test(label);
    (preferredImage ? preferred : fallback).push(imageUrl.href);
  }
  const unique = [...new Set(preferred.length ? preferred : fallback)];
  return unique.slice(0, MAX_PAGES);
}

function imageFormat(bytes, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) return type;
  if (type === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return type;
  if (type === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return type;
  throw new Error('Respons sumber bukan gambar JPEG, PNG, atau WebP yang valid.');
}

async function downloadImage(imageUrl) {
  const url = await validatePublicUrl(imageUrl);
  const delay = await assertAllowedByRobots(url);
  await waitForRateLimit(url.origin, delay);
  let response;
  try {
    response = await fetch(url, {
      headers: {'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg'},
      signal: AbortSignal.timeout(20000), redirect: 'error'
    });
  } catch (error) {
    throw new Error(`Gambar sumber tidak dapat diakses: ${error.message}`);
  }
  if ([401, 403, 407, 429, 451].includes(response.status)) {
    throw new SourceAccessError(`Host gambar membatasi akses (HTTP ${response.status}).`, {retryAfter: retryAfterHeader(response)});
  }
  if (!response.ok) throw new Error(`Gambar sumber merespons HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error('Satu gambar melebihi batas 5 MB.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Satu gambar kosong atau melebihi batas 5 MB.');
  return {bytes, mimeType: imageFormat(bytes, response.headers.get('content-type'))};
}

async function importChapterFromSeries(seriesUrl, chapterNumber) {
  const series = await validatePublicUrl(seriesUrl);
  if (series.hostname !== 'v7.kiryuu.to' || !series.pathname.startsWith('/manga/') || /\/chapter-/i.test(series.pathname)) {
    throw new Error('URL harus berupa halaman seri publik Kiryuu di v7.kiryuu.to/manga/…');
  }
  const seriesHtml = await getHtml(series);
  const chapters = extractChapterLinks(seriesHtml, series.href);
  const selected = chapters.find(chapter => chapter.chapter_number === Number(chapterNumber));
  if (!selected) throw new Error(`Chapter ${chapterNumber} tidak ditemukan pada halaman seri.`);

  const chapterUrl = await validatePublicUrl(selected.source_url);
  if (chapterUrl.hostname !== series.hostname) throw new Error('Tautan chapter keluar dari host seri; impor dihentikan.');
  const chapterHtml = await getHtml(chapterUrl);
  const imageUrls = extractImageUrls(chapterHtml, chapterUrl.href);
  if (!imageUrls.length) throw new Error('Gambar halaman tidak ditemukan pada HTML. Tidak akan mencoba browser otomatis.');

  const images = [];
  let totalBytes = 0;
  for (const imageUrl of imageUrls) {
    const image = await downloadImage(imageUrl);
    totalBytes += image.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Total ukuran gambar chapter melebihi batas 28 MB.');
    images.push(image);
  }
  return {chapter: selected, images};
}

module.exports = {SourceAccessError, importChapterFromSeries, extractChapterLinks, extractImageUrls};
