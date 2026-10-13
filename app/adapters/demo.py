"""Demo adapter — يولد ردوداً محلية ذكية (streaming) بدون أي حسابات.
مفيد للتجربة الفورية + للاختبارات الآلية.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator

from .base import ProviderAdapter


class DemoAdapter(ProviderAdapter):
    provider_id = "demo"
    label = "Demo (local)"

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        last = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                last = str(m.get("content", ""))
                break
        prov = account.get("provider", "demo")
        acc = account.get("label", account.get("id", "demo"))
        text = (f"🤖 رد تجريبي من [{prov}/{acc}] على النموذج `{model}`.\n\n"
                f"سؤالك: {last[:500]}\n\n"
                f"أضف حساباً حقيقياً (DeepSeek/Qwen/ChatGPT) من تبويب الحسابات "
                f"للحصول على ردود حية. هذا الحساب خضع لمهلة {account.get('cooldown_seconds', 3)} ثوانٍ "
                f"تماماً مثل الحسابات الحقيقية.")
        if not stream:
            yield text
            return
        # محاكاة streaming كلمة-كلمة
        for word in text.split(" "):
            yield word + " "
            await asyncio.sleep(0.01)
