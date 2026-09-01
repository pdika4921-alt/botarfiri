require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const https      = require('https');
const TelegramBot = require('node-telegram-bot-api');
const { createWorker } = require('tesseract.js');
const db         = require('./database');
const { hashPassword, verifyPassword } = require('./database');

// Jangan mati hanya karena error Telegram/bot — log & lanjut (penting utk shared hosting)
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ unhandledRejection (diamankan):', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ uncaughtException (diamankan):', err && err.message ? err.message : err);
});

// ── Config ──────────────────────────────────────────────
const TOKEN      = process.env.TELEGRAM_TOKEN || 'ISI_TOKEN_BOT_ANDA';
const PORT       = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// ────────────────────────────────────────────────────────

function genToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'telkom-validator-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Multer (upload web) ──────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png'];
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) return cb(null, true);
    cb(new Error('Format foto harus JPG/PNG'));
  }
});

// ── Auth middlewares ─────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Otentikasi diperlukan' });
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Otentikasi diperlukan' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Akses ditolak' });
    next();
  };
}

// ── Telegram Bot ─────────────────────────────────────────
let bot;
if (TOKEN && !TOKEN.includes('ISI_TOKEN')) {
  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', (err) => console.error('⚠️ polling_error:',
    err && err.message ? err.message : err));
  bot.on('error', (err) => console.error('⚠️ bot error:',
    err && err.message ? err.message : err));
  console.log('🤖 Bot Telegram aktif...');
} else {
  console.log('🤖 Bot Telegram dinonaktifkan (token tidak valid).');
}

// ── OCR Helper ───────────────────────────────────────────
const OCR_CACHE = path.join(__dirname, 'tessdata');
async function runOCR(imagePath) {
  let worker;
  try {
    worker = await createWorker(['ind', 'eng'], 1, { cachePath: OCR_CACHE, logger: () => {} });
    const { data: { text } } = await worker.recognize(imagePath);
    return (text || '').trim();
  } catch (e) {
    console.error('⚠️ OCR gagal:', e.message);
    return '';
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

// Deteksi SN (serial number) dari teks OCR label di bawah QR (format ONT umum)
function extractSN(text) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').replace(/\|/g, 'I').trim();
  // 1) SN setelah penanda (SN, S/N, No Seri, Nomer Seri, Serial)
  const m = clean.match(/(?:SN|S\/N|SNR|SERI|NOMER\s*SERI|NO\.?\s*SERI|SERIAL|NO\.?\s*SN)\s*[:=.\-]?\s*([A-Z0-9][A-Z0-9\-]{5,})/i);
  if (m) return m[1].replace(/\s+/g, '').trim();
  // 2) Format ONT khas: 4 huruf kapital + 6-12 digit (mis HWTC12345678, ALCLF12345678, ZTEGC12345678)
  const m2 = clean.match(/\b([A-Z]{4}\d{6,12})\b/);
  if (m2) return m2[1];
  // 3) Awalan 3-5 huruf kapital + minimal 6 digit
  const m3 = clean.match(/\b([A-Z]{3,5}\d{6,})\b/);
  if (m3) return m3[1];
  // 4) run alfanumerik kapital panjang (fallback)
  const m4 = clean.match(/\b([A-Z0-9]{10,})\b/);
  return m4 ? m4[1] : '';
}

// ── Download foto dari Telegram ──────────────────────────
async function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(fileUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

// ── Status emoji ─────────────────────────────────────────
const statusIcon = { PENDING: '🟡', VALID: '✅', REJECT: '❌' };

// ── Rekam tautan chat teknisi (mencegah bentrok antar teknisi) ──
async function bindChat(nik, chatId) {
  if (!nik || chatId == null) return;
  await db.runP(
    `INSERT INTO user_chats (nik, chat_id, updated_at)
     VALUES (?,?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE SET nik=excluded.nik, updated_at=CURRENT_TIMESTAMP`,
    [nik, chatId]
  ).catch(() => {});
}

// ── Ambil NIK yang tertaut ke chat tertentu ──────────────
async function getChatNIK(chatId) {
  const row = await db.getP('SELECT nik FROM user_chats WHERE chat_id=?', [chatId]).catch(() => null);
  return row ? row.nik : null;
}

// ── Fungsional: target notifikasi tambahan (staf/grup) ───
async function getNotifyTargets() {
  const row = await db.getP(`SELECT value FROM settings WHERE key='notify_targets'`).catch(() => null);
  return row && row.value ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
}

async function notifyAdmins(text) {
  if (!bot) return;
  const targets = await getNotifyTargets();
  for (const t of targets) {
    if (t && !isNaN(Number(t))) bot.sendMessage(t, text, { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// ── Kirim revisi ke chat teknisi + notifikasi staf ───────
async function notifyRevision(job) {
  if (!bot) return;
  // Kirim ke SEMUA chat teknisi yang bisa dijangkau: akun + user_chats
  const targets = new Set();
  const acct = await db.getP('SELECT chat_id FROM users WHERE nik=? AND chat_id IS NOT NULL', [job.nik]).catch(() => null);
  if (acct && acct.chat_id != null) targets.add(String(acct.chat_id));
  const chats = await db.allP('SELECT DISTINCT chat_id FROM user_chats WHERE nik=?', [job.nik]).catch(() => []);
  (chats || []).forEach(c => { if (c && c.chat_id != null) targets.add(String(c.chat_id)); });
  const usr = await db.getP('SELECT login_token FROM users WHERE nik=?', [job.nik]).catch(() => null);

  const icon = job.status === 'REJECT' ? '❌' : '✅';
  const editLink = job.status === 'REJECT' && usr && usr.login_token
    ? `\n━━━━━━━━━━━━━━\n✏️ *Perbaiki revisi:* klik link di bawah (sudah login otomatis sebagai Anda)\n🔗 ${PUBLIC_URL}/auth/auto?token=${usr.login_token}&job=${job.id}`
    : '';
  const msg = `${icon} *Pekerjaan #${job.id} — ${job.status}*\n` +
    `🧑‍🔧 NIK: ${job.nik || '-'} | ${job.nama || '-'}\n` +
    `🎫 WONUM: ${job.wonum || '-'}\n` +
    (job.review_note ? `📝 Catatan Validator:\n_${job.review_note}_\n` : '') +
    (job.status === 'REJECT' ? `\nSilakan perbaiki dan kirim ulang.${editLink}` : `\nPekerjaan Anda dinyatakan VALID.`);

  // kirim ke semua chat teknisi pemilik yang bisa dijangkau
  for (const t of targets) bot.sendMessage(t, msg, { parse_mode: 'Markdown' }).catch(() => {});
  // kirim ringkasan ke staf/grup yang dikonfigurasi
  await notifyAdmins(`${icon} *Status Pekerjaan #${job.id} → ${job.status}*\n${msg.replace(/\n/g, '\n')}`);
}

// Kirim laporan lengkap (semua foto + ringkasan) ke penerima tambahan
const REPORT_FIELDS = [
  ['foto_qr_odp', 'QR ODP'], ['foto_qr_dc', 'QR DC'],
  ['foto_redaman_odp', 'Redaman ODP'], ['foto_clamp_hook', 'Clamp Hook'],
  ['foto_sclamp_tiang', 'S-Clamp Tiang'], ['foto_ikr', 'IKR'],
  ['foto_belakang_sn', 'Belakang SN ONT'], ['foto_odp_buka', 'ODP Terbuka'],
  ['foto_odp_tutup', 'ODP Tertutup']
];
async function sendJobReport(job) {
  if (!bot) return;
  const fpath = (f) => f ? path.join(UPLOAD_DIR, f) : null;

  // Tujuan: semua chat yang bisa dijangkau bot —
  //  target terkonfigurasi (staf/grup) + chat_id akun + SEMUA user_chats teknisi
  const targets = new Set();
  (await getNotifyTargets()).filter(t => t != null && String(t).trim() !== '').forEach(t => targets.add(String(t)));
  const acct = await db.getP('SELECT chat_id FROM users WHERE nik=? AND chat_id IS NOT NULL', [job.nik]).catch(() => null);
  if (acct && acct.chat_id != null) targets.add(String(acct.chat_id));
  const chats = await db.allP('SELECT DISTINCT chat_id FROM user_chats WHERE nik=?', [job.nik]).catch(() => []);
  (chats || []).forEach(c => { if (c && c.chat_id != null) targets.add(String(c.chat_id)); });
  if (!targets.size) return;

  // Album (media group) semua foto yang tersedia
  const media = REPORT_FIELDS
    .map(([field, label]) => ({ field, label, file: fpath(job[field]) }))
    .filter(x => x.file && fs.existsSync(x.file))
    .map(x => ({ type: 'photo', media: x.file }));

  const header =
    `📋 *Laporan Pekerjaan #${job.id}*\n` +
    `🧑‍🔧 Teknisi: ${job.nik || '-'} | ${job.nama || '-'}\n` +
    `🎫 WONUM: ${job.wonum || '-'}\n` +
    `🔢 SC: ${job.sc || '-'}\n` +
    `🏢 STO: ${job.sto || '-'} | 📦 Layanan: ${job.layanan || '-'}\n` +
    (job.sn_odp ? `🆔 SN ODP: ${job.sn_odp}\n` : '') +
    (job.sn_dc ? `🆔 SN DC: ${job.sn_dc}\n` : '') +
    (job.sn_issue ? `⚠️ *SN belum jelas terbaca* — perlu cek manual.\n` : '') +
    `🔄 Status: *${job.status || 'PENDING'}*`;

  const detail = media.length ? '' : `\n⚠️ (foto belum tersedia)`;

  for (const t of targets) {
    try {
      // 1 pesan ringkasan (teks)
      await bot.sendMessage(t, header + detail, { parse_mode: 'Markdown' });
      // album semua foto (maks 10, kita punya 9)
      if (media.length) {
        await bot.sendMediaGroup(t, media).catch(async () => {
          // fallback: kirim satu per satu bila album gagal
          for (const m of media) await bot.sendPhoto(t, m.media).catch(() => {});
        });
      }
    } catch (e) { /* lewati target yang gagal */ }
  }
}

// ── Wizard Bot Telegram (tanya-jawab bertahap) ───────────
if (bot) {
  const sessions = new Map(); // chatId -> { step, data }

  const STEPS = [
    { key: 'wonum',            label: 'WONUM',                      type: 'text',     prompt: '🎫 Masukkan *WONUM*:' },
    { key: 'sc',               label: 'SC',                         type: 'text',     prompt: '🔢 Masukkan *SC*:' },
    { key: 'ocr_qr_odp',       label: 'Foto QR ODP',                type: 'photo',    store: 'foto_qr_odp',  ocr: 'ocr_qr_odp',  sn: 'sn_odp',  prompt: '📷 Kirim *FOTO QR ODP* (pastikan teks *SN* di bawah QR terbaca jelas).\n(Bot otomatis membaca SN)' },
    { key: 'ocr_qr_dc',        label: 'Foto QR DC',                 type: 'photo',    store: 'foto_qr_dc',   ocr: 'ocr_qr_dc',   sn: 'sn_dc',   prompt: '📷 Kirim *FOTO QR DC* (pastikan teks *SN* di bawah QR terbaca jelas).\n(Bot otomatis membaca SN)' },
    { key: 'sto',              label: 'STO',                        type: 'choice',   options: ['SKJ', 'CSL'], prompt: '🏢 Pilih *STO*:' },
    { key: 'layanan',          label: 'Jumlah Layanan',             type: 'choice',   options: ['1P', '2P', '3P'], prompt: '📦 Pilih *JUMLAH LAYANAN*:' },
    { key: 'no_internet',      label: 'No. Internet',               type: 'text',     prompt: '🌐 Masukkan *NO. INTERNET*:' },
    { key: 'no_voice',         label: 'No. Voice',                  type: 'text',     skippable: true, prompt: '☎️ Masukkan *NO. VOICE* (ketik /skip jika kosong):' },
    { key: 'datek_odp',        label: 'Datek ODP',                  type: 'text',     prompt: '📅 Masukkan *DATEK ODP*:' },
    { key: 'port_odp',         label: 'Port ODP',                   type: 'text',     prompt: '🔌 Masukkan *PORT ODP*:' },
    { key: 'valins_id',        label: 'Valins ID',                  type: 'text',     prompt: '🆔 Masukkan *VALINS ID*:' },
    { key: 'p_dc',             label: 'Panjang DC',                 type: 'text',     prompt: '📏 Masukkan *P. DC (Panjang DC)*:' },
    { key: 'lokasi_pelanggan', label: 'Lokasi Pelanggan',           type: 'location', prompt: '📍 *SHARE LOCATION PELANGGAN*.\nTekan ikon 📎 ▶ Location, lalu kirim lokasinya:' },
    { key: 'lokasi_odp',       label: 'Lokasi ODP',                 type: 'location', prompt: '📍 *SHARE LOCATION ODP*.\nTekan ikon 📎 ▶ Location, lalu kirim lokasinya:' },
    { key: 'foto_redaman_odp', label: 'Foto Redaman ODP',           type: 'photo',    store: 'foto_redaman_odp', prompt: '📷 Kirim *FOTO REDAMAN ODP*.\n(Format JPG/PNG)' },
    { key: 'foto_clamp_hook',  label: 'Foto Clamp Hook',            type: 'photo',    store: 'foto_clamp_hook', prompt: '📷 Kirim *FOTO CLAMP HOOK*.\n(Format JPG/PNG)' },
    { key: 'foto_sclamp_tiang',label: 'Foto S-Clamp Tiang',         type: 'photo',    store: 'foto_sclamp_tiang', prompt: '📷 Kirim *FOTO S-CLAMP TIANG*.\n(Format JPG/PNG)' },
    { key: 'foto_ikr',         label: 'Foto IKR',                   type: 'photo',    store: 'foto_ikr', prompt: '📷 Kirim *FOTO IKR*.\n(Format JPG/PNG)' },
    { key: 'foto_belakang_sn', label: 'Foto Belakang SN ONT',       type: 'photo',    store: 'foto_belakang_sn', prompt: '📷 Kirim *FOTO BELAKANG SN ONT*.\n(Format JPG/PNG)' },
    { key: 'foto_odp_buka',    label: 'Foto ODP Terbuka',           type: 'photo',    store: 'foto_odp_buka', prompt: '📷 Kirim *FOTO ODP TERBUKA (BEBAS PATCHCORD)*:\n(Format JPG/PNG)' },
    { key: 'foto_odp_tutup',   label: 'Foto ODP Tertutup',          type: 'photo',    store: 'foto_odp_tutup', prompt: '📷 Kirim *FOTO ODP TERTUTUP*:\n(Format JPG/PNG)' },
  ];

  function buildKeyboard(step) {
    const rows = [];
    // Baris tombol pilihan (untuk step berpilihan)
    if (step.type === 'choice' && step.options) {
      const opts = step.options;
      for (let i = 0; i < opts.length; i += 2) {
        rows.push(opts.slice(i, i + 2).map(o => ({ text: o, callback_data: `VAL|${o}` })));
      }
    }
    // Baris tombol navigasi (selalu ada)
    const nav = [{ text: '⏪ Kembali', callback_data: 'NAV|back' }];
    if (step.skippable) nav.push({ text: '⏭ Lewati (Kosong)', callback_data: 'NAV|skip' });
    nav.push({ text: '❌ Batal', callback_data: 'NAV|cancel' });
    rows.push(nav);
    return { reply_markup: { inline_keyboard: rows } };
  }

  async function sendStep(chatId) {
    const s = sessions.get(chatId);
    if (!s) return;
    const step = STEPS[s.step];
    const opts = { parse_mode: 'Markdown', ...buildKeyboard(step) };
    await bot.sendMessage(chatId, `*Langkah ${s.step + 1}/${STEPS.length}* — ${step.label}\n──────────────────\n${step.prompt}`, opts);
  }

  function backStep(chatId) {
    const s = sessions.get(chatId);
    if (!s) return;
    if (s.step === 0) return bot.sendMessage(chatId, '⚠️ Ini langkah pertama, tidak bisa kembali.');
    s.step -= 1;
    sendStep(chatId);
  }

  // ── Menu tombol inline utama ─────────────────────────────
  const pendingInput = new Map(); // chatId -> 'nik' | 'wonum' (menunggu ketikan ulang)
  const MENU = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔐 Login dengan NIK', callback_data: 'MENU|login' }],
        [{ text: '➕ Input Pekerjaan Baru', callback_data: 'MENU|baru' }],
        [{ text: '🔍 Cek Status', callback_data: 'MENU|status' }],
        [{ text: '📋 List Pekerjaan', callback_data: 'MENU|list' }]
      ]
    }
  };
  async function showMenu(chatId, extra) {
    await bot.sendMessage(chatId,
      (extra ? extra + '\n\n' : '') +
      `🏢 *Telkom Validator Bot*\n` +
      `Pilih menu di bawah ini:`,
      { parse_mode: 'Markdown', ...MENU });
  }
  async function doLogin(chatId, nik) {
    nik = (nik || '').trim();
    if (!nik) return bot.sendMessage(chatId, '⚠️ Kirimkan *NIK* Anda.', { parse_mode: 'Markdown' });
    const user = await db.getP('SELECT * FROM users WHERE nik=?', [nik]).catch(() => null);
    if (!user || user.role !== 'teknisi')
      return bot.sendMessage(chatId,
        `❌ NIK *${nik}* tidak terdaftar sebagai teknisi.\nHubungi admin untuk didaftarkan.`,
        { parse_mode: 'Markdown' });
    await bindChat(nik, chatId);
    return bot.sendMessage(chatId,
      `✅ Login berhasil.\n` +
      `👤 NIK: *${user.nik}*\n🧑‍🔧 Nama: *${user.nama}*\n\n` +
      `Tekan tombol di bawah untuk mulai menginput:`, { parse_mode: 'Markdown', ...MENU });
  }
  async function doStatus(chatId, wonum) {
    wonum = (wonum || '').trim();
    if (!wonum) return bot.sendMessage(chatId, '⚠️ Kirimkan *WONUM* yang mau dicek.', { parse_mode: 'Markdown' });
    return db.get('SELECT * FROM jobs WHERE wonum=? ORDER BY id DESC LIMIT 1', [wonum], (err, row) => {
      if (err || !row) return bot.sendMessage(chatId, `❌ WONUM ${wonum} tidak ditemukan.`);
      const icon = statusIcon[row.status] || '⬜';
      bot.sendMessage(chatId,
        `${icon} *Status WONUM: ${wonum}*\n` +
        `👤 ${row.nama || '-'} (${row.nik})\n` +
        `📋 SC: ${row.sc || '-'} | STO: ${row.sto || '-'}\n` +
        `🔄 Status: *${row.status}*\n` +
        (row.review_note ? `📝 Catatan: ${row.review_note}\n` : ''),
        { parse_mode: 'Markdown' }
      );
    });
  }

  async function startWizard(chatId) {
    const linkedNik = await getChatNIK(chatId);
    const user = linkedNik ? await db.getP('SELECT * FROM users WHERE nik=?', [linkedNik]).catch(() => null) : null;
    if (!user || user.role !== 'teknisi')
      return bot.sendMessage(chatId,
        `❌ Anda belum login.\nTekan tombol *Login dengan NIK* di bawah untuk masuk:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔐 Login dengan NIK', callback_data: 'MENU|login' }]] } }
      );
    sessions.set(chatId, { step: 0, data: { nik: user.nik, nama: user.nama } });
    await bot.sendMessage(chatId, `👤 Login sebagai *${user.nama}* (${user.nik}). Mulai input data...`, { parse_mode: 'Markdown' });
    return sendStep(chatId);
  }

  async function listJobs(chatId) {
    const chat = await db.getP('SELECT nik FROM user_chats WHERE chat_id=?', [chatId]).catch(() => null);
    const nik = chat ? chat.nik : null;
    let sql = 'SELECT id,wonum,nama,status FROM jobs';
    const params = [];
    if (nik) { sql += ' WHERE nik=?'; params.push(nik); }
    sql += ' ORDER BY id DESC LIMIT 10';
    return db.all(sql, params, (err, rows) => {
      if (err || !rows.length) return bot.sendMessage(chatId, 'Belum ada data pekerjaan.');
      const list = rows.map(r => `${statusIcon[r.status]||'⬜'} #${r.id} | ${r.wonum} | ${r.nama||'-'} | ${r.status}`).join('\n');
      bot.sendMessage(chatId, `📋 *Pekerjaan (10 terakhir):*\n\n${list}`, { parse_mode: 'Markdown' });
    });
  }

  async function processPhoto(chatId, msg) {
    const s = sessions.get(chatId);
    if (!s) return;
    const step = STEPS[s.step];
    if (!msg.photo || !msg.photo.length) {
      return bot.sendMessage(chatId, '❌ Ini bukan foto. Kirim *foto* yang diminta atau ketik /batal.', { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, '⏳ Menerima & memproses foto...');

    const photo   = msg.photo[msg.photo.length - 1];
    const file    = await bot.getFile(photo.file_id);
    const ext     = (path.extname(file.file_path) || '.jpg').toLowerCase();
    // Validasi format: hanya JPG / JPEG / PNG
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return bot.sendMessage(chatId, '❌ Format foto tidak didukung (*' + ext + '*). Gunakan format *JPG* atau *PNG*. Silakan kirim ulang.', { parse_mode: 'Markdown' });
    }
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const fname   = `tg-${Date.now()}${ext}`;
    const destPath = path.join(UPLOAD_DIR, fname);

    try {
      await downloadFile(fileUrl, destPath);
      if (step.store) s.data[step.store] = fname;

      let ocrResult = null;
      if (step.ocr) {
        ocrResult = await runOCR(destPath);
        s.data[step.ocr] = ocrResult;
        let msg = `✅ Foto tersimpan.\n📝 Teks terbaca:\n\`${ocrResult || '(tidak ada teks)'}\``;
        // Ekstrak SN di bawah QR (untuk foto QR ODP/DC)
        if (step.sn) {
          const sn = extractSN(ocrResult);
          s.data[step.sn] = sn;
          s.data.sn_issue = (s.data.sn_issue || 0) || (sn ? 0 : 1);
          msg = sn
            ? `✅ Foto tersimpan.\n✅ *SN terbaca:* \`${sn}\``
            : `⚠️ Foto tersimpan, tapi *SN belum jelas terbaca* dari foto.\nAdmin akan cek manual. Kalau bisa mohon kirim ulang foto QR yang lebih jelas.`;
        }
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '✅ Foto tersimpan.');
      }
      advance(chatId);
    } catch (e) {
      await bot.sendMessage(chatId, '❌ Gagal memproses foto: ' + e.message);
    }
  }

  function advance(chatId) {
    const s = sessions.get(chatId);
    if (!s) return;
    s.step += 1;
    if (s.step >= STEPS.length) return finish(chatId);
    sendStep(chatId);
  }

  function finish(chatId) {
    const s = sessions.get(chatId);
    const d = s.data;
    if (d.nik) bindChat(d.nik, chatId); // tautkan chat teknisi agar revisi tidak bentrok

    db.runP(
      `INSERT INTO jobs (nik,nama,wonum,sc,sto,layanan,no_internet,no_voice,
        datek_odp,port_odp,valins_id,p_dc,lokasi_pelanggan,lokasi_odp,
        ocr_qr_odp,ocr_qr_dc,foto_qr_odp,foto_qr_dc,foto_odp_buka,foto_odp_tutup,
        foto_redaman_odp,foto_clamp_hook,foto_sclamp_tiang,foto_ikr,foto_belakang_sn,
        sn_odp,sn_dc,sn_issue)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.nik, d.nama, d.wonum, d.sc, d.sto, d.layanan,
       d.no_internet, d.no_voice, d.datek_odp, d.port_odp,
       d.valins_id, d.p_dc, d.lokasi_pelanggan, d.lokasi_odp,
       d.ocr_qr_odp, d.ocr_qr_dc, d.foto_qr_odp, d.foto_qr_dc,
       d.foto_odp_buka, d.foto_odp_tutup,
       d.foto_redaman_odp, d.foto_clamp_hook, d.foto_sclamp_tiang, d.foto_ikr, d.foto_belakang_sn,
       d.sn_odp || null, d.sn_dc || null, d.sn_issue || 0]
    ).then((r) => {
      sessions.delete(chatId);
      // buat objek job lengkap untuk laporan ke target
      const job = { id: r.lastID, nik: d.nik, nama: d.nama, wonum: d.wonum, sc: d.sc, sto: d.sto, layanan: d.layanan,
        ocr_qr_odp: d.ocr_qr_odp, ocr_qr_dc: d.ocr_qr_dc, foto_qr_odp: d.foto_qr_odp, foto_qr_dc: d.foto_qr_dc,
        foto_odp_buka: d.foto_odp_buka, foto_odp_tutup: d.foto_odp_tutup,
        foto_redaman_odp: d.foto_redaman_odp, foto_clamp_hook: d.foto_clamp_hook,
        foto_sclamp_tiang: d.foto_sclamp_tiang, foto_ikr: d.foto_ikr, foto_belakang_sn: d.foto_belakang_sn,
        sn_odp: d.sn_odp || null, sn_dc: d.sn_dc || null, sn_issue: d.sn_issue || 0 };
      sendJobReport(job);
      bot.sendMessage(chatId,
        `✅ *Berhasil! Laporan tersimpan*\n` +
        `📋 ID: #${r.lastID}\n` +
        `👤 NIK: ${d.nik} | ${d.nama}\n` +
        `🎫 WONUM: ${d.wonum}\n` +
        `🏢 STO: ${d.sto} | 📦 Layanan: ${d.layanan}\n` +
        `🔄 Status: PENDING (menunggu validasi)\n\n` +
        `Ketik /baru untuk input data berikutnya.`,
        { parse_mode: 'Markdown' }
      );
    }).catch((err) => {
      sessions.delete(chatId);
      bot.sendMessage(chatId, '❌ Gagal menyimpan data: ' + err.message);
    });
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();

    // ── Input yang sedang menunggu (NIK / WONUM via tombol menu) ──
    const pending = pendingInput.get(chatId);
    if (pending && text && !text.startsWith('/')) {
      pendingInput.delete(chatId);
      if (pending === 'nik') return doLogin(chatId, text);
      if (pending === 'wonum') return doStatus(chatId, text);
    }

    // ── Login pakai NIK (harus terdaftar sebagai teknisi) ──
    if (text.startsWith('/login')) {
      return doLogin(chatId, (text.split(' ')[1] || '').trim());
    }

    // ── Tautkan chat ke NIK (validasi teknisi) ──
    if (text.startsWith('/link')) {
      const nik = (text.split(' ')[1] || '').trim();
      if (!nik) return bot.sendMessage(chatId, 'Gunakan: /link <NIK>');
      const user = await db.getP('SELECT * FROM users WHERE nik=?', [nik]).catch(() => null);
      if (!user || user.role !== 'teknisi')
        return bot.sendMessage(chatId, `❌ NIK *${nik}* tidak terdaftar sebagai teknisi.`, { parse_mode: 'Markdown' });
      await bindChat(nik, chatId);
      return bot.sendMessage(chatId, `✅ Chat ini tertaut dengan NIK *${nik}*.\nRevisi pekerjaan akan masuk ke chat ini.`, { parse_mode: 'Markdown' });
    }

    if (text === '/start' || text === '/help') {
      const linkedNik = await getChatNIK(chatId);
      const who = linkedNik ? await db.getP('SELECT * FROM users WHERE nik=?', [linkedNik]).catch(() => null) : null;
      const logged = who && who.role === 'teknisi';
      return showMenu(chatId, logged
        ? `👋 Selamat datang kembali, *${who.nama}*! Anda sudah login.`
        : `👋 Selamat datang di *Telkom Validator Bot*.\nSilakan login dulu dengan NIK Anda.`);
    }

    if (text === '/baru') {
      return startWizard(chatId);
    }

    if (text === '/batal') {
      if (sessions.has(chatId)) { sessions.delete(chatId); return bot.sendMessage(chatId, '🚫 Input dibatalkan.'); }
      return bot.sendMessage(chatId, 'Tidak ada input yang sedang berjalan.');
    }

    if (text.startsWith('/status')) {
      return doStatus(chatId, text.split(' ')[1]);
    }

    if (text === '/list') {
      return listJobs(chatId);
    }

    const s = sessions.get(chatId);
    if (!s) return bot.sendMessage(chatId, 'Tidak ada input berjalan. Ketik /baru untuk mulai, atau /help.');

    const step = STEPS[s.step];

    if (step.type === 'location') {
      if (msg.location) {
        s.data[step.key] = `${msg.location.latitude},${msg.location.longitude}`;
        await bot.sendMessage(chatId, '✅ Lokasi diterima.');
        advance(chatId);
        return;
      }
      return bot.sendMessage(chatId, '⚠️ Kirim *SHARE LOCATION* dulu (ikon 📎 ▶ Location).', { parse_mode: 'Markdown' });
    }

    if (step.type === 'photo') return processPhoto(chatId, msg);

    if (step.type === 'text') {
      if (text === '/skip') {
        if (!step.skippable) return bot.sendMessage(chatId, '❌ Langkah ini wajib diisi.');
        s.data[step.key] = null;
        advance(chatId);
        return;
      }
      if (!text) return bot.sendMessage(chatId, '⚠️ Kirim teks yang diminta, atau /batal untuk membatalkan.');
      s.data[step.key] = text;
      advance(chatId);
    }
  });

  bot.on('callback_query', async (cb) => {
    const chatId = cb.message.chat.id;
    const s = sessions.get(chatId);

    // Tombol menu utama
    if (cb.data && cb.data.startsWith('MENU|')) {
      const act = cb.data.split('|')[1];
      if (act === 'login') {
        await bot.answerCallbackQuery(cb.id);
        pendingInput.set(chatId, 'nik');
        return bot.sendMessage(chatId, '🔐 *Login*\nSilakan ketikkan *NIK* Anda di bawah ini:', { parse_mode: 'Markdown' });
      }
      if (act === 'baru') {
        await bot.answerCallbackQuery(cb.id, { text: 'Memulai input...' });
        return startWizard(chatId);
      }
      if (act === 'status') {
        await bot.answerCallbackQuery(cb.id);
        pendingInput.set(chatId, 'wonum');
        return bot.sendMessage(chatId, '🔍 *Cek Status*\nSilakan ketikkan *WONUM* yang mau dicek:', { parse_mode: 'Markdown' });
      }
      if (act === 'list') {
        await bot.answerCallbackQuery(cb.id, { text: 'Memuat daftar...' });
        return listJobs(chatId);
      }
      return;
    }

    // Tombol navigasi
    if (cb.data && cb.data.startsWith('NAV|')) {
      await bot.answerCallbackQuery(cb.id);
      const act = cb.data.split('|')[1];
      if (act === 'cancel') {
        sessions.delete(chatId);
        return bot.editMessageText('🚫 Input dibatalkan.', { chat_id: chatId, message_id: cb.message.message_id });
      }
      if (!s) return bot.sendMessage(chatId, 'Sesi tidak aktif. Ketik /baru untuk memulai.');
      if (act === 'back') return backStep(chatId);
      if (act === 'skip') {
        const step = STEPS[s.step];
        if (!step.skippable) return bot.answerCallbackQuery(cb.id, { text: 'Langkah ini wajib diisi.', show_alert: true });
        s.data[step.key] = null;
        await bot.editMessageText(`⏭ *${step.label}*: dilewati (kosong)`, {
          chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'Markdown'
        });
        return advance(chatId);
      }
      return;
    }

    if (cb.data && cb.data.startsWith('VAL|')) {
      await bot.answerCallbackQuery(cb.id);
      if (!s) return bot.sendMessage(chatId, 'Sesi tidak aktif.');
      const value = cb.data.split('|')[1];
      const step = STEPS[s.step];
      if (step.type !== 'choice') return;
      s.data[step.key] = value;
      await bot.editMessageText(`✅ *${step.label}*: ${value}`, {
        chat_id: chatId, message_id: cb.message.message_id, parse_mode: 'Markdown'
      });
      advance(chatId);
    }
  });
}

// ════════════════════════ AUTH API ════════════════════════
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username & password wajib' });
  db.get('SELECT * FROM users WHERE username=?', [username], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Username atau password salah' });
    if (!verifyPassword(password, user.password)) return res.status(401).json({ error: 'Username atau password salah' });
    req.session.user = { id: user.id, nik: user.nik, nama: user.nama, username: user.username, role: user.role };
    res.json({ user: req.session.user });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  res.json({ user: null });
});

// ═══════════════ SETUP AWAL (admin pertama) ═══════════════
app.get('/api/setup/status', async (req, res) => {
  const needs = await db.needsSetup();
  res.json({ needsSetup: needs });
});

app.post('/api/setup', async (req, res) => {
  const needs = await db.needsSetup();
  if (!needs) return res.status(409).json({ error: 'Setup sudah selesai' });
  const { nik, nama, username, password } = req.body;
  if (!nik || !nama || !username || !password)
    return res.status(400).json({ error: 'Semua field wajib diisi' });
  try {
    await db.runP(
      'INSERT INTO users (nik, nama, username, password, role) VALUES (?,?,?,?,?)',
      [nik, nama, username, hashPassword(password), 'admin']
    );
    // langsung login
    const user = await db.getP('SELECT * FROM users WHERE username=?', [username]);
    req.session.user = { id: user.id, nik: user.nik, nama: user.nama, username: user.username, role: user.role };
    res.json({ success: true, user: req.session.user });
  } catch (e) {
    res.status(409).json({ error: 'Username/NIK sudah terpakai' });
  }
});

// ════════════════════ ADMIN: kelola user ═══════════════════
app.get('/api/users', requireRole('admin'), (req, res) => {
  db.all('SELECT id, nik, nama, username, role, chat_id, login_token FROM users ORDER BY role, id', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { nik, nama, username, password, role, chat_id } = req.body;
  if (!nik || !nama || !username || !password || !['admin','validator','teknisi'].includes(role))
    return res.status(400).json({ error: 'Data tidak lengkap / role tidak valid' });
  try {
    const r = await db.runP(
      `INSERT INTO users (nik, nama, username, password, role, chat_id, login_token) VALUES (?,?,?,?,?,?,?)`,
      [nik, nama, username, hashPassword(password), role, chat_id || null, genToken()]
    );
    res.json({ success: true, id: r.lastID });
  } catch (e) {
    res.status(409).json({ error: 'NIK atau username sudah terpakai' });
  }
});

// Buat ulang token login otomatis (link langsung-login) untuk user
app.post('/api/users/:id/token', requireRole('admin'), async (req, res) => {
  try {
    const r = await db.runP('UPDATE users SET login_token=? WHERE id=?', [genToken(), req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = await db.getP('SELECT id, nik, nama, username, role, chat_id, login_token FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true, user: u });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-login via link (teknisi tinggal klik link) ──────
app.get('/auth/auto', async (req, res) => {
  const { token, job } = req.query;
  if (!token) return res.redirect('/');
  const user = await db.getP('SELECT * FROM users WHERE login_token=?', [token]).catch(() => null);
  if (!user) return res.redirect('/?error=autologin');
  req.session.user = { id: user.id, nik: user.nik, nama: user.nama, username: user.username, role: user.role };
  // buka dashboard langsung ke halaman edit revisi bila ada job
  const target = job ? `#edit=${Number(job)}` : '#';
  res.redirect('/' + target);
});

app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
  const { nama, password, role, chat_id } = req.body;
  const sets = [];
  const params = [];
  if (nama) { sets.push('nama=?'); params.push(nama); }
  if (role && ['admin','validator','teknisi'].includes(role)) { sets.push('role=?'); params.push(role); }
  if (chat_id !== undefined) { sets.push('chat_id=?'); params.push(chat_id || null); }
  if (password) { sets.push('password=?'); params.push(hashPassword(password)); }
  sets.push('id=?'); params.push(req.params.id);
  if (sets.length === 1) return res.status(400).json({ error: 'Tidak ada perubahan' });
  try {
    const r = await db.runP(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, params);
    if (!r.changes) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const r = await db.runP('DELETE FROM users WHERE id=?', [req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════ DATA: jobs (role-aware) ═══════════════
app.get('/api/jobs', requireAuth, (req, res) => {
  const { status, search, nik: filterNik } = req.query;
  const { role, nik } = req.session.user;
  let sql = 'SELECT * FROM jobs';
  const params = [];
  const where = [];

  if (role === 'teknisi') where.push('nik=?'), params.push(nik);
  if (filterNik && role !== 'teknisi') { where.push('nik=?'); params.push(filterNik); }
  if (status && status !== 'ALL') { where.push('status=?'); params.push(status); }
  if (search) where.push('(wonum LIKE ? OR nik LIKE ? OR nama LIKE ?)'), params.push(...Array(3).fill(`%${search}%`));
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC';

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM jobs WHERE id=?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (req.session.user.role === 'teknisi' && row.nik !== req.session.user.nik)
      return res.status(403).json({ error: 'Akses ditolak' });
    res.json(row);
  });
});

// ── Validasi / Revisi oleh validator/admin ────────────────
const REVIEW_CATEGORIES = [
  'Dokumen tidak lengkap',
  'Foto QR ODP tidak terbaca',
  'Foto QR DC tidak terbaca',
  'Lokasi tidak sesuai',
  'Foto ODP buka/tutup kurang',
  'Data tidak cocok',
  'Lainnya'
];

app.post('/api/jobs/:id/review', requireRole('validator', 'admin'), async (req, res) => {
  const { status, note, category } = req.body;
  if (!['VALID', 'REJECT'].includes(status)) return res.status(400).json({ error: 'Status tidak valid' });

  try {
    const job = await db.getP('SELECT * FROM jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Tidak ditemukan' });

    // Kunci data final: data VALID tidak bisa diubah oleh validator (hanya admin)
    if (job.status === 'VALID' && req.session.user.role !== 'admin')
      return res.status(403).json({ error: 'Data sudah final (VALID). Hanya admin yang bisa mengubahnya.' });

    const upd = await db.runP(
      `UPDATE jobs SET status=?, review_note=?, review_cat=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, ack=0 WHERE id=?`,
      [status, note || null, category || null, req.session.user.username, req.params.id]
    );
    if (!upd.changes) return res.status(404).json({ error: 'Tidak ditemukan' });

    notifyRevision({ ...job, status, review_note: note, review_cat: category });
    // kirim laporan lengkap (ringkasan + album foto) setelah OK/VALID
    if (status === 'VALID') {
      sendJobReport({ ...job, status, review_note: note, review_cat: category }).catch(() => {});
    }
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/review-categories', requireAuth, (req, res) => res.json(REVIEW_CATEGORIES));

// ── Teknisi: tandai revisi sudah dibaca ──────────────────
app.post('/api/jobs/:id/ack', requireRole('teknisi'), async (req, res) => {
  try {
    await db.runP('UPDATE jobs SET ack=1 WHERE id=? AND nik=?', [req.params.id, req.session.user.nik]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Teknisi: edit data (hanya miliknya, status REJECT) ───
const EDITABLE_FIELDS = ['nama','wonum','sc','sto','layanan','no_internet','no_voice',
  'datek_odp','port_odp','valins_id','p_dc','lokasi_pelanggan','lokasi_odp'];

app.patch('/api/jobs/:id', requireRole('teknisi'), async (req, res) => {
  try {
    const job = await db.getP('SELECT * FROM jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (job.nik !== req.session.user.nik) return res.status(403).json({ error: 'Akses ditolak' });
    if (job.status !== 'REJECT') return res.status(400).json({ error: 'Hanya data berstatus REJECT yang bisa diedit' });

    const sets = [];
    const params = [];
    for (const f of EDITABLE_FIELDS) {
      if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f] === '' ? null : req.body[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'Tidak ada field yang diubah' });
    params.push(req.params.id);
    await db.runP(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`, params);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Teknisi: kirim ulang (kembali ke PENDING, hapus review) ──
app.post('/api/jobs/:id/resubmit', requireRole('teknisi'), async (req, res) => {
  try {
    const job = await db.getP('SELECT * FROM jobs WHERE id=?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (job.nik !== req.session.user.nik) return res.status(403).json({ error: 'Akses ditolak' });
    if (job.status !== 'REJECT') return res.status(400).json({ error: 'Hanya data REJECT yang bisa dikirim ulang' });

    await db.runP(
      `UPDATE jobs SET status='PENDING', review_note=NULL, review_cat=NULL, reviewed_by=NULL, reviewed_at=NULL, ack=0 WHERE id=?`,
      [req.params.id]
    );
    // kirim laporan revisi ke chat teknisi + target terkonfigurasi
    const updated = await db.getP('SELECT * FROM jobs WHERE id=?', [req.params.id]);
    sendJobReport(updated).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Daftar teknisi untuk filter (validator/admin) ────────
app.get('/api/teknisi-list', requireRole('validator', 'admin'), (req, res) => {
  db.all(
    `SELECT DISTINCT nik, nama FROM users WHERE role='teknisi' AND nik IS NOT NULL ORDER BY nama`,
    [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

// ── Export CSV / JSON (role-aware, dengan filter) ────────
function toCSV(rows) {
  const cols = ['id','nik','nama','wonum','sc','sto','layanan','no_internet','no_voice',
    'datek_odp','port_odp','valins_id','p_dc','lokasi_pelanggan','lokasi_odp',
    'ocr_qr_odp','ocr_qr_dc','foto_qr_odp','foto_qr_dc','foto_odp_buka','foto_odp_tutup',
    'foto_redaman_odp','foto_clamp_hook','foto_sclamp_tiang','foto_ikr','foto_belakang_sn',
    'sn_odp','sn_dc','sn_issue',
    'status','review_cat','review_note','reviewed_by','reviewed_at','created_at'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = cols.map(c => esc(c)).join(',');
  const body = rows.map(r => cols.map(c => esc(r[c])).join(','));
  return [head, ...body].join('\r\n');
}
app.get('/api/export', requireAuth, async (req, res) => {
  const { status, nik: filterNik } = req.query;
  const { role, nik } = req.session.user;
  let sql = 'SELECT * FROM jobs';
  const params = [];
  const where = [];
  if (role === 'teknisi') where.push('nik=?'), params.push(nik);
  if (filterNik && role !== 'teknisi') { where.push('nik=?'); params.push(filterNik); }
  if (status && status !== 'ALL') { where.push('status=?'); params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC';
  const rows = await db.allP(sql, params);
  const format = req.query.format === 'json' ? 'json' : 'csv';
  if (format === 'json') return res.json(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="telkom-jobs-${stamp}.csv"`);
  res.send('\uFEFF' + toCSV(rows)); // BOM agar Excel membaca UTF-8
});

// ── Stats (role-aware) ───────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const { role, nik } = req.session.user;
  let sql = 'SELECT status, COUNT(*) as total FROM jobs';
  const params = [];
  if (role === 'teknisi') { sql += ' WHERE nik=?'; params.push(nik); }
  sql += ' GROUP BY status';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const stats = { PENDING: 0, VALID: 0, REJECT: 0, total: 0 };
    rows.forEach(r => { stats[r.status] = r.total; stats.total += r.total; });
    res.json(stats);
  });
});

// ── Upload foto dari web ─────────────────────────────────
const PHOTO_FIELDS = ['foto_qr_odp', 'foto_qr_dc', 'foto_odp_buka', 'foto_odp_tutup',
  'foto_redaman_odp', 'foto_clamp_hook', 'foto_sclamp_tiang', 'foto_ikr', 'foto_belakang_sn'];
app.post('/api/jobs/:id/upload', requireAuth, upload.fields(
  PHOTO_FIELDS.map(n => ({ name: n, maxCount: 1 }))
), async (req, res) => {
  const id = req.params.id;
  try {
    const job = await db.getP('SELECT * FROM jobs WHERE id=?', [id]);
    if (!job) return res.status(404).json({ error: 'Tidak ditemukan' });
    // Hapus file yang tak terpakai jika ditolak
    const discard = () => {
      PHOTO_FIELDS.forEach(f => {
        if (req.files && req.files[f]) req.files[f].forEach(x => fs.unlink(path.join(UPLOAD_DIR, x.filename), () => {}));
      });
    };
    // Kunci final: VALID tidak bisa diubah kecuali admin
    if (job.status === 'VALID' && req.session.user.role !== 'admin') { discard(); return res.status(403).json({ error: 'Data sudah final (VALID).' }); }
    // Teknisi: hanya miliknya & status REJECT
    if (req.session.user.role === 'teknisi' && (job.nik !== req.session.user.nik || job.status !== 'REJECT')) {
      discard(); return res.status(403).json({ error: 'Akses ditolak: hanya bisa mengunggah ke data REJECT milik Anda.' });
    }

    const updates = [];
    const params = [];
    for (const field of PHOTO_FIELDS) {
      if (req.files[field]) {
        const fname = req.files[field][0].filename;
        updates.push(`${field}=?`);
        params.push(fname);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Tidak ada file' });
    params.push(id);
    const r = await db.runP(`UPDATE jobs SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ success: true, changes: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pengaturan notifikasi tambahan (admin) ───────────────
app.get('/api/settings/notify-targets', requireRole('admin'), async (req, res) => {
  const targets = await getNotifyTargets();
  res.json({ targets });
});

app.put('/api/settings/notify-targets', requireRole('admin'), async (req, res) => {
  const { targets } = req.body;
  const list = Array.isArray(targets) ? targets.map(String).map(s => s.trim()).filter(Boolean).join(',') : '';
  await db.runP(
    `INSERT INTO settings (key, value) VALUES ('notify_targets', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [list]
  );
  res.json({ success: true, targets: list ? list.split(',') : [] });
});

// ── Grafik statistik (role-aware) ────────────────────────
app.get('/api/stats/chart', requireAuth, (req, res) => {
  const { role, nik } = req.session.user;
  const params = [];
  let where = '';
  if (role === 'teknisi') { where = 'WHERE nik=?'; params.push(nik); }

  // Distribusi per status
  db.all(`SELECT status, COUNT(*) n FROM jobs ${where} GROUP BY status`, params, (err, statusRows) => {
    if (err) return res.status(500).json({ error: err.message });
    const byStatus = { PENDING: 0, VALID: 0, REJECT: 0 };
    statusRows.forEach(r => { if (byStatus[r.status] !== undefined) byStatus[r.status] = r.n; });

    // Trend per hari (7 hari terakhir)
    const tparams = [ ...params ];
    db.all(
      `SELECT date(created_at) d, COUNT(*) n FROM jobs ${where} ${where ? 'AND' : 'WHERE'} created_at >= date('now','-6 days') GROUP BY date(created_at) ORDER BY d`,
      tparams, (err2, trendRows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        const trend = {};
        trendRows.forEach(r => { trend[r.d] = r.n; });
        const labels = [];
        const values = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          labels.push(d.slice(5));
          values.push(trend[d] || 0);
        }
        res.json({ byStatus, trend: { labels, values } });
      });
  });
});

// isi token login untuk user lama yang belum punya
db.allP('SELECT id, login_token FROM users WHERE login_token IS NULL OR login_token=\'\'', [])
  .then(rows => Promise.all(rows.map(u => db.runP('UPDATE users SET login_token=? WHERE id=?', [genToken(), u.id]))))
  .catch(() => {});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`📊 Dashboard port: ${PORT} (login: admin/admin123)`);
  console.log(`🤖 Bot Telegram aktif\n`);
});
