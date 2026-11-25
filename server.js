require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_HOURS = 24;

function cleanDbUrl(url) {
  if (!url) return url;
  return url
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/([?&])channel_binding=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');
}
const DB_URL = cleanDbUrl(process.env.DATABASE_URL);

const pool = DB_URL
  ? new Pool({
      connectionString: DB_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false },
      max: process.env.VERCEL ? 1 : 5,
      idleTimeoutMillis: 10000
    })
  : null;

const app = express();
// Di Vercel, body sudah di-parse lebih dulu oleh platform; jangan dibaca ulang.
const jsonParser = express.json({ limit: '32kb' });
app.use((req, res, next) => (req.body && typeof req.body === 'object' ? next() : jsonParser(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- helpers
const CODE_RE = /^[A-Z2-9]{5}$/;
const KITS = new Set(['blackout', 'white', 'striped', 'silver']);
const ALLOWED_ROOT = new Set([
  'p1', 'p2', 'turnIndex', 'kickerChoice', 'keeperChoice',
  'lastOutcome', 'winner', 'rematch', 'status', 'updatedAt'
]);
const ALLOWED_STATUS = new Set(['waiting', 'selecting', 'animating', 'finished']);

const normCode = (c) => String(c || '').trim().toUpperCase();
const getUid = (req) => String(req.get('x-user-id') || req.query.uid || '').slice(0, 80);
const cleanName = (n, fb) => String(n || '').trim().slice(0, 14) || fb;
const cleanKit = (k, fb) => (KITS.has(k) ? k : fb);

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database belum dikonfigurasi' });
  next();
}

// Terapkan path bertitik ("p1.scores", "rematch.p2") pada objek.
function applyUpdate(obj, key, value) {
  const parts = key.split('.');
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
    throw new Error('Path tidak valid');
  }
  if (!ALLOWED_ROOT.has(parts[0])) throw new Error(`Field "${parts[0]}" tidak diizinkan`);
  if (parts.includes('uid')) throw new Error('Field uid tidak boleh diubah');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const isMember = (data, uid) =>
  Boolean(uid) && ((data.p1 && data.p1.uid === uid) || (data.p2 && data.p2.uid === uid));

// ---------------------------------------------------------------- routes
app.get('/api/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pool) return res.json({ ok: true, db: false, reason: 'DATABASE_URL belum diisi di environment server' });
  try {
    await pool.query('SELECT 1');
    const t = await pool.query("SELECT to_regclass('public.penalty_rooms') AS t");
    if (!t.rows[0].t) {
      return res.json({ ok: true, db: false, reason: 'Tabel penalty_rooms belum dibuat (jalankan npm run db:migrate)' });
    }
    res.json({ ok: true, db: true });
  } catch (err) {
    console.error('Health error:', err.message);
    res.json({ ok: true, db: false, reason: `Koneksi database gagal: ${err.code || err.message}` });
  }
});

// Buat room
app.post('/api/rooms', requireDb, async (req, res) => {
  const uid = getUid(req);
  const code = normCode(req.body.code);
  const input = req.body.data || {};
  if (!uid) return res.status(401).json({ error: 'User ID wajib' });
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Kode room tidak valid' });

  const data = {
    roomCode: code,
    status: 'waiting',
    turnIndex: 0,
    p1: { uid, name: cleanName(input.p1 && input.p1.name, 'Pemain 1'), scores: [], kit: cleanKit(input.p1 && input.p1.kit, 'blackout') },
    p2: null,
    kickerChoice: null,
    keeperChoice: null,
    lastOutcome: null,
    winner: null,
    rematch: { p1: false, p2: false },
    updatedAt: Date.now()
  };

  try {
    const r = await pool.query(
      `INSERT INTO penalty_rooms (code, data) VALUES ($1, $2)
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, data]
    );
    cleanupOldRooms();
    if (r.rowCount === 0) return res.status(409).json({ error: 'Kode room sudah dipakai' });
    res.status(201).json({ ok: true, code });
  } catch (err) {
    console.error('Create room error:', err.message);
    res.status(500).json({ error: 'Gagal membuat room' });
  }
});

// Ambil room. Dengan ?since=<version>, balas {changed:false} bila belum ada perubahan.
app.get('/api/rooms/:code', requireDb, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data, version FROM penalty_rooms WHERE code = $1', [normCode(req.params.code)]);
    if (!rows.length) return res.status(404).json({ error: 'Room tidak ditemukan' });
    const version = Number(rows[0].version);
    res.set('Cache-Control', 'no-store');
    if (req.query.since !== undefined && Number(req.query.since) === version) {
      return res.json({ changed: false, version });
    }
    res.json({ changed: true, version, data: rows[0].data });
  } catch (err) {
    console.error('Get room error:', err.message);
    res.status(500).json({ error: 'Gagal mengambil room' });
  }
});

// Gabung room (atomik: dua orang tidak bisa merebut slot p2 bersamaan)
app.post('/api/rooms/:code/join', requireDb, async (req, res) => {
  const uid = getUid(req);
  const code = normCode(req.params.code);
  if (!uid) return res.status(401).json({ error: 'User ID wajib' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM penalty_rooms WHERE code = $1 FOR UPDATE', [code]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Room tidak ditemukan' }); }
    const data = rows[0].data;
    if (data.p2 && data.p2.uid !== uid) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Room sudah penuh' }); }
    if (!data.p2) {
      data.p2 = { uid, name: cleanName(req.body.name, 'Pemain 2'), scores: [], kit: cleanKit(req.body.kit, 'white') };
      data.status = 'selecting';
      data.updatedAt = Date.now();
      const up = await client.query(
        'UPDATE penalty_rooms SET data = $2, version = version + 1, updated_at = now() WHERE code = $1 RETURNING data, version',
        [code, data]
      );
      await client.query('COMMIT');
    } else {
      await client.query('COMMIT');
    }
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Join room error:', err.message);
    res.status(500).json({ error: 'Gagal bergabung' });
  } finally {
    client.release();
  }
});

// Update room (mendukung path bertitik seperti 'p1.scores')
app.patch('/api/rooms/:code', requireDb, async (req, res) => {
  const uid = getUid(req);
  const code = normCode(req.params.code);
  const updates = req.body.updates;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'updates tidak valid' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM penalty_rooms WHERE code = $1 FOR UPDATE', [code]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Room tidak ditemukan' }); }
    const data = rows[0].data;
    if (!isMember(data, uid)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Bukan pemain di room ini' }); }

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'status' && !ALLOWED_STATUS.has(value)) throw new Error('Status tidak valid');
      applyUpdate(data, key, value);
    }
    data.updatedAt = Date.now();

    const up = await client.query(
      'UPDATE penalty_rooms SET data = $2, version = version + 1, updated_at = now() WHERE code = $1 RETURNING data, version',
      [code, data]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const bad = /tidak/.test(err.message);
    if (!bad) console.error('Update room error:', err.message);
    res.status(bad ? 400 : 500).json({ error: bad ? err.message : 'Gagal memperbarui room' });
  } finally {
    client.release();
  }
});

// Bersihkan room lama secara oportunistik (tanpa timer, cocok untuk serverless)
async function cleanupOldRooms() {
  try {
    await pool.query(
      `DELETE FROM penalty_rooms WHERE updated_at < now() - ($1 || ' hours')::interval`,
      [String(ROOM_TTL_HOURS)]
    );
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Adu Penalti Pro berjalan di http://localhost:${PORT}`);
    if (!pool) console.warn('DATABASE_URL belum diisi: Mode Online nonaktif, Mode Lokal tetap jalan.');
  });
}
