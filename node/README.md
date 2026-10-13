# 🧠 Ai-Free Node — البوابة الذكية جداً داخل Node.js

نسخة Node.js خالصة **بدون أي مكتبات خارجية** (http + crypto + sqlite كلها مدمجة في Node 22+).
نفس منطق دمج المستودعات الخمسة، لكن بطبقة ذكاء إضافية.

## ما الذي يجعلها "ذكية جداً"؟ (الفرق عن نسخة Python)

| الميزة الذكية | أين | كيف تعمل |
|---|---|---|
| 🧠 Adaptive Cooldown | `src/brain.js` → `observeProvider` | يتعلّم `ema_latency` و `r429_rate` لكل مزود ويضبط المهلة: `15 + r429×40 + بطء` — تُحفظ في جدول `provider_learn` |
| 🔌 Circuit Breaker | `src/brain.js` | 5 فشل → عزل 5 دقائق → probe نصف مفتوح → إغلاق عند النجاح |
| ⚡ Semantic Cache | `src/store.js` جدول `cache` | تطبيع السؤال (تجاهل التشكيل/الترقيم) + مفتاح SHA256 + TTL — رد فوري بدون استهلاك حساب |
| 👯 Dedup | `src/brain.js` → `dedupRun` | الطلبان المتطابقان المتزامنان (غير متدفقين) يُدمجان في upstream واحد |
| 🔥 Pre-warm | `needsPrewarm` + شارة `🔥 تسخين` | تنبيه قبل انتهاء المهلة بثانيتين |
| 🔀 Fallback ذكي | `executeOnce` | عند الفشل: حساب بديل → نموذج بديل (سلسلة افتراضية) → انتظار ذكي |
| 📊 /api/brain + /metrics | `src/server.js` | التعلّم + الدوائر + الذاكرة + عدّادات بصيغة Prometheus |

## التشغيل (بدون تثبيت!)

```bash
cd node
node src/server.js        # أو من الجذر: bash scripts/run-node.sh
# http://127.0.0.1:8080
```

## الاختبارات (15/15 ✅)

```bash
cd node && npm test   # node --test فقط، بدون تنزيل شيء
```

## البنية

```
node/
  src/server.js     السيرفر + خط المعالجة (cache→dedup→route→lock→upstream→learn→cooldown→audit)
  src/config.js     مهلات المزودين + النماذج الافتراضية
  src/crypto.js     AES-256-GCM (node:crypto)
  src/store.js      SQLite (node:sqlite): accounts + audit + cache + provider_learn
  src/cooldown.js   المهلة الذكية + انتقال READY الكسول
  src/router.js     scoring مركّب يحترم Circuit Breaker
  src/brain.js      🧠 العقل: تعلّم + دوائر + ذاكرة + دمج + تسخين
  src/adapters.js   المحولات الخمسة (deepseek/chatgpt/qwen/webchat/webai/demo)
  public/index.html الواجهة + تبويب 🧠 العقل الذكي
  tests/gateway.test.js
```

## متغيرات البيئة

`HOST` `PORT` `DATA_DIR` `MASTER_KEY` `CACHE_TTL` (ثوانٍ) `MAX_RETRIES` `WEBAI_ENGINE_URL` (تفويض لمحرك WebAI2API الحقيقي).
