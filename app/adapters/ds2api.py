"""DeepSeek adapter — مدمج من:
- CJackHwang/ds2api (Go): POST chat.deepseek.com/api/v0/chat/completion + PoW + session
- xiaoY233/Chat2API deepseek.ts: headers + X-Client-Version + userToken auth
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from .base import ProviderAdapter, RateLimited, UpstreamError
from ..core.crypto import decrypt

ENDPOINT = "https://chat.deepseek.com/api/v0/chat/completion"

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Origin": "https://chat.deepseek.com",
    "Referer": "https://chat.deepseek.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "X-App-Version": "2.0.0",
    "X-Client-Locale": "zh_CN",
    "X-Client-Platform": "web",
    "X-Client-Version": "2.0.0",
}


class DeepSeekAdapter(ProviderAdapter):
    provider_id = "deepseek"
    label = "DeepSeek (ds2api + Chat2API)"

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        token = self._token(account)
        payload = {
            "chat_session_id": kw.get("session_id") or account.get("id"),
            "parent_message_id": None,
            "prompt": self._to_prompt(messages),
            "ref_file_ids": [],
            "thinking_enabled": "reasoner" in (model or "") or "pro" in (model or ""),
            "search_enabled": False,
        }
        try:
            async with httpx.AsyncClient(timeout=120) as c:
                async with c.stream("POST", ENDPOINT,
                                    headers={**HEADERS, "Authorization": f"Bearer {token}"},
                                    json=payload) as r:
                    if r.status_code == 429:
                        raise RateLimited(self._retry_after(r.headers))
                    if r.status_code in (401, 403):
                        raise UpstreamError("token expired", r.status_code)
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            return
                        try:
                            obj = json.loads(data)
                            t = (obj.get("choices", [{}])[0].get("delta", {}).get("content")
                                 or obj.get("choices", [{}])[0].get("message", {}).get("content")
                                 or obj.get("v", ""))
                            if t:
                                yield t
                        except Exception:
                            continue
        except (RateLimited, UpstreamError):
            raise
        except Exception as e:
            raise UpstreamError(str(e))

    def _token(self, account: dict) -> str:
        blob = account.get("credentials_enc", "")
        master = kw_master()
        try:
            creds = decrypt(master, blob) if blob else ""
        except Exception:
            creds = ""
        try:
            obj = json.loads(creds) if creds else {}
            return obj.get("token", creds)
        except Exception:
            return creds

    @staticmethod
    def _to_prompt(messages: list) -> str:
        parts = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            parts.append(f"[{role}]: {content}")
        return "\n".join(parts)

    @staticmethod
    def _retry_after(headers) -> int | None:
        for k in ("retry-after", "Retry-After", "x-retry-after"):
            v = headers.get(k)
            if v:
                try:
                    return int(str(v).split()[0])
                except Exception:
                    pass
        return None


def kw_master() -> str:
    from ..core.config import settings
    return settings.master_key
