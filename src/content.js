/*
 * Z.ai Auto-Resend — content script (ISOLATED world).
 *
 * Vəzifələri:
 *   - səhifədəki (MAIN world) inject.js ilə postMessage ilə danışır
 *   - capture/nəticə qeydlərini chrome.storage-da saxlayır (reload-dan sonra bərpa)
 *   - eksponensial backoff ilə retry-ləri planlaşdırır
 *   - pill (zipləyən vəziyyət kartı), badge və bildirişləri idarə edir
 *   - uğurlu retry-dan sonra persist + (istəyə bağlı) səhifənin yenilənməsi
 */
(function () {
  'use strict';
  if (self.__zaiExtContent) return;
  self.__zaiExtContent = true;

  var C = self.__zaiExtCore;
  var DEFAULTS = self.__zaiExtDefaults || {};
  var settings = Object.assign({}, DEFAULTS);
  var records = {};        // id -> record (storage ilə sinonx saxlanılır)
  var logLines = [];
  var pageOk = false;
  var pillId = null;       // pill-də göstərilən rekord
  var pillEl = null;
  var saveTimer = null;
  var dirty = false;
  var byHash = {};         // bodyHash -> recordId (aktivlər üçün dedup)

  var BUSY_UI_RE = /system is busy|server is busy|too many requests|rate limit|göndərilmədi|məşğul|繁忙|稍后再试|网络错误/i;

  /* ---------- köməkçilər ---------- */

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
    if (n === 1) return '1 əlavə';
    return n + ' əlavə';
  }

  /* ---------- storage ---------- */

  function saveNow() {
    dirty = false;
    prune();
    try {
      chrome.storage.local.set({ settings: settings, records: records, log: logLines.slice(-60) });
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

  // səhifə yıxılarkən/yenilənərkən dərhal flush — state itmir
  self.addEventListener('pagehide', function () { try { saveNow(); } catch (e) { /* ignore */ } });
  self.addEventListener('beforeunload', function () { try { saveNow(); } catch (e) { /* ignore */ } });

  function prune() {
    var ids = Object.keys(records);
    if (ids.length > 14) {
      // ən köhnələri sil
      ids.sort(function (a, b) { return (records[a].ts || 0) - (records[b].ts || 0); });
      while (ids.length > 14) delete records[ids.shift()];
    }
    var now = Date.now();
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if ((r.state === 'succeeded' || r.state === 'aborted') && now - (r.ts || 0) > 30 * 60000) delete records[id];
      if (r.state === 'failed_final' && now - (r.ts || 0) > 7 * 86400000) delete records[id];
    });
    // byHash təmizliyi
    Object.keys(byHash).forEach(function (h) {
      if (!records[byHash[h]] || !isActive(records[byHash[h]])) delete byHash[h];
    });
  }

  function pushLog(line) {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    logLines.push(hh + ' ' + line);
    if (logLines.length > 80) logLines = logLines.slice(-60);
    save();
  }

  /* ---------- background (badge/bildiriş) ---------- */

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
    var text = n > 0 ? String(n) : (fail ? '!' : '');
    var color = fail && n === 0 ? '#ef4444' : (n > 0 ? '#f59e0b' : '#10b981');
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
      '<button class="zai-ext-btn zai-ext-now" type="button">İndi cəhd et</button>' +
      '<button class="zai-ext-btn zai-ext-del" type="button" title="Sil">✕</button>';
    pillEl.querySelector('.zai-ext-now').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pillId) manualRetry(pillId);
    });
    pillEl.querySelector('.zai-ext-del').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pillId) deleteRecord(pillId, true);
    });
    document.body.appendChild(pillEl);
  }

  function hidePill() {
    pillId = null;
    if (pillEl) { pillEl.style.display = 'none'; pillEl.dataset.state = ''; }
  }

  function showPill(rec, text, state, showNow) {
    ensurePill();
    if (!pillEl) return;
    pillId = rec.id;
    pillEl.style.display = 'flex';
    pillEl.dataset.state = state;
    pillEl.querySelector('.zai-ext-text').textContent = text;
    pillEl.querySelector('.zai-ext-now').style.display = showNow === false ? 'none' : '';
  }

  function pillFor(rec) {
    if (!rec) { hidePill(); return; }
    var att = rec.attachments && rec.attachments.length
      ? ' · ' + attLabel(rec.attachments.length) : '';
    var s = rec.state;
    if (s === 'pending_retry') {
      var left = Math.max(0, Math.ceil(((rec.nextAt || Date.now()) - Date.now()) / 1000));
      showPill(rec, 'Yenidən göndərilir — cəhd ' + rec.attempt + '/' + settings.maxRetries +
        ' · ' + left + 's' + att, 'wait');
    } else if (s === 'retrying') {
      showPill(rec, 'Göndərilir…' + att, 'busy');
    } else if (s === 'await_user') {
      showPill(rec, 'Cavab alınmadı' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : ''), 'warn');
    } else if (s === 'failed_fatal') {
      showPill(rec, 'Göndərilmədi' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : '') + ' (avto-retry yoxdur)', 'err');
    } else if (s === 'failed_final') {
      showPill(rec, 'Cəhdlər bitdi (' + settings.maxRetries + ')' + att, 'err');
    } else if (s === 'succeeded') {
      showPill(rec, '✓ Mesaj avtomatik yenidən göndərildi' + att, 'ok');
    } else {
      hidePill();
    }
  }

  function refreshPill() {
    // Prioritet: aktiv (pending/retrying/persisting) rekordlar köhnə xətalı
    // rekordları əvəz edir; yoxdursa ən yeni failed/await rekordu göstərilir.
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

  /* ---------- state keçidləri ---------- */

  function scheduleRetry(rec, reason, retryAfterMs) {
    rec.attempt = (rec.attempt || 0) + 1;
    rec.ts = Date.now();
    if (rec.attempt > (settings.maxRetries || 6)) {
      rec.state = 'failed_final';
      rec.lastMsg = reason || '';
      notify('Z.ai Auto-Resend', 'Avtomatik göndərilmə alınmadı (' + settings.maxRetries + ' cəhd). Mesaj popup-dan əl ilə təkrarlana bilər.');
      updateBadge();
      save();
      refreshPill();
      return;
    }
    var delay = C.computeDelay(rec.attempt, settings);
    delay = C.applyRetryAfter(delay, retryAfterMs);
    rec.nextAt = Date.now() + delay;
    rec.state = 'pending_retry';
    rec.lastMsg = reason || '';
    if (rec.attempt === 1 && !rec.notifiedStart) {
      rec.notifiedStart = true;
      notify('Z.ai Auto-Resend', 'Göndərilmədi (' + C.firstLine(reason || 'xəta', 60) + '). Avtomatik yenidən cəhd ' + rec.attempt + '/' + settings.maxRetries + '…');
    }
    updateBadge();
    save();
    refreshPill();
  }

  function onResult(rec, d) {
    if (!rec) return;
    if (rec.state === 'superseded' || rec.state === 'aborted') return;
    pushLog('nəticə [' + d.src + '] ' + d.outcome + (d.msg ? ' — ' + C.firstLine(d.msg, 80) : ''));
    if (d.outcome === 'success') {
      rec.state = 'succeeded';
      rec.ts = Date.now();
      rec.lastMsg = '';
      if (d.src === 'retry') {
        notify('Z.ai Auto-Resend', 'Mesaj avtomatik yenidən göndərildi ✓ (attachment-lar qorundu).');
        if (settings.persistAfterRetry && rec.canReplay) {
          rec.state = 'persisting';
          post({ t: 'PERSIST', id: rec.id });
        } else {
          maybeReload(rec.id);
        }
      }
      updateBadge();
      save();
      if (rec.state !== 'persisting') refreshPill();
      return;
    }
    if (d.outcome === 'retry') {
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
    notify('Z.ai Auto-Resend', 'Göndərilmədi: ' + C.firstLine(rec.lastMsg, 90) + ' — avtomatik retry bu xəta üçün deyil.');
    updateBadge();
    save();
    refreshPill();
  }

  function onPersisted(rec, d) {
    if (!rec) return;
    pushLog('persist ' + (d.ok ? 'ok' + (d.why ? ' (' + d.why + ')' : '') : ' alınmadı: ' + (d.why || d.status)));
    if (d.ok) {
      rec.state = 'succeeded';
      maybeReload(rec.id);
    } else {
      // persist alınmadı — yeniləməyi tövsiyə edirik
      notify('Z.ai Auto-Resend', 'Mesaj göndərildi, amma tarixçə yazıla bilmədi — səhifəni yeniləyin.');
    }
    updateBadge();
    save();
    refreshPill();
  }

  function maybeReload(excludeId) {
    if (!settings.autoReload) { refreshPill(); return; }
    if (hasBlockingActive(excludeId)) { refreshPill(); return; }
    ensurePill();
    showPill(records[excludeId] || { id: excludeId }, '✓ Uğurla göndərildi — səhifə yenilənir…', 'ok', false);
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
    pushLog('əl ilə retry: ' + (rec.promptPreview || '').slice(0, 40));
    refreshPill();
  }

  function deleteRecord(id, fromUser) {
    var rec = records[id];
    if (!rec) { refreshPill(); return; }
    if (fromUser) pushLog('istifadəçi sildi: ' + (rec.promptPreview || '').slice(0, 40));
    rec.state = 'aborted';
    delete records[id];
    if (pillId === id) hidePill();
    updateBadge();
    save();
    refreshPill();
  }

  /* ---------- capture ---------- */

  function onCaptured(meta) {
    // dedup: eyni body hash aktiv rekordda varsa → köhnə pending retry ləğv olunur
    var rec = {
      id: meta.id, url: meta.url, origin: meta.origin, pathname: meta.pathname,
      queryEntries: meta.queryEntries, query: meta.query, headers: meta.headers,
      body: meta.body, bodyLen: meta.bodyLen || 0,
      canReplay: !!meta.canReplay, canResign: !!meta.canResign,
      promptPreview: meta.promptPreview || '', attachments: meta.attachments || [],
      chatId: meta.chatId || '', ts: meta.ts || Date.now(),
      state: 'monitoring', attempt: 0, nextAt: 0, lastMsg: '', history: []
    };
    records[meta.id] = rec;
    pushLog('tutuldu: ' + rec.pathname + (rec.attachments.length ? ' (' + attLabel(rec.attachments.length) + ')' : '')
      + (rec.canReplay ? '' : ' [təkrarlanabilməz]'));
    if (typeof rec.body === 'string' && rec.body) {
      sha256Hex(rec.body).then(function (h) {
        var oldId = byHash[h];
        if (oldId && oldId !== rec.id && records[oldId] && isActive(records[oldId])) {
          pushLog('dedup: eyni sorğu təkrar gəldi — köhnə retry ləğv edildi');
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

  /* ---------- tick ---------- */

  function tick() {
    var now = Date.now();
    var needPillRefresh = false;
    Object.keys(records).forEach(function (id) {
      var r = records[id];
      if (!r) return;
      if (r.state === 'pending_retry' && r.nextAt && r.nextAt <= now && pageOk) {
        r.state = 'retrying';
        r.retryTimeout = now + 180000;
        r.ts = now;
        post({
          t: 'RETRY', id: r.id,
          opts: { resign: settings.resign !== false, resignAfterMs: settings.minResignAgeMs || 240000, attempt: (r.attempt || 0) }
        });
        needPillRefresh = true;
        save();
      } else if (r.state === 'retrying' && r.retryTimeout && now > r.retryTimeout) {
        // nəticə gəlmədi — yenidən planlaşdır
        scheduleRetry(r, 'zaman aşımı (nəticə gəlmədi)', null);
      }
    });
    if (needPillRefresh) refreshPill();
    // pill saniyə sayğacı
    if (pillId && records[pillId] && records[pillId].state === 'pending_retry') {
      var left = Math.max(0, Math.ceil(((records[pillId].nextAt || 0) - now) / 1000));
      var el = pillEl && pillEl.querySelector('.zai-ext-text');
      if (el) el.textContent = 'Yenidən göndərilir — cəhd ' + records[pillId].attempt + '/' + settings.maxRetries + ' · ' + left + 's';
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
        pushLog('DOM təsdiqi: səhifədə busy xətası göründü → retry');
        scheduleRetry(r, 'səhifədə busy xətası (DOM)', null);
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

  /* ---------- səhifədən mesajlar ---------- */

  self.addEventListener('message', function (ev) {
    if (ev.source !== self) return;
    var d = ev.data;
    if (!d || d.zai !== 1) return;
    if (d.t === 'CAPTURED' && d.meta) { onCaptured(d.meta); return; }
    if (d.t === 'RESULT') {
      var rec = records[d.id];
      if (!rec) { pushLog('nəticə naməlum qeyd üçün: ' + d.id); return; }
      onResult(rec, d);
      return;
    }
    if (d.t === 'PERSISTED') {
      onPersisted(records[d.id], d);
      return;
    }
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
      return;
    });
  } catch (e) { /* ignore */ }

  /* ---------- settings dəyişikliyi ---------- */

  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.settings) {
        settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
        post({ t: 'INIT', settings: settings });
        pushLog('parametrlər yeniləndi');
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- başlanğıc ---------- */

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
        chatId: r.chatId, ts: r.ts, lastText: r.lastText || ''
      });
    });
    if (list.length) post({ t: 'HYDRATE', records: list });
  }

  function boot() {
    chrome.storage.local.get(['settings', 'records', 'log'], function (got) {
      settings = Object.assign({}, DEFAULTS, (got && got.settings) || {});
      records = (got && got.records) || {};
      logLines = (got && got.log) || [];
      var now = Date.now();

      // reload-dan sonra qalan pending-lər:
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (!r) return;
        if (r.state === 'pending_retry' || r.state === 'retrying') {
          if (r.resumeConsent) {
            r.state = 'pending_retry';
            r.nextAt = Math.max(r.nextAt || 0, now + 600);
          } else {
            r.state = 'await_user';
            r.lastMsg = 'səhifə yeniləndi — mesaj hələ göndərilməyib';
            r.domConfirmUntil = 0;
          }
        } else if (r.state === 'persisting') {
          // retry uğurla gedib, persist-in statusu itib — uğur kimi qəbul edirik
          r.state = 'succeeded';
          r.lastMsg = 'persist statusu məlum deyil';
        }
      });

      post({ t: 'INIT', settings: settings });
      post({ t: 'PING' });
      hydratePage();
      setTimeout(function () { post({ t: 'PING' }); }, 1500);
      updateBadge();
      save();
      pushLog('content script başladı (C=' + typeof C
        + ', defaults.maxRetries=' + settings.maxRetries + ')');
      bg({ type: 'alive' });
      refreshPill();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensurePill(); refreshPill(); });
  } else {
    ensurePill();
  }
  startDomObserver();
  boot();
  setInterval(tick, 250);
})();
