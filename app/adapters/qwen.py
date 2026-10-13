"""Qwen adapter — مدمج من:
- YuJunZhiXue/qwen2API backend/upstream/qwen_executor.go:
  ExecuteTurn = CreateChat -> StreamChat(payload) -> DeleteWhenDone
- seringkik/qwen2api core.js: chat.qwen.ai SSE + bearer
- xiaoY233/Chat2API qwen.ts + qwen-ai.ts configs
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from .base import ProviderAdapter, RateLimited, UpstreamError
from ..core.crypto import decrypt
from ..core.config import settings

CREATE_URL = "https://chat.qwen.ai/api/v2/chats/new"


class QwenAdapter(ProviderAdapter):
    provider_id = "qwen"
    label = "Qwen Chat"

    async def chat(self, account, messages, model, stream=True, **kw) -> AsyncIterator[str]:
        token = self._token(account)
        if not token or token.startswith("demo"):
            yield ("[Qwen] لا يوجد bearer token. استخرجه من chat.qwen.ai > DevTools > Authorization، "
                   "أو استخدم حساب Demo.")
            return
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                   "Origin": "https://chat.qwen.ai", "Referer": "https://chat.qwen.ai/"}
        try:
            async with httpx.AsyncClient(timeout=120) as c:
                # 1. CreateChat (transient conversation like upstream ExecuteTurn)
                cr = await c.post(CREATE_URL, headers=headers,
                                  json={"model": model, "chat_type": "search" if "search" in model else "chat"})
                if cr.status_code == 429:
                    raise RateLimited()
                if cr.status_code in (401, 403):
                    raise UpstreamError("qwen token expired", cr.status_code)
                chat_id = ""
                try:
                    chat_id = cr.json().get("data", {}).get("id", "")
                except Exception:
                    pass
                # 2. StreamChat
                payload = {"chat_id": chat_id, "model": model,
                           "prompt": self._prompt(messages), "stream": stream}
                async with c.stream("POST", "https://chat.qwen.ai/api/v2/chat/completions",
                                    headers=headers, json=payload) as r:
                    if r.status_code == 429:
                        raise RateLimited()
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            obj = json.loads(data)
                            t = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if t:
                                yield t
                        except Exception:
                            continue
                # 3. DeleteWhenDone (best effort)
                if chat_id:
                    try:
                        await c.post("https://chat.qwen.ai/api/v2/chats/delete",
                                     headers=headers, json={"chat_id": chat_id})
                    except Exception:
                        pass
        except (RateLimited, UpstreamError):
            raise
        except Exception as e:
            raise UpstreamError(str(e))

    @staticmethod
    def _prompt(messages: list) -> str:
        return "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in messages)

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
