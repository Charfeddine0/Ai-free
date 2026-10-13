"""Central configuration — يجمع إعدادات كل المشاريع الخمسة في مكان واحد."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

APP_NAME = "Ai-Free Unified Gateway"
APP_VERSION = "1.0.0"

# --- Per-provider defaults distilled from upstream analysis ---
# Chat2API (xiaoY233): Electron app, per-provider headers + tokenCheckEndpoint
# ds2api (CJackHwang/Go): in-flight slots + wait queue + PoW solver, base 15s for deepseek
# webchat2api (zqbxdev/FastAPI): gpt/grok/gemini pools, concurrency via account_service
# qwen2API (YuJunZhiXue/Go): create chat -> stream -> delete temp conversation
# WebAI2API (foxhui/Camoufox): adapter registry auto-scan + browser instance isolation
PROVIDER_DEFAULTS: dict = {
    # from Chat2API/src/main/providers/builtin/*.ts + ds2api/internal/deepseek
    "deepseek": {
        "label": "DeepSeek (ds2api + Chat2API-deepseek)",
        "base_cooldown": 15, "jitter": 3, "max_concurrency": 1,
        "api_endpoint": "https://chat.deepseek.com/api",
        "chat_path": "/v0/chat/completion",
        "models": ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"],
        "auth_type": "userToken",
    },
    "chatgpt": {
        "label": "ChatGPT Web (Chat2API + webchat2api-gpt + WebAI2API-chatgpt)",
        "base_cooldown": 8, "jitter": 2, "max_concurrency": 2,
        "models": ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3", "o4-mini"],
        "auth_type": "accessToken",
    },
    "qwen": {
        "label": "Qwen (qwen2API + Chat2API-qwen)",
        "base_cooldown": 10, "jitter": 5, "max_concurrency": 1,
        "api_endpoint": "https://chat.qwen.ai",
        "models": ["qwen-max", "qwen-plus", "qwen-turbo", "qwq-32b", "qwen3-max", "qwen2.5-omni-7b"],
        "auth_type": "bearer",
    },
    "glm": {
        "label": "GLM/Zhipu (Chat2API-glm)",
        "base_cooldown": 8, "jitter": 2, "max_concurrency": 2,
        "models": ["glm-4", "glm-4-plus", "GLM-5.1"],
        "auth_type": "refreshToken",
    },
    "kimi": {
        "label": "Kimi/Moonshot (Chat2API-kimi)",
        "base_cooldown": 8, "jitter": 2, "max_concurrency": 2,
        "models": ["kimi-k2", "Kimi-K2.6", "moonshot-v1-8k"],
        "auth_type": "jwt",
    },
    "grok": {
        "label": "Grok/xAI (webchat2api-grok)",
        "base_cooldown": 5, "jitter": 2, "max_concurrency": 3,
        "models": ["grok-3", "grok-4", "grok-beta"],
        "auth_type": "cookie",
    },
    "gemini": {
        "label": "Gemini (webchat2api-gemini + WebAI2API-gemini)",
        "base_cooldown": 5, "jitter": 2, "max_concurrency": 3,
        "models": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
        "auth_type": "cookie",
    },
    "minimax": {
        "label": "MiniMax (Chat2API-minimax)",
        "base_cooldown": 8, "jitter": 2, "max_concurrency": 2,
        "models": ["MiniMax-M2.7", "abab6.5-chat"],
        "auth_type": "jwt",
    },
    "zai": {
        "label": "Z.ai (Chat2API-zai + WebAI2API-zai)",
        "base_cooldown": 8, "jitter": 2, "max_concurrency": 2,
        "models": ["glm-4.5", "zai-coding"],
        "auth_type": "jwt",
    },
    "lmarena": {
        "label": "LMArena (WebAI2API-lmarena)",
        "base_cooldown": 12, "jitter": 4, "max_concurrency": 1,
        "models": ["lmarena-auto"],
        "auth_type": "browser",
    },
    "perplexity": {
        "label": "Perplexity (Chat2API-perplexity)",
        "base_cooldown": 10, "jitter": 2, "max_concurrency": 1,
        "models": ["pplx-auto"],
        "auth_type": "cookie",
    },
    "demo": {
        "label": "Demo/Mock (يعمل بدون حسابات — للتجربة)",
        "base_cooldown": 3, "jitter": 1, "max_concurrency": 99,
        "models": ["auto", "deepseek-chat", "qwen-max", "gpt-4o-mini", "gemini-2.5-flash"],
        "auth_type": "none",
    },
}

# Virtual model layer: model requested -> ordered fallback list
VIRTUAL_MODELS: dict = {
    "auto": ["deepseek-chat", "qwen-max", "gpt-4o-mini", "gemini-2.5-flash"],
    "reasoning": ["deepseek-reasoner", "qwq-32b", "o3"],
    "gpt-4": ["gpt-4o", "qwen-max", "deepseek-chat"],
    "deepseek-chat": ["deepseek-chat", "deepseek-v4-flash"],
    "deepseek-reasoner": ["deepseek-reasoner", "deepseek-v4-pro"],
}


@dataclass
class Settings:
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8080"))
    data_dir: str = os.getenv("DATA_DIR", "data")
    master_key: str = os.getenv("MASTER_KEY", "ai-free-dev-key-change-me-32bytes!")
    admin_token: str = os.getenv("ADMIN_TOKEN", "")
    default_cooldown: int = int(os.getenv("DEFAULT_COOLDOWN", "15"))
    max_retries: int = int(os.getenv("MAX_RETRIES", "3"))
    allow_demo: bool = os.getenv("ALLOW_DEMO", "1") == "1"

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "ai_free.db")


settings = Settings()


def load_config_file(path: str = "config.json") -> dict:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}
