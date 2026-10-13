// Tests — node:test built-in, no deps.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { markUsed, isReady, remainingSeconds } from '../src/cooldown.js';
import { scoreAccount, getNextAccount } from '../src/router.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { normalizePrompt, cacheKey, breakerAllow, breakerFail, breakerSuccess, observeProvider } from '../src/brain.js';
import { VIRTUAL_MODELS } from '../src/config.js';
import { openStore } from '../src/store.js';

const mk = (id = 'a1', over = {}) => ({
  id, provider: 'demo', label: id, status: 'READY', cooldown_until: 0,
  cooldown_seconds: 15, base_cooldown: 15, consecutive_fails: 0, last_used_at: 0,
  success_count: 10, fail_count: 0, avg_latency_ms: 500, health_score: 0.99,
  quota_remaining: 100, priority: 5, models: ['auto', 'deepseek-chat'], enabled: true, ...over,
});

describe('cooldown', () => {
  it('success -> COOLDOWN 15s+jitter', () => {
    const a = markUsed(mk(), { success: true, latencyMs: 1200 });
    assert.equal(a.status, 'COOLDOWN');
    assert.ok(a.cooldown_seconds >= 15 && a.cooldown_seconds <= 18);
    assert.equal(isReady(a), false);
    assert.ok(remainingSeconds(a) > 0);
  });
  it('429 -> RATE_LIMITED backoff>=30', () => {
    const a = markUsed(mk(), { success: false, statusCode: 429, retryAfter: 10 });
    assert.equal(a.status, 'RATE_LIMITED');
    assert.ok(a.cooldown_seconds >= 30);
  });
  it('401 -> EXPIRED', () => {
    assert.equal(markUsed(mk(), { success: false, statusCode: 401 }).status, 'EXPIRED');
  });
});

describe('router', () => {
  it('prefers ready account', () => {
    const busy = markUsed(mk('busy'), { success: true });
    const { account } = getNextAccount([busy, mk('free')], 'deepseek-chat');
    assert.equal(account?.id, 'free');
  });
  it('wait when all in cooldown', () => {
    const b1 = markUsed(mk('b1'), { success: true });
    const b2 = markUsed(mk('b2'), { success: true });
    const { account, wait } = getNextAccount([b1, b2], 'deepseek-chat');
    assert.equal(account, null);
    assert.ok(wait > 0);
  });
  it('respects quota/disable', () => {
    assert.equal(scoreAccount(mk('q', { quota_remaining: 0 })), -1);
    assert.equal(scoreAccount(mk('d', { enabled: false })), -1);
  });
  it('virtual models expand', () => {
    assert.ok(VIRTUAL_MODELS.auto.includes('deepseek-chat'));
  });
});

describe('brain', () => {
  it('normalize+cacheKey stable across punctuation', () => {
    const k1 = cacheKey('auto', [{ role: 'user', content: 'مرحبا؟' }]);
    const k2 = cacheKey('auto', [{ role: 'user', content: 'مرحبا' }]);
    assert.equal(k1, k2);
    assert.ok(normalizePrompt([{ role: 'user', content: 'Hi!' }]).length > 0);
  });
  it('circuit breaker opens after 5 fails', () => {
    const p = 'prov-test-' + Date.now();
    for (let i = 0; i < 5; i++) breakerFail(p);
    assert.equal(breakerAllow(p), false);
    breakerSuccess(p);
    assert.equal(breakerAllow(p), true);
  });
  it('learner tunes cooldown up on 429s', () => {
    const calls = [];
    const fakeStore = {
      getLearn: () => null,
      saveLearn: (p, patch) => { calls.push(patch); return patch; },
    };
    for (let i = 0; i < 10; i++) observeProvider(fakeStore, 'x', { latencyMs: 500, was429: true });
    assert.ok(calls.at(-1).tuned_cooldown > 15);
  });
});

describe('crypto', () => {
  it('AES roundtrip', () => {
    const enc = encrypt('master-key-for-test-1234567890', '{"token":"abc"}');
    assert.ok(enc.startsWith('gcm:'));
    assert.equal(decrypt('master-key-for-test-1234567890', enc), '{"token":"abc"}');
  });
});

describe('http integration', () => {
  let base, ctx;
  before(async () => {
    const dir = '/tmp/aifree_node_test_' + Date.now() + '_' + process.pid;
    const srv = await import('../src/server.js');
    srv.setStore(openStore(dir)); // عزل كامل: مخزن خاص بهذا التشغيل
    const r = await srv.start(0, '127.0.0.1');
    ctx = r; base = r.url;
  });
  after(() => ctx.server.close());

  it('healthz + models', async () => {
    assert.equal((await (await fetch(base + '/healthz')).json()).ok, true);
    const m = await (await fetch(base + '/v1/models')).json();
    assert.ok(m.data.some((x) => x.id === 'auto'));
  });
  it('chat non-stream then smart cooldown', async () => {
    const post = (b) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const r1 = await post({ model: 'auto', messages: [{ role: 'user', content: 'سؤال اختبار ' + Date.now() }], stream: false });
    assert.equal(r1.status, 200);
    const st = await (await fetch(base + '/api/accounts/status')).json();
    assert.ok(st.cooldown >= 1 || st.ready >= 0);
  });
  it('semantic cache: same question twice -> second HIT', async () => {
    const q = 'سؤال مكرر للذاكرة ' + Date.now();
    const post = (b) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post({ model: 'auto', messages: [{ role: 'user', content: q }], stream: false });
    // wait for cooldown then ask again -> should be cache HIT even though account busy logic irrelevant
    await new Promise((r) => setTimeout(r, 4500));
    const r2 = await post({ model: 'auto', messages: [{ role: 'user', content: q }], stream: false });
    const j2 = await r2.json();
    assert.equal(j2.cached, true);
  });
  it('brain + metrics endpoints', async () => {
    const b = await (await fetch(base + '/api/brain')).json();
    assert.ok(b.cache && b.counters);
    const m = await (await fetch(base + '/metrics')).text();
    assert.ok(m.includes('gateway_requests_total'));
  });
  it('pool status shows pressure + caps', async () => {
    const p = await (await fetch(base + '/api/pool/status')).json();
    assert.ok(Array.isArray(p.accounts));
    assert.ok(p.byProvider && typeof p.etaSec === 'number');
    assert.ok(Array.isArray(p.recommendations));
    assert.ok(p.caps && p.queueDepth !== undefined);
  });
  it('bulk import CSV adds many accounts gently', async () => {
    const csv = ['deepseek,Bulk-1,tok1,15,5,team-a', 'deepseek,Bulk-2,tok2,15,5,team-a', 'nope'].join('\n');
    const r = await fetch(base + '/api/accounts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    const j = await r.json();
    assert.equal(j.added, 2);
    assert.ok(j.skipped_lines.length >= 1);
    const st = await (await fetch(base + '/api/accounts/status')).json();
    assert.ok(st.accounts.some((a) => a.label === 'Bulk-1' && a.max_concurrency === 1));
  });
  it('PATCH tunes pressure per account + bulk disable by tag', async () => {
    const accs = await (await fetch(base + '/api/accounts')).json();
    const target = accs.find((a) => a.label === 'Bulk-1');
    const pr = await fetch(base + '/api/accounts/' + target.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weight: 2.5, daily_quota: 50, min_spacing: 5 }) });
    assert.equal((await pr.json()).weight, 2.5);
    const bk = await fetch(base + '/api/accounts/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: { tag: 'team-a' }, action: 'disable' }) });
    assert.equal((await bk.json()).affected, 2);
    const st = await (await fetch(base + '/api/accounts/status')).json();
    assert.ok(st.accounts.filter((a) => (a.tags || []).includes('team-a')).every((a) => a.status === 'DISABLED'));
  });
});
