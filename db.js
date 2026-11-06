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
  `CREATE TABLE IF NOT EXISTS trade173 (
    id TEXT PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, av INTEGER NOT NULL, bv INTEGER NOT NULL,
    ag INTEGER NOT NULL, bg INTEGER NOT NULL, ab TEXT NOT NULL, bb TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS trade173_commit AFTER INSERT ON trade173 BEGIN
    SELECT CASE WHEN NEW.a=NEW.b OR
      (SELECT COUNT(*) FROM saves WHERE (user_id=NEW.a AND ver=NEW.av) OR (user_id=NEW.b AND ver=NEW.bv))<>2
      THEN RAISE(ABORT,'trade_changed') END;
    UPDATE saves SET gold=NEW.ag,data=json_set(data,'$.gold',NEW.ag,'$.gbag',json(NEW.ab)),ver=ver+1,updated_at=NEW.at WHERE user_id=NEW.a;
    UPDATE saves SET gold=NEW.bg,data=json_set(data,'$.gold',NEW.bg,'$.gbag',json(NEW.bb)),ver=ver+1,updated_at=NEW.at WHERE user_id=NEW.b;
  END`,
  `CREATE TABLE IF NOT EXISTS guild169 (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    owner INTEGER NOT NULL, gold INTEGER NOT NULL DEFAULT 0, emblem TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guild_member169 (
    uid INTEGER PRIMARY KEY, gid INTEGER NOT NULL, joined INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS guild_member169_gid ON guild_member169(gid, joined, uid)`,
  `CREATE TABLE IF NOT EXISTS guild_settings174(gid INTEGER PRIMARY KEY, mode TEXT NOT NULL, min_level INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guild_roles174(uid INTEGER PRIMARY KEY, role TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guild_requests174(uid INTEGER NOT NULL,gid INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(uid,gid))`,
  `CREATE INDEX IF NOT EXISTS guild_requests174_gid ON guild_requests174(gid,at)`,
  `CREATE TRIGGER IF NOT EXISTS guild_join174_cleanup AFTER INSERT ON guild_member169 BEGIN
    DELETE FROM guild_requests174 WHERE uid=NEW.uid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS guild_leave174_cleanup AFTER DELETE ON guild_member169 BEGIN
    DELETE FROM guild_roles174 WHERE uid=OLD.uid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS guild_delete174_cleanup AFTER DELETE ON guild169 BEGIN
    DELETE FROM guild_requests174 WHERE gid=OLD.id;
    DELETE FROM guild_settings174 WHERE gid=OLD.id;
  END`,
  `CREATE TABLE IF NOT EXISTS guild_payment169 (
    id TEXT PRIMARY KEY, uid INTEGER NOT NULL, gid INTEGER NOT NULL, cost INTEGER NOT NULL,
    ver INTEGER NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, emblem TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS guild_payment169_apply AFTER INSERT ON guild_payment169 BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM saves WHERE user_id=NEW.uid AND ver=NEW.ver AND gold>=NEW.cost)
      THEN RAISE(ABORT,'guild_balance') END;
    SELECT CASE WHEN NEW.gid=0 AND EXISTS(SELECT 1 FROM guild_member169 WHERE uid=NEW.uid)
      THEN RAISE(ABORT,'guild_member') END;
    SELECT CASE WHEN NEW.gid=0 AND EXISTS(SELECT 1 FROM guild169 WHERE name_key=NEW.name_key)
      THEN RAISE(ABORT,'guild_name') END;
    SELECT CASE WHEN NEW.gid>0 AND NOT EXISTS(
      SELECT 1 FROM guild169 g JOIN guild_member169 m ON m.gid=g.id
      WHERE g.id=NEW.gid AND m.uid=NEW.uid AND g.gold+NEW.cost<=190000000)
      THEN RAISE(ABORT,'guild_donation') END;
    INSERT INTO guild169(name,name_key,owner,emblem)
      SELECT NEW.name,NEW.name_key,NEW.uid,NEW.emblem WHERE NEW.gid=0;
    INSERT INTO guild_member169(uid,gid,joined)
      SELECT NEW.uid,last_insert_rowid(),NEW.at WHERE NEW.gid=0;
    UPDATE guild169 SET gold=gold+NEW.cost WHERE id=NEW.gid;
    UPDATE saves SET data=json_set(data,'$.gold',gold-NEW.cost), gold=gold-NEW.cost,
      ver=ver+1, updated_at=NEW.at WHERE user_id=NEW.uid;
  END`,
  `CREATE TRIGGER IF NOT EXISTS guild_member169_leave AFTER DELETE ON guild_member169 BEGIN
    DELETE FROM guild169 WHERE id=OLD.gid AND NOT EXISTS(SELECT 1 FROM guild_member169 WHERE gid=OLD.gid);
    UPDATE guild169 SET owner=(SELECT uid FROM guild_member169 WHERE gid=OLD.gid ORDER BY joined,uid LIMIT 1)
      WHERE id=OLD.gid AND owner=OLD.uid;
  END`,
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
  recentSaves: `SELECT s.user_id, s.data, s.updated_at FROM saves s JOIN users u ON u.id = s.user_id
    WHERE u.banned = 0 AND s.updated_at > ? ORDER BY s.updated_at DESC LIMIT 60`,
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
  putMeta: 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
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
    trade173: (id,a,b,av,bv,ag,bg,ab,bb) => B.run(
      'INSERT INTO trade173 VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      [id,a,b,av,bv,ag,bg,JSON.stringify(ab),JSON.stringify(bb),Date.now()]),
    tradeDone173: id => B.get('SELECT id FROM trade173 WHERE id=?',[id]),
    guildById169: id => B.get('SELECT g.*,cfg.mode,cfg.min_level FROM guild169 g LEFT JOIN guild_settings174 cfg ON cfg.gid=g.id WHERE g.id=?',[id]),
    guild169: uid => B.get('SELECT g.*,cfg.mode,cfg.min_level FROM guild169 g JOIN guild_member169 m ON m.gid=g.id LEFT JOIN guild_settings174 cfg ON cfg.gid=g.id WHERE m.uid=?', [uid]),
    guildList169: () => B.all(`SELECT g.*,cfg.mode,cfg.min_level, (SELECT COUNT(*) FROM guild_member169 m WHERE m.gid=g.id) AS members
      FROM guild169 g LEFT JOIN guild_settings174 cfg ON cfg.gid=g.id ORDER BY g.gold DESC,g.id LIMIT 100`),
    guildRoster169: gid => B.all(`SELECT m.uid,s.name,s.level,r.role FROM guild_member169 m JOIN saves s ON s.user_id=m.uid LEFT JOIN guild_roles174 r ON r.uid=m.uid
      WHERE m.gid=? ORDER BY m.joined,m.uid`, [gid]),
    guildSettings174: (gid,mode,lv) => B.run(`INSERT INTO guild_settings174 VALUES (?,?,?)
      ON CONFLICT(gid) DO UPDATE SET mode=excluded.mode,min_level=excluded.min_level`,[gid,mode,lv]),
    guildRole174: (uid,role) => B.run(`INSERT INTO guild_roles174 VALUES (?,?)
      ON CONFLICT(uid) DO UPDATE SET role=excluded.role`,[uid,role]),
    guildApply174: (uid,gid) => B.run('INSERT OR IGNORE INTO guild_requests174 VALUES (?,?,?)',[uid,gid,Date.now()]),
    guildRequests174: gid => B.all(`SELECT r.uid,s.name,s.level FROM guild_requests174 r JOIN saves s ON s.user_id=r.uid
      WHERE r.gid=? ORDER BY r.at,r.uid`,[gid]),
    guildApplied174: uid => B.all('SELECT gid FROM guild_requests174 WHERE uid=?',[uid]),
    guildReject174: (uid,gid) => B.run('DELETE FROM guild_requests174 WHERE uid=? AND gid=?',[uid,gid]),
    guildPayment169: id => B.get('SELECT id FROM guild_payment169 WHERE id=?',[id]),
    guildPay169: (id,uid,gid,cost,ver,name,key,emblem,at) => B.run(
      'INSERT INTO guild_payment169 VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',[id,uid,gid,cost,ver,name,key,emblem,at]),
    guildJoin169: (uid,gid) => B.get(`INSERT INTO guild_member169(uid,gid,joined)
      SELECT ?,id,? FROM guild169 WHERE id=? AND (SELECT COUNT(*) FROM guild_member169 WHERE gid=?)<20
      ON CONFLICT(uid) DO NOTHING RETURNING gid`, [uid,Date.now(),gid,gid]),
    guildLeave169: uid => B.run('DELETE FROM guild_member169 WHERE uid=?', [uid]),
    guildEmblem169: (uid,emblem) => B.get('UPDATE guild169 SET emblem=? WHERE owner=? RETURNING id', [emblem,uid]),
    kind: B.kind,
    init: B.init,
    userByName: n => B.get(SQL.userByName, [n]),
    userById: id => B.get(SQL.userById, [id]),
    addUser: async (u, d, salt, hash) => (await B.run(SQL.addUser, [u, d, salt, hash, Date.now()])).lastId,
    bumpTok: id => B.run(SQL.bumpTok, [id]),
    getSave: uid => B.get(SQL.getSave, [uid]),
    putSave: (uid, data, ver, name, cls, level, gold) => B.run(SQL.putSave, [uid, data, ver, name, cls, level, gold, Date.now()]),
    top: () => B.all(SQL.top),
    recentSaves: since => B.all(SQL.recentSaves, [since]),
    audit: (uid, kind, detail) => B.run(SQL.audit, [uid, Date.now(), kind, detail]),
    getMeta: async k => { const r = await B.get(SQL.getMeta, [k]); return r ? r.v : null; },
    setMeta: (k, v) => B.run(SQL.setMeta, [k, v]),
    putMeta: (k, v) => B.run(SQL.putMeta, [k, v]),
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
