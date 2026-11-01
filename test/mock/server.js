/*
 * Z.ai mock server — for E2E tests.
 * Replicates the real protocol shape (LEGACY_SPEC §5): /api/v2/chat/completions
 * + X-Signature verification (an independent Node crypto implementation),
 * /api/v1/storage/pfs/files/upload (multipart), /api/v1/chats/{id} (persist).
 *
 * Controls:
 *   POST /_ctl {script:["busy","sse_ok",...], resetPersist:true}
 *   GET  /_log  → {requests, persists, uploads}
 *   DELETE /_log
 * Modes: sse_ok | busy | http429 | waf | netkill | badreq | empty200
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8907);
const KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const CHAT_ID = 'mock-chat-1';

/* a second "old" chat for full backup tests (list + detail) */
const CHAT2_ID = 'mock-chat-2';
function secondChat() {
  return {
    id: CHAT2_ID, title: 'Second mock chat', models: ['x-preview-l'],
    history: {
      messages: {
        'm1': { id: 'm1', parentId: null, childrenIds: ['m2'], role: 'user', content: 'Old question 1', timestamp: 1700000000, models: ['x-preview-l'] },
        'm2': { id: 'm2', parentId: 'm1', childrenIds: [], role: 'assistant', content: 'Old answer 1 — backup test.', timestamp: 1700000010, done: true, model: 'x-preview-l' }
      },
      currentId: 'm2'
    },
    tags: [], timestamp: 1700000010
  };
}

const state = {
  script: [],
  uploads: 0,
  uploadLog: [],
  requests: [],
  persists: [],
  persistedChat: null
};

function sse(res, obj) {
  res.write('data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n');
}

function pickQuery(req) {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const sp = u.searchParams;
  return {
    timestamp: Number(sp.get('timestamp') || 0),
    signature_timestamp: Number(sp.get('signature_timestamp') || 0),
    requestId: sp.get('requestId') || '',
    user_id: sp.get('user_id') || ''
  };
}

function pickHeaders(req) {
  return {
    authorization: req.headers['authorization'] || '',
    'x-signature': String(req.headers['x-signature'] || '').toLowerCase(),
    'x-device-id': req.headers['x-device-id'] || '',
    'content-type': req.headers['content-type'] || '',
    accept: req.headers['accept'] || ''
  };
}

/* Independent signature implementation (Node crypto) — inject.js re-signing
   must be the mirror image of this. */
function verifySig(req, bodyJson) {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const sp = u.searchParams;
  const ts = Number(sp.get('signature_timestamp') || sp.get('timestamp') || 0);
  const requestId = sp.get('requestId') || '';
  const userId = sp.get('user_id') || '';
  const prompt = String((bodyJson && bodyJson.signature_prompt) || '').trim();
  const b64 = Buffer.from(prompt, 'utf8').toString('base64');
  const data = 'requestId,' + requestId + ',timestamp,' + ts + ',user_id,' + userId + '|' + b64 + '|' + ts;
  const g = Math.floor(ts / 300000);
  const subkey = crypto.createHmac('sha256', KEY).update(String(g)).digest('hex');
  const sig = crypto.createHmac('sha256', subkey).update(data).digest('hex');
  const fresh = Math.abs(Date.now() - ts) <= 310000;
  const header = String(req.headers['x-signature'] || '').toLowerCase();
  const ok = !!(header === sig && fresh && requestId && userId && ts);
  return { ok: ok, sig: sig, fresh: fresh, headerOk: header === sig, ts: ts };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function parseMultipart(buf, boundary) {
  const out = [];
  const delim = Buffer.from('--' + boundary);
  let start = 0;
  while (true) {
    const s = buf.indexOf(delim, start);
    if (s < 0) break;
    const e = buf.indexOf(delim, s + delim.length);
    if (e < 0) break;
    const part = buf.slice(s + delim.length, e);
    const hdrEnd = part.indexOf('\r\n\r\n');
    if (hdrEnd >= 0) {
      const headers = part.slice(0, hdrEnd).toString('utf8');
      let body = part.slice(hdrEnd + 4);
      if (body.length >= 2) body = body.slice(0, body.length - 2); // son \r\n
      const nameM = /name="([^"]*)"/.exec(headers);
      const fileM = /filename="([^"]*)"/.exec(headers);
      const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
      out.push({
        name: nameM ? nameM[1] : null,
        filename: fileM ? fileM[1] : null,
        contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
        data: body
      });
    }
    start = e;
  }
  return out;
}

async function handleCompletion(req, res) {
  const raw = await readBody(req);
  let bodyJson = null;
  try { bodyJson = JSON.parse(raw.toString('utf8')); } catch (e) { bodyJson = null; }
  const v = verifySig(req, bodyJson);
  if (!v.ok) {
    const why = !v.headerOk ? 'invalid signature (mock)' : (!v.fresh ? 'stale signature (mock)' : 'invalid signature (mock)');
    state.requests.push({ t: Date.now(), sigOk: false, why: why, mode: 'sig_reject', query: pickQuery(req), headers: pickHeaders(req), body: bodyJson });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: why }));
    return;
  }
  const mode = state.script.length ? state.script.shift() : 'sse_ok';
  state.requests.push({ t: Date.now(), sigOk: true, mode: mode, query: pickQuery(req), headers: pickHeaders(req), body: bodyJson });

  if (mode === 'http429') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ detail: 'Too many requests. Please slow down.' }));
    return;
  }
  if (mode === 'waf') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><body>403 — blocked by WAF (mock)</body></html>');
    return;
  }
  if (mode === 'badreq') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'invalid request parameters' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (mode === 'busy') {
    sse(res, { data: { error: { code: 'global_limit', detail: 'The system is busy. Please try again later.' } } });
    res.end();
    return;
  }
  if (mode === 'netkill') {
    sse(res, { data: { message: { delta_content: 'partial response received — ' } } });
    setTimeout(() => { try { res.destroy(); } catch (e) { } }, 30);
    return;
  }
  if (mode === 'empty200') {
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  if (mode === 'duptrap') {
    // v1.2.0 DUPLICATE scenario: the server writes history as success
    // but ends the stream without [DONE] (stream cut). Before retrying, the
    // extension must see this via GET /chats/{id} and NOT resend.
    const bj = bodyJson || {};
    const msgs = Array.isArray(bj.messages) ? bj.messages : [];
    const entries = {};
    let prev = null;
    msgs.forEach((m, i) => {
      const mid = (i === msgs.length - 1) ? String(bj.current_user_message_id || 'msg-' + i) : 'msg-' + i;
      entries[mid] = {
        id: mid, parentId: prev, childrenIds: [], role: m.role, content: m.content,
        timestamp: Math.floor(Date.now() / 1000), models: [bj.model || 'x-preview-l']
      };
      if (prev && entries[prev]) entries[prev].childrenIds = [mid];
      prev = mid;
    });
    const aid = String(bj.id || 'assistant-duptrap');
    entries[aid] = {
      id: aid, parentId: prev, childrenIds: [], role: 'assistant',
      content: 'Response already written by the server (duptrap mode).',
      timestamp: Math.floor(Date.now() / 1000), done: true, model: bj.model || 'x-preview-l'
    };
    if (prev && entries[prev]) entries[prev].childrenIds = [aid];
    const chat = state.persistedChat || defaultChat();
    chat.history = { messages: entries, currentId: aid };
    state.persistedChat = chat;
    sse(res, { data: { message: { delta_content: 'partial response received — ' } } });
    res.end(); // no [DONE]
    return;
  }
  // sse_ok
  sse(res, { data: { message: { phase: 'thinking' } } });
  sse(res, { data: { message: { delta_content: 'Hello! This is an automatic response — part 1. ' } } });
  sse(res, { data: { message: { delta_content: 'Part 2 complete.' } } });
  sse(res, { data: { message: { done: true, delta_content: '' } } });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleUpload(req, res) {
  const raw = await readBody(req);
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] || '');
  const boundary = m ? (m[1] || m[2]) : null;
  const parts = boundary ? parseMultipart(raw, boundary.trim()) : [];
  const file = parts.find((p) => p.name === 'file');
  state.uploads += 1;
  const id = 'file-' + state.uploads;
  const info = {
    id: id,
    filename: (file && file.filename) || 'untitled',
    type: (file && file.contentType) || 'application/octet-stream',
    size: file ? file.data.length : 0
  };
  state.uploadLog.push(info);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    code: 0,
    data: { file: { id: info.id, filename: info.filename, type: info.type, meta: { size: info.size }, direct_url: 'http://localhost:' + PORT + '/files/f-' + state.uploads } }
  }));
}

function defaultChat() {
  return { id: CHAT_ID, title: 'Mock chat', history: { messages: {}, currentId: null } };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const p = u.pathname;

  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'page.html')));
        return;
      }
      if (p === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'app.js')));
        return;
      }
      if (p.startsWith('/files/')) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end('mock-file');
        return;
      }
      if (p === '/api/v1/chats/' + CHAT_ID) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.persistedChat || defaultChat()));
        return;
      }
      /* chat list — GET /api/v1/chats/?page=N&type=default -> array
         (protocol spec: {id, title, updated_at}; page 2 is empty) */
      if (p === '/api/v1/chats/' || p === '/api/v1/chats') {
        const page = Number(u.searchParams.get('page') || '1');
        if (page <= 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: CHAT_ID, title: (state.persistedChat && state.persistedChat.title) || 'Mock chat', updated_at: Math.floor(Date.now() / 1000) },
            { id: CHAT2_ID, title: 'Second mock chat', updated_at: 1700000010 }
          ]));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[]');
        }
        return;
      }
      if (p === '/api/v1/chats/' + CHAT2_ID) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(secondChat()));
        return;
      }
      if (p === '/_log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requests: state.requests, persists: state.persists, uploads: state.uploadLog }));
        return;
      }
    }

    if (req.method === 'DELETE' && p === '/_log') {
      state.requests = [];
      state.persists = [];
      state.uploadLog = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === 'POST') {
      if (p === '/api/v2/chat/completions') {
        await handleCompletion(req, res);
        return;
      }
      if (p === '/api/v1/storage/pfs/files/upload') {
        await handleUpload(req, res);
        return;
      }
      if (p === '/api/v1/chats/' + CHAT_ID) {
        const raw = await readBody(req);
        let j = null;
        try { j = JSON.parse(raw.toString('utf8')); } catch (e) { j = null; }
        const chat = (j && j.chat) ? j.chat : j;
        state.persistedChat = chat;
        state.persists.push({
          t: Date.now(),
          currentId: chat && chat.history ? chat.history.currentId : null,
          chat: chat
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (p === '/_ctl') {
        const raw = await readBody(req);
        let j = null;
        try { j = JSON.parse(raw.toString('utf8')); } catch (e) { j = null; }
        if (j && Array.isArray(j.script)) state.script = j.script.slice();
        if (j && j.resetPersist) { state.persistedChat = null; }
        if (j && Array.isArray(j.uploads)) { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queue: state.script.length }));
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"detail":"not found"}');
  } catch (e) {
    try { res.writeHead(500); res.end('{"detail":"server error"}'); } catch (e2) { /* ignore */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock server: http://localhost:' + PORT + ' (chat_id=' + CHAT_ID + ')');
});
