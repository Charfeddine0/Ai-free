"""Routing Engine — يختار الحساب الأنسب + fallback + انتظار ذكي."""
from __future__ import annotations

import random
import time

from .cooldown import is_ready, refresh_status, remaining_seconds


def score_account(a: dict, now: float | None = None) -> float:
    now = time.time() if now is None else now
    a = refresh_status(a, now)
    if not is_ready(a, now):
        return -1
    if int(a.get("quota_remaining", 1) or 0) <= 0:
        return -1
    s = (int(a.get("priority", 5)) / 10) * 30
    tot = int(a.get("success_count", 0)) + int(a.get("fail_count", 0))
    rate = (a.get("success_count", 0) / tot) if tot else 1.0
    s += rate * 25
    s += float(a.get("health_score", 1.0)) * 15
    lat = int(a.get("avg_latency_ms", 1000) or 1000)
    s += max(0, 15 - (lat / 1000))
    idle = now - float(a.get("last_used_at", 0) or 0)
    s += min(10, idle / 60)
    if int(a.get("quota_remaining", 0) or 0) > 20:
        s += 5
    s += random.uniform(0, 1.5)
    return round(s, 2)


def supports(a: dict, model: str) -> bool:
    models = a.get("models") or []
    return not models or model in models or "auto" in models


def get_next_account(accounts: list[dict], model: str):
    """Returns (account|None, wait_seconds)."""
    now = time.time()
    scored = []
    for a in accounts:
        a = refresh_status(a, now)
        if not supports(a, model):
            continue
        sc = score_account(a, now)
        if sc >= 0:
            scored.append((sc, a))
    if scored:
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1], 0
    # nobody ready -> nearest wait among supporting accounts
    cands = [refresh_status(a, now) for a in accounts if supports(a, model)]
    cands = [a for a in cands if a.get("enabled") and a.get("status") not in ("DISABLED", "ERROR", "EXPIRED")]
    if not cands:
        return None, None
    nxt = min(cands, key=lambda a: remaining_seconds(a, now))
    return None, remaining_seconds(nxt, now)


def status_summary(accounts: list[dict]) -> dict:
    now = time.time()
    out = {"ready": 0, "cooldown": 0, "rate_limited": 0, "in_use": 0,
           "expired": 0, "disabled": 0, "error": 0, "nearest_ready_in": None, "by_provider": {}}
    waits = []
    for raw in accounts:
        a = refresh_status(raw, now)
        st = a.get("status", "READY")
        key = {"READY": "ready", "COOLDOWN": "cooldown", "RATE_LIMITED": "rate_limited",
               "IN_USE": "in_use", "EXPIRED": "expired", "DISABLED": "disabled", "ERROR": "error"}.get(st, "cooldown")
        out[key] += 1
        if st in ("COOLDOWN", "RATE_LIMITED", "IN_USE"):
            waits.append(remaining_seconds(a, now))
        prov = out["by_provider"].setdefault(a.get("provider", "?"), {"ready": 0, "total": 0})
        prov["total"] += 1
        if st == "READY":
            prov["ready"] += 1
    out["nearest_ready_in"] = min(waits) if waits else 0
    return out
