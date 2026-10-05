/* defaults.js — تنظیمات پیش‌فرض، پیش‌تنظیم‌های سرویس‌ها و توابع کمکی مشترک
   این فایل در popup، background (importScripts) و content script بارگذاری می‌شود،
   پس نباید در سطح ماژول به chrome یا document دست بزند. */

var PT_VERSION = '2.1.1';

var PT_DEFAULTS = {
  /* ---------- عمومی ---------- */
  scope: 'auto',              // view = فقط بخش دیدنی | auto = اول دیدنی، بعد کل صفحه | site = کل صفحه
  sourceLang: 'auto',
  targetLang: 'fa',
  shortcut: { ctrl: false, alt: true, shift: true, meta: false, code: 'KeyT', key: 'T' },
  autoTranslate: false,       // ترجمه‌ی خودکار همه‌ی سایت‌ها
  dynamicContent: true,       // ترجمه‌ی محتوای تازه (SPA، اسکرول بی‌نهایت، منوها)
  respectNoTranslate: false,  // احترام به translate="no" / class="notranslate"
  translateInputs: true,      // دکمه‌های فرم و placeholder
  translateInlineCode: true,  // کد داخل جمله (<code>)
  translateCodeBlocks: false, // بلوک‌های کد (<pre>)
  skipSelectors: '',          // سلکتورهای CSS که نباید ترجمه شوند (با کاما)
  minTextLength: 1,           // متن‌های کوتاه‌تر از این تعداد حرف نادیده گرفته می‌شوند
  skipTargetScript: true,     // متنی که همین حالا به زبان مقصد است ترجمه نشود
  toastEnabled: true,

  /* ---------- سرعت ---------- */
  maxConcurrent: 6,           // حداکثر درخواست هم‌زمان
  batchItems: 150,            // حداکثر متن در هر درخواست
  batchChars: 18000,          // حداکثر کاراکتر در هر درخواست
  requestTimeout: 30000,      // مهلت هر درخواست (ms)
  requestRetries: 2,          // تعداد تلاش دوباره
  requestDelay: 0,            // تأخیر بین درخواست‌ها (ms) — برای سرویس‌های محدود
  lightDom: true,             // کادرهای دور از دید ساخته نشوند (DOM سبک)
  hibernateDistance: 2,       // چند برابر ارتفاع صفحه دورتر = حذف کادر (viewport)
  renderMargin: 0.6,          // تا این فاصله بیرون از دید هم کادر ساخته می‌شود (viewport)
  relayoutInterval: 700,      // فاصله‌ی بررسی دوره‌ای صفحه (ms)
  scanSliceMs: 20,            // زمان هر تکه اسکن (ms)

  /* ---------- موتور ترجمه ---------- */
  engine: 'google',           // google | gtx | gcloud | deepl | microsoft | libre | llm
  gcloudKey: '',
  deeplKey: '',
  deeplFormality: 'default',  // default | prefer_more | prefer_less
  msKey: '',
  msRegion: 'global',
  libreUrl: 'https://libretranslate.com',
  libreKey: '',
  llmPreset: 'openai',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmModel: 'gpt-4o-mini',
  llmKey: '',
  llmTemperature: 0,
  llmFormat: 'delimiter',     // delimiter (سازگارتر و سریع‌تر) | json
  llmMaxTokens: 0,            // 0 = خودکار
  llmItems: 100,              // حداکثر متن در هر درخواست AI
  llmChars: 9000,
  llmExtraHeaders: '',        // هر خط: Header: value
  llmSystemPrompt: '',        // دستور اضافی برای مدل
  glossary: '',               // هر خط: واژه=ترجمه
  fallbackToFree: true,       // اگر سرویس کلیددار خطا داد با Google رایگان ادامه بده

  /* ---------- کش ---------- */
  cacheEnabled: true,
  persistCache: true,         // کش روی دیسک (بین نشست‌ها و بعد از خواب service worker)
  cacheLimit: 20000,          // حداکثر تعداد ترجمه‌ی ذخیره‌شده

  /* ---------- تصاویر و OCR ---------- */
  translateImages: true,
  translateBackgroundImages: true,
  ocrLang: 'auto',
  ocrQuality: 'best',         // best = چندمرحله‌ای | fast = یک‌مرحله‌ای
  ocrParallel: 2,
  ocrMinConfidence: 40,
  ocrInvert: true,
  ocrMaxDim: 1800,            // بزرگ‌ترین ضلع تصویر ورودی OCR (بزرگ‌تر = دقیق‌تر و کندتر)
  ocrSkipBlank: true,         // رد کردن سریع تصاویر بدون متن (تزئینی)
  ocrVisibleOnly: false,      // فقط عکس‌های داخل دید
  ocrCacheLimit: 400,
  ocrTimeout: 45,             // مهلت هر تصویر (ثانیه)؛ اگر OCR گیر کند، بقیه‌ی عکس‌ها معطل نمانند

  /* ---------- ظاهر ---------- */
  boxColorMode: 'custom',     // custom | auto
  boxColor: '#ffffff',
  textColorMode: 'auto',      // auto | custom
  textColor: '#111111',
  boxOpacity: 1,              // شفافیت کادر ترجمه
  fontScale: 100,             // درصد اندازه‌ی فونت ترجمه
  boxPadding: 1,              // فاصله‌ی افقی داخلی کادر (px)
  boxRadius: 2,               // گردی گوشه‌ی کادر (px)
  fontFamily: '',             // فونت دلخواه ترجمه (خالی = فونت خود سایت)
  forceRtl: 'auto',           // auto | on | off

  /* ---------- عیب‌یابی ---------- */
  diagnostics: false          // نمایش ریز زمان‌بندی‌ها در کنسول
};

/* زبان‌ها (کد گوگل، نام فارسی) */
var PT_LANGUAGES = [
  ['auto', 'تشخیص خودکار'],
  ['en', 'انگلیسی'], ['fa', 'فارسی'], ['ar', 'عربی'], ['fr', 'فرانسوی'],
  ['de', 'آلمانی'], ['es', 'اسپانیایی'], ['it', 'ایتالیایی'], ['pt', 'پرتغالی'],
  ['ru', 'روسی'], ['tr', 'ترکی استانبولی'], ['zh-CN', 'چینی (ساده)'], ['zh-TW', 'چینی (سنتی)'],
  ['ja', 'ژاپنی'], ['ko', 'کره‌ای'], ['hi', 'هندی'], ['ur', 'اردو'], ['nl', 'هلندی'],
  ['pl', 'لهستانی'], ['uk', 'اوکراینی'], ['sv', 'سوئدی'], ['el', 'یونانی'], ['he', 'عبری'],
  ['id', 'اندونزیایی'], ['ms', 'مالایی'], ['th', 'تایلندی'], ['vi', 'ویتنامی'],
  ['az', 'آذربایجانی'], ['hy', 'ارمنی'], ['ka', 'گرجی'], ['ps', 'پشتو'], ['ckb', 'کردی سورانی'],
  ['ro', 'رومانیایی'], ['cs', 'چکی'], ['hu', 'مجاری'], ['da', 'دانمارکی'], ['fi', 'فنلاندی'],
  ['no', 'نروژی'], ['bg', 'بلغاری'], ['sr', 'صربی'], ['hr', 'کروات'], ['sk', 'اسلواک'],
  ['sl', 'اسلوونیایی'], ['lt', 'لیتوانیایی'], ['lv', 'لتونیایی'], ['et', 'استونیایی'],
  ['sq', 'آلبانیایی'], ['bs', 'بوسنیایی'], ['mk', 'مقدونی'], ['be', 'بلاروسی'],
  ['kk', 'قزاقی'], ['ky', 'قرقیزی'], ['uz', 'ازبکی'], ['tg', 'تاجیکی'], ['mn', 'مغولی'],
  ['bn', 'بنگالی'], ['ta', 'تامیلی'], ['te', 'تلوگو'], ['mr', 'مراتی'], ['gu', 'گجراتی'],
  ['kn', 'کانادا'], ['ml', 'مالایالام'], ['pa', 'پنجابی'], ['ne', 'نپالی'], ['si', 'سینهالی'],
  ['my', 'برمه‌ای'], ['km', 'خمر'], ['lo', 'لائو'], ['am', 'امهری'], ['sw', 'سواحیلی'],
  ['af', 'آفریکانس'], ['fil', 'فیلیپینی'], ['yi', 'یدی'], ['ku', 'کردی کرمانجی'], ['gl', 'گالیسی'],
  ['eu', 'باسکی'], ['ca', 'کاتالان'], ['is', 'ایسلندی'], ['ga', 'ایرلندی'], ['cy', 'ولزی'],
  ['la', 'لاتین'], ['eo', 'اسپرانتو'], ['mt', 'مالتی'], ['tl', 'تاگالوگ']
];

/* نگاشت کد زبان گوگل → کد زبان Tesseract (برای OCR) */
var PT_OCR_LANGS = {
  en: 'eng', fa: 'fas', ar: 'ara', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por',
  ru: 'rus', tr: 'tur', 'zh-CN': 'chi_sim', 'zh-TW': 'chi_tra', ja: 'jpn', ko: 'kor',
  hi: 'hin', ur: 'urd', nl: 'nld', pl: 'pol', uk: 'ukr', sv: 'swe', el: 'ell', he: 'heb',
  id: 'ind', ms: 'msa', th: 'tha', vi: 'vie', az: 'aze', hy: 'hye', ka: 'kat', ps: 'pus',
  ckb: 'ckb', ro: 'ron', cs: 'ces', hu: 'hun', da: 'dan', fi: 'fin', no: 'nor',
  bg: 'bul', sr: 'srp', hr: 'hrv', sk: 'slk', sl: 'slv', lt: 'lit', lv: 'lav', et: 'est',
  sq: 'sqi', bs: 'bos', mk: 'mkd', be: 'bel', kk: 'kaz', ky: 'kir', uz: 'uzb', tg: 'tgk',
  mn: 'mon', bn: 'ben', ta: 'tam', te: 'tel', mr: 'mar', gu: 'guj', kn: 'kan', ml: 'mal',
  pa: 'pan', ne: 'nep', si: 'sin', my: 'mya', km: 'khm', lo: 'lao', am: 'amh', sw: 'swa',
  af: 'afr', fil: 'fil', yi: 'yid', ku: 'kur', gl: 'glg', eu: 'eus', ca: 'cat', is: 'isl',
  ga: 'gle', cy: 'cym', la: 'lat', eo: 'epo', mt: 'mlt', tl: 'tgl'
};

var PT_RTL = ['fa', 'ar', 'he', 'ur', 'ps', 'ckb', 'yi', 'sd', 'ug', 'dv'];

/* خط‌های هر زبان — برای تشخیص «متن همین حالا به زبان مقصد است» */
var PT_LANG_SCRIPTS = {
  en: ['latin'], fr: ['latin'], de: ['latin'], es: ['latin'], it: ['latin'], pt: ['latin'],
  nl: ['latin'], pl: ['latin'], sv: ['latin'], da: ['latin'], no: ['latin'], fi: ['latin'],
  ro: ['latin'], cs: ['latin'], hu: ['latin'], tr: ['latin'], az: ['latin'], id: ['latin'],
  ms: ['latin'], vi: ['latin'], af: ['latin'], fil: ['latin'], tl: ['latin'], gl: ['latin'],
  eu: ['latin'], ca: ['latin'], is: ['latin'], ga: ['latin'], cy: ['latin'], la: ['latin'],
  eo: ['latin'], mt: ['latin'], sw: ['latin'], hr: ['latin'], sl: ['latin'], sk: ['latin'],
  lt: ['latin'], lv: ['latin'], et: ['latin'], sq: ['latin'], bs: ['latin'],
  fa: ['arabic'], ar: ['arabic'], ur: ['arabic'], ps: ['arabic'], ckb: ['arabic'],
  ku: ['arabic', 'latin'], he: ['hebrew'], yi: ['hebrew'],
  ru: ['cyrillic'], uk: ['cyrillic'], bg: ['cyrillic'], sr: ['cyrillic'], mk: ['cyrillic'],
  be: ['cyrillic'], kk: ['cyrillic'], ky: ['cyrillic'], mn: ['cyrillic'], tg: ['cyrillic'],
  el: ['greek'], hy: ['armenian'], ka: ['georgian'],
  hi: ['devanagari'], mr: ['devanagari'], ne: ['devanagari'],
  bn: ['bengali'], ta: ['tamil'], te: ['telugu'], gu: ['gujarati'], kn: ['kannada'],
  ml: ['malayalam'], pa: ['gurmukhi'], si: ['sinhala'],
  th: ['thai'], lo: ['lao'], km: ['khmer'], my: ['myanmar'], am: ['ethiopic'],
  'zh-CN': ['cjk'], 'zh-TW': ['cjk'], zh: ['cjk'], ja: ['cjk', 'kana'], ko: ['hangul'],
  uz: ['latin', 'cyrillic']
};

/* نام انگلیسی زبان‌ها (برای پرامپت مدل‌های هوش مصنوعی) */
var PT_LANG_EN = {
  auto: 'the detected source language', en: 'English', fa: 'Persian (Farsi)', ar: 'Arabic',
  fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
  tr: 'Turkish', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', ja: 'Japanese',
  ko: 'Korean', hi: 'Hindi', ur: 'Urdu', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  sv: 'Swedish', el: 'Greek', he: 'Hebrew', id: 'Indonesian', ms: 'Malay', th: 'Thai',
  vi: 'Vietnamese', az: 'Azerbaijani', hy: 'Armenian', ka: 'Georgian', ps: 'Pashto',
  ckb: 'Central Kurdish (Sorani)', ro: 'Romanian', cs: 'Czech', hu: 'Hungarian',
  da: 'Danish', fi: 'Finnish', no: 'Norwegian', bg: 'Bulgarian', sr: 'Serbian', hr: 'Croatian',
  sk: 'Slovak', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian',
  sq: 'Albanian', bs: 'Bosnian', mk: 'Macedonian', be: 'Belarusian', kk: 'Kazakh',
  ky: 'Kyrgyz', uz: 'Uzbek', tg: 'Tajik', mn: 'Mongolian', bn: 'Bengali', ta: 'Tamil',
  te: 'Telugu', mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam',
  pa: 'Punjabi', ne: 'Nepali', si: 'Sinhala', my: 'Burmese', km: 'Khmer', lo: 'Lao',
  am: 'Amharic', sw: 'Swahili', af: 'Afrikaans', fil: 'Filipino', yi: 'Yiddish',
  ku: 'Kurdish (Kurmanji)', gl: 'Galician', eu: 'Basque', ca: 'Catalan', is: 'Icelandic',
  ga: 'Irish', cy: 'Welsh', la: 'Latin', eo: 'Esperanto', mt: 'Maltese', tl: 'Tagalog'
};

/* مشخصات فنی هر موتور: اندازه‌ی دسته، هم‌زمانی، مهلت، کلید لازم */
var PT_ENGINE_INFO = {
  google:    { name: 'Google رایگان — سریع', items: 120, chars: 18000, conc: 6, timeout: 25000, retries: 2, free: true },
  gtx:       { name: 'Google رایگان — روش جایگزین (gtx)', items: 100, chars: 6000, conc: 6, timeout: 20000, retries: 3, free: true },
  gcloud:    { name: 'Google Cloud Translation', items: 100, chars: 25000, conc: 4, timeout: 30000, retries: 2, key: 'gcloudKey' },
  deepl:     { name: 'DeepL', items: 50, chars: 25000, conc: 4, timeout: 30000, retries: 2, key: 'deeplKey' },
  microsoft: { name: 'Microsoft Translator (Azure)', items: 90, chars: 20000, conc: 4, timeout: 30000, retries: 2, key: 'msKey' },
  libre:     { name: 'LibreTranslate', items: 50, chars: 12000, conc: 3, timeout: 30000, retries: 2, key: 'libreUrl' },
  llm:       { name: 'هوش مصنوعی (OpenAI-compatible)', items: 100, chars: 9000, conc: 5, timeout: 90000, retries: 2, key: 'llmKey' }
};

/* پیش‌تنظیم‌های سرویس‌های سازگار با OpenAI (و چند سرویس بومی ایران) */
var PT_LLM_PRESETS = {
  openai:     { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', json: true },
  gemini:     { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', json: true },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', json: true },
  deepseek:   { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', json: true },
  groq:       { name: 'Groq (خیلی سریع)', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', json: true },
  cerebras:   { name: 'Cerebras (خیلی سریع)', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', json: true },
  mistral:    { name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', json: true },
  xai:        { name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', model: 'grok-3-mini', json: true },
  together:   { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', json: true },
  moonshot:   { name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.ai/v1', model: 'moonshot-v1-8k', json: true },
  qwen:       { name: 'Qwen / DashScope', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', json: true },
  zhipu:      { name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', json: true },
  novita:     { name: 'Novita AI', baseUrl: 'https://api.novita.ai/v3/openai', model: 'deepseek/deepseek-v3', json: true },
  anthropic:  { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', json: false },
  azure:      { name: 'Azure OpenAI', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT', model: '', json: true, note: 'آدرس را کامل وارد کنید؛ در صورت نیاز ?api-version=2024-10-21 خودکار اضافه می‌شود.' },
  ollama:     { name: 'Ollama (روی سیستم خودتان)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', json: false, note: 'باید Ollama با متغیر OLLAMA_ORIGINS=* اجرا شده باشد.' },
  lmstudio:   { name: 'LM Studio (لوکال)', baseUrl: 'http://localhost:1234/v1', model: '', json: false },
  vllm:       { name: 'vLLM / سرور اختصاصی', baseUrl: 'http://localhost:8000/v1', model: '', json: false },
  avalai:     { name: 'AvalAI (ایران)', baseUrl: 'https://api.avalai.ir/v1', model: 'gpt-4o-mini', json: true, note: 'نسخه‌ی داخلی: https://api.avalapis.ir/v1' },
  metis:      { name: 'Metis AI (ایران)', baseUrl: 'https://api.metisai.ir/openai/v1', model: 'gpt-4o-mini', json: true },
  gapgpt:     { name: 'GapGPT (ایران)', baseUrl: 'https://api.gapgpt.app/v1', model: 'gpt-4o-mini', json: true },
  custom:     { name: 'سفارشی (هر سرویس سازگار با OpenAI)', baseUrl: '', model: '', json: false }
};

/* ============================== توابع کمکی ============================== */

function ptShortcutLabel(sc) {
  if (!sc || !sc.code) return '—';
  var p = [];
  if (sc.ctrl) p.push('Ctrl');
  if (sc.alt) p.push('Alt');
  if (sc.shift) p.push('Shift');
  if (sc.meta) p.push('Meta');
  p.push(sc.key || sc.code);
  return p.join(' + ');
}

function ptClamp(v, lo, hi, def) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, v));
}

function ptErrText(e) {
  if (!e) return 'خطای نامشخص';
  return String(e.message || e);
}

/* متن‌ها را به دسته‌های مناسب هر سرویس می‌شکند */
function ptChunkTexts(texts, maxItems, maxChars) {
  var chunks = [];
  var cur = null;
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i];
    if (!cur || cur.items.length >= maxItems || (cur.chars + t.length > maxChars && cur.items.length)) {
      cur = { start: i, items: [], chars: 0 };
      chunks.push(cur);
    }
    cur.items.push(t);
    cur.chars += t.length;
  }
  return chunks;
}

/* آدرس پایه را تمیز می‌کند (http اضافه می‌کند، اسلش آخر را برمی‌دارد) */
function ptNormalizeBaseUrl(raw) {
  var u = String(raw || '').trim().replace(/\s+/g, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function ptIsAzureUrl(url) { return /\.openai\.azure\.com/i.test(url || ''); }

/* آدرس نهایی chat/completions؛ اگر کاربر آدرس کامل داده باشد دست نمی‌زنیم.
   برای Azure، مسیر /chat/completions و api-version خودکار اضافه می‌شود. */
function ptChatUrl(baseUrl) {
  var u = ptNormalizeBaseUrl(baseUrl);
  if (!u) return '';
  var azure = ptIsAzureUrl(u);
  if (/\/chat\/completions/i.test(u)) {
    if (azure && !/api-version=/i.test(u)) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'api-version=2024-10-21';
    return u;
  }
  if (azure) {
    if (!/\/deployments\/[^/]+/i.test(u)) u += '/openai/deployments/YOUR-DEPLOYMENT';
    return u + '/chat/completions?api-version=2024-10-21';
  }
  return u + '/chat/completions';
}

/* آدرس لیست مدل‌ها (برای دکمه‌ی «دریافت لیست مدل‌ها») */
function ptModelsUrl(baseUrl) {
  var u = ptNormalizeBaseUrl(baseUrl);
  if (!u) return '';
  if (/\/chat\/completions/i.test(u)) u = u.replace(/\/chat\/completions.*$/i, '');
  if (ptIsAzureUrl(u)) return '';
  return u + '/models';
}

/* هدرهای احراز هویت بر اساس نوع سرویس (Azure از api-key استفاده می‌کند) */
function ptAuthHeaders(baseUrl, key) {
  var h = { 'Content-Type': 'application/json' };
  if (ptIsAzureUrl(baseUrl)) h['api-key'] = key;
  else h['Authorization'] = 'Bearer ' + key;
  return h;
}

/* «Header: value» های دلخواه کاربر */
function ptParseExtraHeaders(text) {
  var out = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\s*([A-Za-z0-9-_.]+)\s*[:=]\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

/* مدل‌هایی که temperature/max_tokens را قبول نمی‌کنند (مدل‌های استدلالی) */
function ptIsReasoningModel(model) {
  return /^(o\d|gpt-5|gpt-6|deepseek-reasoner|deepseek-r\d|qwq|magistral)/i.test(String(model || '').trim());
}

/* خط‌های یونیکد → تشخیص خط غالب متن (برای رد کردن متنِ هم‌زبان با مقصد) */
var PT_SCRIPT_TESTS = [
  ['arabic', /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g],
  ['hebrew', /[\u0590-\u05FF\uFB1D-\uFB4F]/g],
  ['cyrillic', /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF]/g],
  ['greek', /[\u0370-\u03FF\u1F00-\u1FFF]/g],
  ['armenian', /[\u0530-\u058F]/g],
  ['georgian', /[\u10A0-\u10FF\u2D00-\u2D2F]/g],
  ['devanagari', /[\u0900-\u097F]/g],
  ['bengali', /[\u0980-\u09FF]/g],
  ['gurmukhi', /[\u0A00-\u0A7F]/g],
  ['gujarati', /[\u0A80-\u0AFF]/g],
  ['tamil', /[\u0B80-\u0BFF]/g],
  ['telugu', /[\u0C00-\u0C7F]/g],
  ['kannada', /[\u0C80-\u0CFF]/g],
  ['malayalam', /[\u0D00-\u0D7F]/g],
  ['sinhala', /[\u0D80-\u0DFF]/g],
  ['thai', /[\u0E00-\u0E7F]/g],
  ['lao', /[\u0E80-\u0EFF]/g],
  ['myanmar', /[\u1000-\u109F]/g],
  ['ethiopic', /[\u1200-\u137F]/g],
  ['khmer', /[\u1780-\u17FF]/g],
  ['hangul', /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g],
  ['kana', /[\u3040-\u30FF]/g],
  ['cjk', /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g],
  ['latin', /[A-Za-z\u00C0-\u024F\u1D00-\u1D7F\u1E00-\u1EFF\u2C60-\u2C7F]/g]
];

/* خط غالب متن: { script, ratio } — برای سرعت حداکثر ۴۰۰ حرف اول بررسی می‌شود */
function ptDominantScript(text) {
  var s = String(text || '');
  if (s.length > 400) s = s.slice(0, 400);
  var counts = {}, total = 0, best = '', bestN = 0;
  for (var i = 0; i < PT_SCRIPT_TESTS.length; i++) {
    var name = PT_SCRIPT_TESTS[i][0];
    var m = s.match(PT_SCRIPT_TESTS[i][1]);
    if (m && m.length) {
      counts[name] = m.length;
      total += m.length;
      if (m.length > bestN) { bestN = m.length; best = name; }
    }
  }
  if (!total) return { script: '', ratio: 0 };
  return { script: best, ratio: bestN / total };
}

function ptScriptsForLang(lang) {
  if (!lang) return null;
  return PT_LANG_SCRIPTS[lang] || PT_LANG_SCRIPTS[String(lang).split('-')[0]] || null;
}

/* آیا این متن همین حالا به زبان مقصد است؟ (تا بی‌خودی ترجمه/رسم نشود) */
function ptIsSameAsTarget(text, targetLang, sourceLang) {
  var tScripts = ptScriptsForLang(targetLang);
  if (!tScripts) return false;
  var d = ptDominantScript(text);
  if (!d.script || d.ratio < 0.7) return false;
  if (tScripts.indexOf(d.script) < 0) return false;
  if (sourceLang && sourceLang !== 'auto') {
    var sScripts = ptScriptsForLang(sourceLang);
    // اگر متن به خط زبان مبدأ است، ترجمه‌اش می‌کنیم (کاربر آن را خواسته)
    if (sScripts && sScripts.indexOf(d.script) >= 0) return false;
  }
  return true;
}

/* کد زبان OCR بر اساس تنظیمات */
function ptOcrLangFor(settings) {
  if (settings && settings.ocrLang && settings.ocrLang !== 'auto') return settings.ocrLang;
  return PT_OCR_LANGS[(settings && settings.sourceLang) || 'auto'] || 'eng';
}

function ptIsRtlLang(lang) {
  return PT_RTL.indexOf(String(lang || '').split('-')[0]) >= 0;
}

function ptFormatMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
}
