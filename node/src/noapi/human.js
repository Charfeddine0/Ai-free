// 🧍 السلوك البشري — تمويه ضد كشف الأتمتة (مثل ghost-cursor + Camoufox):
// كتابة بدفعات غير منتظمة، مسارات فأرة Bezier، اهتزاز، بصمات متنوعة.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// مولد عشوائي قابل للبذر (للاختبارات الحتمية)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// تأخير بشري: قاعدة + انفجارات كتابة + وقفات تفكير عرضية
export function humanDelay(rng = Math.random) {
  const r = rng();
  if (r < 0.06) return 600 + rng() * 1400; // وقفة تفكير 0.6-2s
  if (r < 0.2) return 180 + rng() * 250;   // تردد
  return 25 + rng() * 90;                  // ضربة زر طبيعية
}

// تقسيم النص لدفعات كتابة بشرية (كلمات/أجزاء كلمات)
export function chunkForTyping(text, rng = Math.random) {
  const words = text.split(/(\s+)/).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const w of words) {
    buf += w;
    if (buf.length >= 3 + Math.floor(rng() * 9) || /[.؟?!:\n]$/.test(w)) {
      chunks.push(buf); buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// منحنى Bezier مكعب لمسار الفأرة (نقطة تحكم عشوائية = حركة غير آلية)
export function mousePath(x0, y0, x1, y1, rng = Math.random) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = (0.1 + rng() * 0.25) * dist * (rng() < 0.5 ? -1 : 1);
  const nx = -dy / dist, ny = dx / dist; // عمودي
  const cx = (x0 + x1) / 2 + nx * bend, cy = (y0 + y1) / 2 + ny * bend;
  const steps = Math.max(4, Math.min(24, Math.round(dist / 40)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    // اهتزاز دقيق ±1px (رعشة يد بشرية)
    const jx = (rng() - 0.5) * 2, jy = (rng() - 0.5) * 2;
    pts.push({
      x: Math.round(u * u * u * x0 + 3 * u * u * t * cx + 3 * u * t * t * cx + t * t * t * x1 + jx),
      y: Math.round(u * u * u * y0 + 3 * u * u * t * cy + 3 * u * t * t * cy + t * t * t * y1 + jy),
    });
  }
  pts[0] = { x: x0, y: y0 };
  pts[pts.length - 1] = { x: x1, y: y1 };
  return pts;
}

// زمن حركة الفأرة: Fitts's law مبسط (الأبعد = أبطأ لوغاريتمياً)
export const moveDuration = (dist) => Math.round(120 + 140 * Math.log2(1 + dist / 100));

// تدوير البصمة لكل جلسة (مثل fingerprint-generator في WebAI2API)
const VIEWPORTS = [[1366, 768], [1536, 864], [1440, 900], [1920, 1080], [1280, 720], [1600, 900]];
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];
const LOCALES = ['ar-SA', 'ar-EG', 'en-US', 'zh-CN'];
export function randomFingerprint(rng = Math.random) {
  const vp = VIEWPORTS[Math.floor(rng() * VIEWPORTS.length)];
  return {
    viewport: { width: vp[0], height: vp[1] },
    userAgent: UAS[Math.floor(rng() * UAS.length)],
    locale: LOCALES[Math.floor(rng() * LOCALES.length)],
    timezone: 'Asia/Riyadh',
    deviceScaleFactor: rng() < 0.7 ? 1 : 2,
  };
}
