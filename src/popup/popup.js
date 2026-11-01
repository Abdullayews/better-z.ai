/* Z.ai Auto-Resend — popup skripti */
(function () {
  'use strict';

  var ZAI_TABS = ['https://chat.z.ai/*', 'http://localhost:8907/*'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    conn: $('conn'), recList: $('recList'), logBox: $('logBox'),
    btnSave: $('btnSave'), btnClearLog: $('btnClearLog'), btnOptions: $('btnOptions'),
    btnExport: $('btnExport'), btnPause: $('btnPause'), statsLine: $('statsLine'),
    sBlockPreview: $('sBlockPreview'), sClosePopups: $('sClosePopups'),
    sDraftGuard: $('sDraftGuard'), sSnippets: $('sSnippets'),
    sMaxRetries: $('sMaxRetries'), sInitialDelay: $('sInitialDelay'),
    sFactor: $('sFactor'), sMaxDelay: $('sMaxDelay'),
    sResign: $('sResign'), sPersist: $('sPersist'), sAutoReload: $('sAutoReload'),
    sNotify: $('sNotify'), sNotifyDone: $('sNotifyDone'),
    sSerial: $('sSerial'), sDupGuard: $('sDupGuard'), sDomFallback: $('sDomFallback')
  };

  var paused = false;

  var stateLabels = {
    monitoring: ['Gözlənilir', ''],
    pending_retry: ['Yenidən göndərilir', 'wait'],
    retrying: ['Göndərilir…', 'busy'],
    persisting: ['Yazılır…', 'busy'],
    await_user: ['Cavab alınmadı', 'warn'],
    failed_fatal: ['Xəta (avto yoxdur)', 'err'],
    failed_final: ['Cəhdlər bitdi', 'err'],
    succeeded: ['✓ Göndərildi', 'ok']
  };

  function attText(list) {
    if (!list || !list.length) return '';
    var n = list.length;
    var kinds = list.map(function (a) { return a.type; }).join(',');
    return '📎 ' + n + ' əlavə (' + kinds + ')';
  }

  function findZaiTab(cb) {
    chrome.tabs.query({ url: ZAI_TABS }, function (tabs) {
      if (!tabs || !tabs.length) return cb(null);
      tabs.sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); });
      cb(tabs[0]);
    });
  }

  function askContent(cb) {
    // "tabs" permission-u yoxdur → canlı tab-i background-dan soruşuruq
    try {
      chrome.runtime.sendMessage({ type: 'GET_TAB' }, function (r) {
        var tab = r && r.tab;
        if (!tab) return cb(null, null);
        try {
          chrome.tabs.sendMessage(tab.id, { cmd: 'GET_STATE' }, function (resp) {
            if (chrome.runtime.lastError) return cb(null, { id: tab.id });
            cb(resp || null, { id: tab.id });
          });
        } catch (e) { cb(null, { id: tab.id }); }
      });
    } catch (e) { cb(null, null); }
  }

  function renderRecords(list) {
    var box = els.recList;
    box.textContent = '';
    if (!list || !list.length) {
      var d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'Gözləyən mesaj yoxdur — hər şey qaydasındadır.';
      box.appendChild(d);
      return;
    }
    list.forEach(function (r) {
      var lb = stateLabels[r.state] || [r.state, ''];
      var left = (r.state === 'pending_retry' && r.nextAt)
        ? ' · ' + Math.max(0, Math.ceil((r.nextAt - Date.now()) / 1000)) + 's' : '';

      var card = document.createElement('div');
      card.className = 'rec';
      var row1 = document.createElement('div');
      row1.className = 'row1';
      var badge = document.createElement('span');
      badge.className = 'badge ' + lb[1];
      badge.textContent = lb[0] + left;
      var msg = document.createElement('span');
      msg.className = 'msg';
      msg.title = r.lastMsg || '';
      msg.textContent = r.promptPreview || '(boş mesaj)';
      row1.appendChild(badge);
      row1.appendChild(msg);
      card.appendChild(row1);

      var att = document.createElement('div');
      att.className = 'att';
      att.textContent = attText(r.attachments) + (r.lastMsg ? ' · ' + String(r.lastMsg).slice(0, 60) : '');
      card.appendChild(att);

      if (r.state !== 'succeeded' && r.state !== 'monitoring') {
        var act = document.createElement('div');
        act.className = 'act';
        var b1 = document.createElement('button');
        b1.className = 'primary';
        b1.textContent = 'İndi cəhd et';
        b1.setAttribute('data-act', 'retry');
        b1.setAttribute('data-id', r.id);
        act.appendChild(b1);
        // v1.2.0: uğursuz mesajın TAM mətnini kopyala
        if (r.state === 'failed_fatal' || r.state === 'failed_final' || r.state === 'await_user') {
          var b0 = document.createElement('button');
          b0.textContent = '⧉ Mətni kopyala';
          b0.title = 'Mesajın tam mətnini mübadilə buferinə köçür';
          b0.setAttribute('data-act', 'copy');
          b0.setAttribute('data-id', r.id);
          act.appendChild(b0);
        }
        var b2 = document.createElement('button');
        b2.textContent = 'Sil';
        b2.setAttribute('data-act', 'del');
        b2.setAttribute('data-id', r.id);
        act.appendChild(b2);
        card.appendChild(act);
      }
      box.appendChild(card);
    });
    Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var act = btn.getAttribute('data-act');
        if (act === 'copy') {
          var item = list.find(function (x) { return x.id === id; }) || {};
          var txt = item.lastUserText || item.promptPreview || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function () {
              btn.textContent = '✓ Kopyalandı';
              setTimeout(function () { btn.textContent = '⧉ Mətni kopyala'; }, 1200);
            }, function () { /* ignore */ });
          }
          return;
        }
        askContent(function (resp, tab) {
          if (!tab) return;
          if (act === 'retry') {
            chrome.tabs.sendMessage(tab.id, { cmd: 'RETRY_NOW', id: id }, function () {
              if (chrome.runtime.lastError) { /* ignore */ }
              refresh();
            });
          } else {
            chrome.tabs.sendMessage(tab.id, { cmd: 'DELETE', id: id }, function () {
              if (chrome.runtime.lastError) { /* ignore */ }
              refresh();
            });
          }
        });
      });
    });
  }

  function updatePauseBtn() {
    els.btnPause.textContent = paused ? '▶ Retry-ləri davam etdir' : '⏸ Retry-ləri dayandır';
  }

  function updateStats() {
    try {
      chrome.storage.local.get(['stats'], function (got) {
        var st = (got && got.stats) || {};
        els.statsLine.textContent =
          '🔁 xilas: ' + (st.retryOk || 0) +
          ' · 🛡️ dublikat önlənən: ' + (st.dupAvoided || 0) +
          ' · 🔒 preview: ' + (st.previewBlocked || 0) +
          ' · 🚪 popap: ' + (st.popupsClosed || 0) +
          ' · 📝 qaralama: ' + (st.draftsRestored || 0) +
          ' · ⚡ snippet: ' + (st.snippetsInserted || 0) +
          ' · ⤓ ixrac: ' + (st.exports || 0);
      });
    } catch (e) { /* ignore */ }
  }

  function refresh() {
    askContent(function (resp, tab) {
      if (resp && resp.ok) {
        els.conn.textContent = '● chat.z.ai səhifəsi: aktiv';
        els.conn.className = 'ok';
        renderRecords(resp.records);
        els.logBox.textContent = (resp.log || []).join('\n') || '(jurnal boşdur)';
      } else if (tab) {
        els.conn.textContent = '● səhifə tapıldı, amma content script cavab vermir — yeniləyin';
        els.conn.className = 'err';
        // storage-dan son vəziyyəti göstər
        chrome.storage.local.get(['records', 'log'], function (got) {
          var recs = (got && got.records) || {};
          var list = Object.keys(recs).map(function (id) { return recs[id]; })
            .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
          renderRecords(list.map(function (r) {
            return {
              id: r.id, state: r.state, nextAt: r.nextAt || 0,
              promptPreview: r.promptPreview, attachments: r.attachments || [],
              lastUserText: r.lastUserText || '', lastMsg: r.lastMsg || ''
            };
          }));
          els.logBox.textContent = ((got && got.log) || []).join('\n') || '(jurnal boşdur)';
        });
      } else {
        els.conn.textContent = '● chat.z.ai açıq deyil — mesaj göndərmək üçün səhifəni açın';
        els.conn.className = 'err';
        chrome.storage.local.get(['records', 'log'], function (got) {
          var recs = (got && got.records) || {};
          var list = Object.keys(recs).map(function (id) { return recs[id]; })
            .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
          renderRecords(list.map(function (r) {
            return {
              id: r.id, state: r.state, nextAt: r.nextAt || 0,
              promptPreview: r.promptPreview, attachments: r.attachments || [],
              lastUserText: r.lastUserText || '', lastMsg: r.lastMsg || ''
            };
          }));
          els.logBox.textContent = ((got && got.log) || []).join('\n') || '(jurnal boşdur)';
        });
      }
    });
  }

  function loadSettings(cb) {
    chrome.storage.local.get(['settings', 'paused'], function (got) {
      var s = (got && got.settings) || {};
      paused = !!(got && got.paused);
      updatePauseBtn();
      els.sBlockPreview.checked = s.blockAutoPreview !== false;
      els.sClosePopups.checked = s.closePopups !== false;
      els.sDraftGuard.checked = s.draftGuard !== false;
      els.sSnippets.checked = s.snippetsEnabled !== false;
      els.sMaxRetries.value = s.maxRetries != null ? s.maxRetries : 6;
      els.sInitialDelay.value = s.initialDelayMs != null ? s.initialDelayMs : 5000;
      els.sFactor.value = s.backoffFactor != null ? s.backoffFactor : 2;
      els.sMaxDelay.value = s.maxDelayMs != null ? s.maxDelayMs : 120000;
      els.sResign.checked = s.resign !== false;
      els.sPersist.checked = s.persistAfterRetry !== false;
      els.sAutoReload.checked = s.autoReload !== false;
      els.sNotify.checked = s.notify !== false;
      els.sNotifyDone.checked = s.notifyDone !== false;
      els.sSerial.checked = s.serialRetries !== false;
      els.sDupGuard.checked = s.dupGuard !== false;
      els.sDomFallback.checked = !!s.domFallback;
      if (cb) cb();
    });
  }

  els.btnSave.addEventListener('click', function () {
    /* mövcud settings ilə birləşdir — formada olmayan açarlar itmasın */
    chrome.storage.local.get(['settings'], function (got) {
      var cur = (got && got.settings) || {};
      var s = Object.assign({}, cur, {
        blockAutoPreview: els.sBlockPreview.checked,
        closePopups: els.sClosePopups.checked,
        draftGuard: els.sDraftGuard.checked,
        snippetsEnabled: els.sSnippets.checked,
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
        domFallback: els.sDomFallback.checked
      });
      chrome.storage.local.set({ settings: s }, function () {
        els.btnSave.textContent = '✓ Yadda saxlandı';
        setTimeout(function () { els.btnSave.textContent = 'Yadda saxla'; }, 1200);
        refresh();
      });
    });
  });

  /* v1.2.0: qlobal pauza — storage üzərindən (content script dərhal reaksiya verir) */
  els.btnPause.addEventListener('click', function () {
    paused = !paused;
    chrome.storage.local.set({ paused: paused }, function () {
      updatePauseBtn();
      setTimeout(refresh, 400);
    });
  });

  /* v1.2.0: söhbətin ixracı — content script → MAIN world GET → Markdown */
  els.btnExport.addEventListener('click', function () {
    els.btnExport.textContent = '… ixrac olunur';
    askContent(function (resp, tab) {
      if (!tab) {
        els.btnExport.textContent = '✘ səhifə tapılmadı';
        setTimeout(function () { els.btnExport.textContent = '⤓ Söhbəti ixrac et (.md)'; }, 1500);
        return;
      }
      try {
        chrome.tabs.sendMessage(tab.id, { cmd: 'EXPORT_CHAT' }, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
          setTimeout(function () {
            els.btnExport.textContent = '✓ İxrac olundu';
            setTimeout(function () { els.btnExport.textContent = '⤓ Söhbəti ixrac et (.md)'; }, 1500);
            refresh();
          }, 900);
        });
      } catch (e) {
        els.btnExport.textContent = '⤓ Söhbəti ixrac et (.md)';
      }
    });
  });

  els.btnOptions.addEventListener('click', function () {
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL('options/options.html'));
    } catch (e) {
      try { window.open(chrome.runtime.getURL('options/options.html')); } catch (e2) { /* ignore */ }
    }
  });

  els.btnClearLog.addEventListener('click', function () {
    chrome.storage.local.set({ log: [] }, function () {
      els.logBox.textContent = '(təmizləndi)';
    });
  });

  /* pauza və statistika dəyişikliklərini canlı izlə */
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.paused) { paused = !!ch.paused.newValue; updatePauseBtn(); }
    });
  } catch (e) { /* ignore */ }

  loadSettings(refresh);
  updateStats();
  setInterval(refresh, 1000);
  setInterval(updateStats, 2000);
})();
