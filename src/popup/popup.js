/* Z.ai Auto-Resend — popup skripti */
(function () {
  'use strict';

  var ZAI_TABS = ['https://chat.z.ai/*', 'http://localhost:8907/*'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    conn: $('conn'), recList: $('recList'), logBox: $('logBox'),
    btnSave: $('btnSave'), btnClearLog: $('btnClearLog'),
    sMaxRetries: $('sMaxRetries'), sInitialDelay: $('sInitialDelay'),
    sFactor: $('sFactor'), sMaxDelay: $('sMaxDelay'),
    sResign: $('sResign'), sPersist: $('sPersist'), sAutoReload: $('sAutoReload'),
    sNotify: $('sNotify'), sDomFallback: $('sDomFallback')
  };

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
        var b2 = document.createElement('button');
        b2.textContent = 'Sil';
        b2.setAttribute('data-act', 'del');
        b2.setAttribute('data-id', r.id);
        act.appendChild(b1);
        act.appendChild(b2);
        card.appendChild(act);
      }
      box.appendChild(card);
    });
    Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var act = btn.getAttribute('data-act');
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
              lastMsg: r.lastMsg || ''
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
              lastMsg: r.lastMsg || ''
            };
          }));
          els.logBox.textContent = ((got && got.log) || []).join('\n') || '(jurnal boşdur)';
        });
      }
    });
  }

  function loadSettings(cb) {
    chrome.storage.local.get(['settings'], function (got) {
      var s = (got && got.settings) || {};
      els.sMaxRetries.value = s.maxRetries != null ? s.maxRetries : 6;
      els.sInitialDelay.value = s.initialDelayMs != null ? s.initialDelayMs : 5000;
      els.sFactor.value = s.backoffFactor != null ? s.backoffFactor : 2;
      els.sMaxDelay.value = s.maxDelayMs != null ? s.maxDelayMs : 120000;
      els.sResign.checked = s.resign !== false;
      els.sPersist.checked = s.persistAfterRetry !== false;
      els.sAutoReload.checked = s.autoReload !== false;
      els.sNotify.checked = s.notify !== false;
      els.sDomFallback.checked = !!s.domFallback;
      if (cb) cb();
    });
  }

  els.btnSave.addEventListener('click', function () {
    var s = {
      maxRetries: Math.max(1, Math.min(30, Number(els.sMaxRetries.value) || 6)),
      initialDelayMs: Math.max(300, Number(els.sInitialDelay.value) || 5000),
      backoffFactor: Math.max(1, Number(els.sFactor.value) || 2),
      maxDelayMs: Math.max(1000, Number(els.sMaxDelay.value) || 120000),
      resign: els.sResign.checked,
      persistAfterRetry: els.sPersist.checked,
      autoReload: els.sAutoReload.checked,
      notify: els.sNotify.checked,
      domFallback: els.sDomFallback.checked
    };
    chrome.storage.local.set({ settings: s }, function () {
      els.btnSave.textContent = '✓ Yadda saxlandı';
      setTimeout(function () { els.btnSave.textContent = 'Yadda saxla'; }, 1200);
      refresh();
    });
  });

  els.btnClearLog.addEventListener('click', function () {
    chrome.storage.local.set({ log: [] }, function () {
      els.logBox.textContent = '(təmizləndi)';
    });
  });

  loadSettings(refresh);
  setInterval(refresh, 1000);
})();
