/*
 * Mock z.ai chat tətbiqi (test səhifəsi).
 * REAL protokulu təkrarlayır: /api/v2/chat/completions + X-Signature,
 * attachment upload (/api/v1/storage/pfs/files/upload), persist (POST chats/{id}).
 *
 * Xəta halında (system is busy / şəbəkə) DƏQİQ z.ai kimi davranır:
 *   qırmızı xəta sətri + composer təmizlənir + attachment-lar SİLİNİR.
 */
'use strict';

(function () {
  const CHAT_ID = 'mock-chat-1';
  const KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const composerEl = $('composer');
  const chipsEl = $('chips');
  const fileInput = $('fileInput');

  let attachments = [];      // {url, name, kind}
  let appHistory = [];       // {role, content}
  let turnCount = 0;
  let sending = false;

  /* ---------- preview modalı (z.ai kimi) ----------
     window.__mockAutoPreview         → uğurlu cavabdan sonra ÖZ-ÖZÜNƏ açılır
     window.__mockAutoPreviewOnAttach → fayl əlavə ediləndə ÖZ-ÖZÜNƏ açılır
     window.__mockPreview             → test üçün vəziyyət */
  const previewModal = $('previewModal');
  window.__mockPreview = { opens: 0, open: false, openedBy: null, closedBy: null };
  function openPreview(by) {
    previewModal.classList.add('open');
    window.__mockPreview.opens += 1;
    window.__mockPreview.open = true;
    window.__mockPreview.openedBy = by;
    window.__mockPreview.closedBy = null;
  }
  function closePreview(by) {
    previewModal.classList.remove('open');
    window.__mockPreview.open = false;
    window.__mockPreview.closedBy = by;
  }
  $('previewClose').addEventListener('click', (e) => { e.stopPropagation(); closePreview('button'); });
  previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview('backdrop'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewModal.classList.contains('open')) closePreview('escape');
  });

  /* ---------- v1.2.0: peak hours popapı + parol dialoqu ----------
     window.__mockPeakOpen() → saytın özü kimi (kliksiz) popapı açır
     window.__modalVisible(id) → görünənliyi yoxlayır (forceHide daxil) */
  const peakModal = $('peakModal');
  const authModal = $('authModal');
  window.__mockPeak = { opens: 0, open: false, closedBy: null };
  window.__mockPeakOpen = function () {
    peakModal.classList.add('open');
    window.__mockPeak.opens += 1;
    window.__mockPeak.open = true;
    window.__mockPeak.closedBy = null;
  };
  $('peakLater').addEventListener('click', (e) => {
    e.stopPropagation();
    peakModal.classList.remove('open');
    window.__mockPeak.open = false;
    window.__mockPeak.closedBy = 'later';
  });
  peakModal.addEventListener('click', (e) => {
    if (e.target === peakModal) {
      peakModal.classList.remove('open');
      window.__mockPeak.open = false;
      window.__mockPeak.closedBy = 'backdrop';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && peakModal.classList.contains('open')) {
      peakModal.classList.remove('open');
      window.__mockPeak.open = false;
      window.__mockPeak.closedBy = 'escape';
    }
  });
  window.__mockAuthOpen = function () { authModal.classList.add('open'); };
  window.__modalVisible = function (id) {
    const m = document.getElementById(id);
    return !!m && m.classList.contains('open') && getComputedStyle(m).display !== 'none';
  };

  const enc = new TextEncoder();
  function formEncode(v) {
    v = String(v);
    let out = '';
    for (const ch of v) {
      if (/[A-Za-z0-9\*\-\._]/.test(ch)) out += ch;
      else if (ch === ' ') out += '+';
      else {
        for (const b of enc.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }
  async function hmacHex(key, msg) {
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const s = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
    return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function sign(prompt, requestId, userId, ts) {
    const bytes = enc.encode(String(prompt).trim());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    const data = `requestId,${requestId},timestamp,${ts},user_id,${userId}|${b64}|${ts}`;
    const g = Math.floor(ts / 300000);
    const sub = await hmacHex(KEY, String(g));
    return await hmacHex(sub, data);
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    attachments.forEach((a) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = '📎 ' + a.name + (a.kind === 'image' ? ' (şəkil)' : ' (fayl)');
      c.title = 'Preview aç (istifadəçi kliki)';
      c.addEventListener('click', () => openPreview('user'));
      chipsEl.appendChild(c);
    });
  }

  function addRow(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    messagesEl.appendChild(d);
    return d;
  }

  function renderHistory(chat) {
    messagesEl.innerHTML = '';
    const msgs = (chat && chat.history && chat.history.messages) || {};
    Object.values(msgs).forEach((m) => {
      if (!m) return;
      if (m.role === 'assistant') {
        addRow('msg-assistant', typeof m.content === 'string' ? m.content : '(massiv cavab)');
      } else {
        let txt = '';
        if (typeof m.content === 'string') txt = m.content;
        else if (Array.isArray(m.content)) {
          txt = m.content.map((p) => p.type === 'text' ? p.text : `[${p.type === 'image_url' ? 'şəkil' : 'əlavə'}]`).join(' ');
        }
        addRow('msg-user', txt);
      }
    });
    $('turnCount').textContent = String(turnCount);
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/v1/chats/' + CHAT_ID, { headers: { accept: 'application/json', authorization: 'Bearer mock-token-123' }, credentials: 'same-origin' });
      const chat = await r.json();
      renderHistory(chat && chat.chat ? chat.chat : chat);
    } catch (e) { /* ignore */ }
  }

  /* ---------- attachment yükləmə ---------- */
  fileInput.addEventListener('change', async () => {
    for (const f of (fileInput.files || [])) {
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        const r = await fetch('/api/v1/storage/pfs/files/upload', {
          method: 'POST',
          headers: { accept: 'application/json', authorization: 'Bearer mock-token-123', 'x-device-id': 'uid_mockdevice42' },
          body: fd,
          credentials: 'same-origin'
        });
        const j = await r.json();
        const file = j && j.data && j.data.file;
        if (file) {
          const kind = (file.type || '').startsWith('image/') ? 'image' : 'file';
          attachments.push({ url: file.direct_url, name: file.filename, kind: kind });
          renderChips();
        }
      } catch (e) { /* ignore */ }
    }
    fileInput.value = '';
    if (window.__mockAutoPreviewOnAttach) {
      setTimeout(() => { if (window.__mockAutoPreviewOnAttach) openPreview('auto-attach'); }, 120);
    }
  });
  $('attach').addEventListener('click', () => fileInput.click());

  /* ---------- persist ---------- */
  async function persistChat(assistId, userMsgId, assistantText) {
    const now = Date.now();
    const entries = {};
    let prevId = null;
    appHistory.forEach((m, i) => {
      let mid, role = m.role;
      if (i === appHistory.length - 2) { mid = userMsgId; role = 'user'; }
      else if (i === appHistory.length - 1) { mid = assistId; role = 'assistant'; }
      else mid = 'msg-' + i;
      entries[mid] = {
        id: mid, parentId: prevId, childrenIds: [], role: role, content: m.content,
        timestamp: Math.floor(now / 1000), models: ['x-preview-l'],
        done: role === 'assistant' ? true : undefined,
        model: role === 'assistant' ? 'x-preview-l' : undefined
      };
      if (prevId && entries[prevId]) entries[prevId].childrenIds = [mid];
      prevId = mid;
    });
    const chat = {
      id: CHAT_ID, title: 'Mock söhbət', models: ['x-preview-l'], params: {},
      history: { messages: entries, currentId: assistId },
      tags: [], flags: ['general_agent'], mcp_servers: [],
      enable_thinking: true, reasoning_effort: 'high', auto_web_search: false,
      message_version: 1, extra: {}, timestamp: now, type: 'general_agent'
    };
    try {
      await fetch('/api/v1/chats/' + CHAT_ID, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer mock-token-123', 'x-device-id': 'uid_mockdevice42' },
        body: JSON.stringify({ chat: chat }),
        credentials: 'same-origin'
      });
    } catch (e) { /* ignore */ }
  }

  /* THE PAIN: xətada composer + attachment-lar təmizlənir (z.ai kimi) */
  function failSend(msg) {
    addRow('err', msg);
    composerEl.value = '';
    attachments = [];
    renderChips();
  }

  /* ---------- göndər ---------- */
  async function send() {
    const prompt = composerEl.value.trim();
    if (sending) return;
    if (!prompt && attachments.length === 0) return;
    sending = true;

    const det = !!window.__deterministicIds;
    const stale = !!window.__staleTs;
    const ts = Date.now() - (stale ? 600000 : 0);
    const requestId = det ? 'det-req' : crypto.randomUUID();
    const userMsgId = det ? 'det-user' : crypto.randomUUID();
    const assistId = det ? 'det-assist' : crypto.randomUUID();
    const sessionId = det ? 'det-session' : crypto.randomUUID();

    const content = attachments.length
      ? [{ type: 'text', text: prompt }].concat(attachments.map((a) =>
          a.kind === 'image' ? { type: 'image_url', image_url: { url: a.url } } : { type: 'file_url', file_url: { url: a.url } }
        ))
      : prompt;
    appHistory.push({ role: 'user', content: content });

    const body = {
      stream: true,
      model: 'x-preview-l',
      messages: appHistory.slice(),
      signature_prompt: prompt,
      params: {},
      features: {
        image_generation: false, web_search: false, auto_web_search: false, preview_mode: false,
        flags: ['general_agent'], vlm_tools_enable: false, vlm_web_search_enable: false,
        vlm_website_mode: false, enable_thinking: true, reasoning_effort: 'high'
      },
      variables: {},
      session_id: sessionId,
      chat_id: CHAT_ID,
      id: assistId,
      current_user_message_id: userMsgId,
      current_user_message_parent_id: null,
      background_tasks: { title_generation: turnCount === 0, tags_generation: turnCount === 0 }
    };

    const sig = await sign(prompt, requestId, 'mock-user-42', ts);
    const d = new Date(ts);
    const q = [
      ['timestamp', ts], ['requestId', requestId], ['user_id', 'mock-user-42'],
      ['version', '0.0.1'], ['platform', 'web'], ['token', 'mock-token-123'],
      ['user_agent', navigator.userAgent], ['language', 'en-US'], ['languages', 'en-US'],
      ['timezone', 'Asia/Baku'], ['cookie_enabled', 'true'],
      ['screen_width', '1080'], ['screen_height', '2400'], ['screen_resolution', '1080x2400'],
      ['viewport_height', '800'], ['viewport_width', '400'], ['viewport_size', '400x800'],
      ['color_depth', '24'], ['pixel_ratio', '2.625'],
      ['current_url', location.origin + '/'], ['pathname', '/'], ['search', ''], ['hash', ''],
      ['host', location.host], ['hostname', location.host], ['protocol', location.protocol],
      ['referrer', ''], ['title', 'Z.ai Mock'], ['timezone_offset', '-240'],
      ['local_time', d.toISOString()], ['utc_time', d.toUTCString()],
      ['is_mobile', 'true'], ['is_touch', 'true'], ['max_touch_points', '5'],
      ['browser_name', 'Chrome'], ['os_name', 'Android']
    ];
    const qs = q.map(([k, v]) => formEncode(k) + '=' + formEncode(String(v))).join('&') + '&signature_timestamp=' + ts;
    const url = '/api/v2/chat/completions?' + qs;

    let bubble = null;
    let text = '';
    let gotDone = false;
    let streamErr = null;

    function handleData(payload) {
      if (payload === '[DONE]') { gotDone = true; return; }
      let j = null;
      try { j = JSON.parse(payload); } catch (e) { return; }
      const err = (j.data && j.data.error) || j.error;
      if (err) { streamErr = (err.detail || err.message || 'stream error') + (err.code ? ' [' + err.code + ']' : ''); return; }
      const m = j.data && j.data.message;
      if (m) {
        if (m.error) { streamErr = m.error.detail || m.error.message || 'stream error'; return; }
        if (typeof m.delta_content === 'string' && m.delta_content) {
          text += m.delta_content;
          if (bubble) bubble.textContent += m.delta_content;
        }
      }
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: 'Bearer mock-token-123',
          'x-device-id': 'uid_mockdevice42',
          'x-fe-version': 'prod-fe-1.123',
          'x-signature': sig
        },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      });

      if (res.status !== 200) {
        const t = await res.text();
        failSend('HTTP ' + res.status + ': ' + t.slice(0, 90));
        sending = false;
        return;
      }

      bubble = addRow('msg-assistant', '');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let lines = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith('data:')) lines.push(line.slice(5).trim());
          else if (line === '' && lines.length) { handleData(lines.join('\n')); lines = []; }
        }
      }
      if (buf.startsWith('data:')) handleData(buf.slice(5).trim());
      else if (lines.length) handleData(lines.join('\n'));

      if (streamErr) {
        if (bubble && bubble.parentNode) bubble.remove();
        failSend('The system is busy. Please try again later. [' + streamErr + ']');
        appHistory.pop();
        sending = false;
        return;
      }
      if (!gotDone) {
        if (bubble && bubble.parentNode) bubble.remove();
        failSend('Network error');
        appHistory.pop();
        sending = false;
        return;
      }

      // uğur → persist
      appHistory.push({ role: 'assistant', content: text });
      turnCount += 1;
      $('turnCount').textContent = String(turnCount);
      composerEl.value = '';
      attachments = [];
      renderChips();
      await persistChat(assistId, userMsgId, text);
      // z.ai kimi: generasiya bitəndə preview ÖZ-ÖZÜNƏ açılır
      if (window.__mockAutoPreview) {
        setTimeout(() => { if (window.__mockAutoPreview) openPreview('auto'); }, 120);
      }
    } catch (e) {
      if (bubble && bubble.parentNode) bubble.remove();
      failSend('Network error');
      appHistory.pop();
    }
    sending = false;
    window.__mockApp = {
      sent: (window.__mockApp ? window.__mockApp.sent : 0) + 1,
      lastText: text,
      attachments: attachments.length
    };
  }

  $('send').addEventListener('click', send);
  composerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  window.__mockApp = { sent: 0, lastText: '', attachments: 0 };
  window.__mockAutoPreview = false;
  window.__mockAutoPreviewOnAttach = false;
  loadHistory();
})();
