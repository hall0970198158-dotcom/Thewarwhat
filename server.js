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
let SECRET = process.env.JWT_SECRET || '';
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS) || 30;
const PUBLIC = path.join(__dirname, 'public');
const db = createDb();

// ---------- เครื่องยนต์เกม ----------
const engine = loadEngine(path.join(PUBLIC, 'index.html'));
// ไฟล์เกมจาก Artifact ไม่มีส่วนหัว HTML (Artifact เติมให้เอง) เซิร์ฟเวอร์จึงเติม doctype + viewport ให้มือถือแสดงเต็มจอ
let gameHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('<script>\n(function(){', '<script>window.GAME_MODE="client";window.GAME_API="";</script>\n<script>\n(function(){');
if (!/<!doctype/i.test(gameHtml)) {
  gameHtml = '<!doctype html>\n<html lang="th">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="theme-color" content="#0e1326">\n' + gameHtml + '\n</html>';
} else if (!/name=["']viewport["']/i.test(gameHtml)) {
  gameHtml = gameHtml.replace(/<head[^>]*>/i, m => m + '\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
}
// ข้อความหน้าล็อกอินของโหมดออฟไลน์ เปลี่ยนให้ตรงกับโหมดออนไลน์
gameHtml = gameHtml.replace(/บัญชีเก็บอยู่ในเบราว์เซอร์ของเครื่องนี้[^<]*/, 'บัญชีเก็บบนเซิร์ฟเวอร์ เล่นไอดีเดียวกันได้ทุกเครื่อง · ตั้งรหัสผ่านที่เดายากและอย่าบอกใคร');
const indexHtml = gameHtml;

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

// ---------- อันดับ PvP + รายชื่อผู้เล่นจริงสำหรับจับคู่ ----------
const LADDER = new Map(); let BOARD = [], boardDirty = true;
function board() { if (boardDirty) { BOARD = [...LADDER.values()]; boardDirty = false; } return BOARD; }
function updateSnap(uid, p) {
  if (!p.s || !p.s.created || p.s.battle) return;
  const sn = engine.snap(p.s); if (!sn) return;
  const key = JSON.stringify(sn);
  if (p.snapKey === key) return;
  p.snapKey = key;
  LADDER.set(uid, Object.assign(sn, { id: uid, upd: Date.now() })); boardDirty = true;
  db.putLadder(uid, key, sn.rating | 0).catch(e => console.error('ladder save', e.message));
}

// ---------- บอสโลก ไฮดรา (รวมดาเมจทุกคน รีเซ็ตเที่ยงคืนเวลาไทย) ----------
const WB_HP = 9000000, WB_PRIZE = [{ g: 20000, f: 3 }, { g: 10000, f: 2 }, { g: 5000, f: 1 }];
const today = () => Math.floor((Date.now() + 7 * 3600e3) / 864e5);
const WB = { day: 0, total: 0, dmg: new Map(), prev: [] }; // dmg: uid -> {n, cls, dmg}
async function wbLoad(day) {
  WB.day = day; WB.total = 0; WB.dmg = new Map();
  for (const r of await db.wbDay(day)) { WB.dmg.set(Number(r.user_id), { n: r.name, cls: r.cls, dmg: Number(r.dmg) }); WB.total += Number(r.dmg); }
  const prev = await db.wbDay(day - 1);
  WB.prev = prev.slice(0, 3).map(r => ({ n: r.name, uid: Number(r.user_id) }));
  // แจกรางวัลอันดับ 1–3 ของเมื่อวาน (บันทึกไว้ ผู้เล่นได้รับตอนเข้าเกมครั้งถัดไป)
  for (let i = 0; i < Math.min(3, prev.length); i++) await db.wbPrizeAdd(Number(prev[i].user_id), day - 1, i + 1);
}
async function wbEnsure() { const d = today(); if (WB.day !== d) await wbLoad(d); }
function wbCtx() { return { day: WB.day, left: Math.max(0, WB_HP - WB.total) }; }
async function wbRecord(uid, p, res) {
  if (!res || !(res.dmg > 0)) return;
  await wbEnsure();
  const dmg = Math.min(res.dmg, Math.max(0, WB_HP - WB.total));
  const cur = WB.dmg.get(uid) || { n: '', cls: '', dmg: 0 };
  cur.n = String(p.s.name || '').slice(0, 16); cur.cls = p.s.cls; cur.dmg += dmg;
  WB.dmg.set(uid, cur); WB.total += dmg;
  await db.wbAdd(WB.day, uid, cur.n, cur.cls, dmg);
}
async function wbPrizes(uid, p) { // ส่งรางวัลที่ค้างให้ผู้เล่น
  const rows = await db.wbPrizeGet(uid);
  for (const r of rows) {
    const z = WB_PRIZE[(r.rank | 0) - 1]; if (!z) continue;
    const out = engine.run(p.s, p.ui, {}, E => E.grant(z.g, z.f, 'รางวัลบอสโลก อันดับ ' + r.rank + ': ทอง +' + z.g.toLocaleString() + ' · ยาฟื้นเลือดเต็ม ×' + z.f));
    p.s = out.s; p.ui = out.ui; p.v++;
    await db.wbPrizeDone(uid, r.day);
  }
  if (rows.length) persist(uid, p);
}

// ---------- แชท/ทีม ----------
const CHATLOG = []; let CHAT_ID = Date.now(); // id เริ่มจากเวลา เพื่อให้รีสตาร์ทแล้ว id ยังมากกว่าของเดิมในหน้าเว็บ
const TEAM_MAX = 6, teamCache = new Map();
async function teamOf(uid) { if (teamCache.has(uid)) return teamCache.get(uid); const t = await db.getTeam(uid); teamCache.set(uid, t); return t; }

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
    await wbEnsure(); engine.setWB(wbCtx()); engine.setBoard(board(), u.id);
    await wbPrizes(u.id, p).catch(e => console.error('prize', e.message));
    const out = engine.run(p.s, p.ui, {}, E => E.enter());
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p); updateSnap(u.id, p);
    send(res, 200, { s: out.s, ui: out.ui, fx: [], fxt: {}, v: p.v, user: u.display, uid: u.id });
  },
  'POST /api/act': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const a = String(b.a || ''), pr = b.p == null ? null : String(b.p);
    if (!/^[a-z0-9]{1,20}$/.test(a) || (pr && pr.length > 80)) return send(res, 400, { error: 'คำสั่งไม่ถูกต้อง' });
    const p = await session(u.id);
    if (!takeToken(p)) return send(res, 429, { error: 'ส่งคำสั่งเร็วเกินไป' });
    const before = p.s.gold;
    engine.setBoard(board(), u.id); await wbEnsure(); engine.setWB(wbCtx());
    const out = engine.run(p.s, p.ui, cleanInputs(b.inp), E => E.act(a, pr));
    if (out.wb) await wbRecord(u.id, p, out.wb);
    p.s = out.s; p.ui = out.ui; p.v++; persist(u.id, p); updateSnap(u.id, p);
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
    engine.setBoard(board(), u.id); engine.setWB(wbCtx());
    const out = engine.run(p.s, p.ui, {}, E => { changed = E.tick(); });
    if (out.wb) await wbRecord(u.id, p, out.wb);
    p.s = out.s; p.ui = out.ui;
    if (changed || out.fx.length) { p.v++; persist(u.id, p); updateSnap(u.id, p); }
    if (!changed && !out.fx.length && Number(b.v) === p.v) return send(res, 200, { same: true, v: p.v });
    reply(res, p, out);
  },
  // ---------- แชท: โลก · ฝ่าย · ทีม · กระซิบ (เก็บในหน่วยความจำ 600 ข้อความล่าสุด) ----------
  'GET /api/chat': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const p = await session(u.id);
    const team = await teamOf(u.id);
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    const fac = p.s.fac == null ? null : p.s.fac;
    const out = [];
    for (const m of CHATLOG) {
      if (m.id <= since) continue;
      const ok = m.ch === 'world' || (m.ch === 'fac' && fac != null && m.key === fac) || (m.ch === 'team' && team && m.key === team) || (m.ch === 'dm' && (m.from === u.id || m.toId === u.id));
      if (ok) out.push({ id: m.id, ch: m.ch, n: m.n, t: m.t, to: m.to, mine: m.from === u.id });
    }
    send(res, 200, { msgs: out.slice(-120), team, fac, me: p.s.name || u.display });
  },
  'POST /api/chat': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    const ch = String(b.ch || ''), t = String(b.t || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!['world', 'fac', 'team', 'dm'].includes(ch) || !t) return send(res, 400, { error: 'ข้อความไม่ถูกต้อง' });
    const p = await session(u.id), now = Date.now();
    if (!p.s.created) return send(res, 400, { error: 'สร้างตัวละครก่อน' });
    if (now - (p.lastChat || 0) < 1200) return send(res, 429, { error: 'ส่งเร็วเกินไป รอสักครู่' });
    const m = { id: ++CHAT_ID, ch, n: String(p.s.name || u.display).slice(0, 16), t, from: u.id, ts: now };
    if (ch === 'fac') { if (p.s.fac == null) return send(res, 400, { error: 'ยังไม่ได้เข้าฝ่าย' }); m.key = p.s.fac; }
    if (ch === 'team') { const team = await teamOf(u.id); if (!team) return send(res, 400, { error: 'ยังไม่มีทีม' }); m.key = team; }
    if (ch === 'dm') {
      const to = String(b.to || '').trim().slice(0, 12);
      if (!to) return send(res, 400, { error: 'ใส่ชื่อผู้รับ' });
      let target = null;
      for (const [id, q] of live) if (q.s && q.s.name === to) { target = id; break; }
      if (!target) { const row = await db.findByName(to); if (row) target = Number(row.user_id); }
      if (!target) return send(res, 404, { error: 'ไม่พบผู้เล่นชื่อ ' + to });
      if (target === u.id) return send(res, 400, { error: 'กระซิบหาตัวเองไม่ได้' });
      m.toId = target; m.to = to;
    }
    p.lastChat = now;
    CHATLOG.push(m); if (CHATLOG.length > 600) CHATLOG.splice(0, CHATLOG.length - 600);
    send(res, 200, { ok: true, id: m.id });
  },
  'POST /api/team': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const b = await readBody(req);
    if (b.leave) { await db.delTeam(u.id); teamCache.delete(u.id); return send(res, 200, { team: '' }); }
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 16) return send(res, 400, { error: 'ชื่อทีมยาว 2–16 ตัวอักษร' });
    if ((await teamOf(u.id)) === name) return send(res, 200, { team: name });
    if ((await db.teamCount(name)) >= TEAM_MAX) return send(res, 409, { error: 'ทีมนี้เต็มแล้ว (' + TEAM_MAX + ' คน)' });
    await db.setTeam(u.id, name); teamCache.set(u.id, name);
    send(res, 200, { team: name });
  },
  'GET /api/wboss': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    await wbEnsure();
    const all = [...WB.dmg.entries()].sort((a, b) => b[1].dmg - a[1].dmg);
    const idx = all.findIndex(([id]) => id === u.id);
    send(res, 200, { day: WB.day, hp: WB_HP, left: Math.max(0, WB_HP - WB.total), total: WB.total, count: all.length,
      top: all.slice(0, 20).map(([id, x]) => ({ n: x.n, cls: x.cls, dmg: x.dmg, me: id === u.id })),
      me: idx >= 0 ? { rank: idx + 1, dmg: all[idx][1].dmg } : null, prev: WB.prev.map(x => ({ n: x.n })) });
  },
  'GET /api/fac': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    send(res, 200, { list: board().filter(x => x.fac != null).map(x => ({ id: x.id, fac: x.fac, wid: x.wid, pt: x.pt | 0, tries: x.tries | 0 })) });
  },
  'GET /api/ladder': async (req, res) => {
    const u = await auth(req); if (!u) return send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    const all = board().slice().sort((a, b) => (b.rating | 0) - (a.rating | 0));
    const idx = all.findIndex(x => x.id === u.id);
    send(res, 200, { top: all.slice(0, 10).map(x => ({ n: x.n, cls: x.cls, lvl: x.lvl, rating: x.rating, tt: x.tt, me: x.id === u.id })), rank: idx >= 0 ? idx + 1 : 0, total: all.length });
  },
  'GET /api/top': async (req, res) => send(res, 200, { top: (await db.top()).map(r => ({ name: r.name, cls: r.cls, lvl: r.level })) }),
  'GET /api/health': async (req, res) => send(res, 200, { ok: true, players: live.size, db: db.kind.split(' ')[0] }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  try {
    // เปิดลิงก์ /api/... หรือหน้าที่ไม่มีอยู่ตรงๆ ในเบราว์เซอร์ → พากลับหน้าเกม แทนการโชว์ข้อความ JSON
    if (req.method === 'GET' && url.pathname !== '/' && /text\/html/.test(req.headers.accept || '') && url.pathname !== '/index.html') {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
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

// รหัสลับเซ็นโทเคน: ใช้ JWT_SECRET ถ้าตั้งไว้ยาวพอ ไม่อย่างนั้นสร้างเองครั้งแรกแล้วเก็บในฐานข้อมูล (รีสตาร์ทแล้วยังเป็นค่าเดิม)
async function ensureSecret() {
  if (SECRET && SECRET.length >= 24) return 'env';
  let v = await db.getMeta('jwt_secret');
  if (!v) { await db.setMeta('jwt_secret', crypto.randomBytes(32).toString('hex')); v = await db.getMeta('jwt_secret'); }
  SECRET = v;
  return 'auto';
}
async function loadLadder() {
  for (const r of await db.allLadder()) { try { LADDER.set(Number(r.user_id), Object.assign(JSON.parse(r.snap), { id: Number(r.user_id), upd: Number(r.upd) })); } catch (e) {} }
  boardDirty = true;
}
db.init().then(ensureSecret).then(async src => { await loadLadder(); await wbEnsure();
  if (src === 'auto') console.log('JWT_SECRET: ไม่ได้ตั้งหรือสั้นเกินไป ใช้รหัสลับที่สร้างอัตโนมัติและเก็บในฐานข้อมูลแทน');
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
