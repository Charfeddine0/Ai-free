# 🤖 Ai-Free — البوابة الموحدة الذكية | Unified AI Gateway

تطبيق حاسوب كامل يجمع **5 مستودعات** خلف واجهة OpenAI موحدة واحدة مع **مهلة ذكية (Cooldown)** وتوجيه تلقائي:

| المستودع الأصلي | ماذا أخذنا منه | أين في الكود |
|---|---|---|
| `xiaoY233/Chat2API` (Electron+TS) | إعدادات المزودين (headers/auth/models) لكل من DeepSeek/GLM/Kimi/Qwen | `app/adapters/chat2api.py` + `app/core/config.py` |
| `CJackHwang/ds2api` (Go) | Account Pool + Queue + DeepSeek client + PoW | `app/adapters/ds2api.py` + `app/core/cooldown.py` |
| `YuJunZhiXue/qwen2API` (Go) | `ExecuteTurn`: CreateChat → Stream → Delete | `app/adapters/qwen.py` |
| `zqbxdev/webchat2api` (FastAPI+Next.js) | `AccountAdapter/ChatAdapter` + pools لـ GPT/Grok/Gemini | `app/adapters/webchat.py` + `app/adapters/base.py` |
| `foxhui/WebAI2API` (Node/Camoufox) | Adapter Registry + Task Queue + Failover | `app/adapters/registry.py` + `app/adapters/webai.py` |

> الأكواد الأصلية بلغات Go/TS/Node أُعيد تنفيذ منطقها بلغة Python (البوابة لغة واحدة لتسهيل التشغيل على الحاسوب)، مع إمكانية التفويض لخدمة `WebAI2API` الحقيقية عبر `WEBAI_ENGINE_URL`.

## ✨ المزايا

- **واجهة OpenAI موحدة**: `POST /v1/chat/completions` (streaming + non-stream) و `GET /v1/models` — تعمل مع Open WebUI و LangChain و Dify بدون تعديل.
- **مهلة ذكية 15 ثانية** (لكل مزود قيمة من تحليل المشاريع): بعد كل استخدام ناجح → `COOLDOWN` + jitter + backoff تصاعدي عند 429.
- **انتظار ذكي**: إذا طلبت أثناء المهلة، يبث `⏳ متبقي N ثانية...` ثم ينفذ تلقائياً (SSE) أو يتحول لـ Fallback.
- **توجيه بالنقاط**: أولوية + نسبة نجاح + صحة + سرعة + LRU + حصة.
- **نماذج افتراضية**: `auto` و `reasoning` تُحسم لأفضل حساب جاهز.
- **واجهة عربية كاملة**: محادثة + حسابات (عد تنازلي حي) + توجيه + سجلات — على `/`.
- **تشفير AES-256-GCM** للرموز، SQLite محلية (لا سيرفرات خارجية)، تطبيق حاسوب عبر `desktop/launcher.py`.

## 🧠 نسخة Node الذكية جداً (الجديدة — بدون تثبيت!)

نفس البوابة أُعيد بناؤها **داخل Node.js خالص بدون أي مكتبة خارجية** (`node/` — يعمل بـ `node src/server.js` فقط على Node 22+)، مع عقل ذكي إضافي:

- **تعلّم تكيفي**: المهلة تُضبط تلقائياً من `ema_latency` و `r429_rate` (`/api/brain`).
- **Circuit Breaker**: عزل المزود الفاشل + probe نصف مفتوح.
- **ذاكرة دلالية**: السؤال المكرر يُرد فوراً (⚡) بدون استهلاك حساب.
- **دمج الطلبات**: المتطابقان المتزامنان → upstream واحد.
- **تبويب 🧠 العقل الذكي** في الواجهة + `/metrics` بصيغة Prometheus.

```bash
bash scripts/run-node.sh   # ثم افتح http://127.0.0.1:8080
cd node && npm test        # 15 اختباراً (node:test فقط)
```

التفاصيل: [`node/README.md`](node/README.md).

## 🚀 التشغيل (نسخة Python)

```bash
pip install -r requirements.txt
# الطريقة 1: سيرفر
bash scripts/run.sh
# الطريقة 2: تطبيق حاسوب (يفتح المتصفح تلقائياً)
python desktop/launcher.py
# ثم افتح: http://127.0.0.1:8080
```

تجربة فورية (بدون أي حساب — وضع Demo):
```bash
curl -N -X POST http://127.0.0.1:8080/v1/chat/completions \
 -H 'Content-Type: application/json' \
 -d '{"model":"auto","messages":[{"role":"user","content":"مرحبا"}],"stream":true}'
```

إضافة حساب حقيقي (من الواجهة أو API):
```bash
curl -X POST http://127.0.0.1:8080/api/accounts \
 -H 'Content-Type: application/json' \
 -d '{"provider":"deepseek","label":"DeepSeek-1","token":"PASTE_TOKEN","base_cooldown":15}'
```

مصادر الرموز: DeepSeek من `chat.deepseek.com` (LocalStorage → userToken) • Qwen من `chat.qwen.ai` (Authorization Bearer) • ChatGPT من `chatgpt.com/api/auth/session`.

## 🐳 Docker

```bash
docker compose up --build
# الواجهة: http://localhost:8080
```

## 🖥️ بناء نسخة تنفيذية (exe/AppImage)

```bash
pip install pyinstaller
pyinstaller --onefile --name Ai-Free desktop/launcher.py
./dist/Ai-Free
```

## 📁 الهيكل

```
app/main.py            البوابة (FastAPI + Demo seed + UI)
app/core/              config (مهلات كل مزود) / crypto / store (SQLite) / cooldown / routing
app/adapters/          base + ds2api + chat2api + qwen + webchat + webai + demo + registry
app/api/               openai (/v1/*) + accounts + system (routing/logs/health)
app/ui/static/index.html  الواجهة العربية الكاملة
desktop/launcher.py    مشغّل الحاسوب + درج النظام
tests/                 5 اختبارات (تمر كلها)
```

## ⚠️ ملاحظة

للاستخدام الشخصي/البحثي. التزم بشروط خدمات المواقع. المطورون الأصليون للمشاريع الخمسة هم أصحاب الفضل في بروتوكولات الربط.
