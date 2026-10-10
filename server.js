'use strict';
/**
 * CCTV Monitor – poller + dashboard
 * Tanpa dependensi eksternal. Butuh Node.js >= 22.13 (memakai node:sqlite bawaan).
 *
 * Alur setiap siklus (default 10 menit):
 *   1. GET  /api/flagged/<kamera>   -> simpan gambar dengan nama unik
 *   2. GET  /api/dashboard          -> simpan data + nama file gambar ke SQLite
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- konfigurasi
const CONFIG = {
  baseUrl: (process.env.API_BASE || 'http://36.94.68.175:5000').replace(/\/+$/, ''),
  cameras: (process.env.CAMERAS || 'cctv-1').split(',').map((s) => s.trim()).filter(Boolean),
  intervalMin: Number(process.env.INTERVAL_MIN || 10),
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  timeoutMs: Number(process.env.TIMEOUT_MS || 30000),
};
const IMAGES_DIR = path.join(CONFIG.dataDir, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ------------------------------------------------------------------- database
const db = new DatabaseSync(path.join(CONFIG.dataDir, 'monitor.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS readings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    polled_at        TEXT NOT NULL,          -- waktu program mengambil data (UTC, ISO)
    camera_id        TEXT NOT NULL,
    checked_at       TEXT,                   -- waktu pengecekan dari API (apa adanya)
    obj_count        INTEGER,
    decision         TEXT,
    level            TEXT,
    mask_source      TEXT,
    source_filename  TEXT,                   -- nama file asli dari API
    inner_pct        REAL,
    inner_level      TEXT,
    outer_pct        REAL,
    outer_level      TEXT,
    zones_json       TEXT,
    image_file       TEXT,                   -- nama file unik di data/images
    image_bytes      INTEGER,
    stream_connected INTEGER,
    stream_age       REAL,
    stream_error     TEXT,
    monitoring       TEXT,
    configured       INTEGER,
    raw_json         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_readings_polled ON readings(polled_at);
  CREATE INDEX IF NOT EXISTS idx_readings_cam    ON readings(camera_id, polled_at);

  CREATE TABLE IF NOT EXISTS poll_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    polled_at TEXT NOT NULL,
    ok        INTEGER NOT NULL,
    image_ok  INTEGER NOT NULL,
    message   TEXT
  );
`);

const READING_COLS = [
  'polled_at', 'camera_id', 'checked_at', 'obj_count', 'decision', 'level', 'mask_source',
  'source_filename', 'inner_pct', 'inner_level', 'outer_pct', 'outer_level', 'zones_json',
  'image_file', 'image_bytes', 'stream_connected', 'stream_age', 'stream_error', 'monitoring',
  'configured', 'raw_json',
];
const insertReading = db.prepare(
  `INSERT INTO readings (${READING_COLS.join(',')}) VALUES (${READING_COLS.map(() => '?').join(',')})`
);
const insertPollLog = db.prepare('INSERT INTO poll_log (polled_at, ok, image_ok, message) VALUES (?,?,?,?)');

// ----------------------------------------------------------------- pengambilan
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const nn = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

async function httpGet(url) {
  return fetch(url, { signal: AbortSignal.timeout(CONFIG.timeoutMs) });
}

/** Unduh gambar kamera, simpan dengan nama unik. */
async function downloadImage(cameraId, polledAt) {
  const res = await httpGet(`${CONFIG.baseUrl}/api/flagged/${encodeURIComponent(cameraId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`respons bukan gambar (${type || 'tanpa content-type'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('gambar kosong');

  const stamp = polledAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safeCam = cameraId.replace(/[^\w-]/g, '_');
  const name = `${safeCam}_${stamp}_${crypto.randomBytes(4).toString('hex')}.${EXT_BY_TYPE[type] || 'jpg'}`;
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  return { name, bytes: buf.length };
}

const status = { running: false, lastPollAt: null, lastOk: null, lastMessage: null, nextPollAt: null };

async function pollOnce() {
  if (status.running) return { skipped: true };
  status.running = true;
  const polledAt = new Date();
  const notes = [];
  const savedImages = [];
  let imageOk = true;

  try {
    // 1) gambar dulu
    const images = {};
    for (const cam of CONFIG.cameras) {
      try {
        images[cam] = await downloadImage(cam, polledAt);
        savedImages.push(images[cam].name);
        log(`gambar ${cam} -> ${images[cam].name} (${images[cam].bytes} B)`);
      } catch (e) {
        images[cam] = null;
        imageOk = false;
        notes.push(`gambar ${cam}: ${e.message}`);
        log(`gagal ambil gambar ${cam}: ${e.message}`);
      }
    }

    // 2) lalu data
    const res = await httpGet(`${CONFIG.baseUrl}/api/dashboard`);
    if (!res.ok) throw new Error(`dashboard HTTP ${res.status}`);
    const data = await res.json();
    const cameras = Array.isArray(data.cameras) ? data.cameras : [];

    let saved = 0;
    db.exec('BEGIN');
    try {
      for (const cam of cameras) {
        if (!CONFIG.cameras.includes(cam.id)) continue;
        const latest = cam.latest || {};
        const zones = Array.isArray(latest.zones) ? latest.zones : [];
        const inner = zones.find((z) => z.kind === 'inner') || {};
        const outer = zones.find((z) => z.kind === 'outer') || {};
        const stream = cam.stream || {};
        const img = images[cam.id];

        insertReading.run(
          polledAt.toISOString(), cam.id, nn(latest.checked_at), nn(latest.count), nn(latest.decision),
          nn(latest.level), nn(latest.mask_source), nn(latest.filename),
          nn(inner.pct), nn(inner.level), nn(outer.pct), nn(outer.level), JSON.stringify(zones),
          img ? img.name : null, img ? img.bytes : null,
          nn(stream.connected), nn(stream.age), nn(stream.error), nn(data.monitoring), nn(cam.configured),
          JSON.stringify(cam)
        );
        saved++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (!saved) throw new Error(`kamera ${CONFIG.cameras.join(', ')} tidak ada di respons dashboard`);

    status.lastOk = true;
    status.lastMessage = notes.length ? `tersimpan (${notes.join('; ')})` : `tersimpan (${saved} kamera)`;
    log(status.lastMessage);
  } catch (e) {
    // data gagal diambil -> hapus gambar yatim agar tidak menumpuk
    for (const f of savedImages) fs.rm(path.join(IMAGES_DIR, f), { force: true }, () => {});
    imageOk = false;
    status.lastOk = false;
    status.lastMessage = e.message;
    log(`siklus gagal: ${e.message}`);
  } finally {
    status.lastPollAt = polledAt.toISOString();
    status.nextPollAt = new Date(Date.now() + CONFIG.intervalMin * 60000).toISOString();
    status.running = false;
    insertPollLog.run(polledAt.toISOString(), Number(status.lastOk), Number(imageOk), status.lastMessage);
  }
  return { ok: status.lastOk, message: status.lastMessage };
}

// ---------------------------------------------------------------------- query
const SORTABLE = {
  polled_at: 'polled_at', checked_at: 'checked_at', camera_id: 'camera_id', obj_count: 'obj_count',
  decision: 'decision', level: 'level', inner_pct: 'inner_pct', outer_pct: 'outer_pct',
};
const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function buildWhere(sp) {
  const w = [];
  const p = [];
  const eq = (key, col) => { const v = sp.get(key); if (v) { w.push(`${col} = ?`); p.push(v); } };
  eq('camera', 'camera_id');
  eq('level', 'level');
  eq('decision', 'decision');
  if (sp.get('from')) { w.push('polled_at >= ?'); p.push(sp.get('from')); }
  if (sp.get('to')) { w.push('polled_at <= ?'); p.push(sp.get('to')); }
  if (num(sp.get('min_count')) !== null) { w.push('obj_count >= ?'); p.push(num(sp.get('min_count'))); }
  if (num(sp.get('max_count')) !== null) { w.push('obj_count <= ?'); p.push(num(sp.get('max_count'))); }
  const q = (sp.get('q') || '').trim();
  if (q) { w.push('(image_file LIKE ? OR source_filename LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

const LIST_COLS = `id, polled_at, camera_id, checked_at, obj_count, decision, level, mask_source,
  source_filename, inner_pct, inner_level, outer_pct, outer_level, image_file, image_bytes`;

function listReadings(sp) {
  const { sql, params } = buildWhere(sp);
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize'), 10) || 25));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM readings ${sql}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, parseInt(sp.get('page'), 10) || 1));
  const sort = SORTABLE[sp.get('sort')] || 'polled_at';
  const dir = sp.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(`SELECT ${LIST_COLS} FROM readings ${sql} ORDER BY ${sort} ${dir}, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total, page, pages, pageSize };
}

function csvExport(sp) {
  const { sql, params } = buildWhere(sp);
  const rows = db.prepare(`SELECT ${LIST_COLS} FROM readings ${sql} ORDER BY polled_at DESC, id DESC`).all(...params);
  const cols = LIST_COLS.split(',').map((s) => s.trim());
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function getReading(id) {
  const r = db.prepare('SELECT * FROM readings WHERE id = ?').get(id);
  if (!r) return null;
  try { r.zones = JSON.parse(r.zones_json || '[]'); } catch { r.zones = []; }
  delete r.zones_json;
  return r;
}

function getMeta() {
  const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} AS v FROM readings WHERE ${col} IS NOT NULL ORDER BY ${col}`).all().map((r) => r.v);
  const range = db.prepare('SELECT MIN(polled_at) AS first_at, MAX(polled_at) AS last_at, COUNT(*) AS total FROM readings').get();
  return { cameras: distinct('camera_id'), levels: distinct('level'), decisions: distinct('decision'), ...range };
}

function getStatus() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM readings').get().c;
  const recent = db.prepare('SELECT polled_at, ok, image_ok, message FROM poll_log ORDER BY id DESC LIMIT 10').all();
  return { ...status, intervalMin: CONFIG.intervalMin, cameras: CONFIG.cameras, totalReadings: total, recent };
}

function getTrends(sp) {
  const { sql, params } = buildWhere(sp);
  const tz = Math.max(-840, Math.min(840, parseInt(sp.get('tz'), 10) || 0));
  const mod = `${tz >= 0 ? '+' : ''}${tz} minutes`;

  const range = db.prepare(`SELECT MIN(polled_at) AS a, MAX(polled_at) AS b FROM readings ${sql}`).get(...params);
  const spanH = range.a ? (Date.parse(range.b) - Date.parse(range.a)) / 3600000 : 0;
  let bucket = sp.get('bucket');
  if (!['raw', 'hour', 'day'].includes(bucket)) bucket = spanH <= 48 ? 'raw' : spanH <= 24 * 21 ? 'hour' : 'day';
  const fmt = { raw: '%Y-%m-%dT%H:%M:%S', hour: '%Y-%m-%dT%H:00:00', day: '%Y-%m-%dT00:00:00' }[bucket];
  const tExpr = `strftime('${fmt}', polled_at, ?)`;

  const series = db.prepare(`
    SELECT ${tExpr} AS t, COUNT(*) AS n,
           AVG(obj_count) AS avg_count, MAX(obj_count) AS max_count,
           AVG(inner_pct) AS avg_inner, MAX(inner_pct) AS max_inner,
           AVG(outer_pct) AS avg_outer, MAX(outer_pct) AS max_outer
    FROM readings ${sql} GROUP BY t ORDER BY t`).all(mod, ...params);

  const levels = db.prepare(`
    SELECT ${tExpr} AS t, COALESCE(level, 'unknown') AS level, COUNT(*) AS n
    FROM readings ${sql} GROUP BY t, level ORDER BY t`).all(mod, ...params);

  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', polled_at, ?) AS INTEGER) AS h, COUNT(*) AS n,
           AVG(obj_count) AS avg_count, MAX(obj_count) AS max_count, AVG(inner_pct) AS avg_inner
    FROM readings ${sql} GROUP BY h ORDER BY h`).all(mod, ...params);

  const sum = db.prepare(`
    SELECT COUNT(*) AS total, AVG(obj_count) AS avg_count, MAX(obj_count) AS max_count,
           SUM(CASE WHEN level = 'overload' THEN 1 ELSE 0 END) AS overload_n,
           SUM(CASE WHEN decision = 'YES' THEN 1 ELSE 0 END) AS yes_n,
           MAX(inner_pct) AS max_inner, MAX(outer_pct) AS max_outer
    FROM readings ${sql}`).get(...params);
  const latest = db.prepare(`SELECT ${LIST_COLS} FROM readings ${sql} ORDER BY polled_at DESC, id DESC LIMIT 1`).get(...params) || null;

  return { bucket, series, levels, byHour, summary: sum, latest };
}

// ------------------------------------------------------------------------ HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJSON(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache || 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const sp = url.searchParams;

    if (req.method === 'POST' && p === '/api/poll-now') {
      return sendJSON(res, 200, await pollOnce());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: 'method not allowed' });
    }

    if (p === '/api/readings') return sendJSON(res, 200, listReadings(sp));
    if (p === '/api/readings.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="cctv-readings.csv"',
      });
      return res.end('\ufeff' + csvExport(sp));
    }
    const m = p.match(/^\/api\/readings\/(\d+)$/);
    if (m) {
      const r = getReading(Number(m[1]));
      return r ? sendJSON(res, 200, r) : sendJSON(res, 404, { error: 'tidak ditemukan' });
    }
    if (p === '/api/meta') return sendJSON(res, 200, getMeta());
    if (p === '/api/status') return sendJSON(res, 200, getStatus());
    if (p === '/api/trends') return sendJSON(res, 200, getTrends(sp));

    if (p.startsWith('/images/')) {
      const name = decodeURIComponent(p.slice('/images/'.length));
      if (name !== path.basename(name)) { res.writeHead(400); return res.end('Bad request'); }
      return sendFile(res, path.join(IMAGES_DIR, name), 'public, max-age=31536000, immutable');
    }

    const page = p === '/' ? '/index.html' : p === '/trends' ? '/trends.html' : p;
    const file = path.normalize(path.join(PUBLIC_DIR, page));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    return sendFile(res, file);
  } catch (e) {
    log('error:', e);
    return sendJSON(res, 500, { error: e.message });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`Dashboard: http://${CONFIG.host}:${CONFIG.port}`);
  log(`Sumber: ${CONFIG.baseUrl} | kamera: ${CONFIG.cameras.join(', ')} | interval: ${CONFIG.intervalMin} menit`);
  log(`Data: ${CONFIG.dataDir}`);
  pollOnce();
  setInterval(pollOnce, CONFIG.intervalMin * 60000);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`${sig}, menutup…`); server.close(); db.close(); process.exit(0); });
}
