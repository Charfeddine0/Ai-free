// Smart Cooldown — نفس القاعدة (مهلة بعد كل نجاح) + تكامل مع التعلّم التكيفي.
export const remainingSeconds = (acc, now = Date.now() / 1000) =>
  Math.max(0, Math.ceil((acc.cooldown_until || 0) - now));

export function isReady(acc, now = Date.now() / 1000) {
  if (!acc.enabled) return false;
  if (['DISABLED', 'ERROR', 'EXPIRED'].includes(acc.status)) return false;
  if (acc.status === 'READY') return true;
  return now >= (acc.cooldown_until || 0);
}

export function refreshStatus(acc, now = Date.now() / 1000) {
  if (['COOLDOWN', 'RATE_LIMITED', 'IN_USE'].includes(acc.status) && now >= (acc.cooldown_until || 0)) {
    return { ...acc, status: 'READY' };
  }
  return { ...acc };
}

// tunedBase: من المُتعلّم التكيفي (brain) — يتجاوز base_cooldown عند توفره
export function markUsed(acc, { success, statusCode = 200, retryAfter = null, latencyMs = 0, tunedBase = null }) {
  const now = Date.now() / 1000;
  const base = tunedBase || acc.base_cooldown || 15;
  const a = { ...acc };
  if (success) {
    const extra = latencyMs > 8000 ? 5 : 0;
    a.cooldown_seconds = base + Math.floor(Math.random() * 4) + extra;
    a.consecutive_fails = 0;
    a.success_count += 1;
    a.avg_latency_ms = a.avg_latency_ms ? Math.round(a.avg_latency_ms * 0.85 + latencyMs * 0.15) : latencyMs;
    a.status = 'COOLDOWN';
    a.quota_remaining = Math.max(0, (a.quota_remaining || 0) - 1);
  } else {
    a.consecutive_fails += 1;
    a.fail_count += 1;
    if (statusCode === 429) {
      a.cooldown_seconds = Math.min(Math.max((retryAfter || base) * 2, 30), 600);
      a.status = 'RATE_LIMITED';
    } else if ([401, 403].includes(statusCode)) {
      a.status = 'EXPIRED';
      a.cooldown_seconds = 60;
    } else {
      a.cooldown_seconds = Math.min(base * 2 ** Math.min(a.consecutive_fails, 4), 300);
      a.status = 'COOLDOWN';
      if (a.consecutive_fails >= 5) a.status = 'ERROR';
      if (a.consecutive_fails >= 10) a.status = 'DISABLED';
    }
  }
  a.cooldown_until = now + a.cooldown_seconds;
  a.last_used_at = now;
  const tot = a.success_count + a.fail_count;
  const rate = tot ? a.success_count / tot : 1;
  a.health_score = Math.round(Math.max(0, rate - Math.min(0.2, (a.avg_latency_ms || 0) / 50000) - a.consecutive_fails * 0.05) * 1000) / 1000;
  return a;
}
