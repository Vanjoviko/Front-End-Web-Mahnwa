/* Fungsi tampilan murni untuk Scan Import (dipakai browser sebagai window.ScanFormat dan diuji di Node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ScanFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const NOT_OK = new Set(['FAILED', 'CANCELLED']);
  const RETRY_ALL_LABEL = 'Coba ulang semua yang gagal';

  // Jumlah halaman di baris finalisasi: hanya untuk chapter yang selesai (COMPLETED); label "halaman" (bukan "hlm").
  function pagesLabel(ch) { return ch && ch.status === 'COMPLETED' && ch.pageCount > 0 ? `${ch.pageCount} halaman` : ''; }

  // Hitungan per-chapter di panel progres: chapter gagal/dibatalkan tidak menampilkan hitungan parsial (halaman dibersihkan).
  function progressCount(c) {
    if (!c || NOT_OK.has(c.status)) return '—';
    return c.pagesTotal ? `${c.pagesDone}/${c.pagesTotal}` : '—';
  }

  // Total halaman keseluruhan hanya dari chapter yang tidak gagal/dibatalkan.
  function displayTotals(p) {
    let done = 0, total = 0;
    for (const c of (p && p.chapters) || []) { if (NOT_OK.has(c.status)) continue; done += c.pagesDone || 0; total += c.pagesTotal || 0; }
    return {pagesDone: done, pagesTotal: total};
  }

  // "perlu nomor" (dari sumber) dan "nomor wajib diisi" (validasi FE) bermakna sama: tampilkan satu saja.
  function visibleIssues(issues) {
    const list = Array.from(new Set(issues || []));
    return list.includes('number_required') ? list.filter(i => i !== 'needs_number') : list;
  }

  // Pesan galat polling dalam bahasa Indonesia: galat jaringan browser ("Failed to fetch", dll.) tidak boleh tampil apa adanya.
  function pollErrorMessage(err) {
    if (err && (err.code || err.status) && err.message) return err.message;   // ApiError dari server (pesan sudah berbahasa Indonesia)
    const msg = String((err && err.message) || '');
    if (!msg || /failed to fetch|networkerror|load failed|network request failed|fetch failed|aborted|timeout/i.test(msg)) return 'Tidak dapat terhubung ke server.';
    return 'Terjadi kesalahan saat memuat progres.';
  }

  return {pagesLabel, progressCount, displayTotals, visibleIssues, pollErrorMessage, RETRY_ALL_LABEL, NOT_OK};
});
