// Pool pressure tests — فتحات، تباعد، سقف مزود، طابور، CSV.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Pool, parseAccountsCsv } from '../src/pool.js';
import { scoreAccount } from '../src/router.js';

const mk = (id, over = {}) => ({
  id, provider: 'demo', label: id, status: 'READY', cooldown_until: 0,
  cooldown_seconds: 3, base_cooldown: 3, consecutive_fails: 0, last_used_at: 0,
  success_count: 5, fail_count: 0, avg_latency_ms: 200, health_score: 1,
  quota_remaining: 100, daily_quota: 0, used_today: 0, quota_day: '',
  priority: 5, weight: 1, min_spacing: 0, max_concurrency: 1,
  models: ['auto'], enabled: true, ...over,
});

describe('pool slots', () => {
  it('max_concurrency=1 blocks second acquire', () => {
    const p = new Pool({ demo: 100 });
    try {
      const a = mk('s1');
      assert.equal(p.acquire(a), true);
      assert.equal(p.acquire(a), false); // الفتحة مشغولة → لا ضغط
      p.release('s1');
      assert.equal(p.acquire(a), true);
    } finally { p.stop(); }
  });
  it('max_concurrency=3 allows three parallel', () => {
    const p = new Pool({ demo: 100 });
    try {
      const a = mk('s3', { max_concurrency: 3 });
      assert.equal(p.acquire(a), true);
      assert.equal(p.acquire(a), true);
      assert.equal(p.acquire(a), true);
      assert.equal(p.acquire(a), false);
    } finally { p.stop(); }
  });
  it('min_spacing prevents hammering', () => {
    const p = new Pool({ demo: 100 });
    try {
      const a = mk('sp', { min_spacing: 60, max_concurrency: 5 });
      assert.equal(p.acquire(a), true);
      p.release('sp');
      assert.equal(p.acquire(a), false); // تباعد 60s → مرفوض رغم الفتحات
    } finally { p.stop(); }
  });
});

describe('provider caps', () => {
  it('RPM cap blocks over-limit starts', () => {
    const p = new Pool({ demo: 2 });
    try {
      assert.equal(p.acquire(mk('c1', { max_concurrency: 9 })), true);
      assert.equal(p.acquire(mk('c2', { max_concurrency: 9 })), true);
      assert.equal(p.acquire(mk('c3', { max_concurrency: 9 })), false); // سقف 2/دقيقة
    } finally { p.stop(); }
  });
  it('429 shrinks cap adaptively', () => {
    const p = new Pool({ demo: 20 });
    try {
      p.on429('demo');
      assert.ok(p.caps.get('demo') < 20);
    } finally { p.stop(); }
  });
});

describe('fair queue', () => {
  it('higher priority jumps ahead', async () => {
    const p = new Pool({ demo: 100 });
    try {
      const order = [];
      p.setSelector(() => []); // لا حسابات → تبقى في الطابور
      const t1 = p.enqueue({ models: ['auto'], priority: 0 });
      const t2 = p.enqueue({ models: ['auto'], priority: 9 });
      assert.equal(p.position(t2.id), 1);
      assert.equal(p.position(t1.id), 2);
      assert.equal(p.depth, 2);
      p.dequeue(t1.id); p.dequeue(t2.id);
      await Promise.all([t1.promise, t2.promise]);
      assert.equal(p.depth, 0);
    } finally { p.stop(); }
  });
  it('pump assigns when account appears', async () => {
    const p = new Pool({ demo: 100 });
    try {
      let accs = [];
      p.setSelector(() => accs.map((a) => ({ a, s: 10 })));
      const t = p.enqueue({ models: ['auto'], priority: 0, timeoutMs: 8000 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(p.depth, 1); // ما زال منتظراً
      accs = [mk('late')];
      p.pump();
      const got = await t.promise;
      assert.equal(got?.a?.id, 'late');
      p.release('late');
    } finally { p.stop(); }
  });
  it('queue timeout resolves null (backpressure)', async () => {
    const p = new Pool({ demo: 100 });
    try {
      p.setSelector(() => []);
      const t = p.enqueue({ models: ['auto'], timeoutMs: 300 });
      const got = await t.promise;
      assert.equal(got, null);
    } finally { p.stop(); }
  });
});

describe('pressure scores', () => {
  it('idle account ~0, busy+cooldown high', () => {
    const p = new Pool({ demo: 100 });
    try {
      const idle = mk('idle');
      const rem = () => 0;
      const pr = p.pressure([idle], rem);
      assert.equal(pr.accounts[0].pressure, 0);
      assert.deepEqual(pr.recommendations, []);
      p.acquire(mk('hot', { max_concurrency: 1 }));
      const hot = { ...mk('hot'), status: 'COOLDOWN', cooldown_seconds: 15 };
      const pr2 = p.pressure([hot], () => 15);
      assert.ok(pr2.accounts[0].pressure >= 70);
      assert.equal(pr2.accounts[0].hot, true);
    } finally { p.stop(); }
  });
});

describe('router pressure fields', () => {
  it('daily quota excludes account', () => {
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(scoreAccount(mk('dq', { daily_quota: 5, used_today: 5, quota_day: day })), -1);
    assert.ok(scoreAccount(mk('dq2', { daily_quota: 5, used_today: 4, quota_day: day })) > 0);
  });
  it('weight scales score', () => {
    const lo = scoreAccount({ ...mk('w'), success_count: 50, last_used_at: 0, weight: 0.1 });
    const hi = scoreAccount({ ...mk('w'), success_count: 50, last_used_at: 0, weight: 3 });
    assert.ok(hi > lo);
  });
});

describe('csv import', () => {
  it('parses valid + skips bad lines', () => {
    const { rows, errors } = parseAccountsCsv([
      '# تعليق',
      'deepseek,DS-1,tokenABC,15,8,paid|fast',
      '"qwen","Q,1","tok,en",10,,',
      'badline-without-token',
      '',
    ].join('\n'));
    assert.equal(rows.length, 2);
    assert.deepEqual(errors, [4]);
    assert.equal(rows[0].provider, 'deepseek');
    assert.deepEqual(rows[0].tags, ['paid', 'fast']);
    assert.equal(rows[1].label, 'Q,1'); // فاصلة داخل اقتباس
  });
});
