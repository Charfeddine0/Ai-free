// 🌐 عميل CDP مصغّر — بدون مكتبات (WebSocket مدمج في Node 22+).
// يتحكم بكروم حقيقي يعمل بـ:  chrome --remote-debugging-port=9222
// الفكرة من WebAI2API (Camoufox) لكن ببروتوكول CDP الخام بدل المتصفح المضمن.
import { randomBytes } from 'node:crypto';

export const debugBase = () => process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
export const browserConfigured = () => !!process.env.CHROME_DEBUG_URL;

// ---------- WebSocket codec (للـ mock server في الاختبارات) ----------
export function wsEncode(text) {
  const data = Buffer.from(text);
  const len = data.length;
  const mask = randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export function wsEncodeServer(text) {
  const data = Buffer.from(text);
  const len = data.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), data]);
  const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2);
  return Buffer.concat([h, data]);
}

export function wsDecodeFrame(buf) {
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (buf[1] & 0x80) { mask = buf.subarray(off, off + 4); off += 4; }
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, length: off + len };
}

// ---------- عميل الصفحة ----------
export class CdpPage {
  constructor(wsUrl, targetId, base) {
    this.wsUrl = wsUrl; this.targetId = targetId; this.base = base;
    this.seq = 0; this.pending = new Map(); this.events = new Map();
  }

  static async open(base = debugBase()) {
    let t;
    try {
      const r = await fetch(base + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('http ' + r.status);
      t = await r.json();
    } catch (e) {
      throw new Error('لا يوجد كروم للتحكم. شغّل: chrome --remote-debugging-port=9222  (' + e.message + ')');
    }
    const page = new CdpPage(t.webSocketDebuggerUrl, t.id, base);
    await page._connect();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
      const ws = new WebSocket(this.wsUrl);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      ws.onmessage = (e) => this._onMsg(String(e.data));
      ws.onclose = () => {
        for (const [, p] of this.pending) p.reject(new Error('ws closed'));
        this.pending.clear();
      };
      this.ws = ws;
    });
  }

  _onMsg(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error('cdp: ' + (m.error.message || JSON.stringify(m.error))));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of this.events.get(m.method) || []) fn(m.params || {});
    }
  }

  onEvent(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 25000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url, timeoutMs = 30000) {
    const loaded = new Promise((resolve) => {
      const to = setTimeout(resolve, timeoutMs);
      this.onEvent('Page.loadEventFired', () => { clearTimeout(to); resolve(); });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .then((r) => r?.result?.value);
  }

  async waitFor(condExpr, timeoutMs = 25000, pollMs = 700) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.evaluate(condExpr)) return true; } catch { /* الصفحة تتحمّل */ }
      if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout: ' + condExpr.slice(0, 80));
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async mouseMovePath(pts, stepMs = 12) {
    for (const p of pts) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  typeText(text) {
    return this.send('Input.insertText', { text });
  }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  }

  async shot() {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    return r?.data || '';
  }

  cookies() {
    return this.send('Storage.getCookies').then((r) => r?.cookies || []);
  }

  async setCookies(cookies) {
    if (cookies?.length) await this.send('Storage.setCookies', { cookies });
  }

  async close() {
    try { this.ws?.close(); } catch { /* */ }
    try { await fetch(`${this.base}/json/close/${this.targetId}`, { signal: AbortSignal.timeout(5000) }); } catch { /* */ }
  }
}

export async function chromeStatus(base = debugBase()) {
  const out = { configured: browserConfigured(), base, reachable: false };
  try {
    const v = await fetch(base + '/json/version', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    out.reachable = true;
    out.browser = v.Browser || v.browser || '?';
    const list = await fetch(base + '/json/list', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    out.pages = (list || []).filter((t) => t.type === 'page').length;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
