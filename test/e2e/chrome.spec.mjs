/*
 * E2E — Chromium + Playwright (xvfb altında işə salınmalıdır).
 * Ssenarilər:
 *   0) extension yüklənməsi (window.__zaiExtInject)
 *   A) system-is-busy → avtomatik retry: eyni body (attachment!), imza yeniləndi,
 *      persist yazıldı, səhifə avto-yeniləndi → uğur görünür
 *   B) HTTP 429 + Retry-After → gecikmə hörmət olunur
 *   C) 400 (fatal) → avtomatik retry YOX, pill xəta göstərir
 *   D) axın kəsintisi (qismən cavab + [DONE] yoxdur) → retry
 *   E) dedup — tətbiqin öz təkrar göndərişi extension-ın retry-sını əvəz edir
 *   F) istifadəçi ləğvi (Sil) → heç bir retry baş vermir
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const BASE = 'http://localhost:8907';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d9b90000000049454e44ae426082',
  'hex'
);

let failures = 0;
function ok(name) { console.log('  ✔ ' + name); }
function bad(name, e) {
  failures++;
  console.error('  ✘ ' + name + ' — ' + (e && e.message || e));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}
const ctl = (body) => jfetch(BASE + '/_ctl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getLog = () => jfetch(BASE + '/_log');
const clearLog = () => jfetch(BASE + '/_log', { method: 'DELETE' });

async function waitReady() {
  try { await fetch(BASE + '/_log'); return null; } catch (e) { /* server yoxdur */ }
  const p = spawn('node', [path.join(ROOT, 'test', 'mock', 'server.js')], { stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/_log'); return p; } catch (e) { await sleep(150); }
  }
  throw new Error('mock server başlamadı');
}

async function pollLog(fn, timeoutMs, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await getLog();
    if (fn(last)) return last;
    await sleep(200);
  }
  throw new Error('poll timeout: ' + label + ' (requests=' + (last ? last.requests.length : '?') + ')');
}

async function setup(script) {
  await sleep(1300); // əvvəlki ssenarinin async pipeline-ı (save/persist/reload) bitsin
  await ctl({ script, resetPersist: true });
  await clearLog();
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await sleep(400);
}

async function attachAndSend(text) {
  await page.setInputFiles('#fileInput', { name: 'shekil.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#chips .chip', { timeout: 6000 });
  await page.fill('#composer', text);
  await page.click('#send');
}

async function send(text) {
  await page.fill('#composer', text);
  await page.click('#send');
}

let page, ctx, serverProc, profileDir;

async function dumpState(name) {
  try {
    const sws = ctx.serviceWorkers();
    if (!sws.length) { console.log('--- dump ' + name + ': SW yoxdur'); return; }
    const id = new URL(sws[0].url()).host;
    const p2 = await ctx.newPage();
    await p2.goto('chrome-extension://' + id + '/popup/popup.html');
    await p2.waitForTimeout(1500);
    const st = await p2.evaluate(() => ({
      conn: document.getElementById('conn').textContent,
      recs: document.getElementById('recList').innerText,
      log: document.getElementById('logBox').textContent
    }));
    const pill = await page.evaluate(() => {
      const el = document.querySelector('.zai-ext-pill');
      return el ? { display: el.style.display, state: el.dataset.state, text: el.textContent } : null;
    });
    console.log('--- dump ' + name + ' ---');
    console.log('pill:', JSON.stringify(pill));
    console.log('popup:', JSON.stringify(st, null, 2));
    await p2.close();
  } catch (e) {
    console.log('--- dump alınmadı: ' + e.message);
  }
}

async function pollPill(predOrStr, timeoutMs) {
  const pred = typeof predOrStr === 'string' ? (s) => s === predOrStr : predOrStr;
  const t0 = Date.now();
  let last = { state: '(yoxdur)', text: '', display: '' };
  const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(() => {
      const el = document.querySelector('.zai-ext-pill');
      return el
        ? { state: el.dataset.state || '', text: (el.querySelector('.zai-ext-text') || {}).textContent || '', display: el.style.display }
        : { state: '(yoxdur)', text: '', display: '' };
    });
    if (seen[seen.length - 1] !== last.state) seen.push(last.state);
    if (pred(last.state)) return { ...last, seen: seen.join('→') };
    await sleep(150);
  }
  return { ...last, seen: seen.join('→') };
}

const scenarios = {};

scenarios.A = async () => {
  await setup(['busy', 'sse_ok']);
  await attachAndSend('Salam, bu test mesajıdır');
  // 1) tətbiq öz ui-nda xəta göstərib composer+attachment-ları SİLDİ (z.ai kimi)
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const composerVal = await page.inputValue('#composer');
  const chipCount = await page.locator('#chips .chip').count();
  if (composerVal !== '' || chipCount !== 0) throw new Error('mock app composer/chips təmizlənmədi (val=' + JSON.stringify(composerVal) + ', chips=' + chipCount + ')');
  ok('A1 tətbiqdə busy xətası + attachment-lar silindi (z.ai davranışı təkrarlandı)');

  // 2) extension avtomatik retry etdi
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'A: retry gəlmədi');
  const r0 = log.requests[0], r1 = log.requests[1];
  if (!r0.sigOk || !r1.sigOk) throw new Error('imza yoxlaması keçilmədi: r0=' + r0.sigOk + ' r1=' + r1.sigOk + ' (' + (r1.why || '') + ')');
  ok('A2 server imza yoxlamasını keçdi (hər iki sorğu)');

  // 3) body birmənalı eynidir — attachment daxil
  const b0 = r0.body, b1 = r1.body;
  if (JSON.stringify(b0) !== JSON.stringify(b1)) throw new Error('retry body fərqlidir!');
  const lastMsg = b1.messages[b1.messages.length - 1].content;
  if (!Array.isArray(lastMsg) || !lastMsg.some((p) => p.type === 'image_url')) {
    throw new Error('retry body-də attachment yoxdur!');
  }
  ok('A3 retry body eynidir — attachment (image_url) qorundu');

  // 4) imza yeniləndi (ts + x-signature fərqlidir)
  if (r1.headers['x-signature'] === r0.headers['x-signature']) throw new Error('imza yenilənmədi');
  if (!(r1.query.timestamp > r0.query.timestamp)) throw new Error('timestamp artmadı');
  ok('A4 imza (X-Signature) yenidən hesablandı — ' + r1.headers['x-signature'].slice(0, 12) + '…');

  // 5) persist yazıldı
  const log2 = await pollLog((l) => l.persists.length >= 1, 15000, 'A: persist yoxdur');
  const chat = log2.persists[log2.persists.length - 1].chat;
  if (chat.history.currentId !== b0.id) throw new Error('persist currentId uyğunsuz');
  const entries = Object.values(chat.history.messages);
  const assistant = entries.find((m) => m.role === 'assistant');
  if (!assistant || !String(assistant.content).includes('Salam! Bu avtomatik')) throw new Error('persist-də assistant cavabı yoxdur');
  const userEntry = entries.find((m) => m.id === b0.current_user_message_id);
  if (!userEntry) throw new Error('persist-də real user id yoxdur');
  if (!Array.isArray(userEntry.content) || !userEntry.content.some((p) => p.type === 'image_url')) throw new Error('persist-də attachment yoxdur');
  ok('A5 persist (POST /api/v1/chats/mock-chat-1) — attachment + cavab tarixçəyə yazıldı');

  // 6) avto-reload → səhifədə uğur görünür, xəta sətri yox olur
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('Salam! Bu avtomatik') && !document.querySelector('#messages .err');
  }, null, { timeout: 15000 });
  ok('A6 səhifə avtomatik yeniləndi — uğurlu cavab görünür, xəta sətri yoxdur');
};

scenarios.B = async () => {
  await setup(['http429', 'sse_ok']);
  await send('429 testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'B: retry gəlmədi');
  const gap = log.requests[1].t - log.requests[0].t;
  if (gap < 900) throw new Error('Retry-After (1s) hörmət olunmadı: gap=' + gap + 'ms');
  if (gap > 6000) throw new Error('Retry-After çox gec icra olundu: gap=' + gap + 'ms');
  if (!log.requests[1].sigOk) throw new Error('ikinci sorğunun imzası keçilmədi');
  await pollLog((l) => l.persists.length >= 1, 15000, 'B: persist yoxdur');
  ok('B HTTP 429 + Retry-After=1s → ' + gap + 'ms sonra retry, uğur');
};

scenarios.C = async () => {
  await setup(['badreq']);
  await send('fatal testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await sleep(3500);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('fatal xətaya baxmayaraq retry atıldı: ' + log.requests.length);
  const pillInfo = await pollPill((s) => s === 'err', 6000);
  if (pillInfo.state !== 'err') throw new Error('pill xəta vəziyyətində deyil: ' + pillInfo.state + ' | ' + pillInfo.text);
  if (!/Göndərilmədi/.test(pillInfo.text)) throw new Error('pill mətni: ' + pillInfo.text);
  ok('C 400 (fatal) → avtomatik retry YOX, pill xəta göstərir');
};

scenarios.D = async () => {
  await setup(['netkill', 'sse_ok']);
  await send('netkill testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'D: retry gəlmədi');
  const r1 = log.requests[1];
  if (!r1.sigOk) throw new Error('retry imzası keçilmədi');
  await pollLog((l) => l.persists.length >= 1, 15000, 'D: persist yoxdur');
  ok('D axın kəsildi (qismən cavab, [DONE] yoxdur) → retry uğurla başa çatdı');
};

scenarios.E = async () => {
  await setup(['busy', 'sse_ok']);
  await page.evaluate(() => { window.__deterministicIds = true; });
  await send('dedup testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  // xəta gəldikdən dərhal sonra tətbiq ÖZÜ eyni mesajı yenidən göndərir
  await page.fill('#composer', 'dedup testi');
  await page.click('#send');
  await pollLog((l) => l.requests.length >= 2, 15000, 'E: ikinci sorğu gəlmədi');
  await sleep(3200); // extension-ın retry-atma şansı var idisə, burada görünməli idi
  const log = await getLog();
  if (log.requests.length !== 2) throw new Error('dedup işləmədi — əlavə sorğu getdi: ' + log.requests.length);
  await pollLog((l) => l.persists.length >= 1, 15000, 'E: persist yoxdur');
  await page.evaluate(() => { window.__deterministicIds = false; });
  ok('E dedup — tətbiqin öz təkrarı extension-ın retry-sını əvəz etdi (cəmi 2 sorğu)');
};

scenarios.F = async () => {
  await setup(['busy', 'sse_ok']);
  await send('ləğv testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const w = await pollPill('wait', 9000);
  if (w.state !== 'wait') throw new Error('pill wait vəziyyətinə keçmədi: state=' + w.state + ' | display=' + w.display + ' | seen=' + w.seen + ' | text=' + w.text);
  ok('F1 pill wait vəziyyətini göstərdi (' + w.seen + ')');
  await page.click('.zai-ext-pill .zai-ext-del');
  await sleep(3200);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('ləğvdən sonra sorğu getdi: ' + log.requests.length);
  // F-nin rekordu silinməli; pill ya gizlənməli, YA DA başqa (köhnə) rekordu göstərməli —
  // amma 'ləğv testi' rekorduna aid heç nə qalmamalıdır
  const fin = await pollPill((s) => true, 3000);
  if (fin.text.includes('ləğv testi')) throw new Error('F rekordu hələ pill-dədir: ' + JSON.stringify(fin));
  const sws = ctx.serviceWorkers();
  if (sws.length) {
    const id = new URL(sws[0].url()).host;
    const p2 = await ctx.newPage();
    await p2.goto('chrome-extension://' + id + '/popup/popup.html');
    await p2.waitForTimeout(1500);
    const recsText = await p2.evaluate(() => document.getElementById('recList').innerText);
    await p2.close();
    if (recsText.includes('ləğv testi')) throw new Error('F rekordu storage-dan silinməyib: ' + recsText);
  }
  ok('F2 ləğv → retry dayandırıldı (cəmi 1 sorğu), rekord silindi' + (fin.state === 'err' ? ' (pill köhnə rekordu göstərir — gözləmə başqa mesaj üçündür)' : ''));
};

async function main() {
  console.log('== Z.ai Auto-Resend — Chromium E2E ==');
  serverProc = await waitReady();
  profileDir = mkdtempSync(path.join(tmpdir(), 'zaiext-profile-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  page = ctx.pages()[0] || await ctx.newPage();

  // Ssenari 0: extension MAIN world + ISOLATED world yükləndi
  try {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
    ok('0 extension inject olundu (MAIN world aktiv)');
    const hasPill = await page.locator('.zai-ext-pill').count();
    if (hasPill < 1) throw new Error('pill DOM-da yoxdur');
    ok('0 pill DOM-da hazırdır');
  } catch (e) {
    bad('0 extension yüklənmədi', e);
    console.error('DİQQƏT: --load-extension yalnız başlıqlı (xvfb) rejimdə işləyir. "npm run e2e:chrome" istifadə edin.');
    await cleanup(1);
    return;
  }

  for (const [name, fn] of Object.entries(scenarios)) {
    console.log('— Ssenari ' + name);
    try {
      await fn();
    } catch (e) {
      bad(name, e);
      await dumpState(name);
    }
  }

  await cleanup(failures ? 1 : 0);
}

async function cleanup(code) {
  try { if (ctx) await ctx.close(); } catch (e) { /* ignore */ }
  try { if (profileDir) rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (serverProc && serverProc.exitCode === null) {
    // server xarici başladıbsa — yalnız öz prosesimizdirsə öldür
    serverProc.kill();
  }
  console.log(failures === 0 ? '\nHƏMİSİ KEÇDİ ✔' : '\n' + failures + ' SSENARİ ALINDI ✘');
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(1); });
