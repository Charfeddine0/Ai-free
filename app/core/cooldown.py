"""Smart Cooldown — القاعدة الأساسية: بعد كل استخدام ناجح مهلة افتراضية (15s)."""
from __future__ import annotations

import math
import random
import time


def remaining_seconds(acc: dict, now: float | None = None) -> int:
    now = time.time() if now is None else now
    return max(0, math.ceil((acc.get("cooldown_until", 0) or 0) - now))


def is_ready(acc: dict, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    if not acc.get("enabled", True):
        return False
    if acc.get("status") in ("DISABLED", "ERROR", "EXPIRED"):
        return False
    if acc.get("status") == "READY":
        return True
    return now >= (acc.get("cooldown_until", 0) or 0)


def refresh_status(acc: dict, now: float | None = None) -> dict:
    """If cooldown elapsed -> flip to READY (lazy transition, no background job needed)."""
    now = time.time() if now is None else now
    acc = dict(acc)
    if acc.get("status") in ("COOLDOWN", "RATE_LIMITED", "IN_USE") and now >= (acc.get("cooldown_until", 0) or 0):
        acc["status"] = "READY"
    return acc


def mark_used(acc: dict, success: bool, status_code: int = 200,
              retry_after: int | None = None, latency_ms: int = 0,
              now: float | None = None) -> dict:
    """Port of ds2api pool + webchat2api account_service backoff + Chat2API retry logic."""
    now = time.time() if now is None else now
    acc = dict(acc)
    base = int(acc.get("base_cooldown", 15) or 15)

    if success:
        extra = 5 if latency_ms > 8000 else 0
        acc["cooldown_seconds"] = base + random.randint(0, 3) + extra
        acc["consecutive_fails"] = 0
        acc["success_count"] = int(acc.get("success_count", 0)) + 1
        prev = int(acc.get("avg_latency_ms", 0) or 0)
        acc["avg_latency_ms"] = int(prev * 0.85 + latency_ms * 0.15) if prev else latency_ms
        acc["status"] = "COOLDOWN"
        q = int(acc.get("quota_remaining", 1000) or 0)
        acc["quota_remaining"] = max(0, q - 1)
    else:
        acc["consecutive_fails"] = int(acc.get("consecutive_fails", 0)) + 1
        acc["fail_count"] = int(acc.get("fail_count", 0)) + 1
        if status_code == 429:
            ra = retry_after or base
            acc["cooldown_seconds"] = min(max(ra * 2, 30), 600)
            acc["status"] = "RATE_LIMITED"
        elif status_code in (401, 403):
            acc["status"] = "EXPIRED"
            acc["cooldown_seconds"] = 60
        else:
            exp = min(base * (2 ** min(acc["consecutive_fails"], 4)), 300)
            acc["cooldown_seconds"] = exp
            acc["status"] = "COOLDOWN"
            if acc["consecutive_fails"] >= 5:
                acc["status"] = "ERROR"
            if acc["consecutive_fails"] >= 10:
                acc["status"] = "DISABLED"

    acc["cooldown_until"] = now + int(acc["cooldown_seconds"])
    acc["last_used_at"] = now

    s, f = int(acc.get("success_count", 0)), int(acc.get("fail_count", 0))
    rate = s / max(1, s + f)
    lat_pen = min(0.2, int(acc.get("avg_latency_ms", 0) or 0) / 50000)
    acc["health_score"] = round(max(0.0, rate - lat_pen - acc.get("consecutive_fails", 0) * 0.05), 3)
    return acc
