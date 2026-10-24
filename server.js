// server.js — เซิร์ฟเวอร์เกม ศึกชิงเมือง (ไม่มี dependency ภายนอก)
// หลักกันโกง: หน้าเว็บส่งมาแค่ "คำสั่ง" (เช่น ล่า โจมตี คราฟ) เซิร์ฟเวอร์เป็นผู้คำนวณผลและเก็บสถานะจริงในฐานข้อมูล
// ฐานข้อมูล: Turso (SQLite บนคลาวด์) ถ้าตั้ง TURSO_URL · ไม่ตั้ง = ไฟล์ SQLite ในเครื่อง (ดู db.js)
'use strict';
process.env.TZ = process.env.TZ || 'Asia/Bangkok'; // วันรีเซ็ตเควส/ช่วงเวลาโบนัสยึดเวลาไทย
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEngine } = require('./engine');
const { createDb } = require('./db');

loadDotEnv();
const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.JWT_SECRET || '';
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS) || 30;
const PUBLIC = path.join(__dirname, 'public');
if (!SECRET || SECRET.length < 24) {
  console.error('ต้องตั้ง JWT_SECRET (สุ่มยาวอย่างน้อย 24 ตัวอักษร) ใน Environment Variables หรือไฟล์ .env');
  process.exit(1);
}
const db = createDb();

// ---------- เครื่องยนต์เกม ----------
const engine = loadEngine(path.join(PUBLIC, 'index.html'));
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('<script>\n(function(){', '<script>window.GAME_MODE="client";window.GAME_API="";</script>\n<script>\n(function(){');

// ---------- สถานะผู้เล่นในหน่วยความจำ + เขียนลงฐานข้อมูล (รวมการเขียนที่ถี่ ๆ ให้เหลือครั้งล่าสุด) ----------
const live = new Map();     // uid -> { s, ui, v, lastTick, bucket, bucketAt, touched, saving, dirty }
const loading = new Map();  // uid -> Promise (กันโหลดซ้ำพร้อมกัน)
async function session(uid) {
  const p = live.get(uid);
  if (p) { p.touched = Date.now(); return p; }
  if (loading.has(uid)) return loading.get(uid);
  const pr = (async () => {
    const row = await db.getSave(uid);
    let s = null, v = 0;
    if (row) { try { s = engine.normalize(JSON.parse(row.data)); v = row.ver | 0; } catch (e) { s = null; } }
    if (!s) s = engine.fresh();
    const np = { s, ui: {}, v, lastTick: 0, bucket: 30, bucketAt: Date.now(), touched: Date.now(), saving: false, dirty: false };
    live.set(uid, np);
    return np;
  })();
  loading.set(uid, pr);
  try { return await pr; } finally { loading.delete(uid); }
}
function persist(uid, p) {
  p.dirty = true;
  if (p.saving) return p.saving;
  p.saving = (async () => {
    while (p.dirty) {
      p.dirty = false;
      const s = p.s;
      try {
        await db.putSave(uid, JSON.stringify(s), p.v, String(s.name || ''), String(s.cls || ''), s.lvl | 0, Math.floor(s.gold || 0));
      } catch (e) { console.error('save failed', uid, e.message); p.dirty = true; await new Promise(z => setTimeout(z, 2000)); }
    }
    p.saving = false;
  })();
  return p.saving;
}
async function flushAll() { await Promise.all([...live.entries()].map(([uid, p]) => (p.dirty || p.saving) ? persist(uid, p) : null)); }
setInterval(() => { // ล้างแคชผู้เล่นที่ไม่ได้เล่นเกิน 30 นาที (บันทึกก่อนล้าง)
  const cut = Date.now() - 30 * 60 * 1000;
  for (const [uid, p] of live) if (p.touched < cut && !p.saving && !p.dirty) live.delete(uid);
}, 5 * 60 * 1000).unref();

// ---------- รหัสผ่าน + โทเคน ----------
function hashPw(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
const userCache = new Map(); // id -> { u, at } ลดการถามฐานข้อมูลทุกคำสั่ง (อัปเดตทุก 60 วินาที)
async function userById(id) {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 60000) return c.u;
  const u = await db.userById(id);
  userCache.set(id, { u, at: Date.now() });
  return u;
}
async function verify(tok) {
  if (typeof tok !== 'string' || tok.length > 600) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!p || typeof p.uid !== 'number' || !(p.exp > Date.now())) return null;
  const u = await userById(p.uid);
  if (!u || u.banned || u.token_ver !== p.tv) return null;
  return u;
}
const issue = u => sign({ uid: u.id, tv: u.token_ver, exp: Date.now() + TOKEN_DAYS * 864e5 });

// ---------- จำกัดความถี่ ----------
const ipHits = new Map();
function ipLimited(ip, key, max, windowMs) {
  const k = key + '|' + ip, now = Date.now();
  let h = ipHits.get(k);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; ipHits.set(k, h); }
  return ++h.n > max;
}
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, h] of ipHits) if (h.t < cut) ipHits.delete(k); }, 600e3).unref();
function takeToken(p) { // ผู้เล่นส่งคำสั่งได้เฉลี่ย 12 ครั้ง/วินาที (สะสมได้ 30) กันบอทยิงรัว
  const now = Date.now();
  p.bucket = Math.min(30, p.bucket + (now - p.bucketAt) * 0.012); p.bucketAt = now;
  if (p.bucket < 1) return false;
  p.bucket -= 1; return true;
}

// ---------- HTTP ----------
const MAX_BODY = 16 * 1024;
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('ข้อมูลใหญ่เกินไป'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(Object.assign(new Error('รูปแบบข้อมูลไม่ถูกต้อง'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const clientIp = req => { const xf = req.headers['x-forwarded-for']; return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.socket.remoteAddress || '?'; };
const auth = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? verify(h.slice(7)) : Promise.resolve(null); };
function cleanInputs(inp) {
  const o = {};
  if (inp && typeof inp === 'object') for (const k of ['cname', 'gname', 'gamt']) if (typeof inp[k] === 'string') o[k] = inp[k].slice(0, 40);
  return o;
}
const reply = (res, p, out, user) => send(res, 200, { s: out.s, ui: out.ui, fx: out.fx || [], fxt: out.fxt || {}, v: p.v, user });

const routes = {
  'POST /api/register': async (req, res) => {
    if (ipLimited(clientIp(req), 'reg', 5, 3600e3)) return send(res, 429, { error: 'สมัครบ่อยเกินไป ลองใหม่ภายหลัง' });
    const b = await readBody(req);
    const id = String(b.username || '').trim(), pw = String(b.password || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(id)) return send(res, 400, { error: 'ไอดีใช้ได้เฉพาะ A–Z ตัวเลข และ _ ยาว 3–16 ตัว' });
    if (pw.length < 6 || pw.length > 64) return send(res, 400, { error: 'รหัสผ่านต้องยาว 6–64 ตัวอักษร' });
    const key = id.toLowerCase();
    if (await db.userByName(key)) return send(res, 409, { error: 'ไอดีนี้ถูกใช้แล้ว ลองไอดีอื่น' });
    const salt = crypto.randomBytes(16).toString('hex');
    let uid;
    try { uid = await db.addUser(key, id, salt, await hashPw(pw, salt)); }
    catch (e) { if (/UNIQUE/i.test(e.message)) return send(res, 409, { error: 'ไอดีนี้ถูกใช้แล้ว ลองไอดีอื่น' }); throw e; }
    const u = await db.userById(uid);
    const p = await session(u.id); await persist(u.id, p);
    send(res, 200, { token: issue(u) });
  },
  'POST /api/login': async (req, res) => {
    if (ipLimited(clientIp(req), 'login', 20, 15 * 60e3)) return send(res, 429, { error: 'ลองเข้าสู่ระบบบ่อยเกินไป รอ 15 นาที' });
    const b = await readBody(req);
    const u = await db.userByName(String(b.username || '').trim().toLowerCase());
    if (!u || (await hashPw(String(b.password || ''), u.pass_salt)) !== u.pass_hash) return send(res, 401, { error: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง' });
    if (u.banned) return send(res, 403, { error: 'บัญชีนี้ถูกระงับ' });
    send(res, 200, { token: issue(u) });
  },
  'POST /api/logout': async (req, res) => {
    const u = await auth(req);
    if (u) { await db.bumpTok(u.id); userCache.delete(u.id); } // โทเคนเดิมทุกเครื่องใช้ไม่ได้
    send(res, 200, { ok: true });
  },
  'GET /api/state': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const p = await session(u.id);
    const out = engine.run(p.s, p.ui, {}, E => E.enter());
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p);
    reply(res, p, { s: out.s, ui: out.ui }, u.display);
  },
  'POST /api/act': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const a = String(b.a || ''), pr = b.p == null ? null : String(b.p);
    if (!/^[a-z0-9]{1,20}$/.test(a) || (pr && pr.length > 80)) return send(res, 400, { error: 'คำสั่งไม่ถูกต้อง' });
    const p = await session(u.id);
    if (!takeToken(p)) return send(res, 429, { error: 'ส่งคำสั่งเร็วเกินไป' });
    const before = p.s.gold;
    const out = engine.run(p.s, p.ui, cleanInputs(b.inp), E => E.act(a, pr));
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p);
    if (out.s.gold - before > 200000) db.audit(u.id, 'gold_jump', a + ' +' + (out.s.gold - before)).catch(() => {});
    reply(res, p, out);
  },
  'POST /api/tick': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const p = await session(u.id), now = Date.now();
    if (now - p.lastTick < 500) return send(res, 200, { same: true, v: p.v }); // tick ถี่กว่า 0.5 วินาทีไม่นับ
    p.lastTick = now;
    let changed = false;
    const out = engine.run(p.s, p.ui, {}, E => { changed = E.tick(); });
    p.s = out.s; p.ui = out.ui;
    if (changed || out.fx.length) { p.v++; persist(u.id, p); }
    if (!changed && !out.fx.length && Number(b.v) === p.v) return send(res, 200, { same: true, v: p.v });
    reply(res, p, out);
  },
  'GET /api/top': async (req, res) => send(res, 200, { top: (await db.top()).map(r => ({ name: r.name, cls: r.cls, lvl: r.level })) }),
  'GET /api/health': async (req, res) => send(res, 200, { ok: true, players: live.size, db: db.kind.split(' ')[0] }),
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
    if (!res.headersSent) send(res, code, { error: code === 500 ? 'เซิร์ฟเวอร์ผิดพลาด ลองใหม่อีกครั้ง' : e.message });
  }
});

db.init().then(() => {
  server.listen(PORT, () => console.log('ศึกชิงเมือง server · port ' + PORT + ' · DB ' + db.kind));
}).catch(e => { console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', e.message); process.exit(1); });

// ปิดเซิร์ฟเวอร์ (เช่น Render สั่งหลับ/อัปเดต) → บันทึกข้อมูลที่ค้างก่อน
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  server.close();
  try { await Promise.race([flushAll(), new Promise(z => setTimeout(z, 8000))]); } catch (e) {}
  process.exit(0);
});

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ไม่มีไฟล์ .env ก็ใช้ Environment Variables */ }
}
