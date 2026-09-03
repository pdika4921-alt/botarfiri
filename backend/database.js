const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'telkom.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) return console.error('DB Error:', err.message);
  console.log('✅ Database terhubung:', DB_PATH);
});

// ── Helper: query promisified ─────────────────────────────
db.runP = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function (err) { if (err) return rej(err); res(this); }));
db.getP = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => (err ? rej(err) : res(row))));
db.allP = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nik           TEXT,
    nama          TEXT,
    wonum         TEXT,
    sc            TEXT,
    foto_qr_odp   TEXT,
    foto_qr_dc    TEXT,
    ocr_qr_odp    TEXT,
    ocr_qr_dc     TEXT,
    sto           TEXT,
    layanan       TEXT,
    no_internet   TEXT,
    no_voice      TEXT,
    datek_odp     TEXT,
    port_odp      TEXT,
    valins_id     TEXT,
    p_dc          TEXT,
    lokasi_pelanggan TEXT,
    lokasi_odp    TEXT,
    foto_odp_buka TEXT,
    foto_odp_tutup TEXT,
    foto_redaman_odp TEXT,
    foto_clamp_hook TEXT,
    foto_sclamp_tiang TEXT,
    foto_ikr TEXT,
    foto_belakang_sn TEXT,
    sn_odp        TEXT,
    sn_dc         TEXT,
    sn_issue      INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'PENDING',
    review_note   TEXT,
    review_cat    TEXT,
    reviewed_by   TEXT,
    reviewed_at   DATETIME,
    ack           INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nik        TEXT UNIQUE,
    nama       TEXT,
    username   TEXT UNIQUE,
    password   TEXT,
    role       TEXT CHECK(role IN ('admin','validator','teknisi')),
    chat_id    INTEGER,
    login_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nik        TEXT,
    chat_id    INTEGER UNIQUE,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);
});

// ── Migrasi: tambah kolom baru bila belum ada ─────────────
function addColumn(table, name) {
  db.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
    const exists = cols && cols.some(c => c.name === name);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`, (e) => {
        if (e) console.error('Migrasi gagal:', e.message);
        else console.log(`✅ Kolom ${name} ditambahkan ke ${table}`);
      });
    }
  });
}
['foto_qr_odp', 'foto_qr_dc', 'review_note', 'review_cat', 'reviewed_by',
 'reviewed_at', 'ack', 'sto', 'layanan',
 'foto_redaman_odp', 'foto_clamp_hook', 'foto_sclamp_tiang', 'foto_ikr', 'foto_belakang_sn',
 'sn_odp', 'sn_dc', 'sn_issue', 'foto_rumah'].forEach(c => addColumn('jobs', c));
['chat_id', 'login_token'].forEach(c => addColumn('users', c));

// ── Setup awal: buat admin default hanya jika DB kosong ──
function seedAdmin() {
  db.get('SELECT COUNT(*) AS n FROM users', [], (err, row) => {
    if (err) return;
    if (row.n === 0) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync('admin123', salt, 32).toString('hex');
      db.run(
        `INSERT INTO users (nik, nama, username, password, role)
         VALUES (?,?,?,?,?)`,
        ['ADMIN', 'Administrator', 'admin', `${salt}:${hash}`, 'admin'],
        (e) => { if (!e) console.log('✅ Akun admin default dibuat (username: admin / password: admin123)'); }
      );
    }
  });
}
seedAdmin();
// `needsSetup` = true jika belum ada user sama sekali
db.needsSetup = () => new Promise((res) =>
  db.get('SELECT COUNT(*) AS n FROM users', [], (e, r) => res(!e && r.n === 0)));

// ── Password helpers ──────────────────────────────────────
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
