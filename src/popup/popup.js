/* better z.ai — popup script (clean: status + quick settings + tools) */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    conn: $('conn'), recList: $('recList'),
    btnOptions: $('btnOptions'),
    btnExport: $('btnExport'), btnBackup: $('btnBackup'), btnPause: $('btnPause'),
    pauseLabel: $('pauseLabel'),
    sBlockPreview: $('sBlockPreview'), sClosePopups: $('sClosePopups'),
    sDraftGuard: $('sDraftGuard'), sSnippets: $('sSnippets')
  };

  var paused = false;
  var saveTimer = null;

  var stateLabels = {
    monitoring: ['Monitoring', ''],
    pending_retry: ['Resending', 'wait'],
    retrying: ['Sending…', 'busy'],
    persisting: ['Saving…', 'busy'],
    await_user: ['No response received', 'warn'],
    failed_fatal: ['Error (no auto-retry)', 'err'],
    failed_final: ['Attempts exhausted', 'err'],
    succeeded: ['✓ Sent', 'ok']
  };

  function attText(list) {
    if (!list || !list.length) return '';
    return '📎 ' + list.length + ' attachments (' + list.map(function (a) { return a.type; }).join(',') + ')';
  }

  function askContent(cb) {
    // no "tabs" permission -> ask the background for the live tab
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
      d.textContent = 'No pending messages — all clear.';
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
      msg.textContent = r.promptPreview || '(empty message)';
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
        b1.textContent = 'Retry now';
        b1.setAttribute('data-act', 'retry');
        b1.setAttribute('data-id', r.id);
        act.appendChild(b1);
        if (r.state === 'failed_fatal' || r.state === 'failed_final' || r.state === 'await_user') {
          var b0 = document.createElement('button');
          b0.textContent = '⧉ Copy text';
          b0.title = 'Copy the full message text to the clipboard';
          b0.setAttribute('data-act', 'copy');
          b0.setAttribute('data-id', r.id);
          act.appendChild(b0);
        }
        var b2 = document.createElement('button');
        b2.textContent = 'Delete';
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
              btn.textContent = '✓ Copied';
              setTimeout(function () { btn.textContent = '⧉ Copy text'; }, 1200);
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

  function recordsFromStorage(got) {
    var recs = (got && got.records) || {};
    return Object.keys(recs).map(function (id) { return recs[id]; })
      .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .map(function (r) {
        return {
          id: r.id, state: r.state, nextAt: r.nextAt || 0,
          promptPreview: r.promptPreview, attachments: r.attachments || [],
          lastUserText: r.lastUserText || '', lastMsg: r.lastMsg || ''
        };
      });
  }

  function updatePauseBtn() {
    els.pauseLabel.textContent = paused ? 'Resume retries' : 'Pause retries';
  }

  function refresh() {
    askContent(function (resp, tab) {
      if (resp && resp.ok) {
        els.conn.textContent = 'z.ai page: active';
        els.conn.className = 'conn ok';
        renderRecords(resp.records);
      } else if (tab) {
        els.conn.textContent = 'page found but not responding — reload it';
        els.conn.className = 'conn err';
        chrome.storage.local.get(['records'], function (got) {
          renderRecords(recordsFromStorage(got));
        });
      } else {
        els.conn.textContent = 'z.ai is not open — open the page to send messages';
        els.conn.className = 'conn err';
        chrome.storage.local.get(['records'], function (got) {
          renderRecords(recordsFromStorage(got));
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
      if (cb) cb();
    });
  }

  /* quick toggles - saved immediately (merged with current settings) */
  function saveQuick() {
    chrome.storage.local.get(['settings'], function (got) {
      var cur = (got && got.settings) || {};
      var merged = Object.assign({}, cur, {
        blockAutoPreview: els.sBlockPreview.checked,
        closePopups: els.sClosePopups.checked,
        draftGuard: els.sDraftGuard.checked,
        snippetsEnabled: els.sSnippets.checked
      });
      chrome.storage.local.set({ settings: merged }, function () { /* ok */ });
    });
  }

  function onQuickChange() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; saveQuick(); }, 200);
  }

  [els.sBlockPreview, els.sClosePopups, els.sDraftGuard, els.sSnippets]
    .forEach(function (el) { el.addEventListener('change', onQuickChange); });

  /* global pause — via storage (the content script reacts instantly) */
  els.btnPause.addEventListener('click', function () {
    paused = !paused;
    chrome.storage.local.set({ paused: paused }, function () {
      updatePauseBtn();
      setTimeout(refresh, 400);
    });
  });

  /* chat export — content script → MAIN world GET → Markdown */
  els.btnExport.addEventListener('click', function () {
    var span = els.btnExport.querySelector('span:not(.dim)');
    var orig = span.textContent;
    span.textContent = '… exporting';
    askContent(function (resp, tab) {
      if (!tab) {
        span.textContent = '✘ page not found';
        setTimeout(function () { span.textContent = orig; }, 1500);
        return;
      }
      try {
        chrome.tabs.sendMessage(tab.id, { cmd: 'EXPORT_CHAT' }, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
          setTimeout(function () {
            span.textContent = '✓ Exported';
            setTimeout(function () { span.textContent = orig; }, 1500);
            refresh();
          }, 900);
        });
      } catch (e) { span.textContent = orig; }
    });
  });

  /* FULL chat backup — content script → MAIN world
     (chat list + details) → .md + .json files are downloaded */
  els.btnBackup.addEventListener('click', function () {
    var span = els.btnBackup.querySelector('span:not(.dim)');
    var orig = span.textContent;
    span.textContent = '… backing up';
    els.btnBackup.disabled = true;
    askContent(function (resp, tab) {
      if (!tab) {
        span.textContent = '✘ page not found';
        els.btnBackup.disabled = false;
        setTimeout(function () { span.textContent = orig; }, 1800);
        return;
      }
      var t0 = Date.now();
      try {
        chrome.tabs.sendMessage(tab.id, { cmd: 'EXPORT_ALL' }, function () {
          if (chrome.runtime.lastError) { /* a reply may not come — we watch via storage */ }
        });
      } catch (e) { /* ignore */ }
      var iv = setInterval(function () {
        chrome.storage.local.get(['lastBackup'], function (g) {
          var lb = g && g.lastBackup;
          if (lb && lb.at > t0 - 2000) {
            clearInterval(iv);
            span.textContent = '✓ ' + (lb.count || 0) + ' chats backed up';
            els.btnBackup.disabled = false;
            setTimeout(function () { span.textContent = orig; }, 2600);
          } else if (Date.now() - t0 > 120000) {
            clearInterval(iv);
            span.textContent = '✘ timed out';
            els.btnBackup.disabled = false;
            setTimeout(function () { span.textContent = orig; }, 2200);
          }
        });
      }, 700);
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

  /* watch pause changes live */
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.paused) { paused = !!ch.paused.newValue; updatePauseBtn(); }
    });
  } catch (e) { /* ignore */ }

  loadSettings(refresh);
  setInterval(refresh, 1000);
})();
