// Provider Adapters — منطق المشاريع الخمسة مُعاد تنفيذه بـ fetch الأصلي في Node.
// deepseek: ds2api (Go) + Chat2API deepseek.ts headers
// chatgpt: webchat2api gpt + WebAI2API chatgpt.js
// qwen: qwen2API ExecuteTurn (create -> stream -> delete) + qwen.ts
// webchat: webchat2api pools (gpt/grok/gemini)
// webai: WebAI2API registry + engine delegation عبر WEBAI_ENGINE_URL
// demo: رد محلي فوري
import { decrypt } from './crypto.js';
import { settings } from './config.js';

export class UpstreamError extends Error {
  constructor(message, statusCode = 500, retryAfter = null) {
    super(message); this.statusCode = statusCode; this.retryAfter = retryAfter;
  }
}
export class RateLimited extends UpstreamError {
  constructor(retryAfter = null) { super('rate limited by upstream', 429, retryAfter); }
}

const tokenOf = (account) => {
  try {
    const raw = decrypt(settings.masterKey, account.credentials_enc || '');
    try { return JSON.parse(raw).token || raw; } catch { return raw; }
  } catch { return ''; }
};

const promptOf = (messages) =>
  messages.map((m) => `[${m.role || 'user'}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');

async function* sseTexts(res) {
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const o = JSON.parse(data);
      const t = o.choices?.[0]?.delta?.content || o.choices?.[0]?.message?.content || o.v || '';
      if (t) yield t;
    } catch { /* تجاهل الأسطر غير الصالحة */ }
  }
}

class BaseAdapter {
  constructor(id, label) { this.id = id; this.label = label; }
  // eslint-disable-next-line no-unused-vars
  async *chat(account, messages, model, opts) { throw new Error('not implemented'); }
  async refresh(account) { return account; }
}

// ---- DeepSeek: POST chat.deepseek.com/api/v0/chat/completion ----
class DeepSeekAdapter extends BaseAdapter {
  constructor() { super('deepseek', 'DeepSeek (ds2api + Chat2API)'); }
  async *chat(account, messages, model) {
    const token = tokenOf(account);
    const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Origin: 'https://chat.deepseek.com', Referer: 'https://chat.deepseek.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'X-Client-Platform': 'web', 'X-Client-Version': '2.0.0', Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chat_session_id: account.id, prompt: promptOf(messages),
        thinking_enabled: /reasoner|pro/i.test(model || ''), search_enabled: false,
      }),
    });
    if (res.status === 429) throw new RateLimited(res.headers.get('retry-after'));
    if ([401, 403].includes(res.status)) throw new UpstreamError('token expired', res.status);
    if (!res.ok) throw new UpstreamError(`deepseek http ${res.status}`, res.status);
    yield* sseTexts(res);
  }
}

// ---- ChatGPT Web ----
class ChatGPTAdapter extends BaseAdapter {
  constructor() { super('chatgpt', 'ChatGPT Web'); }
  async *chat(account, messages, model) {
    const token = tokenOf(account);
    if (!token || token.startsWith('demo')) {
      yield '[وضع المتصفح] لا يوجد accessToken. أضفه من https://chatgpt.com/api/auth/session أو استخدم Demo.';
      return;
    }
    const res = await fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (res.status === 429) throw new RateLimited();
    if ([401, 403].includes(res.status)) throw new UpstreamError('session expired', res.status);
    if (!res.ok) throw new UpstreamError(`chatgpt http ${res.status}`, res.status);
    yield* sseTexts(res);
  }
}

// ---- Qwen: CreateChat -> Stream -> Delete (مثل ExecuteTurn في Go) ----
class QwenAdapter extends BaseAdapter {
  constructor() { super('qwen', 'Qwen Chat'); }
  async *chat(account, messages, model) {
    const token = tokenOf(account);
    if (!token || token.startsWith('demo')) {
      yield '[Qwen] لا يوجد bearer token. استخرجه من chat.qwen.ai > DevTools > Authorization أو استخدم Demo.';
      return;
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://chat.qwen.ai', Referer: 'https://chat.qwen.ai/' };
    const cr = await fetch('https://chat.qwen.ai/api/v2/chats/new', { method: 'POST', headers, body: JSON.stringify({ model }) });
    if (cr.status === 429) throw new RateLimited();
    if ([401, 403].includes(cr.status)) throw new UpstreamError('qwen token expired', cr.status);
    let chatId = '';
    try { chatId = (await cr.json()).data?.id || ''; } catch { /* */ }
    const res = await fetch('https://chat.qwen.ai/api/v2/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ chat_id: chatId, model, prompt: promptOf(messages), stream: true }),
    });
    if (res.status === 429) throw new RateLimited();
    if (!res.ok) throw new UpstreamError(`qwen http ${res.status}`, res.status);
    yield* sseTexts(res);
    if (chatId) fetch('https://chat.qwen.ai/api/v2/chats/delete', { method: 'POST', headers, body: JSON.stringify({ chat_id: chatId }) }).catch(() => {});
  }
}

// ---- WebChat pools (gpt/grok/gemini) — يحتاج جلسة متصفح حقيقية كما في الأصل ----
class WebChatAdapter extends BaseAdapter {
  constructor() { super('webchat', 'WebChat Pool (GPT/Grok/Gemini)'); }
  async *chat(account, messages, model) {
    const sub = `${account.label} ${model}`.toLowerCase();
    const kind = sub.includes('grok') ? 'grok' : sub.includes('gemini') ? 'gemini' : 'gpt';
    yield `[webchat:${kind}] الحساب '${account.label}' يحتاج جلسة متصفح حقيقية (cookies) كما في webchat2api الأصلية. أضف بيانات الاعتماد أو استخدم Demo.`;
  }
}

// ---- WebAI browser pool — تفويض لخدمة WebAI2API الحقيقية إن وُجدت ----
class WebAIAdapter extends BaseAdapter {
  constructor() { super('webai', 'WebAI Browser Pool'); }
  async *chat(account, messages) {
    const engine = process.env.WEBAI_ENGINE_URL || '';
    if (engine) {
      const res = await fetch(`${engine}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'auto', messages, stream: false }),
      });
      if (!res.ok) throw new UpstreamError(`webai engine http ${res.status}`, res.status);
      const o = await res.json();
      yield o.choices?.[0]?.message?.content || JSON.stringify(o);
      return;
    }
    const q = messages.at(-1)?.content || '';
    yield `[WebAI2API-mode] طلبك: ${String(q).slice(0, 200)}\nمحاكاة task-queue + load-balancing من الأصل. شغّل حاوية foxhui/webai-2api واضبط WEBAI_ENGINE_URL للتفعيل الكامل.`;
  }
}

// ---- Demo ----
class DemoAdapter extends BaseAdapter {
  constructor() { super('demo', 'Demo (local)'); }
  async *chat(account, messages, model) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const q = String(last?.content || '').slice(0, 500);
    const text = `🤖 رد تجريبي من [${account.provider}/${account.label}] على \`${model}\`.\n\nسؤالك: ${q}\n\nأضف حساباً حقيقياً للحصول على ردود حية. هذا الحساب خضع لمهلة ${account.cooldown_seconds} ثوانٍ مثل الحسابات الحقيقية.`;
    for (const w of text.split(' ')) yield w + ' ';
  }
}

const registry = new Map();
for (const A of [DeepSeekAdapter, ChatGPTAdapter, QwenAdapter, WebChatAdapter, WebAIAdapter, DemoAdapter]) {
  const a = new A();
  registry.set(a.id, a);
}
const ALIASES = {
  gpt: 'chatgpt', grok: 'webchat', gemini: 'webchat', glm: 'chatgpt', kimi: 'chatgpt',
  minimax: 'chatgpt', zai: 'chatgpt', perplexity: 'webchat', lmarena: 'webai',
  deepseek: 'deepseek', qwen: 'qwen', chatgpt: 'chatgpt', webchat: 'webchat', webai: 'webai', demo: 'demo',
};

export const getAdapter = (provider) => registry.get(ALIASES[provider] || provider) || registry.get('demo');
export const listAdapters = () => [...registry.values()].map((a) => ({ id: a.id, label: a.label }));
