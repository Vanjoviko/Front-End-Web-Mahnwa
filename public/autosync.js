'use strict';
// Tab admin "Auto-Sync": daftarkan URL seri sekali, sistem memeriksa chapter baru
// dan (bila auto-publish) mempublikasikannya otomatis. Memakai BFF /api/admin/subscriptions.
(function () {
  const $q = (sel, root = document) => root.querySelector(sel);
  const $$q = (sel, root = document) => [...root.querySelectorAll(sel)];
  const S = {list: [], schedulerEnabled: false, concurrency: 1, busy: false, error: '', note: '', urls: '', interval: '360', autoPublish: true, preview: {}, timer: null, token: 0, loaded: false};

  const root = () => $q('#autosync-root');
  const fmt = ts => ts ? new Date(ts).toLocaleString('id-ID') : '—';
  const intervalLabel = v => v < 60 ? `${v} menit` : v < 1440 ? `${v / 60} jam` : `${v / 1440} hari`;
  const STATUS = {pending: ['Belum jalan', ''], running: ['Berjalan…', 'aktif'], ok: ['Berhasil', 'siap'], draft: ['Menunggu review', 'warn'], error: ['Gagal', 'err']};

  function statusBadge(s) {
    const [label, kind] = STATUS[s.lastStatus] || [s.lastStatus || '—', ''];
    return `<span class="badge ${kind}">${esc(label)}</span>`;
  }

  function row(s) {
    const pv = S.preview[s.id];
    return `<tr>
      <td><b>${esc(s.title || '(belum dipindai)')}</b><br><small style="word-break:break-all">${esc(s.seriesUrl)}</small>${s.lastError ? `<br><small class="err-text">${esc(s.lastError)}</small>` : ''}</td>
      <td>${statusBadge(s)}${s.autoPublish ? '<br><small>auto-publish</small>' : '<br><small>review manual</small>'}</td>
      <td>${s.lastNewChapters || 0}</td>
      <td>${fmt(s.lastCheckedAt)}</td>
      <td>${s.enabled ? fmt(s.nextCheckAt) : '—'}</td>
      <td class="as-actions"><button class="btn small" data-as-sync="${esc(s.id)}" ${s.running ? 'disabled' : ''}>Sync</button><button class="btn ghost small" data-as-preview="${esc(s.id)}" ${s.running ? 'disabled' : ''}>Cek</button><button class="btn ghost small" data-as-toggle="${esc(s.id)}">${s.enabled ? 'Jeda' : 'Aktifkan'}</button><button class="btn danger small" data-as-delete="${esc(s.id)}">Hapus</button></td>
    </tr>${pv ? `<tr class="row-muted"><td colspan="6"><small>Pratinjau ${esc(pv.title || '')}: ${pv.newCount} chapter baru${pv.newCount ? ' → ' + pv.newChapters.slice(0, 10).map(c => esc(c.number ?? c.numberRaw ?? '?')).join(', ') : ''}</small></td></tr>` : ''}`;
  }

  function inner() {
    return `<div class="admin-card">
      <h3>Auto-Sync sumber seri</h3>
      <p style="font-size:12px;color:#9aa;margin:4px 0 10px">Daftarkan URL seri <b>sekali</b>; sistem memeriksa chapter baru secara berkala. Scheduler <b>${S.schedulerEnabled ? 'AKTIF' : 'NONAKTIF'}</b>${S.schedulerEnabled ? '' : ' (set AUTO_SYNC_ENABLED=true untuk otomatis)'}. Tombol <b>Sync</b> tetap bisa dipakai manual.</p>
      <form id="as-form">
        <label style="display:block;font-size:11px;margin-bottom:4px">URL seri (satu per baris, boleh banyak sekaligus)</label>
        <textarea id="as-urls" class="control" rows="3" placeholder="https://sumber.example/series/slug-1&#10;https://sumber.example/series/slug-2" ${S.busy ? 'disabled' : ''}>${esc(S.urls)}</textarea>
        <div class="admin-row" style="margin-top:8px">
          <label style="font-size:11px">Interval <select id="as-interval" class="control">${[60, 360, 1440, 4320].map(v => `<option value="${v}" ${String(v) === S.interval ? 'selected' : ''}>${intervalLabel(v)}</option>`).join('')}</select></label>
          <label style="font-size:11px"><input type="checkbox" id="as-autopublish" ${S.autoPublish ? 'checked' : ''}> Auto-publish chapter baru</label>
          <button class="btn" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Menambah…' : 'Tambah langganan'}</button>
          <button class="btn ghost" type="button" id="as-refresh">Muat ulang</button>
        </div>
        ${S.error ? `<p class="form-error" role="alert">${esc(S.error)}</p>` : S.note ? `<p class="muted" role="status">${esc(S.note)}</p>` : '<p class="form-error"></p>'}
      </form>
    </div>
    <div class="admin-card table-wrap">
      <table class="admin-table"><thead><tr><th>Seri</th><th>Status</th><th>Baru</th><th>Terakhir cek</th><th>Cek berikutnya</th><th>Aksi</th></tr></thead>
      <tbody>${S.list.length ? S.list.map(row).join('') : '<tr><td colspan="6">Belum ada langganan. Tambahkan URL seri di atas.</td></tr>'}</tbody></table>
    </div>`;
  }

  function paint() { const r = root(); if (r) r.innerHTML = inner(); }

  async function call(path, method, body) {
    return api(path, {method, body: body === undefined ? undefined : JSON.stringify(body)});
  }

  async function refresh() {
    try {
      const data = await call('/api/admin/subscriptions', 'GET');
      S.list = data.subscriptions || [];
      S.schedulerEnabled = Boolean(data.schedulerEnabled);
      S.concurrency = data.concurrency || 1;
      S.error = '';
    } catch (error) {
      S.error = error.message;
    }
    S.loaded = true;
    paint();
    attach();
    managePoll();
  }

  function managePoll() {
    const anyRunning = S.list.some(s => s.running);
    if (anyRunning && !S.timer) {
      S.timer = setInterval(() => { refresh().catch(() => {}); }, 3000);
    } else if (!anyRunning && S.timer) {
      clearInterval(S.timer); S.timer = null;
    }
  }

  function attach() {
    const r = root(); if (!r) return;
    const form = $q('#as-form', r);
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const urls = $q('#as-urls', r).value;
      if (!urls.trim()) { S.error = 'Masukkan setidaknya satu URL.'; paint(); attach(); return; }
      S.busy = true; S.urls = urls; S.error = ''; S.note = ''; paint(); attach();
      try {
        const out = await call('/api/admin/subscriptions', 'POST', {text: urls, intervalMinutes: Number($q('#as-interval', r).value), autoPublish: $q('#as-autopublish', r).checked});
        const n = out.added || 0;
        S.note = `${n} langganan ditambahkan${out.skipped?.length ? `, ${out.skipped.length} dilewati` : ''}.`;
        S.urls = '';
      } catch (error) { S.error = error.message; }
      S.busy = false;
      await refresh();
    };
    $q('#as-refresh', r)?.addEventListener('click', () => { S.note = ''; refresh().catch(() => {}); });
    $$q('[data-as-sync]', r).forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Mengantre…';
      try { await call(`/api/admin/subscriptions/${encodeURIComponent(b.dataset.asSync)}/sync`, 'POST', {}); S.note = 'Sinkronisasi masuk antrean.'; }
      catch (error) { S.error = error.message; }
      refresh().catch(() => {});
    });
    $$q('[data-as-preview]', r).forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Memeriksa…';
      try {
        const pv = await call(`/api/admin/subscriptions/${encodeURIComponent(b.dataset.asPreview)}/preview`, 'GET');
        S.preview[b.dataset.asPreview] = pv; S.error = '';
      } catch (error) { S.error = error.message; }
      paint(); attach();
    });
    $$q('[data-as-toggle]', r).forEach(b => b.onclick = async () => {
      const sub = S.list.find(s => s.id === b.dataset.asToggle); if (!sub) return;
      try { await call(`/api/admin/subscriptions/${encodeURIComponent(sub.id)}`, 'PATCH', {enabled: !sub.enabled}); }
      catch (error) { S.error = error.message; }
      refresh().catch(() => {});
    });
    $$q('[data-as-delete]', r).forEach(b => b.onclick = async () => {
      try { await call(`/api/admin/subscriptions/${encodeURIComponent(b.dataset.asDelete)}`, 'DELETE'); delete S.preview[b.dataset.asDelete]; }
      catch (error) { S.error = error.message; }
      refresh().catch(() => {});
    });
  }

  function tabHtml() { return `<div id="autosync-root">${inner()}</div>`; }

  function bind() {
    const r = root(); if (!r) return;
    if (!S.loaded) { refresh().catch(() => {}); return; }
    paint(); attach(); managePoll();
  }

  function stop() { if (S.timer) { clearInterval(S.timer); S.timer = null; } S.token++; }

  window.AutoSync = {tabHtml, bind, stop, refresh, _state: S};
})();
