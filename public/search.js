'use strict';
// Komponen pencarian judul di header (PRD "Fitur Pencarian Judul", F1-F19).
// Menampilkan panel dropdown live saat mengetik, navigasi keyboard, serta status
// skeleton/kosong/gagal. Dipakai dari app.js: HeaderSearch.init({api, esc, slug, fallbackCover}).
(function () {
  const DEBOUNCE_MS = 300;
  const MIN_CHARS = 2;
  const LIMIT = 5;
  const PANEL_ID = 'search-panel';

  let deps = null;       // {api, esc, slug, fallbackCover}
  let form, input, panel;
  let rows = [];         // hasil terakhir: [{id,title,cover}]
  let active = -1;       // indeks baris tersorot
  let state = 'idle';    // idle | loading | results | empty | error
  let timer = null;      // timer debounce
  let controller = null; // permintaan berjalan (dibatalkan bila ada ketikan baru)
  let seq = 0;           // nomor urut permintaan; respons usang diabaikan (F15)
  let lastQuery = '';    // kata kunci yang dipakai menandai sorotan teks (F17)

  const esc = value => deps.esc(value);
  const isTouch = () => window.matchMedia && window.matchMedia('(hover: none)').matches;

  function openPanel() {
    panel.classList.add('open');
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function closePanel() {
    panel.classList.remove('open');
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function resetResults() {
    rows = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
  }

  // Sorot potongan judul yang cocok, aman terhadap HTML (F17).
  function highlight(title, query) {
    if (!query) return esc(title);
    const at = title.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return esc(title);
    return esc(title.slice(0, at)) + '<mark class="search-hl">' + esc(title.slice(at, at + query.length)) + '</mark>' + esc(title.slice(at + query.length));
  }

  function rowHtml(result, index) {
    const cover = result.cover || deps.fallbackCover;
    return '<a class="search-row" role="option" id="search-opt-' + index + '" data-id="' + esc(result.id) + '" href="#detail/' + deps.slug(result.id) + '">' +
      '<span class="search-cover-wrap"><img class="search-cover" loading="lazy" src="' + esc(cover) + '" alt="" onerror="this.classList.add(\'search-cover-ph\');this.removeAttribute(\'src\')"></span>' +
      '<span class="search-title">' + highlight(result.title, lastQuery) + '</span></a>';
  }

  function skeletonHtml() {
    return Array.from({length: 3}, () => '<div class="search-row search-skeleton" aria-hidden="true"><span class="search-cover-wrap sk-block"></span><span class="search-title"><span class="sk-line"></span><span class="sk-line sk-short"></span></span></div>').join('');
  }

  function render() {
    if (state === 'loading') { openPanel(); panel.innerHTML = skeletonHtml(); return; }
    if (state === 'error') { openPanel(); panel.innerHTML = '<div class="search-msg" role="status">Pencarian gagal. Coba lagi.</div>'; return; }
    if (state === 'empty') { openPanel(); panel.innerHTML = '<div class="search-msg" role="status">Tidak ada judul yang cocok</div>'; return; }
    if (state === 'results') {
      openPanel();
      panel.innerHTML = rows.map(rowHtml).join('');
      setActive(0, false); // baris pertama tersorot secara bawaan (F10)
      return;
    }
    closePanel();
  }

  function setActive(index, scroll = true) {
    const links = panel.querySelectorAll('.search-row[role="option"]');
    if (!links.length) { active = -1; input.removeAttribute('aria-activedescendant'); return; }
    active = (index + links.length) % links.length;
    links.forEach((el, i) => el.classList.toggle('active', i === active));
    const current = links[active];
    input.setAttribute('aria-activedescendant', current.id);
    if (scroll) current.scrollIntoView({block: 'nearest'});
  }

  function select(id) {
    if (!id) return;
    location.hash = 'detail/' + deps.slug(id);
    input.value = '';
    resetResults();
    closePanel();
    if (window.matchMedia('(max-width: 760px)').matches) form.classList.remove('open');
  }

  async function runSearch(query) {
    const requestId = ++seq;
    controller?.abort();
    controller = new AbortController();
    state = 'loading';
    render();
    try {
      const data = await deps.api('/api/search?q=' + encodeURIComponent(query) + '&limit=' + LIMIT, {signal: controller.signal});
      if (requestId !== seq) return; // jawaban permintaan lama diabaikan (F15)
      rows = Array.isArray(data.results) ? data.results : [];
      lastQuery = query;
      state = rows.length ? 'results' : 'empty';
    } catch (error) {
      if (requestId !== seq || error?.name === 'AbortError') return;
      state = 'error';
    }
    render();
  }

  function schedule() {
    clearTimeout(timer);
    const query = input.value.replace(/\s+/g, ' ').trim(); // buang spasi di awal/akhir (F3)
    if (query.length < MIN_CHARS) { // kurang dari 2 karakter: tidak ada panel & tidak ada permintaan (F3)
      seq++; controller?.abort();
      resetResults();
      state = 'idle';
      render();
      return;
    }
    timer = setTimeout(() => runSearch(query), DEBOUNCE_MS); // F2
  }

  function currentLink() {
    return panel.querySelector('.search-row[role="option"].active') || panel.querySelector('.search-row[role="option"]');
  }

  function bind() {
    input.addEventListener('input', schedule);
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (state !== 'results' || !rows.length) return;
        event.preventDefault();
        setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter') {
        event.preventDefault(); // Enter membuka hasil tersorot; bukan pindah ke halaman katalog (F10)
        const link = currentLink();
        if (link) select(link.dataset.id);
      } else if (event.key === 'Escape') {
        closePanel(); // kata kunci tetap ada di kolom (F11)
        if (window.matchMedia('(max-width: 760px)').matches) form.classList.remove('open');
      }
    });
    // Klik/sentuh baris hasil (F8).
    panel.addEventListener('click', event => {
      const link = event.target.closest('.search-row[role="option"]');
      if (!link) return;
      event.preventDefault();
      select(link.dataset.id);
    });
    panel.addEventListener('mousemove', event => {
      const links = [...panel.querySelectorAll('.search-row[role="option"]')];
      const link = event.target.closest('.search-row[role="option"]');
      if (link) setActive(links.indexOf(link), false);
    });
    // Klik di luar menutup panel; kata kunci tetap (F11).
    document.addEventListener('click', event => { if (!form.contains(event.target)) closePanel(); });
    // Pada layar sempit kolom diringkas jadi ikon; ketuk ikon membuka kolom selebar layar (F18).
    form.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 760px)').matches && !form.classList.contains('open')) {
        form.classList.add('open');
        input.focus();
      }
    });
    window.addEventListener('hashchange', closePanel);
  }

  function onShortcut() { // Ctrl/⌘ + K (F9)
    form.classList.add('open');
    input.focus();
    input.select();
  }

  function init(options) {
    deps = options;
    form = document.getElementById('search-form');
    input = document.getElementById('global-search');
    if (!form || !input) return;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', PANEL_ID);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', 'Cari judul');
    input.setAttribute('aria-label', 'Cari judul');

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'search-panel';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Hasil pencarian');
    panel.setAttribute('aria-live', 'polite');
    panel.hidden = true;
    form.appendChild(panel);

    // Petunjuk pintasan: Ctrl+K (Win/Linux) atau ⌘K (macOS); disembunyikan di perangkat sentuh (F19).
    const hint = form.querySelector('kbd');
    if (hint) {
      const mac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
      hint.textContent = mac ? '⌘ K' : 'Ctrl K';
      if (isTouch()) hint.hidden = true;
    }

    window.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); onShortcut(); }
    });

    bind();
  }

  window.HeaderSearch = {init};
})();
