"""Automated tests for cooldown + routing + API."""
from fastapi.testclient import TestClient

from app.core.cooldown import is_ready, mark_used, remaining_seconds
from app.core.routing import get_next_account


def _mk(pid="a1", **kw):
    d = {"id": pid, "provider": "demo", "label": pid, "status": "READY",
         "cooldown_until": 0, "cooldown_seconds": 15, "base_cooldown": 15,
         "consecutive_fails": 0, "last_used_at": 0, "success_count": 10,
         "fail_count": 0, "avg_latency_ms": 500, "health_score": 0.99,
         "quota_remaining": 100, "priority": 5, "models": ["auto", "deepseek-chat"],
         "enabled": True}
    d.update(kw)
    return d


def test_cooldown_15s_default():
    a = mark_used(_mk(), True, 200, None, 1200)
    assert a["status"] == "COOLDOWN"
    assert 15 <= a["cooldown_seconds"] <= 18  # 15 + jitter 0..3
    assert not is_ready(a)
    assert remaining_seconds(a) > 0


def test_backoff_on_429():
    a = mark_used(_mk(), False, 429, 10)
    assert a["status"] == "RATE_LIMITED"
    assert a["cooldown_seconds"] >= 30


def test_routing_prefers_ready():
    busy = mark_used(_mk("busy"), True)
    free = _mk("free")
    acc, wait = get_next_account([busy, free], "deepseek-chat")
    assert acc is not None and acc["id"] == "free"


def test_routing_wait_when_all_cooldown():
    b1 = mark_used(_mk("b1"), True)
    b2 = mark_used(_mk("b2"), True)
    acc, wait = get_next_account([b1, b2], "deepseek-chat")
    assert acc is None and wait is not None and wait > 0


def test_api_flow():
    import tempfile
    import os
    os.environ["DATA_DIR"] = tempfile.mkdtemp()
    from importlib import reload
    import app.core.config as cfg
    reload(cfg)
    from app.main import app
    c = TestClient(app)
    assert c.get("/healthz").status_code == 200
    ms = c.get("/v1/models").json()
    assert "data" in ms
    st = c.get("/api/accounts/status").json()
    assert st["ready"] >= 1
    r = c.post("/v1/chat/completions",
               json={"model": "auto", "messages": [{"role": "user", "content": "مرحبا"}],
                     "stream": False, "allow_wait": False})
    assert r.status_code in (200, 429)
