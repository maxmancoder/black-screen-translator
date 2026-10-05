/* global PT_DEFAULTS, PT_LANGUAGES, PT_OCR_LANGS, PT_LLM_PRESETS, PT_ENGINE_INFO, PT_VERSION, ptShortcutLabel, ptFormatMs, ptClamp */
const $ = (id) => document.getElementById(id);
let settings = Object.assign({}, PT_DEFAULTS);
let recording = false;
let lastDiag = null;

/* ---------------------------------- ذخیره ---------------------------------- */
function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
}
function saveNow(patch) {
  Object.assign(settings, patch);
  return chrome.storage.sync.set(patch);
}

/* ---------------------------------- ساخت UI ---------------------------------- */
const ENGINE_LABELS = {
  google: 'Google رایگان — سریع (پیشنهادی)',
  gtx: 'Google رایگان — روش جایگزین (gtx)',
  gcloud: 'Google Cloud Translation (کلید API)',
  deepl: 'DeepL (کلید API)',
  microsoft: 'Microsoft Translator (کلید API)',
  libre: 'LibreTranslate (سرور خودتان)',
  llm: 'هوش مصنوعی: OpenAI / Gemini / Claude / مدل‌های ایرانی (کلید API)'
};

const ENGINE_NOTES = {
  google: 'بدون کلید و بدون هزینه. سریع‌ترین گزینه؛ اگر شبکه‌ی شما دسترسی نداشته باشد، خودکار به روش جایگزین gtx می‌رود.',
  gtx: 'بدون کلید. چند متن در یک درخواست فرستاده می‌شود؛ وقتی روش سریع در شبکه‌ی شما مسدود است مناسب است.',
  gcloud: 'دقیق و پایدار، ولی نیاز به کلید و صورت‌حساب فعال Google Cloud دارد (ماهانه ۵۰۰ هزار کاراکتر رایگان).',
  deepl: 'کیفیت بالا برای زبان‌های اروپایی. کلید Free با :fx مشخص می‌شود.',
  microsoft: 'کلید و منطقه‌ی Azure لازم است؛ ماهانه ۲ میلیون کاراکتر رایگان دارد.',
  libre: 'سرور LibreTranslate (عمومی یا محلی). برای استفاده‌ی کاملاً آفلاین، سرور محلی راه بیندازید.',
  llm: 'کیفیت و لحن بهتر، مخصوصاً برای فارسی. با دکمه‌ی «تست اتصال» مطمئن شوید کلید، آدرس و نام مدل درست است.'
};

function fillLangSelects() {
  const src = $('sourceLang'), dst = $('targetLang'), ocr = $('ocrLang');
  PT_LANGUAGES.forEach(([code, name]) => {
    src.add(new Option(name, code));
    if (code !== 'auto') dst.add(new Option(name, code));
  });
  ocr.add(new Option('خودکار (بر اساس زبان مبدأ)', 'auto'));
  PT_LANGUAGES.forEach(([code, name]) => {
    if (PT_OCR_LANGS[code]) ocr.add(new Option(name, PT_OCR_LANGS[code]));
  });
  ocr.add(new Option('انگلیسی + فارسی', 'eng+fas'));
  ocr.add(new Option('انگلیسی + عربی', 'eng+ara'));
  ocr.add(new Option('انگلیسی + چینی ساده', 'eng+chi_sim'));
  ocr.add(new Option('انگلیسی + روسی', 'eng+rus'));
  ocr.add(new Option('انگلیسی + ترکی', 'eng+tur'));

  const eng = $('engine');
  Object.keys(PT_ENGINE_INFO).forEach((k) => eng.add(new Option(ENGINE_LABELS[k] || PT_ENGINE_INFO[k].name, k)));

  for (const [id, p] of Object.entries(PT_LLM_PRESETS)) $('llmPreset').add(new Option(p.name + (p.note ? ' ⓘ' : ''), id));
  $('version').textContent = 'v' + PT_VERSION;
  $('version2').textContent = PT_VERSION;
}

function fillModels(models) {
  const dl = $('llmModelList'), pick = $('llmModelPick');
  dl.innerHTML = '';
  pick.innerHTML = '';
  models.forEach((m) => {
    const o = new Option(m, m);
    dl.appendChild(o);
    pick.add(new Option(m, m));
  });
  if (models.length) {
    pick.classList.remove('hidden');
    pick.onchange = () => { $('llmModel').value = pick.value; save({ llmModel: pick.value }); };
  }
}

function renderTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
      if (b.dataset.tab === 'adv') refreshDiag();
      if (b.dataset.tab === 'ai') refreshCacheStats();
    };
  });
}

function renderScope() {
  document.querySelectorAll('.scope button').forEach((b) => {
    const on = b.dataset.scope === settings.scope;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('scopeHint').textContent = settings.scope === 'view'
    ? 'فقط متن‌ها و عکس‌های داخل صفحه‌نمایش فوراً ترجمه می‌شوند؛ با اسکرول، بخش‌های جدید هم ترجمه می‌شوند.'
    : settings.scope === 'auto'
      ? 'اول بخش دیده‌شده ترجمه می‌شود (تقریباً فوری) و بعد بقیه‌ی صفحه در پس‌زمینه — تعادل سرعت و پوشش کامل.'
      : 'کل صفحه (حتی بخش‌هایی که هنوز دیده نمی‌شوند) اسکن و ترجمه می‌شود؛ ترجمه‌ها با اسکرول سر جایشان دیده می‌شوند.';
}

function renderEngineRows() {
  const e = settings.engine;
  $('gcloudRow').classList.toggle('show', e === 'gcloud');
  $('deeplRow').classList.toggle('show', e === 'deepl');
  $('msRow').classList.toggle('show', e === 'microsoft');
  $('libreRow').classList.toggle('show', e === 'libre');
  $('llmRow').classList.toggle('show', e === 'llm');
  $('engineNote').textContent = ENGINE_NOTES[e] || '';
  $('llmModelPick').classList.toggle('hidden', !$('llmModelPick').options.length);
}

function renderSettings() {
  renderScope();
  renderEngineRows();
  $('sourceLang').value = settings.sourceLang;
  $('targetLang').value = settings.targetLang;
  $('shortcutBtn').textContent = ptShortcutLabel(settings.shortcut);

  /* سرعت */
  $('maxConcurrent').value = settings.maxConcurrent;
  $('concVal').textContent = settings.maxConcurrent;
  ['batchItems', 'batchChars', 'requestTimeout', 'requestRetries', 'requestDelay', 'minTextLength',
    'hibernateDistance', 'renderMargin', 'relayoutInterval', 'scanSliceMs'].forEach((k) => { $(k).value = settings[k]; });
  ['skipTargetScript', 'lightDom', 'toastEnabled'].forEach((k) => { $(k).checked = !!settings[k]; });

  /* موتور و AI */
  $('engine').value = settings.engine;
  ['gcloudKey', 'deeplKey', 'msKey', 'msRegion', 'libreUrl', 'libreKey', 'llmKey', 'llmBaseUrl',
    'llmModel', 'llmSystemPrompt', 'glossary', 'llmExtraHeaders'].forEach((k) => { $(k).value = settings[k] || ''; });
  $('deeplFormality').value = settings.deeplFormality;
  $('llmPreset').value = settings.llmPreset;
  $('llmTemperature').value = settings.llmTemperature;
  $('llmMaxTokens').value = settings.llmMaxTokens;
  $('llmFormat').value = settings.llmFormat;
  $('llmItems').value = settings.llmItems;
  $('llmChars').value = settings.llmChars;
  $('fallbackToFree').checked = !!settings.fallbackToFree;
  $('cacheEnabled').checked = !!settings.cacheEnabled;
  $('persistCache').checked = !!settings.persistCache;
  $('cacheLimit').value = settings.cacheLimit;

  /* تصاویر */
  ['translateImages', 'translateBackgroundImages', 'ocrInvert', 'ocrSkipBlank', 'ocrVisibleOnly'].forEach((k) => { $(k).checked = !!settings[k]; });
  $('translateBackgroundImages').disabled = !settings.translateImages;
  $('ocrLang').value = settings.ocrLang;
  $('ocrQuality').value = settings.ocrQuality;
  $('ocrParallel').value = String(settings.ocrParallel);
  $('ocrMinConfidence').value = settings.ocrMinConfidence;
  $('confVal').textContent = settings.ocrMinConfidence;
  $('ocrMaxDim').value = settings.ocrMaxDim;
  $('ocrCacheLimit').value = settings.ocrCacheLimit;
  $('ocrTimeout').value = settings.ocrTimeout;

  /* ظاهر */
  document.querySelector(`input[name=boxColorMode][value=${settings.boxColorMode}]`).checked = true;
  document.querySelector(`input[name=textColorMode][value=${settings.textColorMode}]`).checked = true;
  $('boxColor').value = settings.boxColor;
  $('textColor').value = settings.textColor;
  $('boxOpacity').value = settings.boxOpacity;
  $('opacityVal').textContent = Math.round(settings.boxOpacity * 100);
  $('fontScale').value = settings.fontScale;
  $('fontScaleVal').textContent = settings.fontScale;
  $('boxPadding').value = settings.boxPadding;
  $('boxRadius').value = settings.boxRadius;
  $('fontFamily').value = settings.fontFamily || '';
  $('forceRtl').value = settings.forceRtl;

  /* پیشرفته */
  ['translateInputs', 'translateInlineCode', 'translateCodeBlocks', 'respectNoTranslate', 'autoTranslate',
    'dynamicContent', 'diagnostics'].forEach((k) => { $(k).checked = !!settings[k]; });
  $('skipSelectors').value = settings.skipSelectors || '';
}

/* ---------------------------------- رویدادها ---------------------------------- */
function num(id, key, min, max, def) {
  $(id).onchange = (e) => {
    const v = ptClamp(e.target.value, min, max, def);
    e.target.value = v;
    save({ [key]: v });
  };
}
function chk(id, key, after) {
  $(id).onchange = (e) => { save({ [key]: e.target.checked }); if (after) after(); };
}

function bindSettings() {
  renderTabs();
  document.querySelectorAll('.scope button').forEach((b) => {
    b.onclick = () => { save({ scope: b.dataset.scope }); renderScope(); };
  });
  $('sourceLang').onchange = (e) => save({ sourceLang: e.target.value });
  $('targetLang').onchange = (e) => save({ targetLang: e.target.value });
  $('swap').onclick = () => {
    if (settings.sourceLang === 'auto') { $('error').textContent = 'برای جابه‌جایی، اول زبان مبدأ را انتخاب کنید.'; $('error').classList.remove('hidden'); return; }
    save({ sourceLang: settings.targetLang, targetLang: settings.sourceLang });
    renderSettings();
  };

  /* سرعت */
  $('maxConcurrent').oninput = (e) => { $('concVal').textContent = e.target.value; };
  $('maxConcurrent').onchange = (e) => save({ maxConcurrent: +e.target.value });
  num('batchItems', 'batchItems', 10, 500, 150);
  num('batchChars', 'batchChars', 500, 100000, 18000);
  num('requestTimeout', 'requestTimeout', 3000, 300000, 30000);
  num('requestRetries', 'requestRetries', 0, 5, 2);
  num('requestDelay', 'requestDelay', 0, 5000, 0);
  num('minTextLength', 'minTextLength', 1, 40, 1);
  num('hibernateDistance', 'hibernateDistance', 0.5, 10, 2);
  num('renderMargin', 'renderMargin', 0, 3, 0.6);
  num('relayoutInterval', 'relayoutInterval', 200, 5000, 700);
  num('scanSliceMs', 'scanSliceMs', 4, 100, 20);
  ['skipTargetScript', 'lightDom', 'toastEnabled', 'dynamicContent'].forEach((k) => chk(k, k));

  const SPEED_PRESETS = {
    fast: { maxConcurrent: 8, batchItems: 200, batchChars: 24000, requestRetries: 1, requestTimeout: 20000, lightDom: true, hibernateDistance: 1.5, renderMargin: 0.4, relayoutInterval: 1000, scanSliceMs: 30, minTextLength: 2 },
    balanced: { maxConcurrent: 6, batchItems: 150, batchChars: 18000, requestRetries: 2, requestTimeout: 30000, lightDom: true, hibernateDistance: 2, renderMargin: 0.6, relayoutInterval: 700, scanSliceMs: 20, minTextLength: 1 },
    quality: { maxConcurrent: 4, batchItems: 100, batchChars: 12000, requestRetries: 3, requestTimeout: 45000, lightDom: false, hibernateDistance: 6, renderMargin: 1.5, relayoutInterval: 500, scanSliceMs: 12, minTextLength: 1 }
  };
  const applyPreset = (name) => { save(SPEED_PRESETS[name]); renderSettings(); flashStatus('پروفایل «' + (name === 'fast' ? 'سریع‌ترین' : name === 'balanced' ? 'متعادل' : 'دقیق‌ترین') + '» اعمال شد'); };
  $('presetFast').onclick = () => applyPreset('fast');
  $('presetBalanced').onclick = () => applyPreset('balanced');
  $('presetQuality').onclick = () => applyPreset('quality');

  /* موتور / AI */
  $('engine').onchange = (e) => {
    save({ engine: e.target.value });
    renderEngineRows();
    $('testResult').classList.add('hidden');
    $('testSteps').classList.add('hidden');
  };
  ['gcloudKey', 'deeplKey', 'msKey', 'msRegion', 'libreUrl', 'libreKey', 'llmKey', 'llmBaseUrl', 'llmModel',
    'llmSystemPrompt', 'glossary', 'llmExtraHeaders'].forEach((k) => {
    $(k).onchange = (e) => save({ [k]: e.target.value.trim() });
  });
  $('deeplFormality').onchange = (e) => save({ deeplFormality: e.target.value });
  $('llmPreset').onchange = (e) => {
    const p = PT_LLM_PRESETS[e.target.value];
    const patch = { llmPreset: e.target.value };
    if (p.baseUrl) patch.llmBaseUrl = p.baseUrl;
    if (p.model) patch.llmModel = p.model;
    save(patch);
    renderSettings();
    $('testResult').classList.add('hidden');
    $('testSteps').classList.add('hidden');
    if (p.note) flashTest('ℹ️ ' + p.note, '');
  };
  $('llmFormat').onchange = (e) => save({ llmFormat: e.target.value });
  num('llmTemperature', 'llmTemperature', 0, 2, 0);
  num('llmMaxTokens', 'llmMaxTokens', 0, 64000, 0);
  num('llmItems', 'llmItems', 1, 400, 100);
  num('llmChars', 'llmChars', 500, 60000, 9000);
  chk('fallbackToFree', 'fallbackToFree');
  chk('cacheEnabled', 'cacheEnabled', refreshCacheStats);
  chk('persistCache', 'persistCache', refreshCacheStats);
  num('cacheLimit', 'cacheLimit', 200, 200000, 20000);

  $('llmModelsBtn').onclick = async () => {
    const btn = $('llmModelsBtn');
    const patch = {};
    ['llmKey', 'llmBaseUrl', 'llmModel', 'llmExtraHeaders'].forEach((k) => { patch[k] = $(k).value.trim(); });
    patch.llmKey = patch.llmKey || settings.llmKey;
    await saveNow(patch);
    btn.disabled = true;
    flashTest('⏳ در حال دریافت لیست مدل‌ها…', '');
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'llm-models' }); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
    btn.disabled = false;
    if (res && res.ok) {
      fillModels(res.models);
      flashTest(`✅ ${res.models.length} مدل دریافت شد؛ از لیست زیر انتخاب کنید یا نام را دستی وارد کنید.`, 'ok');
    } else {
      flashTest('❌ ' + ((res && res.error) || 'خطای نامشخص'), 'bad');
    }
  };

  $('testBtn').onclick = async () => {
    const patch = {};
    ['gcloudKey', 'deeplKey', 'msKey', 'msRegion', 'libreUrl', 'libreKey', 'llmKey', 'llmBaseUrl', 'llmModel',
      'llmSystemPrompt', 'glossary', 'llmExtraHeaders'].forEach((k) => { patch[k] = $(k).value.trim(); });
    patch.llmTemperature = ptClamp($('llmTemperature').value, 0, 2, 0);
    patch.llmMaxTokens = ptClamp($('llmMaxTokens').value, 0, 64000, 0);
    patch.llmFormat = $('llmFormat').value;
    patch.llmItems = ptClamp($('llmItems').value, 1, 400, 100);
    patch.llmChars = ptClamp($('llmChars').value, 500, 60000, 9000);
    await saveNow(patch);
    const out = $('testResult'), steps = $('testSteps');
    $('testBtn').disabled = true;
    out.className = 'test'; out.textContent = '⏳ در حال تست…';
    steps.classList.add('hidden');
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'test-engine', deep: true }); }
    catch (e) { res = { ok: false, error: String(e.message || e) }; }
    $('testBtn').disabled = false;
    const stepList = (res && res.steps) || [];
    if (stepList.length) {
      steps.classList.remove('hidden');
      steps.innerHTML = stepList.map((s) => {
        const icon = s.ok ? '✅' : '❌';
        const ms = s.ms ? ` <span class="dim">(${ptFormatMs(s.ms)})</span>` : '';
        const info = s.info ? `<div class="stepInfo">${escapeHtml(s.info)}</div>` : '';
        const err = s.error ? `<div class="stepErr">${escapeHtml(s.error)}</div>` : '';
        return `<div class="step">${icon} ${escapeHtml(s.name)}${ms}${info}${err}</div>`;
      }).join('');
    }
    if (res && res.ok) {
      out.className = 'test ok';
      out.textContent = `✅ اتصال برقرار است (${ptFormatMs(res.ms)}) — نمونه: ${(res.sample || '').slice(0, 120)}`;
      if (res.warning) { out.className = 'test warn'; out.textContent += ' ⚠️ ' + res.warning; }
    } else {
      out.className = 'test bad';
      out.textContent = '❌ ' + ((res && res.error) || 'خطای نامشخص');
    }
  };

  $('cacheClear').onclick = async () => {
    try { await chrome.runtime.sendMessage({ type: 'cache-clear' }); } catch (e) { /* ignore */ }
    flashCacheStats('کش پاک شد.');
  };

  /* تصاویر */
  chk('translateImages', 'translateImages', renderSettings);
  chk('translateBackgroundImages', 'translateBackgroundImages');
  chk('ocrInvert', 'ocrInvert');
  chk('ocrSkipBlank', 'ocrSkipBlank');
  chk('ocrVisibleOnly', 'ocrVisibleOnly');
  $('ocrLang').onchange = (e) => save({ ocrLang: e.target.value });
  $('ocrQuality').onchange = (e) => save({ ocrQuality: e.target.value });
  $('ocrParallel').onchange = (e) => save({ ocrParallel: +e.target.value });
  num('ocrMaxDim', 'ocrMaxDim', 600, 4000, 1800);
  num('ocrCacheLimit', 'ocrCacheLimit', 50, 2000, 400);
  num('ocrTimeout', 'ocrTimeout', 5, 300, 45);
  $('ocrMinConfidence').oninput = (e) => { $('confVal').textContent = e.target.value; };
  $('ocrMinConfidence').onchange = (e) => save({ ocrMinConfidence: +e.target.value });

  /* ظاهر */
  document.querySelectorAll('input[name=boxColorMode]').forEach((r) => {
    r.onchange = () => save({ boxColorMode: r.value });
  });
  document.querySelectorAll('input[name=textColorMode]').forEach((r) => {
    r.onchange = () => save({ textColorMode: r.value });
  });
  $('boxColor').onchange = (e) => { save({ boxColor: e.target.value, boxColorMode: 'custom' }); renderSettings(); };
  $('textColor').onchange = (e) => { save({ textColor: e.target.value, textColorMode: 'custom' }); renderSettings(); };
  $('boxOpacity').oninput = (e) => { $('opacityVal').textContent = Math.round(e.target.value * 100); };
  $('boxOpacity').onchange = (e) => save({ boxOpacity: +e.target.value });
  $('fontScale').oninput = (e) => { $('fontScaleVal').textContent = e.target.value; };
  $('fontScale').onchange = (e) => save({ fontScale: +e.target.value });
  num('boxPadding', 'boxPadding', 0, 12, 1);
  num('boxRadius', 'boxRadius', 0, 20, 2);
  $('fontFamily').onchange = (e) => save({ fontFamily: e.target.value.trim() });
  $('forceRtl').onchange = (e) => save({ forceRtl: e.target.value });

  /* پیشرفته */
  ['translateInputs', 'translateInlineCode', 'translateCodeBlocks', 'respectNoTranslate', 'autoTranslate', 'diagnostics'].forEach((k) => chk(k, k));
  $('skipSelectors').onchange = (e) => save({ skipSelectors: e.target.value.trim() });
  $('diagRefresh').onclick = refreshDiag;
  $('exportBtn').onclick = exportSettings;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = importSettings;
  $('resetBtn').onclick = async () => {
    if (!confirm('همه‌ی تنظیمات به حالت پیش‌فرض برگردد؟')) return;
    await chrome.storage.sync.set(PT_DEFAULTS);
    settings = Object.assign({}, PT_DEFAULTS);
    renderSettings();
    flashStatus('تنظیمات پیش‌فرض بازگردانده شد');
  };

  /* ضبط شورتکات */
  $('shortcutBtn').onclick = () => {
    recording = true;
    $('shortcutBtn').classList.add('recording');
    $('shortcutBtn').textContent = 'کلیدها را فشار دهید… (Esc = لغو)';
  };
  $('shortcutReset').onclick = () => { save({ shortcut: PT_DEFAULTS.shortcut }); renderSettings(); };
  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === 'Escape') { stopRecording(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return;
    const hasMod = e.ctrlKey || e.altKey || e.metaKey;
    const isFKey = /^F\d{1,2}$/.test(e.code);
    if (!hasMod && !isFKey) { $('shortcutBtn').textContent = 'حداقل یک Ctrl / Alt لازم است (یا F1..F12)'; return; }
    const key = e.code.replace(/^Key/, '').replace(/^Digit/, '');
    save({ shortcut: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code, key } });
    stopRecording();
  }, true);
  $('openShortcuts').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
}

function stopRecording() {
  recording = false;
  $('shortcutBtn').classList.remove('recording');
  renderSettings();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function flashStatus(msg) { $('status').textContent = msg; }
function flashTest(msg, cls) {
  const out = $('testResult');
  out.className = 'test ' + (cls || '');
  out.textContent = msg;
  out.classList.remove('hidden');
}
function flashCacheStats(msg) {
  $('cacheStats').textContent = msg || '';
  if (!msg) refreshCacheStats();
}

/* ---------------------------------- وضعیت تب ---------------------------------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function tabStatus() {
  const tab = await activeTab();
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 }); } catch (e) { return null; }
}
async function toggleTab() {
  const tab = await activeTab();
  if (!tab) return null;
  try { return await chrome.runtime.sendMessage({ type: 'toggle-tab', tabId: tab.id, action: 'toggle' }); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function renderStatus(st) {
  const btn = $('startBtn');
  if (!st || !st.ok) {
    btn.textContent = '▶ شروع ترجمه صفحه';
    btn.classList.remove('stop');
    $('progress').classList.add('hidden');
    $('status').textContent = 'آماده';
    if (st && st.error) { $('error').textContent = st.error; $('error').classList.remove('hidden'); }
    return;
  }
  $('error').classList.add('hidden');
  if (st.active) {
    btn.textContent = '■ توقف و نمایش متن اصلی';
    btn.classList.add('stop');
    $('progress').classList.remove('hidden');
    const total = st.textTotal + st.imgTotal;
    const done = st.textDone + st.imgDone;
    $('barFill').style.width = (total ? Math.round(done * 100 / total) : 100) + '%';
    const rate = st.rate ? `  •  ${st.rate} متن/ثانیه` : '';
    $('progressText').textContent = `متن‌ها: ${st.textDone}/${st.textTotal}` +
      (settings.translateImages ? `  •  تصاویر: ${st.imgDone}/${st.imgTotal}` : '') +
      (st.imgFail ? `  •  ${st.imgFail} عکس خوانده نشد` : '') + rate +
      (st.textSkipped ? `  •  هم‌زبان مقصد: ${st.textSkipped}` : '');
    $('status').textContent = st.scanning ? 'در حال اسکن صفحه…' : (done >= total ? 'ترجمه کامل شد' : 'در حال ترجمه…');
    if (st.waitingCapture) $('progressText').textContent += `  •  ${st.waitingCapture} عکس با اسکرول`;
  } else {
    btn.textContent = '▶ شروع ترجمه صفحه';
    btn.classList.remove('stop');
    $('progress').classList.add('hidden');
    $('status').textContent = 'آماده — شورتکات: ' + ptShortcutLabel(settings.shortcut);
  }
}

/* ---------------------------------- کش و عیب‌یابی ---------------------------------- */
async function refreshCacheStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'cache-stats' });
    if (res && res.ok) {
      const s = res.stats;
      $('cacheStats').textContent = `${s.entries.toLocaleString('fa-IR')} ترجمه — ${(s.bytes / 1048576).toFixed(1)} مگابایت`;
    }
  } catch (e) { $('cacheStats').textContent = '—'; }
}

async function refreshDiag() {
  const box = $('diagBox');
  box.textContent = 'در حال خواندن…';
  let sw = null, page = null;
  try { sw = await chrome.runtime.sendMessage({ type: 'diag' }); } catch (e) { sw = null; }
  const tab = await activeTab();
  if (tab) {
    try { page = await chrome.tabs.sendMessage(tab.id, { type: 'diag-content' }, { frameId: 0 }); } catch (e) { page = null; }
  }
  let cache = null;
  try { cache = await chrome.runtime.sendMessage({ type: 'cache-stats' }); } catch (e) { cache = null; }
  lastDiag = { sw, page, cache };
  const d = (sw && sw.diag) || {};
  const lines = [
    `نسخه: ${d.version || PT_VERSION}   موتور: ${d.engine || '—'} ${d.model ? '(' + d.model + ')' : ''}`,
    `درخواست‌ها: ${d.requests || 0}   ناموفق: ${d.failures || 0}   تلاش دوباره: ${d.retries || 0}`,
    `میانگین پاسخ: ${ptFormatMs(d.avgMs)}   آخرین: ${ptFormatMs(d.lastMs)}   متن‌ها: ${d.texts || 0}`,
    `کش: ${(d.cacheEntries || 0).toLocaleString('fa-IR')} از ${(d.cacheLimit || 0).toLocaleString('fa-IR')}` +
      (cache && cache.ok ? ` (${(cache.stats.bytes / 1048576).toFixed(1)}MB، ${cache.stats.evicted} حذف‌شده)` : ''),
    `اسلات‌های فعال: ${d.active || 0}/${d.slots || 0}   fallback رایگان: ${d.gtxFallbacks || 0}`,
    d.htmlBlockedUntil ? `سرویس سریع Google تا ${new Date(d.htmlBlockedUntil).toLocaleTimeString('fa-IR')} غیرفعال است (از gtx استفاده می‌شود)` : 'سرویس سریع Google: فعال',
    `OCR: ${d.ocr || 0} تصویر در ${ptFormatMs(d.ocrMs)}`,
    d.lastError ? `آخرین خطا: ${d.lastError}` : 'بدون خطا',
    '',
    page ? `این تب: ${page.active ? 'روشن' : 'خاموش'} — ${page.scope}   آیتم‌ها: ${page.items}   در انتظار: ${page.pending}   در حال ارسال: ${page.inflight}` : 'این تب: content script پاسخ نداد (صفحه را رفرش کنید)',
    page ? `کادرهای ساخته‌شده: ${page.rendered}   صف اسکن: ${page.blocks}   صف تصاویر: ${page.imageQueue}   سرعت: ${page.rate || 0} متن/ثانیه` : ''
  ];
  box.textContent = lines.filter((l) => l !== null).join('\n');
}

function exportSettings() {
  const data = JSON.stringify({ version: PT_VERSION, settings }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'page-translator-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importSettings(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const obj = JSON.parse(fr.result);
      const patch = Object.assign({}, PT_DEFAULTS, obj.settings || obj);
      await chrome.storage.sync.set(patch);
      settings = patch;
      renderSettings();
      flashStatus('تنظیمات بازیابی شد');
    } catch (err) {
      alert('فایل تنظیمات معتبر نیست: ' + err.message);
    }
  };
  fr.readAsText(file);
  e.target.value = '';
}

/* ---------------------------------- شروع ---------------------------------- */
async function init() {
  fillLangSelects();
  settings = Object.assign({}, PT_DEFAULTS, await chrome.storage.sync.get(PT_DEFAULTS));
  renderSettings();
  bindSettings();

  $('startBtn').onclick = async () => {
    const res = await toggleTab();
    if (res && !res.ok) { renderStatus(res); return; }
    setTimeout(async () => renderStatus(await tabStatus()), 150);
  };

  const poll = async () => renderStatus(await tabStatus());
  poll();
  refreshCacheStats();
  setInterval(poll, 700);
}

init();
