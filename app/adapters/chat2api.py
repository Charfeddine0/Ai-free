"""ChatGPT/GPT adapter — مدمج من:
- zqbxdev/webchat2api services/providers/gpt (+ base.py AccountAdapter/ChatAdapter)
- foxhui/WebAI2API src/backend/adapter/chatgpt*.js (Camoufox browser pool)
- xiaoY233/Chat2API (general OpenAI-compat pattern)
Supports: accessToken (web) + browser-mode stub when no token.
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from .base import ProviderAdapter, RateLimited, UpstreamError
from ..core.crypto import decrypt
from ..core.config import settings


class ChatGPTAdapter(ProviderAdapter):
    provider_id = "chatgpt"
    label = "ChatGPT Web"

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        token = self._token(account)
        if not token or token.startswith("demo"):
            # browser-mode stub: WebAI2API-style queue would drive Camoufox here.
            # For desktop without credentials we yield a helpful guided message.
            yield ("[وضع المتصفح] لا يوجد accessToken لهذا الحساب. "
                   "أضف accessToken من https://chatgpt.com/api/auth/session "
                   "أو فعّل وضع Demo للتجربة.")
            return
        try:
            async with httpx.AsyncClient(timeout=120) as c:
                async with c.stream(
                    "POST", "https://chatgpt.com/backend-api/conversation",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                    json={"model": model, "messages": messages, "stream": stream},
                ) as r:
                    if r.status_code == 429:
                        raise RateLimited()
                    if r.status_code in (401, 403):
                        raise UpstreamError("session expired", r.status_code)
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if "delta" in line or "message" in line:
                            try:
                                obj = json.loads(line[line.index("{"):])
                                t = obj.get("message", {}).get("content", {}).get("parts", [""])[0]
                                if t:
                                    yield str(t)
                            except Exception:
                                continue
        except (RateLimited, UpstreamError):
            raise
        except Exception as e:
            raise UpstreamError(str(e))

    def _token(self, account: dict) -> str:
        blob = account.get("credentials_enc", "")
        try:
            creds = decrypt(settings.master_key, blob) if blob else ""
        except Exception:
            creds = ""
        try:
            return json.loads(creds).get("token", creds) if creds else ""
        except Exception:
            return creds
