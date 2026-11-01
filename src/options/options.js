/* better z.ai — Ayarlar səhifəsi (options.js).
   Dəyişikliklər avtomatik yadda saxlanılır (debounce) və mövcud parametrlərlə
   BİRLƏŞDİRİLİR — formada olmayan açarlar (jitter, retryOnHttpError, …) itmir. */
(function () {
  'use strict';

  var DEFAULTS = self.__zaiExtDefaults || {};
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    sBlockPreview: $('sBlockPreview'),
    sDraftGuard: $('sDraftGuard'), sDraftMaxAge: $('sDraftMaxAge'),
    sSnippets: $('sSnippets'), snipList: $('snipList'), btnAddSnippet: $('btnAddSnippet'),
    sMaxRetries: $('sMaxRetries'), sInitialDelay: $('sInitialDelay'),
    sFactor: $('sFactor'), sMaxDelay: $('sMaxDelay'),
    sResign: $('sResign'), sPersist: $('sPersist'), sAutoReload: $('sAutoReload'),
    sNotify: $('sNotify'), sNotifyDone: $('sNotifyDone'),
    sSerial: $('sSerial'), sDupGuard: $('sDupGuard'), sDomFallback: $('sDomFallback'),
    sClosePopups: $('sClosePopups'), sPopupPatterns: $('sPopupPatterns'),
    sAdaptive: $('sAdaptive'), sNotifySound: $('sNotifySound'),
    sWordCounter: $('sWordCounter'), sBackupMaxChats: $('sBackupMaxChats'),
    sShortcuts: $('sShortcuts'),
    btnExportCfg: $('btnExportCfg'), fileImportCfg: $('fileImportCfg'), impNote: $('impNote'),
    btnDiag: $('btnDiag'),
    btnReset: $('btnReset'), savedNote: $('savedNote')
  };

  var saveTimer = null;
  var suppressSave = false;

  function flashSaved() {
    els.savedNote.style.opacity = '1';
    setTimeout(function () { els.savedNote.style.opacity = '0'; }, 1500);
  }

  /* ---------- snippet CRUD ---------- */

  function makeSnipRow(name, text) {
    var row = document.createElement('div');
    row.className = 'snip-row';
    row.innerHTML =
      '<input class="snip-name" type="text" placeholder="Ad (məs: Qısa cavab)" maxlength="60">' +
      '<textarea class="snip-text" rows="2" placeholder="Mətn — kompozitora yerləşəcək"></textarea>' +
      '<button class="snip-del" type="button" title="Sil">✕</button>';
    row.querySelector('.snip-name').value = name || '';
    row.querySelector('.snip-text').value = text || '';
    row.querySelector('.snip-del').addEventListener('click', function () {
      row.remove();
      onChange();
    });
    return row;
  }

  function renderSnippets(list) {
    els.snipList.textContent = '';
    (list || []).forEach(function (s) {
      els.snipList.appendChild(makeSnipRow(s.name || '', s.text || ''));
    });
  }

  function readSnippets() {
    var out = [];
    Array.prototype.forEach.call(els.snipList.querySelectorAll('.snip-row'), function (row) {
      var name = (row.querySelector('.snip-name') || {}).value || '';
      var text = (row.querySelector('.snip-text') || {}).value || '';
      name = name.trim();
      if (name && text.trim()) out.push({ name: name, text: text });
    });
    return out.slice(0, 50);
  }

  /* ---------- form ↔ storage ---------- */

  function fillForm(s) {
    s = s || {};
    var d = DEFAULTS;
    els.sBlockPreview.checked = s.blockAutoPreview !== undefined ? !!s.blockAutoPreview : (d.blockAutoPreview !== false);
    els.sDraftGuard.checked = s.draftGuard !== undefined ? !!s.draftGuard : (d.draftGuard !== false);
    els.sDraftMaxAge.value = s.draftMaxAgeH != null ? s.draftMaxAgeH : (d.draftMaxAgeH || 72);
    els.sSnippets.checked = s.snippetsEnabled !== undefined ? !!s.snippetsEnabled : (d.snippetsEnabled !== false);
    els.sMaxRetries.value = s.maxRetries != null ? s.maxRetries : (d.maxRetries || 6);
    els.sInitialDelay.value = s.initialDelayMs != null ? s.initialDelayMs : (d.initialDelayMs || 5000);
    els.sFactor.value = s.backoffFactor != null ? s.backoffFactor : (d.backoffFactor || 2);
    els.sMaxDelay.value = s.maxDelayMs != null ? s.maxDelayMs : (d.maxDelayMs || 120000);
    els.sResign.checked = s.resign !== false;
    els.sPersist.checked = s.persistAfterRetry !== false;
    els.sAutoReload.checked = s.autoReload !== false;
    els.sNotify.checked = s.notify !== false;
    els.sNotifyDone.checked = s.notifyDone !== false;
    els.sSerial.checked = s.serialRetries !== false;
    els.sDupGuard.checked = s.dupGuard !== false;
    els.sDomFallback.checked = !!s.domFallback;
    els.sAdaptive.checked = s.adaptiveBackoff !== false;
    els.sNotifySound.checked = !!s.notifySound;
    els.sWordCounter.checked = s.wordCounter !== false;
    els.sBackupMaxChats.value = s.backupMaxChats != null ? s.backupMaxChats : (d.backupMaxChats || 50);
    els.sShortcuts.checked = s.shortcutsEnabled !== false;
    els.sClosePopups.checked = s.closePopups !== false;
    els.sPopupPatterns.value = Array.isArray(s.popupPatterns)
      ? s.popupPatterns.join('\n')
      : (Array.isArray(d.popupPatterns) ? d.popupPatterns.join('\n') : '');
    renderSnippets(Array.isArray(s.snippets) ? s.snippets : (d.snippets || []));
  }

  function readForm() {
    return {
      blockAutoPreview: els.sBlockPreview.checked,
      draftGuard: els.sDraftGuard.checked,
      draftMaxAgeH: Math.max(1, Math.min(720, Number(els.sDraftMaxAge.value) || 72)),
      snippetsEnabled: els.sSnippets.checked,
      snippets: readSnippets(),
      maxRetries: Math.max(1, Math.min(30, Number(els.sMaxRetries.value) || 6)),
      initialDelayMs: Math.max(300, Number(els.sInitialDelay.value) || 5000),
      backoffFactor: Math.max(1, Number(els.sFactor.value) || 2),
      maxDelayMs: Math.max(1000, Number(els.sMaxDelay.value) || 120000),
      resign: els.sResign.checked,
      persistAfterRetry: els.sPersist.checked,
      autoReload: els.sAutoReload.checked,
      notify: els.sNotify.checked,
      notifyDone: els.sNotifyDone.checked,
      serialRetries: els.sSerial.checked,
      dupGuard: els.sDupGuard.checked,
      domFallback: els.sDomFallback.checked,
      adaptiveBackoff: els.sAdaptive.checked,
      notifySound: els.sNotifySound.checked,
      wordCounter: els.sWordCounter.checked,
      backupMaxChats: Math.max(1, Math.min(300, Number(els.sBackupMaxChats.value) || 50)),
      shortcutsEnabled: els.sShortcuts.checked,
      closePopups: els.sClosePopups.checked,
      popupPatterns: els.sPopupPatterns.value.split('\n')
        .map(function (x) { return x.trim(); })
        .filter(Boolean)
        .slice(0, 50)
    };
  }

  /* formada olmayan açarları qorumaq üçün mövcud settings ilə birləşdiririk */
  function save() {
    chrome.storage.local.get(['settings'], function (got) {
      var cur = (got && got.settings) || {};
      var merged = Object.assign({}, DEFAULTS, cur, readForm());
      chrome.storage.local.set({ settings: merged }, function () {
        if (!chrome.runtime.lastError) flashSaved();
      });
    });
  }

  function onChange() {
    if (suppressSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; save(); }, 350);
  }

  [els.sBlockPreview, els.sDraftGuard, els.sDraftMaxAge, els.sSnippets,
   els.sMaxRetries, els.sInitialDelay, els.sFactor, els.sMaxDelay,
   els.sResign, els.sPersist, els.sAutoReload, els.sNotify, els.sNotifyDone,
   els.sSerial, els.sDupGuard, els.sDomFallback,
   els.sClosePopups, els.sPopupPatterns,
   els.sAdaptive, els.sNotifySound, els.sWordCounter, els.sBackupMaxChats, els.sShortcuts]
    .forEach(function (el) {
      el.addEventListener('change', onChange);
      el.addEventListener('input', onChange);
    });

  /* snippet sətirləri — delegasiya ilə */
  els.snipList.addEventListener('input', onChange);
  els.snipList.addEventListener('change', onChange);

  els.btnAddSnippet.addEventListener('click', function () {
    els.snipList.appendChild(makeSnipRow('', ''));
    els.snipList.lastChild.querySelector('.snip-name').focus();
    onChange();
  });

  /* ---------- ayarların ixracı / idxalı ---------- */

  els.btnExportCfg.addEventListener('click', function () {
    chrome.storage.local.get(['settings'], function (got) {
      var cur = (got && got.settings) || {};
      var merged = Object.assign({}, DEFAULTS, cur);
      var blob = new Blob([JSON.stringify({ betterZaiSettings: true, settings: merged }, null, 2)],
        { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'better-zai-ayarlar-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { /* ignore */ }
      }, 3000);
    });
  });

  els.fileImportCfg.addEventListener('change', function () {
    var f = els.fileImportCfg.files && els.fileImportCfg.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(String(rd.result || ''));
        var s = (j && j.settings && typeof j.settings === 'object')
          ? j.settings
          : (j && typeof j === 'object' && !Array.isArray(j) ? j : null);
        if (!s) throw new Error('format');
        var merged = Object.assign({}, DEFAULTS, s);
        chrome.storage.local.set({ settings: merged }, function () {
          suppressSave = true;
          fillForm(merged);
          suppressSave = false;
          flashSaved();
          els.impNote.textContent = '✓ İdxal olundu';
          setTimeout(function () { els.impNote.textContent = ''; }, 2000);
        });
      } catch (e) {
        els.impNote.textContent = '✘ Fayl oxunmadı — düzgün JSON deyil';
        setTimeout(function () { els.impNote.textContent = ''; }, 2500);
      }
    };
    rd.readAsText(f);
    els.fileImportCfg.value = '';
  });

  /* ---------- diaqnostika (xəta hesabatı üçün) ---------- */

  els.btnDiag.addEventListener('click', function () {
    chrome.storage.local.get(['settings', 'stats', 'records', 'log', 'paused', 'lastExport', 'lastBackup'], function (got) {
      var records = (got && got.records) || {};
      var byState = {};
      Object.keys(records).forEach(function (id) {
        var st = (records[id] && records[id].state) || '?';
        byState[st] = (byState[st] || 0) + 1;
      });
      var diag = {
        betterZaiDiag: true,
        generatedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        paused: !!(got && got.paused),
        settings: (got && got.settings) || {},
        stats: (got && got.stats) || {},
        recordsSummary: { total: Object.keys(records).length, byState: byState },
        lastExport: (got && got.lastExport) || null,
        lastBackup: (got && got.lastBackup) || null,
        logTail: ((got && got.log) || []).slice(-40)
      };
      var blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'better-zai-diaqnostika-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { /* ignore */ }
      }, 3000);
    });
  });

  /* ---------- reset + başlanğıc ---------- */

  els.btnReset.addEventListener('click', function () {
    suppressSave = true;
    fillForm({});
    suppressSave = false;
    chrome.storage.local.get(['settings'], function (got) {
      var cur = (got && got.settings) || {};
      var merged = Object.assign({}, DEFAULTS, cur, readForm());
      chrome.storage.local.set({ settings: merged }, flashSaved);
    });
  });

  chrome.storage.local.get(['settings'], function (got) {
    fillForm((got && got.settings) || {});
  });
})();
