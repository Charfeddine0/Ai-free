"""Account management API — Account Pool Manager."""
from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.config import PROVIDER_DEFAULTS, settings
from ..core.cooldown import is_ready, refresh_status, remaining_seconds
from ..core.crypto import encrypt
from ..core.routing import status_summary

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

_store = None


def bind(store):
    global _store
    _store = store


class AccountIn(BaseModel):
    provider: str
    label: str = ""
    token: str = ""  # raw credential (token/cookie/bearer) — يُشفر فوراً ولا يُخزن plain
    models: list[str] | None = None
    priority: int = 5
    base_cooldown: int | None = None


def _public(a: dict) -> dict:
    now = time.time()
    a = refresh_status(a, now)
    return {
        "id": a["id"], "provider": a["provider"], "label": a.get("label", ""),
        "status": a.get("status", "READY"),
        "ready": is_ready(a, now),
        "remaining": remaining_seconds(a, now),
        "cooldown_seconds": a.get("cooldown_seconds", 15),
        "cooldown_until": a.get("cooldown_until", 0),
        "last_used_at": a.get("last_used_at", 0),
        "success_count": a.get("success_count", 0),
        "fail_count": a.get("fail_count", 0),
        "avg_latency_ms": a.get("avg_latency_ms", 0),
        "health_score": a.get("health_score", 1.0),
        "quota_remaining": a.get("quota_remaining", 1000),
        "priority": a.get("priority", 5),
        "models": a.get("models", []),
        "enabled": a.get("enabled", True),
        "consecutive_fails": a.get("consecutive_fails", 0),
    }


@router.get("")
def list_accounts():
    return [_public(a) for a in _store.list_accounts()]


@router.get("/status")
def accounts_status():
    accs = _store.list_accounts()
    s = status_summary(accs)
    s["accounts"] = [_public(a) for a in accs]
    return s


@router.post("")
def add_account(body: AccountIn):
    prov = body.provider
    if prov not in PROVIDER_DEFAULTS:
        raise HTTPException(400, f"unknown provider '{prov}'. known: {sorted(PROVIDER_DEFAULTS)}")
    d = PROVIDER_DEFAULTS[prov]
    creds = json.dumps({"token": body.token or f"demo-{uuid.uuid4().hex[:6]}"}, ensure_ascii=False)
    acc = {
        "id": f"acc_{uuid.uuid4().hex[:8]}",
        "provider": prov,
        "label": body.label or f"{d['label']} #1",
        "credentials_enc": encrypt(settings.master_key, creds),
        "status": "READY", "cooldown_until": 0,
        "cooldown_seconds": body.base_cooldown or d["base_cooldown"],
        "base_cooldown": body.base_cooldown or d["base_cooldown"],
        "consecutive_fails": 0, "last_used_at": 0,
        "success_count": 0, "fail_count": 0, "avg_latency_ms": 0,
        "health_score": 1.0, "quota_remaining": 1000,
        "priority": body.priority, "models": body.models or d["models"],
        "enabled": True,
    }
    return _public(_store.upsert_account(acc))


@router.delete("/{acc_id}")
def delete_account(acc_id: str):
    if not _store.delete_account(acc_id):
        raise HTTPException(404, "account not found")
    return {"ok": True}


@router.post("/{acc_id}/enable")
def enable(acc_id: str):
    a = _store.update_fields(acc_id, {"enabled": True, "status": "READY", "consecutive_fails": 0})
    if not a:
        raise HTTPException(404, "account not found")
    return _public(a)


@router.post("/{acc_id}/disable")
def disable(acc_id: str):
    a = _store.update_fields(acc_id, {"enabled": False, "status": "DISABLED"})
    if not a:
        raise HTTPException(404, "account not found")
    return _public(a)


@router.post("/{acc_id}/refresh")
async def refresh(acc_id: str):
    from ..adapters.registry import get_adapter
    a = _store.get_account(acc_id)
    if not a:
        raise HTTPException(404, "account not found")
    adapter = get_adapter(a["provider"])
    try:
        new = await adapter.refresh(a)
        _store.update_fields(acc_id, {"status": "READY", "consecutive_fails": 0})
        return {"ok": True, "id": acc_id}
    except Exception as e:
        _store.update_fields(acc_id, {"status": "EXPIRED"})
        raise HTTPException(502, f"refresh failed: {e}")
