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
 *   G) PREVIEW GUARD: uğurdan sonra öz-özünə açılan preview bağlanılır;
 *      fayl əlavəsi sonrası avto-preview də bloklanır (default: aktiv)
 *   H) PREVIEW GUARD: chip-ə kliklə açılan preview AÇIQ QALIR (yalnız kliklə)
 *   I) parametr söndürüldükdə avtomatik preview istifadəçi istəyi ilə açıq qalır
 *   J) ayarlar səhifəsi: standart dəyərlər + avto-yadda + popup açarı
 *   K) v1.2.0 QARALAMA: yazılmış mətn reload-dan sonra bərpa olunur
 *   L) v1.2.0 SNIPPET: ⚡ düyməsi + bir kliklə kompozitora yerləşmə
 *   M) v1.2.0 İXRAC: söhbət Markdown-a çevrilir (popup düyməsi ilə)
 *   N) v1.2.0 POPAP BAĞLAYICI: peak-hours bağlanır; parol dialoqu toxunulmaz;
 *      parametr söndürüldükdə popap açıq qalır
 *   O) v1.2.0 ARDICIL RETRY: iki uğursuz mesaj SIRAYLA yenidən göndərilir
 *   P) v1.2.0 DUBLİKAT QORUNMASI: server yazıbsa retry getmir (1 sorğu)
 *   Q) v1.2.0 QLOBAL PAUZA: ⏸ → retry dayanır, ▶ → davam edir
 *   R) v1.2.0 STATİSTİKA: bütün sayğaclar doludur
 *   S) v1.2.0 MESAJ XİLASI: failed_final mesajın TAM mətni ⧉ ilə kopyalanır
 *   T) v1.2.0 BILDİRİŞ: tab gizli olanda "cavab hazırdır" (jurnalda)
 *   U) v1.3.0 SÖZ SAYĞACI: yazanda görünür, boşanda gizlənir, parametrlə idarə
 *   V) v1.3.0 QISAYOLLAR: Alt+R (retry-now), Alt+P (pauza), Alt+E (ixrac) —
 *      background-ın göndərdiyi eyni CMD_SHORTCUT mesajı ilə; söndürülmə hali
 *   W) v1.3.0 TAM BACKUP: chat siyahısı + detallar → 2 söhbət, limit hörməti
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

async function extPage(path) {
  const sws = ctx.serviceWorkers();
  if (!sws.length) throw new Error('service worker tapılmadı');
  const id = new URL(sws[0].url()).host;
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + id + path);
  return p;
}

/* v1.3.0: background-ın commands listener-i nə edirsə onu təkrarlayır —
   canlı tab-ə CMD_SHORTCUT mesajı göndərir (real klaviatura basqısının yolu) */
async function cmdToTab(cmd) {
  const p = await extPage('/popup/popup.html');
  const r = await p.evaluate((c) => new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_TAB' }, (t) => {
        if (!t || !t.tab) return res(false);
        chrome.tabs.sendMessage(t.tab.id, c, () => res(!chrome.runtime.lastError));
      });
    } catch (e) { res(false); }
  }), cmd);
  await p.close();
  return r;
}

async function storageGet(keys) {
  const p = await extPage('/popup/popup.html');
  const v = await p.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, (g) => r(g || {}))), keys);
  await p.close();
  return v;
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
  // Xəta gəldikdən dərhal sonra tətbiq ÖZÜ eyni mesajı yenidən göndərir.
  // Birbaşa DOM ilə (evaluate) — Playwright-in fill+click gecikməsi yavaş
  // mühitdə 2 s-lik extension retry-si ilə yarışır (flaky).
  await page.evaluate(() => {
    document.getElementById('composer').value = 'dedup testi';
    document.getElementById('send').click();
  });
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

scenarios.G = async () => {
  await setup(['sse_ok']);
  await page.evaluate(() => { window.__mockAutoPreview = true; });
  await send('preview auto testi');
  // uğur gəldi → mock (z.ai kimi) preview-i ÖZ-ÖZÜNƏ açır → extension bağlamalıdır
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.openedBy === 'auto' && mp.open === false && !!mp.closedBy;
  }, null, { timeout: 9000 });
  const st = await page.evaluate(() => window.__mockPreview);
  if (st.opens !== 1) throw new Error('preview gözləniləndən çox açıldı: ' + st.opens);
  ok('G1 uğurdan sonra avtomatik açılan preview bağlanıldı (' + st.closedBy + ' ilə)');

  // jurnalda qeyd olmalıdır
  const p2 = await extPage('/popup/popup.html');
  await p2.waitForTimeout(1200);
  const logTxt = await p2.evaluate(() => document.getElementById('logBox').textContent);
  await p2.close();
  if (!/preview bloklandı/i.test(logTxt)) throw new Error('jurnalda preview qeydi yoxdur: ' + logTxt.slice(0, 200));
  ok('G2 jurnalda "preview bloklandı" qeydi göründü');

  // fayl əlavəsi sonrası avto-preview də bloklanır
  await page.evaluate(() => { window.__mockAutoPreviewOnAttach = true; });
  await page.setInputFiles('#fileInput', { name: 'shekil.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.openedBy === 'auto-attach' && mp.open === false && !!mp.closedBy;
  }, null, { timeout: 9000 });
  ok('G3 fayl əlavəsi sonrası avtomatik preview də bloklandı');
};

scenarios.H = async () => {
  await setup(['sse_ok']);
  await page.setInputFiles('#fileInput', { name: 'shekil.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#chips .chip', { timeout: 6000 });
  // istifadəçi chip-ə klikləyir → preview AÇILMALI və AÇIQ QALMALIDIR
  await page.click('#chips .chip');
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.open === true && mp.openedBy === 'user';
  }, null, { timeout: 5000 });
  await sleep(2800); // bağlanmamasını yoxla
  const st = await page.evaluate(() => window.__mockPreview);
  if (!st.open) throw new Error('istifadəçinin kliklə açdığı preview bağlandı! closedBy=' + st.closedBy);
  ok('H1 chip-ə kliklə açılan preview açıq qaldı (yalnız kliklə açılır)');
  await page.keyboard.press('Escape');
  await sleep(300);
  const st2 = await page.evaluate(() => window.__mockPreview);
  if (st2.open) throw new Error('Escape preview-i bağlamadı');
  ok('H2 Escape ilə normal bağlanır');
};

scenarios.I = async () => {
  // parametri söndür → avtomatik preview açıq qalmalıdır (istifadəçi istəyi)
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sBlockPreview', { timeout: 5000 });
  await p.waitForFunction(() => document.getElementById('sBlockPreview').checked === true, null, { timeout: 5000 });
  await p.uncheck('#sBlockPreview');
  await p.waitForTimeout(900);
  const s1 = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s1.blockAutoPreview !== false) throw new Error('options avto-yadda işləmədi (blockAutoPreview)');
  await p.close();

  await setup(['sse_ok']);
  await page.evaluate(() => { window.__mockAutoPreview = true; });
  await send('preview aciq testi');
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.open === true && mp.openedBy === 'auto';
  }, null, { timeout: 6000 });
  await sleep(2500); // bağlanmamasını yoxla
  const st = await page.evaluate(() => window.__mockPreview);
  if (!st.open) throw new Error('parametr söndürüldüyü halda preview bağlandı: ' + st.closedBy);
  ok('I parametr söndürüldükdə avtomatik preview açıq qalır');

  // geri yandır (sonrakı istifadə üçün standart vəziyyət)
  const p2 = await extPage('/options/options.html');
  await p2.waitForSelector('#sBlockPreview');
  await p2.check('#sBlockPreview');
  await p2.waitForTimeout(900);
  await p2.close();
  ok('I2 parametr geri yandırıldı (standart)');
};

scenarios.J = async () => {
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sBlockPreview', { timeout: 5000 });
  // standart: blockAutoPreview AKTİV + test build dəyərləri
  const checked = await p.isChecked('#sBlockPreview');
  if (!checked) throw new Error('blockAutoPreview standart olaraq aktiv deyil!');
  const maxR = await p.inputValue('#sMaxRetries');
  if (maxR !== '4') throw new Error('TEST default maxRetries=4 gözlənilirdi: ' + maxR);
  const delay = await p.inputValue('#sInitialDelay');
  if (delay !== '2000') throw new Error('TEST default initialDelayMs=2000 gözlənilirdi: ' + delay);
  ok('J1 ayarlar səhifəsi: preview bloku standart AKTİV, dəyərlər düzgün');

  // avto-yadda: checkbox dəyişməsi storage-ə düşür
  await p.uncheck('#sBlockPreview');
  await p.waitForTimeout(900);
  let s = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s.blockAutoPreview !== false) throw new Error('avto-yadda işləmədi');
  if (typeof s.jitter !== 'number') throw new Error('formada olmayan açar (jitter) itirildi!');
  await p.check('#sBlockPreview');
  await p.waitForTimeout(900);
  s = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s.blockAutoPreview !== true) throw new Error('geri qaytarıla bilmədi');
  ok('J2 dəyişikliklər avtomatik yadda saxlanılır (başqa açarlar itmir)');

  // v1.2.0: yeni bölmələr mövcuddur və standartları düzgündür
  const dClosePopups = await p.isChecked('#sClosePopups');
  const dDraftGuard = await p.isChecked('#sDraftGuard');
  const dSerial = await p.isChecked('#sSerial');
  const dDup = await p.isChecked('#sDupGuard');
  if (!dClosePopups || !dDraftGuard || !dSerial || !dDup) {
    throw new Error('v1.2.0 standartları deyil: closePopups=' + dClosePopups + ' draftGuard=' + dDraftGuard + ' serial=' + dSerial + ' dup=' + dDup);
  }
  const snipRows = await p.locator('#snipList .snip-row').count();
  if (snipRows < 1) throw new Error('standart snippetlər yoxdur');
  ok('J3 v1.2.0 bölmələri: popap/qaralama/serial/dublikat standart AKTİV, snippetlər hazır');
  await p.close();

  // popup-da da eyni açar düzgün vəziyyətdədir
  const p2 = await extPage('/popup/popup.html');
  await p2.waitForTimeout(800);
  const pc = await p2.isChecked('#sBlockPreview');
  if (!pc) throw new Error('popup-dakı preview açarı düzgün deyil');
  const hasBtn = await p2.locator('#btnOptions').count();
  if (!hasBtn) throw new Error('popup-da Ayarlar düyməsi yoxdur');
  await p2.close();
  ok('J4 popup: preview açarı + "Ayarlar…" düyməsi hazırdır');
};

/* ================= v1.2.0 ssenariləri ================= */

scenarios.K = async () => {
  await setup(['sse_ok']);
  const TXT = 'Qaralama testi - bu uzun mesaj itmemelidir 12345';
  await page.fill('#composer', TXT);
  await sleep(1400); // debounce 800ms + save throttle
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await page.waitForSelector('.zai-ext-draft', { timeout: 8000 });
  ok('K1 reload-dan sonra qaralama bannerı göründü');

  await page.click('.zai-ext-draft button[data-a="restore"]');
  const val = await page.inputValue('#composer');
  if (val !== TXT) throw new Error('qaralama bərpa olunmadı: ' + JSON.stringify(val));
  await page.waitForFunction(() => !document.querySelector('.zai-ext-draft'), null, { timeout: 4000 });
  ok('K2 "Bərpa et" → mətn kompozitorda geri qaytarıldı');

  // bərpa olunmuş qaralama istehlak olundu — təkrar təklif yoxdur
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await sleep(2000);
  if (await page.locator('.zai-ext-draft').count()) throw new Error('bərpa olunmuş qaralama yenidən təklif olundu');
  ok('K3 qaralama istehlak olundu — təkrar təklif yoxdur');
};

scenarios.L = async () => {
  await setup(['sse_ok']);
  await page.waitForSelector('.zai-ext-fab', { timeout: 8000 });
  ok('L1 ⚡ snippet düyməsi göründü');
  await page.click('.zai-ext-fab');
  await page.waitForSelector('.zai-ext-snip .zai-ext-snip-item', { timeout: 5000 });
  const n = await page.locator('.zai-ext-snip .zai-ext-snip-item').count();
  if (n < 1) throw new Error('snippet siyahısı boşdur');
  await page.click('.zai-ext-snip .zai-ext-snip-item >> nth=0');
  const val = await page.inputValue('#composer');
  if (!val || val.length < 3) throw new Error('snippet mətni daxil edilmədi: ' + JSON.stringify(val));
  await page.waitForFunction(() => !document.querySelector('.zai-ext-snip'), null, { timeout: 4000 });
  ok('L2 snippet bir kliklə kompozitora yerləşdirildi (' + n + ' şablon, menyu bağlı)');
};

scenarios.M = async () => {
  await setup(['sse_ok']);
  await send('ixrac testi mesaji');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Salam! Bu avtomatik'), null, { timeout: 15000 });
  const p = await extPage('/popup/popup.html');
  await p.waitForSelector('#btnExport', { timeout: 5000 });
  await p.click('#btnExport');
  await sleep(1800);
  const le = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['lastExport'], (g) => r((g && g.lastExport) || null))));
  await p.close();
  if (!le || !le.md) throw new Error('lastExport yoxdur');
  if (!le.md.includes('ixrac testi mesaji')) throw new Error('md-də istifadə mesajı yoxdur');
  if (!le.md.includes('Salam! Bu avtomatik')) throw new Error('md-də cavab yoxdur');
  if (!/^# Mock/.test(le.md)) throw new Error('md başlığı yoxdur: ' + le.md.slice(0, 60));
  ok('M söhbət Markdown ixrac olundu (' + le.name + ')');
};

scenarios.N = async () => {
  await setup(['sse_ok']);
  // 1) peak hours popapı avtomatik bağlanmalıdır
  await page.evaluate(() => window.__mockPeakOpen());
  await page.waitForFunction(() => !window.__modalVisible('peakModal'), null, { timeout: 7000 });
  ok('N1 "Currently in peak hours" popapı avtomatik bağlandı');

  // 2) parametr söndürülür → popap açıq qalmalıdır
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sClosePopups', { timeout: 5000 });
  await p.uncheck('#sClosePopups');
  await p.waitForTimeout(900);
  await p.close();
  await page.evaluate(() => window.__mockPeakOpen());
  await sleep(2800);
  if (!await page.evaluate(() => window.__modalVisible('peakModal'))) throw new Error('parametr söndürüldüyü halda popap bağlandı');
  ok('N2 parametr söndürüldükdə popap toxunulmur');

  // 3) geri yandır + səhnə təmizliyi
  const p2 = await extPage('/options/options.html');
  await p2.waitForSelector('#sClosePopups');
  await p2.check('#sClosePopups');
  await p2.waitForTimeout(900);
  await p2.close();
  await page.evaluate(() => {
    document.getElementById('peakModal').classList.remove('open');
    window.__mockPeak.open = false;
  });
  await sleep(400);

  // 4) parol formalı dialoq HEÇ VAXT bağlanmır
  await page.evaluate(() => window.__mockAuthOpen());
  await sleep(2800);
  if (!await page.evaluate(() => window.__modalVisible('authModal'))) throw new Error('parol dialoqu bağlandı!');
  await page.evaluate(() => document.getElementById('authModal').classList.remove('open'));
  ok('N3 parol formalı dialoq heç vaxt bağlanmır (təhlükəsizlik)');
};

scenarios.O = async () => {
  // Deterministik axın: əvvəl pauza → hər iki mesaj toplanır → sonra buraxılır.
  // (Pauzasız olanda ilk retry 2 s-də atılır və ikinci mesaj hələ göndərilmir.)
  const pp = await extPage('/popup/popup.html');
  await pp.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: true }, r)));
  await pp.close();
  await setup(['busy', 'busy', 'sse_ok', 'sse_ok']);
  await send('SERIAL-1 birinci mesaj');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await send('SERIAL-2 ikinci mesaj');
  await page.waitForFunction(() => document.querySelectorAll('#messages .err').length >= 2, null, { timeout: 8000 });
  const before = await getLog();
  if (before.requests.length !== 2) throw new Error('pauza altında sorğu getdi: ' + before.requests.length);
  // Burax → ardıcıl retry-lər (əvvəl SERIAL-1, sonra SERIAL-2)
  const pp2 = await extPage('/popup/popup.html');
  await pp2.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: false }, r)));
  await pp2.close();
  const log = await pollLog((l) => l.requests.length >= 4, 30000, 'O: retry-lər gəlmədi');
  const rs = log.requests.map((r) => String((r.body && r.body.signature_prompt) || ''));
  if (rs[0] !== 'SERIAL-1 birinci mesaj' || rs[1] !== 'SERIAL-2 ikinci mesaj') {
    throw new Error('ilkin göndərişlər düzgün deyil: ' + JSON.stringify(rs));
  }
  if (rs[2] !== 'SERIAL-1 birinci mesaj' || rs[3] !== 'SERIAL-2 ikinci mesaj') {
    throw new Error('retry sırası pozuldu: ' + JSON.stringify(rs));
  }
  const gap = log.requests[3].t - log.requests[2].t;
  if (gap < 150) throw new Error('retry-lər paralel getdi (gap=' + gap + 'ms) — ardıcıl rejim işləmir');
  ok('O ardıcıl retry: mesajlar SIRAYLA yenidən göndərildi (gap=' + gap + 'ms)');
};

scenarios.P = async () => {
  await setup(['duptrap']);
  await send('DUPTRAP mesaji');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  // retry baş verməməlidir — dublikat qorunması serverdəki yazıyı görür
  await sleep(6500);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('ikinci sorğu getdi! requests=' + log.requests.length);
  ok('P1 dublikat qorunması: yenidən göndərmə baş TUTMADI (cəmi 1 sorğu)');
  const p = await extPage('/popup/popup.html');
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['stats'], (g) => r((g && g.stats) || {}))));
  const recs = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['records'], (g) => r(Object.values((g && g.records) || {})))));
  await p.close();
  if ((st.dupAvoided || 0) < 1) throw new Error('stats.dupAvoided artmadı: ' + JSON.stringify(st));
  const rec = recs.find((r) => (r.promptPreview || '').includes('DUPTRAP'));
  if (!rec || rec.state !== 'succeeded') throw new Error('rekord succeeded deyil: ' + (rec && rec.state));
  ok('P2 rekord "succeeded" qeyd olundu (dublikat önləndi)');
};

scenarios.Q = async () => {
  // Deterministik: ilkin gecikməni 8 s edirik ki, pauza klikinə vaxt qalsın
  // (2 s standartda yavaş mühitdə klik retry-dan SONRA çata bilər → flaky).
  const pOpt = await extPage('/options/options.html');
  await pOpt.waitForSelector('#sInitialDelay', { timeout: 5000 });
  await pOpt.fill('#sInitialDelay', '8000');
  await pOpt.waitForTimeout(900);
  await pOpt.close();
  try {
    await setup(['busy', 'sse_ok']);
    await send('pauza testi');
    await page.waitForSelector('#messages .err', { timeout: 8000 });
    await pollPill('wait', 8000);
    await page.click('.zai-ext-pill .zai-ext-pause');
    await sleep(4200); // ilkin gecikmə 8000ms — pauza mütləq vaxtında çatıb
    let log = await getLog();
    if (log.requests.length !== 1) throw new Error('pauza rejimində retry getdi: ' + log.requests.length);
    ok('Q1 pauza → retry-lər dayandırıldı (cəmi 1 sorğu)');
    await page.click('.zai-ext-pill .zai-ext-pause'); // davam
    const log2 = await pollLog((l) => l.requests.length >= 2, 20000, 'Q: davamdan sonra retry yoxdur');
    if (!log2.requests[1].sigOk) throw new Error('imza keçilmədi');
    ok('Q2 davam etdirildi → retry işə düşdü');
  } finally {
    // pauza və ilkin gecikmə hər halda bərpa edilsin (sonrakı ssenarilər üçün)
    const pp = await extPage('/popup/popup.html');
    await pp.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: false }, r)));
    await pp.close();
    const p2 = await extPage('/options/options.html');
    await p2.waitForSelector('#sInitialDelay', { timeout: 5000 });
    await p2.fill('#sInitialDelay', '2000');
    await p2.waitForTimeout(900);
    await p2.close();
  }
};

scenarios.R = async () => {
  const p = await extPage('/popup/popup.html');
  await p.waitForTimeout(1000);
  const st = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['stats'], (g) => r((g && g.stats) || {}))));
  await p.close();
  const need = {
    retryOk: st.retryOk, previewBlocked: st.previewBlocked, popupsClosed: st.popupsClosed,
    draftsRestored: st.draftsRestored, exports: st.exports, dupAvoided: st.dupAvoided,
    snippetsInserted: st.snippetsInserted
  };
  for (const [k, v] of Object.entries(need)) {
    if (!v || v < 1) throw new Error('stats.' + k + ' artmayıb: ' + JSON.stringify(st));
  }
  ok('R statistika tam işləyir: ' + JSON.stringify(need));
};

scenarios.S = async () => {
  // müdafiə: əvvəlki ssenaridən qala biləcək pauza vəziyyətini təmizlə
  const pp0 = await extPage('/popup/popup.html');
  await pp0.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: false }, r)));
  await pp0.close();
  // maxRetries=2 → tez "failed_final"
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sMaxRetries', { timeout: 5000 });
  await p.fill('#sMaxRetries', '2');
  await p.waitForTimeout(900);
  await p.close();
  try {
    await setup(['busy', 'busy', 'busy']); // initial + 2 retry = 3 busy → failed_final
    const TXT = 'FAILFINAL bu mesaj kopyalanmalidir tam metn 987654321';
    await send(TXT);
    await page.waitForSelector('#messages .err', { timeout: 8000 });
    // "Cəhdlər bitdi" mətnini gözlə (pollPill köhnə fatal rekorduna tez tapılır!)
    await page.waitForFunction(() => {
      const el = document.querySelector('.zai-ext-pill .zai-ext-text');
      return el && /Cəhdlər bitdi/.test(el.textContent || '');
    }, null, { timeout: 30000 });
    ok('S1 cəhdlər bitdi → pill "Cəhdlər bitdi" göstərir');
    await page.click('.zai-ext-pill .zai-ext-copy');
    await sleep(700);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip !== TXT) throw new Error('mübadilə buferində tam mətn yoxdur: ' + JSON.stringify(clip));
    ok('S2 tam mesaj mətni (⧉) mübadilə buferinə köçürüldü');
  } finally {
    // maxRetries-i hər halda geri qaytar (test standartı 4)
    const p2 = await extPage('/options/options.html');
    await p2.waitForSelector('#sMaxRetries');
    await p2.fill('#sMaxRetries', '4');
    await p2.waitForTimeout(900);
    await p2.close();
  }
};

scenarios.T = async () => {
  await setup(['sse_ok']);
  // Bu mühitdə real tab-gizlətmə alınmır (xvfb) → QA hook-u ilə content
  // world-də document.hidden-i override edirik (runtime mesajı ilə)
  const pp = await extPage('/popup/popup.html');
  const hooked = await pp.evaluate(() => new Promise((r) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_TAB' }, (t) => {
        if (!t || !t.tab) return r(false);
        chrome.tabs.sendMessage(t.tab.id, { cmd: 'SET_HIDDEN_OVERRIDE', value: true }, () => r(true));
      });
    } catch (e) { r(false); }
  }));
  await pp.close();
  if (!hooked) throw new Error('SET_HIDDEN_OVERRIDE göndərilə bilmədi');
  await send('gizli tab testi');
  await sleep(2200);
  const p = await extPage('/popup/popup.html');
  await p.waitForTimeout(1200);
  const logTxt = await p.evaluate(() => document.getElementById('logBox').textContent);
  await p.close();
  if (!/bildiriş: cavab hazırdır/.test(logTxt)) throw new Error('jurnalda bildiriş qeydi yoxdur: ' + logTxt.slice(0, 300));
  ok('T tab arxa planda olanda "cavab hazırdır" bildirişi göndərildi (jurnalda qeyd)');
};

/* ---------- v1.3.0 ssenariləri ---------- */

scenarios.U = async () => {
  await setup(['sse_ok']);
  await page.fill('#composer', 'bir iki üç dörd');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return el && el.style.display !== 'none' && /4 söz/.test(el.textContent || '');
  }, null, { timeout: 8000 });
  const txt = await page.evaluate(() => document.querySelector('.zai-ext-counter').textContent);
  if (!/4 söz · 15 simvol/.test(txt)) throw new Error('sayğaç mətni yanlış: ' + JSON.stringify(txt));
  ok('U1 söz sayğacı görünür: "' + txt + '"');
  await page.fill('#composer', '');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return !el || el.style.display === 'none';
  }, null, { timeout: 8000 });
  ok('U2 kompozitor boş — sayğaç gizlənir');
  // parametr söndürüldükdə element DOM-dan silinir
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sWordCounter', { timeout: 5000 });
  await p.uncheck('#sWordCounter');
  await page.waitForFunction(() => !document.querySelector('.zai-ext-counter'), null, { timeout: 10000 });
  ok('U3 parametr söndürüldü — sayğaç DOM-dan silindi');
  await p.check('#sWordCounter');
  await p.waitForTimeout(1200);
  await p.close();
};

scenarios.V = async () => {
  await setup(['busy', 'sse_ok']);
  await send('qisayol testi');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await pollPill('wait', 8000);

  // Alt+R → gözləyən mesaj dərhal yenidən göndərilir
  const r1 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'retry-now' });
  if (!r1) throw new Error('CMD_SHORTCUT (retry-now) göndərilə bilmədi');
  const logV = await pollLog((l) => l.requests.length >= 2, 20000, 'V: retry-now işə düşmədi');
  if (!logV.requests[1].sigOk) throw new Error('imza keçilmədi');
  ok('V1 Alt+R (retry-now) — gözləyən mesaj dərhal göndərildi');
  await sleep(1500); // avto-reload bitsin

  // Alt+P → pauza açılır
  const r2 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  if (!r2) throw new Error('toggle-pause göndərilə bilmədi');
  let pv = null;
  for (let i = 0; i < 20; i++) {
    const g = await storageGet(['paused']);
    if (g.paused === true) { pv = true; break; }
    await sleep(400);
  }
  if (!pv) throw new Error('Alt+P pauzanı aktivləşdirmədi');
  ok('V2 Alt+P (toggle-pause) — pauza aktivləşdi');

  // Alt+P ikinci dəfə → pauza dayanır
  await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  let pv2 = null;
  for (let i = 0; i < 20; i++) {
    const g = await storageGet(['paused']);
    if (g.paused === false) { pv2 = true; break; }
    await sleep(400);
  }
  if (!pv2) throw new Error('Alt+P pauzanı dayandırmadı');
  ok('V3 Alt+P ikinci dəfə — pauza dayandırıldı');

  // Alt+E → cari söhbətin ixracı
  const before = (await storageGet(['lastExport'])).lastExport;
  const r3 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'export-chat' });
  if (!r3) throw new Error('export-chat göndərilə bilmədi');
  let le = null;
  for (let i = 0; i < 25; i++) {
    const g = await storageGet(['lastExport']);
    if (g.lastExport && (!before || g.lastExport.at > (before.at || 0))) { le = g.lastExport; break; }
    await sleep(500);
  }
  if (!le || !le.md) throw new Error('Alt+E ixracı yeniləmədi');
  ok('V4 Alt+E (export-chat) — son ixrac yeniləndi (' + le.name + ')');

  // parametr söndürüldükdə qısayol reaksiya vermir
  const po = await extPage('/options/options.html');
  await po.waitForSelector('#sShortcuts', { timeout: 5000 });
  await po.uncheck('#sShortcuts');
  await po.waitForTimeout(1400);
  await po.close();
  await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  await sleep(1500);
  const g2 = await storageGet(['paused', 'stats']);
  if (g2.paused === true) throw new Error('söndürülmüş qısayol işlədi!');
  ok('V5 parametr söndürüldü — qısayol reaksiya vermir');
  const po2 = await extPage('/options/options.html');
  await po2.waitForSelector('#sShortcuts', { timeout: 5000 });
  await po2.check('#sShortcuts');
  await po2.waitForTimeout(1200);
  await po2.close();
  if (((g2.stats || {}).shortcutActions || 0) < 4) {
    throw new Error('stats.shortcutActions artmadı: ' + JSON.stringify(g2.stats));
  }
  ok('V6 qısayol statistikası: ' + g2.stats.shortcutActions + ' istifadə');
};

scenarios.W = async () => {
  await setup(['sse_ok']);
  await send('backup testi mesaji');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Salam! Bu avtomatik'), null, { timeout: 15000 });

  const p = await extPage('/popup/popup.html');
  await p.waitForSelector('#btnBackup', { timeout: 5000 });
  await p.click('#btnBackup');
  let lb = null;
  for (let i = 0; i < 40; i++) {
    const g = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['lastBackup'], (x) => r((x && x.lastBackup) || null))));
    if (g && g.count === 2) { lb = g; break; }
    await sleep(500);
  }
  if (!lb || lb.count !== 2) throw new Error('tam backup gəlmədi: ' + JSON.stringify(lb));
  ok('W1 tam backup hazır: 2 söhbət (mock-chat-1 + mock-chat-2)');
  const ids = (lb.list || []).map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(['mock-chat-1', 'mock-chat-2'])) {
    throw new Error('backup siyahısı yanlış: ' + JSON.stringify(ids));
  }
  ok('W2 chat siyahısı düzgün gətirildi (GET /api/v1/chats/?page=1)');
  const stW = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['stats'], (g) => r((g && g.stats) || {}))));
  if ((stW.backups || 0) < 1) throw new Error('stats.backups artmadı: ' + JSON.stringify(stW));
  // popup jurnalı ~1s intervallə təzələnir — qeyd görünənə qədər gözlə
  let logOk = false;
  let logTxt = '';
  for (let i = 0; i < 25; i++) {
    logTxt = await p.evaluate(() => document.getElementById('logBox').textContent);
    if (/tam backup hazır: 2 söhbət/.test(logTxt)) { logOk = true; break; }
    await sleep(600);
  }
  if (!logOk) throw new Error('jurnalda backup qeydi yoxdur: ' + logTxt.slice(0, 200));
  ok('W3 stats.backups=' + stW.backups + ' + jurnalda qeyd');

  // limit: backupMaxChats=1 → yalnız 1 söhbət
  await sleep(3000); // popup düyməsi yenidən aktiv olsun
  const po = await extPage('/options/options.html');
  await po.waitForSelector('#sBackupMaxChats', { timeout: 5000 });
  await po.fill('#sBackupMaxChats', '1');
  await po.waitForTimeout(1100);
  await po.close();
  await p.click('#btnBackup');
  let lb2 = null;
  for (let i = 0; i < 40; i++) {
    const g = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['lastBackup'], (x) => r((x && x.lastBackup) || null))));
    if (g && g.count === 1) { lb2 = g; break; }
    await sleep(500);
  }
  if (!lb2 || lb2.count !== 1) throw new Error('backupMaxChats limiti işləmədi: ' + JSON.stringify(lb2));
  ok('W4 backupMaxChats=1 limiti hörmət olunur (1 söhbət)');
  const po2 = await extPage('/options/options.html');
  await po2.waitForSelector('#sBackupMaxChats', { timeout: 5000 });
  await po2.fill('#sBackupMaxChats', '50');
  await po2.waitForTimeout(1100);
  await po2.close();
  await p.close();
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

  // v1.2.0: S ssenarisi üçün mübadilə buferi icazələri
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  } catch (e) { console.log('  (clipboard icazəsi verilmədi: ' + e.message + ')'); }

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
