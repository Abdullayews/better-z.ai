/* Ayarlar səhifəsi + popup + söz sayğacı screenşotları (prod build ilə).
   Qeyd: prod build localhost-a inject olmur — build.py-dən sonra dist
   manifestinə müvəqqəti localhost match əlavə edib screenşot alınır,
   sonra təmiz prod build bərpa olunur. */
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
  try { await fetch(BASE + '/_log'); return null; } catch (e) { /* yoxdur */ }
  const p = spawn('node', [path.join(ROOT, 'test', 'mock', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/_log'); return p; } catch (e) { await sleep(200); }
  }
  throw new Error('mock server başlamadı');
}

// müvəqqəti localhost match (yalnız screenşot üçün)
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

  // SÖZ SAYĞACI — kompozitor dolu, sağ altda sayğaç çipi görünür
  await page.fill('#composer', 'Bu mesajda söz sayğacı görünür və canlı sayılır');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return el && el.style.display !== 'none' && /söz/.test(el.textContent || '');
  }, null, { timeout: 8000 });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'soz-saygaci.png') });
  console.log('✔ soz-saygaci.png');

  // canlı vəziyyət üçün bir mesaj göndər (uğurlu) — popup vəziyyəti dolu olsun
  await page.click('#send');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Salam! Bu avtomatik'), null, { timeout: 10000 });
  await sleep(600);

  const sws = ctx.serviceWorkers();
  const id = new URL(sws[0].url()).host;

  const opts = await ctx.newPage();
  await opts.goto('chrome-extension://' + id + '/options/options.html');
  await opts.waitForSelector('#sWordCounter');
  await opts.waitForTimeout(700);
  await opts.screenshot({ path: path.join(OUT, 'ayarlar-sehifesi.png'), fullPage: true });
  console.log('✔ ayarlar-sehifesi.png');

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
  writeFileSync(mf, orig); // manifesti geri qaytar
}
