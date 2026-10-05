/* =========================================================================
   imgsmoke.js — اجرای واقعی content.js روی DOM شبیه‌سازی‌شده با چند تصویر
   اجرا:  node tools/imgsmoke.js
   هدف: مطمئن شویم «همه‌ی» عکس‌های صفحه به OCR فرستاده و ترجمه می‌شوند،
   نه فقط یکی از آن‌ها (مسیر: considerImage → pumpImages → processImage →
   addImageBlocks → queueTranslate → renderNow).
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..');

let failures = [];
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures.push(name + (extra ? ' → ' + extra : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  checks++;
  if (a !== b) failures.push(`${name} → got ${a}, want ${b}`);
}

/* ------------------------------ micro DOM ------------------------------ */
const DEFAULT_STYLE = {
  display: 'block', position: 'static', overflowX: 'visible', overflowY: 'visible', opacity: '1',
  visibility: 'visible', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', fontStyle: 'normal',
  color: 'rgb(0,0,0)', backgroundColor: 'rgb(255,255,255)', backgroundImage: 'none', backgroundSize: 'auto',
  backgroundPosition: '0% 0%', objectFit: 'fill', objectPosition: '50% 50%', textAlign: 'left', zIndex: 'auto',
  borderLeftWidth: '0px', borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px',
  paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', clipPath: '', transform: 'none'
};

class SNode {
  constructor(type, name) {
    this.nodeType = type;
    this.nodeName = name || (type === 3 ? '#text' : 'DIV');
    this.tagName = type === 1 ? String(name || 'DIV').toUpperCase() : undefined;
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
    this.style = { cssText: '', fontSize: '', fontFamily: '', fontWeight: '', fontStyle: '', textAlign: '',
      width: '', height: '', left: '', top: '', background: '', color: '', padding: '', borderRadius: '', clipPath: '' };
    this.dataset = {};
    this.isConnected = false;
    this.__style = Object.assign({}, DEFAULT_STYLE);
    this.__rect = { left: 0, top: 0, right: 300, bottom: 60, width: 300, height: 60 };
    this.__listeners = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => { if (on === undefined) on = !this.classList._s.has(c); on ? this.classList._s.add(c) : this.classList._s.delete(c); }
    };
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    if (this.nodeType === 3) { this.nodeValue = v; return; }
    this.childNodes = [];
    if (v !== '') this.appendChild(new SNode(3, '#text'));
    if (v !== '' && this.childNodes[0]) this.childNodes[0].nodeValue = String(v);
  }
  get isContentEditable() { return false; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    this.childNodes.push(child);
    child.__markConnected(this.isConnected);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    child.__markConnected(false);
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertBefore(child, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this.nodeType === 1 ? this : null;
    this.childNodes.splice(i, 0, child);
    child.__markConnected(this.isConnected);
    return child;
  }
  __markConnected(v) {
    this.isConnected = v;
    this.childNodes.forEach((c) => c.__markConnected(v));
  }
  setAttribute(k, v) { this.__attrs = this.__attrs || {}; this.__attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.__attrs && this.__attrs[k] != null ? this.__attrs[k] : null; }
  removeAttribute(k) { if (this.__attrs) delete this.__attrs[k]; }
  addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(t) { (this.__listeners[t] || []).forEach((fn) => fn({ type: t, target: this })); }
  getBoundingClientRect() {
    const y = (typeof windowStub !== 'undefined' && windowStub.scrollY) || 0;
    const r = this.__rect;
    return { left: r.left, top: r.top - y, right: r.right, bottom: r.bottom - y,
      width: r.width, height: r.height, x: r.left, y: r.top - y };
  }
  getClientRects() { return [this.__rect]; }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  attachShadow() { this.shadowRoot = new SShadow(); return this.shadowRoot; }
  closest() { return null; }
  matches() { return false; }
  contains(n) { let x = n; while (x) { if (x === this) return true; x = x.parentNode; } return false; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get clientLeft() { return 0; }
  get clientWidth() { return this.__rect.width; }
  get clientHeight() { return this.__rect.height; }
  /* IMG: آدرس مطلق مثل مرورگر */
  get currentSrc() { return this.tagName === 'IMG' ? (this.getAttribute('src') || '') : undefined; }
  get src() { return this.tagName === 'IMG' ? (this.getAttribute('src') || '') : undefined; }
}

class SShadow extends SNode {
  constructor() { super(1, '#shadow-root'); this.nodeName = '#shadow-root'; this.shadowRoot = null; }
  querySelectorAll(sel) { return collect(this, sel); }
  querySelector(sel) { return collect(this, sel)[0] || null; }
}

function collect(root, sel) {
  const out = [];
  const want = String(sel || '').toUpperCase();
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 1 && (want === '*' || c.tagName === want)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

function text(t) { const n = new SNode(3, '#text'); n.nodeValue = t; return n; }
function el(tag, opts) {
  const e = new SNode(1, tag);
  if (opts) {
    if (opts.style) Object.assign(e.__style, opts.style);
    if (opts.rect) e.__rect = Object.assign({}, e.__rect, opts.rect);
    if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  }
  return e;
}
Object.defineProperty(SNode.prototype, 'type', { get() { return this.getAttribute('type') || ''; }, configurable: true });
Object.defineProperty(SNode.prototype, 'value', { get() { return this.getAttribute('value') || ''; }, configurable: true });

const documentElement = el('html');
const body = el('body');
documentElement.appendChild(body);
documentElement.__markConnected(true);

const documentStub = {
  documentElement, body, hidden: false, images: [],
  fonts: { ready: Promise.resolve() },
  scrollingElement: documentElement,
  createElement: (tag) => new SNode(1, tag),
  createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
  elementFromPoint: () => null,
  addEventListener: () => {}, removeEventListener: () => {},
  querySelectorAll: () => []
};

const winListeners = {};
const windowStub = {
  innerWidth: 1200, innerHeight: 3000, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
  addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener: () => {},
  getComputedStyle: (e) => e.__style || DEFAULT_STYLE,
  requestAnimationFrame: (fn) => setTimeout(() => fn(performanceNow()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  SVGElement: class {}, ShadowRoot: class {},
  Element: SNode, Node: SNode, HTMLElement: SNode,
  performance: { now: () => performanceNow() },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console
};
windowStub.window = windowStub;
windowStub.top = windowStub;
windowStub.self = windowStub;

let __t = 0;
function performanceNow() { return (__t += 4.7); }

/* --------------------------- chrome API stubs --------------------------- */
const sent = [];
let ocrFails = new Set();          // src هایی که OCR آن‌ها خطا می‌دهد
const ocrCalls = [];               // ترتیب و تعداد درخواست‌های OCR
let captureCalls = 0;
let captureFail = false;

let contentListener = null;
let storageListener = null;
let hangSet = new Set();           // src هایی که پاسخ OCR هرگز نمی‌رسد (Worker گیرکرده)
const chromeStub = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { contentListener = fn; } },
    sendMessage: (msg, cb) => {
      sent.push(msg);
      let res = { ok: true };
      if (msg.type === 'hello') res = { active: true };
      else if (msg.type === 'status') res = { ok: true, active: true };
      else if (msg.type === 'translate') res = { ok: true, translations: msg.texts.map((t) => 'TT:' + t), engine: 'stub', ms: 3 };
      else if (msg.type === 'capture-ocr') {
        captureCalls++;
        res = captureFail ? { ok: false, error: 'capture blocked (stub)' }
          : { ok: true, width: 1200, height: 900, blocks: [] };
      }
      else if (msg.type === 'ocr') {
        const src = msg.src || 'data:';
        ocrCalls.push(src);
        if (hangSet.has(src)) return new Promise(() => {});   // هرگز پاسخ نمی‌دهد
        if (ocrFails.has(src)) res = { ok: false, error: 'stub failure' };
        else {
          const n = /^.*img(\d+)/.exec(src);
          res = {
            ok: true, width: 600, height: 400,
            blocks: [{
              text: 'Text inside image ' + (n ? n[1] : '?'),
              lines: 1,
              bbox: { x0: 20, y0: 20, x1: 400, y1: 60 },
              lineHeight: 40, bg: '#ffffff', fg: '#111111'
            }]
          };
        }
      }
      if (cb) setTimeout(() => cb(res), 1);
      return Promise.resolve(res);
    }
  },
  storage: {
    sync: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: (fn) => { storageListener = fn; } }
  }
};

/* ------------------------------ sandbox ------------------------------ */
const sandbox = Object.assign({
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, Set, Map, WeakMap, WeakSet, RegExp, Error, String, Number, Array, Object,
  isFinite, parseInt, parseFloat, Boolean, Symbol, fetch: () => Promise.reject(new Error('no net')),
  FileReader: class {}, URL: global.URL, AbortController,
  chrome: chromeStub, document: documentStub, window: windowStub,
  getComputedStyle: windowStub.getComputedStyle,
  requestAnimationFrame: windowStub.requestAnimationFrame,
  cancelAnimationFrame: windowStub.cancelAnimationFrame,
  MutationObserver: windowStub.MutationObserver,
  ResizeObserver: windowStub.ResizeObserver,
  IntersectionObserver: windowStub.IntersectionObserver,
  SVGElement: windowStub.SVGElement, Element: SNode, HTMLElement: SNode,
  performance: windowStub.performance, globalThis: null
}, windowStub);
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* -------------------------- ساخت صفحه‌ی نمونه -------------------------- */
const IMG_COUNT = 6;
const main = el('main');
const imgs = [];
for (let i = 1; i <= IMG_COUNT; i++) {
  const top = 100 + (i - 1) * 500;
  const im = el('img', {
    rect: { left: 40, top, right: 640, bottom: top + 200, width: 600, height: 200 },
    attrs: { src: 'https://example.com/img' + i + '.png' }
  });
  im.complete = true; im.naturalWidth = 600; im.naturalHeight = 400;
  main.appendChild(im);
  imgs.push(im);
  documentStub.images.push(im);
}
body.appendChild(main);

/* ------------------------- اجرای content.js ------------------------- */
let loadError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(dir, 'defaults.js'), 'utf8'), sandbox, { filename: 'defaults.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'content.js'), 'utf8'), sandbox, { filename: 'content.js' });
} catch (e) { loadError = e; }
check('content.js بدون خطای بارگذاری اجرا شد', !loadError, loadError && (loadError.message + '\n' + loadError.stack));

async function settle(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

function imgOverlays() {
  const host = documentElement.childNodes.find((n) => n.nodeName === 'page-translator-layer');
  if (!host || !host.shadowRoot) return [];
  return collect(host.shadowRoot, '*').filter((n) => String(n.className || '').split(/\s+/).includes('img'));
}

function ask(msg) {
  if (!contentListener) return null;
  let out = null;
  contentListener(msg, { tab: { id: 1 } }, (res) => { out = res; });
  return out;
}
const diag = () => ask({ type: 'diag-content' });

function scrollTo(y) {
  windowStub.scrollY = y;
  (winListeners.scroll || []).forEach((fn) => fn({ type: 'scroll', target: documentStub }));
}

async function run() {
  if (loadError) return;
  /* صفحه‌ی واقعی: ویوپورت کوتاه و عکس‌ها پخش در طول سند */
  windowStub.innerHeight = 900;
  await settle(300);
  const visiblePhase = [...new Set(ocrCalls)];
  check('قبل از اسکرول، عکس‌های زیر خط دید به OCR نرفته‌اند', visiblePhase.length < IMG_COUNT,
    'ocr=' + visiblePhase.length);

  /* اسکرول تدریجی تا انتهای صفحه */
  for (let y = 0; y <= 3000; y += 400) { scrollTo(y); await settle(120); }
  scrollTo(0);
  await settle(600);

  windowStub.innerHeight = 3000;   // بقیه‌ی سناریوها با همه‌ی عکس‌های دیده‌شده
  await settle(600);

  const d = diag();
  const ocrSrcs = [...new Set(ocrCalls)];
  eq('تعداد عکس‌های فرستاده‌شده به OCR', ocrSrcs.length, IMG_COUNT);
  eq('آمار imgTotal', d && d.stats.imgTotal, IMG_COUNT);
  eq('آمار imgDone', d && d.stats.imgDone, IMG_COUNT);
  eq('صف تصاویر خالی است', d && d.imageQueue, 0);
  eq('هیچ کار تصویری در جریان نمانده', d && d.imageActive, 0);

  const translated = sent.filter((m) => m.type === 'translate').flatMap((m) => m.texts);
  eq('متن هر عکس برای ترجمه فرستاده شد',
    imgs.map((_, i) => translated.includes('Text inside image ' + (i + 1))),
    imgs.map(() => true));

  await settle(200);
  const ovs = imgOverlays();
  eq('برای هر عکس یک کادر ترجمه ساخته شد', ovs.length, IMG_COUNT);
  eq('کادرها ترجمه‌شده هستند', ovs.every((o) => /TT:Text inside image/.test(o.textContent)), true);

  /* --- سناریوی دوم: خاموش/روشن کردن (مثل تغییر تنظیمات از پنل) --- */
  let restartError = null;
  sent.length = 0; ocrCalls.length = 0; captureCalls = 0;
  try { ask({ type: 'apply-state', active: false }); } catch (e) { restartError = e; }
  check('stop() بدون خطا اجرا می‌شود', !restartError,
    restartError && (restartError.name + ': ' + restartError.message + ' @ ' + String(restartError.stack).split('\n')[1]));
  try { ask({ type: 'apply-state', active: true }); } catch (e) { restartError = restartError || e; }
  await settle(800);
  const d2 = diag();
  eq('بعد از خاموش/روشن، اسکن دوباره کار می‌کند', !!d2 && d2.active === true, true);
  eq('بعد از خاموش/روشن، همه‌ی عکس‌ها دوباره به OCR می‌روند', [...new Set(ocrCalls)].length, IMG_COUNT);
  eq('بعد از خاموش/روشن، کار در جریان نمانده', d2 && d2.imageActive, 0);
  eq('بعد از خاموش/روشن، همه‌ی عکس‌ها خوانده شدند', d2 && d2.stats.imgDone, IMG_COUNT);

  /* --- سناریوی سوم: OCR یکی از عکس‌ها خطا می‌دهد (مثلاً دانلود تصویر بسته است) --- */
  ocrFails = new Set(['https://example.com/img3.png']);
  captureFail = true;                       // اسکرین‌شات هم در دسترس نیست
  try { ask({ type: 'apply-state', active: false }); } catch (e) { /* در سناریوی دوم گزارش شد */ }
  sent.length = 0; ocrCalls.length = 0; captureCalls = 0;
  try { ask({ type: 'apply-state', active: true }); } catch (e) { /* در سناریوی دوم گزارش شد */ }
  await settle(900);
  const ovs3 = imgOverlays();
  const got = ovs3.map((o) => o.textContent).filter((t) => /TT:Text inside image/.test(t));
  eq('با خطای OCR، ۵ عکس دیگر ترجمه و رسم می‌شوند', new Set(got).size, IMG_COUNT - 1);
  eq('با خطای OCR، کار در جریان نمانده', diag() && diag().imageActive, 0);
  eq('عکس ناموفق در آمار خطا شمرده می‌شود', diag() && diag().stats.imgFail >= 1, true);
}

async function scenarioHang() {
  captureFail = false;
  /* مهلت OCR را کوتاه کن (کمینه‌ی مجاز ۵ ثانیه) */
  if (storageListener) storageListener({ ocrTimeout: { newValue: 5 } }, 'sync');
  hangSet = new Set(['https://example.com/img2.png', 'https://example.com/img3.png']);
  try { ask({ type: 'apply-state', active: false }); } catch (e) { /* گزارش شد */ }
  sent.length = 0; ocrCalls.length = 0;
  try { ask({ type: 'apply-state', active: true }); } catch (e) { /* گزارش شد */ }
  /* تا وقتی صف خالی شود صبر می‌کنیم (مهلت OCR پیش‌فرض ۵ ثانیه است) */
  let d = diag();
  for (let k = 0; k < 25 && d && (d.imageQueue || d.imageActive); k++) { await settle(1000); d = diag(); }
  const done = [...new Set(ocrCalls)];
  eq('با دو OCR گیرکرده، بقیه‌ی عکس‌ها هم به OCR می‌روند',
    done.filter((u) => !hangSet.has(u)).length, IMG_COUNT - 2);
  eq('با OCR گیرکرده، صف تصاویر خالی می‌شود', d && d.imageQueue, 0);
  eq('با OCR گیرکرده، اسلات هم‌زمانی آزاد می‌شود', d && d.imageActive, 0);
  eq('با OCR گیرکرده، همه‌ی عکس‌ها سرانجام پردازش می‌شوند', d && d.stats.imgDone, IMG_COUNT);
  console.log('  [hang] imageActive=', d && d.imageActive, 'queue=', d && d.imageQueue,
    'imgDone=', d && d.stats.imgDone, '/', d && d.stats.imgTotal, 'ocr=', done.length);
}

run().then(scenarioHang).then(() => {
  console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
});
