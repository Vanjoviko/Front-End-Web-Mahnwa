'use strict';
// Tes unit penyimpanan komentar (lib/comment-store.js) — memakai db sementara, tanpa server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCommentStore, MAX_BODY} = require('../lib/comment-store');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akuma-cs-'));
  const store = createCommentStore(path.join(dir, 'comments.db'));
  const mk = (body, opts = {}) => {
    store.db.exec('DELETE FROM comment_rate'); // netralkan rate limit untuk pembuatan massal
    return store.create({targetId: 't', body, user: user('u1', 'Budi'), ...opts});
  };
  const setTime = (id, ms) => store.db.prepare('UPDATE comments SET created_at=? WHERE id=?').run(ms, id);
  return {store, dir, mk, setTime, done() { try { store.close(); } catch {} fs.rmSync(dir, {recursive: true, force: true}); }};
}
const user = (id, name, role = 'user') => ({id, name, role});

test('urutan baru/terlama/terpopuler + cursor tanpa duplikat', () => {
  const {store, mk, setTime, done} = fresh();
  try {
    const a = mk('A'), b = mk('B'), c = mk('C');
    setTime(a.id, 1000); setTime(b.id, 2000); setTime(c.id, 3000);
    assert.deepEqual(store.listMain({targetId: 't', sort: 'newest'}).comments.map(x => x.body), ['C', 'B', 'A']);
    assert.deepEqual(store.listMain({targetId: 't', sort: 'oldest'}).comments.map(x => x.body), ['A', 'B', 'C']);
    // popular: c paling banyak suka, a & b seri (diurut created_at DESC -> B lalu A)
    for (const id of [a.id, b.id, c.id]) store.setLike(id, user('u9', 'Z'), true);
    store.setLike(c.id, user('u8', 'Y'), true);
    assert.deepEqual(store.listMain({targetId: 't', sort: 'popular'}).comments.map(x => x.body), ['C', 'B', 'A']);
    // keyset: dua halaman tidak tumpang tindih
    const p1 = store.listMain({targetId: 't', sort: 'oldest', limit: 2});
    assert.equal(p1.comments.length, 2);
    assert.ok(p1.nextCursor);
    const p2 = store.listMain({targetId: 't', sort: 'oldest', limit: 2, cursor: p1.nextCursor});
    assert.deepEqual([...p1.comments, ...p2.comments].map(x => x.body), ['A', 'B', 'C']);
    assert.equal(p2.nextCursor, null);
  } finally { done(); }
});

test('balasan satu tingkat: balasan-dari-balasan menempel ke komentar utama', () => {
  const {store, mk, setTime, done} = fresh();
  try {
    const root = mk('root');
    const r1 = store.create({targetId: 't', parentId: root.id, body: 'r1', user: user('u2', 'Ani')});
    const r2 = store.create({targetId: 't', parentId: r1.id, body: 'r2', user: user('u3', 'Cici')});
    // created_at eksplisit agar urutan deterministik (id = UUID acak; ms bisa sama).
    setTime(root.id, 1000); setTime(r1.id, 2000); setTime(r2.id, 3000);
    assert.equal(r1.parentId, root.id);
    assert.equal(r2.parentId, root.id, 'balasan dari balasan tetap di bawah komentar utama');
    const replies = store.listReplies({parentId: root.id}).comments;
    assert.deepEqual(replies.map(x => x.body), ['r1', 'r2']);
    assert.equal(store.listMain({targetId: 't'}).comments[0].replyCount, 2);
  } finally { done(); }
});

test('soft delete: komentar utama berbalasan tetap tampil sebagai placeholder', () => {
  const {store, mk, done} = fresh();
  try {
    const root = mk('root', {user: user('owner', 'Pemilik')});
    store.create({targetId: 't', parentId: root.id, body: 'anak', user: user('u2', 'Ani')});
    store.softDelete(root.id, user('owner', 'Pemilik'));
    const row = store.listMain({targetId: 't'}).comments.find(x => x.id === root.id);
    assert.ok(row, 'komentar utama berbalasan masih tampil');
    assert.equal(row.isDeleted, true);
    assert.equal(row.body, '');
    assert.equal(row.user, null);
    assert.equal(row.replyCount, 1);
    assert.equal(store.totalCount('t'), 1, 'total hanya menghitung yang tidak dihapus (anak)');
  } finally { done(); }
});

test('hapus balasan menurunkan reply_count komentar utama', () => {
  const {store, mk, done} = fresh();
  try {
    const root = mk('root');
    const r1 = store.create({targetId: 't', parentId: root.id, body: 'r1', user: user('u2', 'Ani')});
    store.softDelete(r1.id, user('u2', 'Ani'));
    const row = store.listMain({targetId: 't'}).comments.find(x => x.id === root.id);
    assert.equal(row.replyCount, 0);
    assert.equal(store.listReplies({parentId: root.id}).comments.length, 0);
  } finally { done(); }
});

test('lapor: sekali per pengguna, auto-sembunyi pada 5 laporan', () => {
  const {store, mk, done} = fresh();
  try {
    const target = mk('spam');
    for (let i = 0; i < 5; i++) store.report(target.id, user('u' + i, 'U' + i), 'spam');
    assert.throws(() => store.report(target.id, user('u0', 'U0'), 'spam'), e => e.status === 409);
    assert.equal(store.listMain({targetId: 't'}).comments.find(x => x.id === target.id), undefined, 'tersembunyi setelah 5 laporan');
    assert.throws(() => store.report(target.id, user('u9', 'U9'), 'ngawur'), e => e.status === 400);
  } finally { done(); }
});

test('rate limit: jeda antar kiriman dan tolak teks sama berturut-turut', () => {
  const {store, done} = fresh();
  try {
    store.create({targetId: 't', body: 'pertama', user: user('r', 'R')});
    assert.throws(() => store.create({targetId: 't', body: 'kedua', user: user('r', 'R')}), e => e.status === 429);
    store.db.prepare('UPDATE comment_rate SET last_post_at=0 WHERE user_id=?').run('r');
    assert.throws(() => store.create({targetId: 't', body: 'pertama', user: user('r', 'R')}), e => e.status === 400);
  } finally { done(); }
});

test('validasi panjang teks', () => {
  const {store, done} = fresh();
  try {
    assert.throws(() => store.create({targetId: 't', body: '   ', user: user('v', 'V')}), e => e.status === 400);
    assert.throws(() => store.create({targetId: 't', body: 'a'.repeat(MAX_BODY + 1), user: user('v', 'V')}), e => e.status === 400);
  } finally { done(); }
});

test('otorisasi hapus: hanya pemilik atau admin', () => {
  const {store, mk, done} = fresh();
  try {
    const c = mk('milik', {user: user('owner', 'Pemilik')});
    assert.throws(() => store.softDelete(c.id, user('lain', 'Lain')), e => e.status === 403);
    assert.deepEqual(store.softDelete(c.id, user('owner', 'Pemilik')), {ok: true});
    const c2 = mk('admin-hapus', {user: user('owner', 'Pemilik')});
    assert.deepEqual(store.softDelete(c2.id, user('admin:admin', 'admin', 'admin')), {ok: true});
  } finally { done(); }
});

test('suka idempoten', () => {
  const {store, mk, done} = fresh();
  try {
    const c = mk('suka');
    assert.equal(store.setLike(c.id, user('u1', 'Budi'), true).likeCount, 1);
    assert.equal(store.setLike(c.id, user('u1', 'Budi'), true).likeCount, 1);
    assert.equal(store.setLike(c.id, user('u1', 'Budi'), false).likeCount, 0);
    assert.equal(store.setLike(c.id, user('u1', 'Budi'), false).likeCount, 0);
  } finally { done(); }
});

test('edit hanya penulis dalam batas waktu', () => {
  const {store, mk, done} = fresh();
  try {
    const c = mk('asli', {user: user('owner', 'Pemilik')});
    const updated = store.edit(c.id, user('owner', 'Pemilik'), 'diubah');
    assert.equal(updated.body, 'diubah');
    assert.ok(updated.editedAt);
    assert.throws(() => store.edit(c.id, user('lain', 'Lain'), 'x'), e => e.status === 403);
    store.db.prepare('UPDATE comments SET created_at=? WHERE id=?').run(Date.now() - 20 * 60_000, c.id);
    assert.throws(() => store.edit(c.id, user('owner', 'Pemilik'), 'x'), e => e.status === 403);
  } finally { done(); }
});
