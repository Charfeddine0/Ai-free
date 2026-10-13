"""System APIs: routing status, logs, health, providers."""
from __future__ import annotations

from fastapi import APIRouter

from ..adapters.registry import list_adapters
from ..core.cooldown import refresh_status
from ..core.config import APP_NAME, APP_VERSION, PROVIDER_DEFAULTS, VIRTUAL_MODELS
from ..core.routing import get_next_account, status_summary

router = APIRouter(tags=["system"])
_store = None


def bind(store):
    global _store
    _store = store


@router.get("/healthz")
def healthz():
    return {"ok": True, "app": APP_NAME, "version": APP_VERSION}


@router.get("/api/providers")
def providers():
    return [{"id": k, **{kk: vv for kk, vv in v.items() if kk in ("label", "models", "base_cooldown", "auth_type")}}
            for k, v in PROVIDER_DEFAULTS.items()]


@router.get("/api/adapters")
def adapters():
    return list_adapters()


@router.get("/api/routing/status")
def routing_status():
    accs = _store.list_accounts()
    s = status_summary(accs)
    detail = []
    for m in ["auto", "deepseek-chat", "qwen-max", "gpt-4o-mini"]:
        acc, wait = get_next_account(accs, m)
        detail.append({"model": m, "selected": acc["id"] if acc else None,
                       "provider": acc["provider"] if acc else None, "wait": wait})
    return {**s, "routing": detail, "virtual_models": VIRTUAL_MODELS}


@router.post("/api/routing/simulate")
def simulate(body: dict):
    model = body.get("model", "auto")
    accs = _store.list_accounts()
    acc, wait = get_next_account(accs, model)
    return {"model": model, "selected": acc, "wait": wait}


@router.get("/api/logs")
def logs(limit: int = 100):
    return _store.list_logs(min(limit, 500))
