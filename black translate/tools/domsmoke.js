/* =========================================================================
   domsmoke.js — اجرای واقعی content.js روی یک DOM کوچک شبیه‌سازی‌شده
   اجرا:  node tools/domsmoke.js
   هدف: مطمئن شویم چرخه‌ی «اسکن → ارسال به background → رسم کادر ترجمه»
   بدون خطا کار می‌کند (چون در این محیط مرورگر در دسترس نیست).
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
    this.nodeType = type;          // 1 = element, 3 = text
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
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return this.__rect; }
  getClientRects() { return [this.__rect]; }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  attachShadow() {
    this.shadowRoot = new SShadow();
    return this.shadowRoot;
  }
  closest(sel) { return null; }
  matches() { return false; }
  contains(n) { let x = n; while (x) { if (x === this) return true; x = x.parentNode; } return false; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get clientLeft() { return 0; }
  get clientWidth() { return this.__rect.width; }
  get clientHeight() { return this.__rect.height; }
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

/* شبیه‌سازی ویژگی‌های ورودی‌ها مثل DOM واقعی */
Object.defineProperty(SNode.prototype, 'type', {
  get() { return this.getAttribute('type') || ''; }, configurable: true
});
Object.defineProperty(SNode.prototype, 'value', {
  get() { return this.getAttribute('value') || ''; }, configurable: true
});

const documentElement = el('html');
const body = el('body');
documentElement.appendChild(body);
documentElement.__markConnected(true);

const documentStub = {
  documentElement, body, hidden: false, images: [],
  fonts: { ready: Promise.resolve() },
  scrollingElement: documentElement,
  createElement: (tag) => new SNode(1, tag),
  createRange: () => {
    let node = null;
    return {
      selectNodeContents(n) { node = n; },
      getClientRects() {
        const host = node && (node.parentElement || (node.nodeType === 3 ? node.parentNode : node));
        const r = host ? host.__rect : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        return [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }];
      }
    };
  },
  elementFromPoint: () => null,
  addEventListener: () => {}, removeEventListener: () => {},
  querySelectorAll: () => []
};

const windowStub = {
  innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
  addEventListener: () => {}, removeEventListener: () => {},
  getComputedStyle: (e) => e.__style || DEFAULT_STYLE,
  requestAnimationFrame: (fn) => setTimeout(() => fn(performanceNow()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  SVGElement: class {},
  ShadowRoot: class {},
  Element: SNode,
  Node: SNode,
  HTMLElement: SNode,
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
let stored = {};
const chromeStub = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: (msg, cb) => {
      sent.push(msg);
      let res = { ok: true };
      if (msg.type === 'translate') res = { ok: true, translations: msg.texts.map((t) => 'TT:' + t), engine: 'google', ms: 5 };
      else if (msg.type === 'hello') res = { active: true };
      else if (msg.type === 'status') res = { ok: true, active: true };
      if (cb) setTimeout(() => cb(res), 1);
      return Promise.resolve(res);
    }
  },
  storage: {
    sync: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} }
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
const header = el('header', { rect: { left: 0, top: 0, right: 1200, bottom: 70, width: 1200, height: 70 }, style: { position: 'fixed' } });
header.appendChild(el('a', { rect: { left: 20, top: 20, right: 180, bottom: 50, width: 160, height: 30 } }));
header.firstChild.appendChild(text('Home page'));
body.appendChild(header);

const main = el('main');
const p1 = el('p', { rect: { left: 40, top: 120, right: 800, bottom: 160, width: 760, height: 40 } });
p1.appendChild(text('Hello world, this is a test paragraph for translation.'));
main.appendChild(p1);
const p2 = el('p', { rect: { left: 40, top: 200, right: 800, bottom: 240, width: 760, height: 40 } });
p2.appendChild(text('سلام، این متن از قبل فارسی است و نباید ترجمه شود.'));
main.appendChild(p2);
const btn = el('input', { rect: { left: 40, top: 280, right: 200, bottom: 320, width: 160, height: 40 }, attrs: { type: 'button', value: 'Submit' } });
main.appendChild(btn);
const ph = el('input', { rect: { left: 40, top: 340, right: 400, bottom: 380, width: 360, height: 40 }, attrs: { placeholder: 'Search here' } });
main.appendChild(ph);
const imgEl = el('img', { rect: { left: 40, top: 420, right: 340, bottom: 620, width: 300, height: 200 }, attrs: { src: 'https://example.com/a.png' } });
imgEl.complete = true; imgEl.naturalWidth = 600; imgEl.naturalHeight = 400;
main.appendChild(imgEl);
body.appendChild(main);

/* ------------------------- اجرای content.js ------------------------- */
/* در افزونه، defaults.js قبل از content.js تزریق می‌شود */
let loadError = null;
try {
  vm.runInContext(fs.readFileSync(path.join(dir, 'defaults.js'), 'utf8'), sandbox, { filename: 'defaults.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'content.js'), 'utf8'), sandbox, { filename: 'content.js' });
} catch (e) {
  loadError = e;
}
check('content.js بدون خطای بارگذاری اجرا شد', !loadError, loadError && (loadError.message + '\n' + loadError.stack));

async function settle(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}
async function run() {
  if (loadError) return;
  await settle(120);

  const translateMsgs = sent.filter((m) => m.type === 'translate');
  check('درخواست ترجمه فرستاده شد', translateMsgs.length > 0);
  const allTexts = translateMsgs.flatMap((m) => m.texts);
  check('متن انگلیسی برای ترجمه فرستاده شد', allTexts.some((t) => t.includes('Hello world')), JSON.stringify(allTexts));
  check('متن فارسی هم‌زبان مقصد فرستاده نشد', !allTexts.some((t) => t.includes('این متن از قبل فارسی')), JSON.stringify(allTexts));
  check('مقدار دکمه‌ی فرم ترجمه شد', allTexts.includes('Submit'), JSON.stringify(allTexts));
  check('placeholder ترجمه شد', allTexts.includes('Search here'), JSON.stringify(allTexts));
  check('اولویت درخواست‌ها مشخص است', translateMsgs.every((m) => m.priority === 'low' || m.priority === 'high'));
  check('زبان مبدأ/مقصد همراه درخواست است', translateMsgs.every((m) => m.sl === 'auto' && m.tl === 'fa'));

  await settle(60);
  const host = documentElement.childNodes.find((n) => n.nodeName === 'page-translator-layer');
  check('لایه‌ی ترجمه به صفحه اضافه شد', !!host);
  const ovList = host && host.shadowRoot
    ? collect(host.shadowRoot, '*').filter((n) => String(n.className || '').split(/\s+/).includes('ov'))
    : [];
  check('کادر ترجمه روی متن ساخته شد', ovList.length > 0, 'overlays=' + ovList.length);
  const translated = ovList.map((o) => o.textContent);
  check('متن ترجمه داخل کادر است', translated.some((t) => t.includes('TT:Hello world')), JSON.stringify(translated));
  check('placeholder در DOM واقعی عوض شد', ph.getAttribute('placeholder') === 'TT:Search here', String(ph.getAttribute('placeholder')));

  /* استاپ: باید همه‌چیز پاک شود و placeholder برگردد */
  const stopRes = vm.runInContext('window.__ptStop ? window.__ptStop() : null', sandbox);
  check('content.js تابع توقف بیرونی ندارد (پاک‌سازی با پیام انجام می‌شود)', stopRes === null);
}

run().then(() => {
  console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
  process.exit(0);
});
