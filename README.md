# CCTV Monitor

Mengambil gambar + data dari API CCTV setiap 10 menit, menyimpannya ke SQLite, dan menampilkannya di dashboard.
Tanpa `npm install`. Butuh **Node.js 22.13 atau lebih baru** (memakai `node:sqlite` bawaan).

## Menjalankan

    node server.js

Buka http://localhost:3001 (halaman Data) dan http://localhost:3001/trends (halaman Tren).

## Pengaturan (environment variable, semuanya opsional)

| Variabel       | Default                    | Keterangan                                   |
|----------------|----------------------------|----------------------------------------------|
| API_BASE       | http://36.94.68.175:5000   | Alamat dasar API sumber                      |
| CAMERAS        | cctv-1                     | Daftar kamera, pisahkan dengan koma          |
| INTERVAL_MIN   | 10                         | Selang pengambilan (menit)                   |
| PORT           | 3001                       | Port dashboard                               |
| HOST           | 127.0.0.1                  | Pakai 0.0.0.0 agar bisa diakses dari luar    |
| DATA_DIR       | ./data                     | Lokasi monitor.db dan folder images/         |
| TIMEOUT_MS     | 30000                      | Batas waktu setiap permintaan ke API (ms)    |

Contoh: `HOST=0.0.0.0 PORT=8080 node server.js`

## Menjalankan dengan Docker

Image memakai Node.js 22 (dibutuhkan minimal 22.13 untuk `node:sqlite`) dan tidak perlu `npm install` karena aplikasi hanya menggunakan modul bawaan Node.js.

    docker build -t cctv-monitor .
    docker run -d --name cctv-monitor --restart unless-stopped --env-file .env -p 3001:3001 -v cctv-monitor-data:/app/data cctv-monitor

Dashboard tersedia di http://localhost:3001. Volume `cctv-monitor-data` menyimpan database SQLite dan gambar supaya tetap ada ketika container dibuat ulang. Sesuaikan `CAMERAS` dan `API_BASE` pada `.env` dengan instalasi Anda. Jangan masukkan rahasia ke dalam image; `.env` tidak disalin saat proses build.

Dashboard tidak memakai login. Jika dibuka ke jaringan luar, pasang di belakang reverse proxy dengan autentikasi.

## Alur tiap siklus

1. `GET /api/flagged/<kamera>`, gambar disimpan sebagai `data/images/<kamera>_<waktu>_<acak>.jpg` (nama unik).
2. `GET /api/dashboard`, data disimpan ke tabel `readings` bersama nama file gambar tadi (`image_file`).
3. Jika langkah 2 gagal, gambar dari langkah 1 dihapus agar tidak ada file yatim.
   Jika hanya gambar yang gagal, data tetap disimpan dengan `image_file` kosong.

## Struktur

    server.js          poller + API + web server
    public/index.html  dashboard data (filter, sorting, pagination, detail, CSV)
    public/trends.html dashboard tren (grafik)
    data/monitor.db    database SQLite (dibuat otomatis; di container ada pada volume /app/data)
    data/images/       gambar yang tersimpan

Agar jalan terus di server: `pm2 start server.js --name cctv-monitor` atau buat service systemd.
