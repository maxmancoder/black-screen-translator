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
const localStore = {};
const storageArea = {get:async (key)=>{if(key==null)return {...localStore};if(typeof key==='string')return key in localStore?{[key]:localStore[key]}:{};const out={};for(const k of key||[])if(k in localStore)out[k]=localStore[k];return out;},set:async(v)=>Object.assign(localStore,v),remove:async(k)=>{for(const x of [].concat(k))delete localStore[x];}};
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
    local: Object.assign(storageArea,{getBytesInUse:async()=>0}),
    session: { get: asyncEmpty, set: asyncEmpty, remove: asyncEmpty },
    onChanged: { addListener: noop }
  },
  commands: { onCommand: { addListener: noop } },
  tabs: { query: async () => [], get: async () => ({id:1,url:'https://example.test/path'}), sendMessage: async () => ({}), onRemoved: { addListener: noop }, captureVisibleTab: async () => '' },
  scripting: { executeScript: asyncEmpty },
  offscreen: { createDocument: asyncEmpty }
};

const sandbox = {
  crypto: require('crypto').webcrypto,
  TextEncoder,
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


(async () => {
  eq('OCR default', sandbox.PT_DEFAULTS.ocrLang, 'eng');
  const savedRegion={xRatio:.65,yRatio:.1,widthRatio:.3,heightRatio:.8};
  ok('normalized region valid',sandbox.validRegion(savedRegion));
  ok('region overflow invalid',!sandbox.validRegion({...savedRegion,xRatio:.8}));
  const saved=await sandbox.saveRegionFor({tab:{url:'https://example.test/a?q=private'}},savedRegion);
  ok('origin region saved',saved.ok);
  const restored=await sandbox.regionConfigFor({tab:{url:'https://example.test/other/path#fragment'}});
  eq('same-origin path restores region',restored.config.region,savedRegion);
  const fullMode=await sandbox.setRegionMode(1,'full');
  ok('full mode persisted',fullMode.ok&&fullMode.config.mode==='full');
  eq('full mode preserves region',fullMode.config.region,savedRegion);
  const regionModeAgain=await sandbox.setRegionMode(1,'region');
  ok('region reenabled without reselection',regionModeAgain.ok&&regionModeAgain.config.region.xRatio===savedRegion.xRatio);
  const foreign=await sandbox.regionConfigFor({tab:{url:'https://different.test/'}});
  eq('different origin isolated',foreign.config,null);
  ok('origin storage key excludes path',sandbox.regionStoreKey('https://example.test')===sandbox.regionStoreKey('https://example.test'));
  eq('OCR auto follows source', sandbox.ptOcrLangFor({ocrLang:'auto',sourceLang:'fr'}), 'fra');
  try { sandbox.ptOcrLangFor({ocrLang:'../bad'}); ok('invalid OCR rejected', false); } catch (_) { ok('invalid OCR rejected', true); }
  ok('cache keys unambiguous', sandbox.cacheKeyOf('a|b','c','d','x') !== sandbox.cacheKeyOf('a','b|c','d','x'));
  eq('gtx unchanged valid', sandbox.normalizeGtx(['same'],1), ['same']);
  eq('gtx malformed rejected', sandbox.normalizeGtx([{}],1), null);
  eq('gtx whitespace rejected', sandbox.normalizeGtx(['   '],1), null);
  const fpSettings = Object.assign({}, sandbox.PT_DEFAULTS, { llmKey: 'secret-A', llmExtraHeaders: '{"Authorization":"Bearer secret-A"}' });
  const fp1 = await sandbox.providerFingerprint(fpSettings, 'llm');
  eq('provider fingerprint stable', await sandbox.providerFingerprint(fpSettings, 'llm'), fp1);
  const changedHeaders = Object.assign({}, fpSettings, { llmExtraHeaders: '{"X-Mode":"new"}' });
  const fp2 = await sandbox.providerFingerprint(changedHeaders, 'llm');
  ok('custom headers invalidate fingerprint', fp1 !== fp2);
  ok('credentials not embedded in fingerprint', !fp1.includes('secret-A'));
  const changedCredential = Object.assign({}, fpSettings, { llmKey: 'secret-B' });
  ok('provider credentials invalidate fingerprint', fp1 !== await sandbox.providerFingerprint(changedCredential, 'llm'));
  const changedModel = Object.assign({}, fpSettings, { llmModel: 'other-model' });
  ok('model invalidates fingerprint', fp1 !== await sandbox.providerFingerprint(changedModel, 'llm'));
  vm.runInContext(`getSettings = async () => Object.assign({}, PT_DEFAULTS, {engine:'gtx', cacheEnabled:true, persistCache:false});
    translateChunk = async (engine, items) => ({engine, items: items.map((t) => t === 'bad' ? null : t)});`, sandbox);
  const first = await sandbox.translateTexts(['same','bad'], 'en', 'fr', {});
  eq('partial statuses', first.statuses, ['success','failed']);
  eq('fallback text retained', first.translations, ['same','bad']);
  const second = await sandbox.translateTexts(['same','bad'], 'en', 'fr', {});
  eq('unchanged success cached', second.cached, 1);
  eq('failed item not cached', second.statuses, ['success','failed']);
  vm.runInContext(`request = async () => ({bad:true})`, sandbox);
  try { await sandbox.gtxOne('hello','en','fr',{}); ok('malformed single fails', false); }
  catch (_) { ok('malformed single fails', true); }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach(f => console.log(' - ' + f)); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exitCode = 1; });
