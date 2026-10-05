/* =========================================================================
   selftest.js — تست خودکار منطق خالص افزونه (بدون نیاز به مرورگر)
   اجرا:  node tools/selftest.js
   در محیط Node، chrome/document شبیه‌سازی می‌شوند و توابع کلیدی defaults.js و
   background.js تست می‌شوند: تشخیص خط زبان، دسته‌بندی، آدرس‌سازی API،
   و پارس خروجی مدل‌های هوش مصنوعی (نشانه‌دار / JSON / خطی).
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra ? ' → ' + extra : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) passed++;
  else { failed++; failures.push(`${name} → got ${a}, want ${b}`); }
}

/* ---------------------- محیط شبیه‌سازی‌شده ---------------------- */
const noop = () => {};
const asyncEmpty = async () => ({});
const chromeStub = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, onSuspend: { addListener: noop },
    getURL: (p) => 'chrome-extension://x/' + p,
    getContexts: async () => [],
    sendMessage: async () => ({ ok: false })
  },
  storage: {
    sync: { get: asyncEmpty, set: asyncEmpty, remove: asyncEmpty },
    local: { get: asyncEmpty, set: asyncEmpty, remove: asyncEmpty, getBytesInUse: async () => 0 },
    session: { get: asyncEmpty, set: asyncEmpty, remove: asyncEmpty },
    onChanged: { addListener: noop }
  },
  commands: { onCommand: { addListener: noop } },
  tabs: { query: async () => [], sendMessage: async () => ({}), onRemoved: { addListener: noop }, captureVisibleTab: async () => '' },
  scripting: { executeScript: asyncEmpty },
  offscreen: { createDocument: asyncEmpty }
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date,
  URL, AbortController, Set, Map, WeakMap, WeakSet, RegExp, Error, String, Number, Array, Object,
  isFinite, isNaN, parseInt, parseFloat, Boolean, Symbol, TextEncoder, structuredClone,
  chrome: chromeStub,
  importScripts: noop,
  fetch: () => Promise.reject(new Error('network disabled in test'))
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(file) {
  let code = fs.readFileSync(path.join(dir, file), 'utf8');
  code = code.replace(/^importScripts\([^)]*\);$/m, '');   // defaults.js دستی بارگذاری می‌شود
  vm.runInContext(code, sandbox, { filename: file });
}
load('defaults.js');
load('background.js');

/* ============================== تست‌ها ============================== */

/* ۱) تشخیص خط غالب و «همین حالا به زبان مقصد است» */
eq('script: persian text', sandbox.ptDominantScript('سلام دنیا').script, 'arabic');
eq('script: english text', sandbox.ptDominantScript('Hello world').script, 'latin');
eq('script: mixed dominantly latin', sandbox.ptDominantScript('Hello دنیا').script, 'latin');
ok('skip: english→persian not skipped', sandbox.ptIsSameAsTarget('Hello world', 'fa', 'auto') === false);
ok('skip: persian→persian skipped', sandbox.ptIsSameAsTarget('سلام دنیا', 'fa', 'auto') === true);
ok('skip: english→english skipped', sandbox.ptIsSameAsTarget('Hello world', 'en', 'auto') === true);
ok('skip: persian text when source=en explicit is skipped', sandbox.ptIsSameAsTarget('سلام', 'fa', 'en') === true);
ok('skip: english text with source=en explicit is NOT skipped', sandbox.ptIsSameAsTarget('Hello', 'fa', 'en') === false);
ok('skip: numbers only', sandbox.ptIsSameAsTarget('12345', 'fa', 'auto') === false);
ok('skip: cyrillic for russian target', sandbox.ptIsSameAsTarget('Привет мир', 'ru', 'auto') === true);
ok('skip: japanese kana for ja', sandbox.ptIsSameAsTarget('こんにちは', 'ja', 'auto') === true);
ok('skip: zh-CN code resolves', sandbox.ptIsSameAsTarget('你好世界', 'zh-CN', 'auto') === true);

/* ۲) دسته‌بندی متن‌ها */
const chunks = sandbox.ptChunkTexts(['a', 'b', 'c', 'd', 'e'], 2, 1000);
eq('chunk: count', chunks.length, 3);
eq('chunk: starts', chunks.map((c) => c.start), [0, 2, 4]);
const charsChunks = sandbox.ptChunkTexts(['aaaa', 'bbbb', 'cc'], 100, 5);
eq('chunk: char limit splits', charsChunks.length, 3);
eq('chunk: char limit sizes', charsChunks.map((c) => c.items.length), [1, 1, 1]);
eq('chunk: empty', sandbox.ptChunkTexts([], 10, 10).length, 0);

/* ۳) آدرس‌سازی و هدرهای API */
eq('url: base + chat', sandbox.ptChatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
eq('url: full path preserved', sandbox.ptChatUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
eq('url: trailing slash', sandbox.ptChatUrl('https://x.com/v1/'), 'https://x.com/v1/chat/completions');
eq('url: missing scheme', sandbox.ptChatUrl('api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/chat/completions');
eq('url: azure adds path+version', sandbox.ptChatUrl('https://r.openai.azure.com/openai/deployments/dep'),
  'https://r.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21');
eq('url: azure full', sandbox.ptChatUrl('https://r.openai.azure.com/openai/deployments/dep/chat/completions'),
  'https://r.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21');
eq('url: models', sandbox.ptModelsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
eq('url: models from full chat url', sandbox.ptModelsUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/models');
eq('url: models azure = none', sandbox.ptModelsUrl('https://r.openai.azure.com/openai/deployments/dep'), '');
eq('auth: bearer default', sandbox.ptAuthHeaders('https://api.openai.com/v1', 'K').Authorization, 'Bearer K');
eq('auth: azure api-key', sandbox.ptAuthHeaders('https://r.openai.azure.com/openai/deployments/d', 'K')['api-key'], 'K');
ok('auth: azure has no bearer', !sandbox.ptAuthHeaders('https://r.openai.azure.com/openai/deployments/d', 'K').Authorization);
eq('headers: parse extra', sandbox.ptParseExtraHeaders('X-Title: My App\nHTTP-Referer=https://x.com'), { 'X-Title': 'My App', 'HTTP-Referer': 'https://x.com' });
ok('model: reasoning detection', sandbox.ptIsReasoningModel('o3-mini') && sandbox.ptIsReasoningModel('gpt-5.1') && !sandbox.ptIsReasoningModel('gpt-4o-mini'));

/* ۴) پارس خروجی مدل: قالب نشانه‌دار */
eq('llm parse: delimiter', sandbox.parseDelimited('[[[1]]]سلام\n[[[2]]]ورود', 2), ['سلام', 'ورود']);
eq('llm parse: delimiter with preamble', sandbox.parseDelimited('Here you go:\n[[[1]]]یک\n[[[2]]]دو\n', 2), ['یک', 'دو']);
eq('llm parse: delimiter multiline segment', sandbox.parseDelimited('[[[1]]]خط اول\nخط دوم\n[[[2]]]ب', 2), ['خط اول\nخط دوم', 'ب']);
eq('llm parse: delimiter missing', sandbox.parseDelimited('سلام\nورود', 2), null);
eq('llm parse: delimiter too few', sandbox.parseDelimited('[[[1]]]فقط یکی', 2), null);
eq('llm parse: delimiter out of order', sandbox.parseDelimited('[[[2]]]دو\n[[[1]]]یک', 2), ['یک', 'دو']);
eq('llm parse: strip leading colon', sandbox.parseDelimited('[[[1]]]: سلام', 1), ['سلام']);

/* ۵) پارس خروجی مدل: JSON */
eq('llm parse: json object t', sandbox.parseJsonArray('{"t":["a","b"]}', 2), ['a', 'b']);
eq('llm parse: json array', sandbox.parseJsonArray('["a","b"]', 2), ['a', 'b']);
eq('llm parse: json with fence', sandbox.parseJsonArray('```json\n{"t":["a","b"]}\n```', 2), ['a', 'b']);
eq('llm parse: json nested arrays', sandbox.parseJsonArray('{"t":[["a"],["b"]]}', 2), ['a', 'b']);
eq('llm parse: json wrong count', sandbox.parseJsonArray('{"t":["a"]}', 2), null);
eq('llm parse: json translations key', sandbox.parseJsonArray('{"translations":["x","y"]}', 2), ['x', 'y']);
eq('llm parse: not json', sandbox.parseJsonArray('سلام', 1), null);

/* ۶) انتخاب مسیر پارس */
eq('llm output: json mode', sandbox.parseLlmOutput('{"t":["a","b"]}', 2, true), ['a', 'b']);
eq('llm output: delimiter mode', sandbox.parseLlmOutput('[[[1]]]a [[[2]]]b', 2, false), ['a', 'b']);
eq('llm output: line fallback', sandbox.parseLlmOutput('a\nb', 2, false), ['a', 'b']);
eq('llm output: junk', sandbox.parseLlmOutput('blah blah', 3, false), null);
eq('llm output: empty', sandbox.parseLlmOutput('', 1, false), null);

/* ۷) نرمال‌سازی پاسخ gtx (چند متن در یک درخواست) */
eq('gtx: flat array', sandbox.normalizeGtx(['a', 'b'], 2), ['a', 'b']);
eq('gtx: pairs with lang', sandbox.normalizeGtx([['a', 'en'], ['b', 'fr']], 2), ['a', 'b']);
eq('gtx: single wrapped', sandbox.normalizeGtx([['a', 'en']], 1), ['a']);
eq('gtx: count mismatch → null', sandbox.normalizeGtx([['a', 'en']], 2), null);
eq('gtx: empty string → null', sandbox.normalizeGtx(['', 'b'], 2), null);

/* ۸) اجزای پرامپت AI */
const s = Object.assign({}, sandbox.PT_DEFAULTS, { glossary: 'API=رابط برنامه‌نویسی\nDeploy => انتشار', llmFormat: 'delimiter' });
const sys = sandbox.llmSystemPrompt(s, 'en', 'fa', 3);
ok('prompt: has languages', sys.includes('English') && sys.includes('Persian'));
ok('prompt: has glossary', sys.includes('رابط برنامه‌نویسی') && sys.includes('انتشار'));
ok('prompt: marker format', sys.includes('[[[1]]]'));
ok('prompt: json mode switches format', sandbox.llmSystemPrompt(Object.assign({}, s, { llmFormat: 'json' }), 'en', 'fa', 3).includes('"t"'));
eq('prompt: user content markers', sandbox.llmUserContent(['a', 'b'], false), '[[[1]]]a\n[[[2]]]b\n');
eq('prompt: user content json', sandbox.llmUserContent(['a', 'b'], true), '["a","b"]');

/* ۹) زبان OCR */
eq('ocr lang: auto from source', sandbox.ptOcrLangFor({ sourceLang: 'fa', ocrLang: 'auto' }), 'fas');
eq('ocr lang: explicit', sandbox.ptOcrLangFor({ sourceLang: 'fa', ocrLang: 'eng+fas' }), 'eng+fas');
eq('ocr lang: unknown source', sandbox.ptOcrLangFor({ sourceLang: 'xx', ocrLang: 'auto' }), 'eng');

/* ۱۰) تعریف موتورها و پیش‌تنظیم‌ها سالم باشند */
ok('engines: defaults exist for every engine', Object.keys(sandbox.PT_DEFAULTS).length > 40);
Object.keys(sandbox.PT_ENGINE_INFO).forEach((e) => {
  ok('engine info complete: ' + e, sandbox.PT_ENGINE_INFO[e].items > 0 && sandbox.PT_ENGINE_INFO[e].chars > 0);
});
Object.keys(sandbox.PT_LLM_PRESETS).forEach((p) => {
  const v = sandbox.PT_LLM_PRESETS[p];
  ok('preset has name: ' + p, !!v.name);
  if (p !== 'custom' && p !== 'vllm' && p !== 'lmstudio' && p !== 'azure') {
    ok('preset absolute url: ' + p, /^https?:\/\//.test(v.baseUrl), v.baseUrl);
  }
});
ok('default engine exists', !!sandbox.PT_ENGINE_INFO[sandbox.PT_DEFAULTS.engine]);
ok('default preset exists', !!sandbox.PT_LLM_PRESETS[sandbox.PT_DEFAULTS.llmPreset]);
ok('default llm url builds', /chat\/completions$/.test(sandbox.ptChatUrl(sandbox.PT_DEFAULTS.llmBaseUrl)));

/* ۱۱) کلید پیش‌فرض تنظیمات با فایل popup هم‌خوان باشد */
const popupHtml = fs.readFileSync(path.join(dir, 'popup.html'), 'utf8');
const ids = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const popupJs = fs.readFileSync(path.join(dir, 'popup.js'), 'utf8');
const contentJs = fs.readFileSync(path.join(dir, 'content.js'), 'utf8');
const bgJs = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
const known = new Set(Object.keys(sandbox.PT_DEFAULTS));
['sourceLang', 'targetLang', 'engine', 'ocrLang', 'ocrQuality'].forEach((id) => {
  ok('popup has id: ' + id, ids.has(id));
});
const settingsInPopup = [...popupJs.matchAll(/\$\('?([A-Za-z_][\w]*)'?\)/g)].map((m) => m[1])
  .filter((k) => k.length > 2);      // نام‌های تک/دوحرفی متغیرهای حلقه هستند، نه id
const unknown = [...new Set(settingsInPopup)].filter((k) => !ids.has(k) && !known.has(k));
eq('popup.js references only existing ids/settings', unknown, []);

/* ۱۲) همه‌ی تنظیمات سیم‌کشی شده باشند (تنظیم بی‌استفاده وجود نداشته باشد) */
const SPECIAL = new Set(['scope', 'shortcut', 'boxColorMode', 'textColorMode', 'llmPreset']);
const defaults = Object.keys(sandbox.PT_DEFAULTS);

/* الف) هر تنظیم باید در پنل یک عنصر داشته باشد */
const noUi = defaults.filter((k) => !ids.has(k) && !SPECIAL.has(k));
eq('هر تنظیم در popup.html عنصر دارد', noUi, []);

/* ب) نام هر تنظیم باید در popup.js آمده باشد (چه مستقیم چه با کلید متغیر) */
const noPopupRef = defaults.filter((k) => !popupJs.includes("'" + k + "'") && !popupJs.includes('"' + k + '"') && !popupJs.includes('.' + k));
eq('هر تنظیم در popup.js استفاده شده', noPopupRef, []);

/* پ) کلیدهای ذخیره‌شده‌ی popup.js معتبر باشند */
const savedKeys = new Set();
for (const m of popupJs.matchAll(/save\(\{([^}]*)\}\)/g)) {
  for (const kv of m[1].split(',')) {
    const k = kv.split(':')[0].trim();
    if (/^[A-Za-z_][\w]*$/.test(k)) savedKeys.add(k);
  }
}
const badSaves = [...savedKeys].filter((k) => !(k in sandbox.PT_DEFAULTS) && !SPECIAL.has(k));
eq('کلیدهای ذخیره‌شده‌ی popup.js معتبرند', badSaves, []);

/* ت) هر تنظیم واقعاً در content.js یا background.js خوانده شود (تنظیم بی‌اثر نداشته باشیم) */
const usesKey = (code, k) => code.includes('.' + k) || code.includes("'" + k + "'");
const unused = defaults.filter((k) => !SPECIAL.has(k) && !usesKey(contentJs, k) && !usesKey(bgJs, k));
eq('هر تنظیم در کد اثر واقعی دارد', unused, []);

/* ث) لیست موتورها از PT_ENGINE_INFO ساخته می‌شود و برچسب فارسی دارد */
ok('لیست موتورها از PT_ENGINE_INFO ساخته می‌شود', popupJs.includes('Object.keys(PT_ENGINE_INFO)'));
Object.keys(sandbox.PT_ENGINE_INFO).forEach((e) => {
  ok('برچسب فارسی موتور: ' + e, popupJs.includes(e + ": '"));
});

/* ج) لیست موتورها در background.js هم پیاده‌سازی شده باشد */
Object.keys(sandbox.PT_ENGINE_INFO).forEach((e) => {
  if (e === 'google') { ok('موتور پیش‌فرض پیاده‌سازی شده', bgJs.includes('googleTranslate')); return; }
  ok('موتور در runEngine پیاده‌سازی شده: ' + e, bgJs.includes("case '" + e + "'") || bgJs.includes("'" + e + "'"));
});

/* چ) content.js فقط تنظیمات موجود را بخواند */
const contentJs2 = contentJs;
const contentSettings = [...new Set([...contentJs2.matchAll(/settings\.([A-Za-z_][\w]*)/g)].map((m) => m[1]))];
eq('content.js فقط تنظیمات موجود را می‌خواند', contentSettings.filter((k) => !(k in sandbox.PT_DEFAULTS)), []);

/* ح) پنل و content هر دو از یک نام برای پیام‌ها استفاده کنند */
['apply-state', 'status', 'translate', 'ping', 'warmup', 'ocr-warmup', 'capture-ocr', 'cache-clear', 'cache-stats', 'diag']
  .forEach((t) => {
    const owners = [bgJs, contentJs2, popupJs].filter((c) => c.includes("'" + t + "'"));
    ok('پیام «' + t + '» بین فایل‌ها هم‌خوان است', owners.length >= 2);
  });

/* ۱۲) خروجی */
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
