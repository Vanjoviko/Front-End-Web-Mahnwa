'use strict';
// UI komentar untuk halaman detail judul (PRD "Fitur Komentar").
// Modul ini tidak menyentuh katalog: komentar diambil dari /api/comments setelah halaman dirender,
// dan pada P1 baru dimuat saat pengguna mendekati bagian komentar (F27), sehingga halaman judul
// tetap cepat walau jumlah komentar besar.
(function () {
  let deps = null;
  const S = {
    container: null,
    comicId: null,
    run: 0,
    started: false,
    observer: null,
    auth: null,
    sort: 'newest',
    comments: [],
    nextCursor: null,
    totalCount: 0,
    loading: false,
    error: null,
    replies: new Map(),
    revealed: new Set(),
    menuId: null,
    replyTo: null,
    editId: null
  };

  const REASONS = [
    {key: 'spam', label: 'Spam'},
    {key: 'spoiler', label: 'Spoiler tanpa tanda'},
    {key: 'abuse', label: 'Kasar atau pelecehan'},
    {key: 'other', label: 'Lainnya'}
  ];

  const esc = v => (deps ? deps.esc(v) : String(v ?? ''));
  const api = (path, opts) => deps.api(path, opts);
  const toast = msg => deps.toast(msg);
  const relTime = iso => deps.relTime(iso);
  const $ = (sel, root) => (root || document).querySelector(sel);

  function init(injected) { deps = injected; }

  function avatarLetter(name) {
    const n = String(name || '?').trim();
    return n ? n[0].toUpperCase() : '?';
  }

  function stop() {
    S.run++;
    if (S.observer) { try { S.observer.disconnect(); } catch {} S.observer = null; }
    S.container = null;
    S.comicId = null;
    S.started = false;
    S.comments = [];
    S.nextCursor = null;
    S.replies = new Map();
    S.revealed = new Set();
    S.menuId = null;
    S.replyTo = null;
    S.editId = null;
    S.error = null;
    S.loading = false;
  }

  function requireLogin() {
    try { sessionStorage.setItem('akuma-login-next', location.hash); } catch {}
    location.hash = 'login';
  }

  async function getAuth() {
    try { S.auth = await api('/api/auth/me'); }
    catch { S.auth = {authenticated: false}; }
    return S.auth;
  }

  function mount({comicId}) {
    const container = document.getElementById('comments');
    if (!container || !comicId) return;
    stop();
    S.container = container;
    S.comicId = comicId;
    const run = S.run;
    container.innerHTML = shell();
    bindOnce();
    const start = async () => {
      if (run !== S.run || S.started) return;
      S.started = true;
      await getAuth();
      if (run !== S.run) return;
      $('#comment-write', container).innerHTML = writeBox();
      wireWrite();
      await loadFirst(run);
    };
    // F27: muat hanya saat kolom komentar mendekati viewport.
    if (typeof IntersectionObserver === 'function') {
      S.observer = new IntersectionObserver(entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        if (S.observer) { S.observer.disconnect(); S.observer = null; }
        start();
      }, {rootMargin: '300px 0px'});
      S.observer.observe(container);
    } else {
      start();
    }
  }

  function shell() {
    return `<div class="comments-inner">
      <div class="section-heading"><div><h2>Komentar</h2><p>Bagikan pendapatmu dengan pembaca lain.</p></div></div>
      <div id="comment-write"><div class="c-write c-loading">Memuat komentar…</div></div>
      <div class="c-list-head">
        <div id="comment-count" class="c-count">Memuat komentar…</div>
        <div class="c-sort" role="group" aria-label="Urutkan komentar">
          <button type="button" class="c-sort-btn" data-act="sort" data-sort="newest" aria-pressed="true">Terbaru</button>
          <button type="button" class="c-sort-btn" data-act="sort" data-sort="oldest" aria-pressed="false">Terlama</button>
          <button type="button" class="c-sort-btn" data-act="sort" data-sort="popular" aria-pressed="false">Terpopuler</button>
        </div>
      </div>
      <div id="comment-list" class="c-list" aria-live="polite"></div>
      <div id="comment-more" class="c-more"></div>
    </div>`;
  }

  function writeBox() {
    if (!S.auth || !S.auth.authenticated) {
      return `<div class="c-write c-prompt"><p>Masuk untuk ikut berkomentar.</p><button type="button" class="btn" data-act="login">Masuk</button></div>`;
    }
    return `<form class="c-write" id="comment-form" novalidate>
      <label class="sr-only" for="comment-input">Tulis komentar</label>
      <textarea id="comment-input" rows="3" placeholder="Tulis komentar" required></textarea>
      <div class="c-write-foot">
        <label class="c-spoiler-toggle"><input type="checkbox" id="comment-spoiler"> Tandai sebagai spoiler</label>
        <span class="c-counter" id="comment-counter">0/1000</span>
        <button class="btn" type="submit" id="comment-submit" disabled>Kirim</button>
      </div>
      <p class="form-error" id="comment-error" role="alert"></p>
    </form>`;
  }

  function wireWrite() {
    const form = $('#comment-form', S.container);
    if (!form) return;
    const input = $('#comment-input', form), counter = $('#comment-counter', form), submit = $('#comment-submit', form);
    const update = () => {
      const len = input.value.trim().length;
      counter.textContent = `${len}/1000`;
      counter.classList.toggle('over', len > 1000);
      submit.disabled = len < 1 || len > 1000;
    };
    input.addEventListener('input', update);
    update();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const error = $('#comment-error', form);
      const body = input.value.trim();
      if (body.length < 1 || body.length > 1000) { error.textContent = 'Komentar harus 1–1000 karakter.'; return; }
      submit.disabled = true;
      error.textContent = '';
      try {
        const res = await api('/api/comments', {method: 'POST', body: JSON.stringify({targetId: S.comicId, targetType: 'series', body, isSpoiler: $('#comment-spoiler', form).checked})});
        input.value = '';
        update();
        // F10: langsung tampil di paling atas, apa pun urutan aktif.
        S.comments = [res.comment, ...S.comments];
        S.totalCount += 1;
        renderCount();
        renderList();
        toast('Komentar terkirim.');
      } catch (err) {
        error.textContent = err.message; // F11: teks tetap ada
      } finally {
        submit.disabled = false;
        update();
      }
    });
  }

  async function loadFirst(run, {keep = false} = {}) {
    if (run !== S.run) return;
    S.loading = true;
    S.error = null;
    if (!keep) { S.comments = []; renderList(); }
    try {
      const data = await api(`/api/comments?targetId=${encodeURIComponent(S.comicId)}&sort=${S.sort}&limit=10`);
      if (run !== S.run) return;
      S.comments = data.comments || [];
      S.nextCursor = data.nextCursor || null;
      S.totalCount = data.totalCount || 0;
    } catch (err) {
      if (run !== S.run) return;
      S.error = true;
    } finally {
      if (run !== S.run) return;
      S.loading = false;
      renderCount();
      renderList();
      renderMore();
    }
  }

  async function loadMore() {
    if (S.loading || !S.nextCursor) return;
    const run = S.run;
    S.loading = true;
    renderMore();
    try {
      const data = await api(`/api/comments?targetId=${encodeURIComponent(S.comicId)}&sort=${S.sort}&limit=10&cursor=${encodeURIComponent(S.nextCursor)}`);
      if (run !== S.run) return;
      S.comments = S.comments.concat(data.comments || []);
      S.nextCursor = data.nextCursor || null;
      S.totalCount = data.totalCount || S.totalCount;
    } catch (err) {
      if (run !== S.run) return;
      toast(err.message);
    } finally {
      if (run !== S.run) return;
      S.loading = false;
      renderCount();
      renderList();
      renderMore();
    }
  }

  async function loadReplies(id) {
    const run = S.run;
    const st = S.replies.get(id) || {items: [], nextCursor: null, open: false, loading: false};
    if (st.open) { st.open = false; S.replies.set(id, st); renderList(); return; }
    st.open = true;
    st.loading = true;
    S.replies.set(id, st);
    renderList();
    try {
      const data = await api(`/api/comments/${encodeURIComponent(id)}/replies?limit=10`);
      if (run !== S.run) return;
      st.items = data.comments || [];
      st.nextCursor = data.nextCursor || null;
    } catch (err) {
      if (run !== S.run) return;
      toast(err.message);
      st.open = false;
    } finally {
      if (run !== S.run) return;
      st.loading = false;
      S.replies.set(id, st);
      renderList();
    }
  }

  async function moreReplies(id) {
    const st = S.replies.get(id);
    if (!st || st.loading || !st.nextCursor) return;
    const run = S.run;
    st.loading = true;
    renderList();
    try {
      const data = await api(`/api/comments/${encodeURIComponent(id)}/replies?limit=10&cursor=${encodeURIComponent(st.nextCursor)}`);
      if (run !== S.run) return;
      st.items = st.items.concat(data.comments || []);
      st.nextCursor = data.nextCursor || null;
    } catch (err) {
      if (run !== S.run) return;
      toast(err.message);
    } finally {
      if (run !== S.run) return;
      st.loading = false;
      renderList();
    }
  }

  function renderCount() {
    const el = $('#comment-count', S.container);
    if (!el) return;
    el.textContent = S.totalCount === 0 ? 'Belum ada komentar' : `${S.totalCount} Komentar`;
    S.container.querySelectorAll('.c-sort-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === S.sort)));
  }

  function renderMore() {
    const el = $('#comment-more', S.container);
    if (!el) return;
    if (S.loading && S.nextCursor) { el.innerHTML = `<button type="button" class="btn ghost" disabled>Memuat…</button>`; return; }
    el.innerHTML = S.nextCursor ? `<button type="button" class="btn ghost" data-act="more">Muat komentar lainnya</button>` : '';
  }

  function skeleton(n) {
    return Array.from({length: n}, () => `<div class="c-item c-skeleton"><div class="c-avatar"></div><div class="c-main"><div class="c-line w40"></div><div class="c-line w90"></div><div class="c-line w70"></div></div></div>`).join('');
  }

  function renderList() {
    const el = $('#comment-list', S.container);
    if (!el) return;
    if (S.error) { el.innerHTML = `<div class="c-state"><p>Komentar gagal dimuat.</p><button type="button" class="btn ghost" data-act="retry">Coba lagi</button></div>`; return; }
    if (S.loading && !S.comments.length) { el.innerHTML = skeleton(3); return; }
    if (!S.comments.length) { el.innerHTML = `<div class="c-state"><p>Belum ada komentar. Jadilah yang pertama.</p></div>`; return; }
    el.innerHTML = S.comments.map(c => commentItem(c, 'main')).join('');
  }

  function repliesBlock(c) {
    const st = S.replies.get(c.id);
    if (!(c.replyCount > 0 || (st && st.items.length))) return '';
    let html = `<div class="c-replies">`;
    if (!st || !st.open) {
      html += `<button type="button" class="c-replies-toggle" data-act="replies" data-id="${esc(c.id)}" aria-expanded="false">${c.replyCount} balasan ↓</button>`;
    } else {
      html += `<button type="button" class="c-replies-toggle" data-act="replies" data-id="${esc(c.id)}" aria-expanded="true">Sembunyikan balasan ↑</button>`;
      html += st.items.map(r => commentItem(r, 'reply')).join('');
      if (st.loading) html += skeleton(1);
      if (st.nextCursor) html += `<button type="button" class="c-replies-toggle" data-act="more-replies" data-id="${esc(c.id)}">Muat balasan lainnya</button>`;
    }
    html += `</div>`;
    return html;
  }

  function commentItem(c, kind) {
    if (c.isDeleted || c.isHidden) {
      const label = c.isHidden ? 'Komentar disembunyikan.' : 'Komentar ini telah dihapus';
      let gone = `<div class="c-item c-gone" data-cid="${esc(c.id)}"><div class="c-avatar"></div><div class="c-main"><p class="c-body">${label}</p>`;
      if (kind === 'main') gone += repliesBlock(c);
      return gone + `</div></div>`;
    }
    const actions = [];
    actions.push(`<button type="button" class="c-act${c.likedByMe ? ' on' : ''}" data-act="like" data-id="${esc(c.id)}" aria-pressed="${c.likedByMe}" aria-label="Suka, ${c.likeCount} suka">♥ <span>${c.likeCount || ''}</span></button>`);
    actions.push(`<button type="button" class="c-act" data-act="reply" data-id="${esc(c.id)}">Balas</button>`);
    actions.push(`<button type="button" class="c-act c-more-btn" data-act="menu" data-id="${esc(c.id)}" aria-label="Aksi lain">⋯</button>`);
    const spoiler = c.isSpoiler && !S.revealed.has(c.id);
    const bodyHtml = spoiler
      ? `<button type="button" class="c-body c-spoiler" data-act="spoiler" data-id="${esc(c.id)}">Spoiler. Klik untuk melihat.</button>`
      : `<p class="c-body">${esc(c.body)}</p>`;
    const edited = c.editedAt ? ' · diedit' : '';
    let html = `<div class="c-item${kind === 'reply' ? ' c-reply-item' : ''}" data-cid="${esc(c.id)}">
      <div class="c-avatar" aria-hidden="true">${esc(avatarLetter(c.user && c.user.name))}</div>
      <div class="c-main">
        <div class="c-meta"><b>${esc((c.user && c.user.name) || 'Pengguna')}</b><span class="c-time">${esc(relTime(c.createdAt))}${edited}</span></div>
        ${bodyHtml}
        <div class="c-actions">${actions.join('')}</div>
        ${menu(c)}
        ${S.editId === c.id ? editForm(c) : ''}`;
    if (kind === 'main') html += repliesBlock(c);
    if (S.replyTo === c.id) html += replyForm(c.id);
    html += `</div></div>`;
    return html;
  }

  function replyForm(id) {
    const c = find(id);
    const name = (c && c.user && c.user.name) || 'Pengguna';
    return `<form class="c-inline-form" data-reply="${esc(id)}">
      <label class="sr-only" for="reply-${esc(id)}">Balas komentar dari ${esc(name)}</label>
      <textarea id="reply-${esc(id)}" rows="2" placeholder="Tulis balasan…" required></textarea>
      <div class="c-inline-foot"><button type="button" class="c-act" data-act="cancel">Batal</button><button type="submit" class="btn">Balas</button></div>
      <p class="form-error" role="alert"></p>
    </form>`;
  }

  function editForm(c) {
    return `<form class="c-inline-form" data-edit="${esc(c.id)}">
      <label class="sr-only" for="edit-${esc(c.id)}">Edit komentar</label>
      <textarea id="edit-${esc(c.id)}" rows="2" required>${esc(c.body)}</textarea>
      <div class="c-inline-foot"><button type="button" class="c-act" data-act="cancel">Batal</button><button type="submit" class="btn">Simpan</button></div>
      <p class="form-error" role="alert"></p>
    </form>`;
  }

  function menu(c) {
    if (S.menuId !== c.id) return '';
    const items = [];
    if (c.canDelete) items.push(`<button type="button" data-act="delete" data-id="${esc(c.id)}">Hapus</button>`);
    if (c.canEdit) items.push(`<button type="button" data-act="edit" data-id="${esc(c.id)}">Edit</button>`);
    if (S.auth && S.auth.authenticated && !c.canDelete) {
      items.push(`<div class="c-report"><span class="c-report-label">Laporkan</span>${REASONS.map(r => `<button type="button" data-act="report" data-id="${esc(c.id)}" data-reason="${r.key}">${esc(r.label)}</button>`).join('')}</div>`);
    }
    if (!items.length) items.push(`<span class="c-menu-empty">Tidak ada aksi</span>`);
    return `<div class="c-menu" role="menu">${items.join('')}</div>`;
  }

  async function doLike(id) {
    if (!S.auth || !S.auth.authenticated) return requireLogin();
    const c = find(id);
    if (!c) return;
    const on = !c.likedByMe;
    const previous = {likeCount: c.likeCount, likedByMe: c.likedByMe};
    c.likedByMe = on;
    c.likeCount = Math.max(0, c.likeCount + (on ? 1 : -1));
    renderList();
    try {
      const res = await api(`/api/comments/${encodeURIComponent(id)}/like`, {method: on ? 'POST' : 'DELETE', body: '{}'});
      c.likedByMe = res.liked;
      c.likeCount = res.likeCount;
    } catch (err) {
      c.likedByMe = previous.likedByMe;
      c.likeCount = previous.likeCount;
      toast(err.message);
    }
    renderList();
  }

  function find(id) {
    const main = S.comments.find(c => c.id === id);
    if (main) return main;
    for (const st of S.replies.values()) {
      const r = st.items.find(x => x.id === id);
      if (r) return r;
    }
    return null;
  }

  function rootIdOf(id) {
    const c = find(id);
    if (!c) return id;
    return c.parentId || c.id;
  }

  async function submitReply(id, text, form) {
    const body = String(text || '').trim();
    if (body.length < 1 || body.length > 1000) { $('.form-error', form).textContent = 'Balasan harus 1–1000 karakter.'; return; }
    try {
      const res = await api('/api/comments', {method: 'POST', body: JSON.stringify({targetId: S.comicId, targetType: 'series', parentId: id, body})});
      // F15: balasan langsung tampil di bawah induk dan daftar balasan terbuka.
      const rootId = rootIdOf(id);
      const root = find(rootId);
      const st = S.replies.get(rootId) || {items: [], nextCursor: null, open: true, loading: false};
      st.items = st.items.concat(res.comment);
      st.open = true;
      S.replies.set(rootId, st);
      if (root) root.replyCount = (root.replyCount || 0) + 1;
      S.replyTo = null;
      toast('Balasan terkirim.');
      renderList();
    } catch (err) {
      $('.form-error', form).textContent = err.message;
    }
  }

  async function doDelete(id) {
    if (!confirm('Hapus komentar ini?')) return;
    try {
      await api(`/api/comments/${encodeURIComponent(id)}`, {method: 'DELETE', body: '{}'});
      const c = find(id);
      const run = S.run;
      if (c && c.parentId) S.replies.delete(rootIdOf(id));
      toast('Komentar dihapus.');
      await loadFirst(run, {keep: true});
    } catch (err) {
      toast(err.message);
    }
  }

  async function doReport(id, reason) {
    S.menuId = null;
    try {
      await api(`/api/comments/${encodeURIComponent(id)}/report`, {method: 'POST', body: JSON.stringify({reason})});
      toast('Terima kasih, laporan diterima.');
    } catch (err) {
      toast(err.message);
    }
  }

  async function submitEdit(id, text, form) {
    const body = String(text || '').trim();
    if (body.length < 1 || body.length > 1000) { $('.form-error', form).textContent = 'Komentar harus 1–1000 karakter.'; return; }
    try {
      const res = await api(`/api/comments/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify({body})});
      const c = find(id);
      if (c && res.comment) { c.body = res.comment.body; c.editedAt = res.comment.editedAt; }
      S.editId = null;
      toast('Komentar diperbarui.');
    } catch (err) {
      $('.form-error', form).textContent = err.message;
      return;
    }
    renderList();
  }

  function bindOnce() {
    const el = S.container;
    if (el.dataset.cBound) return;
    el.dataset.cBound = '1';
    el.addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !el.contains(btn)) return;
      const act = btn.dataset.act, id = btn.dataset.id;
      if (act === 'login') return requireLogin();
      if (act === 'sort') { S.sort = btn.dataset.sort; S.replies = new Map(); await loadFirst(S.run); return; }
      if (act === 'more') return loadMore();
      if (act === 'retry') return loadFirst(S.run);
      if (act === 'like') return doLike(id);
      if (act === 'reply') {
        if (!S.auth || !S.auth.authenticated) return requireLogin();
        S.editId = null;
        S.replyTo = S.replyTo === id ? null : id;
        S.menuId = null;
        return renderList();
      }
      if (act === 'cancel') { S.replyTo = null; S.editId = null; return renderList(); }
      if (act === 'menu') { S.menuId = S.menuId === id ? null : id; S.replyTo = null; return renderList(); }
      if (act === 'delete') return doDelete(id);
      if (act === 'edit') { S.menuId = null; S.editId = S.editId === id ? null : id; return renderList(); }
      if (act === 'report') return doReport(id, btn.dataset.reason);
      if (act === 'spoiler') { S.revealed.add(id); return renderList(); }
      if (act === 'replies') return loadReplies(id);
      if (act === 'more-replies') return moreReplies(id);
    });
    el.addEventListener('submit', async e => {
      const form = e.target;
      if (form.dataset.reply !== undefined) {
        e.preventDefault();
        return submitReply(form.dataset.reply, form.querySelector('textarea').value, form);
      }
      if (form.dataset.edit !== undefined) {
        e.preventDefault();
        return submitEdit(form.dataset.edit, form.querySelector('textarea').value, form);
      }
    });
  }

  window.Comments = {init, mount, stop};
})();
