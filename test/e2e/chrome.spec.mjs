/*
 * E2E — Chromium + Playwright (must run under xvfb).
 * Scenarios:
 *   0) extension loads (window.__zaiExtInject)
 *   A) system-is-busy -> automatic retry: same body (attachment!), signature
 *      refreshed, persist written, page auto-reloaded -> success visible
 *   B) HTTP 429 + Retry-After -> the delay is honored
 *   C) 400 (fatal) -> NO automatic retry, the pill shows the error
 *   D) stream cut (partial response + no [DONE]) -> retry
 *   E) dedup — the app's own resend replaces the extension's retry
 *   F) user cancel (Delete) -> no retry happens
 *   G) PREVIEW GUARD: the preview that opens itself after success is closed;
 *      auto-preview after a file add is blocked too (default: on)
 *   H) PREVIEW GUARD: a preview opened by clicking a chip STAYS OPEN (click only)
 *   I) with the setting off, an automatic preview stays open (user intent)
 *   J) settings page: default values + auto-save + the popup toggle
 *   K) v1.2.0 DRAFT: typed text is restored after a reload
 *   L) v1.2.0 SNIPPET: the ⚡ button + one-click insert into the composer
 *   M) v1.2.0 EXPORT: the chat is converted to Markdown (via the popup button)
 *   N) v1.2.0 POPUP CLOSER: peak-hours gets closed; the password dialog is
 *      untouchable; with the setting off the popup stays open
 *   O) v1.2.0 SERIAL RETRY: two failed messages are resent IN ORDER
 *   P) v1.2.0 DUPLICATE GUARD: if the server already wrote it, no retry (1 request)
 *   Q) v1.2.0 GLOBAL PAUSE: ⏸ -> retries stop, ▶ -> they resume
 *   R) v1.2.0 STATS: all counters are filled
 *   S) v1.2.0 MESSAGE RESCUE: the FULL text of a failed_final message is copied via ⧉
 *   T) v1.2.0 NOTIFICATION: "response is ready" when the tab is hidden (in the log)
 *   U) v1.3.0 WORD COUNTER: visible while typing, hidden when empty, setting-gated
 *   V) v1.3.0 SHORTCUTS: Alt+R / Alt+P / Alt+E via the same CMD_SHORTCUT message
 *      the background sends; plus the off case
 *   W) v1.3.0 FULL BACKUP: chat list + details -> 2 chats, limit honored
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
  try { await fetch(BASE + '/_log'); return null; } catch (e) { /* no server */ }
  const p = spawn('node', [path.join(ROOT, 'test', 'mock', 'server.js')], { stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + '/_log'); return p; } catch (e) { await sleep(150); }
  }
  throw new Error('mock server failed to start');
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
  await sleep(1300); // let the previous scenario's async pipeline (save/persist/reload) finish
  await ctl({ script, resetPersist: true });
  await clearLog();
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await sleep(400);
}

async function attachAndSend(text) {
  await page.setInputFiles('#fileInput', { name: 'image.png', mimeType: 'image/png', buffer: PNG });
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
    if (!sws.length) { console.log('--- dump ' + name + ': no SW'); return; }
    const id = new URL(sws[0].url()).host;
    const p2 = await ctx.newPage();
    await p2.goto('chrome-extension://' + id + '/popup/popup.html');
    await p2.waitForTimeout(1500);
    const st = await p2.evaluate(() => new Promise((res) => {
      chrome.storage.local.get(['log'], (g) => res({
        conn: document.getElementById('conn').textContent,
        recs: document.getElementById('recList').innerText,
        log: ((g && g.log) || []).join('\n')
      }));
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
    console.log('--- dump failed: ' + e.message);
  }
}

async function pollPill(predOrStr, timeoutMs) {
  const pred = typeof predOrStr === 'string' ? (s) => s === predOrStr : predOrStr;
  const t0 = Date.now();
  let last = { state: '(none)', text: '', display: '' };
  const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(() => {
      const el = document.querySelector('.zai-ext-pill');
      return el
        ? { state: el.dataset.state || '', text: (el.querySelector('.zai-ext-text') || {}).textContent || '', display: el.style.display }
        : { state: '(none)', text: '', display: '' };
    });
    if (seen[seen.length - 1] !== last.state) seen.push(last.state);
    if (pred(last.state)) return { ...last, seen: seen.join('→') };
    await sleep(150);
  }
  return { ...last, seen: seen.join('→') };
}

async function extPage(path) {
  const sws = ctx.serviceWorkers();
  if (!sws.length) throw new Error('service worker not found');
  const id = new URL(sws[0].url()).host;
  const p = await ctx.newPage();
  await p.goto('chrome-extension://' + id + path);
  return p;
}

/* replicates what the background's commands listener does —
   sends a CMD_SHORTCUT message to the live tab (the real keyboard path) */
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
  await attachAndSend('Hello, this is a test message');
  // 1) the app showed the error in its own UI and CLEARED composer+attachments (like z.ai)
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const composerVal = await page.inputValue('#composer');
  const chipCount = await page.locator('#chips .chip').count();
  if (composerVal !== '' || chipCount !== 0) throw new Error('mock app did not clear composer/chips (val=' + JSON.stringify(composerVal) + ', chips=' + chipCount + ')');
  ok('A1 busy error in the app + attachments deleted (z.ai behavior reproduced)');

  // 2) the extension retried automatically
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'A: no retry');
  const r0 = log.requests[0], r1 = log.requests[1];
  if (!r0.sigOk || !r1.sigOk) throw new Error('signature check failed: r0=' + r0.sigOk + ' r1=' + r1.sigOk + ' (' + (r1.why || '') + ')');
  ok('A2 passed the server signature check (both requests)');

  // 3) the body is identical — including the attachment
  const b0 = r0.body, b1 = r1.body;
  if (JSON.stringify(b0) !== JSON.stringify(b1)) throw new Error('retry body differs!');
  const lastMsg = b1.messages[b1.messages.length - 1].content;
  if (!Array.isArray(lastMsg) || !lastMsg.some((p) => p.type === 'image_url')) {
    throw new Error('no attachment in the retry body!');
  }
  ok('A3 retry body is identical — attachment (image_url) preserved');

  // 4) the signature was refreshed (ts + x-signature differ)
  if (r1.headers['x-signature'] === r0.headers['x-signature']) throw new Error('signature was not refreshed');
  if (!(r1.query.timestamp > r0.query.timestamp)) throw new Error('timestamp did not increase');
  ok('A4 signature (X-Signature) recomputed — ' + r1.headers['x-signature'].slice(0, 12) + '…');

  // 5) persist was written
  const log2 = await pollLog((l) => l.persists.length >= 1, 15000, 'A: no persist');
  const chat = log2.persists[log2.persists.length - 1].chat;
  if (chat.history.currentId !== b0.id) throw new Error('persist currentId mismatch');
  const entries = Object.values(chat.history.messages);
  const assistant = entries.find((m) => m.role === 'assistant');
  if (!assistant || !String(assistant.content).includes('Hello! This is an automatic')) throw new Error('no assistant response in persist');
  const userEntry = entries.find((m) => m.id === b0.current_user_message_id);
  if (!userEntry) throw new Error('no real user id in persist');
  if (!Array.isArray(userEntry.content) || !userEntry.content.some((p) => p.type === 'image_url')) throw new Error('no attachment in persist');
  ok('A5 persist (POST /api/v1/chats/mock-chat-1) — attachment + response written to history');

  // 6) auto-reload -> success is visible on the page, the error row disappears
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('Hello! This is an automatic') && !document.querySelector('#messages .err');
  }, null, { timeout: 15000 });
  ok('A6 page reloaded automatically — the successful response is visible, the error row is gone');
};

scenarios.B = async () => {
  await setup(['http429', 'sse_ok']);
  await send('429 test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'B: no retry');
  const gap = log.requests[1].t - log.requests[0].t;
  if (gap < 900) throw new Error('Retry-After (1s) was not honored: gap=' + gap + 'ms');
  if (gap > 6000) throw new Error('Retry-After executed too late: gap=' + gap + 'ms');
  if (!log.requests[1].sigOk) throw new Error('the second request failed the signature check');
  await pollLog((l) => l.persists.length >= 1, 15000, 'B: no persist');
  ok('B HTTP 429 + Retry-After=1s -> retry after ' + gap + 'ms, success');
};

scenarios.C = async () => {
  await setup(['badreq']);
  await send('fatal test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await sleep(3500);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('a retry was sent despite the fatal error: ' + log.requests.length);
  const pillInfo = await pollPill((s) => s === 'err', 6000);
  if (pillInfo.state !== 'err') throw new Error('pill is not in the error state: ' + pillInfo.state + ' | ' + pillInfo.text);
  if (!/Send failed/.test(pillInfo.text)) throw new Error('pill text: ' + pillInfo.text);
  ok('C 400 (fatal) -> NO automatic retry, the pill shows the error');
};

scenarios.D = async () => {
  await setup(['netkill', 'sse_ok']);
  await send('netkill test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const log = await pollLog((l) => l.requests.length >= 2, 25000, 'D: no retry');
  const r1 = log.requests[1];
  if (!r1.sigOk) throw new Error('the retry failed the signature check');
  await pollLog((l) => l.persists.length >= 1, 15000, 'D: no persist');
  ok('D stream cut (partial response, no [DONE]) -> retry completed successfully');
};

scenarios.E = async () => {
  await setup(['busy', 'sse_ok']);
  await page.evaluate(() => { window.__deterministicIds = true; });
  await send('dedup test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  // Right after the error the app itself resends the same message.
  // Directly via the DOM (evaluate) — Playwright's fill+click delay races
  // with the 2s extension retry on slow machines (flaky).
  await page.evaluate(() => {
    document.getElementById('composer').value = 'dedup test';
    document.getElementById('send').click();
  });
  await pollLog((l) => l.requests.length >= 2, 15000, 'E: no second request');
  await sleep(3200); // if the extension had a chance to retry, it would have shown here
  const log = await getLog();
  if (log.requests.length !== 2) throw new Error('dedup failed — an extra request went out: ' + log.requests.length);
  await pollLog((l) => l.persists.length >= 1, 15000, 'E: no persist');
  await page.evaluate(() => { window.__deterministicIds = false; });
  ok("E dedup — the app's own resend replaced the extension's retry (2 requests total)");
};

scenarios.F = async () => {
  await setup(['busy', 'sse_ok']);
  await send('cancel test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  const w = await pollPill('wait', 9000);
  if (w.state !== 'wait') throw new Error('pill did not enter the wait state: state=' + w.state + ' | display=' + w.display + ' | seen=' + w.seen + ' | text=' + w.text);
  ok('F1 pill showed the wait state (' + w.seen + ')');
  await page.click('.zai-ext-pill .zai-ext-del');
  await sleep(3200);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('a request went out after the cancel: ' + log.requests.length);
  // F's record must be deleted; the pill must either hide or show another (stale) record —
  // but nothing belonging to the 'cancel test' record may remain
  const fin = await pollPill((s) => true, 3000);
  if (fin.text.includes('cancel test')) throw new Error('the F record is still in the pill: ' + JSON.stringify(fin));
  const sws = ctx.serviceWorkers();
  if (sws.length) {
    const id = new URL(sws[0].url()).host;
    const p2 = await ctx.newPage();
    await p2.goto('chrome-extension://' + id + '/popup/popup.html');
    await p2.waitForTimeout(1500);
    const recsText = await p2.evaluate(() => document.getElementById('recList').innerText);
    await p2.close();
    if (recsText.includes('cancel test')) throw new Error('the F record was not removed from storage: ' + recsText);
  }
  ok('F2 cancel -> retry stopped (1 request only), record deleted' + (fin.state === 'err' ? ' (the pill shows a stale record — the wait was for another message)' : ''));
};

scenarios.G = async () => {
  await setup(['sse_ok']);
  await page.evaluate(() => { window.__mockAutoPreview = true; });
  await send('preview auto test');
  // success arrived -> the mock (like z.ai) opens the preview on its own -> the extension must close it
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.openedBy === 'auto' && mp.open === false && !!mp.closedBy;
  }, null, { timeout: 9000 });
  const st = await page.evaluate(() => window.__mockPreview);
  if (st.opens !== 1) throw new Error('preview opened more times than expected: ' + st.opens);
  ok('G1 the preview that opened itself after success was closed (via ' + st.closedBy + ')');

  // it must appear in the internal log (storage.log)
  const p2 = await extPage('/popup/popup.html');
  await p2.waitForTimeout(1200);
  const logTxt = await p2.evaluate(() => new Promise((r) => chrome.storage.local.get(['log'], (g) => r(((g && g.log) || []).join('\n')))));
  await p2.close();
  if (!/preview blocked/i.test(logTxt)) throw new Error('no preview entry in the log: ' + logTxt.slice(0, 200));
  ok('G2 the "preview blocked" entry appeared in the log');

  // auto-preview after a file add is blocked too
  await page.evaluate(() => { window.__mockAutoPreviewOnAttach = true; });
  await page.setInputFiles('#fileInput', { name: 'image.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.openedBy === 'auto-attach' && mp.open === false && !!mp.closedBy;
  }, null, { timeout: 9000 });
  ok('G3 the automatic preview after a file add was blocked too');
};

scenarios.H = async () => {
  await setup(['sse_ok']);
  await page.setInputFiles('#fileInput', { name: 'image.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#chips .chip', { timeout: 6000 });
  // the user clicks the chip -> the preview MUST OPEN and STAY OPEN
  await page.click('#chips .chip');
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.open === true && mp.openedBy === 'user';
  }, null, { timeout: 5000 });
  await sleep(2800); // verify it does not close
  const st = await page.evaluate(() => window.__mockPreview);
  if (!st.open) throw new Error('the preview the user opened by clicking was closed! closedBy=' + st.closedBy);
  ok('H1 the preview opened by clicking the chip stayed open (opens on click only)');
  await page.keyboard.press('Escape');
  await sleep(300);
  const st2 = await page.evaluate(() => window.__mockPreview);
  if (st2.open) throw new Error('Escape did not close the preview');
  ok('H2 closes normally via Escape');
};

scenarios.I = async () => {
  // turn the setting off -> an automatic preview must stay open (user intent)
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sBlockPreview', { timeout: 5000 });
  await p.waitForFunction(() => document.getElementById('sBlockPreview').checked === true, null, { timeout: 5000 });
  await p.uncheck('#sBlockPreview');
  await p.waitForTimeout(900);
  const s1 = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s1.blockAutoPreview !== false) throw new Error('options auto-save failed (blockAutoPreview)');
  await p.close();

  await setup(['sse_ok']);
  await page.evaluate(() => { window.__mockAutoPreview = true; });
  await send('preview open test');
  await page.waitForFunction(() => {
    const mp = window.__mockPreview;
    return mp && mp.open === true && mp.openedBy === 'auto';
  }, null, { timeout: 6000 });
  await sleep(2500); // verify it does not close
  const st = await page.evaluate(() => window.__mockPreview);
  if (!st.open) throw new Error('the preview was closed despite the setting being off: ' + st.closedBy);
  ok('I with the setting off, an automatic preview stays open');

  // re-enable (default state for later use)
  const p2 = await extPage('/options/options.html');
  await p2.waitForSelector('#sBlockPreview');
  await p2.check('#sBlockPreview');
  await p2.waitForTimeout(900);
  await p2.close();
  ok('I2 the setting was re-enabled (default)');
};

scenarios.J = async () => {
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sBlockPreview', { timeout: 5000 });
  // defaults: blockAutoPreview ON + test-build values
  const checked = await p.isChecked('#sBlockPreview');
  if (!checked) throw new Error('blockAutoPreview is not on by default!');
  const maxR = await p.inputValue('#sMaxRetries');
  if (maxR !== '4') throw new Error('expected TEST default maxRetries=4: ' + maxR);
  const delay = await p.inputValue('#sInitialDelay');
  if (delay !== '2000') throw new Error('expected TEST default initialDelayMs=2000: ' + delay);
  ok('J1 settings page: preview block ON by default, values correct');

  // auto-save: checkbox changes land in storage
  await p.uncheck('#sBlockPreview');
  await p.waitForTimeout(900);
  let s = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s.blockAutoPreview !== false) throw new Error('auto-save failed');
  if (typeof s.jitter !== 'number') throw new Error('a key not in the form (jitter) was lost!');
  await p.check('#sBlockPreview');
  await p.waitForTimeout(900);
  s = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['settings'], (g) => r((g && g.settings) || {}))));
  if (s.blockAutoPreview !== true) throw new Error('could not be restored');
  ok('J2 changes are saved automatically (other keys survive)');

  // new sections exist and their defaults are correct
  const dClosePopups = await p.isChecked('#sClosePopups');
  const dDraftGuard = await p.isChecked('#sDraftGuard');
  const dSerial = await p.isChecked('#sSerial');
  const dDup = await p.isChecked('#sDupGuard');
  if (!dClosePopups || !dDraftGuard || !dSerial || !dDup) {
    throw new Error('defaults are wrong: closePopups=' + dClosePopups + ' draftGuard=' + dDraftGuard + ' serial=' + dSerial + ' dup=' + dDup);
  }
  const snipRows = await p.locator('#snipList .snip-row').count();
  if (snipRows < 1) throw new Error('no default snippets');
  ok('J3 extra sections: popup/draft/serial/duplicate ON by default, snippets ready');
  await p.close();

  // the same toggle is in the correct state in the popup too
  const p2 = await extPage('/popup/popup.html');
  await p2.waitForTimeout(800);
  const pc = await p2.isChecked('#sBlockPreview');
  if (!pc) throw new Error('the preview toggle in the popup is wrong');
  const hasBtn = await p2.locator('#btnOptions').count();
  if (!hasBtn) throw new Error('no Settings button in the popup');
  await p2.close();
  ok('J4 popup: preview toggle + the "Settings" button are ready');
};

/* ================= v1.2.0 scenarios ================= */

scenarios.K = async () => {
  await setup(['sse_ok']);
  const TXT = 'Draft test - this long message must not get lost 12345';
  await page.fill('#composer', TXT);
  await sleep(1400); // debounce 800ms + save throttle
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await page.waitForSelector('.zai-ext-draft', { timeout: 8000 });
  ok('K1 the draft banner appeared after the reload');

  await page.click('.zai-ext-draft button[data-a="restore"]');
  const val = await page.inputValue('#composer');
  if (val !== TXT) throw new Error('the draft was not restored: ' + JSON.stringify(val));
  await page.waitForFunction(() => !document.querySelector('.zai-ext-draft'), null, { timeout: 4000 });
  ok('K2 "Restore" -> the text was put back into the composer');

  // the restored draft was consumed — no repeat offer
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
  await sleep(2000);
  if (await page.locator('.zai-ext-draft').count()) throw new Error('the restored draft was offered again');
  ok('K3 the draft was consumed — no repeat offer');
};

scenarios.L = async () => {
  await setup(['sse_ok']);
  await page.waitForSelector('.zai-ext-fab', { timeout: 8000 });
  ok('L1 the ⚡ snippet button appeared');
  await page.click('.zai-ext-fab');
  await page.waitForSelector('.zai-ext-snip .zai-ext-snip-item', { timeout: 5000 });
  const n = await page.locator('.zai-ext-snip .zai-ext-snip-item').count();
  if (n < 1) throw new Error('the snippet list is empty');
  await page.click('.zai-ext-snip .zai-ext-snip-item >> nth=0');
  const val = await page.inputValue('#composer');
  if (!val || val.length < 3) throw new Error('the snippet text was not inserted: ' + JSON.stringify(val));
  await page.waitForFunction(() => !document.querySelector('.zai-ext-snip'), null, { timeout: 4000 });
  ok('L2 the snippet was inserted into the composer with one click (' + n + ' templates, menu closed)');
};

scenarios.M = async () => {
  await setup(['sse_ok']);
  await send('export test message');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Hello! This is an automatic'), null, { timeout: 15000 });
  const p = await extPage('/popup/popup.html');
  await p.waitForSelector('#btnExport', { timeout: 5000 });
  await p.click('#btnExport');
  await sleep(1800);
  const le = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['lastExport'], (g) => r((g && g.lastExport) || null))));
  await p.close();
  if (!le || !le.md) throw new Error('no lastExport');
  if (!le.md.includes('export test message')) throw new Error('no user message in the md');
  if (!le.md.includes('Hello! This is an automatic')) throw new Error('no response in the md');
  if (!/^# Mock/.test(le.md)) throw new Error('no md title: ' + le.md.slice(0, 60));
  ok('M the chat was exported to Markdown (' + le.name + ')');
};

scenarios.N = async () => {
  await setup(['sse_ok']);
  // 1) the peak hours popup must be closed automatically
  await page.evaluate(() => window.__mockPeakOpen());
  await page.waitForFunction(() => !window.__modalVisible('peakModal'), null, { timeout: 7000 });
  ok('N1 the "Currently in peak hours" popup was closed automatically');

  // 2) the setting is turned off -> the popup must stay open
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sClosePopups', { timeout: 5000 });
  await p.uncheck('#sClosePopups');
  await p.waitForTimeout(900);
  await p.close();
  await page.evaluate(() => window.__mockPeakOpen());
  await sleep(2800);
  if (!await page.evaluate(() => window.__modalVisible('peakModal'))) throw new Error('the popup was closed despite the setting being off');
  ok('N2 with the setting off the popup is untouched');

  // 3) re-enable + scene cleanup
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

  // 4) a password dialog is NEVER closed
  await page.evaluate(() => window.__mockAuthOpen());
  await sleep(2800);
  if (!await page.evaluate(() => window.__modalVisible('authModal'))) throw new Error('the password dialog was closed!');
  await page.evaluate(() => document.getElementById('authModal').classList.remove('open'));
  ok('N3 a password dialog is never closed (safety)');
};

scenarios.O = async () => {
  // Deterministic flow: pause first -> both messages pile up -> then release.
  // (Without the pause the first retry fires at 2s while the second message is not sent yet.)
  const pp = await extPage('/popup/popup.html');
  await pp.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: true }, r)));
  await pp.close();
  await setup(['busy', 'busy', 'sse_ok', 'sse_ok']);
  await send('SERIAL-1 first message');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await send('SERIAL-2 second message');
  await page.waitForFunction(() => document.querySelectorAll('#messages .err').length >= 2, null, { timeout: 8000 });
  const before = await getLog();
  if (before.requests.length !== 2) throw new Error('a request went out while paused: ' + before.requests.length);
  // Release -> serial retries (SERIAL-1 first, then SERIAL-2)
  const pp2 = await extPage('/popup/popup.html');
  await pp2.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: false }, r)));
  await pp2.close();
  const log = await pollLog((l) => l.requests.length >= 4, 30000, 'O: no retries');
  const rs = log.requests.map((r) => String((r.body && r.body.signature_prompt) || ''));
  if (rs[0] !== 'SERIAL-1 first message' || rs[1] !== 'SERIAL-2 second message') {
    throw new Error('the initial sends are wrong: ' + JSON.stringify(rs));
  }
  if (rs[2] !== 'SERIAL-1 first message' || rs[3] !== 'SERIAL-2 second message') {
    throw new Error('the retry order was broken: ' + JSON.stringify(rs));
  }
  const gap = log.requests[3].t - log.requests[2].t;
  if (gap < 150) throw new Error('the retries went in parallel (gap=' + gap + 'ms) — serial mode is not working');
  ok('O serial retry: the messages were resent IN ORDER (gap=' + gap + 'ms)');
};

scenarios.P = async () => {
  await setup(['duptrap']);
  await send('DUPTRAP message');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  // no retry must happen — the duplicate guard sees the server-side write
  await sleep(6500);
  const log = await getLog();
  if (log.requests.length !== 1) throw new Error('a second request went out! requests=' + log.requests.length);
  ok('P1 duplicate guard: the resend did NOT happen (1 request only)');
  const p = await extPage('/popup/popup.html');
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['stats'], (g) => r((g && g.stats) || {}))));
  const recs = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['records'], (g) => r(Object.values((g && g.records) || {})))));
  await p.close();
  if ((st.dupAvoided || 0) < 1) throw new Error('stats.dupAvoided did not increase: ' + JSON.stringify(st));
  const rec = recs.find((r) => (r.promptPreview || '').includes('DUPTRAP'));
  if (!rec || rec.state !== 'succeeded') throw new Error('the record is not succeeded: ' + (rec && rec.state));
  ok('P2 the record was marked "succeeded" (duplicate avoided)');
};

scenarios.Q = async () => {
  // Deterministic: set the initial delay to 8s so there is time to click pause
  // (with the 2s default, on slow machines the click may land AFTER the retry -> flaky).
  const pOpt = await extPage('/options/options.html');
  await pOpt.waitForSelector('#sInitialDelay', { timeout: 5000 });
  await pOpt.fill('#sInitialDelay', '8000');
  await pOpt.waitForTimeout(900);
  await pOpt.close();
  try {
    await setup(['busy', 'sse_ok']);
    await send('pause test');
    await page.waitForSelector('#messages .err', { timeout: 8000 });
    await pollPill('wait', 8000);
    await page.click('.zai-ext-pill .zai-ext-pause');
    await sleep(4200); // the initial delay is 8000ms — the pause has definitely landed in time
    let log = await getLog();
    if (log.requests.length !== 1) throw new Error('a retry went out while paused: ' + log.requests.length);
    ok('Q1 pause -> retries stopped (1 request only)');
    await page.click('.zai-ext-pill .zai-ext-pause'); // resume
    const log2 = await pollLog((l) => l.requests.length >= 2, 20000, 'Q: no retry after resuming');
    if (!log2.requests[1].sigOk) throw new Error('the signature check failed');
    ok('Q2 resumed -> the retry fired');
  } finally {
    // always restore pause and the initial delay (for the later scenarios)
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
    if (!v || v < 1) throw new Error('stats.' + k + ' did not increase: ' + JSON.stringify(st));
  }
  ok('R stats are fully working: ' + JSON.stringify(need));
};

scenarios.S = async () => {
  // defensive: clear any pause state left over from the previous scenario
  const pp0 = await extPage('/popup/popup.html');
  await pp0.evaluate(() => new Promise((r) => chrome.storage.local.set({ paused: false }, r)));
  await pp0.close();
  // maxRetries=2 -> a fast "failed_final"
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sMaxRetries', { timeout: 5000 });
  await p.fill('#sMaxRetries', '2');
  await p.waitForTimeout(900);
  await p.close();
  try {
    await setup(['busy', 'busy', 'busy']); // initial + 2 retries = 3 busy -> failed_final
    const TXT = 'FAILFINAL this message must be copied in full 987654321';
    await send(TXT);
    await page.waitForSelector('#messages .err', { timeout: 8000 });
    // wait for the "Attempts exhausted" text (pollPill can match a stale fatal record too quickly!)
    await page.waitForFunction(() => {
      const el = document.querySelector('.zai-ext-pill .zai-ext-text');
      return el && /Attempts exhausted/.test(el.textContent || '');
    }, null, { timeout: 30000 });
    ok('S1 attempts exhausted -> the pill shows "Attempts exhausted"');
    await page.click('.zai-ext-pill .zai-ext-copy');
    await sleep(700);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip !== TXT) throw new Error('the full text is not in the clipboard: ' + JSON.stringify(clip));
    ok('S2 the full message text was copied (⧉) to the clipboard');
  } finally {
    // always restore maxRetries (the test default is 4)
    const p2 = await extPage('/options/options.html');
    await p2.waitForSelector('#sMaxRetries');
    await p2.fill('#sMaxRetries', '4');
    await p2.waitForTimeout(900);
    await p2.close();
  }
};

scenarios.T = async () => {
  await setup(['sse_ok']);
  // real tab hiding does not work in this environment (xvfb) -> via a QA hook we
  // override document.hidden in the content world (a runtime message)
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
  if (!hooked) throw new Error('SET_HIDDEN_OVERRIDE could not be sent');
  await send('hidden tab test');
  await sleep(2200);
  const p = await extPage('/popup/popup.html');
  await p.waitForTimeout(1200);
  const logTxt = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['log'], (g) => r(((g && g.log) || []).join('\n')))));
  await p.close();
  if (!/notify: response is ready/.test(logTxt)) throw new Error('no notification in the log: ' + logTxt.slice(0, 300));
  ok('T the "response is ready" notification fired while the tab was hidden');
};

/* scenarios */

scenarios.U = async () => {
  await setup(['sse_ok']);
  await page.fill('#composer', 'one two three four');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return el && el.style.display !== 'none' && /4 words/.test(el.textContent || '');
  }, null, { timeout: 8000 });
  const txt = await page.evaluate(() => document.querySelector('.zai-ext-counter').textContent);
  if (!/4 words · 18 chars/.test(txt)) throw new Error('counter text is wrong: ' + JSON.stringify(txt));
  ok('U1 the word counter is visible: "' + txt + '"');
  await page.fill('#composer', '');
  await page.waitForFunction(() => {
    const el = document.querySelector('.zai-ext-counter');
    return !el || el.style.display === 'none';
  }, null, { timeout: 8000 });
  ok('U2 composer empty — the counter hides');
  // when the setting is off the element is removed from the DOM
  const p = await extPage('/options/options.html');
  await p.waitForSelector('#sWordCounter', { timeout: 5000 });
  await p.uncheck('#sWordCounter');
  await page.waitForFunction(() => !document.querySelector('.zai-ext-counter'), null, { timeout: 10000 });
  ok('U3 the setting was turned off — the counter was removed from the DOM');
  await p.check('#sWordCounter');
  await p.waitForTimeout(1200);
  await p.close();
};

scenarios.V = async () => {
  await setup(['busy', 'sse_ok']);
  await send('shortcut test');
  await page.waitForSelector('#messages .err', { timeout: 8000 });
  await pollPill('wait', 8000);

  // Alt+R -> the pending message is resent immediately
  const r1 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'retry-now' });
  if (!r1) throw new Error('CMD_SHORTCUT (retry-now) could not be sent');
  const logV = await pollLog((l) => l.requests.length >= 2, 20000, 'V: retry-now did not fire');
  if (!logV.requests[1].sigOk) throw new Error('the signature check failed');
  ok('V1 Alt+R (retry-now) — the pending message was sent immediately');
  await sleep(1500); // let the auto-reload finish

  // Alt+P -> pause turns on
  const r2 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  if (!r2) throw new Error('toggle-pause could not be sent');
  let pv = null;
  for (let i = 0; i < 20; i++) {
    const g = await storageGet(['paused']);
    if (g.paused === true) { pv = true; break; }
    await sleep(400);
  }
  if (!pv) throw new Error('Alt+P did not enable pause');
  ok('V2 Alt+P (toggle-pause) — pause enabled');

  // Alt+P a second time -> pause turns off
  await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  let pv2 = null;
  for (let i = 0; i < 20; i++) {
    const g = await storageGet(['paused']);
    if (g.paused === false) { pv2 = true; break; }
    await sleep(400);
  }
  if (!pv2) throw new Error('Alt+P did not turn pause off');
  ok('V3 Alt+P a second time — pause turned off');

  // Alt+E -> export the current chat
  const before = (await storageGet(['lastExport'])).lastExport;
  const r3 = await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'export-chat' });
  if (!r3) throw new Error('export-chat could not be sent');
  let le = null;
  for (let i = 0; i < 25; i++) {
    const g = await storageGet(['lastExport']);
    if (g.lastExport && (!before || g.lastExport.at > (before.at || 0))) { le = g.lastExport; break; }
    await sleep(500);
  }
  if (!le || !le.md) throw new Error('Alt+E did not refresh the export');
  ok('V4 Alt+E (export-chat) — the latest export was refreshed (' + le.name + ')');

  // with the setting off the shortcut does not react
  const po = await extPage('/options/options.html');
  await po.waitForSelector('#sShortcuts', { timeout: 5000 });
  await po.uncheck('#sShortcuts');
  await po.waitForTimeout(1400);
  await po.close();
  await cmdToTab({ cmd: 'CMD_SHORTCUT', action: 'toggle-pause' });
  await sleep(1500);
  const g2 = await storageGet(['paused', 'stats']);
  if (g2.paused === true) throw new Error('the disabled shortcut worked!');
  ok('V5 the setting is off — the shortcut does not react');
  const po2 = await extPage('/options/options.html');
  await po2.waitForSelector('#sShortcuts', { timeout: 5000 });
  await po2.check('#sShortcuts');
  await po2.waitForTimeout(1200);
  await po2.close();
  if (((g2.stats || {}).shortcutActions || 0) < 4) {
    throw new Error('stats.shortcutActions did not increase: ' + JSON.stringify(g2.stats));
  }
  ok('V6 shortcut stats: ' + g2.stats.shortcutActions + ' uses');
};

scenarios.W = async () => {
  await setup(['sse_ok']);
  await send('backup test message');
  await page.waitForFunction(() => (document.body.innerText || '').includes('Hello! This is an automatic'), null, { timeout: 15000 });

  const p = await extPage('/popup/popup.html');
  await p.waitForSelector('#btnBackup', { timeout: 5000 });
  await p.click('#btnBackup');
  let lb = null;
  for (let i = 0; i < 40; i++) {
    const g = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['lastBackup'], (x) => r((x && x.lastBackup) || null))));
    if (g && g.count === 2) { lb = g; break; }
    await sleep(500);
  }
  if (!lb || lb.count !== 2) throw new Error('the full backup did not arrive: ' + JSON.stringify(lb));
  ok('W1 full backup ready: 2 chats (mock-chat-1 + mock-chat-2)');
  const ids = (lb.list || []).map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(['mock-chat-1', 'mock-chat-2'])) {
    throw new Error('the backup list is wrong: ' + JSON.stringify(ids));
  }
  ok('W2 the chat list was fetched correctly (GET /api/v1/chats/?page=1)');
  const stW = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['stats'], (g) => r((g && g.stats) || {}))));
  if ((stW.backups || 0) < 1) throw new Error('stats.backups did not increase: ' + JSON.stringify(stW));
  // the internal log in storage is refreshed — wait until the entry shows
  let logOk = false;
  let logTxt = '';
  for (let i = 0; i < 25; i++) {
    logTxt = await p.evaluate(() => new Promise((r) => chrome.storage.local.get(['log'], (g) => r(((g && g.log) || []).join('\n')))));
    if (/full backup ready: 2 chats/.test(logTxt)) { logOk = true; break; }
    await sleep(600);
  }
  if (!logOk) throw new Error('no backup entry in the log: ' + logTxt.slice(0, 200));
  ok('W3 stats.backups=' + stW.backups + ' + a log entry');

  // limit: backupMaxChats=1 -> only 1 chat
  await sleep(3000); // let the popup button become active again
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
  if (!lb2 || lb2.count !== 1) throw new Error('the backupMaxChats limit did not work: ' + JSON.stringify(lb2));
  ok('W4 the backupMaxChats=1 limit is honored (1 chat)');
  const po2 = await extPage('/options/options.html');
  await po2.waitForSelector('#sBackupMaxChats', { timeout: 5000 });
  await po2.fill('#sBackupMaxChats', '50');
  await po2.waitForTimeout(1100);
  await po2.close();
  await p.close();
};

async function main() {
  console.log('== better z.ai — Chromium E2E ==');
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

  // clipboard permissions for scenario S
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  } catch (e) { console.log('  (clipboard permission not granted: ' + e.message + ')'); }

  // Scenario 0: the extension loaded in the MAIN world + ISOLATED world
  try {
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__zaiExtInject === true, null, { timeout: 8000 });
    ok('0 the extension was injected (MAIN world active)');
    const hasPill = await page.locator('.zai-ext-pill').count();
    if (hasPill < 1) throw new Error('the pill is not in the DOM');
    ok('0 the pill is ready in the DOM');
  } catch (e) {
    bad('0 the extension failed to load', e);
    console.error('NOTE: --load-extension only works in headed (xvfb) mode. Use "npm run e2e:chrome".');
    await cleanup(1);
    return;
  }

  // a subset of scenarios can be run with ONLY=A,B,C (because of the 10-min Bash limit)
  const ONLY = process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : null;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log('— Scenario ' + name);
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
    // if the server was started externally — only kill it if it is ours
    serverProc.kill();
  }
  console.log(failures === 0 ? '\nALL PASSED ✔' : '\n' + failures + ' SCENARIO(IES) FAILED ✘');
  process.exit(code);
}

main().catch((e) => { console.error(e); process.exit(1); });
