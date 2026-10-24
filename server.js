// server.js — เซิร์ฟเวอร์เกม ศึกชิงเมือง (ไม่มี dependency ภายนอก: ใช้ http, crypto และ node:sqlite ที่มากับ Node 22.5+)
// หลักกันโกง: หน้าเว็บส่งมาแค่ "คำสั่ง" (เช่น ล่า โจมตี คราฟ) เซิร์ฟเวอร์เป็นผู้คำนวณผลและเก็บสถานะจริงใน SQLite
'use strict';
process.env.TZ = process.env.TZ || 'Asia/Bangkok'; // วันรีเซ็ตเควส/ช่วงเวลาโบนัสยึดเวลาไทย
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadEngine } = require('./engine');

// ---------- ตั้งค่า ----------
loadDotEnv();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'game.db');
const SECRET = process.env.JWT_SECRET || '';
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS) || 30;
const PUBLIC = path.join(__dirname, 'public');
if (!SECRET || SECRET.length < 24) {
  console.error('ต้องตั้ง JWT_SECRET (สุ่มยาวอย่างน้อย 24 ตัวอักษร) ในไฟล์ .env หรือ Environment Variables');
  process.exit(1);
}

// ---------- ฐานข้อมูล SQLite ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,          -- ไอดี (ตัวพิมพ์เล็ก)
    display TEXT NOT NULL,                  -- ไอดีตามที่พิมพ์ตอนสมัคร
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,                -- scrypt (ไม่เก็บรหัสผ่านจริง)
    token_ver INTEGER NOT NULL DEFAULT 1,   -- เพิ่มค่าเมื่อออกจากระบบทุกเครื่อง
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,                     -- สถานะเกมทั้งก้อน (JSON ของตัวแปร s)
    ver INTEGER NOT NULL DEFAULT 0,
    name TEXT, cls TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    gold INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS saves_level ON saves(level DESC);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, at INTEGER, kind TEXT, detail TEXT
  );
`);
const Q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  addUser: db.prepare('INSERT INTO users (username, display, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
  bumpTok: db.prepare('UPDATE users SET token_ver = token_ver + 1 WHERE id = ?'),
  getSave: db.prepare('SELECT data, ver FROM saves WHERE user_id = ?'),
  putSave: db.prepare(`INSERT INTO saves (user_id, data, ver, name, cls, level, gold, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, ver = excluded.ver, name = excluded.name, cls = excluded.cls,
    level = excluded.level, gold = excluded.gold, updated_at = excluded.updated_at`),
  top: db.prepare(`SELECT s.name, s.cls, s.level, u.display FROM saves s JOIN users u ON u.id = s.user_id
    WHERE u.banned = 0 AND s.name IS NOT NULL AND s.name <> '' ORDER BY s.level DESC, s.updated_at ASC LIMIT 50`),
  audit: db.prepare('INSERT INTO audit (user_id, at, kind, detail) VALUES (?, ?, ?, ?)'),
};

// ---------- เครื่องยนต์เกม ----------
let engine = loadEngine(path.join(PUBLIC, 'index.html'));
let indexHtml = buildIndex();
function buildIndex() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  // บอกหน้าเว็บว่าให้ทำงานแบบ client (ส่งคำสั่งมาที่เซิร์ฟเวอร์)
  return html.replace('<script>\n(function(){', '<script>window.GAME_MODE="client";window.GAME_API="";</script>\n<script>\n(function(){');
}

// ---------- แคชสถานะผู้เล่นในหน่วยความจำ (เขียนลง SQLite ทุกครั้งที่เปลี่ยน) ----------
const live = new Map(); // userId -> { s, ui, v, lastAct, lastTick, bucket, bucketAt, touched }
function session(uid) {
  let p = live.get(uid);
  if (p) { p.touched = Date.now(); return p; }
  const row = Q.getSave.get(uid);
  let s, v = 0;
  if (row) { try { s = engine.normalize(JSON.parse(row.data)); v = row.ver; } catch (e) { s = null; } }
  if (!s) s = engine.fresh();
  p = { s, ui: {}, v, lastTick: 0, bucket: 30, bucketAt: Date.now(), touched: Date.now() };
  live.set(uid, p);
  return p;
}
function persist(uid, p) {
  const s = p.s;
  Q.putSave.run(uid, JSON.stringify(s), p.v, String(s.name || ''), String(s.cls || ''), s.lvl | 0, Math.floor(s.gold || 0), Date.now());
}
setInterval(() => { // ล้างแคชผู้เล่นที่ไม่ได้เล่นเกิน 30 นาที
  const cut = Date.now() - 30 * 60 * 1000;
  for (const [uid, p] of live) if (p.touched < cut) live.delete(uid);
}, 5 * 60 * 1000).unref();

// ---------- รหัสผ่าน + โทเคน ----------
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(tok) {
  if (typeof tok !== 'string' || tok.length > 600) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!p || typeof p.uid !== 'number' || !(p.exp > Date.now())) return null;
  const u = Q.userById.get(p.uid);
  if (!u || u.banned || u.token_ver !== p.tv) return null;
  return u;
}
function issue(u) { return sign({ uid: u.id, tv: u.token_ver, exp: Date.now() + TOKEN_DAYS * 864e5 }); }

// ---------- จำกัดความถี่ ----------
const ipHits = new Map();
function ipLimited(ip, key, max, windowMs) {
  const k = key + '|' + ip, now = Date.now();
  let h = ipHits.get(k);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; ipHits.set(k, h); }
  h.n++;
  return h.n > max;
}
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, h] of ipHits) if (h.t < cut) ipHits.delete(k); }, 600e3).unref();
// ผู้เล่นแต่ละคน: ส่งคำสั่งได้เฉลี่ย 12 ครั้ง/วินาที (สะสมได้สูงสุด 30) — กันบอทยิงคำสั่งรัว
function takeToken(p) {
  const now = Date.now();
  p.bucket = Math.min(30, p.bucket + (now - p.bucketAt) * 0.012);
  p.bucketAt = now;
  if (p.bucket < 1) return false;
  p.bucket -= 1;
  return true;
}

// ---------- HTTP ----------
const MAX_BODY = 16 * 1024;
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {}));
  res.end(body);
}
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('ข้อมูลใหญ่เกินไป'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(Object.assign(new Error('รูปแบบข้อมูลไม่ถูกต้อง'), { code: 400 })); } });
    req.on('error', reject);
  });
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.socket.remoteAddress || '?';
}
function auth(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
}
function cleanInputs(inp) {
  const o = {};
  if (inp && typeof inp === 'object') for (const k of ['cname', 'gname', 'gamt']) if (typeof inp[k] === 'string') o[k] = inp[k].slice(0, 40);
  return o;
}
function reply(res, p, out, user) {
  send(res, 200, { s: out.s, ui: out.ui, fx: out.fx || [], fxt: out.fxt || {}, v: p.v, user });
}

const routes = {
  'POST /api/register': async (req, res) => {
    const ip = clientIp(req);
    if (ipLimited(ip, 'reg', 5, 3600e3)) return send(res, 429, { error: 'สมัครบ่อยเกินไป ลองใหม่ภายหลัง' });
    const b = await readBody(req);
    const id = String(b.username || '').trim(), pw = String(b.password || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(id)) return send(res, 400, { error: 'ไอดีใช้ได้เฉพาะ A–Z ตัวเลข และ _ ยาว 3–16 ตัว' });
    if (pw.length < 6 || pw.length > 64) return send(res, 400, { error: 'รหัสผ่านต้องยาว 6–64 ตัวอักษร' });
    const key = id.toLowerCase();
    if (Q.userByName.get(key)) return send(res, 409, { error: 'ไอดีนี้ถูกใช้แล้ว ลองไอดีอื่น' });
    const salt = crypto.randomBytes(16).toString('hex');
    const info = Q.addUser.run(key, id, salt, hashPw(pw, salt), Date.now());
    const u = Q.userById.get(Number(info.lastInsertRowid));
    const p = session(u.id); persist(u.id, p);
    send(res, 200, { token: issue(u) });
  },
  'POST /api/login': async (req, res) => {
    const ip = clientIp(req);
    if (ipLimited(ip, 'login', 20, 15 * 60e3)) return send(res, 429, { error: 'ลองเข้าสู่ระบบบ่อยเกินไป รอ 15 นาที' });
    const b = await readBody(req);
    const u = Q.userByName.get(String(b.username || '').trim().toLowerCase());
    const pw = String(b.password || '');
    if (!u || hashPw(pw, u.pass_salt) !== u.pass_hash) return send(res, 401, { error: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง' });
    if (u.banned) return send(res, 403, { error: 'บัญชีนี้ถูกระงับ' });
    send(res, 200, { token: issue(u) });
  },
  'POST /api/logout': async (req, res) => {
    const u = auth(req); if (u) Q.bumpTok.run(u.id); // ทำให้โทเคนเดิมใช้ไม่ได้ทุกเครื่อง
    send(res, 200, { ok: true });
  },
  'GET /api/state': async (req, res) => {
    const u = auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const p = session(u.id);
    const out = engine.run(p.s, p.ui, {}, E => E.enter());
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p);
    reply(res, p, { s: out.s, ui: out.ui }, u.display);
  },
  'POST /api/act': async (req, res) => {
    const u = auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const a = String(b.a || ''), pr = b.p == null ? null : String(b.p);
    if (!/^[a-z0-9]{1,20}$/.test(a) || (pr && pr.length > 80)) return send(res, 400, { error: 'คำสั่งไม่ถูกต้อง' });
    const p = session(u.id);
    if (!takeToken(p)) return send(res, 429, { error: 'ส่งคำสั่งเร็วเกินไป' });
    const before = p.s.gold;
    const out = engine.run(p.s, p.ui, cleanInputs(b.inp), E => E.act(a, pr));
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p);
    if (out.s.gold - before > 200000) Q.audit.run(u.id, Date.now(), 'gold_jump', a + ' +' + (out.s.gold - before));
    reply(res, p, out);
  },
  'POST /api/tick': async (req, res) => {
    const u = auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const p = session(u.id), now = Date.now();
    if (now - p.lastTick < 500) return send(res, 200, { same: true, v: p.v }); // tick ถี่กว่า 0.5 วินาทีไม่นับ (ออโต้เร็วกว่าปกติไม่ได้)
    p.lastTick = now;
    let changed = false;
    const out = engine.run(p.s, p.ui, {}, E => { changed = E.tick(); });
    p.s = out.s; p.ui = out.ui;
    if (changed || out.fx.length) { p.v++; persist(u.id, p); }
    if (!changed && !out.fx.length && Number(b.v) === p.v) return send(res, 200, { same: true, v: p.v });
    reply(res, p, out);
  },
  'GET /api/top': async (req, res) => {
    send(res, 200, { top: Q.top.all().map(r => ({ name: r.name, cls: r.cls, lvl: r.level })) });
  },
  'GET /api/health': async (req, res) => send(res, 200, { ok: true, players: live.size }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  try {
    if (routes[key]) return await routes[key](req, res);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
      return res.end(indexHtml);
    }
    send(res, 404, { error: 'ไม่พบหน้า' });
  } catch (e) {
    const code = e.code === 413 || e.code === 400 ? e.code : 500;
    if (code === 500) console.error(key, e);
    send(res, code, { error: code === 500 ? 'เซิร์ฟเวอร์ผิดพลาด' : e.message });
  }
});
server.listen(PORT, () => console.log('ศึกชิงเมือง server · http://localhost:' + PORT + ' · DB ' + DB_PATH));

function loadDotEnv() {
  try {
    const t = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ไม่มีไฟล์ .env ก็ใช้ค่าจาก Environment Variables */ }
}
