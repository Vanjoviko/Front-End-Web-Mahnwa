'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertPublicUrl, checkUrlStatic, isBlockedAddress, GuardError} = require('../lib/net-guard');

// Tabel penolakan NFR-02 — tanpa koneksi keluar (DNS disuntik).
const noDns = async () => { throw new Error('DNS tidak boleh dipanggil'); };
const BLOCKED = [
  'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/',
  'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::ffff:10.0.0.1]/',
  'http://2130706433/', 'http://0x7f.0.0.1/', 'http://localhost./', 'http://localhost/', 'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/',
  'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://224.0.0.1/', 'http://240.0.0.1/'
];

for (const url of BLOCKED) {
  test(`menolak ${url} (allowHttp agar yang diuji aturan SSRF, bukan skema)`, async () => {
    await assert.rejects(assertPublicUrl(url, {allowHttp: true, lookup: noDns}), e => e instanceof GuardError && ['SSRF_BLOCKED', 'INVALID_URL'].includes(e.code));
  });
  test(`menolak ${url} pada mode ketat (https saja)`, async () => {
    await assert.rejects(assertPublicUrl(url, {lookup: noDns}), e => e instanceof GuardError);
  });
}
test('IP privat memberi kode SSRF_BLOCKED', async () => {
  for (const url of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/x', 'http://[::ffff:10.0.0.1]/', 'http://2130706433/'])
    await assert.rejects(assertPublicUrl(url, {allowHttp: true, lookup: noDns}), e => e.code === 'SSRF_BLOCKED', url);
});
test('https ke IP privat juga ditolak', async () => {
  await assert.rejects(assertPublicUrl('https://192.168.1.1/x', {lookup: noDns}), e => e.code === 'SSRF_BLOCKED');
});
test('skema non-http(s) dan userinfo ditolak', async () => {
  for (const url of ['ftp://example.org/x', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@example.org/', 'fixture://menara', 'not a url', '']) {
    await assert.rejects(assertPublicUrl(url, {lookup: noDns}), e => e instanceof GuardError, url);
  }
});
test('hostname publik yang di-resolve ke IP privat ditolak', async () => {
  const lookup = async () => [{address: '10.1.2.3', family: 4}];
  await assert.rejects(assertPublicUrl('https://rebind.example.org/x', {lookup}), e => e.code === 'SSRF_BLOCKED');
  const mixed = async () => [{address: '93.184.216.34', family: 4}, {address: '127.0.0.1', family: 4}];
  await assert.rejects(assertPublicUrl('https://mixed.example.org/x', {lookup: mixed}), e => e.code === 'SSRF_BLOCKED');
});
test('hostname publik dengan IP publik diterima', async () => {
  const lookup = async () => [{address: '93.184.216.34', family: 4}];
  const url = await assertPublicUrl('https://sumber.example.org/seri/manifest.json', {lookup});
  assert.equal(url.hostname, 'sumber.example.org');
});
test('DNS gagal -> galat terklasifikasi (bukan lolos)', async () => {
  await assert.rejects(assertPublicUrl('https://nx.example.org/', {lookup: async () => { throw new Error('ENOTFOUND'); }}), e => e instanceof GuardError);
});
test('mode dev mengizinkan http/loopback tanpa DNS', async () => {
  const url = await assertPublicUrl('http://127.0.0.1:9100/menara-biru/manifest.json', {allowDev: true, lookup: noDns});
  assert.equal(url.port, '9100');
});
test('isBlockedAddress: rentang penting', () => {
  for (const ip of ['127.0.0.1', '10.255.255.255', '172.31.0.1', '192.168.0.1', '169.254.1.1', '100.127.0.1', '0.1.2.3', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:192.168.0.1', '64:ff9b::7f00:1', '2002:7f00:1::'])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8'])
    assert.equal(isBlockedAddress(ip), false, ip);
});
test('checkUrlStatic membatasi panjang URL', () => {
  assert.throws(() => checkUrlStatic('https://example.org/' + 'a'.repeat(3000)), e => e.code === 'INVALID_URL');
});
