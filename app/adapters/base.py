"""ProviderAdapter ABC — العقد الموحد الذي تلتزم به كل المحولات الخمسة."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator


class UpstreamError(Exception):
    def __init__(self, message: str, status_code: int = 500, retry_after: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


class RateLimited(UpstreamError):
    def __init__(self, retry_after: int | None = None):
        super().__init__("rate limited by upstream", 429, retry_after)


class ProviderAdapter(ABC):
    provider_id: str = ""
    label: str = ""

    @abstractmethod
    async def chat(self, account: dict, messages: list, model: str, stream: bool = True, **kw) -> AsyncIterator[str]:
        """Yield text deltas (plain strings). Gateway converts to OpenAI SSE."""
        ...

    async def refresh(self, account: dict) -> dict:
        return account

    async def healthcheck(self, account: dict) -> bool:
        try:
            async for _ in self.chat(account, [{"role": "user", "content": "ping"}], "ping", stream=False):
                return True
        except Exception:
            return False
        return True
