// 🗺️ إعدادات المواقع — selectors قابلة للتجاوز (تتغير واجهات الويب باستمرار).
// الاستراتيجية: primary selectors → generic auto-discovery (أي textarea ظاهر).
// تجاوز: ملف sites.override.json بجانب dataDir أو env SITES_OVERRIDE_JSON.

const GENERIC_PROMPT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 15 && r.bottom > 0 && r.top < innerHeight; };
  const cands = [...document.querySelectorAll('textarea, input[type=text], [contenteditable=true][role=textbox], [contenteditable=true]')]
    .filter(vis).filter(el => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
  if (!cands.length) return null;
  cands.sort((a,b) => (b.getBoundingClientRect().bottom) - (a.getBoundingClientRect().bottom));
  const el = cands[0]; const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: el.tagName, editable: el.isContentEditable };
})()`;

const GENERIC_RESPONSE_JS = `(prevLen => () => {
  const els = [...document.querySelectorAll('[data-message-author-role=assistant], .assistant, .message-assistant, main [class*=assistant]')];
  let best = '';
  for (const el of els) { const t = (el.innerText || '').trim(); if (t.length > best.length) best = t; }
  if (!best) {
    const ps = [...document.querySelectorAll('main p, main li')].map(e => (e.innerText||'').trim()).filter(Boolean);
    best = ps.slice(-6).join('\\n');
  }
  return { text: best, grew: best.length > prevLen, len: best.length };
})`;

export const SITES = {
  chatgpt: {
    startUrl: 'https://chatgpt.com/',
    prompt: ['#prompt-textarea', 'textarea[data-id="root"]', 'form textarea'],
    responseAttr: '[data-message-author-role="assistant"]',
    settlePolls: 3, pollMs: 1500, navTimeout: 30000,
  },
  deepseek: {
    startUrl: 'https://chat.deepseek.com/',
    prompt: ['textarea', '#chat-input'],
    responseAttr: '.message--assistant, [class*=assistant]',
    settlePolls: 3, pollMs: 1500, navTimeout: 30000,
  },
  gemini: {
    startUrl: 'https://gemini.google.com/app',
    prompt: ['div[aria-label] [contenteditable=true]', '[contenteditable=true]', 'textarea'],
    responseAttr: 'message-content, .response-container',
    settlePolls: 4, pollMs: 1800, navTimeout: 40000,
  },
  grok: {
    startUrl: 'https://grok.com/',
    prompt: ['textarea', '[contenteditable=true]'],
    responseAttr: '[class*=response], [class*=assistant]',
    settlePolls: 4, pollMs: 1800, navTimeout: 40000,
  },
  qwen: {
    startUrl: 'https://chat.qwen.ai/',
    prompt: ['textarea', '[contenteditable=true]'],
    responseAttr: '[class*=assistant], [class*=answer]',
    settlePolls: 3, pollMs: 1500, navTimeout: 30000,
  },
  lmarena: {
    startUrl: 'https://lmarena.ai/',
    prompt: ['textarea', '[contenteditable=true]'],
    responseAttr: '[class*=response], [class*=message]',
    settlePolls: 5, pollMs: 2000, navTimeout: 40000,
  },
  generic: {
    startUrl: '',
    prompt: [], responseAttr: '',
    settlePolls: 3, pollMs: 1500, navTimeout: 30000,
  },
};

export const PROVIDER_SITE = {
  chatgpt: 'chatgpt', deepseek: 'deepseek', qwen: 'qwen',
  gpt: 'chatgpt', grok: 'grok', gemini: 'gemini',
  glm: 'generic', kimi: 'generic', minimax: 'generic', zai: 'generic',
  perplexity: 'generic', lmarena: 'lmarena', webai: 'lmarena', webchat: 'chatgpt',
};

// اكتشاف تلقائي لموقع webchat/webai من التسمية أو النموذج
export function resolveSite(provider, label = '', model = '') {
  const hay = `${label} ${model}`.toLowerCase();
  if (provider === 'webchat' || provider === 'webai' || provider === 'demo') {
    if (hay.includes('grok')) return 'grok';
    if (hay.includes('gemini')) return 'gemini';
    if (hay.includes('deepseek')) return 'deepseek';
    if (hay.includes('qwen')) return 'qwen';
    if (hay.includes('gpt') || hay.includes('chatgpt')) return 'chatgpt';
    if (hay.includes('arena')) return 'lmarena';
  }
  return PROVIDER_SITE[provider] || 'generic';
}

export function getSite(id, overrides = {}) {
  return { ...(SITES[id] || SITES.generic), ...(overrides[id] || {}) };
}

export { GENERIC_PROMPT_JS, GENERIC_RESPONSE_JS };
