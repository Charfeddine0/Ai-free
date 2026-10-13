// 🏊 PoolManager — إدارة الضغط على الكثير من الحسابات:
// فتحات تزامن لكل حساب + تباعد إجباري + سقف RPM لكل مزود (تكيفي)
// + طابور عادل بالأولويات + نقاط ضغط + توصيات تلقائية.
const WINDOW_MS = 60_000;

export class Pool {
  constructor(defaultCaps = {}) {
    this.defaultCaps = { ...defaultCaps };
    this.caps = new Map(Object.entries(defaultCaps)); // provider -> current cap
    this.inflight = new Map();   // accId -> count
    this.lastStart = new Map();  // accId -> ts(sec)
    this.accStarts = new Map();  // accId -> [ms]
    this.provStarts = new Map(); // provider -> [ms]
    this.queue = [];             // tickets
    this.selector = null;        // (models) => [{a, s}] sorted
    this.seq = 0;
    this._pumpTimer = setInterval(() => this.pump(), 500);
    this._pumpTimer.unref?.();
  }

  setSelector(fn) { this.selector = fn; }

  // ---------- فتحات التزامن ----------
  slotCount(id) { return this.inflight.get(id) || 0; }
  slotFree(acc) { return this.slotCount(acc.id) < (acc.max_concurrency || 1); }
  spacingOk(acc, nowSec = Date.now() / 1000) {
    return nowSec - (this.lastStart.get(acc.id) || 0) >= (acc.min_spacing || 0);
  }

  // ---------- سقف المزود (RPM) ----------
  _prune(map, key, nowMs) {
    const arr = (map.get(key) || []).filter((t) => nowMs - t < WINDOW_MS);
    map.set(key, arr);
    return arr;
  }
  providerRpm(provider, nowMs = Date.now()) {
    return this._prune(this.provStarts, provider, nowMs).length;
  }
  accountRpm(accId, nowMs = Date.now()) {
    return this._prune(this.accStarts, accId, nowMs).length;
  }
  providerOk(provider) {
    const cap = this.caps.get(provider) ?? 30;
    return this.providerRpm(provider) < cap;
  }
  canStart(acc) {
    return this.slotFree(acc) && this.spacingOk(acc) && this.providerOk(acc.provider);
  }

  // حجز فوري (يُستخدم عند الاختيار المباشر) — ذري لأن JS أحادي الخيط
  acquire(acc, nowMs = Date.now()) {
    if (!this.canStart(acc)) return false;
    this.inflight.set(acc.id, this.slotCount(acc.id) + 1);
    this.lastStart.set(acc.id, nowMs / 1000);
    this._prune(this.accStarts, acc.id, nowMs).push(nowMs);
    this._prune(this.provStarts, acc.provider, nowMs).push(nowMs);
    return true;
  }
  release(accId) {
    this.inflight.set(accId, Math.max(0, this.slotCount(accId) - 1));
    this.pump();
  }

  // 429 → تقليص تكيفي للسقف؛ والتعافي التدريجي في pump
  on429(provider) {
    const cur = this.caps.get(provider) ?? 30;
    this.caps.set(provider, Math.max(5, Math.floor(cur * 0.8)));
  }
  _recoverCaps() {
    for (const [p, d] of Object.entries(this.defaultCaps)) {
      const cur = this.caps.get(p) ?? d;
      if (cur < d) this.caps.set(p, Math.min(d, cur + Math.max(1, Math.round(d * 0.05))));
    }
  }

  // ---------- الطابور العادل ----------
  enqueue({ models, priority = 0, requestId = '', timeoutMs = 25_000 }) {
    const ticket = {
      id: `q${++this.seq}`, models: [...models], priority,
      requestId, enqueuedAt: Date.now(), assigned: null, settled: false,
    };
    ticket.promise = new Promise((resolve) => { ticket.resolve = resolve; });
    ticket.timer = setTimeout(() => {
      if (!ticket.settled) { ticket.settled = true; this._remove(ticket.id); ticket.resolve(null); }
    }, timeoutMs);
    ticket.timer.unref?.();
    this.queue.push(ticket);
    this.pump();
    return ticket;
  }
  _remove(id) {
    const i = this.queue.findIndex((t) => t.id === id);
    if (i >= 0) this.queue.splice(i, 1);
  }
  dequeue(id) {
    const t = this.queue.find((x) => x.id === id);
    if (t && !t.settled) { t.settled = true; clearTimeout(t.timer); this._remove(id); t.resolve(null); }
  }
  ordered() {
    return [...this.queue].sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }
  position(id) {
    const o = this.ordered();
    const i = o.findIndex((t) => t.id === id);
    return i < 0 ? null : i + 1;
  }
  get depth() { return this.queue.length; }

  pump() {
    this._recoverCaps();
    if (!this.selector) return;
    for (const t of this.ordered()) {
      if (t.settled) continue;
      let picked = null;
      for (const m of t.models) {
        const cands = this.selector([m]) || [];
        picked = cands.find((c) => this.acquire(c.a)) || null;
        if (picked) { picked.model = m; break; }
      }
      if (picked) {
        t.settled = true; clearTimeout(t.timer); this._remove(t.id);
        t.assigned = picked;
        t.resolve(picked);
      }
    }
  }

  // ---------- نقاط الضغط والتوصيات ----------
  pressure(accounts, remainingOf, avgLatencyMs = 5000) {
    const nowMs = Date.now();
    const per = accounts.map((a) => {
      const mc = a.max_concurrency || 1;
      const inflightRatio = Math.min(1, this.slotCount(a.id) / mc);
      const cap = this.caps.get(a.provider) ?? 30;
      const rpmRatio = Math.min(1, this.providerRpm(a.provider, nowMs) / Math.max(1, cap));
      const coolRatio = Math.min(1, (remainingOf(a) || 0) / Math.max(1, a.cooldown_seconds || 15));
      const pressure = Math.round(100 * (0.5 * inflightRatio + 0.3 * rpmRatio + 0.2 * coolRatio));
      return {
        id: a.id, label: a.label, provider: a.provider, status: a.status,
        inflight: this.slotCount(a.id), maxConcurrency: mc,
        rpm: this.accountRpm(a.id, nowMs), remaining: remainingOf(a) || 0,
        pressure, hot: pressure >= 70,
      };
    });
    const byProvider = {};
    for (const p of per) {
      const g = (byProvider[p.provider] ||= { total: 0, ready: 0, inflight: 0, pressureSum: 0, rpm: 0 });
      g.total += 1; g.inflight += p.inflight; g.pressureSum += p.pressure;
      g.rpm += p.rpm;
      if (p.status === 'READY') g.ready += 1;
    }
    for (const g of Object.values(byProvider)) {
      g.avgPressure = Math.round(g.pressureSum / Math.max(1, g.total));
      g.cap = this.caps.get(Object.keys(byProvider).find((k) => byProvider[k] === g)) ?? null;
    }
    const recommendations = [];
    for (const [prov, g] of Object.entries(byProvider)) {
      if (g.total > 0 && g.ready === 0 && this.depth > 0) {
        recommendations.push(`أضف حسابات ${prov}: كل الحسابات (${g.total}) مشغولة والطابور ${this.depth}.`);
      } else if (g.avgPressure >= 70) {
        recommendations.push(`ضغط مرتفع على ${prov} (${g.avgPressure}%): أضف حسابات أو ارفع المهلة.`);
      }
      const cap = this.caps.get(prov) ?? this.defaultCaps[prov];
      if (cap !== undefined && cap < (this.defaultCaps[prov] ?? cap)) {
        recommendations.push(`سقف ${prov} مقلّص تكيفياً إلى ${cap}/دقيقة بسبب 429 — سيتعافى تدريجياً.`);
      }
    }
    const waits = per.filter((p) => p.remaining > 0).map((p) => p.remaining);
    const etaSec = (waits.length ? Math.min(...waits) : 0) + Math.ceil((this.depth * avgLatencyMs) / 1000);
    return { accounts: per, byProvider, queueDepth: this.depth, etaSec, recommendations };
  }

  stop() { clearInterval(this._pumpTimer); }
}

// ---------- استيراد جماعي CSV ----------
// provider,label,token[,cooldown,priority,tags(a|b)]
export function parseAccountsCsv(text) {
  const rows = [];
  const errors = [];
  const splitLine = (line) => {
    const out = [];
    let cur = '', quote = false;
    for (const ch of line) {
      if (ch === '"') quote = !quote;
      else if (ch === ',' && !quote) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim().replace(/^"|"$/g, ''));
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [provider, label, token, cooldown, priority, tags] = splitLine(line);
    if (!provider || !token) { errors.push(i + 1); return; }
    rows.push({
      provider: provider.trim(), label: (label || '').trim(),
      token: token.trim(),
      base_cooldown: Number(cooldown) || undefined,
      priority: priority !== undefined && priority !== '' ? Number(priority) : undefined,
      tags: tags ? tags.split('|').map((t) => t.trim()).filter(Boolean) : undefined,
    });
  });
  return { rows, errors };
}
