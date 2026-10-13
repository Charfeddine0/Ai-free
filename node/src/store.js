// SQLite store via node:sqlite (built-in). Accounts + audit + smart tables (cache/learn).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

export function openStore(dataDir) {
  const dir = dataDir.startsWith('/') ? dataDir : join(here, dataDir);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'ai_free_node.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT DEFAULT '',
      credentials_enc TEXT DEFAULT '', status TEXT DEFAULT 'READY',
      cooldown_until REAL DEFAULT 0, cooldown_seconds INTEGER DEFAULT 15,
      base_cooldown INTEGER DEFAULT 15, consecutive_fails INTEGER DEFAULT 0,
      last_used_at REAL DEFAULT 0, success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0, avg_latency_ms INTEGER DEFAULT 0,
      health_score REAL DEFAULT 1.0, quota_remaining INTEGER DEFAULT 1000,
      priority INTEGER DEFAULT 5, models TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1, created_at REAL DEFAULT 0, updated_at REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit_logs(
      id TEXT PRIMARY KEY, request_id TEXT, model_requested TEXT, model_resolved TEXT,
      provider TEXT, account_id TEXT, queue_wait_ms INTEGER DEFAULT 0,
      upstream_latency_ms INTEGER DEFAULT 0, cooldown_applied INTEGER DEFAULT 0,
      cached INTEGER DEFAULT 0, success INTEGER DEFAULT 0, error TEXT DEFAULT '', created_at REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS cache(
      key TEXT PRIMARY KEY, model TEXT, response TEXT, hits INTEGER DEFAULT 0, created_at REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS provider_learn(
      provider TEXT PRIMARY KEY, ema_latency REAL DEFAULT 1000, r429_rate REAL DEFAULT 0,
      tuned_cooldown INTEGER DEFAULT 0, samples INTEGER DEFAULT 0, updated_at REAL DEFAULT 0);
  `);
  return new Store(db);
}

const row = (r) => {
  if (!r) return null;
  const d = { ...r };
  try { d.models = JSON.parse(d.models || '[]'); } catch { d.models = []; }
  d.enabled = !!d.enabled;
  return d;
};

class Store {
  constructor(db) { this.db = db; }
  now() { return Date.now() / 1000; }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY priority DESC, id').all().map(row);
  }
  getAccount(id) {
    return row(this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
  }
  upsertAccount(acc) {
    const now = this.now();
    acc = { id: 'acc_' + randomUUID().slice(0, 8), ...acc };
    if (Array.isArray(acc.models)) acc.models = JSON.stringify(acc.models);
    acc.updated_at = now;
    if (!acc.created_at) acc.created_at = now;
    const cols = ['id','provider','label','credentials_enc','status','cooldown_until','cooldown_seconds','base_cooldown','consecutive_fails','last_used_at','success_count','fail_count','avg_latency_ms','health_score','quota_remaining','priority','models','enabled','created_at','updated_at'];
    const vals = cols.map((k) => acc[k] ?? null);
    this.db.prepare(`INSERT INTO accounts (${cols}) VALUES (${cols.map(() => '?')})
      ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`)}`).run(...vals);
    return this.getAccount(acc.id);
  }
  updateFields(id, fields) {
    if (Array.isArray(fields.models)) fields = { ...fields, models: JSON.stringify(fields.models) };
    fields = { ...fields, updated_at: this.now() };
    const keys = Object.keys(fields);
    if (!keys.length) return this.getAccount(id);
    this.db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k}=?`)} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
    return this.getAccount(id);
  }
  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id=?').run(id).changes > 0;
  }
  addLog(e) {
    const cols = ['id','request_id','model_requested','model_resolved','provider','account_id','queue_wait_ms','upstream_latency_ms','cooldown_applied','cached','success','error','created_at'];
    const v = { id: 'log_' + randomUUID().slice(0, 10), created_at: this.now(), ...e };
    this.db.prepare(`INSERT OR REPLACE INTO audit_logs (${cols}) VALUES (${cols.map(() => '?')})`).run(...cols.map((k) => v[k] ?? null));
  }
  listLogs(limit = 100) {
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 500));
  }
  // ---- smart cache ----
  cacheGet(key, ttlSec) {
    const r = this.db.prepare('SELECT * FROM cache WHERE key=?').get(key);
    if (!r) return null;
    if (this.now() - r.created_at > ttlSec) { this.db.prepare('DELETE FROM cache WHERE key=?').run(key); return null; }
    this.db.prepare('UPDATE cache SET hits=hits+1 WHERE key=?').run(key);
    return r;
  }
  cacheSet(key, model, response) {
    this.db.prepare('INSERT OR REPLACE INTO cache (key, model, response, hits, created_at) VALUES (?,?,?,?,?)')
      .run(key, model, response, 0, this.now());
  }
  cacheStats() {
    const r = this.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(hits),0) h FROM cache').get();
    return { entries: r.c, totalHits: r.h };
  }
  // ---- provider learning ----
  getLearn(provider) {
    return this.db.prepare('SELECT * FROM provider_learn WHERE provider=?').get(provider) || null;
  }
  saveLearn(provider, patch) {
    const cur = this.getLearn(provider) || { provider, ema_latency: 1000, r429_rate: 0, tuned_cooldown: 0, samples: 0 };
    const v = { ...cur, ...patch, updated_at: this.now() };
    this.db.prepare(`INSERT INTO provider_learn (provider, ema_latency, r429_rate, tuned_cooldown, samples, updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET ema_latency=excluded.ema_latency, r429_rate=excluded.r429_rate, tuned_cooldown=excluded.tuned_cooldown, samples=excluded.samples, updated_at=excluded.updated_at`)
      .run(v.provider, v.ema_latency, v.r429_rate, v.tuned_cooldown, v.samples, v.updated_at);
    return v;
  }
  listLearn() {
    return this.db.prepare('SELECT * FROM provider_learn').all();
  }
}
