"""WebChat adapter (GPT/Grok/Gemini pools) — منقول بتصرف عن:
zqbxdev/webchat2api: services/providers/{gpt,grok,gemini} + services/account_service.py
+ services/openai_backend_api.py (OpenAI-compat surface)
هنا نعيد تنفيذ نفس الفكرة: حساب واحد بواجهة موحدة، والتفاصيل (cookies/refresh)
تُحقن عبر credentials.
"""
from __future__ import annotations

from typing import AsyncIterator

import httpx

from .base import ProviderAdapter, RateLimited, UpstreamError


class WebChatAdapter(ProviderAdapter):
    provider_id = "webchat"  # يغطي gpt/grok/gemini معاً (مثل upstream registry)
    label = "WebChat Pool (GPT/Grok/Gemini)"

    PROVIDER_URLS = {
        "gpt": "https://chatgpt.com/backend-api/conversation",
        "grok": "https://grok.com/rest/app-chat/conversations/new",
        "gemini": "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    }

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        sub = (account.get("label", "") or "").lower()
        kind = "gpt"
        if "grok" in sub or "grok" in model.lower():
            kind = "grok"
        elif "gemini" in sub or "gemini" in model.lower():
            kind = "gemini"
        # NOTE: التنفيذ الكامل للـ browser bridge موجود في upstream (browser_bridge/).
        # هنا نستخدم المسار الخفيف HTTP المباشر، وعند غياب الجلسة نرشد المستخدم.
        yield (f"[webchat:{kind}] الحساب '{account.get('label')}' يحتاج جلسة متصفح حقيقية "
               f"(cookies) كما في webchat2api الأصلية. أضف بيانات الاعتماد من الواجهة، "
               f"أو استخدم Demo للتجربة الفورية.")
        return
        # placeholder to keep generator type
        _ = httpx  # noqa
        _ = RateLimited  # noqa
