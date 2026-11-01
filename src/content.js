/*
 * better z.ai — content script (ISOLATED world).
 *
 * Vəzifələri:
 *   - səhifədəki (MAIN world) inject.js ilə postMessage ilə danışır
 *   - capture/nəticə qeydlərini chrome.storage-da saxlayır (reload-dan sonra bərpa)
 *   - eksponensial backoff ilə retry-ləri planlaşdırır (ARDICIL rejim +
 *     QLOBAL PAUZA)
 *   - pill (zipləyən vəziyyət kartı), badge və bildirişləri idarə edir
 *   - uğurlu retry-dan sonra persist + (istəyə bağlı) səhifənin yenilənməsi
 *
 * Əlavə funksiyalar (content tərəfi):
 *   - QARALAMA MÜHAFİZƏSİ: kompozitor mətni avtomatik yadda saxlanılır,
 *     reload/crash-dan sonra "Bərpa et" təklifi
 *   - SNIPPET KİTABXANASI: ⚡ düyməsi — tez istifadə şablonları
 *   - MESAJ XİLASI: uğursuz mesajın TAM mətni ⧉ ilə panoya köçürülür
 *   - SÖHBƏTİN İXRACI: /api/v1/chats/{id} → Markdown (.md) yükləmə
 *   - "CAVAB HAZIRDIR" bildirişi: tab arxa planda olanda
 *   - STATİSTİKA: xilas/blok/bərpa sayğacları (popup + ayarlar)
 *   - DUBLİKAT QORUNMASI: retry-dan əvvəl server tarixçəsi yoxlanılır
 *
 * Daha çox funksiyalar (content tərəfi):
 *   - KLAVİATURA QISAYOLLARI: Alt+R (indi cəhd et), Alt+P (pauza), Alt+E (ixrac)
 *     — background commands API → CMD_SHORTCUT mesajı
 *   - BÜTÜN SÖHBƏTLƏRİN BACKUP-I: chat siyahısı + detallar → .md + .json
 *   - SÖZ SAYĞACI: kompozitor yanında canlı söz/simvol sayı
 *   - SƏSLİ BİLDİRİŞ: "cavab hazırdır" anında yumşaq zəng (səs)
 *   - ADAPTİV BACKOFF: ardıcıl busy-lərdə gecikmələr uzanır (maks x3)
 */
(function () {
  'use strict';
  if (self.__zaiExtContent) return;
  self.__zaiExtContent = true;

  var C = self.__zaiExtCore;
  var PG = self.__zaiExtPreview;             // preview guard
  var PC = self.__zaiExtPopupCloser;         // popap bağlayıcı
  var DRAFTS = self.__zaiExtDrafts;          // qaralama köməkçiləri
  var MD = self.__zaiExtMdExport;            // markdown ixracı
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

  /* state */
  var stats = {
    captured: 0, retryOk: 0, retryFinalFail: 0, fatal: 0,
    previewBlocked: 0, popupsClosed: 0, draftsRestored: 0,
    exports: 0, dupAvoided: 0, snippetsInserted: 0,
    backups: 0, shortcutActions: 0
  };
  var paused = false;      // qlobal pauza (storage: 'paused')
  var drafts = {};         // storage: 'drafts' — { key: { text, at } }
  var composerEl = null;
  var draftBannerEl = null;
  var fabEl = null;
  var snipMenuEl = null;
  var draftSaveTimer = null;
  var lastPath = null;

  /* state */
  var counterEl = null;      // söz sayğacı elementi
  var congestion = 0;        // ardıcıl busy nəticələri (adaptiv backoff)
  var lastCongestionAt = 0;
  var backupBusy = false;    // tam backup hal-hazırda gedir

  var BUSY_UI_RE = /system is busy|server is busy|too many requests|rate limit|göndərilmədi|məşğul|繁忙|稍后再试|网络错误/i;

  /* QA/test hook-u: "cavab hazırdır" bildirişinin gizli-tab halını süni
     yaratmaq üçün (SET_HIDDEN_OVERRIDE runtime mesajı). Normalda null. */
  var hiddenOverride = null;

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

  function appendPause(t) {
    return paused ? t + ' · ⏸ dayandırılıb' : t;
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
      '<button class="zai-ext-btn zai-ext-copy" type="button" title="Mesajın tam mətnini kopyala">⧉</button>' +
      '<button class="zai-ext-btn zai-ext-pause" type="button" title="Avtomatik retry-ləri dayandır">⏸</button>' +
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
    b.title = paused ? 'Avtomatik retry-ləri davam etdir' : 'Avtomatik retry-ləri dayandır';
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

  /* qısa müddətli pill mesajı (kopyala/ixrac təsdiqi) */
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
      showPill(rec, appendPause('Yenidən göndərilir — cəhd ' + rec.attempt + '/' + settings.maxRetries +
        ' · ' + left + 's' + att), 'wait');
    } else if (s === 'retrying') {
      showPill(rec, appendPause('Göndərilir…' + att), 'busy');
    } else if (s === 'await_user') {
      showPill(rec, 'Cavab alınmadı' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : ''), 'warn', true, true);
    } else if (s === 'failed_fatal') {
      showPill(rec, 'Göndərilmədi' + att + (rec.lastMsg ? ' — ' + rec.lastMsg : '') + ' (avto-retry yoxdur)', 'err', true, true);
    } else if (s === 'failed_final') {
      showPill(rec, 'Cəhdlər bitdi (' + settings.maxRetries + ')' + att, 'err', true, true);
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

  /* ---------- qlobal pauza ---------- */

  function setPaused(v) {
    paused = !!v;
    try { chrome.storage.local.set({ paused: paused }); } catch (e) { /* ignore */ }
    if (!paused) {
      // davam edəndə köhnə vaxtları "indi + 0.8s"-ə çəkirik
      var now = Date.now();
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (r && r.state === 'pending_retry' && (!r.nextAt || r.nextAt < now)) r.nextAt = now + 800;
      });
    }
    save();
    updateBadge();
    refreshPill();
    pushLog(paused ? '⏸ avtomatik retry dayandırıldı' : '▶ avtomatik retry davam etdirildi');
  }

  /* ---------- state keçidləri ---------- */

  function scheduleRetry(rec, reason, retryAfterMs) {
    rec.attempt = (rec.attempt || 0) + 1;
    rec.ts = Date.now();
    if (rec.attempt > (settings.maxRetries || 6)) {
      rec.state = 'failed_final';
      rec.lastMsg = reason || '';
      stats.retryFinalFail = (stats.retryFinalFail || 0) + 1;
      notify('better z.ai', 'Avtomatik göndərilmə alınmadı (' + settings.maxRetries + ' cəhd). Mesaj popup-dan əl ilə təkrarlana bilər.');
      updateBadge();
      save();
      refreshPill();
      return;
    }
    var delay = C.computeDelay(rec.attempt, settings);
    // adaptiv backoff — ardıcıl busy-lərdə gecikmə uzanır (maks x3);
    // 5 dəqiqə "soyuma" olmadan yeni busy yoxdursa sayğaç sıfırlanır.
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
      notify('better z.ai', 'Göndərilmədi (' + C.firstLine(reason || 'xəta', 60) + '). Avtomatik yenidən cəhd ' + rec.attempt + '/' + settings.maxRetries + '…');
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
      congestion = 0; // uğur → tıxanma sayğacı sıfırlanır
      if (d.dupGuard) {
        // dublikat qorunması retry-ni ləğv etdi — mesaj onsuz da çatıb
        stats.dupAvoided = (stats.dupAvoided || 0) + 1;
        notify('better z.ai', 'Mesaj onsuz da çatmışdı — dublikat göndərmə önləndi ✓');
        maybeReload(rec.id);
      } else if (d.src === 'retry') {
        stats.retryOk = (stats.retryOk || 0) + 1;
        notify('better z.ai', 'Mesaj avtomatik yenidən göndərildi ✓ (attachment-lar qorundu).');
        if (settings.persistAfterRetry && rec.canReplay) {
          rec.state = 'persisting';
          post({ t: 'PERSIST', id: rec.id });
        } else {
          maybeReload(rec.id);
        }
      } else if (settings.notifyDone && (document.hidden || hiddenOverride === true) && !rec.notifiedDone) {
        // tab arxa planda olanda "cavab hazırdır" bildirişi
        rec.notifiedDone = true;
        pushLog('bildiriş: cavab hazırdır (' + C.firstLine(rec.promptPreview || '', 40) + ')');
        notify('Z.ai — cavab hazırdır ✓', 'Sual: ' + C.firstLine(rec.promptPreview || '', 60));
        if (settings.notifySound) playChime(); // yumşaq zəng
      }
      updateBadge();
      save();
      if (rec.state !== 'persisting') refreshPill();
      return;
    }
    if (d.outcome === 'retry') {
      // tıxanma sayğacı — hər uğursuz nəticə gecikmələri bir az uzadır
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
    notify('better z.ai', 'Göndərilmədi: ' + C.firstLine(rec.lastMsg, 90) + ' — avtomatik retry bu xəta üçün deyil.');
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
      notify('better z.ai', 'Mesaj göndərildi, amma tarixçə yazıla bilmədi — səhifəni yeniləyin.');
    }
    updateBadge();
    save();
    refreshPill();
  }

  function maybeReload(excludeId) {
    if (!settings.autoReload) { refreshPill(); return; }
    if (hasBlockingActive(excludeId)) { refreshPill(); return; }
    ensurePill();
    showPill(records[excludeId] || { id: excludeId }, '✓ Uğurla göndərildi — səhifə yenilənir…', 'ok', false, false);
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
      lastUserText: meta.lastUserText || '',
      chatId: meta.chatId || '', ts: meta.ts || Date.now(),
      state: 'monitoring', attempt: 0, nextAt: 0, lastMsg: '', history: []
    };
    records[meta.id] = rec;
    stats.captured = (stats.captured || 0) + 1;
    // qaralama artıq istehlak olundu — mesaj göndərilib
    if (settings.draftGuard && DRAFTS) {
      var dk = DRAFTS.key(location.pathname);
      if (drafts[dk]) { delete drafts[dk]; save(); }
    }
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

  /* ---------- tick (ardıcıl retry + pauza) ---------- */

  function tick() {
    var now = Date.now();
    var needPillRefresh = false;
    if (!paused && pageOk) {
      // vaxtı çatmış retry-lər — ən köhnəsindən başlayaraq
      var due = [];
      Object.keys(records).forEach(function (id) {
        var r = records[id];
        if (r && r.state === 'pending_retry' && r.nextAt && r.nextAt <= now) due.push(r);
      });
      due.sort(function (a, b) { return (a.nextAt || a.ts || 0) - (b.nextAt || b.ts || 0); });
      // ARDICIL rejim (standart): eyni anda yalnız BİR retry gedir —
      // mesaj sırası qorunur, server həddindən artıq yüklənmir.
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
        // nəticə gəlmədi — yenidən planlaşdır
        scheduleRetry(r, 'zaman aşımı (nəticə gəlmədi)', null);
      }
    });
    if (needPillRefresh) refreshPill();
    // pill saniyə sayğacı
    if (pillId && records[pillId] && records[pillId].state === 'pending_retry') {
      var left = Math.max(0, Math.ceil(((records[pillId].nextAt || 0) - now) / 1000));
      var el = pillEl && pillEl.querySelector('.zai-ext-text');
      if (el) el.textContent = appendPause('Yenidən göndərilir — cəhd ' + records[pillId].attempt + '/' + settings.maxRetries + ' · ' + left + 's');
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

  /* ---------- mübadilə buferi ---------- */

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
      pushLog(ok ? 'mesaj mətni kopyalandı (' + txt.length + ' simvol)' : 'kopyalama alınmadı');
      if (ok) flashPillText('✓ Mesaj mətni kopyalandı');
      else refreshPill();
    });
  }

  /* ---------- kompozitor + QARALAMA MÜHAFİZƏSİ ---------- */

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
        // aşağıda yerləşən (kompozitor zonası) element üstünlük təşkil edir
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
    updateCounter(); // söz sayğacı (draftGuard-dan asılı deyil)
    if (!settings.draftGuard || !DRAFTS) return;
    var t = composerText();
    var k = currentDraftKey();
    if (t && t.trim().length > 2) {
      drafts[k] = { text: String(t).slice(0, 100000), at: Date.now() };
      DRAFTS.prune(drafts, 20);
      hideDraftBanner(); // istifadəçi yazır — banner lazımsızdır
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
    if (composerText().length > 0) return;    // istifadəçi artıq yazır
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
      txt.textContent = 'Qaralama tapıldı (' + DRAFTS.ageLabel(d) + ' əvvəl)';
      var bR = document.createElement('button');
      bR.className = 'zai-ext-btn';
      bR.type = 'button';
      bR.setAttribute('data-a', 'restore');
      bR.textContent = 'Bərpa et';
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
            pushLog('qaralama bərpa edildi (' + d.text.length + ' simvol)');
          }
        } else {
          pushLog('qaralama ləğv edildi');
        }
        delete drafts[currentDraftKey()];
        save();
        hideDraftBanner();
      });
      document.body.appendChild(draftBannerEl);
      pushLog('qaralama tapıldı — bərpa təklif olunur');
    } catch (e) { draftBannerEl = null; }
  }

  function hideDraftBanner() {
    if (draftBannerEl) {
      try { draftBannerEl.remove(); } catch (e) { /* ignore */ }
      draftBannerEl = null;
    }
  }

  /* ---------- SNIPPET KİTABXANASI ---------- */

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
      fabEl.title = 'Tez istifadə (snippetlər)';
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
      head.textContent = '⚡ Tez istifadə';
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
            pushLog('snippet yerləşdirildi: ' + s.name);
            save();
          }
          closeSnipMenu();
        });
        snipMenuEl.appendChild(b);
      });
      document.body.appendChild(snipMenuEl);
    } catch (e) { closeSnipMenu(); }
  }

  /* ---------- SÖZ SAYĞACI ---------- */

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
      counterEl.title = 'Söz / simvol sayı — better z.ai';
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
    counterEl.textContent = C.countWords(t) + ' söz · ' + t.length + ' simvol';
  }

  /* ---------- SƏSLİ BİLDİRİŞ ---------- */

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

  /* ---------- KLAVİATURA QISAYOLLARI ---------- */

  function handleShortcut(action) {
    if (!settings.shortcutsEnabled) return;
    if (action === 'toggle-pause') {
      stats.shortcutActions = (stats.shortcutActions || 0) + 1;
      pushLog('qısayol Alt+P: pauza ' + (paused ? 'dayandırıldı (▶)' : 'aktivləşdirildi (⏸)'));
      setPaused(!paused);
      save();
      return;
    }
    if (action === 'export-chat') {
      stats.shortcutActions = (stats.shortcutActions || 0) + 1;
      pushLog('qısayol Alt+E: cari söhbətin ixracı');
      exportChat();
      save();
      return;
    }
    if (action === 'retry-now') {
      // ən aktual rekord: pill-də göstərilən, yoxsa ən yeni gözləyən/uğursuz
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
        pushLog('qısayol Alt+R: "İndi cəhd et" — ' + C.firstLine(target.promptPreview || '', 40));
        manualRetry(target.id);
      } else {
        flashPillText('Alt+R: gözləyən mesaj yoxdur');
      }
      save();
      return;
    }
  }

  /* ---------- SÖHBƏTİN İXRACI ---------- */

  function currentChatId() {
    var id = '';
    var bestTs = 0;
    Object.keys(records).forEach(function (rid) {
      var r = records[rid];
      if (r && r.chatId && (r.ts || 0) >= bestTs) { bestTs = r.ts || 0; id = r.chatId; }
    });
    if (!id) {
      // URL-dən: chat.z.ai/c/<id>
      var m = /\/c\/([A-Za-z0-9_\-]{4,})/.exec(location.pathname || '');
      if (m) id = m[1];
    }
    return id;
  }

  function exportChat() {
    var cid = currentChatId();
    if (!cid) {
      pushLog('ixrac: söhbət id tapılmadı');
      notify('better z.ai', 'İxrac üçün söhbət tapılmadı — əvvəlcə bu söhbətdə bir mesaj göndərin.');
      return;
    }
    pushLog('ixrac başlayır: ' + cid);
    post({ t: 'EXPORT', chatId: cid });
  }

  function onExported(d) {
    if (!d || !d.ok) {
      pushLog('ixrac alınmadı: ' + ((d && d.why) || 'naməlum'));
      notify('better z.ai', 'Söhbət ixrac oluna bilmədi (' + ((d && d.why) || 'xəta') + ').');
      return;
    }
    var md = MD ? MD.buildMarkdown(d.chat, { url: location.href, date: Date.now() }) : null;
    if (!md) {
      pushLog('ixrac: tarixçə boşdur');
      notify('better z.ai', 'Söhbət tarixçəsi boşdur — ixrac üçün məlumat yoxdur.');
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
      pushLog('ixrac: fayl yüklənmədi (' + e + ')');
    }
    stats.exports = (stats.exports || 0) + 1;
    try { chrome.storage.local.set({ lastExport: { name: name, md: md.slice(0, 5000), at: Date.now() } }); } catch (e) { /* ignore */ }
    pushLog('söhbət ixrac olundu: ' + name);
    save();
    flashPillText('✓ Söhbət ixrac olundu (.md)');
  }

  /* ---------- BÜTÜN SÖHBƏTLƏRİN BACKUP-I ---------- */

  function backupAll() {
    if (backupBusy) { flashPillText('⏳ Backup artıq gedir…'); return; }
    backupBusy = true;
    var max = settings.backupMaxChats || 50;
    pushLog('tam backup başlayır (maks ' + max + ' söhbət)');
    ensurePill();
    if (pillEl) showPill({ id: '__backup' }, '⤓ Backup hazırlanır…', 'busy', false, false);
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
      pushLog('tam backup alınmadı: ' + ((d && d.why) || 'naməlum'));
      notify('better z.ai', 'Tam backup alınmadı (' + ((d && d.why) || 'xəta') + ').');
      refreshPill();
      return;
    }
    var chats = d.chats || [];
    if (!chats.length) {
      pushLog('tam backup: söhbət tapılmadı');
      notify('better z.ai', 'Backup üçün söhbət tapılmadı.');
      refreshPill();
      return;
    }
    // 1) Birləşdirilmiş Markdown (içindekilər + hər söhbət ayrıca bölmə)
    var parts = ['# Z.ai — tam backup', '',
      '> ' + new Date().toLocaleString('az-AZ') + ' · ' + chats.length +
      ' söhbət · better z.ai', '', '## İçindekilər', ''];
    (d.list || []).forEach(function (c, i) {
      parts.push('- ' + (i + 1) + '. ' + (c.title || '(adsız)') + ' (`' + c.id + '`)');
    });
    parts.push('', '---', '');
    chats.forEach(function (chat) {
      var md = MD ? MD.buildMarkdown(chat, { date: Date.now() }) : null;
      if (md) parts.push(md, '', '---', '');
    });
    var mdAll = parts.join('\n');
    // 2) Xam JSON — tam ehtiyat nüsxə (orijinal strukturla)
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
      pushLog('tam backup: fayl yüklənmədi (' + e + ')');
    }
    stats.backups = (stats.backups || 0) + 1;
    try { chrome.storage.local.set({ lastBackup: { at: Date.now(), count: chats.length, list: (d.list || []).slice(0, 50) } }); } catch (e) { /* ignore */ }
    pushLog('tam backup hazır: ' + chats.length + ' söhbət (.md + .json)');
    notify('better z.ai', 'Tam backup hazır ✓ — ' + chats.length + ' söhbət (.md + .json).');
    save();
    flashPillText('✓ Tam backup hazır (' + chats.length + ' söhbət)');
  }

  /* ---------- səhifədən mesajlar ---------- */

  self.addEventListener('message', function (ev) {
    if (ev.source !== self) return;
    var d = ev.data;
    if (!d || d.zai !== 1) return;
    if (d.t === 'CAPTURED' && d.meta) { onCaptured(d.meta); return; }
    if (d.t === 'RESULT') {
      if (PG) { try { PG.noteResult(d); } catch (e) { /* ignore */ } }
      var rec = records[d.id];
      if (!rec) { pushLog('nəticə naməlum qeyd üçün: ' + d.id); return; }
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

  /* ---------- settings / paused dəyişikliyi ---------- */

  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.settings) {
        settings = Object.assign({}, DEFAULTS, ch.settings.newValue || {});
        post({ t: 'INIT', settings: settings });
        pushLog('parametrlər yeniləndi');
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
        lastUserText: r.lastUserText || '',
        chatId: r.chatId, ts: r.ts, lastText: r.lastText || ''
      });
    });
    if (list.length) post({ t: 'HYDRATE', records: list });
  }

  /* kompozitor/draft/fab ev işləri — SPA naviqasiyasını da tutur */
  function housekeeping() {
    try {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        hideDraftBanner();
        pushLog('söhbət dəyişdi: ' + lastPath);
      }
      ensureComposer();
      ensureFab();
      maybeOfferDraft();
      updateCounter(); // söz sayğacı (parametr bağlanırsa gizlənir)
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
      pushLog('content script başladı (C=' + typeof C + ', PC=' + typeof PC +
        ', DRAFTS=' + typeof DRAFTS + ', defaults.maxRetries=' + settings.maxRetries + ')');
      bg({ type: 'alive' });
      refreshPill();
      updatePauseBtn();
      ensureFab();
      updateCounter();
      setTimeout(maybeOfferDraft, 900);
    });
  }

  /* kompozitor input-larını tuturuq (draft + sayğac üçün) */
  try {
    document.addEventListener('input', function (ev) {
      try {
        var el = ensureComposer();
        if (!el) return;
        if (ev.target === el || (el.contains && el.contains(ev.target))) onComposerInput();
      } catch (e) { /* ignore */ }
    }, true);
  } catch (e) { /* ignore */ }

  /* snippet menyunu xarici klik/Escape ilə bağla */
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
  /* qısayollar üçün canlı tab ünvanı 30 s-də bir yenilənir
     (background aliveTab-i yalnız mesajdan bilir) */
  setInterval(function () { bg({ type: 'alive' }); }, 30000);
})();
