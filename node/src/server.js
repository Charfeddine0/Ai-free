// Ai-Free Node Gateway — zero-dependency HTTP server + smart pipeline + pressure pool.
// Pipeline: cache → dedup → route(score+breaker+slots) → queue → upstream → learn → cooldown → audit
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { APP_NAME, APP_VERSION, PROVIDER_DEFAULTS, VIRTUAL_MODELS, settings } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import { openStore } from './store.js';
import { isReady, markUsed, refreshStatus, remainingSeconds } from './cooldown.js';
import { getNextAccount, scoreAccount, statusSummary, supports } from './router.js';
import { breakerFail, breakerStatus, breakerSuccess, breakerAllow, cacheKey, dedupRun, needsPrewarm, observeProvider, tunedBase } from './brain.js';
import { Pool, parseAccountsCsv } from './pool.js';
import { getAdapter, listAdapters, RateLimited, UpstreamError } from './adapters.js';
import { chromeStatus, browserConfigured, debugBase } from './noapi/cdp.js';
import { webSessions } from './noapi/runner.js';
import { parseCookies } from './noapi/sessions.js';

const here = dirname(fileURLToPath(import.meta.url));
let store = openStore(settings.dataDir);
// عزل الاختبارات: تبديل المخزن بعد الاستيراد (config يُقيّم مرة واحدة)
export function setStore(s) { store = s; seedDemo(); }
// 🏊 مجمع الضغط: سقف RPM افتراضي لكل مزود من التحليل
export const pool = new Pool(Object.fromEntries(
  Object.entries(PROVIDER_DEFAULTS).map(([k, v]) => [k, v.maxRpm || 30])));
const counters = { requests: 0, cacheHits: 0, deduped: 0, fallbacks: 0, queued: 0 };

// Demo seed للتجربة الفورية
function seedDemo() {
  if (store.listAccounts().length) return;
  store.upsertAccount({
    id: 'acc_demo_01', provider: 'demo', label: 'Demo Account 1',
    credentials_enc: encrypt(settings.masterKey, JSON.stringify({ token: 'demo-local' })),
    status: 'READY', cooldown_until: 0, cooldown_seconds: 3, base_cooldown: 3,
    consecutive_fails: 0, last_used_at: 0, success_count: 0, fail_count: 0,
    avg_latency_ms: 300, health_score: 1, quota_remaining: 100000,
    priority: 1, models: ['auto', 'deepseek-chat', 'qwen-max', 'gpt-4o-mini', 'gemini-2.5-flash'], enabled: true,
    max_concurrency: 99, weight: 1, tags: ['demo'],
  });
}
seedDemo();

export const expandModel = (m) => VIRTUAL_MODELS[m] || [m];
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// المرشحون المرتبون الجاهزون فعلاً (نقاط + فتحات + تباعد + سقف مزود)
function rankFor(model) {
  const now = Date.now() / 1000;
  return store.listAccounts()
    .map((a) => refreshStatus(a, now))
    .filter((a) => supports(a, model) && isReady(a, now) && pool.canStart(a))
    .map((a) => ({ a, s: scoreAccount(a, now) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s);
}
pool.setSelector((models) => rankFor(models[0]));

async function collectUpstream(acc, model, messages) {
  const adapter = getAdapter(acc.provider);
  let full = '';
  const t0 = Date.now();
  for await (const delta of adapter.chat(acc, messages, model)) full += delta;
  return { full, latencyMs: Date.now() - t0 };
}

function onSuccess(acc, model, latencyMs) {
  const tuned = tunedBase(store, acc.provider, acc.base_cooldown);
  const upd = markUsed(acc, { success: true, latencyMs, tunedBase: tuned });
  store.updateFields(acc.id, pick(upd, ['status', 'cooldown_until', 'cooldown_seconds', 'consecutive_fails', 'last_used_at', 'success_count', 'avg_latency_ms', 'health_score', 'quota_remaining']));
  observeProvider(store, acc.provider, { latencyMs, was429: false });
  breakerSuccess(acc.provider);
  return upd;
}
function onFailure(acc, err) {
  const code = err instanceof UpstreamError ? err.statusCode : 500;
  const upd = markUsed(acc, { success: false, statusCode: code, retryAfter: err.retryAfter });
  store.updateFields(acc.id, pick(upd, ['status', 'cooldown_until', 'cooldown_seconds', 'consecutive_fails', 'fail_count', 'health_score']));
  observeProvider(store, acc.provider, { latencyMs: 0, was429: code === 429 });
  breakerFail(acc.provider);
  return { upd, code };
}
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));

function log(e) { store.addLog(e); }

// ---- core pipeline: يُعيد النتيجة أو null (ثم الطابور/429) ----
async function executeOnce(model, messages, requestId, t0, stream, onEvent) {
  for (const candidate of expandModel(model)) {
    let cands = rankFor(candidate);
    let tried = 0;
    while (cands.length && tried <= settings.maxRetries) {
      const { a: acc } = cands.shift();
      tried += 1;
      if (!pool.acquire(acc)) { cands = rankFor(candidate); continue; } // امتلأت الفتحة لحظياً
      store.touchStart(acc.id); // تباعد + حصة يومية
      store.updateFields(acc.id, { status: 'IN_USE' });
      try {
        return await runWithAccount(acc, candidate, messages, stream, onEvent, requestId, t0, model);
      } catch (e) {
        counters.fallbacks += 1;
        cands = rankFor(candidate); // أعد التقييم بعد الفشل (حساب أخف ضغطاً)
      }
    }
  }
  return null;
}

// الفتحة محجوزة مسبقاً من المتصل — تُحرر في finally دائماً (لا ضغط عالق)
async function runWithAccount(acc, candidate, messages, stream, onEvent, requestId, t0, modelReq) {
  try {
    // dedup لغير المتدفق فقط (المتدفق يُنفذ مباشرة ليبقى حياً)
    let full, latencyMs, deduped = false;
    if (!stream) {
      const key = cacheKey(candidate, messages);
      const { promise, deduped: dd } = dedupRun(key, () => collectUpstream({ ...acc, status: 'IN_USE' }, candidate, messages));
      deduped = dd;
      if (dd) counters.deduped += 1;
      ({ full, latencyMs } = await promise);
    } else {
      const r = await collectUpstreamWithEvents({ ...acc, status: 'IN_USE' }, candidate, messages, onEvent);
      full = r.full; latencyMs = r.latencyMs;
    }
    const upd = onSuccess(acc, candidate, latencyMs);
    store.cacheSet(cacheKey(candidate, messages), candidate, full);
    log({ request_id: requestId, model_requested: modelReq, model_resolved: candidate, provider: acc.provider, account_id: acc.id, queue_wait_ms: Math.round(Date.now() - t0), upstream_latency_ms: latencyMs, cooldown_applied: upd.cooldown_seconds, cached: 0, success: 1, error: '' });
    return { full, account: acc, provider: acc.provider, model: candidate, cooldown: upd.cooldown_seconds, deduped };
  } catch (err) {
    const { upd, code } = onFailure(acc, err);
    if (code === 429) pool.on429(acc.provider); // تقليص تكيفي لسقف المزود
    log({ request_id: requestId, model_requested: modelReq, model_resolved: candidate, provider: acc.provider, account_id: acc.id, queue_wait_ms: 0, upstream_latency_ms: 0, cooldown_applied: upd.cooldown_seconds, cached: 0, success: 0, error: String(err?.message || err).slice(0, 300) });
    throw err; // fallback للمرشح التالي
  } finally {
    pool.release(acc.id);
  }
}

async function collectUpstreamWithEvents(acc, model, messages, onEvent) {
  const adapter = getAdapter(acc.provider);
  let full = '';
  const t0 = Date.now();
  for await (const delta of adapter.chat(acc, messages, model)) {
    full += delta;
    if (onEvent) await onEvent(delta);
  }
  return { full, latencyMs: Date.now() - t0 };
}

// ---------------- HTTP helpers ----------------
function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) reject(new Error('body too large')); chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const publicAcc = (a) => {
  const now = Date.now() / 1000;
  const r = refreshStatus(a, now);
  return {
    ...r, credentials_enc: undefined,
    ready: isReady(r, now) && pool.canStart(r),
    remaining: remainingSeconds(r, now), prewarm: needsPrewarm(r, now),
    inflight: pool.slotCount(r.id), rpm: pool.accountRpm(r.id),
  };
};
const avgLatencyOf = (accs) => {
  const lats = accs.map((a) => a.avg_latency_ms || 0).filter((x) => x > 0);
  return lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 5000;
};

// ---------------- routes ----------------
async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  counters.requests += 1;

  // static UI
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const html = await readFile(join(here, '..', 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION });
  if (req.method === 'GET' && path === '/v1/models') {
    const seen = new Map();
    for (const a of store.listAccounts()) for (const m of a.models || []) if (!seen.has(m)) seen.set(m, a.provider);
    for (const v of Object.keys(VIRTUAL_MODELS)) if (!seen.has(v)) seen.set(v, 'virtual');
    return json(res, 200, { object: 'list', data: [...seen].sort().map(([id, p]) => ({ id, object: 'model', owned_by: p })) });
  }
  if (req.method === 'GET' && path === '/api/providers') {
    return json(res, 200, Object.entries(PROVIDER_DEFAULTS).map(([id, v]) => ({ id, label: v.label, models: v.models, base_cooldown: v.baseCooldown, max_concurrency: v.maxConcurrency, max_rpm: v.maxRpm || 30, auth_type: v.authType })));
  }
  if (req.method === 'GET' && path === '/api/adapters') return json(res, 200, listAdapters());
  if (req.method === 'GET' && path === '/api/browser/status') {
    const st = await chromeStatus();
    return json(res, 200, {
      ...st, max_pages: Math.max(1, Number(process.env.BROWSER_MAX_PAGES || 2)),
      sessions: webSessions.stats(),
      setup: browserConfigured() ? null : 'chrome --remote-debugging-port=9222  ثم  CHROME_DEBUG_URL=http://127.0.0.1:9222',
    });
  }
  if (req.method === 'POST' && path === '/api/sessions/import') {
    // استيراد cookies لجلسة حساب (JSON array / object / Netscape / name=value)
    const b = JSON.parse(await readBody(req, 2 * 1024 * 1024));
    const a = store.getAccount(b.account_id);
    if (!a) return json(res, 404, { error: 'account not found' });
    const list = parseCookies(b.cookies);
    if (!list.length) return json(res, 400, { error: 'no cookies parsed' });
    let creds = {};
    try { creds = JSON.parse(decrypt(settings.masterKey, a.credentials_enc || '')) || {}; } catch { creds = {}; }
    creds.cookies = list;
    if (b.token) creds.token = b.token;
    store.updateFields(a.id, { credentials_enc: encrypt(settings.masterKey, JSON.stringify(creds)) });
    const n = webSessions.load(a.id, list);
    return json(res, 200, { ok: true, id: a.id, imported: n });
  }
  if (req.method === 'GET' && path === '/api/pool/status') {
    const accs = store.listAccounts();
    const p = pool.pressure(accs.map((a) => refreshStatus(a)), remainingSeconds, avgLatencyOf(accs));
    p.queue = pool.ordered().map((t) => ({ id: t.id, models: t.models, priority: t.priority, waiting_sec: Math.round((Date.now() - t.enqueuedAt) / 1000), position: pool.position(t.id) }));
    p.caps = Object.fromEntries(pool.caps);
    p.defaults = Object.fromEntries(Object.entries(PROVIDER_DEFAULTS).map(([k, v]) => [k, v.maxRpm || 30]));
    return json(res, 200, p);
  }
  if (req.method === 'GET' && path === '/api/accounts/export') {
    // تصدير آمن بدون بيانات الاعتماد (للمشاركة/النسخ)
    return json(res, 200, store.listAccounts().map((a) => {
      const { credentials_enc, ...safe } = publicAcc(a);
      return safe;
    }));
  }
  if (req.method === 'GET' && path === '/api/accounts/status') {
    const accs = store.listAccounts();
    return json(res, 200, { ...statusSummary(accs), accounts: accs.map(publicAcc) });
  }
  if (req.method === 'GET' && path === '/api/accounts') return json(res, 200, store.listAccounts().map(publicAcc));
  if (req.method === 'GET' && path === '/api/routing/status') {
    const accs = store.listAccounts();
    const routing = ['auto', 'deepseek-chat', 'qwen-max', 'gpt-4o-mini'].map((m) => {
      const { account, wait } = getNextAccount(accs, m);
      return { model: m, selected: account?.id || null, provider: account?.provider || null, wait };
    });
    return json(res, 200, { ...statusSummary(accs), routing, virtual_models: VIRTUAL_MODELS });
  }
  if (req.method === 'GET' && path === '/api/logs') return json(res, 200, store.listLogs(Number(url.searchParams.get('limit') || 100)));
  if (req.method === 'GET' && path === '/api/brain') {
    return json(res, 200, {
      learn: store.listLearn(), breakers: breakerStatus(), cache: store.cacheStats(),
      counters, note: 'المهلة المضبوطة tuned_cooldown تُحسب من ema_latency و r429_rate تلقائياً',
    });
  }
  if (req.method === 'GET' && path === '/metrics') {
    const accs = store.listAccounts();
    const s = statusSummary(accs);
    const c = store.cacheStats();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end([
      `gateway_requests_total ${counters.requests}`, `gateway_cache_hits_total ${c.totalHits}`,
      `gateway_deduped_total ${counters.deduped}`, `gateway_accounts_ready ${s.ready}`,
      `gateway_accounts_cooldown ${s.cooldown}`, `gateway_queue_depth ${pool.depth}`,
      `gateway_breakers_open ${Object.values(breakerStatus()).filter((x) => x === 'open').length}`,
    ].join('\n') + '\n');
  }

  // ---- bulk: استيراد جماعي CSV + عمليات جماعية ----
  if (req.method === 'POST' && path === '/api/accounts/import') {
    const b = JSON.parse(await readBody(req, 5 * 1024 * 1024));
    const { rows, errors } = parseAccountsCsv(String(b.csv || ''));
    let added = 0;
    const skipped = [...errors];
    rows.forEach((r, i) => {
      const d = PROVIDER_DEFAULTS[r.provider];
      if (!d) { skipped.push(i + 1); return; }
      store.upsertAccount({
        provider: r.provider, label: r.label || `${d.label} #${added + 1}`,
        credentials_enc: encrypt(settings.masterKey, JSON.stringify({ token: r.token })),
        status: 'READY', cooldown_until: 0,
        cooldown_seconds: r.base_cooldown || d.baseCooldown,
        base_cooldown: r.base_cooldown || d.baseCooldown,
        consecutive_fails: 0, last_used_at: 0, success_count: 0, fail_count: 0,
        avg_latency_ms: 0, health_score: 1, quota_remaining: 1000,
        priority: r.priority ?? 5, models: d.models, enabled: true,
        max_concurrency: d.maxConcurrency || 1, weight: 1, tags: r.tags || [],
        mode: r.mode || 'auto',
      });
      added += 1;
    });
    return json(res, 200, { added, skipped_lines: skipped });
  }
  if (req.method === 'POST' && path === '/api/accounts/bulk') {
    const b = JSON.parse(await readBody(req));
    const filter = b.filter || {};
    const ALL = ['enable', 'disable', 'delete', 'set_priority', 'set_weight', 'set_cooldown', 'set_quota', 'set_spacing'];
    if (!ALL.includes(b.action)) return json(res, 400, { error: `unknown action (use ${ALL})` });
    if (b.action === 'delete') {
      const all = store.listAccounts().filter((a) =>
        (!filter.provider || a.provider === filter.provider) && (!filter.tag || (a.tags || []).includes(filter.tag)));
      let n = 0;
      for (const a of all) if (store.deleteAccount(a.id)) n += 1;
      return json(res, 200, { action: b.action, affected: n });
    }
    const fields = { enable: { enabled: true, status: 'READY', consecutive_fails: 0 }, disable: { enabled: false, status: 'DISABLED' } }[b.action]
      || { set_priority: { priority: Number(b.value ?? 5) }, set_weight: { weight: Number(b.value ?? 1) }, set_cooldown: { base_cooldown: Number(b.value ?? 15) }, set_quota: { daily_quota: Number(b.value ?? 0) }, set_spacing: { min_spacing: Number(b.value ?? 0) } }[b.action];
    return json(res, 200, { action: b.action, affected: store.bulkUpdate(filter, fields) });
  }

  // ---- accounts CRUD ----
  if (req.method === 'POST' && path === '/api/accounts') {
    const b = JSON.parse(await readBody(req));
    if (!PROVIDER_DEFAULTS[b.provider]) return json(res, 400, { error: `unknown provider ${b.provider}` });
    const d = PROVIDER_DEFAULTS[b.provider];
    const acc = store.upsertAccount({
      provider: b.provider, label: b.label || `${d.label} #1`,
      credentials_enc: encrypt(settings.masterKey, JSON.stringify({ token: b.token || `demo-${randomUUID().slice(0, 6)}` })),
      status: 'READY', cooldown_until: 0, cooldown_seconds: b.base_cooldown || d.baseCooldown,
      base_cooldown: b.base_cooldown || d.baseCooldown, consecutive_fails: 0, last_used_at: 0,
      success_count: 0, fail_count: 0, avg_latency_ms: 0, health_score: 1, quota_remaining: 1000,
      priority: b.priority ?? 5, models: b.models || d.models, enabled: true,
      max_concurrency: b.max_concurrency || d.maxConcurrency || 1,
      daily_quota: b.daily_quota || 0, min_spacing: b.min_spacing || 0,
      weight: b.weight ?? 1, tags: b.tags || [],
      mode: ['auto', 'api', 'browser'].includes(b.mode) ? b.mode : 'auto',
    });
    return json(res, 200, publicAcc(acc));
  }
  const mPatch = path.match(/^\/api\/accounts\/([^/]+)$/);
  if (mPatch && req.method === 'PATCH') {
    // ضبط الضغط لكل حساب: priority/weight/models/tags/daily_quota/min_spacing/max_concurrency/label/base_cooldown/mode
    const b = JSON.parse(await readBody(req));
    const allowed = ['label', 'priority', 'weight', 'models', 'tags', 'daily_quota', 'min_spacing', 'max_concurrency', 'base_cooldown', 'mode'];
    const fields = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(fields).length) return json(res, 400, { error: `allowed: ${allowed}` });
    if (fields.mode && !['auto', 'api', 'browser'].includes(fields.mode)) return json(res, 400, { error: 'mode must be auto|api|browser' });
    const a = store.updateFields(mPatch[1], fields);
    if (!a) return json(res, 404, { error: 'not found' });
    return json(res, 200, publicAcc(a));
  }
  const mAcc = path.match(/^\/api\/accounts\/([^/]+)(\/(enable|disable|refresh))?$/);
  if (mAcc) {
    const [, id, , action] = mAcc;
    if (req.method === 'DELETE' && !action) {
      if (!store.deleteAccount(id)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'enable') return json(res, 200, publicAcc(store.updateFields(id, { enabled: true, status: 'READY', consecutive_fails: 0 })));
    if (req.method === 'POST' && action === 'disable') return json(res, 200, publicAcc(store.updateFields(id, { enabled: false, status: 'DISABLED' })));
    if (req.method === 'POST' && action === 'refresh') {
      const a = store.getAccount(id);
      if (!a) return json(res, 404, { error: 'not found' });
      try { await getAdapter(a.provider).refresh(a); store.updateFields(id, { status: 'READY', consecutive_fails: 0 }); return json(res, 200, { ok: true, id }); }
      catch (e) { store.updateFields(id, { status: 'EXPIRED' }); return json(res, 502, { error: `refresh failed: ${e.message}` }); }
    }
  }
  if (req.method === 'POST' && path === '/api/routing/simulate') {
    const b = JSON.parse(await readBody(req));
    const { account, wait } = getNextAccount(store.listAccounts(), b.model || 'auto');
    return json(res, 200, { model: b.model, selected: account ? publicAcc(account) : null, wait });
  }

  // ---- OpenAI chat ----
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    const t0 = Date.now();
    const requestId = 'req_' + randomUUID().slice(0, 10);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    const model = body.model || 'auto';
    const messages = body.messages || [];
    const stream = body.stream !== false;
    const allowWait = body.allow_wait !== false;

    // 1) semantic cache أولاً (يوفر المهلة كلها)
    const cands0 = expandModel(model);
    for (const c of cands0) {
      const hit = store.cacheGet(cacheKey(c, messages), settings.cacheTtlSec);
      if (hit) {
        counters.cacheHits += 1;
        log({ request_id: requestId, model_requested: model, model_resolved: c, provider: 'cache', account_id: '', queue_wait_ms: 0, upstream_latency_ms: 0, cooldown_applied: 0, cached: 1, success: 1, error: '' });
        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId, 'X-Cache': 'HIT' });
          res.write(sse({ id: requestId, object: 'chat.completion.chunk', model: c, choices: [{ delta: { content: hit.response }, index: 0 }] }));
          res.write(sse({ id: requestId, object: 'chat.completion.chunk', model: c, choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }));
          res.write('data: [DONE]\n\n');
          res.write(sse({ type: 'done', request_id: requestId, cached: true, message: '⚡ رد فوري من الذاكرة الدلالية — بدون استهلاك أي حساب' }));
          return res.end();
        }
        return json(res, 200, { id: requestId, object: 'chat.completion', model: c, choices: [{ message: { role: 'assistant', content: hit.response }, finish_reason: 'stop', index: 0 }], cached: true });
      }
    }

    // 2) محاولة فورية
    const attempt = () => executeOnce(model, messages, requestId, t0, stream,
      stream ? async (delta) => { // بث حي أثناء التجميع
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId });
        res.write(sse({ id: requestId, object: 'chat.completion.chunk', model, choices: [{ delta: { content: delta }, index: 0 }] }));
      } : null);

    let r = await attempt();
    if (r) return finishChat(res, stream, requestId, r);

    // 3) لا يوجد حساب فوري: طابور عادل (FIFO بالأولوية) أو 429 مع backpressure
    const waits = cands0.map((c) => getNextAccount(store.listAccounts(), c).wait).filter((w) => w !== null);
    const wait = waits.length ? Math.min(...waits) : null;
    if (wait === null) {
      log({ request_id: requestId, model_requested: model, model_resolved: '', provider: '', account_id: '', queue_wait_ms: 0, upstream_latency_ms: 0, cooldown_applied: 0, cached: 0, success: 0, error: 'no_supporting_account' });
      return json(res, 429, { error: { message: 'لا يوجد حساب يدعم هذا النموذج.', type: 'no_account', request_id: requestId } });
    }
    if (allowWait && wait <= 20) {
      counters.queued += 1;
      const priority = Number(body.priority || 0);
      if (!stream) {
        // non-stream: تذكرة طابور ثم تنفيذ (بدون إغراق الحسابات بالpolling)
        const ticket = pool.enqueue({ models: cands0, priority, requestId });
        const got = await ticket.promise; // تُحل عند التعيين أو انتهاء المهلة (25s)
        if (!got) {
          log({ request_id: requestId, model_requested: model, model_resolved: '', provider: '', account_id: '', queue_wait_ms: 25000, upstream_latency_ms: 0, cooldown_applied: 0, cached: 0, success: 0, error: 'queue_timeout' });
          return json(res, 429, { error: { message: 'الطابور ممتلئ/المهلة طالت. أعد المحاولة.', type: 'queue_timeout', request_id: requestId } });
        }
        store.touchStart(got.a.id);
        store.updateFields(got.a.id, { status: 'IN_USE' });
        r = await runWithAccount(got.a, got.model || cands0[0], messages, false, null, requestId, t0, model);
        if (r) return finishChat(res, false, requestId, r);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId });
        res.write(sse({ type: 'waiting', request_id: requestId, retry_in: wait, message: `⏳ أقرب حساب جاهز بعد ${wait} ثانية... (انتظار ذكي)` }));
        const ticket = pool.enqueue({ models: cands0, priority, requestId });
        let assigned = null;
        ticket.promise.then((a) => { assigned = a; });
        const startT = Date.now();
        let lastPos = -1;
        while (Date.now() - startT < 25000 && !assigned) {
          const pos = pool.position(ticket.id);
          if (pos !== null && pos !== lastPos) {
            lastPos = pos;
            res.write(sse({ type: 'queued', request_id: requestId, position: pos, message: `⏳ دورك رقم ${pos} في الطابور — لا تُغرق الحسابات، دورك محفوظ` }));
          }
          await Promise.race([ticket.promise, sleep(1000)]);
        }
        if (!assigned) {
          pool.dequeue(ticket.id);
          res.write(sse({ error: 'still_no_account', request_id: requestId }));
          return res.end();
        }
        // الفتحة محجوزة من pump — نفّذ ثم حرر
        store.touchStart(assigned.a.id);
        store.updateFields(assigned.a.id, { status: 'IN_USE' });
        try {
          r = await runWithAccount(assigned.a, assigned.model || cands0[0], messages, true, async (delta) => {
            res.write(sse({ id: requestId, object: 'chat.completion.chunk', model, choices: [{ delta: { content: delta }, index: 0 }] }));
          }, requestId, t0, model);
        } catch { r = null; }
        if (r) finishStream(res, requestId, r);
        else res.write(sse({ error: 'upstream_failed_fallback_exhausted', request_id: requestId }));
        return res.end();
      }
    }
    log({ request_id: requestId, model_requested: model, model_resolved: '', provider: '', account_id: '', queue_wait_ms: 0, upstream_latency_ms: 0, cooldown_applied: 0, cached: 0, success: 0, error: 'all_accounts_cooldown' });
    return json(res, 429, { error: { message: 'كل الحسابات في مهلة. أعد المحاولة بعد قليل.', type: 'all_accounts_cooldown', retry_after: wait, request_id: requestId } });
  }

  return json(res, 404, { error: 'not found' });
}

function finishChat(res, stream, requestId, r) {
  if (!stream) {
    return json(res, 200, { id: requestId, object: 'chat.completion', model: r.model, choices: [{ message: { role: 'assistant', content: r.full }, finish_reason: 'stop', index: 0 }], account: r.account.label, provider: r.provider, deduped: !!r.deduped },
      { 'X-Request-Id': requestId, 'X-Account-Id': r.account.id, 'X-Provider': r.provider });
  }
  // وضع التدفق: الدeltas بُثّت حياً عبر onEvent — نرسل الختام فقط
  finishStream(res, requestId, r);
  return res.end();
}
function finishStream(res, requestId, r) {
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId });
  // إذا بُثّت الدeltas مسبقاً عبر onEvent لا نعيدها؛ نرسل الختام فقط
  res.write(sse({ id: requestId, object: 'chat.completion.chunk', model: r.model, choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }));
  res.write('data: [DONE]\n\n');
  res.write(sse({ type: 'done', request_id: requestId, account: r.account.label, provider: r.provider, cooldown: `الحساب متاح بعد ${r.cooldown} ثانية`, deduped: !!r.deduped }));
}

export function start(port = settings.port, host = settings.host) {
  const server = createServer((req, res) => handler(req, res).catch((e) => {
    try { json(res, 500, { error: String(e?.message || e) }); } catch { /* */ }
  }));
  server.on('close', () => pool.stop());
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { url } = await start();
  console.log(`✅ ${APP_NAME} v${APP_VERSION} يعمل على ${url}`);
}
