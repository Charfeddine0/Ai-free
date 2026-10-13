"""Ai-Free Unified Gateway — نقطة الدخول.
FastAPI app يجمع المستودعات الخمسة خلف /v1/* مع Web UI مدمجة.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import accounts as accounts_api
from .api import openai as openai_api
from .api import system as system_api
from .core.config import APP_NAME, APP_VERSION, settings
from .core.store import Store

BASE = os.path.dirname(os.path.abspath(__file__))

store = Store(settings.db_path)
accounts_api.bind(store)
openai_api.bind(store)
system_api.bind(store)

# حساب Demo افتراضي للتجربة الفورية (من webchat2api فكرة guest pool)
if settings.allow_demo and not store.list_accounts():
    from .core.crypto import encrypt
    import json as _json
    store.upsert_account({
        "id": "acc_demo_01", "provider": "demo", "label": "Demo Account 1",
        "credentials_enc": encrypt(settings.master_key, _json.dumps({"token": "demo-local"})),
        "status": "READY", "cooldown_until": 0, "cooldown_seconds": 3,
        "base_cooldown": 3, "consecutive_fails": 0, "last_used_at": 0,
        "success_count": 0, "fail_count": 0, "avg_latency_ms": 300,
        "health_score": 1.0, "quota_remaining": 100000, "priority": 1,
        "models": ["auto", "deepseek-chat", "qwen-max", "gpt-4o-mini", "gemini-2.5-flash"],
        "enabled": True,
    })

app = FastAPI(title=APP_NAME, version=APP_VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

app.include_router(openai_api.router)
app.include_router(accounts_api.router)
app.include_router(system_api.router)

static_dir = os.path.join(BASE, "ui", "static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
def index():
    idx = os.path.join(static_dir, "index.html")
    if os.path.exists(idx):
        return FileResponse(idx)
    return {"app": APP_NAME, "version": APP_VERSION, "docs": "/docs"}


def run():
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    run()
