/* =========================================================================
   content.js — اسکن صفحه، ترجمه و رسم ترجمه روی متن اصلی
   نسخه‌ی ۲.۱ — بازنویسی‌شده برای سرعت:
     • صف اولویت‌دار با موقعیت‌های کش‌شده (بدون خواندن مکرر DOM)
     • ساخت تنبل کادرها + خواباندن کادرهای دور از دید (DOM سبک)
     • به‌روزرسانی موقعیت فقط برای عناصر شناور/اسکرول‌دار
     • رد کردن متن هم‌زبان با مقصد و متن‌های کم‌ارزش
     • ارسال دسته‌ای با هم‌زمانی قابل تنظیم و اولویت «بخش دیدنی»
   ========================================================================= */
/* global PT_DEFAULTS, PT_RTL, PT_OCR_LANGS, ptIsSameAsTarget, ptIsRtlLang, ptClamp, ptDominantScript */
(() => {
  if (window.__pageTranslatorLoaded) return;
  window.__pageTranslatorLoaded = true;

  const IS_TOP = window === window.top;

  /* ============================ وضعیت ============================ */
  let settings = Object.assign({}, PT_DEFAULTS);
  let active = false;
  let session = 0;                    // با هر شروع/توقف عوض می‌شود تا نتایج قدیمی نادیده گرفته شوند
  let host = null, shadow = null, layer = null, toast = null;
  let items = [];                     // همه‌ی هدف‌های ترجمه (متن، دکمه، placeholder، تصویر)
  let pending = [];                   // در انتظار ترجمه
  let retryLater = [];                // آیتم‌هایی که ترجمه‌شان خطا داد (تلاش دوباره)
  let ovMap = new WeakMap();          // overlay element -> item
  let processedText = new WeakSet();
  let processedEls = new WeakSet();
  let processedImages = new WeakMap();
  let ancCache = new WeakMap();
  let occCache = new WeakMap();       // عنصر -> {at, info}
  let skipCache = new WeakMap();      // عنصر -> آیا باید نادیده گرفته شود
  let occluders = new Set();
  let blockQueue = [];
  let deferredBlocks = new Set();     // بلوک‌های بیرون از دید (حالت صفحه‌ی فعلی)
  let retryRuns = [];                 // متن‌هایی که هنگام اسکن دیده نمی‌شدند
  let nodeItems = new WeakMap();     // text node -> item (برای تشخیص سریع تغییر متن)
  let bgCandidates = new Set();
  let canvasCandidates = new Set();
  let attrOriginals = new WeakMap();
  let attrTouched = new Set();
  let scanning = false;
  let inflight = 0;
  let imageQueue = [];
  let imageActive = 0, captureBusy = false, lastImagePump = 0;
  let stats = { textTotal: 0, textDone: 0, textSkipped: 0, imgTotal: 0, imgDone: 0, imgFail: 0, scanning: false };
  let mutationObs = null, resizeObs = null, intersectObs = null, tickTimer = null, tickCount = 0, keepAlive = null;
  let pendingRoots = new Set();
  let mutationTimer = null, relayoutTimer = null, scrollRaf = 0, scrollEndTimer = null, renderRaf = 0;
  let needsNearRelayout = false;
  let ancDirty = false;
  let errorShown = false;
  let startedAt = 0, lastRate = 0, lastRateAt = 0, lastDoneCount = 0;
  const localCache = new Map();
  let imgRectCache = new WeakMap();  // el -> {at, dist}

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'PRE', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'MATH', 'SAMP', 'TEMPLATE',
    'HEAD', 'TITLE', 'LINK', 'META', 'BR', 'HR', 'WBR']);
  const INLINE_DISPLAYS = new Set(['inline', 'contents', 'ruby', 'ruby-text', 'ruby-base']);
  const LETTER_RE = /\p{L}/u;
  const LETTER_OR_NUM_RE = /[\p{L}\p{N}]/gu;

  /* در همه‌ی زمینه‌ها ShadowRoot سراسری نیست؛ تشخیص امن */
  function isShadow(node) {
    return !!node && ((typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot) || node.nodeType === 11);
  }

  const isView = () => settings.scope === 'view';           // فقط بخش دیدنی
  const prioritizeView = () => settings.scope !== 'site';   // اولویت به بخش دیدنی
  const viewMargin = () => Math.round(window.innerHeight * (isView() ? 0.2 : 0.35));
  const maxInflight = () => ptClamp(settings.maxConcurrent, 1, 12, 6);
  /* مهلت هر درخواست OCR (ثانیه) — اگر offscreen گیر کند، اسلات تصویر برای همیشه قفل نشود */
  const ocrTimeoutMs = () => ptClamp(settings.ocrTimeout, 5, 300, 45) * 1000;

  function rectInView(r) {
    const m = viewMargin();
    return r.bottom > -m && r.top < window.innerHeight + m && r.right > -20 && r.left < window.innerWidth + 20;
  }
  function blockOutOfView(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return !rectInView(r);
  }

  function countItem(it) {
    if (!it.counted && it.type === 'text') { it.counted = true; stats.textTotal++; }
  }

  /* ============================ راه‌اندازی ============================ */
  (async () => {
    try {
      settings = Object.assign({}, PT_DEFAULTS, await chrome.storage.sync.get(PT_DEFAULTS));
      const st = await sendMessage({ type: 'hello' });
      if (st && st.active) startWhenReady();
    } catch (e) { /* ignore */ }
  })();

  function startWhenReady() {
    if (active) return;
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', () => { if (!active) start(); }, { once: true });
  }

  /* ============================ تنظیمات ============================ */
  const RESTART_KEYS = ['sourceLang', 'targetLang', 'engine', 'gcloudKey', 'deeplKey', 'msKey', 'msRegion',
    'libreUrl', 'libreKey', 'llmKey', 'llmModel', 'llmBaseUrl', 'llmPreset', 'llmFormat', 'llmItems', 'llmChars',
    'translateImages', 'translateBackgroundImages', 'ocrMinConfidence', 'ocrLang', 'ocrQuality', 'ocrInvert',
    'ocrMaxDim', 'ocrSkipBlank', 'ocrVisibleOnly', 'scope', 'respectNoTranslate', 'translateInputs',
    'translateInlineCode', 'translateCodeBlocks', 'skipSelectors', 'minTextLength', 'skipTargetScript',
    'deeplFormality', 'llmExtraHeaders', 'llmSystemPrompt', 'glossary'];
  const RELAYOUT_KEYS = ['lightDom', 'hibernateDistance', 'renderMargin', 'fontScale', 'boxOpacity',
    'boxPadding', 'boxRadius', 'fontFamily', 'forceRtl'];

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const old = settings;
    settings = Object.assign({}, settings);
    for (const k in changes) settings[k] = changes[k].newValue;
    if (!active) return;
    if (RESTART_KEYS.some((k) => k in changes && JSON.stringify(changes[k].newValue) !== JSON.stringify(old[k]))) {
      stop(); start();
    } else if (['boxColorMode', 'boxColor', 'textColorMode', 'textColor'].some((k) => k in changes)) {
      items.forEach((it) => { if (it.ov) applyColors(it); });
    } else if (RELAYOUT_KEYS.some((k) => k in changes)) {
      items.forEach((it) => { it.needsFit = true; });
      renderNow();
    } else if ('toastEnabled' in changes && !settings.toastEnabled && toast) {
      toast.classList.add('fade');
    }
  });

  /* ============================ شورتکات داخل صفحه ============================ */
  window.addEventListener('keydown', (e) => {
    const sc = settings.shortcut;
    if (!sc || !sc.code || e.repeat) return;
    if (e.code !== sc.code || e.ctrlKey !== !!sc.ctrl || e.altKey !== !!sc.alt ||
        e.shiftKey !== !!sc.shift || e.metaKey !== !!sc.meta) return;
    if (!sc.ctrl && !sc.alt && !sc.meta && isEditable(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    sendMessage({ type: 'toggle-tab' }).catch(() => { active ? stop() : start(); });
  }, true);

  function isEditable(el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  /* ============================ پیام‌ها ============================ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'apply-state') {
      if (msg.active && !active) startWhenReady();
      else if (!msg.active && active) stop();
      sendResponse(status());
    } else if (msg.type === 'status') {
      sendResponse(status());
    } else if (msg.type === 'diag-content') {
      sendResponse(contentDiag());
    }
    return false;
  });

  function status() {
    return Object.assign({
      ok: true, active, waitingCapture: imageQueue.filter((j) => j.mode === 'capture').length,
      scope: settings.scope, pending: pending.length, inflight, rate: lastRate
    }, stats);
  }

  function contentDiag() {
    return {
      ok: true, active, session, scope: settings.scope,
      items: items.length, pending: pending.length, retry: retryLater.length,
      inflight, rendered: items.reduce((a, it) => a + (it.ov ? 1 : 0), 0),
      blocks: blockQueue.length, deferred: deferredBlocks.size, retryRuns: retryRuns.length,
      imageQueue: imageQueue.length, imageActive, rate: lastRate, stats
    };
  }

  /* ============================ شروع / توقف ============================ */
  function start() {
    if (!document.body || active) return;
    if (!IS_TOP && (window.innerWidth < 60 || window.innerHeight < 30)) return;  // فریم‌های تبلیغاتی
    active = true;
    session++;
    errorShown = false;
    startedAt = Date.now();
    lastRate = 0; lastRateAt = Date.now(); lastDoneCount = 0;
    stats = { textTotal: 0, textDone: 0, textSkipped: 0, imgTotal: 0, imgDone: 0, imgFail: 0, scanning: true };
    try {
      createHost();
      showToast(isView() ? '⚡ ترجمه‌ی بخش قابل مشاهده…'
        : settings.scope === 'auto' ? '⚡ ترجمه‌ی بخش دیدنی، سپس کل صفحه…' : '⏳ در حال اسکن کل صفحه…');
      sendMessage({ type: 'warmup' }).catch(() => {});
      if (settings.translateImages) sendMessage({ type: 'ocr-warmup', lang: ocrLang() }).catch(() => {});
      startObservers();
      enqueueScan(document.body);
    } catch (e) {
      console.error('[Page Translator] start failed:', e);
    }
  }

  function stop() {
    active = false;
    session++;
    stopObservers();
    if (host) host.remove();
    for (const el of attrTouched) {
      const orig = attrOriginals.get(el);
      if (!orig) continue;
      for (const k in orig) { if (orig[k] == null) el.removeAttribute(k); else el.setAttribute(k, orig[k]); }
    }
    attrTouched = new Set();
    attrOriginals = new WeakMap();
    host = shadow = layer = toast = null;
    items = [];
    pending = [];
    retryLater = [];
    ovMap = new WeakMap();
    processedText = new WeakSet();
    processedEls = new WeakSet();
    processedImages = new WeakMap();
    ancCache = new WeakMap();
    occCache = new WeakMap();
    skipCache = new WeakMap();
    imgRectCache = new WeakMap();
    occluders = new Set();
    deferredBlocks = new Set();
    bgCandidates = new Set();
    canvasCandidates = new Set();
    retryRuns = [];
    blockQueue = [];
    scanning = false;
    imageQueue = [];
    pendingRoots.clear();
    inflight = 0;
    imageActive = 0;
    captureBusy = false;
    needsNearRelayout = false;
  }

  function createHost() {
    host = document.createElement('page-translator-layer');
    host.setAttribute('translate', 'no');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;overflow:visible;' +
      'z-index:2147483647;pointer-events:none;display:block;contain:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .ov{position:absolute;box-sizing:border-box;overflow:hidden;display:flex;align-items:center;
        pointer-events:none;margin:0;padding:0 1px;border:0;contain:strict;
        font-kerning:normal;-webkit-font-smoothing:antialiased;}
      .ov.fixed{position:fixed}
      .ov .t{display:block;width:100%;margin:0;padding:0;white-space:normal;overflow-wrap:anywhere;
        word-break:normal;line-height:1.18;}
      .ov.hidden{display:none}
      .ov.capturing{visibility:hidden}
      .ov.img{border-radius:2px;padding:0 2px}
      .ov.widget{border-radius:3px}
      .toast{position:fixed;bottom:16px;left:16px;z-index:2;background:rgba(17,24,39,.92);color:#fff;
        font:13px/1.6 Tahoma,Vazirmatn,system-ui,sans-serif;padding:8px 14px;border-radius:10px;
        box-shadow:0 6px 24px rgba(0,0,0,.25);direction:rtl;transition:opacity .4s;opacity:1;max-width:390px}
      .toast.fade,.toast.capturing{opacity:0}
      .toast b{color:#93c5fd;font-weight:600}
      .toast small{display:block;color:#cbd5e1}
    `;
    shadow.appendChild(style);
    layer = document.createElement('div');
    shadow.appendChild(layer);
    if (IS_TOP) {
      toast = document.createElement('div');
      toast.className = 'toast';
      shadow.appendChild(toast);
      if (!settings.toastEnabled) toast.classList.add('fade');
    }
    document.documentElement.appendChild(host);
  }

  /* ============================ جمع‌آوری متن‌ها ============================ */
  function skipSelectorList() {
    const raw = String(settings.skipSelectors || '').trim();
    if (!raw) return null;
    try { return raw.split(',').map((s) => s.trim()).filter(Boolean); } catch (e) { return null; }
  }

  function matchesSkipSelector(el) {
    const list = skipSelectorList();
    if (!list || !el.closest) return false;
    const cached = skipCache.get(el);
    if (cached !== undefined) return cached;
    let hit = false;
    for (const sel of list) {
      try { if (el.closest(sel)) { hit = true; break; } } catch (e) { /* سلکتور نادرست */ }
    }
    skipCache.set(el, hit);
    return hit;
  }

  function isSkippable(el) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'PRE' && !settings.translateCodeBlocks) return true;
    if (SKIP_TAGS.has(tag) && !(tag === 'PRE')) return true;
    if (tag === 'CODE' && !settings.translateInlineCode) return true;
    if (el === host) return true;
    if (el.isContentEditable) return true;
    if (el.dataset && el.dataset.pageTranslator) return true;
    if (settings.skipSelectors && matchesSkipSelector(el)) return true;
    if (settings.respectNoTranslate) {
      const tr = el.getAttribute && el.getAttribute('translate');
      if (tr === 'no' || (el.classList && el.classList.contains('notranslate'))) return true;
    }
    return false;
  }

  function enqueueScan(root) {
    if (!root || !active) return;
    let el = root.nodeType === 1 ? root : root.parentElement;
    if (!el || !el.isConnected) return;
    while (el && el !== document.body && el.parentElement) {
      if (!INLINE_DISPLAYS.has(getComputedStyle(el).display)) break;
      el = el.parentElement;
    }
    for (let a = el; a; a = a.parentElement) {
      if (a !== document.body && a !== document.documentElement && isSkippable(a)) {
        if (a.tagName === 'CANVAS') considerCanvas(a);
        if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') considerInput(a);
        return;
      }
    }
    if (el.tagName === 'IMG') { considerImage(el, false); pumpImages(); return; }
    if (el !== document.body && settings.translateImages && settings.translateBackgroundImages) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage.includes('url(')) considerImage(el, true, cs);
    }
    blockQueue.push(el);
    runScan();
  }

  function runScan() {
    if (scanning) return;
    scanning = true;
    stats.scanning = true;
    const mySession = session;
    const slice = ptClamp(settings.scanSliceMs, 4, 100, 20);
    const step = () => {
      if (!active || mySession !== session) return;
      const t0 = performance.now();
      while (blockQueue.length && performance.now() - t0 < slice) {
        const b = blockQueue.shift();
        if (!b || !(b.isConnected || isShadow(b))) continue;
        try { processBlock(b); }
        catch (e) { if (settings.diagnostics) console.debug('[PT] scan error', e); }
      }
      pumpTranslations();
      pumpImages();
      if (blockQueue.length) setTimeout(step, 0);
      else { scanning = false; stats.scanning = false; updateToast(); }
    };
    step();
  }

  function processBlock(blockEl) {
    let run = [];
    const owner = isShadow(blockEl) ? blockEl.host : blockEl;
    const flush = () => { if (run.length) createTextItems(run, owner); run = []; };
    const view = isView();
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          if (!processedText.has(child) && child.nodeValue.trim()) run.push(child);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'IMG') { considerImage(child, false); continue; }
        if (tag === 'CANVAS') { considerCanvas(child); continue; }
        if (tag === 'INPUT' || tag === 'TEXTAREA') { considerInput(child); continue; }
        if (tag === 'SVG') { flush(); scanSvg(child); continue; }
        if (isSkippable(child)) continue;
        const cs = getComputedStyle(child);
        if (cs.display === 'none') continue;
        if (cs.position === 'fixed' || cs.position === 'sticky' ||
            (cs.position === 'absolute' && cs.zIndex !== 'auto' && +cs.zIndex > 0)) occluders.add(child);
        if (settings.translateImages && settings.translateBackgroundImages &&
            cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url(')) considerImage(child, true, cs);
        if (child.shadowRoot) { flush(); blockQueue.push(child.shadowRoot); }
        if (INLINE_DISPLAYS.has(cs.display)) walk(child);
        else {
          flush();
          if (view && blockOutOfView(child)) deferredBlocks.add(child);
          else blockQueue.push(child);
        }
      }
    };
    walk(blockEl);
    flush();
  }

  function scanSvg(svg) {
    for (const t of svg.querySelectorAll('text')) {
      if (isView() && blockOutOfView(t)) deferredBlocks.add(t);
      else blockQueue.push(t);
    }
  }

  function considerInput(el) {
    if (!settings.translateInputs || processedEls.has(el)) return;
    const type = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(type) && el.value && LETTER_RE.test(el.value)) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      if (isView() && !rectInView(r)) return;
      processedEls.add(el);
      const cs = getComputedStyle(el);
      const item = Object.assign({
        type: 'text', kind: 'widget', el, text: el.value.replace(/\s+/g, ' ').trim(),
        font: { size: parseFloat(cs.fontSize) || 14, family: cs.fontFamily, weight: cs.fontWeight, style: cs.fontStyle, color: cs.color, align: 'center' }
      }, ancInfo(el));
      item.rect = textRect(item);
      setDocPos(item);
      items.push(item);
      if (!isView()) countItem(item);
      queueTranslate(item);
      return;
    }
    const ph = el.getAttribute('placeholder');
    if (ph && LETTER_RE.test(ph)) {
      processedEls.add(el);
      const item = { type: 'attr', kind: 'attr', attr: 'placeholder', el, text: ph.replace(/\s+/g, ' ').trim(), fixed: true, docTop: 0, docBottom: 0 };
      items.push(item);
      queueTranslate(item);
    }
  }

  /* یک ردیف متن با فاصله‌ی افقی زیاد (مثل آیتم‌های منو) به چند آیتم جدا شکسته می‌شود */
  function createTextItems(nodes, blockEl) {
    if (nodes.length === 1) { createTextItem(nodes, blockEl, null); return; }
    const range = document.createRange();
    const edge = (n, last) => {
      range.selectNodeContents(n);
      const rs = [...range.getClientRects()].filter((r) => r.width > 0.5);
      return rs.length ? rs[last ? rs.length - 1 : 0] : null;
    };
    const fs = parseFloat(getComputedStyle(blockEl).fontSize) || 16;
    let group = [nodes[0]], seps = [];
    const groups = [];
    for (let i = 1; i < nodes.length; i++) {
      const a = edge(nodes[i - 1], true), b = edge(nodes[i], false);
      let sep = '';
      if (a && b) {
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const sameLine = vOverlap > 0.5 * Math.min(a.height, b.height);
        const gap = Math.max(b.left - a.right, a.left - b.right);
        if (sameLine && gap > 1.1 * fs) { groups.push([group, seps]); group = [nodes[i]]; seps = []; continue; }
        if (sameLine && gap > 0.2 * fs) sep = ' ';
      }
      seps.push(sep);
      group.push(nodes[i]);
    }
    groups.push([group, seps]);
    for (const [g, sp] of groups) createTextItem(g, blockEl, sp);
  }

  /* متن‌هایی که ارزش ترجمه ندارند: خیلی کوتاه، فقط عدد/نشانه، یا هم‌زبان با مقصد */
  function shouldSkipText(text) {
    const minLen = ptClamp(settings.minTextLength, 1, 40, 1);
    if (minLen > 1) {
      const letters = (text.match(LETTER_OR_NUM_RE) || []).length;
      if (letters < minLen) return 'short';
    }
    if (settings.skipTargetScript && ptIsSameAsTarget(text, settings.targetLang, settings.sourceLang)) return 'same';
    return null;
  }

  /* true = آیتم ساخته شد / false = فعلاً دیده نمی‌شود */
  function createTextItem(nodes, blockEl, seps, fromRetry) {
    let raw = nodes[0].nodeValue;
    for (let i = 1; i < nodes.length; i++) raw += ((seps && seps[i - 1]) || '') + nodes[i].nodeValue;
    const text = raw.replace(/\s+/g, ' ').trim();
    nodes.forEach((n) => processedText.add(n));
    if (!text || !LETTER_RE.test(text)) return true;

    const skip = shouldSkipText(text);
    if (skip === 'same') {
      if (skip === 'same' && settings.diagnostics) console.debug('[PT] skip (same language):', text.slice(0, 60));
      if (!isView()) { stats.textTotal++; stats.textDone++; }
      stats.textSkipped++;
      return true;
    }
    if (skip === 'short' && !isView()) { stats.textTotal++; stats.textDone++; return true; }

    const parent = nodes[0].parentElement;
    if (!parent) return true;
    const anc = ancInfo(parent);
    const item = { type: 'text', kind: 'text', nodes, el: blockEl, text, session };
    Object.assign(item, anc);
    item.rect = anc.transparent ? null : textRect(item);
    if (!item.rect || item.rect.width < 2 || item.rect.height < 4) {
      nodes.forEach((n) => processedText.delete(n));
      if (!fromRetry && retryRuns.length < 8000) retryRuns.push({ nodes, blockEl, seps });
      return false;
    }
    const cs = getComputedStyle(parent);
    const isSvg = parent instanceof SVGElement;
    item.font = {
      size: parseFloat(cs.fontSize) || 16,
      family: cs.fontFamily,
      weight: cs.fontWeight,
      style: cs.fontStyle,
      color: isSvg && cs.fill && cs.fill.startsWith('rgb') ? cs.fill : cs.color,
      align: isSvg ? 'center' : getComputedStyle(blockEl).textAlign
    };
    setDocPos(item);
    items.push(item);
    nodes.forEach((n) => nodeItems.set(n, item));
    if (!isView()) countItem(item);
    queueTranslate(item);
    return true;
  }

  function retryHidden() {
    if (!retryRuns.length) return;
    const keep = [];
    let tried = 0;
    for (const r of retryRuns) {
      if (!r.nodes.every((n) => n.isConnected) || r.nodes.some((n) => processedText.has(n))) continue;
      if (tried > 800) { keep.push(r); continue; }
      tried++;
      if (isView() && r.blockEl.isConnected && blockOutOfView(r.blockEl)) { keep.push(r); continue; }
      if (!createTextItem(r.nodes, r.blockEl, r.seps, true)) keep.push(r);
    }
    retryRuns = keep;
  }

  /* اطلاعات اجداد: fixed/sticky، برش overflow، نامرئی بودن — با کش */
  const EMPTY_ANC = { fixed: false, sticky: false, scrollable: false, transparent: false, clips: [], dynamic: false };
  function ancInfo(el) {
    if (!el || el.nodeType !== 1 || el === document.documentElement) return EMPTY_ANC;
    const cached = ancCache.get(el);
    if (cached) return cached;
    const parent = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    const p = ancInfo(parent);
    const cs = getComputedStyle(el);
    const clipsHere = el !== document.body && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
    const info = {
      fixed: p.fixed || cs.position === 'fixed',
      sticky: p.sticky || cs.position === 'sticky',
      scrollable: p.scrollable || (clipsHere && /(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY)),
      transparent: p.transparent || parseFloat(cs.opacity) < 0.05 || cs.visibility === 'hidden' || cs.display === 'none',
      clips: clipsHere ? p.clips.concat([el]) : p.clips
    };
    info.dynamic = info.sticky || info.scrollable;
    ancCache.set(el, info);
    return info;
  }

  function textRect(item) {
    if (item.kind === 'widget') {
      const el = item.el;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const cs = getComputedStyle(el);
      const bl = (parseFloat(cs.borderLeftWidth) || 0) + 1, bt = (parseFloat(cs.borderTopWidth) || 0) + 1;
      const br = (parseFloat(cs.borderRightWidth) || 0) + 1, bb = (parseFloat(cs.borderBottomWidth) || 0) + 1;
      return { left: r.left + bl, top: r.top + bt, right: r.right - br, bottom: r.bottom - bb, width: r.width - bl - br, height: r.height - bt - bb };
    }
    const range = document.createRange();
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of item.nodes) {
      if (!n.isConnected) continue;
      range.selectNodeContents(n);
      for (const rc of range.getClientRects()) {
        if (rc.width < 0.5 || rc.height < 0.5) continue;
        if (rc.left < l) l = rc.left;
        if (rc.top < t) t = rc.top;
        if (rc.right > r) r = rc.right;
        if (rc.bottom > b) b = rc.bottom;
      }
    }
    if (l === Infinity) return null;
    return { left: l - 1, top: t, right: r + 1, bottom: b, width: r - l + 2, height: b - t };
  }

  /* ============================ ترجمه ============================ */
  function ck(text) { return settings.sourceLang + '|' + settings.targetLang + '|' + text; }

  function setDocPos(item) {
    if (!item.rect) { item.docTop = null; return; }
    const sy = item.fixed ? 0 : window.scrollY;
    item.docTop = item.rect.top + sy;
    item.docBottom = item.rect.bottom + sy;
  }

  function queueTranslate(item) {
    const hit = localCache.get(ck(item.text));
    if (hit != null) {
      item.translation = hit;
      item.done = true;
      countItem(item);
      if (item.type === 'text') stats.textDone++;
      item.needsRender = true;
      scheduleRender();
      return;
    }
    item.queued = true;
    item._d = distanceOf(item);
    pending.push(item);
  }

  /* حالت «صفحه‌ی فعلی»: متن داخل کادر اسکرول‌دار که بیرون از بخش دیده‌شده‌ی آن است */
  function hiddenInScroller(item) {
    if (!item.scrollable || !item.rect || !item.clips || !item.clips.length) return false;
    const now = performance.now();
    if (item._chkAt && now - item._chkAt < 500) return item._chkHidden;
    item._chkAt = now;
    for (const c of item.clips) {
      if (!c.isConnected) continue;
      const cs = getComputedStyle(c);
      if (!/(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY)) continue;
      const r = c.getBoundingClientRect();
      const mv = r.height * 0.2, mh = r.width * 0.2;
      if (item.rect.bottom < r.top - mv || item.rect.top > r.bottom + mv ||
          item.rect.right < r.left - mh || item.rect.left > r.right + mh) { item._chkHidden = true; return true; }
    }
    item._chkHidden = false;
    return false;
  }

  /* فاصله‌ی تقریبی از محدوده‌ی دید — با مقادیر کش‌شده، بدون خواندن DOM */
  function distanceOf(item) {
    if (item.fixed || item.kind === 'attr') return 0;
    if (item.docTop == null) return 0;
    const y = window.scrollY, vh = window.innerHeight;
    const top = item.docTop - y, bottom = item.docBottom - y;
    if (bottom < -vh) return -bottom - vh;
    if (top > vh) return top - vh;
    return 0;
  }

  let sortedAt = 0, sortedPendingLen = 0, sortedScroll = -1;
  function sortPending() {
    if (!pending.length) return;
    const now = performance.now();
    const scrollMoved = Math.abs(window.scrollY - sortedScroll) > 4;
    if (!scrollMoved && now - sortedAt < 350 && pending.length - sortedPendingLen < 30) return;
    sortedAt = now; sortedPendingLen = pending.length; sortedScroll = window.scrollY;
    for (const it of pending) it._d = distanceOf(it);
    pending.sort((a, b) => a._d - b._d);
  }

  function pumpTranslations() {
    if (!active || !pending.length || inflight >= maxInflight()) return;
    sortPending();

    const strict = isView();
    const margin = viewMargin();
    const budgetItems = ptClamp(settings.batchItems, 10, 500, 150);
    const budgetChars = ptClamp(settings.batchChars, 500, 100000, 18000);

    while (inflight < maxInflight() && pending.length) {
      const firstBatch = stats.textDone === 0 && inflight === 0;
      const maxItems = firstBatch ? Math.min(budgetItems, 60) : budgetItems;
      const batch = [];
      const later = [];
      let chars = 0, idx = 0;
      while (idx < pending.length && batch.length < maxItems && chars < budgetChars) {
        const it = pending[idx];
        const d = it._d == null ? 0 : it._d;
        if (strict && d > margin) break;                    // «فقط دیدنی»: بقیه با اسکرول
        if (it.done || it.removed) { idx++; continue; }
        if (strict && it.scrollable && hiddenInScroller(it)) { later.push(it); idx++; continue; }
        idx++;
        countItem(it);
        const hit = localCache.get(ck(it.text));
        if (hit != null) {
          it.translation = hit; it.done = true; it.queued = false;
          if (it.type === 'text') stats.textDone++;
          it.needsRender = true;
          scheduleRender();
          continue;
        }
        batch.push(it);
        chars += it.text.length;
      }
      pending.splice(0, idx);
      if (later.length) pending.push(...later);
      if (!batch.length) break;
      sendBatch(batch, (strict || firstBatch || batch[0]._d === 0) ? 'high' : 'low');
    }
    updateToast();
  }

  function sendBatch(batch, priority) {
    inflight++;
    const mySession = session;
    const texts = [...new Set(batch.map((it) => it.text))];
    const t0 = performance.now();
    sendMessage({ type: 'translate', texts, sl: settings.sourceLang, tl: settings.targetLang, priority })
      .then((res) => {
        if (mySession !== session) return;
        if (!res || !res.ok) {
          const err = new Error((res && res.error) || 'خطای نامشخص');
          err.fatal = !!(res && res.fatal);
          throw err;
        }
        if (res.warning && !errorShown) { errorShown = true; showToast('⚠️ ' + escapeHtml(res.warning), 8000); }
        if (res.engine && res.engine !== settings.engine && settings.diagnostics) {
          console.debug('[PT] engine used:', res.engine);
        }
        if (localCache.size > 60000) localCache.clear();
        const map = new Map();
        texts.forEach((t, i) => { map.set(t, res.translations[i]); localCache.set(ck(t), res.translations[i]); });
        batch.forEach((it) => {
          const tr = map.get(it.text);
          it.translation = (tr == null || tr === '') ? it.text : tr;
          it.done = true;
          it.queued = false;
          it.needsRender = true;
          countItem(it);
          if (it.type === 'text') stats.textDone++;
        });
        if (settings.diagnostics) console.debug('[PT] batch', texts.length, 'in', Math.round(performance.now() - t0), 'ms via', res.engine);
        scheduleRender();
      })
      .catch((e) => {
        if (mySession !== session) return;
        if (e && e.fatal) {
          batch.forEach((it) => { it.done = true; it.queued = false; countItem(it); if (it.type === 'text') stats.textDone++; });
          if (!errorShown) { errorShown = true; showToast('❌ ' + escapeHtml(e.message), 12000); }
          return;
        }
        const maxTries = ptClamp(settings.requestRetries, 0, 5, 2) + 2;
        const again = [];
        batch.forEach((it) => {
          it.tries = (it.tries || 0) + 1;
          if (it.tries < maxTries) again.push(it);
          else { it.done = true; it.queued = false; countItem(it); if (it.type === 'text') stats.textDone++; }
        });
        if (again.length) {
          const delay = Math.min(8000, 900 * again[0].tries);
          setTimeout(() => {
            if (mySession !== session || !active) return;
            pending.push(...again);
            pumpTranslations();
          }, delay);
        } else if (!errorShown) {
          errorShown = true;
          showToast('❌ خطا در ترجمه: ' + escapeHtml(e.message), 10000);
        }
      })
      .finally(() => {
        if (mySession !== session) return;
        inflight--;
        pumpTranslations();
      });
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message)); else resolve(res);
        });
      } catch (e) { reject(e); }
    });
  }

  /* مهلت OCR: اگر offscreen یا service worker پاسخ نداد (Worker گیرکرده، خواب SW)،
     درخواست رها می‌شود تا اسلات هم‌زمانی تصاویر برای همیشه قفل نماند. */
  function sendTimed(msg, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const e = new Error('مهلت OCR تمام شد');
        e.timeout = true;
        reject(e);
      }, ms);
      sendMessage(msg).then((res) => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(res);
      }, (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(err);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  /* ============================ رسم روی صفحه ============================ */
  function isRtlTarget() {
    if (settings.forceRtl === 'on') return true;
    if (settings.forceRtl === 'off') return false;
    return ptIsRtlLang(settings.targetLang);
  }

  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderNow(); });
    if (!renderRaf) renderRaf = setTimeout(() => { renderRaf = 0; renderNow(); }, 16);
  }

  function isNearRender(item) {
    if (item.fixed || item.kind === 'attr') return true;
    if (item.docTop == null) return true;
    const y = window.scrollY, vh = window.innerHeight;
    const pre = vh * ptClamp(settings.renderMargin, 0, 3, 0.6);
    return item.docBottom > y - pre && item.docTop < y + vh + pre;
  }

  function isFarHibernate(item) {
    if (!settings.lightDom) return false;
    if (item.fixed || item.kind === 'attr') return false;
    if (item.docTop == null) return false;
    const y = window.scrollY, vh = window.innerHeight;
    const d = vh * ptClamp(settings.hibernateDistance, 0.5, 10, 2);
    return item.docBottom < y - d || item.docTop > y + vh + d;
  }

  /* ساخت کادرهای تازه، خواباندن کادرهای دور، و به‌روزرسانی عناصر شناور */
  function renderNow() {
    if (!active || !layer) return;
    const origin = hostOrigin();
    const occ = occluderRects();
    const toCreate = [];
    const toHide = [];
    const now = performance.now();
    for (const it of items) {
      if (it.removed) continue;
      if (!it.translation || it.translation === it.text) continue;
      if (it.kind === 'attr') {                       // placeholder فیلدها
        if (!it.attrApplied) { applyAttr(it); it.attrApplied = true; }
        continue;
      }
      if (it.ov) {
        if (isFarHibernate(it)) toHide.push(it);
        continue;
      }
      if (it.hiddenUntil && now < it.hiddenUntil) continue;
      if (isNearRender(it)) {
        toCreate.push(it);
        if (toCreate.length >= 240 && toHide.length >= 120) break;   // بقیه در فریم بعد
      }
    }
    const limit = toCreate.length > 200 ? 200 : toCreate.length;
    let fitBudget = 50;                      // اندازه‌گیری فونت گران است؛ بقیه با IntersectionObserver
    for (let i = 0; i < limit; i++) {
      const it = toCreate[i];
      const m = measure(it, occ, false);
      if (m.remove) { removeItem(it); continue; }
      if (m.hidden) { it.needsRender = false; it.hiddenUntil = now + 1500; continue; }
      createOverlay(it, isRtlTarget());
      apply(it, m, origin);
      if (it.needsFit && fitBudget > 0) { fitBudget--; fit(it); }
    }
    for (const it of toHide) {
      if (it.ov) { it.ov.remove(); ovMap.delete(it.ov); it.ov = null; it.span = null; it.w = it.h = null; }
    }
    /* عناصر شناور/اسکرول‌دار نزدیک دید باید جای‌شان تازه شود */
    if (needsNearRelayout) {
      needsNearRelayout = false;
      repositionDynamic(origin, occ);
    }
    if (toCreate.length > limit) scheduleRender();
  }

  function repositionDynamic(origin, occ) {
    const list = items.filter((it) => it.ov && (it.dynamic || it.fixed));
    if (!list.length) return;
    const near = list.filter((it) => isNearRender(it)).slice(0, 400);
    const ms = near.map((it) => [it, measure(it, occ, false)]);
    for (const [it, m] of ms) if (m) apply(it, m, origin);
    let budget = 30;
    for (const [it] of ms) {
      if (budget <= 0) break;
      if (it.ov && it.needsFit && isNearRender(it)) { budget--; fit(it); }
    }
  }

  function applyAttr(item) {
    if (!item.el.isConnected) return;
    if (!attrOriginals.has(item.el)) attrOriginals.set(item.el, {});
    const orig = attrOriginals.get(item.el);
    if (!(item.attr in orig)) orig[item.attr] = item.el.getAttribute(item.attr);
    item.el.setAttribute(item.attr, item.translation.trim());
    attrTouched.add(item.el);
  }

  function createOverlay(item, rtl) {
    const ov = document.createElement('div');
    ov.className = 'ov' + (item.type === 'image' ? ' img' : '') + (item.kind === 'widget' ? ' widget' : '') + (item.fixed ? ' fixed' : '');
    const t = document.createElement('span');
    t.className = 't';
    ov.appendChild(t);
    item.ov = ov;
    item.span = t;
    ovMap.set(ov, item);
    ov.dir = rtl ? 'rtl' : 'ltr';
    item.w = item.h = null;
    applyOverlayStyle(item);
    layer.appendChild(ov);
    if (intersectObs) intersectObs.observe(ov);
  }

  /* متن و استایل کادر (با تنظیمات ظاهری) */
  function applyOverlayStyle(item) {
    const f = item.font || { size: 16, family: '', weight: 'normal', style: 'normal', color: '#111', align: 'left' };
    const rtl = isRtlTarget();
    let align = f.align;
    if (align !== 'center') align = rtl ? 'right' : 'left';
    const scale = ptClamp(settings.fontScale, 50, 200, 100) / 100;
    const size = item.type === 'image'
      ? Math.max(8, (item.lineHeightPx || 14) * 0.8)
      : (f.size || 16) * scale;
    const family = settings.fontFamily ? settings.fontFamily + ',' : '';
    item.span.style.cssText = `font-family:${family}${f.family ? f.family + ',' : ''}Vazirmatn,Tahoma,"Segoe UI",sans-serif;` +
      `font-weight:${f.weight || 'normal'};font-style:${f.style || 'normal'};text-align:${align};font-size:${size}px;`;
    item.span.textContent = (item.translation || '').trim();
    item.ov.style.padding = `0 ${ptClamp(settings.boxPadding, 0, 12, 1)}px`;
    item.ov.style.borderRadius = ptClamp(settings.boxRadius, 0, 20, 2) + 'px';
    applyColors(item);
    item.needsFit = true;
  }

  function applyColors(item) {
    let bg, fg;
    if (settings.boxColorMode === 'auto') bg = item.type === 'image' ? item.bg : effectiveBg(item.el);
    else bg = settings.boxColor || '#ffffff';
    if (settings.textColorMode === 'custom') fg = settings.textColor;
    else {
      const orig = item.type === 'image' ? item.fg : (item.font && item.font.color);
      fg = contrast(orig, bg) >= 2.5 ? orig : (luminance(parseColor(bg)) > 0.45 ? '#111111' : '#ffffff');
    }
    const op = ptClamp(settings.boxOpacity, 0.1, 1, 1);
    item.ov.style.background = op >= 1 ? bg : toRgba(bg, op);
    item.ov.style.color = fg;
  }

  function toRgba(color, alpha) {
    const c = parseColor(color);
    if (!c) return color;
    return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] == null ? 1 : c[3]) * alpha})`;
  }

  function effectiveBg(el) {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const c = parseColor(getComputedStyle(a).backgroundColor);
      if (c && c[3] > 0.5) return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    return '#ffffff';
  }

  function parseColor(str) {
    if (!str) return null;
    let m = String(str).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length < 3) return null;
    return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
  }

  function luminance(c) {
    if (!c) return 1;
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }

  function contrast(a, b) {
    const ca = parseColor(a), cb = parseColor(b);
    if (!ca || !cb || ca[3] < 0.5) return 0;
    const la = luminance(ca), lb = luminance(cb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function hostOrigin() {
    if (!host) return { left: 0, top: 0 };
    const r = host.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  /* مستطیل عناصر شناور مات (هدر ثابت، مودال، منو) — با کش کوتاه‌مدت */
  function occluderRects() {
    const out = [];
    const now = performance.now();
    for (const el of occluders) {
      if (!el.isConnected) { occluders.delete(el); continue; }
      const cached = occCache.get(el);
      if (cached && now - cached.at < 120) {
        if (cached.info) out.push(cached.info);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10 || r.bottom < 0 || r.top > window.innerHeight) {
        occCache.set(el, { at: now, info: null });
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.2) {
        occCache.set(el, { at: now, info: null });
        continue;
      }
      const bg = parseColor(cs.backgroundColor);
      const opaque = (bg && bg[3] > 0.3) || cs.backgroundImage !== 'none' || (cs.backdropFilter && cs.backdropFilter !== 'none');
      if (!opaque) { occCache.set(el, { at: now, info: null }); continue; }
      const info = { el, r, z: parseInt(cs.zIndex, 10) || 0, fixed: cs.position === 'fixed' || cs.position === 'sticky' };
      occCache.set(el, { at: now, info });
      out.push(info);
    }
    return out;
  }

  function measure(item, occ, checkVis) {
    let rect;
    if (item.type === 'text') {
      if (item.nodes ? item.nodes.some((n) => !n.isConnected) : !item.el.isConnected) return { remove: true };
      rect = textRect(item);
    } else {
      if (!item.el.isConnected) return { remove: true };
      rect = imageBlockRect(item);
    }
    if (!rect || rect.width < 2 || rect.height < 3) return { rect, hidden: true };
    if (checkVis) {
      const a = ancInfo(item.nodes ? item.nodes[0].parentElement : item.el);
      if (a.transparent) return { rect, hidden: true };
    }
    let cl = rect.left, ct = rect.top, cr = rect.right, cb = rect.bottom;
    for (const c of item.clips) {
      if (!c.isConnected) continue;
      const r = c.getBoundingClientRect();
      const left = r.left + c.clientLeft, top = r.top + c.clientTop;
      const right = c.clientWidth ? left + c.clientWidth : r.right;
      const bottom = c.clientHeight ? top + c.clientHeight : r.bottom;
      cl = Math.max(cl, left); ct = Math.max(ct, top); cr = Math.min(cr, right); cb = Math.min(cb, bottom);
    }
    if (item.selfClip) {
      const s = item.selfClip;
      cl = Math.max(cl, s.left); ct = Math.max(ct, s.top); cr = Math.min(cr, s.right); cb = Math.min(cb, s.bottom);
    }
    /* بخش‌هایی از متن که زیر هدر ثابت/مودال/منو رفته‌اند از کادر ترجمه هم بریده می‌شوند */
    if (occ && occ.length && cr > cl && cb > ct) {
      for (const o of occ) {
        if (o.el === item.el || o.el.contains(item.el) || item.el.contains(o.el)) continue;
        if (o.z < 0) continue;
        const R = o.r;
        if (R.right <= cl || R.left >= cr || R.bottom <= ct || R.top >= cb) continue;
        const px = (Math.max(R.left, cl) + Math.min(R.right, cr)) / 2;
        const py = (Math.max(R.top, ct) + Math.min(R.bottom, cb)) / 2;
        if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) {
          if (!o.fixed) continue;
        } else {
          const hit = document.elementFromPoint(px, py);
          if (!hit || !(hit === o.el || o.el.contains(hit))) continue;
        }
        const spanH = R.left <= cl + 1 && R.right >= cr - 1;
        const spanV = R.top <= ct + 1 && R.bottom >= cb - 1;
        if (spanH && spanV) { cb = ct; break; }
        if (spanH) { if (R.top <= ct + 1) ct = Math.max(ct, Math.floor(R.bottom)); else cb = Math.min(cb, Math.ceil(R.top)); }
        else if (spanV) { if (R.left <= cl + 1) cl = Math.max(cl, Math.floor(R.right)); else cr = Math.min(cr, Math.ceil(R.left)); }
        else {
          const ia = (Math.min(R.right, cr) - Math.max(R.left, cl)) * (Math.min(R.bottom, cb) - Math.max(R.top, ct));
          if (ia > 0.4 * (cr - cl) * (cb - ct)) { cb = ct; break; }
        }
      }
    }
    if (cr - cl < 2 || cb - ct < 2) return { rect, hidden: true };
    return { rect, clip: { cl, ct, cr, cb } };
  }

  function apply(item, m, origin) {
    if (m.remove) { removeItem(item); return; }
    item.rect = m.rect;
    item.needsRender = false;
    if (!item.ov) return;
    if (m.hidden) { item.ov.classList.add('hidden'); return; }
    item.ov.classList.remove('hidden');
    const rect = m.rect, clip = m.clip;
    const ox = item.fixed ? 0 : origin.left;
    const oy = item.fixed ? 0 : origin.top;
    const st = item.ov.style;
    st.left = (rect.left - ox) + 'px';
    st.top = (rect.top - oy) + 'px';
    const w = Math.round(rect.width * 10) / 10, h = Math.round(rect.height * 10) / 10;
    if (item.w == null || Math.abs(item.w - w) > 0.5 || Math.abs(item.h - h) > 0.5) {
      st.width = w + 'px';
      st.height = h + 'px';
      item.w = w; item.h = h;
      item.needsFit = true;
    }
    const clipped = clip && (clip.cl > rect.left + 0.5 || clip.ct > rect.top + 0.5 || clip.cr < rect.right - 0.5 || clip.cb < rect.bottom - 0.5);
    const cp = clipped ? `inset(${clip.ct - rect.top}px ${rect.right - clip.cr}px ${rect.bottom - clip.cb}px ${clip.cl - rect.left}px)` : '';
    if (st.clipPath !== cp) st.clipPath = cp;
    const sy = item.fixed ? 0 : window.scrollY;
    item.docTop = rect.top + sy;
    item.docBottom = rect.bottom + sy;
  }

  /* اندازه‌ی فونت را طوری تنظیم می‌کند که ترجمه در کادر متن اصلی جا شود */
  function fit(item) {
    if (!item.ov || !item.span || item.removed) return;
    item.needsFit = false;
    const sp = item.span;
    const boxH = item.h, boxW = item.w;
    if (!boxH || !boxW) return;
    const key = boxW + 'x' + boxH + '|' + (item.translation || '').length;
    if (item.fitKey === key && item.fitOk) return;
    const maxFs = item.type === 'image'
      ? Math.max(6, Math.min((item.lineHeightPx || 14) * 0.85, boxH * 0.92))
      : Math.max(6, (item.font && item.font.size ? item.font.size : 16) * ptClamp(settings.fontScale, 50, 200, 100) / 100);
    const fits = (fs) => {
      sp.style.fontSize = fs + 'px';
      return sp.scrollHeight <= boxH + 1 && sp.scrollWidth <= sp.clientWidth + 1;
    };
    item.fitKey = key;
    if (fits(maxFs)) { item.fitOk = true; return; }
    const ratio = Math.sqrt(boxH / Math.max(1, sp.scrollHeight));
    const guess = Math.max(5, maxFs * ratio);
    let lo, hi;
    if (fits(guess)) { lo = guess; hi = maxFs; } else { lo = 5; hi = guess; }
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    sp.style.fontSize = lo + 'px';
    item.fitOk = true;
  }

  function removeItem(item) {
    if (item.removed) return;
    item.removed = true;
    if (item.ov) { if (intersectObs) intersectObs.unobserve(item.ov); item.ov.remove(); }
    if (item.nodes) item.nodes.forEach((n) => { processedText.delete(n); nodeItems.delete(n); });
    const i = items.indexOf(item);
    if (i >= 0) items.splice(i, 1);
  }

  /* ============================ به‌روزرسانی موقعیت‌ها ============================ */
  function relayoutNear(radiusViewports) {
    if (!active) return;
    const y = window.scrollY, vh = window.innerHeight;
    const rad = (radiusViewports || 1.2) * vh;
    let n = 0;
    for (const it of items) {
      if (it.docTop == null) { if (n++ < 400) refreshItemRect(it); continue; }
      if (it.docBottom < y - rad || it.docTop > y + vh + rad) continue;
      if (n++ > 600) break;
      refreshItemRect(it);
    }
    needsNearRelayout = true;
  }

  function refreshItemRect(item) {
    if (item.kind === 'attr') return;
    if (item.type === 'text' && item.nodes && item.nodes.some((n) => !n.isConnected)) return;
    if (item.type !== 'text' && !item.el.isConnected) return;
    const r = item.type === 'image' ? imageBlockRect(item) : textRect(item);
    if (r) { item.rect = r; setDocPos(item); }
  }

  function scheduleRelayout(delay) {
    if (relayoutTimer) return;
    relayoutTimer = setTimeout(() => {
      relayoutTimer = null;
      if (!active) return;
      relayoutNear(1.5);
      renderNow();
    }, delay == null ? 220 : delay);
  }

  /* ============================ تصاویر (OCR) ============================ */
  function considerImage(el, isBg, cs) {
    if (!settings.translateImages || !active) return;
    let src;
    if (isBg) {
      const m = (cs || getComputedStyle(el)).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (!m || !m[1]) return;
      src = m[1];
    } else {
      src = el.currentSrc || el.src;
      if (!src) return;
      if (!el.complete || !el.naturalWidth) {
        if (!el.__ptLoadHook) {
          el.__ptLoadHook = true;
          el.addEventListener('load', () => {
            el.__ptLoadHook = false;
            if (active) { considerImage(el, false); pumpImages(); }
          }, { once: true });
        }
        return;
      }
      if (el.naturalWidth < 24 || el.naturalHeight < 10) return;
    }
    if (processedImages.get(el) === src) return;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 12) { if (isBg) bgCandidates.add(el); return; }
    if (isView() && !rectInView(r)) { if (isBg) bgCandidates.add(el); return; }
    if (settings.ocrVisibleOnly && !rectInView(r)) {
      if (isBg) bgCandidates.add(el);
      imageQueue.push({ el, src, isBg, mode: 'fetch' });
      stats.imgTotal++;
      processedImages.set(el, src);
      return;
    }
    bgCandidates.delete(el);
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return;
    processedImages.set(el, src);
    imageQueue.push({ el, src, isBg, mode: 'fetch' });
    stats.imgTotal++;
  }

  function considerCanvas(el) {
    if (!settings.translateImages || !active) return;
    if (processedImages.has(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 30) return;
    if (isView() && !rectInView(r)) { canvasCandidates.add(el); return; }
    if (settings.ocrVisibleOnly && !rectInView(r)) return;
    canvasCandidates.delete(el);
    processedImages.set(el, 'canvas');
    imageQueue.push({ el, src: 'canvas', isBg: false, mode: 'capture' });
    stats.imgTotal++;
  }

  function imgDistance(el) {
    if (!el.isConnected) return 1e9;
    const now = performance.now();
    const c = imgRectCache.get(el);
    if (c && now - c.at < 250) return c.dist;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    let dist = 0;
    if (r.bottom < 0) dist = -r.bottom;
    else if (r.top > vh) dist = r.top - vh;
    imgRectCache.set(el, { at: now, dist });
    return dist;
  }

  function captureReady(el) {
    if (document.hidden) return false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 20 || h <= 12) return false;
    return (w * h) / (r.width * r.height) > 0.85 || h > vh * 0.8;
  }

  function pumpImages() {
    if (!active || !settings.translateImages) return;
    const now = performance.now();
    if (now - lastImagePump < 120 && imageActive) return;
    lastImagePump = now;
    const parallel = Math.max(1, Math.min(4, settings.ocrParallel || 2));
    const lim = prioritizeView() ? viewMargin() : Infinity;
    let progressed = true;
    while (progressed && imageActive < parallel && imageQueue.length) {
      progressed = false;
      imageQueue.forEach((q) => { q.dist = imgDistance(q.el); });
      imageQueue.sort((a, b) => a.dist - b.dist);
      const idx = imageQueue.findIndex((j) => {
        if (!j.el.isConnected) return true;
        if (j.mode === 'fetch' && j.dist <= lim) return true;
        if (j.mode === 'capture' && !captureBusy && j.dist === 0 && captureReady(j.el)) return true;
        return false;
      });
      if (idx < 0) break;
      const job = imageQueue.splice(idx, 1)[0];
      if (!job.el.isConnected) { stats.imgDone++; progressed = true; continue; }
      imageActive++;
      progressed = true;
      runImageJob(job);
    }
    updateToast();
  }

  async function runImageJob(job) {
    const mySession = session;
    let requeued = false;
    try {
      if (job.mode === 'capture') await processCapture(job, mySession);
      else requeued = await processImage(job, mySession);
    } catch (e) {
      if (settings.diagnostics) console.debug('[Page Translator] OCR failed:', job.src, e);
    } finally {
      /* اسلات همیشه آزاد می‌شود؛ حتی اگر نشست عوض شده باشد یا خطای غیرمنتظره رخ دهد.
         در غیر این صورت با چند خطا، صف تصاویر برای همیشه می‌ایستد. */
      imageActive = Math.max(0, imageActive - 1);
    }
    if (mySession !== session) return;
    if (!requeued) stats.imgDone++;
    pumpImages();
  }

  function ocrLang() {
    return ptOcrLangFor ? ptOcrLangFor(settings) : (settings.ocrLang !== 'auto' ? settings.ocrLang : (PT_OCR_LANGS[settings.sourceLang] || 'eng'));
  }

  /* حالت عادی: دانلود تصویر و OCR؛ اگر نشد → اسکرین‌شات (true = دوباره در صف) */
  async function processImage(job, mySession) {
    const { src } = job;
    const ms = ocrTimeoutMs();
    let msg = { type: 'ocr', lang: ocrLang(), minConf: settings.ocrMinConfidence, quick: isView() };
    let res = null;
    try {
      if (src.startsWith('data:')) msg.dataUrl = src;
      else if (src.startsWith('blob:')) msg.dataUrl = await urlToDataUrl(src);
      else msg.src = src;
      res = await sendTimed(msg, ms);
      if ((!res || !res.ok) && msg.src) {
        msg = Object.assign({}, msg, { src: undefined, dataUrl: await urlToDataUrl(src) });
        res = await sendTimed(msg, ms);
      }
    } catch (e) { res = null; }
    if (mySession !== session) return false;
    if (!res || !res.ok) {
      if (job.isBg || job.captureDone) { countImageFail(job, res); return false; }
      job.mode = 'capture';
      imageQueue.push(job);
      return true;
    }
    addImageBlocks(job, res, null);
    return false;
  }

  /* شمارش عکس‌هایی که خوانده نشدند تا کاربر بداند چرا ترجمه نشدند */
  function countImageFail(job, res) {
    if (job.failed) return;
    job.failed = true;
    stats.imgFail++;
    if (settings.diagnostics) {
      console.debug('[Page Translator] image not OCR-ed:', job.src, (res && res.error) || 'no result');
    }
    updateToast();
  }

  async function processCapture(job, mySession) {
    const el = job.el;
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    const vis = {
      left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, r.bottom)
    };
    if (vis.right - vis.left < 20 || vis.bottom - vis.top < 12) return;
    captureBusy = true;
    const hiddenOvs = [];
    try {
      for (const it of items) {
        const q = it.rect;
        if (it.ov && q && q.right > vis.left && q.left < vis.right && q.bottom > vis.top && q.top < vis.bottom) {
          it.ov.classList.add('capturing'); hiddenOvs.push(it.ov);
        }
      }
      if (toast) toast.classList.add('capturing');
      await new Promise((res) => {
        setTimeout(res, 250);
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 30)));
      });
      if (document.hidden) { imageQueue.push(job); return; }
      const dpr = window.devicePixelRatio || 1;
      const res = await sendTimed({
        type: 'capture-ocr', lang: ocrLang(), minConf: settings.ocrMinConfidence, quick: isView(),
        crop: { x: vis.left * dpr, y: vis.top * dpr, w: (vis.right - vis.left) * dpr, h: (vis.bottom - vis.top) * dpr }
      }, ocrTimeoutMs());
      if (mySession !== session) return;
      if (!res || !res.ok || !res.blocks) { job.captureDone = true; countImageFail(job, res); return; }
      const offX = vis.left - r.left, offY = vis.top - r.top;
      res.blocks.forEach((b) => {
        b.bbox = { x0: b.bbox.x0 / dpr + offX, y0: b.bbox.y0 / dpr + offY, x1: b.bbox.x1 / dpr + offX, y1: b.bbox.y1 / dpr + offY };
        b.lineHeight /= dpr;
      });
      addImageBlocks(job, res, { w: r.width, h: r.height });
    } finally {
      /* کادرهای پنهان‌شده و قفل اسکرین‌شات همیشه آزاد می‌شوند؛
         وگرنه یک درخواست گیرکرده، خواندن بقیه‌ی عکس‌ها را برای همیشه می‌خواباند. */
      hiddenOvs.forEach((o) => o.classList.remove('capturing'));
      if (toast) toast.classList.remove('capturing');
      captureBusy = false;
    }
  }

  function addImageBlocks(job, res, capture) {
    if (!res.blocks || !res.blocks.length) return;
    const created = [];
    const anc = ancInfo(job.el);
    for (const b of res.blocks) {
      const item = Object.assign({
        type: 'image', el: job.el, isBg: job.isBg, capture,
        natW: res.width, natH: res.height, bbox: b.bbox,
        lineHeight: b.lineHeight, lineHeightPx: b.lineHeight, text: b.text, bg: b.bg, fg: b.fg,
        font: { size: 16, family: '', weight: '600', style: 'normal', color: b.fg, align: 'center' }
      }, anc);
      item.rect = imageBlockRect(item);
      setDocPos(item);
      items.push(item);
      created.push(item);
    }
    created.forEach((it) => queueTranslate(it));
    pumpTranslations();
  }

  function urlToDataUrl(url) {
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then((blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    }));
  }

  /* نگاشت مختصات OCR به مختصات صفحه (با پشتیبانی object-fit و background-size) */
  function imageBlockRect(item) {
    const el = item.el;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    let sx, sy, ox, oy;

    if (item.capture) {
      sx = r.width / item.capture.w; sy = r.height / item.capture.h;
      ox = r.left; oy = r.top;
      item.selfClip = r;
    } else {
      const cs = getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
      const nw = item.natW, nh = item.natH;
      let box;
      if (!item.isBg) {
        const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
        const pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
        box = { left: r.left + bl + pl, top: r.top + bt + pt, right: r.right - br - pr, bottom: r.bottom - bb - pb };
        const bw = box.right - box.left, bh = box.bottom - box.top;
        const fitMode = cs.objectFit || 'fill';
        if (fitMode === 'fill') { sx = bw / nw; sy = bh / nh; }
        else {
          let s;
          if (fitMode === 'contain') s = Math.min(bw / nw, bh / nh);
          else if (fitMode === 'cover') s = Math.max(bw / nw, bh / nh);
          else if (fitMode === 'none') s = 1;
          else s = Math.min(1, Math.min(bw / nw, bh / nh));
          sx = sy = s;
        }
        const pos = parsePosition(cs.objectPosition || '50% 50%', 0.5);
        ox = box.left + (bw - nw * sx) * pos[0];
        oy = box.top + (bh - nh * sy) * pos[1];
      } else {
        box = { left: r.left + bl, top: r.top + bt, right: r.right - br, bottom: r.bottom - bb };
        const bw = box.right - box.left, bh = box.bottom - box.top;
        const size = (cs.backgroundSize || 'auto').split(',')[0].trim();
        if (size === 'cover') sx = sy = Math.max(bw / nw, bh / nh);
        else if (size === 'contain') sx = sy = Math.min(bw / nw, bh / nh);
        else if (size === 'auto' || size === 'auto auto') sx = sy = 1;
        else {
          const parts = size.split(/\s+/);
          const dim = (v, total) => (v == null || v === 'auto') ? null : (v.endsWith('%') ? total * parseFloat(v) / 100 : parseFloat(v));
          let w = dim(parts[0], bw), h = dim(parts[1], bh);
          if (w == null && h == null) { w = nw; h = nh; }
          else if (w == null) w = h * nw / nh;
          else if (h == null) h = w * nh / nw;
          sx = w / nw; sy = h / nh;
        }
        const pos = parsePosition((cs.backgroundPosition || '0% 0%').split(',')[0], 0);
        ox = box.left + (bw - nw * sx) * pos[0];
        oy = box.top + (bh - nh * sy) * pos[1];
      }
      item.selfClip = box;
    }
    item.lineHeightPx = item.lineHeight * sy;
    const pad = Math.max(2, item.lineHeightPx * 0.15);
    const left = ox + item.bbox.x0 * sx - pad;
    const top = oy + item.bbox.y0 * sy - pad;
    const right = ox + item.bbox.x1 * sx + pad;
    const bottom = oy + item.bbox.y1 * sy + pad;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function parsePosition(str, def) {
    const map = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
    const parts = String(str).trim().split(/\s+/);
    const val = (p) => {
      if (p == null) return 0.5;
      if (p in map) return map[p];
      if (p.endsWith('%')) return parseFloat(p) / 100;
      return def;
    };
    let x = val(parts[0]), y = val(parts[1]);
    if (parts[0] === 'top' || parts[0] === 'bottom') { const t = x; x = val(parts[1]); y = t; }
    return [x, y];
  }

  /* ============================ ناظرها ============================ */
  function startObservers() {
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', () => scheduleRelayout(150), { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scheduleRelayout(200));

    resizeObs = new ResizeObserver(() => scheduleRelayout(260));
    resizeObs.observe(document.documentElement);
    if (document.body) resizeObs.observe(document.body);

    intersectObs = new IntersectionObserver((entries) => {
      let any = false;
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const it = ovMap.get(en.target);
        if (it && it.needsFit) { fit(it); any = true; }
      }
      if (!any) return;
    }, { rootMargin: '100% 0px 100% 0px' });

    mutationObs = new MutationObserver(onMutations);
    mutationObs.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'src', 'srcset', 'aria-expanded', 'aria-hidden', 'value', 'placeholder']
    });

    const interval = ptClamp(settings.relayoutInterval, 200, 5000, 700);
    tickTimer = setInterval(tick, interval);
    keepAlive = setInterval(() => { if (active) sendMessage({ type: 'ping' }).catch(() => {}); }, 20000);
  }

  function tick() {
    if (!active) return;
    tickCount++;
    if (document.hidden) return;                   // تب پنهان: کار سنگین نکن
    if (isView()) {
      checkDeferred();
      retryHidden();
      if (settings.translateImages) { sweepImages(); pumpImages(); }
      pumpTranslations();
    } else {
      if (tickCount % 2 === 0) retryHidden();
      if (settings.translateImages && tickCount % 3 === 0) { sweepImages(); pumpImages(); }
      pumpTranslations();
    }
    if (ancDirty) { ancCache = new WeakMap(); ancDirty = false; }
    if (needsNearRelayout || tickCount % 3 === 0) {
      relayoutNear(1.2);
      renderNow();
      if (tickCount % 2 === 0) syncVisibility();
    }
    updateRate();
    updateToast();
  }

  /* متن اصلی که نامرئی شده (اسلاید بسته، تب مخفی، انیمیشن محو) → کادر ترجمه هم پنهان شود */
  function syncVisibility() {
    let n = 0;
    for (const it of items) {
      if (!it.ov || n > 800) continue;
      if (!isNearRender(it)) continue;
      n++;
      const el = it.nodes ? it.nodes[0].parentElement : it.el;
      if (!el) continue;
      const hidden = ancInfo(el).transparent;
      it.ov.classList.toggle('hidden', !!hidden);
    }
  }

  function updateRate() {
    const now = Date.now();
    if (now - lastRateAt < 900) return;
    const done = stats.textDone + stats.imgDone;
    lastRate = Math.max(0, Math.round((done - lastDoneCount) / ((now - lastRateAt) / 1000)));
    lastDoneCount = done;
    lastRateAt = now;
  }

  function checkDeferred() {
    if (!deferredBlocks.size) return;
    let added = false;
    for (const el of deferredBlocks) {
      if (!el.isConnected) { deferredBlocks.delete(el); continue; }
      if (!blockOutOfView(el)) { deferredBlocks.delete(el); blockQueue.push(el); added = true; }
    }
    if (added) runScan();
  }

  function sweepImages() {
    if (!settings.translateImages) return;
    let n = 0;
    for (const img of document.images) {
      if (processedImages.get(img) === (img.currentSrc || img.src)) continue;
      if (n++ > 400) break;
      considerImage(img, false);
    }
    for (const el of bgCandidates) {
      if (!el.isConnected) { bgCandidates.delete(el); continue; }
      considerImage(el, true);
    }
    for (const el of canvasCandidates) {
      if (!el.isConnected) { canvasCandidates.delete(el); continue; }
      considerCanvas(el);
    }
  }

  function stopObservers() {
    window.removeEventListener('scroll', onScroll, { capture: true });
    if (resizeObs) resizeObs.disconnect();
    if (intersectObs) intersectObs.disconnect();
    if (mutationObs) mutationObs.disconnect();
    clearInterval(tickTimer);
    clearInterval(keepAlive);
    clearTimeout(mutationTimer);
    clearTimeout(relayoutTimer);
    clearTimeout(scrollEndTimer);
    if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
    mutationTimer = relayoutTimer = scrollEndTimer = null;
    tickTimer = keepAlive = null;
    resizeObs = intersectObs = mutationObs = null;
  }

  function onScroll(e) {
    if (!active) return;
    const isWindowScroll = e.target === document || e.target === document.documentElement ||
      e.target === document.scrollingElement || e.target === document.body;
    if (!isWindowScroll) {
      /* اسکرول داخلی (لیست، چت، منو): عناصر داخل همان کادر باید جابه‌جا شوند */
      needsNearRelayout = true;
      clearTimeout(scrollEndTimer);
      scrollEndTimer = setTimeout(() => {
        if (!active) return;
        relayoutNear(1.2);
        renderNow();
        if (isView()) { checkDeferred(); pumpTranslations(); }
      }, 120);
      scheduleRender();
      return;
    }
    /* اسکرول پنجره: کادرهای absolute خودشان با سند حرکت می‌کنند؛ فقط عناصر شناور
       و برش‌ها نیاز به به‌روزرسانی دارند → تقریباً هیچ خواندن DOM در هر فریم */
    if (!scrollRaf) {
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (!active) return;
        needsNearRelayout = needsNearRelayout || true;
        renderNow();
        pumpTranslations();
        if (isView()) checkDeferred();
        if (imageQueue.length) pumpImages();
      });
    }
    clearTimeout(scrollEndTimer);
    scrollEndTimer = setTimeout(() => {
      if (!active) return;
      relayoutNear(1.2);
      renderNow();
      retryHidden();
      if (isView()) { checkDeferred(); pumpTranslations(); }
      if (imageQueue.length) pumpImages();
    }, 130);
  }

  function onMutations(muts) {
    let pendingAdded = false;
    for (const m of muts) {
      if (m.target === host) continue;
      if (m.type === 'characterData') {
        const node = m.target;
        const it = nodeItems.get(node);
        if (it) {
          const newText = it.nodes.map((n) => n.nodeValue).join('').replace(/\s+/g, ' ').trim();
          if (newText !== it.text) { removeItem(it); pendingRoots.add(node.parentElement); pendingAdded = true; }
        } else if (node.parentElement) { pendingRoots.add(node.parentElement); pendingAdded = true; }
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n === host) return;
          if (n.nodeType === 1 && n !== toast) { pendingRoots.add(n); pendingAdded = true; }
          else if (n.nodeType === 3 && n.parentElement) { pendingRoots.add(n.parentElement); pendingAdded = true; }
        });
      } else if (m.type === 'attributes') {
        const t = m.target;
        if (t.tagName === 'IMG' && (m.attributeName === 'src' || m.attributeName === 'srcset')) {
          items.filter((x) => x.type === 'image' && x.el === t).forEach(removeItem);
          processedImages.delete(t);
        }
        if (m.attributeName === 'value' && t.tagName === 'INPUT') {
          if (attrTouched.has(t)) continue;
          items.filter((x) => x.kind === 'widget' && x.el === t).forEach(removeItem);
          processedEls.delete(t);
        }
        if (m.attributeName === 'placeholder' && attrTouched.has(t)) continue;
        if (m.attributeName === 'class' || m.attributeName === 'style' || m.attributeName === 'hidden') ancDirty = true;
        pendingRoots.add(t);
      }
    }
    skipCache = new WeakMap();
    needsNearRelayout = true;
    if (pendingAdded && relayoutTimer == null) scheduleRelayout(260);
    if (!settings.dynamicContent || !pendingRoots.size) return;
    if (!mutationTimer) mutationTimer = setTimeout(() => { mutationTimer = null; processPendingRoots(); }, 250);
  }

  function processPendingRoots() {
    if (!active) return;
    const roots = [...pendingRoots].filter((r) => r && r.isConnected);
    pendingRoots.clear();
    const unique = roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)));
    for (const r of unique.slice(0, 200)) {
      try { enqueueScan(r); } catch (e) { /* ignore */ }
    }
  }

  /* ============================ پیام وضعیت ============================ */
  let toastHideTimer = null;
  function showToast(html, hideAfter) {
    if (!toast) return;
    toast.innerHTML = html;
    toast.classList.remove('fade');
    clearTimeout(toastHideTimer);
    if (hideAfter) toastHideTimer = setTimeout(() => { if (toast) toast.classList.add('fade'); }, hideAfter);
  }

  let lastToastHtml = '';
  function updateToast() {
    if (!toast || errorShown || !settings.toastEnabled) return;
    const view = isView();
    const lim = viewMargin();
    const waitingCapture = imageQueue.filter((j) => j.mode === 'capture').length;
    const imgPending = imageActive > 0;
    const visiblePending = prioritizeView() && pending.some((it) => (it._d != null ? it._d : distanceOf(it)) <= lim);
    const busy = (!view && scanning) || stats.textDone < stats.textTotal || imgPending || visiblePending || inflight > 0;
    const rateTxt = busy && lastRate > 0 ? ` · <b>${lastRate}</b> متن/ثانیه` : '';
    let html = (view ? '⚡ صفحه‌ی فعلی — ' : settings.scope === 'auto' ? '⚡ هوشمند — ' : '') +
      `متن‌ها: <b>${stats.textDone}/${stats.textTotal}</b>${rateTxt}`;
    if (settings.translateImages) {
      html += ` &nbsp;|&nbsp; تصاویر: <b>${stats.imgDone}/${stats.imgTotal}</b>`;
      if (stats.imgFail) html += ` <small>(${stats.imgFail} خطا)</small>`;
    }
    if (stats.textSkipped) html += ` &nbsp;|&nbsp; هم‌زبان مقصد: ${stats.textSkipped}`;
    if (waitingCapture && !busy) html += `<small>${waitingCapture} تصویر محافظت‌شده با اسکرول خوانده می‌شود</small>`;
    if (prioritizeView() && !busy) html += '<small>با اسکرول، بخش‌های جدید خودکار ترجمه می‌شوند</small>';
    const full = (busy ? '⏳ ' : '✅ ') + html;
    if (full === lastToastHtml && !busy) return;
    lastToastHtml = full;
    if (busy) showToast(full);
    else showToast(full, 2500);
  }
})();
