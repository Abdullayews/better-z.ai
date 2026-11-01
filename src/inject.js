/*
 * Z.ai Auto-Resend — MAIN world inyeksiyası (səhifə konteksti).
 *
 * Vəzifələri:
 *   1. fetch/XHR yolasıyla z.ai completion sorğularını TUTMAQ (POST /api/v2/chat/completions)
 *   2. SSE axınını təhlil edib nəticəni təsnifatlaşdırmaq (content script-ə bildirir)
 *   3. Retry zamanı eyni sorğunu (lazımsa YENİ İMZA ilə) yenidən göndərmək
 *   4. Uğurlu retry-dan sonra /api/v1/chats/{id} persist POST-unu etmək (§7 forması)
 *
 * DİQQƏT: capture SINXRONDUR — fetch promise-i tətbiqə qaytarılmazdan əvvəl
// bizim monitor handler-imiz artıq taxılıb (clone() yarışı yoxdur).
 */
(function () {
  'use strict';
  if (self.__zaiExtInject) return;
  self.__zaiExtInject = true; // E2E/diaqnostika işarəsi (window.__zaiExtInject)

  var C = self.__zaiExtCore;
  var ofetch = self.fetch;
  var recs = new Map();
  var settings = { retryOnHttpError: true };
  var seq = 0;

  var COMPLETION_RE = /^\/api\/(?:v2\/chat|v1\/chat|chat)\/completions$/;

  function POST(msg) {
    msg.zai = 1;
    try { self.postMessage(msg, self.location.origin); } catch (e) { /* ignore */ }
  }

  function uid() {
    return 'zext-' + Date.now().toString(36) + '-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function isCompletionPath(u) {
    try { return COMPLETION_RE.test(new URL(u, self.location.href).pathname); } catch (e) { return false; }
  }

  /* SIRAQLI [[k,v]] — URLSearchParams girişin sırasını qoruyur */
  function parseOrderedQuery(search) {
    var out = [];
    try {
      var sp = new URLSearchParams(search);
      sp.forEach(function (v, k) { out.push([k, v]); });
    } catch (e) { /* ignore */ }
    return out;
  }

  function qGet(entries, key) {
    for (var i = 0; i < entries.length; i++) if (entries[i][0] === key) return entries[i][1];
    return null;
  }

  function headersToDict(h) {
    var d = {};
    try {
      if (!h) return d;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { d[k.toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(function (kv) { d[String(kv[0]).toLowerCase()] = String(kv[1]); });
      } else if (typeof h === 'object') {
        Object.keys(h).forEach(function (k) { d[k.toLowerCase()] = String(h[k]); });
      }
    } catch (e) { /* ignore */ }
    return d;
  }

  /* ---------- SSE hadisə emalı (stream scanner və XHR üçün ortaq) ---------- */

  function makeEventState() {
    var st = {
      sawContent: false, gotDone: false, hadLines: false,
      errEvents: [], text: '', currentData: [], pending: false
    };
    st.handleLine = function (line) {
      line = String(line).replace(/\r$/, '');
      if (line.indexOf('data:') === 0) { st.currentData.push(line.slice(5).trim()); return; }
      if (line === '') st.flush();
    };
    st.flush = function () {
      if (!st.currentData.length) return;
      var payload = st.currentData.join('\n');
      st.currentData = [];
      st.handlePayload(payload);
    };
    st.handlePayload = function (p) {
      st.hadLines = true;
      if (p === '[DONE]') { st.gotDone = true; return; }
      var j = null;
      try { j = JSON.parse(p); } catch (e) { j = null; }
      if (j) {
        var err = C.extractError(j);
        if (err) st.errEvents.push(C.errText(err) || 'stream error');
        var m = C.extractMessage(j);
        if (m) {
          if (m.error) st.errEvents.push(C.errText(m.error) || 'stream error');
          if (typeof m.delta_content === 'string' && m.delta_content.length) {
            st.sawContent = true;
            if (st.text.length < 200000) st.text += m.delta_content;
          }
          if (m.done === true) st.gotDone = true;
        }
        return;
      }
      // parçalı (multi-line) hadisə — LEGACY_SPEC §5 pending birləşdirməsi
      if (st.pending) {
        try {
          var joined = JSON.parse(st.pending + '\n' + p);
          st.pending = false;
          var err2 = C.extractError(joined);
          if (err2) st.errEvents.push(C.errText(err2) || 'stream error');
          var m2 = C.extractMessage(joined);
          if (m2 && typeof m2.delta_content === 'string' && m2.delta_content.length) st.sawContent = true;
          if (m2 && m2.done === true) st.gotDone = true;
          return;
        } catch (e) { st.pending = false; }
      }
      if (/"delta_content"\s*:\s*"/.test(p)) st.sawContent = true;
      if (/^\s*\{/.test(p)) st.pending = p;
    };
    return st;
  }

  function finalizeState(st) {
    st.flush();
    return {
      ended: true, sawContent: st.sawContent, gotDone: st.gotDone,
      hadLines: st.hadLines, errText: st.errEvents.join('; '), text: st.text
    };
  }

  /* Axın (reader) skanerı — watchdog 150s (LEGACY_SPEC §5 idle qaydası) */
  async function scanBodyStream(body, watchdogMs) {
    var st = makeEventState();
    var dec = new TextDecoder();
    var reader = body.getReader();
    var watchdogFired = false;
    if (!watchdogMs || watchdogMs < 1000) watchdogMs = 150000;
    var watchdog = null;
    var arm = function () {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        watchdogFired = true;
        try { reader.cancel(); } catch (e) { /* ignore */ }
      }, watchdogMs);
    };
    arm();
    var buf = '';
    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        arm();
        buf += dec.decode(r.value, { stream: true });
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          st.handleLine(line);
        }
        if (buf.length > 262144) buf = buf.slice(-4096); // yaddaş qoruması
      }
      if (buf) st.handleLine(buf);
    } catch (e) {
      if (watchdog) clearTimeout(watchdog);
      st.flush();
      return {
        ended: false, sawContent: st.sawContent, gotDone: st.gotDone,
        hadLines: st.hadLines, errText: st.errEvents.join('; '), text: st.text
      };
    }
    if (watchdog) clearTimeout(watchdog);
    var res = finalizeState(st);
    if (watchdogFired) res.ended = false;
    return res;
  }

  /* Tam mətn (XHR responseText) skanerı */
  function scanFullText(text) {
    var st = makeEventState();
    String(text || '').split('\n').forEach(function (line) { st.handleLine(line); });
    return finalizeState(st);
  }

  function parseRetryAfter(h) {
    if (!h) return null;
    var t = String(h).trim();
    var n = Number(t);
    if (n > 0) return Math.round(n * 1000);
    var d = Date.parse(t);
    if (!isNaN(d)) return Math.max(0, d - Date.now());
    return null;
  }

  /* ---------- Capture (SİNXRON) ---------- */

  function summarizeBody(bodyJson) {
    var meta = { promptPreview: '', attachments: [], lastUserText: '' };
    try {
      if (bodyJson && typeof bodyJson.signature_prompt === 'string') {
        meta.promptPreview = C.firstLine(bodyJson.signature_prompt, 120);
      }
      var msgs = bodyJson && Array.isArray(bodyJson.messages) ? bodyJson.messages : [];
      var last = msgs[msgs.length - 1];
      if (last) {
        if (typeof last.content === 'string') {
          if (!meta.promptPreview) meta.promptPreview = C.firstLine(last.content, 120);
          meta.lastUserText = last.content;
        } else if (Array.isArray(last.content)) {
          var texts = [];
          last.content.forEach(function (part) {
            if (part && part.type === 'text') {
              texts.push(part.text || '');
              if (!meta.promptPreview) meta.promptPreview = C.firstLine(part.text || '', 120);
            }
            if (part && part.type === 'image_url') meta.attachments.push({ type: 'image' });
            if (part && part.type === 'file_url') meta.attachments.push({ type: 'file' });
            if (part && part.type === 'video_url') meta.attachments.push({ type: 'video' });
          });
          meta.lastUserText = texts.join('\n');
        }
      }
    } catch (e) { /* ignore */ }
    // v1.2.0: uğursuz mesajın TAM mətni (kopyala düyməsi üçün)
    meta.lastUserText = String(meta.lastUserText || '').slice(0, 200000);
    return meta;
  }

  function registerCaptureSync(url, method, headers, bodyStr) {
    var u = new URL(url, self.location.href);
    var queryEntries = parseOrderedQuery(u.search);
    var bodyJson = null;
    if (typeof bodyStr === 'string') { try { bodyJson = JSON.parse(bodyStr); } catch (e) { bodyJson = null; } }
    var sum = summarizeBody(bodyJson);
    var canResign = !!(bodyJson && typeof bodyJson.signature_prompt === 'string'
      && qGet(queryEntries, 'requestId') && qGet(queryEntries, 'user_id')
      && qGet(queryEntries, 'timestamp'));
    var rec = {
      id: uid(),
      url: u.href,
      origin: u.origin,
      pathname: u.pathname,
      queryEntries: queryEntries,
      query: {
        timestamp: Number(qGet(queryEntries, 'timestamp')) || 0,
        signature_timestamp: Number(qGet(queryEntries, 'signature_timestamp')) || 0,
        requestId: qGet(queryEntries, 'requestId') || '',
        user_id: qGet(queryEntries, 'user_id') || ''
      },
      headers: headers,
      body: (typeof bodyStr === 'string') ? bodyStr : null,
      bodyJson: bodyJson,
      canReplay: method === 'POST' && typeof bodyStr === 'string',
      canResign: canResign,
      promptPreview: sum.promptPreview,
      attachments: sum.attachments,
      chatId: bodyJson && bodyJson.chat_id ? String(bodyJson.chat_id) : '',
      ts: Date.now(),
      lastText: ''
    };
    recs.set(rec.id, rec);
    POST({ t: 'CAPTURED', meta: stripForContent(rec) });
    return rec;
  }

  function stripForContent(rec) {
    return {
      id: rec.id, url: rec.url, origin: rec.origin, pathname: rec.pathname,
      queryEntries: rec.queryEntries, query: rec.query,
      headers: rec.headers,
      body: (typeof rec.body === 'string' && rec.body.length <= 1048576) ? rec.body : null,
      bodyLen: rec.body ? rec.body.length : 0,
      canReplay: rec.canReplay, canResign: rec.canResign,
      promptPreview: rec.promptPreview, attachments: rec.attachments,
      lastUserText: rec.lastUserText || '',
      chatId: rec.chatId, ts: rec.ts
    };
  }

  /* ---------- Monitor ---------- */

  function monitorResponse(rec, res, retryAfterMs) {
    try {
      POST({ t: 'LOG', line: 'completion → ' + res.status + ' (' + rec.attachments.length + ' əlavə)' });
      var clone = res.clone(); // bizim handler birincidir — clone təhlükəsizdir
      if (!res.ok || res.status >= 400) {
        clone.text().then(function (t) {
          var r = C.classifyHttpError(res.status, t, settings.retryOnHttpError);
          POST({
            t: 'RESULT', src: 'app', id: rec.id, outcome: r.outcome, reason: r.reason,
            msg: r.msg, httpStatus: res.status, retryAfterMs: retryAfterMs || null
          });
        }).catch(function () {
          POST({ t: 'RESULT', src: 'app', id: rec.id, outcome: 'retry', reason: 'http_' + res.status, msg: 'HTTP ' + res.status });
        });
        return;
      }
      var ct = (res.headers.get('content-type') || '');
      if (ct.indexOf('text/event-stream') >= 0) {
        scanBodyStream(clone.body, 150000).then(function (s) {
          var r = C.classifyStream(s);
          POST({
            t: 'RESULT', src: 'app', id: rec.id, outcome: r.outcome, reason: r.reason,
            msg: r.msg, httpStatus: res.status, retryAfterMs: retryAfterMs || null,
            sawContent: s.sawContent, gotDone: s.gotDone
          });
        }).catch(function () {
          POST({ t: 'RESULT', src: 'app', id: rec.id, outcome: 'retry', reason: 'stream_cut', msg: 'Axın oxunmadı' });
        });
      } else {
        clone.text().then(function (t) {
          var r = C.classifyBodyText(t);
          POST({ t: 'RESULT', src: 'app', id: rec.id, outcome: r.outcome, reason: r.reason, msg: r.msg, httpStatus: res.status });
        }).catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- Dublikat qorunması (v1.2.0) ----------
   *
   * Retry-dan ƏVVƏL server tarixçəsi yoxlanılır: mesaj onsuz da çatıb və
   * cavabı yazılıbsa (məs. axın kəsilib, amma server yazıb) yenidən
   * göndərmək DUB_LİKAT yaradar — ona görə retry ləğv edilir.
   */
  async function checkDuplicate(rec) {
    try {
      var g = await ofetch(rec.origin + '/api/v1/chats/' + encodeURIComponent(rec.chatId), {
        method: 'GET', headers: authishHeaders(rec, false), credentials: 'same-origin'
      });
      if (!g.ok) return false;
      var j = await g.json();
      var chat = (j && j.chat) ? j.chat : j;
      var msgs = (chat && chat.history && chat.history.messages) || {};
      var um = msgs[rec.bodyJson.current_user_message_id];
      if (!um) return false;
      var kids = um.childrenIds || [];
      for (var i = 0; i < kids.length; i++) {
        var k = msgs[kids[i]];
        if (k && k.role === 'assistant' && k.done !== false) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  /* ---------- Retry icraçısı ---------- */

  async function doRetry(id, opts) {
    opts = opts || {};
    var rec = recs.get(id);
    if (!rec) {
      POST({ t: 'RESULT', src: 'retry', id: id, outcome: 'fatal', reason: 'no_record', msg: 'Qeyd tapılmadı' });
      return;
    }
    if (!rec.canReplay || typeof rec.body !== 'string') {
      POST({ t: 'RESULT', src: 'retry', id: id, outcome: 'fatal', reason: 'not_replayable', msg: 'Sorğu təkrarlanabilməz' });
      return;
    }
    /* v1.2.0: dublikat qorunması — sorğu getməzdən əvvəl serverə baxılır */
    if (opts.dupGuard && rec.chatId && rec.bodyJson && rec.bodyJson.current_user_message_id) {
      var dup = await checkDuplicate(rec);
      if (dup) {
        POST({ t: 'LOG', line: 'dublikat qorunması: mesaj onsuz da tarixçədədir — retry ləğv edildi' });
        POST({
          t: 'RESULT', src: 'retry', id: rec.id, outcome: 'success',
          reason: 'duplicate_avoided', msg: 'Mesaj onsuz da göndərilib (dublikat qorunması)',
          dupGuard: true
        });
        return;
      }
    }
    var url = rec.url;
    var headers = Object.assign({}, rec.headers);
    var resigned = false;
    if (opts.resign && rec.canResign && rec.query.timestamp) {
      var age = Date.now() - rec.query.timestamp;
      var threshold = opts.resignAfterMs || 240000;
      if (age > threshold) {
        try {
          var r = await C.resignUrl(
            rec.queryEntries, rec.origin, rec.pathname,
            rec.bodyJson.signature_prompt, rec.query.requestId, rec.query.user_id, Date.now()
          );
          url = r.url;
          headers['x-signature'] = r.signature;
          resigned = true;
        } catch (e) { /* imza yenilənmədi — orijinal sorğu ilə davam */ }
      }
    }
    POST({ t: 'LOG', line: 'retry ' + rec.pathname + (resigned ? ' (imza yeniləndi)' : '') + ' — cəhd ' + (opts.attempt || '?') });
    try {
      var res = await ofetch(url, {
        method: 'POST',
        headers: headers,
        body: rec.body,
        credentials: 'same-origin'
      });
      var ra = parseRetryAfter(res.headers.get('retry-after'));
      if (!res.ok || res.status >= 400) {
        var t = await res.text().catch(function () { return ''; });
        var r2 = C.classifyHttpError(res.status, t, settings.retryOnHttpError);
        POST({
          t: 'RESULT', src: 'retry', id: rec.id, outcome: r2.outcome, reason: r2.reason,
          msg: r2.msg, httpStatus: res.status, retryAfterMs: ra, resigned: resigned
        });
        return;
      }
      var ct = (res.headers.get('content-type') || '');
      if (ct.indexOf('text/event-stream') >= 0) {
        var s = await scanBodyStream(res.body, 150000);
        rec.lastText = s.text;
        var r3 = C.classifyStream(s);
        POST({
          t: 'RESULT', src: 'retry', id: rec.id, outcome: r3.outcome, reason: r3.reason,
          msg: r3.msg, httpStatus: res.status, retryAfterMs: ra, resigned: resigned,
          sawContent: s.sawContent, gotDone: s.gotDone, text: s.text
        });
      } else {
        var t2 = await res.text().catch(function () { return ''; });
        var r4 = C.classifyBodyText(t2);
        POST({
          t: 'RESULT', src: 'retry', id: rec.id, outcome: r4.outcome, reason: r4.reason,
          msg: r4.msg, httpStatus: res.status, retryAfterMs: ra, resigned: resigned
        });
      }
    } catch (e) {
      var ab = e && (e.name === 'AbortError' || String(e).indexOf('abort') >= 0);
      POST({
        t: 'RESULT', src: 'retry', id: rec.id,
        outcome: ab ? 'aborted' : 'retry', reason: 'network',
        msg: ab ? 'Ləğv edildi' : 'Şəbəkə xətası'
      });
    }
  }

  /* ---------- Persist (uğurlu retry-dan sonra, LEGACY_SPEC §7) ---------- */

  function authishHeaders(rec, json) {
    var h = {};
    Object.keys(rec.headers || {}).forEach(function (k) {
      if (['accept', 'content-type', 'x-signature'].indexOf(k) < 0) h[k] = rec.headers[k];
    });
    h['accept'] = 'application/json';
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  async function doPersist(id) {
    var rec = recs.get(id);
    if (!rec || !rec.bodyJson || !rec.chatId) {
      POST({ t: 'PERSISTED', id: id, ok: false, why: 'no_record' });
      return;
    }
    if (!rec.lastText) {
      POST({ t: 'PERSISTED', id: id, ok: false, why: 'no_text' });
      return;
    }
    try {
      // 1) Mövcud chat obyektini gətir (title və digər sahələr itməsin)
      var chatObj = null;
      try {
        var gr = await ofetch(rec.origin + '/api/v1/chats/' + rec.chatId, {
          method: 'GET', headers: authishHeaders(rec, false), credentials: 'same-origin'
        });
        if (gr.ok) {
          var gj = await gr.json();
          chatObj = (gj && gj.chat) ? gj.chat : gj;
          var existing = chatObj && chatObj.history && chatObj.history.messages;
          if (existing && existing[rec.bodyJson.id]) {
            POST({ t: 'PERSISTED', id: id, ok: true, why: 'already' });
            return;
          }
        }
      } catch (e) { /* davam */ }

      // 2) §7 forması: msg-0..msg-N sintetik id-lər + real user/assistant id-ləri
      var now = Date.now();
      var msgs = Array.isArray(rec.bodyJson.messages) ? rec.bodyJson.messages : [];
      var entries = {};
      var prevId = null;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var mid = (i === msgs.length - 1)
          ? String((rec.bodyJson.current_user_message_id) || ('msg-' + i))
          : ('msg-' + i);
        entries[mid] = {
          id: mid, parentId: prevId, childrenIds: [],
          role: m.role, content: m.content,
          timestamp: Math.floor(now / 1000), models: [rec.bodyJson.model]
        };
        if (prevId && entries[prevId]) entries[prevId].childrenIds = [mid];
        prevId = mid;
      }
      var aid = String(rec.bodyJson.id || 'assistant');
      entries[aid] = {
        id: aid, parentId: prevId, childrenIds: [],
        role: 'assistant', content: rec.lastText,
        timestamp: Math.floor(now / 1000), models: [rec.bodyJson.model],
        model: rec.bodyJson.model, modelName: rec.bodyJson.model, modelIdx: 0,
        done: true, error: false
      };
      if (prevId && entries[prevId]) entries[prevId].childrenIds = [aid];

      var chat = (chatObj && typeof chatObj === 'object')
        ? Object.assign({}, chatObj)
        : { id: rec.chatId, title: 'Z.ai', tags: [], flags: ['general_agent'], features: [], mcp_servers: [] };
      chat.history = { messages: entries, currentId: aid };
      chat.models = [rec.bodyJson.model];
      chat.timestamp = now;
      chat.message_version = 1;
      chat.type = 'general_agent';
      if (!chat.params) chat.params = {};
      if (!chat.extra) chat.extra = {};
      if (rec.bodyJson.features) {
        if (rec.bodyJson.features.reasoning_effort) chat.reasoning_effort = rec.bodyJson.features.reasoning_effort;
        if (typeof rec.bodyJson.features.enable_thinking === 'boolean') chat.enable_thinking = rec.bodyJson.features.enable_thinking;
      }

      var pr = await ofetch(rec.origin + '/api/v1/chats/' + rec.chatId, {
        method: 'POST',
        headers: authishHeaders(rec, true),
        body: JSON.stringify({ chat: chat }),
        credentials: 'same-origin'
      });
      POST({ t: 'PERSISTED', id: id, ok: pr.ok, status: pr.status });
    } catch (e) {
      POST({ t: 'PERSISTED', id: id, ok: false, why: String(e) });
    }
  }

  /* ---------- Söhbətin ixracı (v1.2.0) ----------
   *
   * GET /api/v1/chats/{id} — mövcud sessiya kukiləri ilə; cavab content
   * script-ə ötürülür, Markdown orada qurulur (core/mdexport.js).
   */
  async function doExport(chatId) {
    try {
      var cid = String(chatId || '').replace(/[^A-Za-z0-9_\-]/g, '');
      if (!cid) { POST({ t: 'EXPORTED', ok: false, why: 'no_chat_id' }); return; }
      var anyRec = null;
      recs.forEach(function (r) { if (!anyRec && r.headers && r.headers.authorization) anyRec = r; });
      var headers = anyRec ? authishHeaders(anyRec, false) : { accept: 'application/json' };
      var r = await ofetch(self.location.origin + '/api/v1/chats/' + cid, {
        method: 'GET', headers: headers, credentials: 'same-origin'
      });
      if (!r.ok) { POST({ t: 'EXPORTED', ok: false, why: 'http_' + r.status }); return; }
      var j = await r.json();
      POST({ t: 'EXPORTED', ok: true, chat: (j && j.chat) ? j.chat : j, chatId: cid });
    } catch (e) {
      POST({ t: 'EXPORTED', ok: false, why: String(e) });
    }
  }

  /* ---------- BÜTÜN SÖHBƏTLƏRİN BACKUP-I (v1.3.0) ----------
   *
   * GET /api/v1/chats/?page=N&type=default → [{id, title, updated_at}]
   * (protokol spec-i: səhifələmə 1..10, boş səhifə / təkrar ilk id / qısa
   * səhifə / 300-dən çox halında dayan). Sonra hər chatın detalı ayrıca
   * gətirilir; progress content script-ə axınla ötürülür.
   */
  function authishHeadersAny() {
    var anyRec = null;
    recs.forEach(function (r) { if (!anyRec && r.headers && r.headers.authorization) anyRec = r; });
    return anyRec ? authishHeaders(anyRec, false) : { accept: 'application/json' };
  }

  async function listChats() {
    var headers = authishHeadersAny();
    var out = [];
    var firstPrev = null;
    for (var pg = 1; pg <= 10; pg++) {
      var r = await ofetch(self.location.origin + '/api/v1/chats/?page=' + pg + '&type=default', {
        method: 'GET', headers: headers, credentials: 'same-origin'
      });
      if (!r.ok) break;
      var j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      var arr = Array.isArray(j) ? j
        : (j && Array.isArray(j.chats) ? j.chats
          : (j && Array.isArray(j.data) ? j.data : null));
      if (!arr || !arr.length) break;
      var firstId = arr[0] && arr[0].id;
      if (firstPrev && firstId === firstPrev) break; // server səhifələməni iqnor edir
      firstPrev = firstId;
      out = out.concat(arr);
      if (arr.length < 20) break; // qısa səhifə — sonuncudur
      if (out.length > 300) break;
    }
    return out.filter(function (c) { return c && c.id; });
  }

  async function doBackupAll(maxChats) {
    try {
      var list = await listChats();
      if (!list.length) { POST({ t: 'BACKUP_DONE', ok: false, why: 'no_chats' }); return; }
      var limit = Math.max(1, Math.min(300, Number(maxChats) || 50));
      var target = list.slice(0, limit);
      var headers = authishHeadersAny();
      var chats = [];
      for (var i = 0; i < target.length; i++) {
        var cid = String(target[i].id);
        try {
          var r = await ofetch(self.location.origin + '/api/v1/chats/' + encodeURIComponent(cid), {
            method: 'GET', headers: headers, credentials: 'same-origin'
          });
          if (r.ok) {
            var j = await r.json();
            chats.push((j && j.chat) ? j.chat : j);
          }
        } catch (e) { /* bu söhbət alınmadı — qalanı davam etsin */ }
        POST({
          t: 'BACKUP_PROGRESS', done: i + 1, total: target.length,
          title: String(target[i].title || '').slice(0, 60)
        });
      }
      POST({
        t: 'BACKUP_DONE', ok: true, chats: chats,
        list: target.map(function (c) { return { id: c.id, title: c.title || '', updated_at: c.updated_at || 0 }; })
      });
    } catch (e) {
      POST({ t: 'BACKUP_DONE', ok: false, why: String(e) });
    }
  }

  /* ---------- fetch yolası ---------- */

  self.fetch = function () {
    var args = arguments;
    var rec = null;
    var bodyPromise = null;
    try {
      var input = args[0], init = args[1];
      var url, method, headers, bodyStr = null;
      if (typeof Request !== 'undefined' && input instanceof Request) {
        url = input.url;
        method = input.method;
        headers = headersToDict(input.headers);
        if (init && init.headers) {
          var extra = headersToDict(init.headers);
          Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
        }
        try {
          if (!input.bodyUsed) bodyPromise = input.clone().text();
        } catch (e) { bodyPromise = null; }
      } else {
        url = String(input);
        init = init || {};
        method = init.method || 'GET';
        headers = headersToDict(init.headers);
        if (typeof init.body === 'string') bodyStr = init.body;
      }
      var u = new URL(url, self.location.href);
      if (u.origin === self.location.origin && String(method).toUpperCase() === 'POST' && u.pathname.indexOf('/api/') === 0) {
        if (isCompletionPath(u.href) && (bodyStr !== null || bodyPromise)) {
          if (bodyStr !== null) {
            rec = registerCaptureSync(url, method, headers, bodyStr);
          } else {
            // Request obyekti: body gələndə qeydi tamamlayırıq (retry yalnız ondan sonra mümkün)
            rec = registerCaptureSync(url, method, headers, null);
            bodyPromise.then(function (b) {
              rec.body = b;
              try { rec.bodyJson = JSON.parse(b); } catch (e) { rec.bodyJson = null; }
              rec.canReplay = typeof b === 'string';
              var qs = parseOrderedQuery(new URL(rec.url).search);
              rec.canResign = !!(rec.bodyJson && typeof rec.bodyJson.signature_prompt === 'string'
                && qGet(qs, 'requestId') && qGet(qs, 'user_id') && qGet(qs, 'timestamp'));
              rec.chatId = rec.bodyJson && rec.bodyJson.chat_id ? String(rec.bodyJson.chat_id) : '';
              var sum = summarizeBody(rec.bodyJson);
              rec.promptPreview = sum.promptPreview;
              rec.attachments = sum.attachments;
              POST({ t: 'CAPTURED', meta: stripForContent(rec) });
            }).catch(function () { /* body oxunmadı */ });
          }
        }
      }
    } catch (e) { rec = null; /* capture sındı — sorğu normal gedir */ }

    var pr;
    try {
      pr = ofetch.apply(self, args);
    } catch (e) {
      // sync istisna (nadiren) — birbaşa ötürürt
      throw e;
    }

    if (rec) {
      // bizim handler TƏTBİQİN handler-indən ƏVVƏL taxılır → clone() təhlükəsizdir
      pr.then(function (res) {
        var ra = parseRetryAfter(res.headers.get('retry-after'));
        monitorResponse(rec, res, ra);
        return res;
      }, function (err) {
        var ab = err && (err.name === 'AbortError' || String(err).indexOf('abort') >= 0);
        POST({
          t: 'RESULT', src: 'app', id: rec.id,
          outcome: ab ? 'aborted' : 'retry', reason: 'network',
          msg: ab ? 'İstifadəçi ləğv etdi' : 'Şəbəkə xətası'
        });
        throw err;
      });
    } else {
      try {
        var u2 = new URL(String(args[0]), self.location.href);
        if (u2.origin === self.location.origin && u2.pathname.indexOf('/api/') === 0) {
          pr.then(function (res) {
            POST({ t: 'LOG', line: 'POST ' + u2.pathname + ' → ' + res.status });
            return res;
          }, function () { POST({ t: 'LOG', line: 'POST ' + u2.pathname + ' → şəbəkə xətası' }); });
        }
      } catch (e) { /* ignore */ }
    }
    return pr;
  };

  /* ---------- XHR yolası ---------- */

  (function () {
    var OX = self.XMLHttpRequest;
    if (!OX) return;
    var oxOpen = OX.prototype.open;
    var oxSend = OX.prototype.send;
    var oxSet = OX.prototype.setRequestHeader;

    OX.prototype.open = function (m, u) {
      this.__zaiInfo = { method: String(m || 'GET').toUpperCase(), url: String(u), headers: {} };
      return oxOpen.apply(this, arguments);
    };
    OX.prototype.setRequestHeader = function (k, v) {
      if (this.__zaiInfo) this.__zaiInfo.headers[String(k).toLowerCase()] = String(v);
      return oxSet.apply(this, arguments);
    };
    OX.prototype.send = function (b) {
      var x = this;
      var info = x.__zaiInfo;
      try {
        if (info) {
          var u = new URL(info.url, self.location.href);
          if (u.origin === self.location.origin && info.method === 'POST' && u.pathname.indexOf('/api/') === 0) {
            if (isCompletionPath(u.href) && typeof b === 'string') {
              var rec = registerCaptureSync(u.href, info.method, info.headers, b);
              x.addEventListener('loadend', function () {
                if (x.__zaiReported) return;
                x.__zaiReported = true;
                var s = scanFullText(x.responseText);
                rec.lastText = s.text;
                var r;
                if (!x.status) {
                  r = { outcome: 'retry', reason: 'network', msg: 'Şəbəkə xətası (XHR)' };
                } else if (x.status >= 400) {
                  r = C.classifyHttpError(x.status, x.responseText, settings.retryOnHttpError);
                } else {
                  r = C.classifyStream(s);
                }
                POST({
                  t: 'RESULT', src: 'app', id: rec.id, outcome: r.outcome, reason: r.reason,
                  msg: r.msg, httpStatus: x.status, retryAfterMs: null,
                  sawContent: s.sawContent, gotDone: s.gotDone, text: s.text
                });
              });
              x.addEventListener('abort', function () {
                POST({ t: 'RESULT', src: 'app', id: rec.id, outcome: 'aborted', reason: 'user', msg: 'Ləğv edildi' });
              });
            } else {
              x.addEventListener('loadend', function () {
                POST({ t: 'LOG', line: 'XHR POST ' + u.pathname + ' → ' + x.status });
              });
            }
          }
        }
      } catch (e) { /* ignore */ }
      return oxSend.apply(this, arguments);
    };
  })();

  /* ---------- WebSocket müşahidəsi (yalnız jurnal) ---------- */
  (function () {
    var OW = self.WebSocket;
    if (!OW || OW.__zaiWrapped) return;
    try {
      function WSWrapper(url, protocols) {
        var ws = protocols === undefined ? new OW(url) : new OW(url, protocols);
        POST({ t: 'LOG', line: 'WS açıldı: ' + url });
        var os = ws.send;
        var n = 0;
        ws.send = function (d) {
          n++;
          if (n <= 3) POST({ t: 'LOG', line: 'WS send #' + n + ': ' + (typeof d === 'string' ? String(d).slice(0, 100) : '[binary]') });
          return os.apply(this, arguments);
        };
        ws.addEventListener('close', function () { POST({ t: 'LOG', line: 'WS bağlandı: ' + url }); });
        return ws;
      }
      WSWrapper.prototype = OW.prototype;
      Object.keys(OW).forEach(function (k) { try { WSWrapper[k] = OW[k]; } catch (e) { } });
      WSWrapper.__zaiWrapped = true;
      self.WebSocket = WSWrapper;
    } catch (e) { /* ignore */ }
  })();

  /* ---------- Content script-dən gələn əmrlər ---------- */

  self.addEventListener('message', function (ev) {
    if (ev.source !== self) return;
    var d = ev.data;
    if (!d || d.zai !== 1) return;
    if (d.t === 'PING') { POST({ t: 'PONG', inject: true, recs: recs.size }); return; }
    if (d.t === 'INIT') { if (d.settings) settings = Object.assign(settings, d.settings); return; }
    if (d.t === 'RETRY') { doRetry(d.id, d.opts || {}); return; }
    if (d.t === 'PERSIST') { doPersist(d.id); return; }
    if (d.t === 'EXPORT') { doExport(d.chatId); return; }
    if (d.t === 'BACKUP_ALL') { doBackupAll(d.maxChats); return; }
    if (d.t === 'HYDRATE') {
      (d.records || []).forEach(function (r) {
        if (recs.has(r.id)) return;
        try {
          var bodyJson = null;
          try { bodyJson = JSON.parse(r.body); } catch (e) { }
          recs.set(r.id, {
            id: r.id, url: r.url, origin: r.origin, pathname: r.pathname,
            queryEntries: r.queryEntries || [], query: r.query || {},
            headers: r.headers || {}, body: r.body || null, bodyJson: bodyJson,
            canReplay: !!(r.body && r.canReplay), canResign: !!(r.canResign),
            promptPreview: r.promptPreview || '', attachments: r.attachments || [],
            lastUserText: r.lastUserText || '',
            chatId: r.chatId || '', ts: r.ts || 0, lastText: r.lastText || ''
          });
        } catch (e) { /* ignore */ }
      });
      return;
    }
  });

  POST({ t: 'LOG', line: 'inject hazırdır (' + self.location.host + ')' });
})();
