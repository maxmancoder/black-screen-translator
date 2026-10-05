/* =========================================================================
   offscreen.js — تشخیص متن داخل تصاویر با Tesseract.js
   نسخه‌ی ۲.۱ — سریع‌تر:
     • رد کردن سریع تصاویر بی‌متن (یک‌رنگ) قبل از OCR
     • پاس‌های تطبیقی: psm 11 و تصویر معکوس فقط وقتی لازم است
     • کوچک‌کردن تصاویر بزرگ بر اساس تنظیمات (پیش‌فرض ۱۸۰۰px)
     • رمزگشایی سریع‌تر با createImageBitmap + معکوس‌سازی با فیلتر canvas
     • مدیریت Worker‌ها: استفاده‌ی مجدد، آزادسازی حافظه و گزارش زمان
   ========================================================================= */
/* global Tesseract */
const pools = new Map();      // lang|quality -> { workers: [], idle: [], waiting: [], creating: 0, last: 0 }
const ocrCache = new Map();   // cacheKey -> result
const RTL_OCR = ['ara', 'fas', 'heb', 'urd', 'pus', 'ckb', 'uig', 'snd', 'yid'];
let liveWorkers = 0;
let cacheLimit = 400;

function workerOptions(lang, quality) {
  const opts = {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core'),
    workerBlobURL: false,
    cacheMethod: 'write',
    cachePath: 'pt-' + quality,
    errorHandler: (e) => console.warn('[PT/OCR] worker error:', e)
  };
  if (quality === 'fast') {
    opts.langPath = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main';
    opts.gzip = false;
  } else if (lang === 'eng') {
    opts.langPath = chrome.runtime.getURL('lib/lang');   // مدل انگلیسی داخل افزونه
  } else {
    opts.langPath = 'https://tessdata.projectnaptha.com/4.0.0';
  }
  return opts;
}

async function createWorker(lang, quality) {
  const w = await Tesseract.createWorker(lang, 1, workerOptions(lang, quality));
  await w.setParameters({ preserve_interword_spaces: '1' });
  liveWorkers++;
  return w;
}

async function terminateWorker(w) {
  if (!w || w.__ptDead) return;
  w.__ptDead = true;
  liveWorkers = Math.max(0, liveWorkers - 1);
  try { await w.terminate(); } catch (e) { /* ignore */ }
}

/* بیرون‌کردن worker از پول؛ وگرنه worker مرده «ظرفیت پر» نشان می‌دهد و
   درخواست‌های بعدی آن زبان برای همیشه در صف انتظار می‌مانند. */
function dropWorker(pool, w) {
  if (!pool || !w) return;
  let i = pool.workers.indexOf(w);
  if (i >= 0) pool.workers.splice(i, 1);
  i = pool.idle.indexOf(w);
  if (i >= 0) pool.idle.splice(i, 1);
}

function aliveWorkers(pool) { return pool.workers.filter((w) => w && !w.__ptDead); }

/* اگر ساخت worker شکست و worker زنده‌ای نماند، منتظرها هرگز آزاد نمی‌شوند */
function wakeWaiters(pool, err) {
  const list = pool.waiting.splice(0, pool.waiting.length);
  for (const w of list) { try { w.reject(err); } catch (e) { /* ignore */ } }
}

function withTimeout(p, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error('مهلت OCR تمام شد'));
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* آزادسازی حافظه: Worker‌های بی‌کار اضافی و پول‌های قدیمی بسته می‌شوند */
function trimPools(keepKey) {
  const maxLive = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const kill = (pool) => { const w = pool.idle.pop(); dropWorker(pool, w); terminateWorker(w); };
  for (const [key, pool] of pools) {
    if (key === keepKey) continue;
    while (pool.idle.length > 1) kill(pool);
    if (!aliveWorkers(pool).length && !pool.creating && !pool.waiting.length) pools.delete(key);
  }
  if (liveWorkers > maxLive) {
    const sorted = [...pools.entries()]
      .filter(([k, p]) => k !== keepKey && p.idle.length)
      .sort((a, b) => (a[1].last || 0) - (b[1].last || 0));
    for (const [, pool] of sorted) {
      while (liveWorkers > maxLive && pool.idle.length) kill(pool);
    }
  }
}

async function acquire(lang, quality, parallel) {
  const key = lang + '|' + quality;
  let pool = pools.get(key);
  if (!pool) { pool = { workers: [], idle: [], waiting: [], creating: 0, last: 0 }; pools.set(key, pool); }
  pool.last = Date.now();
  /* workerهای مرده ظرفیت حساب نشوند، وگرنه پول همیشه «پر» به نظر می‌رسد */
  pool.workers = aliveWorkers(pool);
  pool.idle = pool.idle.filter((w) => w && !w.__ptDead);
  if (pool.idle.length) return { pool, worker: pool.idle.pop() };
  const max = Math.max(1, Math.min(parallel || 2, 4, (navigator.hardwareConcurrency || 4) - 1));
  if (pool.workers.length + pool.creating < max) {
    pool.creating++;
    let made = false;
    try {
      const w = await createWorker(lang, quality);
      pool.workers.push(w);
      made = true;
      trimPools(key);
      return { pool, worker: w };
    } finally {
      pool.creating--;
      /* ساخت worker شکست و worker زنده‌ای نمانده → منتظرها را با خطا برگردان
         تا هیچ درخواست OCR بی‌پاسخ (و برای همیشه گیرکرده) نماند */
      if (!made && !pool.creating && !aliveWorkers(pool).length) {
        wakeWaiters(pool, new Error('ساخت worker OCR ناموفق بود'));
      }
    }
  }
  return new Promise((resolve, reject) => pool.waiting.push({ resolve, reject }))
    .then((worker) => ({ pool, worker }));
}

function release(pool, worker) {
  if (!worker || worker.__ptDead) { dropWorker(pool, worker); return; }
  const next = pool.waiting.shift();
  if (next) next.resolve(worker);
  else pool.idle.push(worker);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.cacheLimit) cacheLimit = msg.cacheLimit;
  if (msg.type === 'ocr-warmup') {
    acquire(msg.lang || 'eng', msg.quality || 'best', msg.parallel)
      .then(({ pool, worker }) => { release(pool, worker); sendResponse({ ok: true }); })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type !== 'ocr') return false;
  doOcr(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function loadBlob(msg) {
  if (msg.dataUrl) return (await fetch(msg.dataUrl)).blob();
  let res;
  try { res = await fetch(msg.src, { credentials: 'include' }); } catch (e) { res = await fetch(msg.src); }
  if (!res.ok) throw new Error('دانلود تصویر ناموفق بود: HTTP ' + res.status);
  return res.blob();
}

/* رمزگشایی سریع تصویر (createImageBitmap در دسترس است) */
async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
    } catch (e) { /* سراغ روش قدیمی می‌رویم */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('تصویر قابل خواندن نیست'));
      im.src = url;
    });
    return { img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/* تصویر تقریباً یک‌رنگ = بدون متن → OCR لازم نیست */
function looksTextless(pixels) {
  const d = pixels.data;
  let n = 0, sum = 0, sum2 = 0, min = 255, max = 0;
  const step = Math.max(4, Math.floor(Math.sqrt(pixels.width * pixels.height) / 48)) * 4;
  for (let i = 0; i < d.length; i += step) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    n++; sum += g; sum2 += g * g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  if (!n) return true;
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  const contrast = max - min;
  return contrast < 20 || variance < 12;
}

async function doOcr(msg) {
  const t0 = Date.now();
  const quality = msg.quality || 'best';
  const maxDim = msg.maxDim || 1800;
  const cacheKey = msg.noCache ? null : [msg.src || ('data:' + (msg.dataUrl || '').length + (msg.dataUrl || '').slice(-80)),
    msg.lang, msg.minConf, quality, msg.invert, !!msg.quick, maxDim].join('|');
  if (cacheKey && ocrCache.has(cacheKey)) {
    const hit = ocrCache.get(cacheKey);
    return Object.assign({}, hit, { cached: true, ms: 0 });
  }

  const blob = await loadBlob(msg);
  const dec = await decodeImage(blob);
  let canvas, ctx, natW, natH, scale;
  let pixels = null;
  try {
    const crop = msg.crop
      ? { x: Math.max(0, msg.crop.x), y: Math.max(0, msg.crop.y), w: msg.crop.w, h: msg.crop.h }
      : { x: 0, y: 0, w: dec.w, h: dec.h };
    crop.w = Math.min(crop.w, dec.w - crop.x);
    crop.h = Math.min(crop.h, dec.h - crop.y);
    natW = crop.w; natH = crop.h;
    if (!natW || !natH || natW < 8 || natH < 8) throw new Error('ابعاد تصویر نامعتبر است');

    /* تصاویر کوچک بزرگ‌نمایی و تصاویر بزرگ کوچک می‌شوند تا متن‌های ریز هم خوانده شوند */
    const maxSide = Math.max(natW, natH);
    scale = 1;
    if (maxSide < 1400) scale = Math.min(2.5, 1400 / maxSide);
    if (maxSide * scale > maxDim) scale = maxDim / maxSide;

    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(natW * scale));
    canvas.height = Math.max(1, Math.round(natH * scale));
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(dec.img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  } finally {
    dec.close();
  }

  pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (msg.skipBlank !== false && looksTextless(pixels)) {
    const empty = { ok: true, width: natW, height: natH, blocks: [], blank: true, ms: Date.now() - t0 };
    if (cacheKey) storeCache(cacheKey, empty);
    return empty;
  }

  const darkFrac = darkFraction(pixels);
  const { pool, worker } = await acquire(msg.lang, quality, msg.parallel);
  const lines = [];
  let passes = 0;
  /* اگر recognize گیر کند، worker را دور می‌اندازیم تا پول OCR قفل نشود */
  const passMs = Math.max(8000, Math.min(25000, msg.passTimeoutMs || 20000));
  let workerStuck = false;
  try {
    const merge = (found) => {
      for (const l of found) {
        const dup = lines.findIndex((o) => overlapRatio(o, l) > 0.3);
        if (dup < 0) lines.push(l);
        else if (l.conf > lines[dup].conf + 10 && l.text.length >= lines[dup].text.length) lines[dup] = l;
      }
    };
    const pass = async (image, psm) => {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await withTimeout(worker.recognize(image), passMs, () => { workerStuck = true; });
      passes++;
      merge(extractLines(data, msg.minConf));
      return lines.length;
    };

    /* پاس ۱: چیدمان خودکار (بهترین حالت برای متن‌های معمولی و پاراگراف‌ها) */
    await pass(canvas, '3');

    /* پاس ۲: متن پراکنده (دکمه، بنر، اینفوگرافیک) — فقط اگر پاس اول کم پیدا کرد */
    if (quality !== 'fast' && !msg.quick && lines.length < 3) await pass(canvas, '11');

    /* پاس ۳: تصویر معکوس برای متن روشن روی زمینه‌ی تیره */
    const wantsInvert = msg.invert !== false && darkFrac > 0.3 &&
      (quality === 'best' ? (lines.length < 6 || darkFrac > 0.55) : lines.length === 0);
    if (wantsInvert) {
      const inv = document.createElement('canvas');
      inv.width = canvas.width; inv.height = canvas.height;
      const ictx = inv.getContext('2d');
      if ('filter' in ictx) {
        ictx.filter = 'invert(1)';
        ictx.drawImage(canvas, 0, 0);
      } else {
        const id = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
        for (let i = 0; i < id.data.length; i += 4) {
          id.data[i] = 255 - id.data[i];
          id.data[i + 1] = 255 - id.data[i + 1];
          id.data[i + 2] = 255 - id.data[i + 2];
        }
        ictx.putImageData(id, 0, 0);
      }
      await pass(inv, '3');
    }
  } finally {
    if (workerStuck || worker.__ptDead) { dropWorker(pool, worker); terminateWorker(worker); }
    else release(pool, worker);
  }

  const rtl = msg.lang.split('+').every((l) => RTL_OCR.includes(l));
  const blocks = groupLines(lines, rtl).map((b) => {
    const colors = sampleColors(pixels, b);
    return {
      text: b.text,
      lines: b.rows,
      bbox: { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale },
      lineHeight: b.lineHeight / scale,
      bg: colors.bg,
      fg: colors.fg
    };
  });
  const result = { ok: true, width: natW, height: natH, blocks, passes, dark: Math.round(darkFrac * 100) / 100, ms: Date.now() - t0 };
  if (cacheKey) storeCache(cacheKey, result);
  return result;
}

function storeCache(key, value) {
  if (ocrCache.size >= cacheLimit) {
    const drop = Math.max(1, Math.floor(cacheLimit / 4));
    let i = 0;
    for (const k of ocrCache.keys()) { ocrCache.delete(k); if (++i >= drop) break; }
  }
  ocrCache.set(key, value);
}

/* خطوط معتبر را با حذف کلمات کم‌اطمینان استخراج می‌کند */
function extractLines(data, minConf) {
  const out = [];
  for (const line of (data.lines || [])) {
    const words = (line.words || [])
      .filter((w) => w.confidence >= Math.max(15, minConf - 20) && w.text.trim())
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!words.length) continue;
    /* Tesseract گاهی دو متن جدا (دکمه و پاورقی) را یک خط می‌گیرد؛ با فاصله/اندازه‌ی حروف می‌شکنیم */
    const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || 10;
    const clusters = [[words[0]]];
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1], w = words[i];
      const gap = w.bbox.x0 - prev.bbox.x1;
      const h1 = prev.bbox.y1 - prev.bbox.y0, h2 = w.bbox.y1 - w.bbox.y0;
      const hr = Math.max(h1, h2) / Math.max(1, Math.min(h1, h2));
      const cy1 = (prev.bbox.y0 + prev.bbox.y1) / 2, cy2 = (w.bbox.y0 + w.bbox.y1) / 2;
      if (gap > 1.6 * medH || hr > 1.7 || Math.abs(cy1 - cy2) > 0.7 * medH) clusters.push([w]);
      else clusters[clusters.length - 1].push(w);
    }
    for (const ws of clusters) {
      const avg = ws.reduce((s, w) => s + w.confidence, 0) / ws.length;
      if (avg < minConf) continue;
      const text = ws.map((w) => w.text.trim()).join(' ');
      if (!isMeaningful(text)) continue;
      const bb = ws.reduce((a, w) => ({
        x0: Math.min(a.x0, w.bbox.x0), y0: Math.min(a.y0, w.bbox.y0),
        x1: Math.max(a.x1, w.bbox.x1), y1: Math.max(a.y1, w.bbox.y1)
      }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      if (bb.x1 - bb.x0 < 4 || bb.y1 - bb.y0 < 4) continue;
      out.push(Object.assign(bb, { text, h: bb.y1 - bb.y0, conf: avg }));
    }
  }
  return out;
}

function isMeaningful(t) {
  if (!t) return false;
  const s = t.replace(/\s+/g, '');
  if (s.length < 2) return false;
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (letters < 2) return false;
  if (letters / s.length < 0.3) return false;
  if (/^(.)\1+$/u.test(s)) return false;     // چیزهایی مثل lll یا |||
  return true;
}

function overlapRatio(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}

function darkFraction(imgData) {
  const d = imgData.data;
  let dark = 0, n = 0;
  const step = Math.max(4, Math.floor(d.length / 4 / 20000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 100) dark++;
    n++;
  }
  return n ? dark / n : 0;
}

/* خطوط → ردیف → پاراگراف (تا ترجمه با مفهوم کامل‌تری انجام شود) */
function groupLines(lines, rtl) {
  lines.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.x0 - b.x0);
  const rows = [];
  for (const l of lines) {
    const cy = (l.y0 + l.y1) / 2;
    const row = rows.find((r) => {
      const rcy = (r.y0 + r.y1) / 2;
      const hr = Math.max(r.h, l.h) / Math.min(r.h, l.h);
      const gap = Math.max(l.x0 - r.x1, r.x0 - l.x1);
      return Math.abs(cy - rcy) < 0.5 * Math.min(r.h, l.h) && hr < 1.5 && gap < 1.5 * Math.max(r.h, l.h);
    });
    if (row) {
      row.parts.push(l);
      row.x0 = Math.min(row.x0, l.x0); row.y0 = Math.min(row.y0, l.y0);
      row.x1 = Math.max(row.x1, l.x1); row.y1 = Math.max(row.y1, l.y1);
      row.h = (row.h + l.h) / 2;
    } else rows.push({ parts: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, h: l.h });
  }
  rows.forEach((r) => {
    r.parts.sort((a, b) => (rtl ? b.x0 - a.x0 : a.x0 - b.x0));
    r.text = r.parts.map((p) => p.text).join(' ');
  });

  rows.sort((a, b) => a.y0 - b.y0);
  const blocks = [];
  for (const r of rows) {
    const b = blocks.find((bl) => {
      const last = bl.last;
      const vgap = r.y0 - last.y1;
      const hr = Math.max(last.h, r.h) / Math.min(last.h, r.h);
      const ov = Math.min(r.x1, bl.x1) - Math.max(r.x0, bl.x0);
      return vgap > -0.3 * r.h && vgap < 0.9 * Math.max(last.h, r.h) && hr < 1.45 &&
        ov > 0.25 * Math.min(r.x1 - r.x0, bl.x1 - bl.x0);
    });
    if (b) {
      b.items.push(r); b.last = r;
      b.x0 = Math.min(b.x0, r.x0); b.y0 = Math.min(b.y0, r.y0);
      b.x1 = Math.max(b.x1, r.x1); b.y1 = Math.max(b.y1, r.y1);
    } else blocks.push({ items: [r], last: r, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
  }
  return blocks.map((b) => {
    let text = '';
    b.items.forEach((r, i) => {
      if (i && /[-‐]$/.test(text)) text = text.replace(/[-‐]$/, '') + r.text;
      else text += (i ? ' ' : '') + r.text;
    });
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      rows: b.items.length,
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1,
      lineHeight: b.items.reduce((s, r) => s + r.h, 0) / b.items.length
    };
  });
}

/* رنگ پس‌زمینه (حلقه‌ی دور کادر) و رنگ متن (دورترین پیکسل‌ها از پس‌زمینه) */
function sampleColors(imgData, bb) {
  const { width: W, height: H, data } = imgData;
  const px = (x, y) => {
    x = Math.max(0, Math.min(W - 1, Math.round(x)));
    y = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (y * W + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const pad = 3;
  const ring = [];
  const stepX = Math.max(1, (bb.x1 - bb.x0) / 40);
  const stepY = Math.max(1, (bb.y1 - bb.y0) / 15);
  for (let x = bb.x0 - pad; x <= bb.x1 + pad; x += stepX) { ring.push(px(x, bb.y0 - pad)); ring.push(px(x, bb.y1 + pad)); }
  for (let y = bb.y0 - pad; y <= bb.y1 + pad; y += stepY) { ring.push(px(bb.x0 - pad, y)); ring.push(px(bb.x1 + pad, y)); }
  const median = (arr, k) => arr.map((c) => c[k]).sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bg = [median(ring, 0), median(ring, 1), median(ring, 2)];

  const inside = [];
  const sx = Math.max(1, (bb.x1 - bb.x0) / 60);
  const sy = Math.max(1, (bb.y1 - bb.y0) / 20);
  for (let y = bb.y0; y <= bb.y1; y += sy) for (let x = bb.x0; x <= bb.x1; x += sx) inside.push(px(x, y));
  const dist = (c) => Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
  inside.sort((a, b) => dist(b) - dist(a));
  const top = inside.slice(0, Math.max(1, Math.floor(inside.length * 0.08)));
  let fg = [0, 1, 2].map((k) => Math.round(top.reduce((s, c) => s + c[k], 0) / top.length));
  if (dist(fg) < 120) {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    fg = lum > 140 ? [17, 17, 17] : [255, 255, 255];
  }
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), fg: hex(fg) };
}
