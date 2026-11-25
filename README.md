# Adu Penalti Pro — Monokrom Multiplayer

Game adu penalti (Mode Lokal + Online Multiplayer) dengan backend **Express + Neon Postgres**.
Tampilan (HTML/CSS/Tailwind/canvas) **tidak diubah** dari file asli; hanya lapisan online yang
dulunya Firebase diganti dengan API ke Neon.

## Struktur

```
public/index.html   HTML + CSS asli (identik)
public/js/app.js    Logika game asli + klien API (menggantikan Firebase)
server.js           Express: REST API + real-time (Server-Sent Events)
db/schema.sql       Skema tabel Neon
scripts/migrate.js  Menjalankan schema.sql
```

## Cara menjalankan

1. Buat project di https://console.neon.tech lalu salin **connection string**.
2. `cp .env.example .env` dan isi `DATABASE_URL`.
3. Jalankan:
   ```bash
   npm install
   npm run db:migrate   # membuat tabel penalty_rooms
   npm start            # http://localhost:3000
   ```

Tanpa `DATABASE_URL`, Mode Lokal tetap jalan dan Mode Online otomatis nonaktif.

## API

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/health` | Cek server & database |
| POST | `/api/rooms` | Buat room |
| GET | `/api/rooms/:code` | Ambil data room |
| POST | `/api/rooms/:code/join` | Gabung sebagai P2 (atomik) |
| PATCH | `/api/rooms/:code` | Update room (mendukung path seperti `p1.scores`) |
| GET | `/api/rooms/:code/events` | Stream real-time (SSE) |

Identitas pemain: UUID anonim di `localStorage`, dikirim lewat header `x-user-id`.

## Catatan

- Real-time memakai SSE + polling versi baris di Neon (±600 ms), jadi tidak butuh WebSocket
  dan tetap benar jika server dijalankan lebih dari satu instance. Karena itu hosting harus
  mendukung proses Node yang terus hidup (Render, Railway, Fly.io, VPS), bukan serverless murni.
- Room tidak aktif > 24 jam dihapus otomatis.
- Server hanya mengizinkan pemain di dalam room mengubah room tersebut dan melarang perubahan `uid`.
