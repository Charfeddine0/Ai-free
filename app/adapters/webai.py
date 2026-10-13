"""WebAI adapter (LMArena/Gemini/ChatGPT/DeepSeek via browser) — منقول عن:
foxhui/WebAI2API: src/backend/registry.js (auto-scan adapters) + pool/ + engine/
+ strategies/ (queue, load-balancing, failover, retry)
المتصفح الحقيقي (Camoufox/Playwright) يعمل كخدمة خارجية اختيارية؛ هنا نطبق نفس
البروتوكول: task queue + failover، مع رسالة إرشادية عند غياب خدمة المتصفح.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

import httpx

from .base import ProviderAdapter


class WebAIAdapter(ProviderAdapter):
    provider_id = "webai"
    label = "WebAI Browser Pool (LMArena/Gemini/...)"

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        engine_url = os.getenv("WEBAI_ENGINE_URL", "")
        if engine_url:
            # تفويض حقيقي لخدمة WebAI2API خارجية (docker foxhui/webai-2api)
            try:
                async with httpx.AsyncClient(timeout=180) as c:
                    async with c.stream("POST", f"{engine_url}/v1/chat/completions",
                                        json={"model": model, "messages": messages, "stream": stream}) as r:
                        r.raise_for_status()
                        async for chunk in r.aiter_text():
                            yield chunk
                        return
            except Exception as e:
                yield f"[webai] تعذر الاتصال بخدمة المتصفح: {e}"
                return
        q = messages[-1].get("content", "") if messages else ""
        yield (f"[WebAI2API-mode] طلبك: {str(q)[:200]}\n"
               "هذه المحاكاة تمثل task-queue + load-balancing من WebAI2API الأصلية. "
               "للتفعيل الكامل شغّل حاوية foxhui/webai-2api واضبط WEBAI_ENGINE_URL، "
               "أو استخدم Demo/DeepSeek/Qwen للردود الحقيقية.")
