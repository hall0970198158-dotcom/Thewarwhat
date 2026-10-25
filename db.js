// db.js — ชั้นฐานข้อมูล ใช้ได้ 2 แบบ (คำสั่ง SQL ชุดเดียวกัน)
//   1) Turso (SQLite บนคลาวด์ ใช้ฟรี) — เมื่อตั้ง TURSO_URL และ TURSO_TOKEN   ← ใช้กับ Render แพ็กเกจฟรี
//   2) ไฟล์ SQLite ในเครื่อง (node:sqlite)  — เมื่อไม่ได้ตั้ง TURSO_URL       ← ใช้ตอนรันในเครื่อง / โฮสต์ที่มีดิสก์ถาวร
'use strict';
const path = require('path');
const fs = require('fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    token_ver INTEGER NOT NULL DEFAULT 1,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS saves (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    ver INTEGER NOT NULL DEFAULT 0,
    name TEXT, cls TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    gold INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS saves_level ON saves(level DESC)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS teams (user_id INTEGER PRIMARY KEY, team TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wbdmg (day INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT, cls TEXT, dmg INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, user_id))`,
  `CREATE TABLE IF NOT EXISTS wbprize (user_id INTEGER NOT NULL, day INTEGER NOT NULL, rank INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))`,
  `CREATE TABLE IF NOT EXISTS wbkill (user_id INTEGER NOT NULL, day INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))`,
  `CREATE TABLE IF NOT EXISTS ladder (user_id INTEGER PRIMARY KEY, snap TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, upd INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS teams_team ON teams(team)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, at INTEGER, kind TEXT, detail TEXT)`,
];
const SQL = {
  userByName: 'SELECT * FROM users WHERE username = ?',
  userById: 'SELECT * FROM users WHERE id = ?',
  addUser: 'INSERT INTO users (username, display, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  bumpTok: 'UPDATE users SET token_ver = token_ver + 1 WHERE id = ?',
  getSave: 'SELECT data, ver FROM saves WHERE user_id = ?',
  putSave: `INSERT INTO saves (user_id, data, ver, name, cls, level, gold, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, ver = excluded.ver, name = excluded.name, cls = excluded.cls,
    level = excluded.level, gold = excluded.gold, updated_at = excluded.updated_at`,
  top: `SELECT s.name, s.cls, s.level FROM saves s JOIN users u ON u.id = s.user_id
    WHERE u.banned = 0 AND s.name IS NOT NULL AND s.name <> '' ORDER BY s.level DESC, s.updated_at ASC LIMIT 50`,
  audit: 'INSERT INTO audit (user_id, at, kind, detail) VALUES (?, ?, ?, ?)',
  getMeta: 'SELECT v FROM meta WHERE k = ?',
  getTeam: 'SELECT team FROM teams WHERE user_id = ?',
  wbAdd: `INSERT INTO wbdmg (day, user_id, name, cls, dmg) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, user_id) DO UPDATE SET dmg = dmg + excluded.dmg, name = excluded.name, cls = excluded.cls`,
  wbDay: 'SELECT user_id, name, cls, dmg FROM wbdmg WHERE day = ? ORDER BY dmg DESC',
  wbPrizeAdd: 'INSERT OR IGNORE INTO wbprize (user_id, day, rank) VALUES (?, ?, ?)',
  wbPrizeGet: 'SELECT day, rank FROM wbprize WHERE user_id = ? AND claimed = 0',
  wbPrizeDone: 'UPDATE wbprize SET claimed = 1 WHERE user_id = ? AND day = ?',
  wbKillAdd: 'INSERT OR IGNORE INTO wbkill (user_id, day) VALUES (?, ?)',
  wbKillGet: 'SELECT day FROM wbkill WHERE user_id = ? AND claimed = 0',
  wbKillDone: 'UPDATE wbkill SET claimed = 1 WHERE user_id = ? AND day = ?',
  putLadder: 'INSERT INTO ladder (user_id, snap, rating, upd) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET snap = excluded.snap, rating = excluded.rating, upd = excluded.upd',
  allLadder: 'SELECT l.user_id, l.snap, l.upd FROM ladder l JOIN users u ON u.id = l.user_id WHERE u.banned = 0',
  setTeam: 'INSERT INTO teams (user_id, team) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET team = excluded.team',
  delTeam: 'DELETE FROM teams WHERE user_id = ?',
  teamCount: 'SELECT COUNT(*) AS n FROM teams WHERE team = ?',
  findByName: 'SELECT user_id, name FROM saves WHERE name = ? ORDER BY updated_at DESC LIMIT 1',
  setMeta: 'INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)',
};

// ---------- แบบ 1: Turso ผ่าน HTTP (ไม่ต้องติดตั้งแพ็กเกจ) ----------
function tursoBackend(url, token) {
  const base = url.replace(/^libsql:\/\//, 'https://').replace(/^wss:\/\//, 'https://').replace(/\/+$/, '');
  const toArg = v => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  };
  const fromVal = x => {
    if (!x || x.type === 'null') return null;
    if (x.type === 'integer') return Number(x.value);
    if (x.type === 'float') return Number(x.value);
    return x.value;
  };
  async function pipeline(stmts) {
    const body = { requests: stmts.map(([sql, args]) => ({ type: 'execute', stmt: { sql, args: (args || []).map(toArg) } })).concat([{ type: 'close' }]) };
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(base + '/v2/pipeline', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error('Turso HTTP ' + r.status + ': ' + text.slice(0, 200));
        const j = JSON.parse(text);
        return j.results.slice(0, stmts.length).map(res => {
          if (res.type !== 'ok') throw new Error('Turso: ' + ((res.error && res.error.message) || 'error'));
          const R = res.response.result;
          const cols = R.cols.map(c => c.name);
          return {
            rows: R.rows.map(row => { const o = {}; row.forEach((v, i) => { o[cols[i]] = fromVal(v); }); return o; }),
            lastId: R.last_insert_rowid == null ? null : Number(R.last_insert_rowid),
          };
        });
      } catch (e) { lastErr = e; if (/Turso: /.test(e.message)) break; await new Promise(z => setTimeout(z, 300 * (attempt + 1))); }
    }
    throw lastErr;
  }
  const one = async (sql, args) => (await pipeline([[sql, args]]))[0];
  return {
    kind: 'turso ' + base,
    init: () => pipeline(SCHEMA.map(s => [s])),
    get: async (sql, args) => (await one(sql, args)).rows[0] || null,
    all: async (sql, args) => (await one(sql, args)).rows,
    run: async (sql, args) => ({ lastId: (await one(sql, args)).lastId }),
  };
}

// ---------- แบบ 2: ไฟล์ SQLite ในเครื่อง ----------
function localBackend(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const prep = {};
  const P = sql => prep[sql] || (prep[sql] = db.prepare(sql));
  return {
    kind: 'sqlite ' + file,
    init: async () => { for (const s of SCHEMA) db.exec(s); },
    get: async (sql, args) => P(sql).get(...(args || [])) || null,
    all: async (sql, args) => P(sql).all(...(args || [])),
    run: async (sql, args) => { const r = P(sql).run(...(args || [])); return { lastId: Number(r.lastInsertRowid) }; },
  };
}

function createDb() {
  const B = process.env.TURSO_URL
    ? tursoBackend(process.env.TURSO_URL, process.env.TURSO_TOKEN || '')
    : localBackend(process.env.DB_PATH || path.join(__dirname, 'data', 'game.db'));
  return {
    kind: B.kind,
    init: B.init,
    userByName: n => B.get(SQL.userByName, [n]),
    userById: id => B.get(SQL.userById, [id]),
    addUser: async (u, d, salt, hash) => (await B.run(SQL.addUser, [u, d, salt, hash, Date.now()])).lastId,
    bumpTok: id => B.run(SQL.bumpTok, [id]),
    getSave: uid => B.get(SQL.getSave, [uid]),
    putSave: (uid, data, ver, name, cls, level, gold) => B.run(SQL.putSave, [uid, data, ver, name, cls, level, gold, Date.now()]),
    top: () => B.all(SQL.top),
    audit: (uid, kind, detail) => B.run(SQL.audit, [uid, Date.now(), kind, detail]),
    getMeta: async k => { const r = await B.get(SQL.getMeta, [k]); return r ? r.v : null; },
    setMeta: (k, v) => B.run(SQL.setMeta, [k, v]),
    putLadder: (uid, snap, rating) => B.run(SQL.putLadder, [uid, snap, rating, Date.now()]),
    allLadder: () => B.all(SQL.allLadder),
    wbAdd: (day, uid, name, cls, dmg) => B.run(SQL.wbAdd, [day, uid, name, cls, dmg]),
    wbDay: day => B.all(SQL.wbDay, [day]),
    wbPrizeAdd: (uid, day, rank) => B.run(SQL.wbPrizeAdd, [uid, day, rank]),
    wbPrizeGet: uid => B.all(SQL.wbPrizeGet, [uid]),
    wbPrizeDone: (uid, day) => B.run(SQL.wbPrizeDone, [uid, day]),
    wbKillAdd: (uid, day) => B.run(SQL.wbKillAdd, [uid, day]),
    wbKillGet: uid => B.all(SQL.wbKillGet, [uid]),
    wbKillDone: (uid, day) => B.run(SQL.wbKillDone, [uid, day]),
    getTeam: async uid => { const r = await B.get(SQL.getTeam, [uid]); return r ? r.team : ''; },
    setTeam: (uid, team) => B.run(SQL.setTeam, [uid, team]),
    delTeam: uid => B.run(SQL.delTeam, [uid]),
    teamCount: async team => { const r = await B.get(SQL.teamCount, [team]); return r ? Number(r.n) : 0; },
    findByName: name => B.get(SQL.findByName, [name]),
  };
}
module.exports = { createDb };
