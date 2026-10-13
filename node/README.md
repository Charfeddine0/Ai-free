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

## 🌐 الذكاء الكامل بدون API (الجديد)

عند غياب الرموز، البوابة تتصفح المواقع **بمتصفح كروم حقيقي وسلوك بشري** (فكرة WebAI2API/Camoufox، لكن ببروتوكول CDP الخام — بدون مكتبات):

| المكوّن | الملف | الذكاء |
|---|---|---|
| 🧍 سلوك بشري | `src/noapi/human.js` | كتابة بدفعات غير منتظمة + وقفات تفكير + فأرة Bezier برعشة يد + Fitts's law + بصمة متغيرة (viewport/UA/locale) |
| 🌐 عميل CDP | `src/noapi/cdp.js` | تحكم كامل بكروم (`--remote-debugging-port=9222`): تبويبات، تنقل، كتابة، نقر، لقطات، cookies — بـ WebSocket المدمج فقط |
| 🍪 الجلسات | `src/noapi/sessions.js` | استيراد cookies (JSON/Netscape/`name=value`) + حقن تلقائي + صحة (3 فشل = عزل) + تدوير |
| 🗺️ المواقع | `src/noapi/sites.js` | إعدادات chatgpt/deepseek/gemini/grok/qwen/lmarena + **اكتشاف تلقائي** لأي مربع إدخال + تجاوز عبر `sites.override` |
| 🏃 العدّاء | `src/noapi/runner.js` | قراءة تدريجية حية حتى الاستقرار + semaphore للصفحات + الفشل يتيح Fallback تلقائياً |
| 🔀 الأوضاع | عمود `mode` | `auto`=API إن وُجد وإلا متصفح • `api`=رموز فقط • `browser`=متصفح دائماً — لكل حساب |

**التفعيل:** `chrome --remote-debugging-port=9222` ثم `CHROME_DEBUG_URL=http://127.0.0.1:9222`.

**نقاط جديدة:** `GET /api/browser/status` (كروم؟ جلسات؟) • `POST /api/sessions/import` (cookies مشفرة) • تبويب **🌐 بدون API** (حالة + استيراد + أوضاع).

## الاختبارات (52/52 ✅)

```bash
cd node && npm test   # node --test فقط، بدون تنزيل شيء
```

## 🏊 إدارة الكثير من الحسابات بدون ضغط (الجديد)

| الآلية | أين | التفاصيل |
|---|---|---|
| فتحات تزامن | `src/pool.js` + عمود `max_concurrency` | كل حساب له N فتحات (DeepSeek=1، GPT=2...) — الممتلئ يُتجاوز تلقائياً لحساب أخف |
| تباعد إجباري | `min_spacing` (ثوانٍ) | فجوة دنيا بين بدايات الطلبات على نفس الحساب — يمنع القصف |
| سقف RPM للمزود | `maxRpm` + `pool.caps` | سقف طلبات/دقيقة لكل مزود، **يتقلص تلقائياً عند 429 ويتعافى تدريجياً** |
| حصة يومية | `daily_quota`/`used_today` | تُصفّر تلقائياً كل يوم؛ المستنفد يُستبعد من التوجيه |
| أوزان + وسوم | `weight`/`tags` | وزن يدوي في التسجيل + تجميع بالوسوم للعمليات الجماعية |
| طابور عادل | `pool.enqueue/pump` | أولوية + FIFO، بثّ `queued {position}` حياً، مهلة 25s (backpressure بدل الإغراق) |
| نقاط ضغط | `/api/pool/status` | 0-100 لكل حساب/مزود + ETA + **توصيات تلقائية** ("أضف حسابات deepseek") |
| استيراد CSV | `POST /api/accounts/import` | `provider,label,token,cooldown,priority,tags` — سطر لكل حساب |
| عمليات جماعية | `POST /api/accounts/bulk` | enable/disable/delete/priority/weight/cooldown/quota/spacing حسب المزود أو الوسم |
| ضبط فردي | `PATCH /api/accounts/:id` | أي حقل ضغط لحساب واحد |
| تصدير آمن | `GET /api/accounts/export` | بدون بيانات الاعتماد |

مهلات خارجية صارمة (30s) على كل upstream حتى لا يحجز حساب معلّق فتحة للأبد.

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
