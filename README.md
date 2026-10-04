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

Impor chapter Kiryuu dimulai dari tab Admin → Chapter: pilih komik, isi URL seri HTTPS `v7.kiryuu.to/manga/...`, nomor chapter, lalu antrekan impor. Worker memakai HTTP standar dengan identitas yang transparan, mengecek `robots.txt` di host halaman dan gambar, memberi jeda minimal 1,2 detik per host, membatasi chapter sampai 80 halaman dan total 28 MB, lalu menyimpan gambar bernomor ke `data/media/<slug-komik-id>/chapters/chapter-<nomor>/`. Impor hanya dijalankan atas permintaan admin dan tidak mengikuti jadwal konektor metadata.

Jika host menolak akses, mengirim CAPTCHA/halaman anti-bot, atau robots melarang URL, worker menghentikan pekerjaan, menandai chapter gagal, menonaktifkan konektor Kiryuu, dan menampilkan pesan beserta `Retry-After` (bila ada) pada panel admin. Tidak ada upaya melewati pemeriksaan, memakai proxy, atau menjalankan browser otomatis. Kiryuu dan host CDN belum diverifikasi berhasil dari lingkungan ini; keberhasilan impor bergantung pada izin penggunaan konten dan metode akses yang diizinkan oleh sumber. Bila halaman memakai proteksi atau gambar tidak dapat diakses secara langsung, gunakan unggah gambar/PDF lokal. Shinigami tetap nonaktif sampai ada metode akses publik yang diizinkan dan diverifikasi.

Konektor Feed Publik menerima URL JSON, RSS, atau Atom yang memang boleh diakses. Konektor memeriksa `robots.txt`, memakai jeda, timeout, cache, deduplikasi, dan batas respons. Feed dibatasi paling banyak 30 entri metadata per proses. Tidak ada halaman chapter atau gambar yang diambil dari feed. Pemeriksaan `robots.txt` tidak menggantikan izin maupun ketentuan layanan sumber.

Konektor Sumber Demo Lokal memakai fixture JSON dan ilustrasi SVG orisinal di `public/demo-source/`. Ini adalah data demonstrasi lokal, bukan hasil scraping situs lain. Pengaturan jadwal default-nya mati dan hanya berlaku saat server berjalan.

## Iklan

Slot halaman ditandai sebagai **IKLAN** dan kosong secara default. Pengaturan nama penyedia dan unit iklan di panel hanya menyimpan konfigurasi; kode ini belum menyertakan SDK, akun, atau persetujuan penyedia. Karena itu tidak ada iklan yang diklaim aktif atau disetujui.

## Batas demo

Untuk metadata Kiryuu tanpa berkas lokal, reader menampilkan pesan bahwa chapter belum tersedia. Pembaca tidak diarahkan ke situs eksternal. Formulir Hubungi/Laporkan memberi konfirmasi lokal saja dan tidak mengirim data. Favorit serta riwayat tetap di browser yang sama. Login admin memakai satu akun yang dikonfigurasi melalui environment; akun pembaca dapat mendaftar sendiri. Sebelum melayani pengguna umum, gunakan HTTPS dan kebijakan retensi sesuai kebutuhan.
