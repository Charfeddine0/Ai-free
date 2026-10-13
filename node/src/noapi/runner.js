// 🏃 عدّاء الويب — تشغيل المواقع بدون API عبر كروم حقيقي + سلوك بشري.
// المتتالية الذكية: token/API أولاً → متصفح عند غيابه → فشل واضح يتيح Fallback.
import { CdpPage } from './cdp.js';
import { sleep, humanDelay, chunkForTyping, mousePath, randomFingerprint } from './human.js';
import { getSite, GENERIC_RESPONSE_JS } from './sites.js';
import { SessionPool, parseCookies } from './sessions.js';
import { decrypt } from '../crypto.js';
import { settings } from '../config.js';

export const webSessions = new SessionPool();

const maxPages = () => Math.max(1, Number(process.env.BROWSER_MAX_PAGES || 2));
let activePages = 0;
const pageWaiters = [];
async function acquirePageSlot() {
  if (activePages < maxPages()) { activePages += 1; return; }
  await new Promise((r) => pageWaiters.push(r));
  activePages += 1;
}
function releasePageSlot() {
  activePages = Math.max(0, activePages - 1);
  const w = pageWaiters.shift();
  if (w) w();
}

export function shouldUseBrowser(account, hasApi) {
  const mode = account.mode || 'auto';
  if (mode === 'browser') return true;
  if (mode === 'api') return false;
  return !hasApi; // auto: المتصفح عند غياب الرمز
}

function accountCookies(account) {
  try {
    const raw = decrypt(settings.masterKey, account.credentials_enc || '');
    const o = JSON.parse(raw);
    return o.cookies || [];
  } catch { return []; }
}

const lastUserText = (messages) => {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  const c = m?.content;
  return typeof c === 'string' ? c : JSON.stringify(c || '');
};

const FIND_PROMPT_JS = (selectors) => `(sels => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 15; };
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && vis(el)) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), via: s }; }
  }
  const cands = [...document.querySelectorAll('textarea, input[type=text], [contenteditable=true]')].filter(vis);
  if (!cands.length) return null;
  cands.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  const r = cands[0].getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), via: 'generic' };
})(${JSON.stringify(selectors)})`;

async function readResponse(page, site, prevLen) {
  try {
    if (site.responseAttr) {
      const t = await page.evaluate(`(() => { let best=''; for (const el of document.querySelectorAll(${JSON.stringify(site.responseAttr)})) { const x=(el.innerText||'').trim(); if (x.length>best.length) best=x; } return best; })()`);
      if (t && t.length) return { text: t, grew: t.length > prevLen, len: t.length };
    }
    return await page.evaluate(`(${GENERIC_RESPONSE_JS})(${prevLen})()`);
  } catch { return { text: '', grew: false, len: prevLen }; }
}

export async function* runBrowserFlow({ siteId, account, messages, siteOverrides = {}, connectFn = null, rng = Math.random, onStage = null }) {
  const site = getSite(siteId, siteOverrides);
  const stage = (s) => { try { onStage && onStage(s); } catch { /* */ } };
  const prompt = lastUserText(messages);
  if (!prompt.trim()) throw new Error('empty prompt');

  await acquirePageSlot();
  let page = null;
  try {
    stage('open');
    page = connectFn ? await connectFn() : await CdpPage.open();

    // بصمة + جلسة
    const fp = randomFingerprint(rng);
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: fp.viewport.width, height: fp.viewport.height, deviceScaleFactor: fp.deviceScaleFactor, mobile: false });
    } catch { /* */ }
    const cookies = accountCookies(account);
    if (cookies.length) {
      webSessions.load(account.id, cookies, fp);
      try { await page.setCookies(parseCookies(cookies)); } catch { /* */ }
      stage('session:' + cookies.length);
    }

    if (site.startUrl) {
      stage('goto');
      await page.navigate(site.startUrl, site.navTimeout || 30000);
      await sleep(1200 + rng() * 1500); // انتظار بشري بعد التحميل
    }

    // إيجاد مربع الإدخال ثم حركة فأرة بشرية + نقرة
    stage('find-prompt');
    const found = await page.evaluate(FIND_PROMPT_JS(site.prompt || []));
    if (!found) throw new Error('web: prompt box not found (login? selectors? — حدّث sites.override)');
    const vw = fp.viewport.width, vh = fp.viewport.height;
    const path = mousePath(Math.round(rng() * vw), Math.round(rng() * vh), found.x, found.y, rng);
    await page.mouseMovePath(path, 10);
    await sleep(150 + rng() * 300);
    await page.clickAt(found.x, found.y);
    await sleep(250 + rng() * 400);

    // كتابة بشرية بدفعات
    stage('type');
    for (const chunk of chunkForTyping(prompt, rng)) {
      await page.typeText(chunk);
      await sleep(humanDelay(rng));
    }
    await sleep(400 + rng() * 600);
    await page.pressEnter();
    stage('sent');

    // قراءة تدريجية حتى الاستقرار (البث الحي)
    let prev = '';
    let stable = 0;
    const t0 = Date.now();
    const timeoutMs = Number(process.env.BROWSER_REPLY_TIMEOUT || 120000);
    for (;;) {
      await sleep(site.pollMs || 1500);
      const r = await readResponse(page, site, prev.length);
      if (r.text && r.text.length > prev.length) {
        yield r.text.slice(prev.length);
        prev = r.text;
        stable = r.grew ? 0 : stable + 1;
      } else {
        stable += 1;
      }
      if (stable >= (site.settlePolls || 3) && prev.length > 0) break;
      if (Date.now() - t0 > timeoutMs) {
        if (prev.length > 0) break;
        throw new Error('web: no response (timeout — تحقق من الجلسة/الدخول)');
      }
    }
    webSessions.markOk(account.id);
    stage('done:' + prev.length);
  } catch (e) {
    webSessions.markFail(account.id);
    throw e;
  } finally {
    if (page && !connectFn) { try { await page.close(); } catch { /* */ } }
    releasePageSlot();
  }
}
