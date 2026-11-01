/* Screenshots of the settings page + popup + word counter (with the prod build).
   Note: the prod build does not inject into localhost — after build.py we
   temporarily add a localhost match to the dist manifest to take the shots,
   then restore the clean prod build. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const OUT = '/home/z/my-project/download/better-z.ai';
const BASE = 'http://localhost:8907';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  try { await fetch(BASE + '/_log'); return null; } catch (e) { /* none */ }
  const p = spawn('node', [path.join(ROOT, 'test', 'mock', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/_log'); return p; } catch (e) { await sleep(200); }
  }
  throw new Error('mock server failed to start');
}

// temporary localhost match (for screenshots only)
const mf = path.join(EXT, 'manifest.json');
const orig = readFileSync(mf, 'utf8');
const m = JSON.parse(orig);
for (const cs of m.content_scripts || []) cs.matches = ['http://localhost/*', ...cs.matches];
writeFileSync(mf, JSON.stringify(m, null, 2));

const profileDir = mkdtempSync(path.join(tmpdir(), 'zg-shots-'));
let serverProc = null;
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage']
});
try {
  const server = await waitReady();
  serverProc = server;
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await sleep(600);

  // WORD COUNTER — composer filled, the counter chip appears bottom-right
  await page.fill('#composer', 'This message shows the word counter live');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return el && el.style.display !== 'none' && /words/.test(el.textContent || '');
  }, null, { timeout: 8000 });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'word-counter.png') });
  console.log('✔ word-counter.png');

  // send one message (successful) for live state — so the popup shows content
  await page.click('#send');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Hello! This is an automatic'), null, { timeout: 10000 });
  await sleep(600);

  const sws = ctx.serviceWorkers();
  const id = new URL(sws[0].url()).host;

  const opts = await ctx.newPage();
  await opts.goto('chrome-extension://' + id + '/options/options.html');
  await opts.waitForSelector('#sWordCounter');
  await opts.waitForTimeout(700);
  await opts.screenshot({ path: path.join(OUT, 'settings-page.png'), fullPage: true });
  console.log('✔ settings-page.png');

  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 384, height: 720 });
  await pop.goto('chrome-extension://' + id + '/popup/popup.html');
  await pop.waitForTimeout(2000);
  await pop.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
  console.log('✔ popup.png');

  if (server) server.kill();
} finally {
  if (serverProc && serverProc.exitCode === null) serverProc.kill();
  await ctx.close().catch(() => {});
  try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  writeFileSync(mf, orig); // restore the manifest
}
