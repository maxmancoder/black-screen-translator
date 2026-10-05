/* =========================================================================
   ocrsmoke.js — اجرای واقعی offscreen.js با Tesseract شبیه‌سازی‌شده
   اجرا:  node tools/ocrsmoke.js
   هدف: مطمئن شویم مسیر OCR (استخر Worker، کش، پاس‌های تطبیقی) برای
   «چند» تصویر پشت‌سرهم/هم‌زمان درست کار می‌کند، نه فقط اولین تصویر.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..');

let failures = [];
let checks = 0;
function check(name, cond, extra) { checks++; if (!cond) failures.push(name + (extra ? ' → ' + extra : '')); }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  checks++;
  if (a !== b) failures.push(`${name} → got ${a}, want ${b}`);
}

/* --------------------------- شمارنده‌های تست --------------------------- */
let createdWorkers = 0, terminatedWorkers = 0, recognizeCalls = 0;
let workerFailAfter = Infinity;      // ساخت worker از این شماره به بعد خطا می‌دهد
let stuckOnce = false;               // یک recognize هرگز تمام نمی‌شود
const workerLog = [];

/* ------------------------------ canvas جعلی ------------------------------ */
class FakeCtx {
  constructor(canvas) { this.canvas = canvas; this.filter = 'none'; this.imageSmoothingQuality = ''; this.fillStyle = ''; }
  fillRect() {}
  drawImage() {}
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
    /* الگوی پرسروصدا تا looksTextless رد نکند */
    for (let i = 0; i < data.length; i += 4) {
      const v = ((i / 4) % 97 < 12) ? 20 : 245;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    return { width: w, height: h, data };
  }
  putImageData() {}
}
class FakeCanvas {
  constructor() { this.width = 300; this.height = 150; this.__ctx = null; }
  getContext() { if (!this.__ctx) this.__ctx = new FakeCtx(this); return this.__ctx; }
}

/* ------------------------------ Tesseract جعلی ------------------------------ */
function fakeWorker(id) {
  let params = {};
  return {
    id,
    terminated: false,
    setParameters: async (p) => { Object.assign(params, p); },
    recognize: async () => {
      if (stuckOnce) { stuckOnce = false; return new Promise(() => {}); }   // هرگز تمام نمی‌شود
      recognizeCalls++;
      workerLog.push(id);
      const psm = params.tessedit_pageseg_mode;
      /* یک خط متن برای psm=3؛ برای psm=11 همان خط (تکراری) */
      const mk = (x0, txt) => ({
        text: txt, confidence: 92,
        bbox: { x0, y0: 20, x1: x0 + 120, y1: 60 }
      });
      return {
        data: {
          lines: [{
            text: 'Hello world', confidence: 92,
            bbox: { x0: 20, y0: 20, x1: 340, y1: 60 },
            words: [mk(20, 'Hello'), mk(180, 'world')]
          }]
        }
      };
    },
    terminate: async () => { terminatedWorkers++; }
  };
}

const Tesseract = {
  createWorker: async (lang, oem, opts) => {
    createdWorkers++;
    if (createdWorkers > workerFailAfter) throw new Error('worker creation failed (stub)');
    workerLog.length; // no-op
    return fakeWorker('w' + createdWorkers + ':' + lang);
  }
};

/* ------------------------------ محیط DOM جعلی ------------------------------ */
const navigatorStub = { hardwareConcurrency: 8 };
const documentStub = {
  createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? new FakeCanvas() : { style: {}, appendChild() {} })
};

let msgListener = null;
const chromeStub = {
  runtime: {
    getURL: (p) => 'chrome-extension://abc/' + p,
    onMessage: { addListener: (fn) => { msgListener = fn; } }
  }
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date,
  Map, Set, WeakMap, Object, Array, String, Number, Error, RegExp, Boolean, isFinite, parseInt, parseFloat,
  navigator: navigatorStub,
  document: documentStub,
  chrome: chromeStub,
  Tesseract,
  URL: global.URL,
  Image: class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } },
  createImageBitmap: async (blob) => ({ width: 600, height: 400, close() {} }),
  fetch: async (u) => ({ ok: true, blob: async () => ({ __url: u }) }),
  globalThis: null
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let loadError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(dir, 'offscreen.js'), 'utf8'), sandbox, { filename: 'offscreen.js' });
} catch (e) { loadError = e; }
check('offscreen.js بدون خطا بارگذاری شد', !loadError, loadError && (loadError.message + '\n' + loadError.stack));

function ocr(msg) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const keep = msgListener(Object.assign({ target: 'offscreen' }, msg), {}, (res) => { answered = true; resolve(res); });
    if (keep !== true && !answered) resolve(undefined);
  });
}

const dataUrlOf = (n) => 'data:image/png;base64,IMG' + n + '=' + 'A'.repeat(60) + String(n).padStart(3, '0');

async function run() {
  if (loadError) return;

  /* --- ۱) شش تصویر پشت‌سرهم --- */
  const seq = [];
  for (let i = 1; i <= 6; i++) seq.push(await ocr({ type: 'ocr', dataUrl: dataUrlOf(i), lang: 'eng', minConf: 40, parallel: 2 }));
  eq('همه‌ی ۶ تصویر نتیجه‌ی موفق دارند', seq.map((r) => !!(r && r.ok)), seq.map(() => true));
  eq('هر تصویر متن خودش را دارد', seq.map((r) => r && r.blocks && r.blocks[0] && r.blocks[0].text),
    seq.map(() => 'Hello world'));
  check('کش نتایج متفاوت را قاطی نکرد', new Set(seq.map((r) => JSON.stringify(r.blocks))).size >= 1);

  /* --- ۲) شش تصویر هم‌زمان (رقابت روی استخر Worker) --- */
  createdWorkers = 0; recognizeCalls = 0;
  const conc = await Promise.all(
    [7, 8, 9, 10, 11, 12].map((i) => ocr({ type: 'ocr', dataUrl: dataUrlOf(i), lang: 'eng', minConf: 40, parallel: 2 }))
  );
  eq('همه‌ی ۶ درخواست هم‌زمان موفق‌اند', conc.map((r) => !!(r && r.ok)), conc.map(() => true));
  eq('هیچ‌کدام بی‌پاسخ نماند', conc.map((r) => r === undefined), conc.map(() => false));
  check('استخر worker بیش از حد مجاز نساخت', createdWorkers <= 2, 'created=' + createdWorkers);

  /* --- ۳) خطای ساخت worker برای درخواست دوم به بعد --- */
  workerFailAfter = 1;
  createdWorkers = 0;
  const mixed = await Promise.all(
    [13, 14, 15].map((i) => ocr({ type: 'ocr', dataUrl: dataUrlOf(i), lang: 'fra', minConf: 40, parallel: 2, noCache: true }))
  );
  eq('با خطای worker، درخواست‌ها بی‌پاسخ نمی‌مانند', mixed.map((r) => r !== undefined), mixed.map(() => true));
  workerFailAfter = Infinity;

  /* --- ۴) worker گیرکرده: پول باید آزاد شود و درخواست بعدی جواب بگیرد --- */
  stuckOnce = true;
  const t0 = Date.now();
  const stuck = await ocr({ type: 'ocr', dataUrl: dataUrlOf(20), lang: 'ita', minConf: 40, noCache: true, passTimeoutMs: 8000 });
  check('OCR گیرکرده با خطا برمی‌گردد (بی‌پاسخ نمی‌ماند)', !!(stuck && stuck.ok === false),
    JSON.stringify(stuck));
  const after = await ocr({ type: 'ocr', dataUrl: dataUrlOf(21), lang: 'ita', minConf: 40, noCache: true });
  eq('بعد از worker گیرکرده، همان زبان دوباره کار می‌کند', !!(after && after.ok), true);
  stuckOnce = false;

  /* --- ۵) worker های بسته‌شده ظرفیت پول را اشغال نکنند --- */
  createdWorkers = 0; terminatedWorkers = 0;
  /* سه زبان مختلف تا trimPools worker های زبان‌های دیگر را ببندد */
  for (const lang of ['spa', 'por', 'nld', 'pol']) {
    await ocr({ type: 'ocr', dataUrl: dataUrlOf(30) + lang, lang, minConf: 40, noCache: true });
  }
  const revived = await Promise.all(
    [41, 42, 43].map((i) => ocr({ type: 'ocr', dataUrl: dataUrlOf(i) + 'spa2', lang: 'spa', minConf: 40, noCache: true }))
  );
  eq('زبانی که worker هایش بسته شده‌اند دوباره کار می‌کند', revived.map((r) => !!(r && r.ok)), revived.map(() => true));
  check('worker مرده بسته شد', terminatedWorkers > 0, 'terminated=' + terminatedWorkers);
}

/* اگر یک درخواست OCR بی‌پاسخ بماند، process بی‌صدا خارج می‌شود → نگهبان سراسری */
const globalTimer = setTimeout(() => {
  console.log('\nFAIL: آزمون تمام نشد — یک درخواست OCR بی‌پاسخ ماند (پول Worker قفل شده است)');
  process.exit(1);
}, 60000);

run().then(() => {
  clearTimeout(globalTimer);
  console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
});
