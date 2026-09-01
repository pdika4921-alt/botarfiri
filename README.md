# 🏢 Telkom Validator — Pasang Baru Jaringan

Aplikasi validasi pekerjaan pasang baru dengan Bot Telegram + OCR + Dashboard Web.

---

## 📁 Struktur Proyek

```
telkom-validator/
└── backend/
    ├── public/
    │   ├── uploads/        ← foto otomatis tersimpan di sini
    │   └── index.html      ← dashboard web
    ├── database.js         ← skema SQLite
    ├── server.js           ← server Express + Bot Telegram + OCR
    ├── package.json
    ├── .env.example        ← template konfigurasi
    └── telkom.db           ← database (auto-buat saat pertama run)
```

---

## ⚙️ Instalasi

### 1. Buat Bot Telegram

1. Chat `@BotFather` di Telegram → `/newbot`
2. Catat **TOKEN** yang diberikan

### 2. Setup Proyek

```bash
cd telkom-validator/backend

# Salin file env
cp .env.example .env

# Edit .env → isi TOKEN bot Anda
# TELEGRAM_TOKEN=1234567890:ABCdef...

# Install dependensi
npm install
```

### 3. Jalankan Server

```bash
node server.js
# atau untuk auto-reload saat development:
npm run dev
```

### 4. Buka Dashboard

Buka browser: **http://localhost:3000**

---

## 📨 Format Laporan Telegram

Kirim pesan ke bot dengan format berikut:

```
NIK TEKNISI: 123456789
NAMA TEKNISI: Budi Santoso
WONUM: WO-2024-001
SC: SC-JKT-001
STO: SKJ
JUMLAH LAYANAN: 2P
NO. INTERNET: 08123456789
NO. VOICE: 02112345678
DATEK ODP: ODP-SKJ-001
PORT ODP: 01
VALINS ID: VL-001
P. DC: 15m
LOKASI PELANGGAN: Jl. Merdeka No. 1, Jakarta
LOKASI ODP: Pojok Jl. Merdeka - Tiang No. 5
```

---

## 📸 Kirim Foto via Telegram

Kirim foto dengan **caption** untuk OCR otomatis:

| Caption | Fungsi |
|---------|--------|
| `QR ODP buka` | Foto ODP terbuka + OCR |
| `QR ODP tutup` | Foto ODP tertutup + OCR |
| `QR DC` | Foto DC + OCR |

Bot akan otomatis OCR dan menyimpan teks ke database.

---

## 🤖 Perintah Bot

| Perintah | Fungsi |
|----------|--------|
| `/start` atau `/help` | Panduan penggunaan |
| `/status WO-2024-001` | Cek status pekerjaan |
| `/list` | 10 pekerjaan terakhir |

---

## 🌐 REST API

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET | `/api/jobs` | Semua pekerjaan |
| GET | `/api/jobs?status=PENDING` | Filter status |
| GET | `/api/jobs?search=budi` | Cari data |
| GET | `/api/jobs/:id` | Detail pekerjaan |
| PATCH | `/api/jobs/:id/status` | Update status |
| GET | `/api/stats` | Statistik |

**Contoh PATCH:**
```json
PATCH /api/jobs/1/status
{ "status": "VALID" }
```

---

## 📊 Status Validasi

| Status | Keterangan |
|--------|------------|
| 🟡 PENDING | Baru masuk, belum divalidasi |
| ✅ VALID | Disetujui validator |
| ❌ REJECT | Ditolak |

---

## 🔧 Troubleshooting

**Bot tidak merespons?**
- Pastikan TOKEN benar di file `.env`
- Restart server: `Ctrl+C` lalu `node server.js`

**OCR lambat?**
- Normal untuk gambar besar — Tesseract.js memproses di server
- Kompres foto sebelum kirim untuk hasil lebih cepat

**Database error?**
- Hapus file `telkom.db` lalu restart server (data akan hilang)
