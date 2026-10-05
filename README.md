# Lembar

Katalog dan pembaca manhwa berbahasa Indonesia. Proyek ini memakai Node.js bawaan (tanpa paket eksternal), HTML, CSS, dan JavaScript. Karya, sampul, metadata, dan halaman baca yang tampil adalah data/placeholder demo.

## Menjalankan

Perlu Node.js 20 atau lebih baru.

Kredensial admin lokal dibaca dari `.env` (file ini diabaikan Git dan tidak dikirim ke browser). Isi `ADMIN_USER` dan `ADMIN_PASSWORD` di file tersebut untuk menetapkan login. Ganti kata sandi sebelum mengekspos server ke jaringan atau internet.

```powershell
npm start
```

Buka alamat yang dicetak server, biasanya `http://127.0.0.1:3000`. Server membuat `data/db.json` pada penggunaan pertama. Login admin terpisah dari akun pembaca. Secara lokal, nama admin default `admin` dan kata sandi acak dicetak di terminal saat server mulai. Tetapkan `ADMIN_USER` dan `ADMIN_PASSWORD` sebagai environment variables untuk kredensial tetap. Sesi login memakai cookie HttpOnly dan kedaluwarsa setelah 8 jam; restart server mengakhiri sesi aktif.

Untuk port lain, atur variabel lingkungan `PORT`. `HOST` default ke `127.0.0.1` agar hanya dapat diakses dari komputer lokal. Untuk menjalankan pada host jaringan, berikan perlindungan jaringan dan set kredensial admin melalui environment sebelum membuka host tersebut.

```powershell
$env:ADMIN_USER = "admin"
$env:ADMIN_PASSWORD = "ganti-dengan-kata-sandi-yang-kuat"
$env:PORT = "3000"
npm start
```

## Fitur

- Beranda dengan pencarian, pilihan editor, pengumuman, rekomendasi, update, genre, dan slot iklan berlabel.
- Katalog dengan filter judul/genre, jenis, status, genre, dan pengurutan update/popularitas.
- Detail komik dan daftar chapter; reader demo responsif dengan chapter sebelumnya/berikutnya.
- Akun pembaca dapat mendaftar dan login; favorit dan riwayat baca tetap disimpan di browser.
- Login admin khusus mengelola komik, chapter, pengumuman, slot iklan, jadwal, dan konektor. Password pembaca disimpan sebagai hash scrypt di `data/db.json`.
- Form admin menerima sampul PNG/JPEG/WebP dan chapter PDF (maksimum 5 MB per sampul, 20 MB per PDF). Server menyimpan PDF asli dan mengantrekannya untuk dirender menjadi gambar halaman bernomor; reader menampilkan halaman hasil konversi dan tautan untuk mengunduh PDF asli. Status `QUEUED`, `DOWNLOADING`, `COMPLETED`, atau `FAILED` dicatat per chapter; reader memeriksa status proses secara otomatis. Rendering membutuhkan `pdfinfo` dan `pdftoppm` (Poppler) di `PATH`; maksimum 80 halaman dirender per chapter.
- Tab Kelola chapter menerima unggahan 1–80 gambar JPG/PNG/WebP per chapter, total maksimal 28 MB. Admin memilih nomor chapter; urutan pilihan file menjadi urutan halaman reader. Gambar langsung disimpan lokal sebagai `001`, `002`, dan seterusnya tanpa dependensi scraping atau PDF.
- Berkas unggahan baru disimpan terstruktur di `data/media/<slug-komik-id>/cover.*` dan `data/media/<slug-komik-id>/chapters/chapter-<nomor>/` (`original.pdf`, `001.jpg`, `002.jpg`, dan seterusnya). Saat server pertama kali dijalankan setelah pembaruan, aset unggahan lama di `data/media/uploads/` disalin ke struktur ini dan tautan di database diperbarui; berkas lama dibiarkan sebagai cadangan.
- Form admin dapat menerima URL seri Kiryuu dan satu nomor chapter. Worker mencari chapter pada daftar seri, mengambil HTML dan gambar yang diizinkan, lalu menyimpan gambar secara lokal di folder chapter. Ini impor manual per chapter, tidak menjadwalkan unduhan otomatis.
- Pipeline demo otomatis membaca fixture JSON lokal, memilih chapter bernomor terbesar, membandingkan database, lalu menyalin halaman SVG demo ke `data/media/` untuk reader lokal.
- Endpoint admin dilindungi peran dan sesi server; kredensial admin tidak ditanam pada bundle browser atau berkas data.
- Data katalog yang tersinkron disimpan lokal di `data/db.json`; gunakan panel admin untuk menghapusnya atau hapus berkas tersebut saat server berhenti untuk mengatur ulang seluruh demo.

## Sinkronisasi dan batas sumber

Reader hanya menampilkan chapter dari berkas lokal. Tautan chapter ke situs sumber tidak disimpan atau ditampilkan; bila metadata sumber tidak memiliki halaman lokal, chapter ditandai belum tersedia. Untuk menambahkan isi, unggah PDF milik Anda atau yang penggunaannya diizinkan melalui panel admin. PDF asli serta gambar hasil konversi disimpan di `data/media/`.

Impor chapter Kiryuu dimulai dari tab Admin → Chapter: pilih komik, isi URL seri HTTPS `v7.kiryuu.to/manga/...`, nomor chapter, lalu antrekan impor. Worker memakai HTTP standar dengan identitas yang transparan, memberi jeda minimal 1,2 detik per host, membatasi chapter sampai 80 halaman dan total 28 MB, lalu menyimpan gambar bernomor ke `data/media/<slug-komik-id>/chapters/chapter-<nomor>/`. Impor hanya dijalankan atas permintaan admin dan tidak mengikuti jadwal konektor metadata.

Jika host menolak akses (mis. 401/403/429), worker menghentikan pekerjaan, menandai chapter gagal, menonaktifkan konektor Kiryuu, dan menampilkan pesan beserta `Retry-After` (bila ada) pada panel admin. Kiryuu dan host CDN belum diverifikasi berhasil dari lingkungan ini; keberhasilan impor bergantung pada izin penggunaan konten dan metode akses yang diizinkan oleh sumber. Bila gambar tidak dapat diakses secara langsung, gunakan unggah gambar/PDF lokal. Shinigami tetap nonaktif sampai ada metode akses publik yang diizinkan dan diverifikasi.

Konektor Feed Publik menerima URL JSON, RSS, atau Atom yang memang boleh diakses. Konektor memakai jeda, timeout, cache, deduplikasi, dan batas respons. Feed dibatasi paling banyak 30 entri metadata per proses. Tidak ada halaman chapter atau gambar yang diambil dari feed.

Konektor Sumber Demo Lokal memakai fixture JSON dan ilustrasi SVG orisinal di `public/demo-source/`. Ini adalah data demonstrasi lokal, bukan hasil scraping situs lain. Pengaturan jadwal default-nya mati dan hanya berlaku saat server berjalan.

## Scan Import

Fitur Scan Import mengimpor satu seri beserta semua chapter-nya dari sumber yang **diizinkan** ke penyimpanan lokal, melalui draft yang ditinjau admin sebelum tampil di katalog publik. Perayap Python (repo Back-End, "worker") menjalankan scan/unduhan; FE tidak pernah mengunduh langsung dari internet untuk jalur ini dan hanya menyimpan hasil yang sudah diverifikasi.

Alur (Admin → **Scan Import**):

1. Tempel URL sumber lalu **Scan link**. Worker memilih adapter (saat ini: *Manifest JSON* dan *Fixture* lokal untuk pengujian), mengembalikan metadata, sampul, dan daftar chapter. Hasilnya adalah **draft** (`db.scanDrafts`) yang tidak muncul di katalog, konektor, maupun panel admin lama.
2. Periksa pratinjau (sampul, judul, deskripsi, status, kreator, genre, jumlah chapter, tanda BARU/SUDAH ADA) lalu klik **Download All**. FE meminta worker membuat job; progres per chapter/halaman dipantau dan dapat dibatalkan atau diulang per chapter. Chapter dinyatakan `COMPLETED` hanya jika **semua** halamannya valid (all-or-nothing); gambar dicek ukuran, checksum SHA-256, dan magic byte saat diterima.
3. Buka **halaman finalisasi** (`#admin/scan/<draftId>`, tata letak sama dengan halaman detail): ubah judul/sinopsis/sampul/nomor & judul chapter, keluarkan atau hapus chapter, lalu **Publish**. Publish bersifat atomik (satu penulisan `db.json`; berkas dipindah dengan rollback bila gagal) dan menyimpan chapter dengan kontrak yang sama dengan unggahan manual: `pages: [{ "page_number": 1, "image_url": "/media/<kunci>/chapters/chapter-<nomor>/001.webp" }]`.
4. Scan ulang URL yang sama setelah dipublikasikan hanya menandai chapter baru; publish menambahkan chapter baru tanpa menimpa metadata yang sudah ada. Mengganti chapter yang sudah ada memerlukan konfirmasi eksplisit.

Konfigurasi FE (environment variables; lihat `.env.example`):

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `SCAN_WORKER_URL` | `http://127.0.0.1:8000` | Alamat worker Python (sebaiknya hanya dapat dijangkau secara lokal/privat). |
| `SCAN_WORKER_TOKEN` | kosong | Token bersama dengan `WORKER_TOKEN` di worker; dikirim sebagai `X-Worker-Token`. Wajib kecuali `SCAN_DEV_MODE=true`. |
| `SCAN_DEV_MODE` | `false` | Hanya untuk pengembangan lokal: mengizinkan `http://`/`fixture://` dan host loopback. Jangan aktifkan di produksi. |
| `SCAN_MAX_PAGES_PER_CHAPTER` | `300` | Validasi ulang di FE saat ingest. |
| `SCAN_MAX_BYTES_PER_CHAPTER` | `157286400` | 150 MiB per chapter. |
| `SCAN_MAX_BYTES_PER_IMAGE` | `15728640` | 15 MiB per gambar. |
| `SCAN_MIN_FREE_BYTES` | `1073741824` | Ruang disk bebas minimum sebelum unduhan dimulai (jika kurang: `INSUFFICIENT_DISK`). |
| `SCAN_POLL_MS` | `1000` | Interval FE memantau worker. |
| `SCAN_WORKER_UNREACHABLE_S` | `60` | Setelah worker tidak terjangkau selama ini, chapter yang berjalan ditandai `FAILED` (`WORKER_UNAVAILABLE`). |
| `SCAN_DRAFT_EXPIRY_DAYS` | `7` | Draft yang tidak diubah selama ini dibuang otomatis beserta berkasnya. |
| `LEMBAR_DATA_DIR` | `./data` | Lokasi `db.json` dan `media/` (berguna untuk pengujian). |

**Batas ukuran.** Batas jalur Scan Import — **300 halaman**, **150 MiB per chapter**, **15 MiB per gambar** (sampul tetap ≤ 5 MB) — berlaku **hanya** untuk Scan Import. Batas unggah manual **tidak berubah**: maksimum **80 halaman** dan **28 MB** total untuk unggahan gambar chapter, **5 MB** per sampul/gambar, dan **20 MB** per PDF.

**Keamanan.** Semua endpoint `/api/admin/scan*` memerlukan sesi admin. Browser tidak pernah berbicara langsung dengan worker; FE hanya memanggil rute worker tetap, tidak meneruskan cookie browser, dan tidak mengikuti URL dari worker. URL sumber melewati guard SSRF (`lib/net-guard.js`), dan draft hanya dapat dilihat admin (`/media/_drafts/` memerlukan sesi admin; path dinormalisasi lebih dulu sehingga `//`, `/./`, `%2e`, `%2f`, `\`, dan huruf besar tidak dapat melewatinya). Pratinjau sampul draft juga tersedia lewat `GET /api/admin/scan/:draftId/cover`. Respons draft memuat `chaptersTotal`, `sourceCanonicalUrl`, `comic.coverPreviewUrl`, `publishable`, dan `blockers` (kode yang sama dengan galat publish). Publish diserialkan per draft: panggilan paralel kedua mendapat `409 ALREADY_PUBLISHED`, dan perubahan lain saat publish berjalan ditolak `409 PUBLISH_IN_PROGRESS`. Katalog publik (`/api/catalog`) tidak memuat daftar halaman; reader mengambilnya dari `GET /api/comics/:id/chapters/:chapterId/pages`.

## Panduan menjalankan (FE + worker)

Dua repo terpisah: **Front-End-Web-Mahnwa** (repo ini) dan **Back-End-Web-Mahnwa** (worker Python). Semua environment variable FE:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / acak (dicetak di terminal) | Login admin. Set kata sandi tetap sebelum mengekspos server. |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Alamat dengar. |
| `NODE_ENV` | — | `production` ⇒ cookie sesi bertanda `Secure` (butuh `localhost`/HTTPS). |
| `LEMBAR_DATA_DIR` | `./data` | `db.json` dan `media/`. |
| `SCAN_WORKER_URL` | `http://127.0.0.1:8000` | Alamat worker. |
| `SCAN_WORKER_TOKEN` | — (wajib) | Harus sama dengan `WORKER_TOKEN` worker. FE tetap start bila kosong/berbeda, tetapi worker menolak (401) dan Scan Import melaporkan `WORKER_UNAVAILABLE` (502). |
| `SCAN_DEV_MODE` | `false` | Hanya lokal. |
| `SCAN_MAX_PAGES_PER_CHAPTER` / `SCAN_MAX_BYTES_PER_CHAPTER` / `SCAN_MAX_BYTES_PER_IMAGE` | `300` / `157286400` / `15728640` | Validasi ulang saat ingest. |
| `SCAN_MIN_FREE_BYTES` / `SCAN_POLL_MS` / `SCAN_WORKER_UNREACHABLE_S` / `SCAN_DRAFT_EXPIRY_DAYS` / `SCAN_INGEST_CONCURRENCY` | `1073741824` / `1000` / `60` / `7` / `2` | Lihat tabel Scan Import di atas (`SCAN_INGEST_CONCURRENCY` = jumlah gambar yang diterima FE paralel). |

Variabel worker (`WORKER_TOKEN`, `WORKER_BIND`, `WORKER_PORT`, `PUBLIC_BASE_URL`, `SCAN_ALLOWED_HOSTS`, …) didokumentasikan lengkap di README repo BE.

### Hubungan variabel FE ↔ worker

| FE | Worker (BE) | Aturan |
| --- | --- | --- |
| `SCAN_WORKER_URL` (default `http://127.0.0.1:8000`) | `WORKER_BIND` + `WORKER_PORT` (default `127.0.0.1:8000`) | Alamat yang dipakai FE untuk memanggil worker harus menunjuk ke bind/port worker. Satu-satunya alamat worker yang dipakai FE; URL di dalam respons/manifest worker **tidak** diikuti. |
| `SCAN_WORKER_TOKEN` | `WORKER_TOKEN` | **Harus identik.** Dikirim FE sebagai header `X-Worker-Token`. Worker wajib memilikinya (kecuali `SCAN_DEV_MODE=true`, hanya lokal); FE mengirim apa adanya, jadi nilai kosong/berbeda berujung 401 dari worker. |
| — | `PUBLIC_BASE_URL` | Basis absolut untuk field `url` di manifest chapter (mis. `http://worker:8000`). Isi sama dengan `SCAN_WORKER_URL` seperti yang terlihat dari klien manifest; kosong = path relatif (`/worker/v1/...`). FE memakai `SCAN_WORKER_URL`, bukan `PUBLIC_BASE_URL`, jadi salah isi `PUBLIC_BASE_URL` tidak memutus FE tetapi membuat `url` di manifest keliru. |
| `SCAN_DEV_MODE` | `SCAN_DEV_MODE` | Nyalakan di keduanya (hanya lokal) agar `http://` + host loopback/privat yang ada di `SCAN_ALLOWED_HOSTS` diizinkan. |
| — | `SCAN_ALLOWED_HOSTS` | Sumber yang boleh di-scan (daftar host, koma). Kosong = Scan Import nonaktif. |

### Memulai kedua layanan

**Cara cepat (lokal, satu perintah)** — dari repo FE, repo BE di folder sebelahnya (atau `BE_DIR=...`):

```bash
scripts/dev-start.sh        # fixture :9100 + worker :8000 + FE :3000; Ctrl+C menghentikan semuanya
```

Login `admin` / `admin-dev` (hanya dev), buka `http://127.0.0.1:3000/#admin` → tab **Scan Import** → tempel `http://127.0.0.1:9100/menara-biru/manifest.json`. Port/token dapat diubah lewat `FE_PORT`, `WORKER_PORT`, `FIXTURE_PORT`, `WORKER_TOKEN`, `ADMIN_PASSWORD`; log di `/tmp/lembar-dev/`. Konten sumber hanya placeholder orisinal buatan generator.

**Manual (dua terminal)**

```bash
# 1) Worker (repo BE)
python -m venv .venv && . .venv/bin/activate && pip install fastapi "uvicorn[standard]" httpx pydantic sqlalchemy
export WORKER_TOKEN="$(openssl rand -hex 24)" SCAN_ALLOWED_HOSTS="sumber.contoh.org" PUBLIC_BASE_URL="http://127.0.0.1:8000"
python -m app                                  # 127.0.0.1:8000, cek: curl http://127.0.0.1:8000/health

# 2) FE (repo FE)
export SCAN_WORKER_URL="http://127.0.0.1:8000" SCAN_WORKER_TOKEN="<token yang sama>" ADMIN_PASSWORD="kata-sandi-kuat"
npm start                                      # 127.0.0.1:3000
```

**Docker** — `Dockerfile` ada di masing-masing repo (repo tetap terpisah). Contoh compose lintas-repo ada di `docker-compose.example.yml` (di samping `REPORT.md`, bukan bagian dari salah satu repo); worker tidak dipublish ke host, hanya FE di `127.0.0.1:3000`. Catatan: image worker hanya memuat dependensi scan-import (kode legacy Playwright/img2pdf tidak ikut); image FE memakai `NODE_ENV=production` sehingga cookie sesi bertanda `Secure` — akses lewat `localhost` atau reverse proxy TLS.

## Pengujian

```powershell
npm test
```

Menjalankan `node --test test/` (tanpa dependensi tambahan).

## Iklan

Slot halaman ditandai sebagai **IKLAN** dan kosong secara default. Pengaturan nama penyedia dan unit iklan di panel hanya menyimpan konfigurasi; kode ini belum menyertakan SDK, akun, atau persetujuan penyedia. Karena itu tidak ada iklan yang diklaim aktif atau disetujui.

## Batas demo

Untuk metadata Kiryuu tanpa berkas lokal, reader menampilkan pesan bahwa chapter belum tersedia. Pembaca tidak diarahkan ke situs eksternal. Formulir Hubungi/Laporkan memberi konfirmasi lokal saja dan tidak mengirim data. Favorit serta riwayat tetap di browser yang sama. Login admin memakai satu akun yang dikonfigurasi melalui environment; akun pembaca dapat mendaftar sendiri. Sebelum melayani pengguna umum, gunakan HTTPS dan kebijakan retensi sesuai kebutuhan.
