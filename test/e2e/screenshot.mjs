/* Ayarlar səhifəsi + popup + snippet menysu screenşotları (prod build ilə).
   Qeyd: prod build localhost-a inject olmur — build.py-dən sonra dist
   manifestinə müvəqqəti localhost match əlavə edib screenşot alınır,
   sonra təmiz prod build bərpa olunur (əvvəlki dəfələr kimi). */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const OUT = '/home/z/my-project/download/zai-autoresend';
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
  // canlı vəziyyət üçün bir mesaj göndər (uğurlu) — popup vəziyyəti dolu olsun
  await page.fill('#composer', 'Salam! Bu test mesajıdır');
  await page.click('#send');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Salam! Bu avtomatik'), null, { timeout: 10000 });
  await sleep(600);

  // ⚡ snippet menyusu açıq (v1.2.0)
  await page.waitForSelector('.zai-ext-fab', { timeout: 6000 });
  await page.click('.zai-ext-fab');
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'snippet-menyusu-v1.2.0.png') });
  console.log('✔ snippet-menyusu-v1.2.0.png');
  await page.click('.zai-ext-fab'); // menyunu bağla

  const sws = ctx.serviceWorkers();
  const id = new URL(sws[0].url()).host;

  const opts = await ctx.newPage();
  await opts.goto('chrome-extension://' + id + '/options/options.html');
  await opts.waitForSelector('#sBlockPreview');
  await opts.waitForTimeout(700);
  await opts.screenshot({ path: path.join(OUT, 'ayarlar-sehifesi-v1.2.0.png'), fullPage: true });
  console.log('✔ ayarlar-sehifesi-v1.2.0.png');

  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 384, height: 660 });
  await pop.goto('chrome-extension://' + id + '/popup/popup.html');
  await pop.waitForTimeout(2000);
  await pop.screenshot({ path: path.join(OUT, 'popup-v1.2.0.png'), fullPage: true });
  console.log('✔ popup-v1.2.0.png');

  if (server) server.kill();
} finally {
  if (serverProc && serverProc.exitCode === null) serverProc.kill();
  await ctx.close().catch(() => {});
  try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  writeFileSync(mf, orig); // manifesti geri qaytar
}
