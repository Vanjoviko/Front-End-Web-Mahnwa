'use strict';
// SSRF guard tunggal untuk jalur scan-import (NFR-02). Menggantikan duplikasi guard lama HANYA untuk jalur baru;
// guard lama (safeUrl/privateIp/validatePublicUrl) tetap dipakai kode Kiryuu/feed yang tidak diubah.
const dns = require('node:dns/promises');
const net = require('node:net');

const MAX_URL_LENGTH = 2048;
const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'broadcasthost']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

class GuardError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// Notasi IPv4 ala inet_aton: "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.1".
function parseLooseIpv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || !parts.every(p => /^(0[xX][0-9a-fA-F]*|\d+)$/.test(p))) return null;
  const numbers = parts.map(p => {
    if (/^0[xX]/.test(p)) return BigInt('0x' + (p.slice(2) || '0'));
    if (p.length > 1 && p.startsWith('0')) return /^[0-7]+$/.test(p) ? BigInt('0o' + p) : -1n;
    return BigInt(p);
  });
  if (numbers.some(n => n < 0n)) return null;
  const head = numbers.slice(0, -1), last = numbers[numbers.length - 1];
  if (head.some(n => n > 255n) || last >= 256n ** BigInt(5 - numbers.length)) return null;
  let value = 0n;
  for (const n of head) value = (value << 8n) | n;
  value = (value << BigInt(8 * (5 - numbers.length))) | last;
  return [Number(value >> 24n) & 255, Number(value >> 16n) & 255, Number(value >> 8n) & 255, Number(value) & 255];
}

// IPv6 -> array 8 hextet (angka) atau null
function parseIpv6(text) {
  let s = text.toLowerCase().split('%')[0];
  if (!net.isIPv6(s)) return null;
  if (s.includes('.')) { // bagian IPv4 di ekor
    const idx = s.lastIndexOf(':');
    const v4 = s.slice(idx + 1).split('.').map(Number);
    s = s.slice(0, idx + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.length === 8 ? groups.map(g => parseInt(g, 16)) : null;
}

function ipv4Blocked([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function ipv6Blocked(g) {
  const v4 = x => [g[x] >> 8, g[x] & 255, g[x + 1] >> 8, g[x + 1] & 255];
  if (g.every(x => x === 0)) return true;                                     // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;           // ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return ipv4Blocked(v4(6)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every(x => x === 0)) return true;                           // ::a.b.c.d (IPv4-compatible, usang)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return ipv4Blocked(v4(6)); // NAT64
  if (g[0] === 0x2002) return ipv4Blocked([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                 // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                 // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true;                                 // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                         // dokumentasi
  return false;
}

function parseIpLiteral(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return {family: 4, parts: bare.split('.').map(Number)};
  const v6 = parseIpv6(bare);
  if (v6) return {family: 6, parts: v6};
  const loose = parseLooseIpv4(bare);
  return loose ? {family: 4, parts: loose} : null;
}

function isBlockedAddress(address) {
  const ip = parseIpLiteral(String(address));
  if (!ip) return true; // tidak dapat diparse: anggap tidak aman
  return ip.family === 4 ? ipv4Blocked(ip.parts) : ipv6Blocked(ip.parts);
}

// Validasi statis (tanpa DNS). Mengembalikan objek URL atau melempar GuardError(INVALID_URL | SSRF_BLOCKED).
function checkUrlStatic(raw, {allowDev = false, allowHttp = false} = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new GuardError('INVALID_URL', 'URL wajib diisi.');
  if (raw.length > MAX_URL_LENGTH) throw new GuardError('INVALID_URL', `URL terlalu panjang (maksimal ${MAX_URL_LENGTH} karakter).`);
  if (/[\u0000-\u0020\u007f]/.test(raw)) throw new GuardError('INVALID_URL', 'URL mengandung spasi atau karakter kontrol.');
  let url;
  try { url = new URL(raw); } catch { throw new GuardError('INVALID_URL', 'Format URL tidak valid.'); }
  const allowed = ['https:', ...(allowDev || allowHttp ? ['http:'] : []), ...(allowDev ? ['fixture:'] : [])];
  if (!allowed.includes(url.protocol)) throw new GuardError('INVALID_URL', allowDev || allowHttp ? 'URL harus memakai HTTP(S).' : 'URL harus memakai HTTPS.');
  if (url.username || url.password || /@/.test(url.host)) throw new GuardError('INVALID_URL', 'URL tidak boleh memuat nama pengguna atau kata sandi.');
  if (url.protocol === 'fixture:') return url;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new GuardError('INVALID_URL', 'URL tidak memiliki host.');
  if (allowDev) return url;
  const literal = parseIpLiteral(host);
  if (literal) {
    if (isBlockedAddress(host)) throw new GuardError('SSRF_BLOCKED', 'URL mengarah ke alamat jaringan privat atau terlarang.');
    return url;
  }
  if (/^\d+$|^0[xX][0-9a-fA-F]*$/.test(host.split('.').pop())) throw new GuardError('SSRF_BLOCKED', 'Alamat host tidak valid atau mengarah ke jaringan privat.');
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) throw new GuardError('SSRF_BLOCKED', 'URL mengarah ke host lokal atau internal.');
  return url;
}

// Validasi lengkap: statis + semua alamat hasil DNS harus publik (lookup dapat disuntikkan untuk tes).
async function assertPublicUrl(raw, {allowDev = false, allowHttp = false, lookup = (h) => dns.lookup(h, {all: true, verbatim: true})} = {}) {
  const url = checkUrlStatic(raw, {allowDev, allowHttp});
  if (allowDev || url.protocol === 'fixture:') return url;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (parseIpLiteral(host)) return url;
  let records;
  try { records = await lookup(host); } catch { throw new GuardError('INVALID_URL', 'Host sumber tidak dapat ditemukan.'); }
  if (!records.length || records.some(r => isBlockedAddress(r.address))) throw new GuardError('SSRF_BLOCKED', 'Host sumber di-resolve ke alamat jaringan privat.');
  return url;
}

module.exports = {GuardError, MAX_URL_LENGTH, parseIpLiteral, isBlockedAddress, checkUrlStatic, assertPublicUrl};
