"""Adapter registry — نفس فكرة WebAI2API registry.js: تسجيل تلقائي."""
from __future__ import annotations

from .base import ProviderAdapter
from .chat2api import ChatGPTAdapter
from .demo import DemoAdapter
from .ds2api import DeepSeekAdapter
from .qwen import QwenAdapter
from .webai import WebAIAdapter
from .webchat import WebChatAdapter

_REGISTRY: dict[str, ProviderAdapter] = {}


def _register(a: ProviderAdapter):
    _REGISTRY[a.provider_id] = a


for _cls in (DeepSeekAdapter, ChatGPTAdapter, QwenAdapter, WebChatAdapter, WebAIAdapter, DemoAdapter):
    _register(_cls())

# aliases: webchat2api sub-pools + Chat2API builtin ids -> adapter
_ALIASES = {
    "gpt": "chatgpt", "grok": "webchat", "gemini": "webchat",
    "glm": "chatgpt", "kimi": "chatgpt", "minimax": "chatgpt",
    "zai": "chatgpt", "perplexity": "webchat", "lmarena": "webai",
    "deepseek": "deepseek", "qwen": "qwen", "chatgpt": "chatgpt",
    "webchat": "webchat", "webai": "webai", "demo": "demo",
}


def get_adapter(provider: str) -> ProviderAdapter:
    key = _ALIASES.get(provider, provider)
    return _REGISTRY.get(key, _REGISTRY["demo"])


def list_adapters() -> list[dict]:
    return [{"id": a.provider_id, "label": a.label} for a in _REGISTRY.values()]
