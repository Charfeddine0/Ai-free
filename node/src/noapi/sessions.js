// 🍪 مسبح الجلسات — cookies لكل حساب + صحة + تدوير (مثل webchat2api account_service).
// التخزين الدائم عبر credentials_enc في DB؛ هنا منطق الذاكرة والاختيار.

export function parseCookies(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((c) => c && c.name);
  if (typeof input === 'object') {
    return Object.entries(input).map(([name, value]) => ({ name, value: String(value) }));
  }
  const text = String(input).trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      if (Array.isArray(o)) return o.filter((c) => c && c.name);
      return parseCookies(o);
    } catch { return []; }
  }
  // Netscape cookie jar (curl -c)
  const out = [];
  const pushPair = (seg) => {
    const i = seg.indexOf('=');
    if (i > 0) out.push({ name: seg.slice(0, i).trim(), value: seg.slice(i + 1).trim() });
  };
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#') && !l.includes('\t')) continue;
    const parts = l.split('\t');
    if (parts.length >= 7) {
      out.push({ domain: parts[0], path: parts[2] || '/', secure: parts[3] === 'TRUE', name: parts[5], value: parts[6] });
    } else if (l.includes('\t')) {
      continue;
    } else {
      // name=value; name2=value2 (ترويسة Cookie)
      for (const seg of l.split(';')) pushPair(seg.trim());
    }
  }
  return out.filter((c) => c.name);
}

export function cookiesHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

const MAX_FAILS = 3;

export class SessionPool {
  constructor() {
    this.map = new Map(); // accountId -> {cookies, fp, fails, lastOk, uses, updatedAt}
  }

  load(accountId, cookies, fp = null) {
    const list = parseCookies(cookies);
    if (!list.length) return 0;
    const cur = this.map.get(accountId);
    this.map.set(accountId, {
      cookies: list, fp: fp || cur?.fp || null,
      fails: 0, lastOk: cur?.lastOk || 0, uses: cur?.uses || 0, updatedAt: Date.now(),
    });
    return list.length;
  }

  get(accountId) {
    return this.map.get(accountId) || null;
  }

  healthy(accountId) {
    const s = this.map.get(accountId);
    return !!s && s.cookies.length > 0 && s.fails < MAX_FAILS;
  }

  use(accountId) {
    const s = this.map.get(accountId);
    if (!s || !this.healthy(accountId)) return null;
    s.uses += 1;
    return s;
  }

  markOk(accountId) {
    const s = this.map.get(accountId);
    if (s) { s.fails = 0; s.lastOk = Date.now(); }
  }

  markFail(accountId) {
    const s = this.map.get(accountId);
    if (s) s.fails += 1;
  }

  stats() {
    return [...this.map].map(([id, s]) => ({
      accountId: id, cookies: s.cookies.length, fails: s.fails,
      uses: s.uses, lastOk: s.lastOk, healthy: this.healthy(id),
    }));
  }
}
