// engine.js — โหลดโค้ดเกมจาก public/index.html มารันบนเซิร์ฟเวอร์ (โหมด server)
// เซิร์ฟเวอร์ใช้กติกาเกมชุดเดียวกับหน้าเว็บทุกบรรทัด แต่หน้าเว็บแก้ผลไม่ได้ เพราะสถานะจริงอยู่ที่เซิร์ฟเวอร์
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeStubs(inputs) {
  // องค์ประกอบปลอม: รับค่าอะไรก็ได้ ไม่ทำอะไร (เซิร์ฟเวอร์ไม่มีหน้าจอ)
  const noop = () => {};
  const ctx2d = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'measureText') return () => ({ width: 0 });
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = {
        id, innerHTML: '', textContent: '', className: '', hidden: false, disabled: false, type: '',
        style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop, setPointerCapture: noop,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        scrollTop: 0, clientHeight: 0, scrollHeight: 0, querySelector: () => null, querySelectorAll: () => [],
        getContext: () => ctx2d, toDataURL: () => '', width: 0, height: 0,
      };
    }
    // ช่องกรอกข้อความ (ชื่อตัวละคร ฯลฯ) ใช้ค่าที่หน้าเว็บส่งมากับคำสั่ง
    els[id].value = inputs.cur[id] != null ? String(inputs.cur[id]).slice(0, 40) : '';
    return els[id];
  }
  const document = {
    hidden: false, activeElement: null, body: el('body'),
    getElementById: el,
    createElement: () => ({ getContext: () => ctx2d, toDataURL: () => '', width: 0, height: 0, style: {} }),
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  };
  const mem = {};
  const localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  class Image { constructor() { this.complete = false; this.naturalWidth = 0; } set src(v) { this._s = v; } get src() { return this._s; } }
  return { document, localStorage, Image, ctx2d };
}

function loadEngine(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const code = scripts[scripts.length - 1];
  if (!code) throw new Error('ไม่พบโค้ดเกมใน ' + htmlPath);
  const inputs = { cur: {} };
  const st = makeStubs(inputs);
  const window = {
    GAME_MODE: 'server', innerWidth: 400, innerHeight: 800,
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
  };
  const sandbox = {
    window, document: st.document, localStorage: st.localStorage, Image: st.Image,
    navigator: { userAgent: 'server' }, performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    console, Math, Date, JSON, crypto: require('crypto').webcrypto, TextEncoder, TextDecoder,
    // VM contexts do not inherit Node's browser-compatible Base64 globals.
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    fetch: () => Promise.reject(new Error('no fetch on server')),
  };
  window.window = window;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'game-engine.js' });
  const E = window.ENGINE;
  if (!E) throw new Error('โค้ดเกมไม่ได้เปิด ENGINE (ต้องเป็นไฟล์เกมรุ่นที่รองรับโหมด server)');
  return {
    fresh: () => clone(E.fresh()),
    normalize: o => clone(E.normalize(o)),
    snap: st => { try { return E.snap(clone(st)); } catch (e) { return null; } },
    setBoard: (b, uid) => E.setBoard(b, uid),
    setWB: w => E.setWB(w),
    // รันคำสั่งหนึ่งครั้งบนสถานะของผู้เล่นคนเดียว แล้วคืนสถานะใหม่ (คัดลอกออกมา ไม่ให้ชี้ข้ามผู้เล่น)
    run(state, ui, inp, fn) {
      inputs.cur = inp || {};
      try {
        const out = E.run(state, ui, () => fn(E));
        return clone(out);
      } finally { inputs.cur = {}; }
    },
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = { loadEngine };
if (require.main === module) {
  const eng = loadEngine(path.join(__dirname, 'public', 'index.html'));
  const s = eng.fresh();
  console.log('engine ok · new state keys:', Object.keys(s).length, 'gold', s.gold);
}
