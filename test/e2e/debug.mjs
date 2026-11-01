/* Debug: channel (postMessage), PONG, storage state, popup view. */
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const BASE = 'http://localhost:8907';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d9b90000000049454e44ae426082', 'hex');

const profile = mkdtempSync(path.join(tmpdir(), 'zaiext-dbg-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage']
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (!t.includes('Download the React')) console.log('[console]', t); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForTimeout(1200);

// 1) PONG round-trip
const pong = await page.evaluate(() => new Promise((resolve) => {
  const onMsg = (ev) => {
    if (ev.data && ev.data.zai === 1 && ev.data.t === 'PONG') {
      window.removeEventListener('message', onMsg);
      resolve(ev.data);
    }
  };
  window.addEventListener('message', onMsg);
  window.postMessage({ zai: 1, t: 'PING' }, location.origin);
  setTimeout(() => resolve(null), 4000);
}));
console.log('PONG =', JSON.stringify(pong));

// 2) send a message (busy) — with an attachment
await fetch(BASE + '/_ctl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: ['busy', 'sse_ok'], resetPersist: true }) });
await fetch(BASE + '/_log', { method: 'DELETE' });
await page.setInputFiles('#fileInput', { name: 'd.png', mimeType: 'image/png', buffer: PNG });
await page.waitForSelector('#chips .chip', { timeout: 6000 });
await page.fill('#composer', 'debug message');
await page.click('#send');
await page.waitForSelector('#messages .err', { timeout: 8000 });
console.log('[app] busy error shown');
await page.waitForTimeout(5000);

// 3) server log
const log = await (await fetch(BASE + '/_log')).json();
console.log('server requests =', log.requests.length, JSON.stringify(log.requests.map(r => ({ sigOk: r.sigOk, why: r.why, mode: r.mode }))));

// 4) pill state
const pill = await page.evaluate(() => {
  const el = document.querySelector('.zai-ext-pill');
  return el ? { display: el.style.display, state: el.dataset.state, text: el.textContent } : null;
});
console.log('pill =', JSON.stringify(pill));

// 5) extension id -> open the popup, inspect the GET_STATE result
const sws = ctx.serviceWorkers();
console.log('serviceWorkers =', sws.map((s) => s.url()));
if (sws.length) {
  const id = new URL(sws[0].url()).host;
  const p2 = await ctx.newPage();
  await p2.goto(`chrome-extension://${id}/popup/popup.html`);
  await p2.waitForTimeout(1800);
  const state = await p2.evaluate(() => ({
    conn: document.getElementById('conn').textContent,
    recs: document.getElementById('recList').innerText,
    log: document.getElementById('logBox').textContent
  }));
  console.log('POPUP =', JSON.stringify(state, null, 2));
  await p2.close();
}

await ctx.close();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
