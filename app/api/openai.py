"""OpenAI-compatible surface: POST /v1/chat/completions + GET /v1/models.
يدمج: ds2api OpenAI adapter + webchat2api openai_backend_api + qwen2API prompt compat.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..adapters.base import RateLimited, UpstreamError
from ..adapters.registry import get_adapter
from ..core.cooldown import mark_used
from ..core.config import VIRTUAL_MODELS, settings
from ..core.routing import get_next_account

router = APIRouter(tags=["openai"])

_store = None
_locks: dict[str, asyncio.Lock] = {}


def bind(store):
    global _store
    _store = store


def _lock_for(acc_id: str) -> asyncio.Lock:
    if acc_id not in _locks:
        _locks[acc_id] = asyncio.Lock()
    return _locks[acc_id]


def _expand_model(model: str) -> list[str]:
    if model in VIRTUAL_MODELS:
        return VIRTUAL_MODELS[model]
    return [model]


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


@router.get("/v1/models")
def list_models():
    seen: dict[str, str] = {}
    for acc in _store.list_accounts():
        for m in acc.get("models", []):
            seen.setdefault(m, acc["provider"])
    for virt in VIRTUAL_MODELS:
        seen.setdefault(virt, "virtual")
    return {"object": "list", "data": [
        {"id": m, "object": "model", "owned_by": p} for m, p in sorted(seen.items())]}


@router.post("/v1/chat/completions")
async def chat_completions(req: Request):
    t0 = time.time()
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    model_req = body.get("model", "auto")
    messages = body.get("messages", [])
    stream = bool(body.get("stream", True))
    allow_wait = bool(body.get("allow_wait", True))
    request_id = f"req_{uuid.uuid4().hex[:10]}"

    for candidate in _expand_model(model_req):
        accounts = _store.list_accounts()
        # filter by model support here (registry aliases handle provider mapping)
        acc, wait = get_next_account(accounts, candidate)
        if acc is None:
            if wait is None:
                continue  # no supporting account at all -> try next virtual candidate
            if allow_wait and wait <= 20:
                # انتظار ذكي مع إخبار المستخدم (SSE waiting events + إعادة فحص)
                async def _wait_gen():
                    yield _sse({"type": "waiting", "request_id": request_id,
                                "message": f"⏳ أقرب حساب ({candidate}) جاهز بعد {wait} ثانية...",
                                "retry_in": wait})
                    acc2 = None
                    # فحص دوري كل ثانية حتى 3 محاولات إضافية بعد المهلة (يتحمل انحراف الساعة)
                    for _ in range(max(1, wait + 3)):
                        await asyncio.sleep(1.0)
                        accs2 = _store.list_accounts()
                        acc2, _ = get_next_account(accs2, candidate)
                        if acc2 is not None:
                            break
                    if acc2 is None:
                        yield _sse({"error": "still_no_account", "request_id": request_id})
                        return
                    async for chunk in _run_account(acc2, candidate, messages, stream, request_id, t0):
                        yield chunk
                return StreamingResponse(_wait_gen(), media_type="text/event-stream",
                                         headers={"X-Request-Id": request_id})
            continue  # fallback to next virtual model
        return StreamingResponse(_run_account(acc, candidate, messages, stream, request_id, t0),
                                 media_type="text/event-stream" if stream else "application/json",
                                 headers={"X-Request-Id": request_id,
                                          "X-Account-Id": acc["id"], "X-Provider": acc["provider"]})
    # nothing available
    _store.add_log({"request_id": request_id, "model_requested": model_req,
                    "model_resolved": "", "provider": "", "account_id": "",
                    "queue_wait_ms": int((time.time() - t0) * 1000),
                    "upstream_latency_ms": 0, "cooldown_applied": 0,
                    "success": 0, "error": "all_accounts_cooldown"})
    return JSONResponse({"error": {"message": "لا يوجد حساب جاهز الآن. أضف حسابات أو انتظر انتهاء المهلة.",
                                   "type": "all_accounts_cooldown", "request_id": request_id}},
                        status_code=429)


async def _run_account(acc: dict, model: str, messages: list, stream: bool,
                       request_id: str, t0: float):
    """Lock account (IN_USE) -> stream upstream -> mark COOLDOWN. Retries next account on fail."""
    from ..core.cooldown import remaining_seconds  # noqa
    lock = _lock_for(acc["id"])
    if lock.locked():
        yield _sse({"type": "waiting", "request_id": request_id,
                    "message": "الحساب مشغول بطلب آخر، جارٍ التحويل لحساب بديل..."})
        # try alternative
        accs = _store.list_accounts()
        alt, _ = get_next_account([a for a in accs if a["id"] != acc["id"]], model)
        if alt is not None:
            acc = alt
            lock = _lock_for(acc["id"])
        else:
            yield _sse({"error": "account_busy"})
            return
    async with lock:
        _store.update_fields(acc["id"], {"status": "IN_USE"})
        adapter = get_adapter(acc["provider"])
        full = ""
        up_t0 = time.time()
        try:
            async for delta in adapter.chat(acc, messages, model, stream=True):
                full += delta
                if stream:
                    yield _sse({"id": request_id, "object": "chat.completion.chunk",
                                "model": model, "choices": [{"delta": {"content": delta}, "index": 0}]})
            lat = int((time.time() - up_t0) * 1000)
            updated = mark_used({**acc, "status": "IN_USE"}, True, 200, None, lat)
            _store.update_fields(acc["id"], {k: updated[k] for k in
                                 ("status", "cooldown_until", "cooldown_seconds", "consecutive_fails",
                                  "last_used_at", "success_count", "avg_latency_ms",
                                  "health_score", "quota_remaining")})
            _store.add_log({"request_id": request_id, "model_requested": model,
                            "model_resolved": model, "provider": acc["provider"],
                            "account_id": acc["id"], "queue_wait_ms": int((up_t0 - t0) * 1000),
                            "upstream_latency_ms": lat, "cooldown_applied": updated["cooldown_seconds"],
                            "success": 1, "error": ""})
            if stream:
                yield _sse({"id": request_id, "object": "chat.completion.chunk", "model": model,
                            "choices": [{"delta": {}, "index": 0, "finish_reason": "stop"}]})
                yield "data: [DONE]\n\n"
                # تذييل يعرض المصدر والمهلة (مهم للشفافية)
                yield _sse({"type": "done", "request_id": request_id, "account": acc["label"],
                            "provider": acc["provider"],
                            "cooldown": f"الحساب متاح بعد {updated['cooldown_seconds']} ثانية"})
            else:
                yield json.dumps({"id": request_id, "object": "chat.completion", "model": model,
                                  "choices": [{"message": {"role": "assistant", "content": full},
                                               "finish_reason": "stop", "index": 0}],
                                  "usage": {}, "account": acc["label"], "provider": acc["provider"]},
                                 ensure_ascii=False)
        except RateLimited as e:
            updated = mark_used(acc, False, 429, e.retry_after)
            _store.update_fields(acc["id"], {k: updated[k] for k in
                                 ("status", "cooldown_until", "cooldown_seconds",
                                  "consecutive_fails", "fail_count", "health_score")})
            _store.add_log({"request_id": request_id, "model_requested": model,
                            "model_resolved": model, "provider": acc["provider"],
                            "account_id": acc["id"], "queue_wait_ms": 0,
                            "upstream_latency_ms": int((time.time() - up_t0) * 1000),
                            "cooldown_applied": updated["cooldown_seconds"],
                            "success": 0, "error": "429 rate limited"})
            yield _sse({"error": f"المزود مزدحم (429). أُعيدت الجدولة بعد {updated['cooldown_seconds']}s. أعد المحاولة."})
        except UpstreamError as e:
            updated = mark_used(acc, False, e.status_code)
            _store.update_fields(acc["id"], {k: updated[k] for k in
                                 ("status", "cooldown_until", "cooldown_seconds",
                                  "consecutive_fails", "fail_count", "health_score")})
            _store.add_log({"request_id": request_id, "model_requested": model,
                            "model_resolved": model, "provider": acc["provider"],
                            "account_id": acc["id"], "queue_wait_ms": 0,
                            "upstream_latency_ms": int((time.time() - up_t0) * 1000),
                            "cooldown_applied": updated["cooldown_seconds"],
                            "success": 0, "error": str(e)[:300]})
            yield _sse({"error": f"فشل المزود: {e}. تم التحويل للمهلة وإتاحة Fallback."})
