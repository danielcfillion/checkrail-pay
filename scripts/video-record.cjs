// Scripted screen recorder (CDP screencast). Usage: node video-record.cjs desktop|mobile
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3300';
const MODE = process.argv[2] || 'desktop';
const OUT = path.join(__dirname, 'rec', MODE);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const Database = require('/home/claude/checkrail-pay/node_modules/better-sqlite3');
const _db = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'demo.sqlite'), { readonly: true });
const q = (ref, state) => _db.prepare('select id from obligations where source_ref=? and state=?').get(ref, state).id;
const ID = { phuong: q('INV-2026-0152', 'blocked'), dup: q('JOB-HG4D-0914', 'blocked'), pay: q('JOB-HG4D-0921', 'approved'), ana: q('JOB-PAL3D-0927', 'awaiting_approval') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(
    MODE === 'desktop'
      ? { viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1.5, colorScheme: 'light' }
      : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;pointer-events:none;background:#000;animation:kf 1s linear infinite alternate;z-index:2147483647';
      const s = document.createElement('style');
      s.textContent = '@keyframes kf{from{opacity:.01}to{opacity:.03}}';
      document.head.appendChild(s);
      document.body.appendChild(d);
      try { localStorage.setItem('checkrail.demoBanner.dismissed', '1'); localStorage.setItem('checkrail.tour.dismissed', '1'); } catch (e) {}
    });
  });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  const marks = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(OUT, `f${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ t: f.metadata.timestamp, file: path.basename(file) });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
  });
  await page.goto(BASE + '/demo');
  await sleep(1500);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: MODE === 'desktop' ? 1920 : 780, maxHeight: MODE === 'desktop' ? 1080 : 1688, everyNthFrame: 1 });
  const t0 = Date.now();
  const mark = (n) => marks.push({ name: n, at: (Date.now() - t0) / 1000 });
  const hold = async (s) => { const end = Date.now() + s * 1000; while (Date.now() < end) { await sleep(400); } };
  const go = async (p, wait = 1200) => { await page.goto(BASE + p, { waitUntil: 'networkidle' }).catch(() => {}); await sleep(wait); };
  const scroll = async (y, ms = 1200) => { await page.evaluate(([y, ms]) => new Promise((res) => { const s = window.scrollY, t = performance.now(); const step = (n) => { const k = Math.min(1, (n - t) / ms); const e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k+2, 2)/2; window.scrollTo(0, s + (y - s) * e); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); }), [y, ms]); };

  mark('phuong'); await go('/obligations/' + ID.phuong); await hold(4); await scroll(520, 1800); await hold(3); await scroll(1100, 1800); await hold(3);
  mark('overview'); await go('/'); await hold(4); await scroll(500, 1500); await hold(2);
  mark('duplicate'); await go('/obligations/' + ID.dup); await hold(4); await scroll(600, 1800); await hold(3);
  mark('pay'); await go('/obligations/' + ID.pay); await hold(3);
  const btn = page.getByRole('button', { name: /Pay with PayPal/i }).first();
  if (await btn.count()) { await btn.scrollIntoViewIfNeeded(); await hold(1); await btn.click(); await hold(2);
    const confirm = page.getByRole('button', { name: /^(Yes|Confirm|Pay)/i }).first();
    if (await confirm.count()) { await confirm.click().catch(() => {}); }
    await hold(7); } else { marks.push({ name: 'NO_PAY_BUTTON', at: 0 }); }
  mark('agents'); await go('/agents'); await hold(4); await scroll(500, 1500); await hold(3);
  mark('close'); await go('/close'); await hold(4); await scroll(600, 1500); await hold(3);
  mark('end');
  await cdp.send('Page.stopScreencast');
  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify({ frames, marks, t0, errors }, null, 1));
  console.log('frames', frames.length, 'marks', JSON.stringify(marks), 'errors', errors);
  await browser.close();
})();
