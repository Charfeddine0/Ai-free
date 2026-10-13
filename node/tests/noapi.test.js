// No-API tests — سلوك بشري + CDP codec + خادم CDP وهمي + جلسات + عدّاء + API.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

import { mulberry32, humanDelay, chunkForTyping, mousePath, moveDuration, randomFingerprint } from '../src/noapi/human.js';
import { wsEncode, wsDecodeFrame, wsEncodeServer, CdpPage, chromeStatus } from '../src/noapi/cdp.js';
import { parseCookies, cookiesHeader, SessionPool } from '../src/noapi/sessions.js';
import { resolveSite, getSite } from '../src/noapi/sites.js';
import { shouldUseBrowser, runBrowserFlow } from '../src/noapi/runner.js';
import { openStore } from '../src/store.js';

describe('human', () => {
  it('seeded rng deterministic', () => {
    const a = mulberry32(7), b = mulberry32(7);
    assert.equal(a(), b());
  });
  it('delays within human bounds', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const d = humanDelay(rng);
      assert.ok(d >= 25 && d <= 2000, `delay ${d}`);
    }
  });
  it('typing chunks cover full text', () => {
    const t = 'مرحبا بالعالم! كيف حالك اليوم؟ سؤال طويل للاختبار.';
    assert.equal(chunkForTyping(t, mulberry32(3)).join(''), t);
  });
  it('mouse path endpoints exact + steps sane', () => {
    const p = mousePath(10, 20, 300, 400, mulberry32(9));
    assert.deepEqual(p[0], { x: 10, y: 20 });
    assert.deepEqual(p[p.length - 1], { x: 300, y: 400 });
    assert.ok(p.length >= 6 && p.length <= 26);
  });
  it('move duration grows with distance', () => {
    assert.ok(moveDuration(1000) > moveDuration(50));
  });
  it('fingerprint shape valid', () => {
    const f = randomFingerprint(mulberry32(1));
    assert.ok(f.viewport.width > 1000 && f.userAgent.length > 20 && f.locale);
  });
});

describe('ws codec', () => {
  it('client masked roundtrip', () => {
    const enc = wsEncode('{"id":1}');
    const d = wsDecodeFrame(enc);
    assert.equal(d.opcode, 1);
    assert.equal(d.payload.toString(), '{"id":1}');
  });
  it('long payload (>125) roundtrip', () => {
    const big = 'x'.repeat(500);
    assert.equal(wsDecodeFrame(wsEncode(big)).payload.toString(), big);
    assert.equal(wsDecodeFrame(wsEncodeServer(big)).payload.toString(), big);
  });
});

// ---------- خادم DevTools + CDP وهمي ----------
function startMockCdp(script) {
  const received = [];
  const server = createServer((req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/json/new')) {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'T1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1` }));
    }
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ Browser: 'MockChrome/131' }));
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ id: 'T1', type: 'page' }]));
    }
    if (req.url.startsWith('/json/close/')) {
      res.writeHead(200); return res.end('ok');
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) break;
        const need = wsDecodeFrame(buf).length;
        if (buf.length < need) break;
        const fr = wsDecodeFrame(buf);
        buf = buf.subarray(need);
        if (fr.opcode === 8) { socket.end(); break; }
        let msg = {};
        try { msg = JSON.parse(fr.payload.toString()); } catch { /* */ }
        received.push(msg.method);
        let result = {};
        if (msg.method === 'Runtime.evaluate') {
          result = { result: { value: script.length > 1 ? script.shift() : script[0] } };
        } else if (msg.method === 'Storage.getCookies') {
          result = { cookies: [{ name: 's', value: 'v' }] };
        } else if (msg.method === 'Page.captureScreenshot') {
          result = { data: 'aGVsbG8=' };
        }
        socket.write(wsEncodeServer(JSON.stringify({ id: msg.id, result })));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

describe('CdpPage vs mock', () => {
  let mock;
  before(async () => { mock = await startMockCdp([{ x: 5, y: 6 }, false, false, true]); });
  after(() => mock.server.close());
  it('open/navigate/evaluate/waitFor/cookies/close', async () => {
    const page = await CdpPage.open(mock.base);
    await page.navigate('https://example.com/', 5000);
    assert.deepEqual(await page.evaluate('1+1'), { x: 5, y: 6 });
    await page.waitFor('ready', 5000, 50);
    assert.equal((await page.cookies()).length, 1);
    await page.typeText('hi');
    await page.pressEnter();
    await page.clickAt(1, 2);
    await page.mouseMovePath([{ x: 1, y: 1 }], 1);
    assert.ok((await page.shot()).length > 0);
    await page.close();
    assert.ok(mock.received.includes('Page.navigate'));
    assert.ok(mock.received.includes('Input.insertText'));
  });
  it('chromeStatus reachable', async () => {
    const st = await chromeStatus(mock.base);
    assert.equal(st.reachable, true);
    assert.match(st.browser, /MockChrome/);
    assert.equal(st.pages, 1);
  });
  it('chromeStatus unreachable', async () => {
    const st = await chromeStatus('http://127.0.0.1:9');
    assert.equal(st.reachable, false);
  });
});

describe('sessions', () => {
  it('parses array/object/JSON/netscape/pairs', () => {
    assert.equal(parseCookies([{ name: 'a', value: '1' }]).length, 1);
    assert.equal(parseCookies({ a: '1', b: '2' }).length, 2);
    assert.equal(parseCookies('[{"name":"a","value":"1"}]').length, 1);
    assert.equal(parseCookies('a=1; b=2').length, 2);
    const netscape = '# cookie jar\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123\n';
    const n = parseCookies(netscape);
    assert.equal(n[0].name, 'sid');
    assert.equal(cookiesHeader(n), 'sid=abc123');
    assert.deepEqual(parseCookies('nope-no-equals'), []);
  });
  it('health rotation: 3 fails -> unhealthy', () => {
    const p = new SessionPool();
    p.load('a1', [{ name: 's', value: 'v' }]);
    assert.equal(p.healthy('a1'), true);
    assert.ok(p.use('a1'));
    p.markFail('a1'); p.markFail('a1'); p.markFail('a1');
    assert.equal(p.healthy('a1'), false);
    assert.equal(p.use('a1'), null);
    assert.equal(p.stats()[0].fails, 3);
  });
});

describe('sites', () => {
  it('resolveSite mapping + heuristics', () => {
    assert.equal(resolveSite('deepseek'), 'deepseek');
    assert.equal(resolveSite('webchat', 'My Grok Acc'), 'grok');
    assert.equal(resolveSite('webai', 'x', 'gemini-2.5-flash'), 'gemini');
    assert.equal(resolveSite('unknown-xyz'), 'generic');
  });
  it('override merge', () => {
    const s = getSite('chatgpt', { chatgpt: { pollMs: 5 } });
    assert.equal(s.pollMs, 5);
    assert.ok(s.startUrl.includes('chatgpt'));
  });
});

// ---------- FakePage للعدّاء (بدون شبكة) ----------
class FakePage {
  constructor(script) { this.script = [...script]; this.calls = []; this.closed = false; }
  async send(m) { this.calls.push(m); return {}; }
  async navigate() { this.calls.push('nav'); }
  async evaluate() { return this.script.length > 1 ? this.script.shift() : this.script[0]; }
  async waitFor() { return true; }
  async mouseMovePath() {}
  async clickAt() {}
  async typeText(t) { this.calls.push('type:' + t.length); }
  async pressEnter() {}
  async setCookies() {}
  async close() { this.closed = true; }
}
const acc = (over = {}) => ({
  id: 'acc_web1', provider: 'chatgpt', label: 'Web-1', mode: 'browser',
  credentials_enc: '', cooldown_seconds: 8, status: 'READY', ...over,
});

describe('runner', () => {
  it('shouldUseBrowser matrix', () => {
    assert.equal(shouldUseBrowser({ mode: 'browser' }, true), true);
    assert.equal(shouldUseBrowser({ mode: 'api' }, false), false);
    assert.equal(shouldUseBrowser({}, false), true);
    assert.equal(shouldUseBrowser({}, true), false);
    assert.equal(shouldUseBrowser({ mode: 'auto' }, true), false);
  });
  it('streams growing web text then settles', async () => {
    const fake = new FakePage([
      { x: 100, y: 100 },
      { text: '', grew: false, len: 0 },
      { text: 'مرحبا', grew: true, len: 5 },
      { text: 'مرحبا بالعالم', grew: true, len: 13 },
      { text: 'مرحبا بالعالم', grew: false, len: 13 },
      { text: 'مرحبا بالعالم', grew: false, len: 13 },
    ]);
    const stages = [];
    let out = '';
    for await (const d of runBrowserFlow({
      siteId: 'chatgpt', account: acc(), messages: [{ role: 'user', content: 'hi' }],
      siteOverrides: { startUrl: '', pollMs: 5, settlePolls: 2 },
      connectFn: async () => fake, rng: () => 0.5, onStage: (s) => stages.push(s),
    })) out += d;
    assert.equal(out, 'مرحبا بالعالم');
    assert.ok(stages.includes('sent'));
    assert.ok(fake.calls.some((c) => String(c).startsWith('type:')));
  });
  it('empty response throws (login/selectors) and frees slot', async () => {
    const fake = new FakePage([{ x: 1, y: 1 }]);
    // evaluate دائماً فارغ
    fake.evaluate = async () => ({ text: '', grew: false, len: 0 });
    process.env.BROWSER_REPLY_TIMEOUT = '400';
    await assert.rejects(runBrowserFlow({
      siteId: 'chatgpt', account: acc(), messages: [{ role: 'user', content: 'hi' }],
      siteOverrides: { startUrl: '', pollMs: 5, settlePolls: 50 },
      connectFn: async () => fake, rng: () => 0.5,
    }).next(), /no response|prompt box/);
    delete process.env.BROWSER_REPLY_TIMEOUT;
    // الفتحة تحررت: تشغيل ثانٍ يعمل فوراً
    const fake2 = new FakePage([{ x: 1, y: 1 }, { text: 'ok', grew: true, len: 2 }, { text: 'ok', grew: false, len: 2 }, { text: 'ok', grew: false, len: 2 }]);
    let out = '';
    for await (const d of runBrowserFlow({
      siteId: 'chatgpt', account: acc(), messages: [{ role: 'user', content: 'hi' }],
      siteOverrides: { startUrl: '', pollMs: 5, settlePolls: 2 },
      connectFn: async () => fake2, rng: () => 0.5,
    })) out += d;
    assert.equal(out, 'ok');
  });
});

describe('noapi http', () => {
  let base, ctx;
  before(async () => {
    const srv = await import('../src/server.js');
    srv.setStore(openStore('/tmp/aifree_noapi_test_' + Date.now() + '_' + process.pid));
    const r = await srv.start(0, '127.0.0.1');
    ctx = r; base = r.url;
  });
  after(() => ctx.server.close());
  it('browser status unconfigured', async () => {
    const b = await (await fetch(base + '/api/browser/status')).json();
    assert.equal(b.reachable, false);
    assert.ok(b.setup);
    assert.ok(Array.isArray(b.sessions));
  });
  it('sessions import validates + stores encrypted', async () => {
    const accs = await (await fetch(base + '/api/accounts')).json();
    const id = accs[0].id;
    const bad = await fetch(base + '/api/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: id, cookies: 'garbage-no-cookies-here' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(base + '/api/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: id, cookies: [{ name: 'session', value: 'abc' }] }) });
    assert.equal((await ok.json()).imported, 1);
    const nf = await fetch(base + '/api/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'nope', cookies: 'a=1' }) });
    assert.equal(nf.status, 404);
  });
  it('mode PATCH + validation', async () => {
    const accs = await (await fetch(base + '/api/accounts')).json();
    const id = accs[0].id;
    const r = await fetch(base + '/api/accounts/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'browser' }) });
    assert.equal((await r.json()).mode, 'browser');
    const bad = await fetch(base + '/api/accounts/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'telepathy' }) });
    assert.equal(bad.status, 400);
  });
  it('browser-mode account without chrome yields setup hint (no crash)', async () => {
    const created = await (await fetch(base + '/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'chatgpt', label: 'Web-Test', mode: 'browser' }) })).json();
    assert.equal(created.mode, 'browser');
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'سؤال متصفح ' + Date.now() }], stream: false, allow_wait: false }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.choices[0].message.content, /remote-debugging-port/);
  });
});
