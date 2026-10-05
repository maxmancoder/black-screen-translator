# black-screen-translator

افزونه‌ی کروم «مترجم صفحه و تصاویر» — ترجمه‌ی زنده‌ی متن صفحه و متن داخل عکس‌ها (OCR با Tesseract) از هر زبانی به هر زبانی.

- **کد افزونه:** پوشه‌ی [`black translate/`](black%20translate/) (برای نصب: `chrome://extensions` ← Developer mode ← **Load unpacked**)
- **بسته‌ی فشرده:** `black translate.zip` (همان پوشه، برای نصب سریع)
- **راهنما و تنظیمات:** [`black translate/README.md`](black%20translate/README.md)

## تست‌ها
```bash
cd "black translate"
node tools/selftest.js    # منطق خالص (۱۵۱ تست)
node tools/domsmoke.js    # اسکن → ترجمه → رسم کادر
node tools/imgsmoke.js    # مسیر واقعی عکس‌ها (صف OCR، اسکرول، ری‌استارت، OCR گیرکرده)
node tools/ocrsmoke.js    # پول Worker در offscreen.js
```

## نسخه‌ی ۲.۱.۱
رفع نقص «فقط یک عکس ترجمه می‌شود»: خطای `stop()`، نشت اسلات هم‌زمانی OCR، نبود مهلت روی درخواست OCR، و قفل‌شدن پول Worker در `offscreen.js`. جزئیات در [`black translate/README.md`](black%20translate/README.md).
