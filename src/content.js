/*
 * better z.ai — content script (ISOLATED world).
 *
 * Responsibilities:
 *   - talks to inject.js in the page (MAIN world) via postMessage
 *   - stores capture/result records in chrome.storage (restored after a reload)
 *   - schedules retries with exponential backoff (SERIAL mode +
 *     GLOBAL PAUSE)
 *   - manages the pill (floating status card), badge and notifications
 *   - after a successful retry: persist + (optional) page reload
 *
 * Additional features (content side):
 *   - DRAFT GUARD: composer text is saved automatically; after a
 *     reload/crash a "Restore" offer appears
 *   - SNIPPET LIBRARY: ⚡ button — quick-use templates
 *   - MESSAGE RESCUE: the FULL text of a failed message can be copied to the clipboard via ⧉
 *   - CHAT EXPORT: /api/v1/chats/{id} → Markdown (.md) download
 *   - "RESPONSE IS READY" notification when the tab is in the background
 *   - STATS: rescued/blocked/restored counters (popup + options)
 *   - DUPLICATE GUARD: server history is checked before retrying
 *
 * More features (content side):
 *   - KEYBOARD SHORTCUTS: Alt+R (Retry now), Alt+P (pause), Alt+E (export)
 *     — background commands API → CMD_SHORTCUT message
 *   - FULL CHAT BACKUP: chat list + details → .md + .json
 *   - WORD COUNTER: live word/character count next to the composer
 *   - SOUND ALERT: a soft chime the moment the response is ready
 *   - ADAPTIVE BACKOFF: delays grow on consecutive busy results (max ×3)
 */
(function () {
  'use strict';
  if (self.__zaiExtContent) return;
  self.__zaiExtContent = true;

  var C = self.__zaiExtCore;
  var PG = self.__zaiExtPreview;             // preview guard
  var PC = self.__zaiExtPopupCloser;         // popup closer
  var DRAFTS = self.__zaiExtDrafts;          // draft helpers
  var MD = self.__zaiExtMdExport;            // markdown export
  var DEFAULTS = self.__zaiExtDefaults || {};
  var settings = Object.assign({}, DEFAULTS);
  var records = {};        // id -> record (kept in sync with storage)
  var logLines = [];
  var pageOk = false;
  var pillId = null;       // record shown in the pill
  var pillEl = null;
  var saveTimer = null;
  var dirty = false;
  var byHash = {};         // bodyHash -> recordId (dedup for active ones)

  /* state */
  var stats = {
    captured: 0, retryOk: 0, retryFinalFail: 0, fatal: 0,
    previewBlocked: 0, popupsClosed: 0, draftsRestored: 0,
    exports: 0, dupAvoided: 0, snippetsInserted: 0,
    backups: 0, shortcutActions: 0
  };
  var paused = false;      // global pause (storage: 'paused')
  var drafts = {};         // storage: 'drafts' — { key: { text, at } }
  var composerEl = null;
  var draftBannerEl = null;
  var fabEl = null;
  var snipMenuEl = null;
  var draftSaveTimer = null;
  var lastPath = null;

  /* state */
  var counterEl = null;      // word counter element
  var congestion = 0;        // consecutive busy results (adaptive backoff)
  var lastCongestionAt = 0;
  var backupBusy = false;    // full backup in progress right now

  var BUSY_UI_RE = /system is busy|server is busy|too many requests|rate limit|send failed|繁忙|稍后再试|网络错误/i;

  /* QA/test hook: used to fake the hidden-tab state for the
     "response is ready" notification (SET_HIDDEN_OVERRIDE runtime message). Normally null. */
  var hiddenOverride = null;

  /* ---------- helpers ---------- */

  function post(msg) {
    msg.zai = 1;
    try { self.postMessage(msg, self.location.origin); } catch (e) { /* ignore */ }
  }

  async function sha256Hex(s) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    var hex = '';
    var u = new Uint8Array(buf);
    for (var i = 0; i < u.length; i++) hex += u[i].toString(16).padStart(2, '0');
    return hex;
  }

  function activeStates() {
    return ['monitoring', 'pending_retry', 'retrying', 'await_user'];
  }

  function isActive(r) { return r && activeStates().indexOf(r.state) >= 0; }

  function hasBlockingActive(excludeId) {
    return Object.keys(records).some(function (id) {
      if (id === excludeId) return false;
      var r = records[id];
      return r && (r.state === 'pending_retry' || r.state === 'retrying' || r.state === 'await_user');
    });
  }

  function attLabel(n) {
    if (!n) return '';
    if (n === 1) return '1 attachment';
    return n + ' attachments';
  }

  function appendPause(t) {
    return paused ? t + ' · ⏸ paused' : t;
  }

  /* ---------- storage ---------- */

  function saveNow() {
    dirty = false;
    prune();
    try {
      chrome.storage.local.set({
        settings: settings, records: records, log: logLines.slice(-60),
        stats: stats, drafts: drafts
      });
    } catch (e) { /* ignore */ }
  }

  function save() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (dirty) saveNow();
    }, 150);
  }

  // flush immediately on page unload/reload — state survives
  self.addEventListener('pagehide', function () { try { saveNow(); } catch (e) { /* ignore */ } });
  self.addEventListener('beforeunload', function () { try { saveNow(); } catch (e) { /* ignore */ } });

  function prune() {
    var ids = Object.keys(records);
    if (ids.length > 14) {
      // drop the oldest ones
      ids.sort(function (a, b) { return (records[a].ts || 0) - (records[b].ts || 0); });
      while (ids.length > 14) delete records[ids.shift()];
    }
    var now = Date.now();
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if ((r.state === 'succeeded' || r.state === 'aborted') && now - (r.ts || 0) > 30 * 60000) delete records[id];
      if (r.state === 'failed_final' && now - (r.ts || 0) > 7 * 86400000) delete records[id];
    });
    // byHash cleanup
    Object.keys(byHash).forEach(function (h) {
      if (!records[byHash[h]] || !isActive(records[byHash[h]])) delete byHash[h];
    });
    // draft limiti
    if (DRAFTS) DRAFTS.prune(drafts, 20);
  }

  function pushLog(line) {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    logLines.push(hh + ' ' + line);
    if (logLines.length > 80) logLines = logLines.slice(-60);
    save();
  }

  /* ---------- background (badge/notifications) ---------- */

  function bg(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) { /* ignore */ }
  }

  function updateBadge() {
    var n = 0, fail = false;
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (!r) return;
      if (r.state === 'pending_retry' || r.state === 'retrying' || r.state === 'await_user') n++;
      if (r.state === 'failed_fatal' || r.state === 'failed_final') fail = true;
    });
    var text, color;
    if (paused) { text = '||'; color = '#94a3b8'; }
    else {
      text = n > 0 ? String(n) : (fail ? '!' : '');
      color = fail && n === 0 ? '#ef4444' : (n > 0 ? '#f59e0b' : '#10b981');
    }
    bg({ type: 'badge', text: text, color: color });
  }

  function notify(title, message) {
    if (!settings.notify) return;
    bg({ type: 'notify', title: title, message: message });
  }

  /* ---------- pill ---------- */

  function ensurePill() {
    if (pillEl && pillEl.isConnected) return;
    if (!document.body) return;
    pillEl = document.createElement('div');
    pillEl.className = 'zai-ext-pill';
    pillEl.style.display = 'none';
    pillEl.innerHTML =
      '<span class="zai-ext-dot"></span>' +
      '<span class="zai-ext-text"></span>' +
      '<button class="zai-ext-btn zai-ext-copy" type="button" title="Copy the full message text">⧉</button>' +
      '<button class="zai-ext-btn zai-ext-pause" type="button" title="Pause automatic retries">⏸</button>' +
      '<button class="zai-ext-btn zai-ext-now" type="button">Retry now</button>' +
      '<button class="zai-ext-btn zai-ext-del" type="button" title="Sil">✕</button>';
    pillEl.querySelector('.zai-ext-now').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pillId) manualRetry(pillId);
    });
    pillEl.querySelector('.zai-ext-del').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pillId) deleteRecord(pillId, true);
    });
    pillEl.querySelector('.zai-ext-copy').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pillId && records[pillId]) copyRecordText(records[pillId]);
    });
    pillEl.querySelector('.zai-ext-pause').addEventListener('click', function (ev) {
      ev.stopPropagation();
      setPaused(!paused);
    });
    document.body.appendChild(pillEl);
    updatePauseBtn();
  }

  function updatePauseBtn() {
    if (!pillEl) return;
    var b = pillEl.querySelector('.zai-ext-pause');
    if (!b) return;
    b.textContent = paused ? '▶' : '⏸';
    b.title = paused ? 'Resume automatic retries' : 'Pause automatic retries';
  }

  function hidePill() {
    pillId = null;
    if (pillEl) { pillEl.style.display = 'none'; pillEl.dataset.state = ''; }
  }

  function showPill(rec, text, state, showNow, showCopy) {
    ensurePill();
    if (!pillEl) return;
    pillId = rec.id;
    pillEl.style.display = 'flex';
    pillEl.dataset.state = state;
    pillEl.querySelector('.zai-ext-text').textContent = text;
    pillEl.querySelector('.zai-ext-now').style.display = showNow === false ? 'none' : '';
    pillEl.querySelector('.zai-ext-copy').style.display = showCopy ? '' : 'none';
    updatePauseBtn();
  }

  /* short-lived pill message (copy/export confirmation) */
  function flashPillText(text) {
    try {
      ensurePill();
      if (!pillEl) return;
      showPill({ id: '__flash' }, text, 'ok', false, false);
      setTimeout(function () { if (pillId === '__flash') refreshPill(); }, 2200);
    } catch (e) { /* ignore */ }
  }

  function pillFor(rec) {
    if (!rec) { hidePill(); return; }
    var att = rec.attachments && rec.attachments.length
      ? ' · ' + attLabel(rec.attachments.length) : '';
    var s = rec.state;
    if (s === 'pending_retry') {
      var left = Math.max(0, Math.ceil(((rec.nextAt || Date.now()) - Date.now()) / 1000));
      showPill(rec, appendPause('Resending — attempt ' + rec.attempt + '/' + settings.maxRetries +
        ' · ' + left + 's' + att), 'wait');
    } else if (s === 'retrying') {
      showPill(rec, appendPause('Sending…' + att), 'busy');
    } else if (s === 'await_user') {
      showPill(rec, 'No response received' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : ''), 'warn', true, true);
    } else if (s === 'failed_fatal') {
      showPill(rec, 'Send failed' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : '') + ' (no auto-retry)', 'err', true, true);
    } else if (s === 'failed_final') {
      showPill(rec, 'Attempts exhausted (' + settings.maxRetries + ')' + att, 'err', true, true);
    } else if (s === 'succeeded') {
      showPill(rec, '✓ Message resent automatically' + att, 'ok');
    } else {
      hidePill();
    }
  }

  function refreshPill() {
    // Priority: active (pending/retrying/persisting) records replace stale
    // failed ones; otherwise the newest failed/await record is shown.
    var act = null, fail = null;
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (!r) return;
      var s = r.state;
      if (s === 'succeeded' || s === 'monitoring' || s === 'aborted' || s === 'superseded') return;
      if (s === 'pending_retry' || s === 'retrying' || s === 'persisting') {
        if (!act || (r.ts || 0) > (act.ts || 0)) act = r;
      } else {
        if (!fail || (r.ts || 0) > (fail.ts || 0)) fail = r;
      }
    });
    var cand = act || fail;
    if (cand) pillFor(cand);
    else hidePill();
  }

  /* ---------- qlobal pauza ---------- */

  function setPaused(v) {
    paused = !!v;
    try { chrome.storage.local.set({ paused: paused }); } catch (e) { /* ignore */ }
    if (!paused) {
      // when resuming, pull stale timers up to "now + 0.8s"
      var now = Date.now();
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (r && r.state === 'pending_retry' && (!r.nextAt || r.nextAt < now)) r.nextAt = now + 800;
      });
    }
    save();
    updateBadge();
    refreshPill();
    pushLog(paused ? '⏸ automatic retries paused' : '▶ automatic retries resumed');
  }

  /* ---------- state transitions ---------- */

  function scheduleRetry(rec, reason, retryAfterMs) {
    rec.attempt = (rec.attempt || 0) + 1;
    rec.ts = Date.now();
    if (rec.attempt > (settings.maxRetries || 6)) {
      rec.state = 'failed_final';
      rec.lastMsg = reason || '';
      stats.retryFinalFail = (stats.retryFinalFail || 0) + 1;
      notify('better z.ai', 'Automatic send failed after ' + settings.maxRetries + ' attempts. You can resend the message manually from the popup.');
      updateBadge();
      save();
      refreshPill();
      return;
    }
    var delay = C.computeDelay(rec.attempt, settings);
    // adaptive backoff — delays grow on consecutive busy results (max ×3);
    // the counter resets if no new busy arrives within a 5-minute "cooldown".
    if (settings.adaptiveBackoff !== false && congestion > 0) {
      if (Date.now() - lastCongestionAt > 300000) {
        congestion = 0;
      } else {
        delay = Math.round(delay * C.congestionMultiplier(congestion));
      }
    }
    delay = C.applyRetryAfter(delay, retryAfterMs);
    rec.nextAt = Date.now() + delay;
    rec.state = 'pending_retry';
    rec.lastMsg = reason || '';
    if (rec.attempt === 1 && !rec.notifiedStart) {
      rec.notifiedStart = true;
      notify('better z.ai', 'Send failed (' + C.firstLine(reason || 'error', 60) + '). Automatic retry ' + rec.attempt + '/' + settings.maxRetries + '…');
    }
    updateBadge();
    save();
    refreshPill();
  }

  function onResult(rec, d) {
    if (!rec) return;
    if (rec.state === 'superseded' || rec.state === 'aborted') return;
    pushLog('result [' + d.src + '] ' + d.outcome + (d.msg ? ' — ' + C.firstLine(d.msg, 80) : ''));
    if (d.outcome === 'success') {
      rec.state = 'succeeded';
      rec.ts = Date.now();
      rec.lastMsg = '';
      congestion = 0; // success → congestion counter resets
      if (d.dupGuard) {
        // duplicate guard cancelled the retry — message already arrived
        stats.dupAvoided = (stats.dupAvoided || 0) + 1;
        notify('better z.ai', 'Message had already arrived — duplicate send avoided ✓');
        maybeReload(rec.id);
      } else if (d.src === 'retry') {
        stats.retryOk = (stats.retryOk || 0) + 1;
        notify('better z.ai', 'Message resent automatically ✓ (attachments preserved).');
        if (settings.persistAfterRetry && rec.canReplay) {
          rec.state = 'persisting';
          post({ t: 'PERSIST', id: rec.id });
        } else {
          maybeReload(rec.id);
        }
      } else if (settings.notifyDone && (document.hidden || hiddenOverride === true) && !rec.notifiedDone) {
        // "response is ready" notification when the tab is in the background
        rec.notifiedDone = true;
        pushLog('notify: response is ready (' + C.firstLine(rec.promptPreview || '', 40) + ')');
        notify('Z.ai — response is ready ✓', 'Question: ' + C.firstLine(rec.promptPreview || '', 60));
        if (settings.notifySound) playChime(); // soft chime
      }
      updateBadge();
      save();
      if (rec.state !== 'persisting') refreshPill();
      return;
    }
    if (d.outcome === 'retry') {
      // congestion counter — every failed outcome lengthens delays a bit
      congestion = Math.min(9, congestion + 1);
      lastCongestionAt = Date.now();
      scheduleRetry(rec, d.msg || d.reason, d.retryAfterMs);
      return;
    }
    if (d.outcome === 'aborted') {
      rec.state = 'aborted';
      delete records[rec.id];
      updateBadge();
      save();
      refreshPill();
      return;
    }
    if (d.outcome === 'await_user') {
      rec.state = 'await_user';
      rec.ts = Date.now();
      rec.lastMsg = d.msg || '';
      rec.domConfirmUntil = Date.now() + 15000;
      updateBadge();
      save();
      refreshPill();
      return;
    }
    // fatal / partial
    rec.state = 'failed_fatal';
    rec.ts = Date.now();
    rec.lastMsg = d.msg || d.reason || '';
    stats.fatal = (stats.fatal || 0) + 1;
    notify('better z.ai', 'Send failed: ' + C.firstLine(rec.lastMsg, 90) + ' — automatic retry does not apply to this error.');
    updateBadge();
    save();
    refreshPill();
  }

  function onPersisted(rec, d) {
    if (!rec) return;
    pushLog('persist ' + (d.ok ? 'ok' + (d.why ? ' (' + d.why + ')' : '') : ' failed: ' + (d.why || d.status)));
    if (d.ok) {
      rec.state = 'succeeded';
      maybeReload(rec.id);
    } else {
      // persist failed — recommend a reload
      notify('better z.ai', 'Message sent, but history could not be saved — reload the page.');
    }
    updateBadge();
    save();
    refreshPill();
  }

  function maybeReload(excludeId) {
    if (!settings.autoReload) { refreshPill(); return; }
    if (hasBlockingActive(excludeId)) { refreshPill(); return; }
    ensurePill();
    showPill(records[excludeId] || { id: excludeId }, '✓ Sent successfully — page reloading…', 'ok', false, false);
    setTimeout(function () { try { self.location.reload(); } catch (e) { /* ignore */ } }, 900);
  }

  function manualRetry(id) {
    var rec = records[id];
    if (!rec) return;
    if (rec.state === 'succeeded' || rec.state === 'monitoring') return;
    rec.attempt = 0;
    rec.state = 'pending_retry';
    rec.nextAt = Date.now();
    rec.resumeConsent = true;
    updateBadge();
    save();
    pushLog('manual retry: ' + (rec.promptPreview || '').slice(0, 40));
    refreshPill();
  }

  function deleteRecord(id, fromUser) {
    var rec = records[id];
    if (!rec) { refreshPill(); return; }
    if (fromUser) pushLog('user dismissed: ' + (rec.promptPreview || '').slice(0, 40));
    rec.state = 'aborted';
    delete records[id];
    if (pillId === id) hidePill();
    updateBadge();
    save();
    refreshPill();
  }

  /* ---------- capture ---------- */

  function onCaptured(meta) {
    // dedup: if the same body hash exists in an active record → the older pending retry is cancelled
    var rec = {
      id: meta.id, url: meta.url, origin: meta.origin, pathname: meta.pathname,
      queryEntries: meta.queryEntries, query: meta.query, headers: meta.headers,
      body: meta.body, bodyLen: meta.bodyLen || 0,
      canReplay: !!meta.canReplay, canResign: !!meta.canResign,
      promptPreview: meta.promptPreview || '', attachments: meta.attachments || [],
      lastUserText: meta.lastUserText || '',
      chatId: meta.chatId || '', ts: meta.ts || Date.now(),
      state: 'monitoring', attempt: 0, nextAt: 0, lastMsg: '', history: []
    };
    records[meta.id] = rec;
    stats.captured = (stats.captured || 0) + 1;
    // draft already consumed — the message was sent
    if (settings.draftGuard && DRAFTS) {
      var dk = DRAFTS.key(location.pathname);
      if (drafts[dk]) { delete drafts[dk]; save(); }
    }
    pushLog('tutuldu: ' + rec.pathname + (rec.attachments.length ? ' (' + attLabel(rec.attachments.length) + ')' : '')
      + (rec.canReplay ? '' : ' [not replayable]'));
    if (typeof rec.body === 'string' && rec.body) {
      sha256Hex(rec.body).then(function (h) {
        var oldId = byHash[h];
        if (oldId && oldId !== rec.id && records[oldId] && isActive(records[oldId])) {
          pushLog('dedup: same request seen again — older retry cancelled');
          var old = records[oldId];
          old.state = 'superseded';
          delete records[oldId];
          if (pillId === oldId) hidePill();
        }
        byHash[h] = rec.id;
        updateBadge();
        refreshPill();
      }).catch(function () { /* ignore */ });
    }
    updateBadge();
    save();
  }

  /* ---------- tick (serial retries + pause) ---------- */

  function tick() {
    var now = Date.now();
    var needPillRefresh = false;
    if (!paused && pageOk) {
      // due retries — starting from the oldest
      var due = [];
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (r && r.state === 'pending_retry' && r.nextAt && r.nextAt <= now) due.push(r);
      });
      due.sort(function (a, b) { return (a.nextAt || a.ts || 0) - (b.nextAt || b.ts || 0); });
      // SERIAL mode (default): only ONE retry runs at a time —
      // message order is preserved and the server is not overloaded.
      var budget = settings.serialRetries === false ? due.length : 1;
      for (var i = 0; i < due.length && budget > 0; i++) {
        var r = due[i];
        r.state = 'retrying';
        r.retryTimeout = now + 180000;
        r.ts = now;
        post({
          t: 'RETRY', id: r.id,
          opts: {
            resign: settings.resign !== false, resignAfterMs: settings.minResignAgeMs || 240000,
            attempt: (r.attempt || 0), dupGuard: settings.dupGuard !== false
          }
        });
        budget--;
        needPillRefresh = true;
        save();
      }
    }
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (!r) return;
      if (r.state === 'retrying' && r.retryTimeout && now > r.retryTimeout) {
        // no result came — reschedule
        scheduleRetry(r, 'timeout (no result)', null);
      }
    });
    if (needPillRefresh) refreshPill();
    // pill seconds counter
    if (pillId && records[pillId] && records[pillId].state === 'pending_retry') {
      var left = Math.max(0, Math.ceil(((records[pillId].nextAt || 0) - now) / 1000));
      var el = pillEl && pillEl.querySelector('.zai-ext-text');
      if (el) el.textContent = appendPause('Resending — attempt ' + records[pillId].attempt + '/' + settings.maxRetries + ' · ' + left + 's');
    }
  }

  /* ---------- DOM fallback ---------- */

  var domTimer = null;
  function domScan() {
    domTimer = null;
    var need = Object.keys(records).some(function (id) {
      var r = records[id];
      return r && r.state === 'await_user' && r.domConfirmUntil && Date.now() < r.domConfirmUntil;
    });
    if (!need) return;
    var text = '';
    try { text = (document.body && document.body.innerText || '').slice(0, 20000); } catch (e) { return; }
    if (!BUSY_UI_RE.test(text)) return;
    if (!settings.domFallback) return;
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (r && r.state === 'await_user' && r.domConfirmUntil && Date.now() < r.domConfirmUntil) {
        pushLog('DOM confirm: busy error seen on the page → retry');
        scheduleRetry(r, 'busy error on page (DOM)', null);
      }
    });
  }

  function startDomObserver() {
    try {
      var mo = new MutationObserver(function () {
        if (domTimer) return;
        domTimer = setTimeout(domScan, 600);
      });
      var start = function () {
        if (!document.body) { setTimeout(start, 300); return; }
        mo.observe(document.body, { childList: true, characterData: true, subtree: true });
      };
      start();
    } catch (e) { /* ignore */ }
  }

  /* ---------- clipboard ---------- */

  function fallbackCopy(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  function copyTextToClipboard(txt) {
    return new Promise(function (resolve) {
      var t = String(txt || '');
      if (!t) return resolve(false);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(function () { resolve(true); },
            function () { resolve(fallbackCopy(t)); });
          return;
        }
      } catch (e) { /* ignore */ }
      resolve(fallbackCopy(t));
    });
  }

  function copyRecordText(rec) {
    var txt = (rec && rec.lastUserText) || (rec && rec.promptPreview) || '';
    copyTextToClipboard(txt).then(function (ok) {
      pushLog(ok ? 'message text copied (' + txt.length + ' chars)' : 'copy failed');
      if (ok) flashPillText('✓ Message text copied');
      else refreshPill();
    });
  }

  /* ---------- composer + DRAFT GUARD ---------- */

  function findComposer() {
    try {
      var els = document.querySelectorAll('textarea, div[contenteditable="true"]');
      var best = null, bestScore = 0;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 20) continue;
        var st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        // the element placed lower (composer zone) takes priority
        var score = r.width * r.height + (r.bottom > window.innerHeight * 0.5 ? 1e6 : 0);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      return best;
    } catch (e) { return null; }
  }

  function ensureComposer() {
    if (composerEl && composerEl.isConnected) return composerEl;
    composerEl = findComposer();
    return composerEl;
  }

  function composerText() {
    var el = ensureComposer();
    if (!el) return '';
    try {
      return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
        ? String(el.value || '') : String(el.innerText || '');
    } catch (e) { return ''; }
  }

  function setNativeValue(el, txt) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    (desc && desc.set ? desc.set : function (v) { el.value = v; }).call(el, txt);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setComposerText(txt) {
    var el = ensureComposer();
    if (!el) return false;
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        setNativeValue(el, txt);
        try { el.selectionStart = el.selectionEnd = txt.length; } catch (e) { /* ignore */ }
      } else {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, txt);
      }
      return true;
    } catch (e) { return false; }
  }

  function insertAtCursor(txt) {
    var el = ensureComposer();
    if (!el) return false;
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var s = el.selectionStart != null ? el.selectionStart : String(el.value || '').length;
        var e2 = el.selectionEnd != null ? el.selectionEnd : s;
        var v = String(el.value || '');
        setNativeValue(el, v.slice(0, s) + txt + v.slice(e2));
        try { el.selectionStart = el.selectionEnd = s + txt.length; } catch (e) { /* ignore */ }
        return true;
      }
      return !!document.execCommand('insertText', false, txt);
    } catch (e) { return false; }
  }

  function currentDraftKey() {
    return DRAFTS ? DRAFTS.key(location.pathname) : String(location.pathname || '/');
  }

  function scheduleDraftSave() {
    if (draftSaveTimer) return;
    draftSaveTimer = setTimeout(function () {
      draftSaveTimer = null;
      save();
    }, 800);
  }

  function onComposerInput() {
    updateCounter(); // word counter (independent of draftGuard)
    if (!settings.draftGuard || !DRAFTS) return;
    var t = composerText();
    var k = currentDraftKey();
    if (t && t.trim().length > 2) {
      drafts[k] = { text: String(t).slice(0, 100000), at: Date.now() };
      DRAFTS.prune(drafts, 20);
      hideDraftBanner(); // the user is typing — banner not needed
      scheduleDraftSave();
    } else if (drafts[k]) {
      delete drafts[k];
      scheduleDraftSave();
    }
  }

  function maybeOfferDraft() {
    if (!settings.draftGuard || !DRAFTS) return;
    if (draftBannerEl && draftBannerEl.isConnected) return;
    var el = ensureComposer();
    if (!el) return;
    if (composerText().length > 0) return;    // user is already typing
    var d = drafts[currentDraftKey()];
    if (!d || !DRAFTS.fresh(d, settings.draftMaxAgeH)) return;
    if (!d.text || d.text.trim().length < 4) return;
    showDraftBanner(d);
  }

  function showDraftBanner(d) {
    hideDraftBanner();
    try {
      if (!document.body) return;
      draftBannerEl = document.createElement('div');
      draftBannerEl.className = 'zai-ext-draft';
      var ico = document.createElement('span');
      ico.className = 'zai-ext-ico';
      ico.textContent = '📝';
      var txt = document.createElement('span');
      txt.className = 'zai-ext-text';
      txt.textContent = 'Draft found (' + DRAFTS.ageLabel(d) + ' ago)';
      var bR = document.createElement('button');
      bR.className = 'zai-ext-btn';
      bR.type = 'button';
      bR.setAttribute('data-a', 'restore');
      bR.textContent = 'Restore';
      var bD = document.createElement('button');
      bD.className = 'zai-ext-btn zai-ext-del';
      bD.type = 'button';
      bD.setAttribute('data-a', 'dismiss');
      bD.title = 'Sil';
      bD.textContent = '✕';
      draftBannerEl.appendChild(ico);
      draftBannerEl.appendChild(txt);
      draftBannerEl.appendChild(bR);
      draftBannerEl.appendChild(bD);
      draftBannerEl.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('button[data-a]') : null;
        if (!b) return;
        ev.stopPropagation();
        var a = b.getAttribute('data-a');
        if (a === 'restore') {
          if (setComposerText(d.text)) {
            stats.draftsRestored = (stats.draftsRestored || 0) + 1;
            pushLog('draft restored (' + d.text.length + ' chars)');
          }
        } else {
          pushLog('draft dismissed');
        }
        delete drafts[currentDraftKey()];
        save();
        hideDraftBanner();
      });
      document.body.appendChild(draftBannerEl);
      pushLog('draft found — restore offered');
    } catch (e) { draftBannerEl = null; }
  }

  function hideDraftBanner() {
    if (draftBannerEl) {
      try { draftBannerEl.remove(); } catch (e) { /* ignore */ }
      draftBannerEl = null;
    }
  }

  /* ---------- SNIPPET LIBRARY ---------- */

  function snippetList() {
    if (!settings.snippetsEnabled || !Array.isArray(settings.snippets)) return [];
    return settings.snippets.filter(function (s) { return s && s.name && s.text; });
  }

  function closeSnipMenu() {
    if (snipMenuEl) {
      try { snipMenuEl.remove(); } catch (e) { /* ignore */ }
      snipMenuEl = null;
    }
  }

  function ensureFab() {
    var list = snippetList();
    if (!list.length) {
      closeSnipMenu();
      if (fabEl) { try { fabEl.remove(); } catch (e) { /* ignore */ } fabEl = null; }
      return;
    }
    if (fabEl && fabEl.isConnected) return;
    if (!document.body) return;
    try {
      fabEl = document.createElement('button');
      fabEl.type = 'button';
      fabEl.className = 'zai-ext-fab';
      fabEl.title = 'Quick use (snippets)';
      fabEl.textContent = '⚡';
      fabEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleSnipMenu();
      });
      document.body.appendChild(fabEl);
    } catch (e) { fabEl = null; }
  }

  function toggleSnipMenu() {
    if (snipMenuEl && snipMenuEl.isConnected) { closeSnipMenu(); return; }
    var list = snippetList();
    if (!list.length) return;
    try {
      snipMenuEl = document.createElement('div');
      snipMenuEl.className = 'zai-ext-snip';
      var head = document.createElement('div');
      head.className = 'zai-ext-snip-head';
      head.textContent = '⚡ Quick use';
      snipMenuEl.appendChild(head);
      list.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'zai-ext-snip-item';
        var nb = document.createElement('b');
        nb.textContent = s.name;
        var sp = document.createElement('span');
        sp.textContent = C.firstLine(s.text, 60);
        b.appendChild(nb);
        b.appendChild(sp);
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (insertAtCursor(s.text)) {
            stats.snippetsInserted = (stats.snippetsInserted || 0) + 1;
            pushLog('snippet inserted: ' + s.name);
            save();
          }
          closeSnipMenu();
        });
        snipMenuEl.appendChild(b);
      });
      document.body.appendChild(snipMenuEl);
    } catch (e) { closeSnipMenu(); }
  }

  /* ---------- WORD COUNTER ---------- */

  function ensureCounter() {
    if (settings.wordCounter === false) {
      if (counterEl) { try { counterEl.remove(); } catch (e) { /* ignore */ } counterEl = null; }
      return;
    }
    if (counterEl && counterEl.isConnected) return;
    if (!document.body) return;
    try {
      counterEl = document.createElement('div');
      counterEl.className = 'zai-ext-counter';
      counterEl.title = 'Word / character count — better z.ai';
      counterEl.style.display = 'none';
      document.body.appendChild(counterEl);
    } catch (e) { counterEl = null; }
  }

  function updateCounter() {
    ensureCounter();
    if (!counterEl) return;
    var t = composerText();
    if (!t || !t.trim()) { counterEl.style.display = 'none'; return; }
    counterEl.style.display = 'block';
    counterEl.textContent = C.countWords(t) + ' words · ' + t.length + ' chars';
  }

  /* ---------- SOUND ALERT ---------- */

  function playChime() {
    try {
      var AC = self.AudioContext || self.webkitAudioContext;
      if (!AC) return;
      var ctx = playChime._ctx && playChime._ctx.state !== 'closed' ? playChime._ctx : new AC();
      playChime._ctx = ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(function () { /* ignore */ });
      var t0 = ctx.currentTime;
      [[880, 0], [1318.5, 0.16]].forEach(function (n) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t0 + n[1]);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + n[1] + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.34);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t0 + n[1]);
        o.stop(t0 + n[1] + 0.4);
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- KEYBOARD SHORTCUTS ---------- */

  function handleShortcut(action) {
    if (!settings.shortcutsEnabled) return;
    if (action === 'toggle-pause') {
      stats.shortcutActions = (stats.shortcutActions || 0) + 1;
      pushLog('shortcut Alt+P: pause ' + (paused ? 'resumed (▶)' : 'enabled (⏸)'));
      setPaused(!paused);
      save();
      return;
    }
    if (action === 'export-chat') {
      stats.shortcutActions = (stats.shortcutActions || 0) + 1;
      pushLog('shortcut Alt+E: exporting the current chat');
      exportChat();
      save();
      return;
    }
    if (action === 'retry-now') {
      // most relevant record: the one shown in the pill, else the newest pending/failed
      var target = null;
      if (pillId && records[pillId] &&
        ['pending_retry', 'retrying', 'await_user', 'failed_fatal', 'failed_final', 'persisting']
          .indexOf(records[pillId].state) >= 0) {
        target = records[pillId];
      } else {
        var bestTs = 0;
        Object.keys(records).forEach(function (id) {
          var r = records[id];
          if (!r || ['succeeded', 'monitoring', 'aborted', 'superseded'].indexOf(r.state) >= 0) return;
          if ((r.ts || 0) >= bestTs) { bestTs = r.ts || 0; target = r; }
        });
      }
      if (target) {
        stats.shortcutActions = (stats.shortcutActions || 0) + 1;
        pushLog('shortcut Alt+R: "Retry now" — ' + C.firstLine(target.promptPreview || '', 40));
        manualRetry(target.id);
      } else {
        flashPillText('Alt+R: no pending message');
      }
      save();
      return;
    }
  }

  /* ---------- CHAT EXPORT ---------- */

  function currentChatId() {
    var id = '';
    var bestTs = 0;
    Object.keys(records).forEach(function (rid) {
      var r = records[rid];
      if (r && r.chatId && (r.ts || 0) >= bestTs) { bestTs = r.ts || 0; id = r.chatId; }
    });
    if (!id) {
      // from the URL: chat.z.ai/c/<id>
      var m = /\/c\/([A-Za-z0-9_\-]{4,})/.exec(location.pathname || '');
      if (m) id = m[1];
    }
    return id;
  }

  function exportChat() {
    var cid = currentChatId();
    if (!cid) {
      pushLog('export: chat id not found');
      notify('better z.ai', 'No chat to export — send a message in this chat first.');
      return;
    }
    pushLog('export started: ' + cid);
    post({ t: 'EXPORT', chatId: cid });
  }

  function onExported(d) {
    if (!d || !d.ok) {
      pushLog('export failed: ' + ((d && d.why) || 'unknown'));
      notify('better z.ai', 'Chat could not be exported (' + ((d && d.why) || 'error') + ').');
      return;
    }
    var md = MD ? MD.buildMarkdown(d.chat, { url: location.href, date: Date.now() }) : null;
    if (!md) {
      pushLog('export: history is empty');
      notify('better z.ai', 'Chat history is empty — nothing to export.');
      return;
    }
    var dt = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var name = 'zai-sohbet-' + String(d.chatId || 'chat').slice(0, 24) + '-' +
      dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) + '-' +
      pad(dt.getHours()) + pad(dt.getMinutes()) + '.md';
    try {
      var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { /* ignore */ }
      }, 4000);
    } catch (e) {
      pushLog('export: file download failed (' + e + ')');
    }
    stats.exports = (stats.exports || 0) + 1;
    try { chrome.storage.local.set({ lastExport: { name: name, md: md.slice(0, 5000), at: Date.now() } }); } catch (e) { /* ignore */ }
    pushLog('chat exported: ' + name);
    save();
    flashPillText('✓ Chat exported (.md)');
  }

  /* ---------- FULL CHAT BACKUP ---------- */

  function backupAll() {
    if (backupBusy) { flashPillText('⏳ Backup already in progress…'); return; }
    backupBusy = true;
    var max = settings.backupMaxChats || 50;
    pushLog('full backup started (max ' + max + ' chats)');
    ensurePill();
    if (pillEl) showPill({ id: '__backup' }, '⤓ Preparing backup…', 'busy', false, false);
    post({ t: 'BACKUP_ALL', maxChats: max });
  }

  function onBackupProgress(d) {
    try {
      if (!backupBusy) return;
      ensurePill();
      if (pillEl && pillId === '__backup') {
        showPill({ id: '__backup' }, '⤓ Backup: ' + d.done + '/' + d.total +
          (d.title ? ' · ' + C.firstLine(d.title, 30) : ''), 'busy', false, false);
      }
    } catch (e) { /* ignore */ }
  }

  function onBackupDone(d) {
    backupBusy = false;
    if (!d || !d.ok) {
      pushLog('full backup failed: ' + ((d && d.why) || 'unknown'));
      notify('better z.ai', 'Full backup failed (' + ((d && d.why) || 'error') + ').');
      refreshPill();
      return;
    }
    var chats = d.chats || [];
    if (!chats.length) {
      pushLog('full backup: no chats found');
      notify('better z.ai', 'No chats found to back up.');
      refreshPill();
      return;
    }
    // 1) Combined Markdown (table of contents + a separate section per chat)
    var parts = ['# Z.ai — tam backup', '',
      '> ' + new Date().toLocaleString('az-AZ') + ' · ' + chats.length +
      ' chats · better z.ai', '', '## Contents', ''];
    (d.list || []).forEach(function (c, i) {
      parts.push('- ' + (i + 1) + '. ' + (c.title || '(untitled)') + ' (`' + c.id + '`)');
    });
    parts.push('', '---', '');
    chats.forEach(function (chat) {
      var md = MD ? MD.buildMarkdown(chat, { date: Date.now() }) : null;
      if (md) parts.push(md, '', '---', '');
    });
    var mdAll = parts.join('\n');
    // 2) Raw JSON — full backup copy (original structure)
    var jsonAll = JSON.stringify({
      zaiBackup: true, version: '1.3.0', at: Date.now(),
      count: chats.length, list: d.list || [], chats: chats
    });
    var dt = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var stamp = dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) + '-' +
      pad(dt.getHours()) + pad(dt.getMinutes());
    try {
      [['zai-tam-backup-' + stamp + '.md', mdAll, 'text/markdown;charset=utf-8'],
       ['zai-tam-backup-' + stamp + '.json', jsonAll, 'application/json;charset=utf-8']]
        .forEach(function (f) {
          var blob = new Blob([f[1]], { type: f[2] });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = f[0];
          document.body.appendChild(a);
          a.click();
          setTimeout(function () {
            try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { /* ignore */ }
          }, 4000);
        });
    } catch (e) {
      pushLog('full backup: file download failed (' + e + ')');
    }
    stats.backups = (stats.backups || 0) + 1;
    try { chrome.storage.local.set({ lastBackup: { at: Date.now(), count: chats.length, list: (d.list || []).slice(0, 50) } }); } catch (e) { /* ignore */ }
    pushLog('full backup ready: ' + chats.length + ' chats (.md + .json)');
    notify('better z.ai', 'Full backup ready ✓ — ' + chats.length + ' chats (.md + .json).');
    save();
    flashPillText('✓ Full backup ready (' + chats.length + ' chats)');
  }

  /* ---------- messages from the page ---------- */

  self.addEventListener('message', function (ev) {
    if (ev.source !== self) return;
    var d = ev.data;
    if (!d || d.zai !== 1) return;
    if (d.t === 'CAPTURED' && d.meta) { onCaptured(d.meta); return; }
    if (d.t === 'RESULT') {
      if (PG) { try { PG.noteResult(d); } catch (e) { /* ignore */ } }
      var rec = records[d.id];
      if (!rec) { pushLog('result for unknown record: ' + d.id); return; }
      onResult(rec, d);
      return;
    }
    if (d.t === 'PERSISTED') {
      onPersisted(records[d.id], d);
      return;
    }
    if (d.t === 'EXPORTED') { onExported(d); return; }
    if (d.t === 'BACKUP_PROGRESS') { onBackupProgress(d); return; }
    if (d.t === 'BACKUP_DONE') { onBackupDone(d); return; }
    if (d.t === 'PONG') { pageOk = true; pushLog('inject cavab verdi'); return; }
    if (d.t === 'LOG' && d.line) { pushLog(d.line); return; }
  });

  /* ---------- popup-dan mesajlar ---------- */

  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResponse) {
      if (!m) return;
      if (m.cmd === 'GET_STATE') {
        var list = [];
        Object.keys(records).forEach(function (id) {
          var r = records[id];
          if (!r) return;
          list.push({
            id: r.id, state: r.state, attempt: r.attempt || 0, nextAt: r.nextAt || 0,
            promptPreview: r.promptPreview || '', attachments: r.attachments || [],
            lastUserText: r.lastUserText || '',
            lastMsg: r.lastMsg || '', ts: r.ts || 0,
            maxRetries: settings.maxRetries
          });
        });
        list.sort(function (a, b) { return b.ts - a.ts; });
        sendResponse({ ok: true, pageOk: pageOk, records: list, log: logLines.slice(-40) });
        return;
      }
      if (m.cmd === 'RETRY_NOW' && m.id) { manualRetry(m.id); sendResponse({ ok: true }); return; }
      if (m.cmd === 'DELETE' && m.id) { deleteRecord(m.id, true); sendResponse({ ok: true }); return; }
      if (m.cmd === 'RELOAD') { try { self.location.reload(); } catch (e) { } sendResponse({ ok: true }); return; }
      if (m.cmd === 'EXPORT_CHAT') { exportChat(); sendResponse({ ok: true }); return; }
      if (m.cmd === 'EXPORT_ALL') { backupAll(); sendResponse({ ok: true }); return; }
      if (m.cmd === 'CMD_SHORTCUT' && m.action) {
        handleShortcut(m.action);
        sendResponse({ ok: true });
        return;
      }
      if (m.cmd === 'SET_HIDDEN_OVERRIDE' && typeof m.value === 'boolean') {
        hiddenOverride = m.value;
        sendResponse({ ok: true });
        return;
      }
      if (m.cmd === 'COPY_TEXT' && m.text) {
        copyTextToClipboard(m.text).then(function (ok) { sendResponse({ ok: ok }); });
        return true; // async
      }
      return;
    });
  } catch (e) { /* ignore */ }

  /* ---------- settings / pause changes ---------- */

  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.settings) {
        settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
        post({ t: 'INIT', settings: settings });
        pushLog('settings updated');
        ensureFab();
        closeSnipMenu();
      }
      if (ch.paused) {
        paused = !!ch.paused.newValue;
        updatePauseBtn();
        updateBadge();
        refreshPill();
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- init ---------- */

  function hydratePage() {
    var list = [];
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (!r || !r.body) return;
      list.push({
        id: r.id, url: r.url, origin: r.origin, pathname: r.pathname,
        queryEntries: r.queryEntries, query: r.query, headers: r.headers,
        body: r.body, canReplay: r.canReplay, canResign: r.canResign,
        promptPreview: r.promptPreview, attachments: r.attachments,
        lastUserText: r.lastUserText || '',
        chatId: r.chatId, ts: r.ts, lastText: r.lastText || ''
      });
    });
    if (list.length) post({ t: 'HYDRATE', records: list });
  }

  /* composer/draft/fab housekeeping — also covers SPA navigation */
  function housekeeping() {
    try {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        hideDraftBanner();
        pushLog('chat changed: ' + lastPath);
      }
      ensureComposer();
      ensureFab();
      maybeOfferDraft();
      updateCounter(); // word counter (hidden if the setting is off)
    } catch (e) { /* ignore */ }
  }

  function boot() {
    chrome.storage.local.get(['settings', 'records', 'log', 'stats', 'drafts', 'paused'], function (got) {
      settings = Object.assign({}, DEFAULTS, (got && got.settings) || {});
      records = (got && got.records) || {};
      logLines = (got && got.log) || [];
      stats = Object.assign({}, stats, (got && got.stats) || {});
      drafts = (got && got.drafts) || {};
      paused = !!(got && got.paused);
      lastPath = location.pathname;
      if (PG) {
        try {
          PG.init({
            getSettings: function () { return settings; },
            log: function (line) { pushLog(line); },
            onBlocked: function () { stats.previewBlocked = (stats.previewBlocked || 0) + 1; save(); }
          });
        } catch (e) { /* ignore */ }
      }
      if (PC) {
        try {
          PC.init({
            getSettings: function () { return settings; },
            log: function (line) { pushLog(line); },
            onBlocked: function () { stats.popupsClosed = (stats.popupsClosed || 0) + 1; save(); }
          });
        } catch (e) { /* ignore */ }
      }
      var now = Date.now();

      // pending records left after a reload:
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (!r) return;
        if (r.state === 'pending_retry' || r.state === 'retrying') {
          if (r.resumeConsent) {
            r.state = 'pending_retry';
            r.nextAt = Math.max(r.nextAt || 0, now + 600);
          } else {
            r.state = 'await_user';
            r.lastMsg = 'page reloaded — message not sent yet';
            r.domConfirmUntil = 0;
          }
        } else if (r.state === 'persisting') {
          // retry succeeded and persist status was lost — treat as success
          r.state = 'succeeded';
          r.lastMsg = 'persist status unknown';
        }
      });

      post({ t: 'INIT', settings: settings });
      post({ t: 'PING' });
      hydratePage();
      setTimeout(function () { post({ t: 'PING' }); }, 1500);
      updateBadge();
      save();
      pushLog('content script started (C=' + typeof C + ', PC=' + typeof PC +
        ', DRAFTS=' + typeof DRAFTS + ', defaults.maxRetries=' + settings.maxRetries + ')');
      bg({ type: 'alive' });
      refreshPill();
      updatePauseBtn();
      ensureFab();
      updateCounter();
      setTimeout(maybeOfferDraft, 900);
    });
  }

  /* grab composer inputs (for drafts + counter) */
  try {
    document.addEventListener('input', function (ev) {
      try {
        var el = ensureComposer();
        if (!el) return;
        if (ev.target === el || (el.contains && el.contains(ev.target))) onComposerInput();
      } catch (e) { /* ignore */ }
    }, true);
  } catch (e) { /* ignore */ }

  /* close the snippet menu on outside click/Escape */
  try {
    document.addEventListener('click', function (ev) {
      if (!snipMenuEl) return;
      try {
        if (fabEl && fabEl.contains(ev.target)) return;
        if (snipMenuEl.contains(ev.target)) return;
        closeSnipMenu();
      } catch (e) { /* ignore */ }
    }, true);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeSnipMenu();
    }, true);
  } catch (e) { /* ignore */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensurePill(); refreshPill(); ensureFab(); });
  } else {
    ensurePill();
    ensureFab();
  }
  startDomObserver();
  boot();
  setInterval(tick, 250);
  setInterval(housekeeping, 1200);
  /* live tab address for shortcuts, refreshed every 30 s
     (background only learns aliveTab from messages) */
  setInterval(function () { bg({ type: 'alive' }); }, 30000);
})();
