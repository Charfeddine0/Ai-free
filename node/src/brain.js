// 🧠 العقل الذكي — ما يجعل البوابة "ذكية جداً":
// 1. Adaptive Cooldown: يتعلّم ema_latency + r429_rate لكل مزود ويضبط المهلة تلقائياً.
// 2. Circuit Breaker: عزل المزود الفاشل (open) + probe نصف مفتوح (half-open).
// 3. Semantic Cache: رد فوري للأسئلة المكررة (يوفر المهلة كلها).
// 4. Dedup: دمج الطلبات المتطابقة المتزامنة في upstream واحد.
// 5. Pre-warm: تنبيه استباقي قبل انتهاء المهلة.
import { createHash } from 'node:crypto';

export function normalizePrompt(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '');
  return text.toLowerCase().replace(/[؟?!\s،,.\-]+/g, ' ').trim().slice(0, 500);
}

export const cacheKey = (model, messages) =>
  'q:' + createHash('sha256').update(model + '|' + normalizePrompt(messages)).digest('hex').slice(0, 32);

// ---------- 1. Adaptive learner ----------
export function observeProvider(store, provider, { latencyMs, was429 }) {
  const cur = store.getLearn(provider) || { ema_latency: 1000, r429_rate: 0, samples: 0 };
  const samples = cur.samples + 1;
  const ema = cur.ema_latency * 0.9 + latencyMs * 0.1;
  const r429 = cur.r429_rate * 0.9 + (was429 ? 1 : 0) * 0.1;
  // القاعدة المتعلمة: أساس 15s، + حتى 20s عند كثرة 429، + حتى 10s عند البطء
  const tuned = Math.round(Math.min(60, Math.max(5, 15 + r429 * 40 + Math.max(0, (ema - 3000) / 1000) * 5)));
  return store.saveLearn(provider, { ema_latency: Math.round(ema), r429_rate: +r429.toFixed(3), tuned_cooldown: tuned, samples });
}

export const tunedBase = (store, provider, fallback) =>
  store.getLearn(provider)?.tuned_cooldown || fallback;

// ---------- 2. Circuit Breaker (ذاكرة عملية) ----------
const breakers = new Map(); // provider -> { state, openedAt, fails }
const OPEN_MS = 5 * 60 * 1000;

export function breakerAllow(provider) {
  const b = breakers.get(provider);
  if (!b || b.state === 'closed') return true;
  if (b.state === 'open') {
    if (Date.now() - b.openedAt > OPEN_MS) { b.state = 'half-open'; return true; } // probe واحد
    return false;
  }
  return true; // half-open: اسمح بمحاولة واحدة
}
export function breakerSuccess(provider) { breakers.delete(provider); }
export function breakerFail(provider) {
  const b = breakers.get(provider) || { fails: 0, state: 'closed' };
  b.fails += 1;
  if (b.state === 'half-open' || b.fails >= 5) {
    b.state = 'open'; b.openedAt = Date.now(); b.fails = 0;
  }
  breakers.set(provider, b);
}
export const breakerStatus = () =>
  Object.fromEntries([...breakers].map(([k, v]) => [k, v.state]));

// ---------- 4. Dedup registry ----------
const inflight = new Map(); // key -> Promise<string>
export function dedupRun(key, fn) {
  if (inflight.has(key)) return { promise: inflight.get(key), deduped: true };
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return { promise: p, deduped: false };
}

// ---------- 5. Pre-warm check ----------
export function needsPrewarm(acc, now = Date.now() / 1000) {
  const rem = (acc.cooldown_until || 0) - now;
  return acc.status !== 'READY' && rem > 0 && rem <= 2; // آخر ثانيتين: جهّز مسبقاً
}
