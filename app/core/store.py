"""SQLite store: accounts + audit logs + queue. No external DB needed for desktop."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT DEFAULT '',
  credentials_enc TEXT DEFAULT '',
  status TEXT DEFAULT 'READY',
  cooldown_until REAL DEFAULT 0,
  cooldown_seconds INTEGER DEFAULT 15,
  base_cooldown INTEGER DEFAULT 15,
  consecutive_fails INTEGER DEFAULT 0,
  last_used_at REAL DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER DEFAULT 0,
  health_score REAL DEFAULT 1.0,
  quota_remaining INTEGER DEFAULT 1000,
  priority INTEGER DEFAULT 5,
  models TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at REAL DEFAULT 0,
  updated_at REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  model_requested TEXT,
  model_resolved TEXT,
  provider TEXT,
  account_id TEXT,
  queue_wait_ms INTEGER DEFAULT 0,
  upstream_latency_ms INTEGER DEFAULT 0,
  cooldown_applied INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at REAL DEFAULT 0
);
"""


class Store:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        self._init()

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, check_same_thread=False)
        c.row_factory = sqlite3.Row
        return c

    def _init(self):
        with self._lock, self._conn() as c:
            c.executescript(SCHEMA)

    # ---------- accounts ----------
    def list_accounts(self) -> list[dict]:
        with self._lock, self._conn() as c:
            rows = c.execute("SELECT * FROM accounts ORDER BY priority DESC, id").fetchall()
        return [self._row(r) for r in rows]

    def get_account(self, acc_id: str) -> dict | None:
        with self._lock, self._conn() as c:
            r = c.execute("SELECT * FROM accounts WHERE id=?", (acc_id,)).fetchone()
        return self._row(r) if r else None

    def upsert_account(self, acc: dict) -> dict:
        now = time.time()
        acc = dict(acc)
        acc.setdefault("id", f"acc_{uuid.uuid4().hex[:8]}")
        acc.setdefault("created_at", now)
        acc["updated_at"] = now
        cols = ["id", "provider", "label", "credentials_enc", "status", "cooldown_until",
                "cooldown_seconds", "base_cooldown", "consecutive_fails", "last_used_at",
                "success_count", "fail_count", "avg_latency_ms", "health_score",
                "quota_remaining", "priority", "models", "enabled", "created_at", "updated_at"]
        if isinstance(acc.get("models"), list):
            acc["models"] = json.dumps(acc["models"], ensure_ascii=False)
        vals = [acc.get(k, 0 if k in ("cooldown_until", "last_used_at", "created_at", "updated_at") else ("" if k in ("label", "credentials_enc", "status") else 0)) for k in cols]
        with self._lock, self._conn() as c:
            c.execute(
                f"INSERT INTO accounts ({','.join(cols)}) VALUES ({','.join('?'*len(cols))}) "
                f"ON CONFLICT(id) DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in cols if k != "id"),
                vals,
            )
        return self.get_account(acc["id"])  # type: ignore

    def delete_account(self, acc_id: str) -> bool:
        with self._lock, self._conn() as c:
            cur = c.execute("DELETE FROM accounts WHERE id=?", (acc_id,))
            return cur.rowcount > 0

    def update_fields(self, acc_id: str, fields: dict) -> dict | None:
        if not fields:
            return self.get_account(acc_id)
        fields = dict(fields)
        if isinstance(fields.get("models"), list):
            fields["models"] = json.dumps(fields["models"], ensure_ascii=False)
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=?" for k in fields)
        with self._lock, self._conn() as c:
            c.execute(f"UPDATE accounts SET {sets} WHERE id=?", (*fields.values(), acc_id))
        return self.get_account(acc_id)

    # ---------- audit ----------
    def add_log(self, entry: dict):
        entry = dict(entry)
        entry.setdefault("id", f"log_{uuid.uuid4().hex[:10]}")
        entry.setdefault("created_at", time.time())
        cols = ["id", "request_id", "model_requested", "model_resolved", "provider",
                "account_id", "queue_wait_ms", "upstream_latency_ms", "cooldown_applied",
                "success", "error", "created_at"]
        with self._lock, self._conn() as c:
            c.execute(f"INSERT OR REPLACE INTO audit_logs ({','.join(cols)}) VALUES ({','.join('?'*len(cols))})",
                      [entry.get(k, "") for k in cols])

    def list_logs(self, limit: int = 100) -> list[dict]:
        with self._lock, self._conn() as c:
            rows = c.execute("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _row(r: sqlite3.Row) -> dict:
        d = dict(r)
        try:
            d["models"] = json.loads(d.get("models") or "[]")
        except Exception:
            d["models"] = []
        d["enabled"] = bool(d.get("enabled", 1))
        return d
