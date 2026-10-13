'use strict';
// Penyimpanan komentar terpisah dari db.json (PRD "Fitur Komentar").
// SQLite (node:sqlite, modul bawaan Node) dengan mode WAL: tulis kecil O(log n), baca berindeks,
// counter denormal, keunikan lewat constraint. TIDAK ada data komentar yang masuk ke katalog,
// sehingga /api/catalog dan halaman judul tidak terpengaruh.
//
// Catatan: node:sqlite butuh Node >= 22.5. Semua operasi sinkron (DatabaseSync) sehingga tidak
// ada interleaving baca-tulis di dalam satu proses.
const {DatabaseSync} = require('node:sqlite');
const crypto = require('node:crypto');

const MAX_BODY = 1000;
const MIN_BODY = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RATE_GAP_MS = 15_000;         // jeda antar kiriman
const RATE_WINDOW_MS = 3_600_000;   // jendela 1 jam
const RATE_MAX = 30;                // maks kiriman per jam
const REPORT_HIDE = 5;              // laporan terbuka sebelum disembunyikan otomatis (P1)
const EDIT_WINDOW_MS = 15 * 60_000; // batas waktu edit (P1)
const REASONS = new Set(['spam', 'spoiler', 'abuse', 'other']);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clampLimit(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

const encodeCursor = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function createCommentStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS comments(
      id          TEXT PRIMARY KEY,
      target_type TEXT NOT NULL DEFAULT 'series' CHECK(target_type IN ('series','chapter')),
      target_id   TEXT NOT NULL,
      parent_id   TEXT REFERENCES comments(id) ON DELETE SET NULL,
      user_id     TEXT NOT NULL,
      user_name   TEXT NOT NULL,
      body        TEXT NOT NULL,
      is_spoiler  INTEGER NOT NULL DEFAULT 0 CHECK(is_spoiler IN (0,1)),
      like_count  INTEGER NOT NULL DEFAULT 0,
      reply_count INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      edited_at   INTEGER,
      deleted_at  INTEGER,
      hidden      INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_main_new ON comments(target_id, created_at DESC, id DESC) WHERE parent_id IS NULL;
    CREATE INDEX IF NOT EXISTS ix_main_old ON comments(target_id, created_at ASC,  id ASC)  WHERE parent_id IS NULL;
    CREATE INDEX IF NOT EXISTS ix_main_pop ON comments(target_id, like_count DESC, created_at DESC, id DESC) WHERE parent_id IS NULL;
    CREATE INDEX IF NOT EXISTS ix_replies  ON comments(parent_id, created_at ASC, id ASC) WHERE parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_target_alive ON comments(target_id, deleted_at);
    CREATE TABLE IF NOT EXISTS comment_likes(
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(comment_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_likes_user ON comment_likes(user_id, comment_id);
    CREATE TABLE IF NOT EXISTS comment_reports(
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      reason     TEXT NOT NULL CHECK(reason IN ('spam','spoiler','abuse','other')),
      status     TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','ignored','actioned')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(comment_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_reports_open ON comment_reports(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS comment_rate(
      user_id        TEXT PRIMARY KEY,
      last_post_at   INTEGER NOT NULL,
      window_start   INTEGER NOT NULL,
      window_count   INTEGER NOT NULL,
      last_body_hash TEXT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS comment_targets(
      target_id   TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    PRAGMA user_version=1;
  `);

  const stmtCache = new Map();
  const sql = text => { let s = stmtCache.get(text); if (!s) { s = db.prepare(text); stmtCache.set(text, s); } return s; };

  const q = {
    byId: sql('SELECT * FROM comments WHERE id=?'),
    insert: sql('INSERT INTO comments(id,target_type,target_id,parent_id,user_id,user_name,body,is_spoiler,created_at) VALUES(?,?,?,?,?,?,?,?,?)'),
    incReply: sql('UPDATE comments SET reply_count=reply_count+1 WHERE id=?'),
    decReply: sql('UPDATE comments SET reply_count=CASE WHEN reply_count>0 THEN reply_count-1 ELSE 0 END WHERE id=?'),
    bumpTarget: sql('INSERT INTO comment_targets(target_id,total_count) VALUES(?,1) ON CONFLICT(target_id) DO UPDATE SET total_count=total_count+1'),
    dropTarget: sql('UPDATE comment_targets SET total_count=CASE WHEN total_count>0 THEN total_count-1 ELSE 0 END WHERE target_id=?'),
    targetCount: sql('SELECT total_count AS n FROM comment_targets WHERE target_id=?'),
    softDelete: sql('UPDATE comments SET deleted_at=? WHERE id=?'),
    setEdited: sql('UPDATE comments SET body=?, edited_at=? WHERE id=?'),
    hide: sql('UPDATE comments SET hidden=1 WHERE id=?'),
    likeInsert: sql('INSERT INTO comment_likes(comment_id,user_id,created_at) VALUES(?,?,?) ON CONFLICT(comment_id,user_id) DO NOTHING'),
    likeDelete: sql('DELETE FROM comment_likes WHERE comment_id=? AND user_id=?'),
    likeBump: sql('UPDATE comments SET like_count=like_count+1 WHERE id=?'),
    likeDrop: sql('UPDATE comments SET like_count=CASE WHEN like_count>0 THEN like_count-1 ELSE 0 END WHERE id=?'),
    reportInsert: sql('INSERT INTO comment_reports(comment_id,user_id,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(comment_id,user_id) DO NOTHING'),
    reportCount: sql("SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id=? AND status='open'"),
    rateGet: sql('SELECT * FROM comment_rate WHERE user_id=?'),
    rateSet: sql('INSERT INTO comment_rate(user_id,last_post_at,window_start,window_count,last_body_hash) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_post_at=excluded.last_post_at,window_start=excluded.window_start,window_count=excluded.window_count,last_body_hash=excluded.last_body_hash'),
    reportsOpen: sql('SELECT r.comment_id AS commentId, c.target_id AS targetId, c.parent_id AS parentId, c.user_name AS userName, c.body AS body, COUNT(*) AS reports, MAX(r.created_at) AS lastAt FROM comment_reports r JOIN comments c ON c.id=r.comment_id WHERE r.status=\'open\' GROUP BY r.comment_id ORDER BY reports DESC, lastAt DESC LIMIT 200'),
    resolveReports: sql("UPDATE comment_reports SET status=? WHERE comment_id=? AND status='open'")
  };

  function runTx(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = work(); db.exec('COMMIT'); return out; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function totalCount(targetId) {
    const row = q.targetCount.get(targetId);
    return row ? row.n : 0;
  }

  function likedSet(rows, viewer) {
    if (!viewer || !rows.length) return new Set();
    const placeholders = rows.map(() => '?').join(',');
    const res = sql(`SELECT comment_id AS id FROM comment_likes WHERE user_id=? AND comment_id IN (${placeholders})`).all(viewer.id, ...rows.map(r => r.id));
    return new Set(res.map(r => r.id));
  }

  function project(row, viewer, liked) {
    const deleted = Boolean(row.deleted_at);
    const hidden = Boolean(row.hidden);
    const masked = deleted || hidden;
    return {
      id: row.id,
      parentId: row.parent_id || null,
      user: masked ? null : {id: row.user_id, name: row.user_name, avatar: null},
      body: masked ? '' : row.body,
      isSpoiler: Boolean(row.is_spoiler),
      isDeleted: deleted,
      isHidden: hidden,
      likeCount: row.like_count,
      replyCount: row.reply_count,
      likedByMe: liked ? liked.has(row.id) : false,
      canDelete: Boolean(viewer && (viewer.role === 'admin' || viewer.id === row.user_id)),
      canEdit: Boolean(viewer && !deleted && viewer.id === row.user_id && Date.now() - row.created_at <= EDIT_WINDOW_MS),
      createdAt: new Date(row.created_at).toISOString(),
      editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null
    };
  }

  function listMain({targetId, sort = 'newest', cursor = null, limit = DEFAULT_LIMIT, viewer = null}) {
    const lim = clampLimit(limit);
    const after = decodeCursor(cursor);
    const order = sort === 'oldest' ? 'created_at ASC, id ASC'
      : sort === 'popular' ? 'like_count DESC, created_at DESC, id DESC'
      : 'created_at DESC, id DESC';
    let where = 'target_id=? AND parent_id IS NULL AND hidden=0 AND (deleted_at IS NULL OR reply_count>0)';
    const params = [targetId];
    if (after) {
      if (sort === 'popular') { where += ' AND (like_count, created_at, id) < (?,?,?)'; params.push(after.l ?? 0, after.c, after.i); }
      else if (sort === 'oldest') { where += ' AND (created_at, id) > (?,?)'; params.push(after.c, after.i); }
      else { where += ' AND (created_at, id) < (?,?)'; params.push(after.c, after.i); }
    }
    params.push(lim + 1);
    const rows = sql(`SELECT * FROM comments WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...params);
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor(sort === 'popular' ? {l: last.like_count, c: last.created_at, i: last.id} : {c: last.created_at, i: last.id})
      : null;
    const liked = likedSet(page, viewer);
    return {comments: page.map(r => project(r, viewer, liked)), totalCount: totalCount(targetId), nextCursor};
  }

  function listReplies({parentId, cursor = null, limit = DEFAULT_LIMIT, viewer = null}) {
    const lim = clampLimit(limit);
    const after = decodeCursor(cursor);
    let where = 'parent_id=? AND deleted_at IS NULL AND hidden=0';
    const params = [parentId];
    if (after) { where += ' AND (created_at, id) > (?,?)'; params.push(after.c, after.i); }
    params.push(lim + 1);
    const rows = sql(`SELECT * FROM comments WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params);
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({c: last.created_at, i: last.id}) : null;
    const liked = likedSet(page, viewer);
    return {comments: page.map(r => project(r, viewer, liked)), nextCursor};
  }

  function rateGuard(userId, text, now) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const row = q.rateGet.get(userId);
    if (row) {
      if (now - row.last_post_at < RATE_GAP_MS) throw httpError(429, 'Terlalu cepat. Coba lagi sebentar.');
      const count = now - row.window_start < RATE_WINDOW_MS ? row.window_count : 0;
      if (count >= RATE_MAX) throw httpError(429, 'Terlalu cepat. Coba lagi sebentar.');
      if (row.last_body_hash === hash) throw httpError(400, 'Komentar yang sama persis tidak boleh dikirim berulang kali.');
    }
    return hash;
  }

  function rateCommit(userId, hash, now) {
    const row = q.rateGet.get(userId);
    const sameWindow = row && now - row.window_start < RATE_WINDOW_MS;
    const windowStart = sameWindow ? row.window_start : now;
    const windowCount = (sameWindow ? row.window_count : 0) + 1;
    q.rateSet.run(userId, now, windowStart, windowCount, hash);
  }

  function create({targetType = 'series', targetId, parentId = null, body, isSpoiler = false, user}) {
    if (!user) throw httpError(401, 'Silakan masuk terlebih dahulu.');
    const text = String(body ?? '').trim();
    if (text.length < MIN_BODY) throw httpError(400, 'Komentar tidak boleh kosong.');
    if (text.length > MAX_BODY) throw httpError(400, `Komentar maksimal ${MAX_BODY} karakter.`);
    let rootId = null;
    if (parentId) {
      const parent = q.byId.get(parentId);
      if (!parent || parent.target_id !== targetId) throw httpError(400, 'Komentar induk tidak ditemukan pada judul ini.');
      rootId = parent.parent_id || parent.id; // balasan selalu menempel ke komentar utama (satu tingkat)
      const root = rootId === parent.id ? parent : q.byId.get(rootId);
      if (!root || root.deleted_at || root.hidden) throw httpError(400, 'Komentar induk telah dihapus.');
    }
    const now = Date.now();
    const hash = rateGuard(user.id, text, now);
    const id = 'c_' + crypto.randomUUID();
    runTx(() => {
      q.insert.run(id, targetType, targetId, rootId, user.id, String(user.name).slice(0, 60), text, isSpoiler ? 1 : 0, now);
      if (rootId) q.incReply.run(rootId);
      q.bumpTarget.run(targetId);
      rateCommit(user.id, hash, now);
    });
    return project(q.byId.get(id), user, new Set());
  }

  function softDelete(id, viewer) {
    if (!viewer) throw httpError(401, 'Silakan masuk terlebih dahulu.');
    const row = q.byId.get(id);
    if (!row) throw httpError(404, 'Komentar tidak ditemukan.');
    if (viewer.role !== 'admin' && viewer.id !== row.user_id) throw httpError(403, 'Anda tidak boleh menghapus komentar ini.');
    if (row.deleted_at) return {ok: true};
    const now = Date.now();
    runTx(() => {
      q.softDelete.run(now, id);
      q.dropTarget.run(row.target_id);
      if (row.parent_id) q.decReply.run(row.parent_id);
    });
    return {ok: true};
  }

  function setLike(id, viewer, on) {
    if (!viewer) throw httpError(401, 'Silakan masuk terlebih dahulu.');
    const row = q.byId.get(id);
    if (!row || row.deleted_at || row.hidden) throw httpError(404, 'Komentar tidak ditemukan.');
    runTx(() => {
      if (on) { if (q.likeInsert.run(id, viewer.id, Date.now()).changes === 1) q.likeBump.run(id); }
      else if (q.likeDelete.run(id, viewer.id).changes === 1) q.likeDrop.run(id);
    });
    return {liked: Boolean(on), likeCount: q.byId.get(id).like_count};
  }

  function report(id, viewer, reason) {
    if (!viewer) throw httpError(401, 'Silakan masuk terlebih dahulu.');
    if (!REASONS.has(reason)) throw httpError(400, 'Alasan laporan tidak valid.');
    const row = q.byId.get(id);
    if (!row || row.deleted_at) throw httpError(404, 'Komentar tidak ditemukan.');
    const inserted = q.reportInsert.run(id, viewer.id, reason, Date.now());
    if (inserted.changes !== 1) throw httpError(409, 'Anda sudah melaporkan komentar ini.');
    const open = q.reportCount.get(id).n;
    if (open >= REPORT_HIDE) q.hide.run(id);
    return {ok: true, reports: open};
  }

  function edit(id, viewer, body) {
    if (!viewer) throw httpError(401, 'Silakan masuk terlebih dahulu.');
    const row = q.byId.get(id);
    if (!row || row.deleted_at) throw httpError(404, 'Komentar tidak ditemukan.');
    if (viewer.id !== row.user_id) throw httpError(403, 'Anda tidak boleh mengedit komentar ini.');
    if (Date.now() - row.created_at > EDIT_WINDOW_MS) throw httpError(403, 'Batas waktu edit sudah lewat.');
    const text = String(body ?? '').trim();
    if (text.length < MIN_BODY) throw httpError(400, 'Komentar tidak boleh kosong.');
    if (text.length > MAX_BODY) throw httpError(400, `Komentar maksimal ${MAX_BODY} karakter.`);
    q.setEdited.run(text, Date.now(), id);
    return project(q.byId.get(id), viewer, new Set());
  }

  function listReports() {
    return q.reportsOpen.all().map(row => ({
      commentId: row.commentId,
      targetId: row.targetId,
      parentId: row.parentId || null,
      userName: row.userName,
      body: row.body,
      reports: row.reports,
      lastAt: new Date(row.lastAt).toISOString()
    }));
  }

  function resolveReports(commentId, action) {
    if (!['ignore', 'delete'].includes(action)) throw httpError(400, 'Aksi tidak valid.');
    if (action === 'delete') {
      const row = q.byId.get(commentId);
      if (row && !row.deleted_at) {
        const now = Date.now();
        runTx(() => {
          q.softDelete.run(now, commentId);
          q.dropTarget.run(row.target_id);
          if (row.parent_id) q.decReply.run(row.parent_id);
        });
      }
    }
    q.resolveReports.run(action === 'delete' ? 'actioned' : 'ignored', commentId);
    return {ok: true};
  }

  function stats() {
    const row = sql('SELECT (SELECT COUNT(*) FROM comments) c, (SELECT COUNT(*) FROM comment_likes) l').get();
    return {comments: row.c, likes: row.l};
  }

  return {db, listMain, listReplies, create, softDelete, setLike, report, edit, listReports, resolveReports, totalCount, stats, close: () => db.close()};
}

module.exports = {createCommentStore, MAX_BODY, REPORT_HIDE};
