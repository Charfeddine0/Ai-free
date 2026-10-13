// Central config — نفس مهلات المزودين المستخلصة من المشاريع الخمسة + طبقة ذكية.
export const APP_NAME = 'Ai-Free Unified Gateway';
export const APP_VERSION = '2.0.0-node';

export const PROVIDER_DEFAULTS = {
  deepseek: { label: 'DeepSeek (ds2api + Chat2API)', baseCooldown: 15, jitter: 3, maxConcurrency: 1, maxRpm: 20, apiEndpoint: 'https://chat.deepseek.com/api', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'], authType: 'userToken' },
  chatgpt:  { label: 'ChatGPT Web (Chat2API + webchat-gpt + WebAI)', baseCooldown: 8, jitter: 2, maxConcurrency: 2, maxRpm: 30, models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o4-mini'], authType: 'accessToken' },
  qwen:     { label: 'Qwen (qwen2API + Chat2API-qwen)', baseCooldown: 10, jitter: 5, maxConcurrency: 1, maxRpm: 20, apiEndpoint: 'https://chat.qwen.ai', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq-32b', 'qwen3-max'], authType: 'bearer' },
  glm:      { label: 'GLM/Zhipu (Chat2API-glm)', baseCooldown: 8, jitter: 2, maxConcurrency: 2, maxRpm: 30, models: ['glm-4', 'glm-4-plus', 'GLM-5.1'], authType: 'refreshToken' },
  kimi:     { label: 'Kimi (Chat2API-kimi)', baseCooldown: 8, jitter: 2, maxConcurrency: 2, maxRpm: 30, models: ['kimi-k2', 'Kimi-K2.6'], authType: 'jwt' },
  grok:     { label: 'Grok/xAI (webchat2api-grok)', baseCooldown: 5, jitter: 2, maxConcurrency: 3, maxRpm: 60, models: ['grok-3', 'grok-4'], authType: 'cookie' },
  gemini:   { label: 'Gemini (webchat-gemini + WebAI-gemini)', baseCooldown: 5, jitter: 2, maxConcurrency: 3, maxRpm: 60, models: ['gemini-2.5-pro', 'gemini-2.5-flash'], authType: 'cookie' },
  minimax:  { label: 'MiniMax (Chat2API-minimax)', baseCooldown: 8, jitter: 2, maxConcurrency: 2, maxRpm: 30, models: ['MiniMax-M2.7'], authType: 'jwt' },
  zai:      { label: 'Z.ai (Chat2API-zai + WebAI-zai)', baseCooldown: 8, jitter: 2, maxConcurrency: 2, maxRpm: 30, models: ['glm-4.5'], authType: 'jwt' },
  lmarena:  { label: 'LMArena (WebAI2API-lmarena)', baseCooldown: 12, jitter: 4, maxConcurrency: 1, maxRpm: 10, models: ['lmarena-auto'], authType: 'browser' },
  perplexity:{ label: 'Perplexity (Chat2API-perplexity)', baseCooldown: 10, jitter: 2, maxConcurrency: 1, maxRpm: 20, models: ['pplx-auto'], authType: 'cookie' },
  demo:     { label: 'Demo/Mock (بدون حسابات)', baseCooldown: 3, jitter: 1, maxConcurrency: 99, maxRpm: 300, models: ['auto', 'deepseek-chat', 'qwen-max', 'gpt-4o-mini', 'gemini-2.5-flash'], authType: 'none' },
};

// Virtual model layer: requested -> ordered fallback chain
export const VIRTUAL_MODELS = {
  auto: ['deepseek-chat', 'qwen-max', 'gpt-4o-mini', 'gemini-2.5-flash'],
  reasoning: ['deepseek-reasoner', 'qwq-32b', 'o3'],
  'gpt-4': ['gpt-4o', 'qwen-max', 'deepseek-chat'],
  'deepseek-chat': ['deepseek-chat', 'deepseek-v4-flash'],
  'deepseek-reasoner': ['deepseek-reasoner', 'deepseek-v4-pro'],
};

export const settings = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || '../data',
  masterKey: process.env.MASTER_KEY || 'ai-free-dev-key-change-me-32bytes!',
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  cacheTtlSec: Number(process.env.CACHE_TTL || 3600),
};
