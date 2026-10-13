// Routing Engine — scoring مركّب + circuit breaker + دعم النماذج الافتراضية.
import { isReady, refreshStatus, remainingSeconds } from './cooldown.js';
import { breakerAllow } from './brain.js';
import { todayKey } from './store.js';

export const dailyExhausted = (a) =>
  a && (a.daily_quota || 0) > 0 && a.quota_day === todayKey() && (a.used_today || 0) >= a.daily_quota;

export const supports = (a, model) =>
  !a.models?.length || a.models.includes(model) || a.models.includes('auto');

export function scoreAccount(a, now = Date.now() / 1000) {
  a = refreshStatus(a, now);
  if (!isReady(a, now)) return -1;
  if ((a.quota_remaining || 0) <= 0) return -1;
  if (dailyExhausted(a)) return -1; // الحصة اليومية انتهت → لا ضغط عليه اليوم
  if (!breakerAllow(a.provider)) return -1;
  let s = (a.priority / 10) * 30;
  const tot = a.success_count + a.fail_count;
  s += (tot ? a.success_count / tot : 1) * 25;
  s += a.health_score * 15;
  s += Math.max(0, 15 - (a.avg_latency_ms || 1000) / 1000);
  s += Math.min(10, (now - (a.last_used_at || 0)) / 60);
  if ((a.quota_remaining || 0) > 20) s += 5;
  s *= (a.weight || 1); // وزن يدوي: ارفع الحسابات القوية واخفض الضعيفة
  return Math.round((s + Math.random() * 1.5) * 100) / 100;
}

export function getNextAccount(accounts, model) {
  const now = Date.now() / 1000;
  const scored = [];
  for (const raw of accounts) {
    const a = refreshStatus(raw, now);
    if (!supports(a, model)) continue;
    const sc = scoreAccount(a, now);
    if (sc >= 0) scored.push([sc, a]);
  }
  if (scored.length) {
    scored.sort((x, y) => y[0] - x[0]);
    return { account: scored[0][1], wait: 0, score: scored[0][0] };
  }
  const cands = accounts.map((a) => refreshStatus(a, now))
    .filter((a) => supports(a, model) && a.enabled && !['DISABLED', 'ERROR', 'EXPIRED'].includes(a.status) && breakerAllow(a.provider));
  if (!cands.length) return { account: null, wait: null };
  const nxt = cands.reduce((m, a) => (remainingSeconds(a, now) < remainingSeconds(m, now) ? a : m));
  return { account: null, wait: remainingSeconds(nxt, now), nearest: nxt };
}

export function statusSummary(accounts) {
  const now = Date.now() / 1000;
  const out = { ready: 0, cooldown: 0, rate_limited: 0, in_use: 0, expired: 0, disabled: 0, error: 0, nearest_ready_in: 0, by_provider: {} };
  const waits = [];
  for (const raw of accounts) {
    const a = refreshStatus(raw, now);
    const k = { READY: 'ready', COOLDOWN: 'cooldown', RATE_LIMITED: 'rate_limited', IN_USE: 'in_use', EXPIRED: 'expired', DISABLED: 'disabled', ERROR: 'error' }[a.status] || 'cooldown';
    out[k] += 1;
    if (['COOLDOWN', 'RATE_LIMITED', 'IN_USE'].includes(a.status)) waits.push(remainingSeconds(a, now));
    const p = (out.by_provider[a.provider] ||= { ready: 0, total: 0 });
    p.total += 1;
    if (a.status === 'READY') p.ready += 1;
  }
  out.nearest_ready_in = waits.length ? Math.min(...waits) : 0;
  return out;
}
