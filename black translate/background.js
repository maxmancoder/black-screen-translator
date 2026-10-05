/* =====================================================================
   background.js — Service worker افزونه
   - موتورها: Google رایگان (سریع/gtx)، Google Cloud، DeepL،
     Microsoft Translator، LibreTranslate و هر سرویس سازگار با OpenAI
   - صف هوشمند با اولویت (متن‌های جلوی چشم اول)، کش حافظه + دیسک
   - OCR از طریق offscreen document
   - تست اتصال و عیب‌یابی گام‌به‌گام
   ===================================================================== */
importScripts('defaults.js');

/* ------------------------------ وضعیت ------------------------------ */
let settingsCache = null;
const swStartedAt = Date.now();
const diag = {
  requests: 0, retries: 0, failures: 0, cacheHits: 0, cacheMisses: 0,
  texts: 0, chars: 0, avgMs: 0, lastMs: 0, lastError: null, lastEngine: null,
  gtxFallbacks: 0, ocr: 0, ocrMs: 0, startedAt: Date.now()
};

async function getSettings() {
  if (settingsCache) return settingsCache;
  let s = {};
  try { s = await chrome.storage.sync.get(PT_DEFAULTS); } catch (e) { /* ignore */ }
  settingsCache = Object.assign({}, PT_DEFAULTS, s);
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && settingsCache) for (const k in changes) settingsCache[k] = changes[k].newValue;
  if (area === 'local' && (changes.ptCacheReset || changes.ptCacheClear)) {
    buckets.clear(); bucketDirty.clear(); cacheSize = 0;
  }
});

/* ============================== پیام‌ها ============================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: ptErrText(e), fatal: !!(e && e.fatal) }));

  switch (msg.type) {
    case 'translate':
      reply(translateTexts(msg.texts || [], msg.sl || 'auto', msg.tl || 'fa', msg));
      return true;
    case 'test-engine':
      reply(testEngine(!!msg.deep));
      return true;
    case 'llm-models':
      reply(listModels());
      return true;
    case 'cache-stats':
      reply(cacheStats().then((stats) => ({ ok: true, stats })));
      return true;
    case 'cache-clear':
      reply(clearCache());
      return true;
    case 'diag':
      reply(getSettings().then((s) => ({ ok: true, diag: diagnostics(s) })));
      return true;
    case 'warmup':
      reply(warmup());
      return true;
    case 'ping':
      sendResponse({ ok: true });
      return false;
    case 'ocr':
    case 'ocr-warmup':
      reply(forwardToOffscreen(msg));
      return true;
    case 'capture-ocr':
      reply(captureAndOcr(msg, sender));
      return true;
    case 'hello':
      reply(helloState(sender));
      return true;
    case 'toggle-tab':
      reply(setTabState(msg.tabId || (sender.tab && sender.tab.id), msg.action || 'toggle'));
      return true;
  }
  return false;
});

/* شورتکات سراسری (chrome://extensions/shortcuts) */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) setTabState(tab.id, 'toggle');
});

/* ---------- وضعیت روشن/خاموش هر تب (storage.session تا با خواب SW از بین نرود) ---------- */
const tabKey = (id) => 'tab_' + id;
async function getTabState(tabId) {
  const o = await chrome.storage.session.get(tabKey(tabId));
  return o[tabKey(tabId)];
}
async function isTabActive(tabId) {
  const st = await getTabState(tabId);
  if (st === true) return true;
  if (st === false) return false;
  return (await getSettings()).autoTranslate;
}
async function helloState(sender) {
  if (!sender.tab) return { active: false };
  return { active: await isTabActive(sender.tab.id) };
}

const lastToggleAt = new Map();
async function setTabState(tabId, action) {
  if (!tabId) return { ok: false, error: 'تب فعالی پیدا نشد' };
  let next;
  if (action === 'start') next = true;
  else if (action === 'stop') next = false;
  else {
    const now = Date.now();
    if (now - (lastToggleAt.get(tabId) || 0) < 400) return { ok: true, ignored: true };
    lastToggleAt.set(tabId, now);
    next = !(await isTabActive(tabId));
  }
  await chrome.storage.session.set({ [tabKey(tabId)]: next });
  const res = await broadcast(tabId, { type: 'apply-state', active: next });
  return Object.assign({ ok: true, active: next }, res && res.error ? { ok: false, error: res.error } : {});
}

/* پیام به همه‌ی فریم‌های تب؛ اگر اسکریپت تزریق نشده بود (تب قدیمی) اول تزریق می‌شود */
async function broadcast(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['defaults.js', 'content.js'] });
      await sleep(150);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e2) {
      if (message.active === false) return { ok: true };
      return { ok: false, error: 'امکان اجرا روی این صفحه وجود ندارد (صفحات داخلی کروم، Web Store و PDF پشتیبانی نمی‌شوند).' };
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(tabKey(tabId)); });

/* ====================================================================== */
/*                       کش ترجمه (حافظه + دیسک)                          */
/* ====================================================================== */
const CACHE_PREFIX = 'ptc';
const BUCKETS = 32;
const buckets = new Map();          // bucketIndex -> Map(key -> value)  (با ترتیب LRU)
const bucketDirty = new Set();
let cacheSize = 0;
let cacheLoaded = false;
let cacheSaveTimer = null;
let evicted = 0;

function bucketOf(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) | 0;
  return Math.abs(h) % BUCKETS;
}
function bucketMap(i) {
  let m = buckets.get(i);
  if (!m) { m = new Map(); buckets.set(i, m); }
  return m;
}
function cacheKeyOf(id, sl, tl, text) { return id + '|' + sl + '|' + tl + '|' + text; }
function engineId(s) {
  if (s.engine === 'llm') return 'llm:' + (s.llmModel || '') + '@' + ptNormalizeBaseUrl(s.llmBaseUrl);
  return s.engine;
}
function cacheLimitOf(s) { return ptClamp(s.cacheLimit, 200, 200000, 20000); }

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const keys = [];
    for (let i = 0; i < BUCKETS; i++) keys.push(CACHE_PREFIX + i);
    const data = await chrome.storage.local.get(keys);
    for (let i = 0; i < BUCKETS; i++) {
      const obj = data[CACHE_PREFIX + i];
      if (!obj || typeof obj !== 'object') continue;
      const m = bucketMap(i);
      for (const k in obj) { m.set(k, obj[k]); cacheSize++; }
    }
  } catch (e) { /* ignore */ }
}

function cacheGet(key) {
  const bi = bucketOf(key), m = bucketMap(bi);
  const v = m.get(key);
  if (v === undefined) return undefined;
  m.delete(key); m.set(key, v);
  bucketDirty.add(bi);
  return v;
}

function cacheSet(key, value, limit) {
  const bi = bucketOf(key), m = bucketMap(bi);
  if (m.has(key)) m.delete(key); else cacheSize++;
  m.set(key, value);
  bucketDirty.add(bi);
  const perBucket = Math.max(8, Math.ceil(limit / BUCKETS));
  while (m.size > perBucket) { m.delete(m.keys().next().value); cacheSize--; evicted++; }
  scheduleCacheSave();
}

function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => { saveCache(); }, 2500);
}

async function saveCache() {
  cacheSaveTimer = null;
  const s = await getSettings();
  if (!s.persistCache) { bucketDirty.clear(); return; }
  const payload = {};
  for (const bi of bucketDirty) {
    const m = buckets.get(bi);
    if (!m) continue;
    const obj = {};
    for (const [k, v] of m) obj[k] = v;
    payload[CACHE_PREFIX + bi] = obj;
  }
  bucketDirty.clear();
  try {
    await chrome.storage.local.set(payload);
    await chrome.storage.local.set({ ptCacheMeta: { size: cacheSize, at: Date.now(), version: PT_VERSION } });
  } catch (e) { diag.lastError = 'ذخیره‌ی کش ناموفق بود (فضای storage پر است؟)'; }
}

async function clearCache() {
  buckets.clear(); bucketDirty.clear(); cacheSize = 0; evicted = 0;
  const keys = [];
  for (let i = 0; i < BUCKETS; i++) keys.push(CACHE_PREFIX + i);
  keys.push('ptCacheMeta');
  try { await chrome.storage.local.remove(keys); } catch (e) { /* ignore */ }
  return { ok: true };
}

async function cacheStats() {
  await loadCache();
  let chars = 0;
  for (const m of buckets.values()) for (const [k, v] of m) chars += k.length + String(v).length;
  let bytes = 0;
  try { bytes = (await chrome.storage.local.getBytesInUse()) || 0; } catch (e) { /* ignore */ }
  return { entries: cacheSize, chars, evicted, bytes, loaded: cacheLoaded };
}

function diagnostics(s) {
  return Object.assign({}, diag, {
    uptimeMs: Date.now() - swStartedAt,
    engine: s.engine,
    model: s.engine === 'llm' ? s.llmModel : '',
    cacheEntries: cacheSize,
    cacheLimit: cacheLimitOf(s),
    persist: !!s.persistCache,
    slots: maxSlots,
    active: activeSlots,
    version: PT_VERSION,
    htmlBlockedUntil: htmlDownUntil > Date.now() ? htmlDownUntil : 0
  });
}

/* ====================================================================== */
/*              صف هوشمند (اولویت‌دار) و محدودکننده‌ی نرخ                  */
/* ====================================================================== */
const qHigh = [], qLow = [];
let activeSlots = 0;
let maxSlots = 6;

function setMaxSlots(n) {
  maxSlots = Math.max(1, Math.min(16, n || 6));
  while (activeSlots < maxSlots && (qHigh.length || qLow.length)) {
    const next = qHigh.shift() || qLow.shift();
    activeSlots++;
    next();
  }
}
function acquire(priority) {
  if (activeSlots < maxSlots) { activeSlots++; return Promise.resolve(); }
  return new Promise((resolve) => { (priority === 'low' ? qLow : qHigh).push(resolve); });
}
function release() {
  const next = qHigh.shift() || qLow.shift();
  if (next) { next(); return; }        // اسلات مستقیم به نفر بعدی تحویل داده می‌شود
  activeSlots--;
}

const hostNextAt = new Map();
async function rateLimit(url, delayMs) {
  if (!delayMs) return;
  let host = '';
  try { host = new URL(url).host; } catch (e) { return; }
  const now = Date.now();
  const at = hostNextAt.get(host) || 0;
  const wait = Math.max(0, at - now);
  hostNextAt.set(host, Math.max(now, at) + delayMs);
  if (wait) await sleep(wait);
}

/* پول کارگرها: هر کارگر یک اسلات می‌گیرد و تا پایان کارش نگه می‌دارد.
   هیچ تابع داخلی نباید دوباره runPool صدا بزند (وگرنه اسلات‌ها تمام می‌شوند). */
async function runPool(items, priority, fn) {
  const results = new Array(items.length);
  const errors = new Array(items.length);
  if (!items.length) return { results, errors };
  let idx = 0;
  const workers = Math.max(1, Math.min(items.length, maxSlots));
  await Promise.all(new Array(workers).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await acquire(priority);
      try { results[i] = await fn(items[i], i); }
      catch (e) { errors[i] = e; }
      finally { release(); }
    }
  }));
  return { results, errors };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ====================================================================== */
/*                     درخواست HTTP با تلاش دوباره                        */
/* ====================================================================== */
function httpHint(status, m) {
  m = String(m || '').toLowerCase();
  if (m.includes('api key not valid') || m.includes('invalid api key') || m.includes('incorrect api key') ||
      m.includes('invalid_api_key') || m.includes('unauthorized') || status === 401)
    return ' (کلید API نامعتبر است یا اشتباه کپی شده)';
  if (m.includes('location') || m.includes('region') || m.includes('country') || m.includes('sanction') ||
      m.includes('unsupported_country') || m.includes('not available in your'))
    return ' (این سرویس برای منطقه‌ی جغرافیایی/IP شما در دسترس نیست — VPN، پروکسی یا سرویس جایگزین امتحان کنید)';
  if (status === 403) return ' (دسترسی رد شد: API فعال نیست، اعتبار/صورت‌حساب فعال نیست، کلید محدود شده یا IP شما تحریم است)';
  if (status === 404) return ' (آدرس Base URL یا نام مدل اشتباه است — «تست اتصال» را اجرا کنید)';
  if (status === 429) return ' (محدودیت تعداد درخواست یا اتمام اعتبار — «تعداد درخواست هم‌زمان» یا «تأخیر بین درخواست‌ها» را کم کنید)';
  if (status === 456) return ' (سهمیه‌ی DeepL تمام شده)';
  if (status === 400 && (m.includes('model') || m.includes('does not exist')))
    return ' (نام مدل اشتباه است — با دکمه‌ی «دریافت لیست مدل‌ها» مدل درست را انتخاب کنید)';
  return '';
}

function retryAfterMs(res) {
  if (!res || !res.headers || !res.headers.get) return 0;
  const h = res.headers.get('retry-after');
  if (!h) return 0;
  const sec = parseFloat(h);
  if (isFinite(sec)) return Math.min(30000, Math.max(0, sec * 1000));
  const d = Date.parse(h);
  return isFinite(d) ? Math.min(30000, Math.max(0, d - Date.now())) : 0;
}

/* درخواست با مهلت، تلاش دوباره، پیام خطای دقیق و پشتیبانی از Retry-After */
async function request(url, opts, ctx) {
  ctx = ctx || {};
  const service = ctx.service || 'سرویس';
  const timeoutMs = ctx.timeout || 30000;
  const tries = ctx.retries == null ? 2 : Math.max(0, Math.min(6, ctx.retries));
  const delay = ctx.delay || 0;
  let host = '';
  try { host = new URL(url).host; } catch (e) { /* ignore */ }
  let lastErr = null;

  for (let attempt = 0; attempt <= tries; attempt++) {
    if (attempt) diag.retries++;
    await rateLimit(url, delay);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res = null, raw = '';
    try {
      res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      raw = await res.text();
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      lastErr = new Error(aborted
        ? `${service}: پاسخی از ${host} نیامد (مهلت ${Math.round(timeoutMs / 1000)} ثانیه تمام شد).`
        : `${service}: اتصال به ${host} برقرار نشد. این آدرس احتمالاً در شبکه‌ی شما مسدود است (فیلترینگ/تحریم) یا اینترنت/VPN/پروکسی مشکل دارد.`);
      lastErr.network = true;
      if (attempt < tries) { await sleep(400 * Math.pow(2, attempt) + Math.random() * 200); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* not json */ }
    if (res.ok) return data != null ? data : raw;

    let m = data && ((data.error && (data.error.message || data.error)) || data.message || data.detail || data.msg);
    if (Array.isArray(data) && data[0] && (data[0].error || data[0].message)) {
      m = data[0].error ? (data[0].error.message || data[0].error) : data[0].message;
    }
    if (m && typeof m === 'object') m = JSON.stringify(m);
    if (typeof m !== 'string' || !m) m = String(raw || '').slice(0, 240).replace(/<[^>]+>/g, ' ').trim();

    const err = new Error(`${service}: HTTP ${res.status} — ${m || res.statusText}${httpHint(res.status, m)}`);
    err.status = res.status;
    lastErr = err;
    const retryable = res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < tries) {
      await sleep(retryAfterMs(res) || (500 * Math.pow(2, attempt) + Math.random() * 300));
      continue;
    }
    if (res.status === 401 || res.status === 403) err.fatal = true;
    throw err;
  }
  throw lastErr || new Error(service + ': خطای ناشناخته');
}

/* ====================================================================== */
/*                          ترجمه‌ی متن‌ها                                 */
/* ====================================================================== */
const pendingUnique = new Map();   // key -> { promise, resolve, done }  (درخواست‌های تکراری اشتراکی)

function defer() {
  const d = { done: false };
  d.promise = new Promise((resolve) => {
    d.resolve = (v) => { if (!d.done) { d.done = true; resolve(v); } };
  });
  return d;
}

async function translateTexts(texts, sl, tl, opts) {
  opts = opts || {};
  const s = await getSettings();
  setMaxSlots(s.maxConcurrent);
  const ready = engineReady(s);
  let engine = ready ? s.engine : 'google';
  let warning = opts.warning || null;
  if (!ready) warning = 'کلید/تنظیمات موتور «' + (PT_ENGINE_INFO[s.engine] ? PT_ENGINE_INFO[s.engine].name : s.engine) +
    '» کامل نیست؛ موقتاً با Google رایگان ترجمه می‌شود.';
  const id = engineId(Object.assign({}, s, { engine }));
  const limit = cacheLimitOf(s);
  if (s.cacheEnabled && s.persistCache) await loadCache();

  const t0 = Date.now();
  const results = new Array(texts.length);
  const fresh = [];
  const waiting = [];
  const seen = new Map();
  let hits = 0;

  for (let i = 0; i < texts.length; i++) {
    const clean = String(texts[i] == null ? '' : texts[i]).replace(/\s+/g, ' ').trim();
    if (!clean) { results[i] = ''; continue; }
    const key = cacheKeyOf(id, sl, tl, clean);
    if (s.cacheEnabled) {
      const hit = cacheGet(key);
      if (hit !== undefined) { results[i] = hit; hits++; diag.cacheHits++; continue; }
    }
    if (seen.has(key)) { seen.get(key).idx.push(i); continue; }
    const x = { idx: [i], text: clean, key };
    seen.set(key, x);
    const pend = pendingUnique.get(key);
    if (pend) waiting.push(pend.promise.then((v) => { x.idx.forEach((k) => { results[k] = v == null ? x.text : v; }); }));
    else { x.defer = defer(); pendingUnique.set(key, x.defer); fresh.push(x); }
  }

  diag.cacheMisses += fresh.length;
  diag.lastEngine = engine;

  if (!fresh.length) {
    if (waiting.length) await Promise.all(waiting);
    const ms0 = Date.now() - t0;
    return { ok: true, translations: results, engine, cached: hits, ms: ms0, warning };
  }

  let out = null, thrown = null;
  try {
    out = await runEngineBatches(engine, fresh, sl, tl, s, opts.priority);
  } catch (e) {
    thrown = e;
  }

  /* پر کردن نتایج؛ آیتمی که ترجمه نشد متن اصلی خودش را نگه می‌دارد و در کش ذخیره نمی‌شود */
  try {
    fresh.forEach((x, i) => {
      const failed = !!(out && out.failed && out.failed.has(i)) || (!out && !!thrown);
      let tr = x.text;
      if (!failed && out && out.results[i] != null && out.results[i] !== '') tr = out.results[i];
      x.idx.forEach((k) => { results[k] = tr; });
      if (s.cacheEnabled && !failed && tr !== x.text) cacheSet(x.key, tr, limit);
      if (x.defer) x.defer.resolve(failed ? null : tr);
    });
  } finally {
    /* پاک‌سازی بعد از resolve تا درخواست‌های هم‌زمانِ بعدی همان نتیجه را از کشِ درجریان بگیرند */
    for (const x of fresh) {
      if (pendingUnique.get(x.key) === x.defer) pendingUnique.delete(x.key);
    }
  }
  if (waiting.length) await Promise.all(waiting);

  const ms = Date.now() - t0;
  diag.requests++;
  diag.lastMs = ms;
  diag.avgMs = diag.avgMs ? Math.round(diag.avgMs * 0.8 + ms * 0.2) : ms;
  diag.texts += texts.length;
  diag.chars += texts.reduce((a, t) => a + String(t || '').length, 0);

  if (out && out.warning) warning = warning ? warning + ' ' + out.warning : out.warning;
  const applied = out && out.engine ? out.engine : engine;

  if (thrown || (out && !out.okChunks)) {
    const err = thrown || new Error(out && out.warning ? out.warning : 'ترجمه ناموفق بود');
    diag.failures++;
    diag.lastError = ptErrText(err);
    /* اگر هیچ دسته‌ای هم موفق نشد، خطا را بالا می‌بریم (وگرنه فقط هشدار) */
    if (!out || !out.okChunks) {
      return { ok: false, error: ptErrText(err), fatal: !!(err && err.fatal), translations: results, engine: applied, warning };
    }
  }
  return { ok: true, translations: results, engine: applied, cached: hits, ms, warning };
}

/* دسته‌بندی متن‌ها و ترجمه‌ی موازی؛ خطای هر دسته فقط همان دسته را از دست می‌دهد */
async function runEngineBatches(engine, todo, sl, tl, s, priority) {
  const info = PT_ENGINE_INFO[engine] || PT_ENGINE_INFO.google;
  const maxItems = engine === 'llm' ? ptClamp(s.llmItems, 1, 400, info.items) : info.items;
  const maxChars = engine === 'llm' ? ptClamp(s.llmChars, 500, 60000, info.chars) : info.chars;
  const texts = todo.map((x) => x.text);
  const chunks = ptChunkTexts(texts, maxItems, maxChars);
  const results = new Array(texts.length);
  const failedIdx = new Set();
  const notes = [];
  let okChunks = 0;
  let applied = engine;
  let firstErr = null;

  const got = await runPool(chunks, priority, async (ch) => {
    try {
      const r = await translateChunk(engine, ch.items, sl, tl, s);
      if (r.items && r.items.length === ch.items.length) {
        r.items.forEach((t, k) => { results[ch.start + k] = t; });
      } else {
        throw new Error('تعداد ترجمه‌های برگشتی با درخواست نمی‌خواند');
      }
      if (r.engine !== engine) applied = r.engine;
      if (r.note) notes.push(r.note);
      okChunks++;
    } catch (e) {
      firstErr = firstErr || e;
      ch.items.forEach((t, k) => { results[ch.start + k] = t; failedIdx.add(ch.start + k); });
      notes.push(ptErrText(e));
    }
  });
  if (got.errors.some(Boolean) && !firstErr) firstErr = got.errors.find(Boolean);
  if (firstErr) diag.lastError = ptErrText(firstErr);

  const failed = chunks.length - okChunks;
  let warning = null;
  if (failed) {
    const uniq = [...new Set(notes)].slice(0, 2).join(' / ');
    warning = `${uniq} — ${failed} از ${chunks.length} دسته ترجمه نشد و متن اصلی نشان داده می‌شود.`;
  }
  return { results, okChunks, failed: failedIdx, engine: applied, warning, error: firstErr };
}

/* یک دسته با موتور انتخابی؛ اگر موتور کلیددار خطا داد و fallback روشن بود، با Google رایگان ادامه می‌دهد */
async function translateChunk(engine, items, sl, tl, s) {
  try {
    return { items: await runEngine(engine, items, sl, tl, s), engine };
  } catch (e) {
    const canFallback = engine !== 'google' && engine !== 'gtx' && s.fallbackToFree && !isAuthError(e);
    if (!canFallback) throw e;
    const out = await runEngine('google', items, sl, tl, s);
    diag.gtxFallbacks++;
    return { items: out, engine: 'google', note: ptErrText(e) + ' — با Google رایگان ادامه یافت' };
  }
}

function isAuthError(e) {
  const m = String((e && e.message) || '').toLowerCase();
  return e && e.status === 401 || m.includes('کلید api نامعتبر') || m.includes('api key');
}

async function runEngine(engine, items, sl, tl, s) {
  switch (engine) {
    case 'gcloud': return gcloudTranslate(items, sl, tl, s);
    case 'deepl': return deeplTranslate(items, sl, tl, s);
    case 'microsoft': return msTranslate(items, sl, tl, s);
    case 'libre': return libreTranslate(items, sl, tl, s);
    case 'llm': return llmTranslate(items, sl, tl, s);
    case 'gtx': return gtxBatchTranslate(items, sl, tl, s);
    default: return googleTranslate(items, sl, tl, s);
  }
}

function engineReady(s) {
  const info = PT_ENGINE_INFO[s.engine];
  if (!info) return false;
  if (!info.key) return true;
  if (s.engine === 'llm') return !!(String(s.llmKey || '').trim() && String(s.llmBaseUrl || '').trim() && String(s.llmModel || '').trim());
  return !!String(s[info.key] || '').trim();
}

/* ====================================================================== */
/*                       Google رایگان (سریع)                             */
/* ====================================================================== */
const GOOGLE_HTML_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
let htmlDownUntil = 0;
let htmlFails = 0;
let htmlChecked = false;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

/* سرویس سریع ترجمه (همان سرویس داخلی کروم): ۱۲۰ متن در یک درخواست */
async function googleHtmlRequest(items, sl, tl, s) {
  const timeout = !htmlChecked ? Math.min(8000, (s && s.requestTimeout) || 8000) : ((s && s.requestTimeout) || 20000);
  const data = await request('https://translate-pa.googleapis.com/v1/translateHtml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': GOOGLE_HTML_KEY },
    body: JSON.stringify([[items.map(escapeHtml), sl, tl], 'te_lib'])
  }, { service: 'Google Translate', timeout, retries: 1, delay: (s && s.requestDelay) || 0 });
  if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length !== items.length) {
    throw new Error('Google Translate: پاسخ نامعتبر (تعداد ترجمه‌ها نمی‌خواند)');
  }
  return data[0].map(unescapeHtml);
}

/* موتور پیش‌فرض: سرویس سریع؛ اگر در دسترس نبود، روش gtx (هم دسته‌ای) */
async function googleTranslate(items, sl, tl, s) {
  if (Date.now() < htmlDownUntil) return gtxBatchTranslate(items, sl, tl, s);
  try {
    const out = await googleHtmlRequest(items, sl, tl, s);
    htmlFails = 0;
    htmlChecked = true;
    return out;
  } catch (e) {
    htmlChecked = true;
    htmlFails++;
    if (htmlFails >= 2 || e.network || (e.status === 403)) htmlDownUntil = Date.now() + 120000;
    diag.gtxFallbacks++;
    diag.lastError = ptErrText(e);
    return gtxBatchTranslate(items, sl, tl, s);
  }
}

/* ---------- Google gtx: چند متن در یک درخواست (translate_a/t) ---------- */
const MAX_URL_Q = 4500;

async function gtxBatchTranslate(items, sl, tl, s) {
  const out = new Array(items.length);
  const groups = [];
  let cur = null;
  items.forEach((t, i) => {
    const len = encodeURIComponent(t).length + 10;
    if (!cur || cur.len + len > MAX_URL_Q || cur.items.length >= 100) { cur = { items: [], idx: [], len: 0 }; groups.push(cur); }
    cur.items.push(t); cur.idx.push(i); cur.len += len;
  });
  let firstErr = null;
  for (const g of groups) {                       // سریالی؛ هم‌زمانی کلی توسط اسلات‌های بیرونی کنترل می‌شود
    try {
      const translated = await gtxGet(g.items, sl, tl, s);
      translated.forEach((t, k) => { out[g.idx[k]] = t; });
    } catch (e) {
      firstErr = firstErr || e;
      g.idx.forEach((k) => { out[k] = items[k]; });
    }
  }
  if (firstErr && groups.length === 1) throw firstErr;
  if (firstErr) diag.lastError = ptErrText(firstErr);
  for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = items[i];
  return out;
}

async function gtxGet(items, sl, tl, s) {
  const q = items.map((t) => '&q=' + encodeURIComponent(t)).join('');
  const url = 'https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=' +
    encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + q;
  const data = await request(url, {}, {
    service: 'Google Translate',
    timeout: (s && s.requestTimeout) || 20000,
    retries: s ? ptClamp(s.requestRetries, 0, 5, 2) : 2,
    delay: (s && s.requestDelay) || 0
  });
  const norm = normalizeGtx(data, items.length);
  if (norm) return norm;
  /* شکل پاسخ متفاوت بود → تک‌تک (متن‌های بلند هم اینجا شکسته می‌شوند) */
  const out = new Array(items.length);
  let lastErr = null;
  for (let i = 0; i < items.length; i++) {
    try { out[i] = await gtxOne(items[i], sl, tl, s); } catch (e) { lastErr = lastErr || e; out[i] = items[i]; }
  }
  if (lastErr && out.every((t, i) => t === items[i])) throw lastErr;
  return out;
}

/* پاسخ translate_a/t در حالت‌های مختلف: ["a","b"] یا [["a","en"],["b","fa"]]
   فقط وقتی می‌پذیریم که تعداد آیتم‌ها دقیقاً با درخواست بخواند. */
function normalizeGtx(data, count) {
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length !== count) return null;
  const out = [];
  for (const x of arr) {
    if (Array.isArray(x)) {
      if (typeof x[0] !== 'string') return null;
      out.push(x[0]);
    } else if (typeof x === 'string') {
      out.push(x);
    } else {
      return null;
    }
  }
  if (out.some((t) => !t || /^\[\s*\[/.test(t))) return null;
  return out;
}

async function gtxOne(text, sl, tl, s) {
  if (encodeURIComponent(text).length > 1500) {
    const parts = text.split(/(?<=[.!?؟。．\n])\s+/);
    if (parts.length > 1) {
      const mid = Math.ceil(parts.length / 2);
      const a = await gtxOne(parts.slice(0, mid).join(' '), sl, tl, s);
      const b = await gtxOne(parts.slice(mid).join(' '), sl, tl, s);
      return (a + ' ' + b).trim();
    }
  }
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=' +
    encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(text);
  const data = await request(url, {}, { service: 'Google Translate', timeout: 20000, retries: 2 });
  if (!Array.isArray(data) || !Array.isArray(data[0])) return text;
  return data[0].map((seg) => (seg && seg[0]) || '').join('') || text;
}

/* ====================================================================== */
/*                    Google Cloud Translation v2                         */
/* ====================================================================== */
async function gcloudTranslate(items, sl, tl, s) {
  const key = String(s.gcloudKey || '').trim();
  const body = { q: items, target: tl, format: 'text' };
  if (sl && sl !== 'auto') body.source = sl;
  const data = await request('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, { service: 'Google Cloud', timeout: s.requestTimeout, retries: s.requestRetries, delay: s.requestDelay });
  const tr = data && data.data && data.data.translations;
  if (!Array.isArray(tr)) throw new Error('Google Cloud: پاسخ نامعتبر');
  return tr.map((t) => unescapeHtml(t.translatedText));
}

/* ====================================================================== */
/*                              DeepL                                     */
/* ====================================================================== */
function deeplLang(code, isTarget) {
  const map = { 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', no: 'NB', pt: 'PT-PT' };
  let c = map[code] || String(code || '').toUpperCase();
  if (isTarget && c === 'EN') c = 'EN-US';
  if (isTarget && c === 'PT') c = 'PT-BR';
  if (!isTarget) c = c.split('-')[0];
  return c;
}

async function deeplTranslate(items, sl, tl, s) {
  const key = String(s.deeplKey || '').trim();
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = { text: items, target_lang: deeplLang(tl, true), split_sentences: 'nonewlines' };
  if (sl && sl !== 'auto') body.source_lang = deeplLang(sl, false);
  if (s.deeplFormality && s.deeplFormality !== 'default') body.formality = s.deeplFormality;
  const data = await request(base + '/v2/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'DeepL-Auth-Key ' + key },
    body: JSON.stringify(body)
  }, { service: 'DeepL', timeout: s.requestTimeout, retries: s.requestRetries, delay: s.requestDelay });
  if (!data || !Array.isArray(data.translations)) throw new Error('DeepL: پاسخ نامعتبر');
  return data.translations.map((t) => t.text);
}

/* ====================================================================== */
/*                       Microsoft Translator (Azure)                     */
/* ====================================================================== */
function msLang(code) {
  const map = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', no: 'nb', fil: 'fil' };
  return map[code] || code;
}

async function msTranslate(items, sl, tl, s) {
  const key = String(s.msKey || '').trim();
  let url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' + encodeURIComponent(msLang(tl));
  if (sl && sl !== 'auto') url += '&from=' + encodeURIComponent(msLang(sl));
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
  const region = String(s.msRegion || '').trim();
  if (region && region !== 'global') headers['Ocp-Apim-Subscription-Region'] = region;
  const data = await request(url, {
    method: 'POST', headers, body: JSON.stringify(items.map((t) => ({ Text: t })))
  }, { service: 'Microsoft Translator', timeout: s.requestTimeout, retries: s.requestRetries, delay: s.requestDelay });
  if (!Array.isArray(data)) throw new Error('Microsoft Translator: پاسخ نامعتبر');
  return data.map((d, i) => (d && d.translations && d.translations[0] && d.translations[0].text) || items[i]);
}

/* ====================================================================== */
/*                            LibreTranslate                              */
/* ====================================================================== */
function libreLang(code) {
  const map = { 'zh-CN': 'zh', 'zh-TW': 'zt', no: 'nb' };
  return map[code] || code;
}

async function libreTranslate(items, sl, tl, s) {
  const base = ptNormalizeBaseUrl(s.libreUrl);
  if (!base) throw new Error('LibreTranslate: آدرس سرور تنظیم نشده است');
  const body = { q: items, source: sl === 'auto' ? 'auto' : libreLang(sl), target: libreLang(tl), format: 'text' };
  if (s.libreKey) body.api_key = String(s.libreKey).trim();
  const data = await request(base + '/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }, { service: 'LibreTranslate', timeout: s.requestTimeout, retries: s.requestRetries, delay: s.requestDelay });
  if (!data) throw new Error('LibreTranslate: پاسخ خالی');
  if (Array.isArray(data.translatedText)) return data.translatedText;
  if (typeof data.translatedText === 'string') return [data.translatedText];
  throw new Error('LibreTranslate: پاسخ نامعتبر');
}

/* ====================================================================== */
/*                    مدل‌های زبانی سازگار با OpenAI                      */
/* ====================================================================== */
const DELIM = (n) => '[[[' + n + ']]]';
let llmJsonDisabled = false;     // اگر سرویس json_object را قبول نکرد
let llmNoTemperature = false;    // اگر سرویس temperature را قبول نکرد

function llmHeaders(s) {
  const h = ptAuthHeaders(s.llmBaseUrl, String(s.llmKey || '').trim());
  const extra = ptParseExtraHeaders(s.llmExtraHeaders);
  for (const k in extra) h[k] = extra[k];
  return h;
}

function glossaryBlock(s) {
  const lines = String(s.glossary || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
  const pairs = lines.map((l) => {
    const m = l.split(/\s*(?:=>|→|=|:)\s*/);
    return m.length >= 2 ? `${m[0]} => ${m.slice(1).join(' ')}` : null;
  }).filter(Boolean);
  if (!pairs.length) return '';
  return '\nGlossary (always use exactly these equivalents): ' + pairs.join('; ') + '.';
}

function llmSystemPrompt(s, sl, tl, count) {
  const src = PT_LANG_EN[sl] || sl;
  const dst = PT_LANG_EN[tl] || tl;
  const json = s.llmFormat === 'json' && !llmJsonDisabled;
  const format = json
    ? `Return ONLY a JSON object like {"t":["<translation 1>","<translation 2>", ...]} with exactly ${count} strings in the same order.`
    : `Input: each segment starts with a marker like ${DELIM(1)} followed by its text (a segment may span several lines). ` +
      `Output: ONLY the translated segments, each preceded by the SAME marker, in the same order — never merge, split, reorder, drop or comment on segments.`;
  return `You are a professional website translator inside a browser extension. Translate every segment from ${src} to ${dst}. ` +
    format + ' Rules: keep numbers, URLs, e-mails, code, file names, CSS/HTML class names and placeholders (like {name} or %s) unchanged; ' +
    'keep UI labels short; use natural fluent wording; never add notes, explanations, quotes or transliterations.' +
    glossaryBlock(s) +
    (s.llmSystemPrompt ? '\nExtra instructions: ' + String(s.llmSystemPrompt).trim() : '');
}

function llmUserContent(items, json) {
  if (json) return JSON.stringify(items);
  let out = '';
  items.forEach((t, i) => { out += DELIM(i + 1) + t + '\n'; });
  return out;
}

/* ترجمه با AI: اگر پارس خروجی شکست خورد، دسته را می‌شکند و دوباره می‌گیرد */
async function llmTranslate(items, sl, tl, s) {
  return llmChunk(items, sl, tl, s, 0);
}

async function llmChunk(items, sl, tl, s, depth) {
  if (!items.length) return [];
  let err = null;
  try {
    const parsed = await llmRequest(items, sl, tl, s);
    if (parsed) return parsed;
  } catch (e) { err = e; }
  if (items.length === 1) {
    if (depth < 2 && err) return [await llmSingle(items[0], sl, tl, s, depth + 1)];
    return items;
  }
  if (depth >= 4) return items;
  const mid = Math.ceil(items.length / 2);
  const left = await llmChunk(items.slice(0, mid), sl, tl, s, depth + 1);
  const right = await llmChunk(items.slice(mid), sl, tl, s, depth + 1);
  const out = left.concat(right);
  if (out.length === items.length) return out;
  return items;
}

async function llmSingle(text, sl, tl, s, depth) {
  try {
    const parsed = await llmRequest([text], sl, tl, Object.assign({}, s, { llmFormat: 'delimiter' }));
    if (parsed && parsed[0]) return parsed[0];
  } catch (e) { /* متن اصلی */ }
  return text;
}

/* یک درخواست واقعی به سرویس AI */
async function llmRequest(items, sl, tl, s) {
  const url = ptChatUrl(s.llmBaseUrl);
  if (!url) throw new Error('آدرس Base URL سرویس AI تنظیم نشده است');
  const model = String(s.llmModel || '').trim();
  if (!model) throw new Error('نام مدل AI تنظیم نشده است');
  const json = s.llmFormat === 'json' && !llmJsonDisabled;

  const body = {
    model,
    messages: [
      { role: 'system', content: llmSystemPrompt(s, sl, tl, items.length) },
      { role: 'user', content: llmUserContent(items, json) }
    ]
  };
  if (!llmNoTemperature && !ptIsReasoningModel(model)) body.temperature = ptClamp(s.llmTemperature, 0, 2, 0);
  const chars = items.reduce((a, t) => a + t.length, 0);
  const maxTokens = s.llmMaxTokens > 0
    ? ptClamp(s.llmMaxTokens, 64, 64000, 4096)
    : ptClamp(Math.ceil(chars / 1.6) + 300, 512, 8192, 4096);
  if (ptIsReasoningModel(model)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };

  let host = 'AI';
  try { host = new URL(url).host; } catch (e) { /* ignore */ }

  let data;
  try {
    data = await request(url, { method: 'POST', headers: llmHeaders(s), body: JSON.stringify(body) }, {
      service: 'AI (' + host + ')',
      timeout: ptClamp(s.requestTimeout, 5000, 300000, 90000),
      retries: ptClamp(s.requestRetries, 0, 4, 2),
      delay: s.requestDelay
    });
  } catch (e) {
    const m = String(e.message || '').toLowerCase();
    if (e.status === 400 && m.includes('temperature') && !llmNoTemperature) {
      llmNoTemperature = true;
      return llmRequest(items, sl, tl, s);
    }
    if (e.status === 400 && (m.includes('response_format') || m.includes('json_object')) && !llmJsonDisabled) {
      llmJsonDisabled = true;
      return llmRequest(items, sl, tl, s);
    }
    throw e;
  }

  const ch = data && data.choices && data.choices[0];
  const content = ch && ((ch.message && ch.message.content) || ch.text);
  const parsed = parseLlmOutput(content, items.length, json);
  if (parsed) return parsed;
  throw new Error('پاسخ مدل قابل خواندن نبود' +
    (ch && ch.finish_reason === 'length' ? ' (خروجی مدل بریده شد — «حداکثر توکن پاسخ» را بالا یا «تعداد متن در هر درخواست» را کم کنید)' : ''));
}

/* پارس خروجی: نشانه‌دار → JSON → خط‌به‌خط */
function parseLlmOutput(content, count, json) {
  const txt = String(content == null ? '' : content).trim();
  if (!txt) return null;
  if (json) { const j = parseJsonArray(txt, count); if (j) return j; }
  const d = parseDelimited(txt, count);
  if (d) return d;
  const j2 = parseJsonArray(txt, count);
  if (j2) return j2;
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^```/.test(l));
  if (lines.length === count) return lines;
  return null;
}

function parseDelimited(content, count) {
  const re = /\[\[\[\s*(\d+)\s*\]\]\]/g;
  const marks = [];
  let m;
  while ((m = re.exec(content)) !== null) marks.push({ n: +m[1], start: m.index, end: re.lastIndex });
  if (marks.length < count) return null;
  const out = new Array(count).fill(null);
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].start : content.length;
    const idx = marks[i].n - 1;
    if (idx >= 0 && idx < count && out[idx] == null) {
      out[idx] = content.slice(marks[i].end, to).replace(/^\s*[:\-–]?\s*/, '').trim();
    }
  }
  return out.every((x) => x != null && x !== '') ? out : null;
}

function parseJsonArray(txt, count) {
  const clean = txt.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const attempts = [];
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) attempts.push(clean.slice(a, b + 1));
  const c = clean.indexOf('['), d = clean.lastIndexOf(']');
  if (c >= 0 && d > c) attempts.push(clean.slice(c, d + 1));
  attempts.push(clean);
  for (const t of attempts) {
    let obj;
    try { obj = JSON.parse(t); } catch (e) { continue; }
    if (Array.isArray(obj)) {
      if (obj.length === count) return obj.map((x) => String(Array.isArray(x) ? x[0] : x));
      if (obj.length === 1 && Array.isArray(obj[0]) && obj[0].length === count) return obj[0].map(String);
      if (obj.length && obj[0] && typeof obj[0] === 'object' && Array.isArray(obj[0].t) && obj[0].t.length === count) return obj[0].t.map(String);
      continue;
    }
    if (obj && typeof obj === 'object') {
      const cand = obj.t || obj.translations || obj.result || obj.data || Object.values(obj)[0];
      if (Array.isArray(cand) && cand.length === count) return cand.map((x) => String(Array.isArray(x) ? x[0] : x));
    }
  }
  return null;
}

/* ---------- لیست مدل‌های سرویس AI ---------- */
async function listModels(baseUrl, key, extraHeaders) {
  const s = await getSettings();
  const base = baseUrl || s.llmBaseUrl;
  const k = key || s.llmKey;
  if (!String(k || '').trim()) return { ok: false, error: 'اول کلید API را وارد کنید.' };
  const url = ptModelsUrl(base);
  if (!url) return { ok: false, error: 'این سرویس لیست مدل ندارد (مثل Azure)؛ نام Deployment را دستی وارد کنید.' };
  try {
    const headers = ptAuthHeaders(base, String(k).trim());
    const extra = ptParseExtraHeaders(extraHeaders == null ? s.llmExtraHeaders : extraHeaders);
    for (const hk in extra) headers[hk] = extra[hk];
    delete headers['Content-Type'];
    const data = await request(url, { headers }, { service: 'AI', timeout: 20000, retries: 1 });
    let ids = [];
    if (Array.isArray(data && data.data)) ids = data.data.map((m) => m && (m.id || m.name));
    else if (Array.isArray(data && data.models)) ids = data.models.map((m) => m && (m.name || m.id));
    else if (Array.isArray(data)) ids = data.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)));
    ids = ids.filter(Boolean).map((x) => String(x).replace(/^models\//, '')).sort();
    if (!ids.length) return { ok: false, error: 'لیست مدلی از سرویس دریافت نشد (پاسخ نامعتبر بود).' };
    return { ok: true, models: ids, url };
  } catch (e) {
    return { ok: false, error: ptErrText(e) + ' — می‌توانید نام مدل را دستی وارد کنید.' };
  }
}

/* ====================================================================== */
/*                     تست اتصال (گام‌به‌گام)                             */
/* ====================================================================== */
async function testEngine(deep) {
  const s = await getSettings();
  const steps = [];
  const push = (name, ok, info, ms, error) => steps.push({ name, ok, info: info || '', ms: ms || 0, error: error || '' });
  const engine = s.engine;
  const target = s.targetLang || 'fa';
  const t0 = Date.now();
  let sample = '';

  if (engine === 'llm') {
    const missing = [];
    if (!String(s.llmKey || '').trim()) missing.push('کلید API');
    if (!String(s.llmBaseUrl || '').trim()) missing.push('Base URL');
    if (!String(s.llmModel || '').trim()) missing.push('نام مدل');
    if (missing.length) {
      push('تنظیمات', false, '', 0, 'این موارد کامل نیست: ' + missing.join('، '));
      return { ok: false, error: 'این موارد کامل نیست: ' + missing.join('، '), steps };
    }
    push('آدرس نهایی', true, ptChatUrl(s.llmBaseUrl), 0);
    if (deep) {
      const t = Date.now();
      const lm = await listModels();
      if (lm.ok) push('لیست مدل‌های سرویس', true, `${lm.models.length} مدل — نمونه: ${lm.models.slice(0, 4).join(', ')}`, Date.now() - t);
      else push('لیست مدل‌های سرویس', false, '', Date.now() - t, lm.error);
    }
    const t = Date.now();
    try {
      const r = await llmChunk(['Hello! How are you today?', 'The weather is nice.'], 'en', target, s, 0);
      sample = r.join(' | ');
      push('ترجمه‌ی نمونه با مدل ' + s.llmModel, true, sample, Date.now() - t);
      return { ok: true, sample, ms: Date.now() - t0, engine, steps };
    } catch (e) {
      push('ترجمه‌ی نمونه با مدل ' + s.llmModel, false, '', Date.now() - t, ptErrText(e));
      return { ok: false, error: ptErrText(e), steps };
    }
  }

  if (engine === 'google' || engine === 'gtx') {
    let htmlOk = false, gtxOk = false;
    if (engine === 'google') {
      const t = Date.now();
      try {
        const r = await googleHtmlRequest(['Hello! How are you today?'], 'en', target, s);
        sample = r[0];
        htmlOk = true;
        push('سرویس سریع Google (translateHtml)', true, r[0], Date.now() - t);
      } catch (e) {
        push('سرویس سریع Google (translateHtml)', false, '', Date.now() - t, ptErrText(e));
      }
    }
    const t2 = Date.now();
    try {
      const r2 = await gtxGet(['Hello! How are you today?', 'The weather is nice.'], 'en', target, s);
      gtxOk = true;
      if (!sample) sample = r2.join(' | ');
      push('روش جایگزین gtx (دسته‌ای)', true, r2.join(' | '), Date.now() - t2);
    } catch (e) {
      push('روش جایگزین gtx (دسته‌ای)', false, '', Date.now() - t2, ptErrText(e));
    }
    const ok = engine === 'gtx' ? gtxOk : (htmlOk || gtxOk);
    return {
      ok, sample, ms: Date.now() - t0, engine, steps,
      warning: engine === 'google' && !htmlOk && gtxOk
        ? 'سرویس سریع در دسترس نیست (احتمالاً فیلتر است)؛ افزونه با روش جایگزین gtx کار می‌کند و کمی کندتر است.'
        : ''
    };
  }

  if (!engineReady(s)) {
    push('تنظیمات', false, '', 0, 'کلید API / تنظیمات این موتور کامل نیست.');
    return { ok: false, error: 'کلید API / تنظیمات این موتور کامل نیست.', steps };
  }
  const t = Date.now();
  try {
    const r = await runEngine(engine, ['Hello! How are you today?', 'The weather is nice.'], 'en', target, s);
    sample = r.join(' | ');
    push(PT_ENGINE_INFO[engine].name, true, sample, Date.now() - t);
    return { ok: true, sample, ms: Date.now() - t0, engine, steps };
  } catch (e) {
    push(PT_ENGINE_INFO[engine].name, false, '', Date.now() - t, ptErrText(e));
    return { ok: false, error: ptErrText(e), steps };
  }
}

/* ====================================================================== */
/*                    گرم‌کردن (پیش‌اتصال به سرویس‌ها)                     */
/* ====================================================================== */
let warmedAt = 0;
async function warmup() {
  if (Date.now() - warmedAt < 45000) return { ok: true, skipped: true };
  warmedAt = Date.now();
  const s = await getSettings();
  setMaxSlots(s.maxConcurrent);
  if (s.cacheEnabled && s.persistCache) loadCache();
  if (s.engine === 'google' && Date.now() > htmlDownUntil) {
    googleHtmlRequest(['hello'], 'en', s.targetLang || 'fa', s).then(
      () => { htmlChecked = true; htmlFails = 0; },
      (e) => { htmlChecked = true; htmlFails++; if (e.network || e.status === 403) htmlDownUntil = Date.now() + 120000; }
    );
  }
  return { ok: true };
}

/* ====================================================================== */
/*                                 OCR                                    */
/* ====================================================================== */
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'تشخیص متن داخل تصاویر (OCR) با Tesseract در Web Worker'
  }).catch((e) => {
    if (!String(e).includes('single offscreen')) throw e;
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function forwardToOffscreen(msg) {
  await ensureOffscreen();
  const s = await getSettings();
  if (msg.type === 'ocr-warmup') {
    return chrome.runtime.sendMessage(Object.assign({}, msg, {
      target: 'offscreen', quality: s.ocrQuality, parallel: s.ocrParallel
    }));
  }
  const t0 = Date.now();
  const res = await chrome.runtime.sendMessage(Object.assign({}, msg, {
    target: 'offscreen',
    quality: msg.quality || s.ocrQuality,
    invert: msg.invert == null ? s.ocrInvert : msg.invert,
    parallel: s.ocrParallel,
    maxDim: s.ocrMaxDim,
    skipBlank: s.ocrSkipBlank,
    cacheLimit: s.ocrCacheLimit,
    /* مهلت هر پاس OCR در offscreen: نصف مهلت سمت صفحه تا اول اینجا رها شود */
    passTimeoutMs: Math.round(ptClamp(s.ocrTimeout, 5, 300, 45) * 500)
  }));
  if (res && res.ok) { diag.ocr++; diag.ocrMs += Date.now() - t0; }
  return res;
}

/* عکس‌هایی که دانلود نمی‌شوند، از اسکرین‌شات بخش دیده‌شده خوانده می‌شوند */
let lastCapture = 0;
let captureChain = Promise.resolve();
function captureVisible(windowId) {
  const p = captureChain.then(async () => {
    const wait = 550 - (Date.now() - lastCapture);
    if (wait > 0) await sleep(wait);
    lastCapture = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  });
  captureChain = p.catch(() => {});
  return p;
}

async function captureAndOcr(msg, sender) {
  if (!sender.tab) throw new Error('no tab');
  const dataUrl = await captureVisible(sender.tab.windowId);
  return forwardToOffscreen({
    type: 'ocr', dataUrl, crop: msg.crop, lang: msg.lang,
    minConf: msg.minConf, quick: msg.quick, quality: msg.quality, noCache: true
  });
}

/* ====================================================================== */
/*                              نصب/به‌روزرسانی                           */
/* ====================================================================== */
chrome.runtime.onInstalled.addListener(async () => {
  let s = {};
  try { s = await chrome.storage.sync.get(null); } catch (e) { /* ignore */ }
  if (s.engine === 'gcloud' && s.apiKey && !s.gcloudKey) s.gcloudKey = s.apiKey;
  if (s.ocrMinConfidence === 55) s.ocrMinConfidence = 40;
  if (s.__v !== PT_VERSION && (s.scope === 'site' || s.scope == null)) s.scope = PT_DEFAULTS.scope;
  s.__v = PT_VERSION;
  delete s.apiKey;
  try { await chrome.storage.sync.remove('apiKey'); } catch (e) { /* ignore */ }
  const merged = Object.assign({}, PT_DEFAULTS, s);
  try { await chrome.storage.sync.set(merged); } catch (e) { /* ignore */ }
  settingsCache = merged;
});

chrome.runtime.onStartup.addListener(() => { settingsCache = null; });

/* در MV3 ممکن است SW هر لحظه بخوابد؛ کش حافظه‌ای را زودتر ذخیره می‌کنیم */
chrome.runtime.onSuspend.addListener(() => { if (bucketDirty.size) saveCache(); });

/* گرم‌کردن اولیه: تنظیمات و کش را از پیش می‌خوانیم تا اولین ترجمه سریع باشد */
getSettings().then((s) => { setMaxSlots(s.maxConcurrent); if (s.cacheEnabled && s.persistCache) loadCache(); });
