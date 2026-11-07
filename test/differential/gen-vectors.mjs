/*
 * better z.ai — differential vector generator.
 *
 * Runs the REAL JavaScript core (src/core/{classifier,backoff,sign}.js) in a
 * Node vm and records its outputs for a fixed set of inputs.
 * The output (core-wasm/tests/vectors.json) is consumed by:
 *   - cargo test in core-wasm/       (native Rust must match every vector)
 *   - test/unit/wasm.test.mjs        (the actual .wasm artifact, via the
 *                                     real wasm-loader.js, must match too)
 *
 * All inputs are deterministic (fixed timestamps, fixed rand values).
 *
 * Usage:  node test/differential/gen-vectors.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../unit/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'core-wasm', 'tests', 'vectors.json');

const C = loadCore();

/* ------------------------------------------------------------------ */
/* 1) signature                                                        */
/* ------------------------------------------------------------------ */
const SIG_CASES = [
  ['Hello, how are you?', 'req-42', 'user-42', 1730000000000],
  ['  Hello world 🌊 — with attachments!  ', 'req-ñ-42', 'user_Ñ', 1730001234567],
  ['', 'r', 'u', 1730000000000],                       // empty prompt
  ['   \t\n  ', 'r', 'u', 1730000000000],               // whitespace-only → trim
  ['Salam \u00a0dünya — Şəki, Bakı 🖼', 'id-ş-1', 'istifadəçi_1', 1700000000123],
  ['a'.repeat(9000), 'req-long', 'user-long', 1767225600000],
  ['multi\nline\ttext with  spaces', 'req-m', 'user-m', 1767225600001],
  ['x', 'r', 'u', 300000 * 5770000],                    // exact window boundary
  ['x', 'r', 'u', 300000 * 5770000 - 1],                // boundary − 1
  ['x', 'r', 'u', 300000 * 5770000 + 1],                // boundary + 1
  ['x', 'r', 'u', 4102444800000],                       // year 2100
  ['Ünsiköd çaractérè', 'req-ü', 'user-ü', 0]           // epoch
];
const signature = [];
for (const [prompt, req, user, ts] of SIG_CASES) {
  const r = await C.computeSignature(prompt, req, user, ts);
  signature.push({ prompt, req, user, ts, sig: r.signature, data: r.data });
}

/* ------------------------------------------------------------------ */
/* 2) formEncode                                                       */
/* ------------------------------------------------------------------ */
const formEncode = [
  'a b', 'é!', 'Z*-_.', '2026-11-01T12:00:00.000Z', 'Mon, 01 Nov 2026 12:00:00 GMT',
  '', ' ', 'a+b', '100%', 'tilde~caret^', 'ş ğ ü ö ç İ ə',
  'k=v&x=y?z/w#f', '\\\n\r\t"\'<>{}|', 'emoji🌊surf', 'ABC abc 123'
].map((s) => ({ in: s, out: C.formEncode(s) }));

/* ------------------------------------------------------------------ */
/* 3) b64Utf8                                                          */
/* ------------------------------------------------------------------ */
const b64 = [
  '', 'Baku — 4°C, lots of work 🖼', 'a'.repeat(300),
  'Salam dünya', '≈≠÷×±∞'
].map((s) => ({ in: s, out: C.b64Utf8(s) }));

/* ------------------------------------------------------------------ */
/* 4) hmacHex                                                          */
/* ------------------------------------------------------------------ */
const hmac = [];
// NOTE: no empty-KEY case — WebCrypto (Node) rejects zero-length HMAC keys;
// production only ever uses the fixed SIGNATURE_KEY or the 64-char hex subkey.
for (const [k, m] of [
  ['key', 'message'],
  ['key-@@@@)))()((9))-xxxx&&&%%%%%', '19233'],
  ['k', ''], ['ünïcode', 'şifrə 🔑']
]) {
  hmac.push({ key: k, msg: m, out: await C.hmacHex(k, m) });
}

/* ------------------------------------------------------------------ */
/* 5) firstLine                                                        */
/* ------------------------------------------------------------------ */
const firstLine = [
  ['short text', 40],
  ['exactly40chars—exactly40chars—exactly4', 40],       // length == n
  ['a'.repeat(50), 40],                                  // ASCII cut
  ['word word word word word word word', 20],
  ['  \n\t multiple   whitespace\n\nlines  ', 60],      // collapse + trim
  ['ünïcode trim\u00a0\u3000', 30],                      // NBSP + ideographic space trim
  ['🌊 emoji test 🌊 emoji test 🌊', 12],                 // multi-byte near boundary (no split)
  ['x'.repeat(139) + 'ē', 140],                          // n-th char is 2-byte, no split
  ['', 100],
  ['分词测试：系统繁忙，请稍后再试 global_limit', 140]
].map(([t, n]) => ({ t, n, out: C.firstLine(t, n) }));

/* ------------------------------------------------------------------ */
/* 6) countWords                                                       */
/* ------------------------------------------------------------------ */
const countWords = [
  '', '   ', 'one', 'one two  three', '\n\t x \u00a0 y \u3000 z ',
  'Salam dünya — Şəki', 'word\u2003with\tem space', '🌊🌊🌊'
].map((t) => ({ in: t, out: C.countWords(t) }));

/* ------------------------------------------------------------------ */
/* 7) isHtmlBody                                                       */
/* ------------------------------------------------------------------ */
const isHtmlBody = [
  '<!doctype html><html><body>blocked</body></html>',
  '<HTML>', '<head>', '  \n\t <body x=1>', 'DOCTYPE', 'plain text',
  '{"error":"x"}', '', ' <html' // leading whitespace is allowed
].map((t) => ({ in: t, out: C.isHtmlBody(t) }));

/* ------------------------------------------------------------------ */
/* 8) classifyHttpError                                                */
/* ------------------------------------------------------------------ */
const HTTP_BODIES = [
  '',
  'System is busy, please try again',
  '<!doctype html><html><head><title>403</title></head><body>cloudflare</body></html>',
  'FRONTEND_CAPTCHA_REQUIRED — please verify',
  '{"error":{"code":"global_limit","detail":"too many requests"}}',
  '{"error":{"code":"1002","detail":"signature expired"}}',
  '系统繁忙，请稍后再试',
  'unauthorized: invalid token',
  'just some random text',
  'temporarily unavailable — upstream'
];
const HTTP_STATUSES = [400, 401, 403, 404, 405, 409, 413, 422, 425, 426, 429, 500, 502, 503, 504, 509, 520, 521, 522, 523, 524, 525, 527, 529, 599, 200];
const classifyHttp = [];
for (const status of HTTP_STATUSES) {
  for (const body of HTTP_BODIES) {
    for (const retry of [true, false]) {
      const r = C.classifyHttpError(status, body, retry);
      classifyHttp.push({ status, body, retry, out: r });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 9) classifyBodyText                                                 */
/* ------------------------------------------------------------------ */
const classifyBody = HTTP_BODIES.concat(['{"ok":true,"answer":"hi"}', 'overloaded! QuotaExceeded?']).map((body) => ({
  body,
  out: C.classifyBodyText(body)
}));

/* ------------------------------------------------------------------ */
/* 10) classifyStream                                                  */
/* ------------------------------------------------------------------ */
const STREAM_STATES = [
  { ended: true, sawContent: true, gotDone: true, errText: '', hadLines: true },
  { ended: true, sawContent: false, gotDone: true, errText: '', hadLines: true },
  { ended: true, sawContent: true, gotDone: false, errText: '', hadLines: true },
  { ended: false, sawContent: true, gotDone: false, errText: '', hadLines: true },
  { ended: false, sawContent: false, gotDone: false, errText: '', hadLines: false },
  { ended: true, sawContent: true, gotDone: true, errText: 'global_limit — system is busy', hadLines: true },
  { ended: true, sawContent: true, gotDone: true, errText: 'FRONTEND_CAPTCHA_REQUIRED', hadLines: true },
  { ended: true, sawContent: true, gotDone: true, errText: 'signature expired', hadLines: true },
  { ended: true, sawContent: true, gotDone: true, errText: 'weird unknown error', hadLines: true },
  { ended: true, sawContent: true, gotDone: true, errText: '系统繁忙', hadLines: true }
];
const classifyStream = STREAM_STATES.map((s) => {
  const slim = { ended: s.ended, sawContent: s.sawContent, gotDone: s.gotDone, errText: s.errText, hadLines: s.hadLines };
  return { state: slim, out: C.classifyStream(slim) };
});

/* ------------------------------------------------------------------ */
/* 11) extractMessage / extractError / errText                         */
/* ------------------------------------------------------------------ */
const PAYLOADS = [
  '{"data":{"message":{"delta_content":"hi","done":true}}}',
  '{"data":{"data":{"message":{"role":"assistant","done":false}}}}',
  '{"message":{"content":"top-level"}}',
  '{"data":{"data":{"data":{"nested":"deep"}}}}',
  '{"data":{"message":"not an object"}}',
  '{"data":{"message":123}}',
  '{"data":{"message":null}}',
  '{"data":{"message":[1,2,3]}}',
  '{"data":{"error":{"code":"global_limit","detail":"busy"}}}',
  '{"data":{"data":{"error":{"code":"x"}}}}',
  '{"error":{"error_code":"E_5","message":"signature expired"}}',
  '{"error":{"code":42,"detail":"numeric code"}}',
  '{"error":{"error_code":7}}',
  '{"error":{"detail":"","message":"fallback message"}}',
  '{"error":{"detail":null,"message":"msg picked"}}',
  '{"error":{"code":"c","detail":"d","message":"m"}}',
  '{"nothing":"here"}',
  'null',
  '{"data":{"data":{"data":"string not object"},"message":{"m":1}}}'
];
const extractMessage = PAYLOADS.map((raw) => {
  const j = JSON.parse(raw);
  const m = C.extractMessage(j);
  return { raw, out: m === null ? null : JSON.stringify(m) };
});
const extractError = PAYLOADS.map((raw) => {
  const j = JSON.parse(raw);
  const e = C.extractError(j);
  return { raw, out: e === null ? null : JSON.stringify(e) };
});
const errText = PAYLOADS.map((raw) => {
  const j = JSON.parse(raw);
  const e = C.extractError(j);
  return { raw, out: C.errText(e) };
});

/* ------------------------------------------------------------------ */
/* 12) computeDelay (grid)                                             */
/* ------------------------------------------------------------------ */
const delayCases = [];
for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8, 0, -2, 2.9]) {
  for (const cfg of [
    { initialDelayMs: 5000, backoffFactor: 2, maxDelayMs: 120000, jitter: 0 },
    { initialDelayMs: 5000, backoffFactor: 2, maxDelayMs: 120000, jitter: 0.25 },
    { initialDelayMs: 2000, backoffFactor: 1.6, maxDelayMs: 5000, jitter: 0.1 },
    { initialDelayMs: 5000, backoffFactor: 3, maxDelayMs: 60000, jitter: 1 },
    { initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 120000, jitter: 0 },      // min 400 clamp
    { initialDelayMs: 5000, backoffFactor: 2, maxDelayMs: 900, jitter: 0 },        // max clamp
    { initialDelayMs: 5000, backoffFactor: 1, maxDelayMs: 120000, jitter: 0.5 },
    { initialDelayMs: 7000, backoffFactor: 1.3, maxDelayMs: 30000, jitter: 0.75 }
  ]) {
    for (const rand of [0, 0.3, 0.5, 1]) {
      const out = C.computeDelay(attempt, cfg, () => rand);
      // resolved values (what the wasm wrapper passes after JS `||` coercion)
      const resolved = {
        initial: (cfg && cfg.initialDelayMs) || 5000,
        factor: (cfg && cfg.backoffFactor) || 2,
        max: (cfg && cfg.maxDelayMs) || 120000,
        jitter: (cfg && cfg.jitter) || 0
      };
      delayCases.push({ attempt, cfg, rand, resolved, out });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 13) applyRetryAfter                                                 */
/* ------------------------------------------------------------------ */
const retryAfter = [
  [5000, null], [5000, undefined], [5000, 0], [5000, -100],
  [5000, 0.5], [5000, 999], [5000, 1000], [5000, 1500.4],
  [5000, 300000], [5000, 999999], [5000, '2500'], [5000, 'abc'], [5000, 42]
].map(([d, ra]) => ({ d, ra, out: C.applyRetryAfter(d, ra) }));

/* ------------------------------------------------------------------ */
/* 14) congestionMultiplier                                            */
/* ------------------------------------------------------------------ */
const congestion = [-1, 0, 1, 2, 3, 4, 5, 6, 9, 2.7, 100].map((n) => ({
  n,
  out: C.congestionMultiplier(n)
}));

/* ------------------------------------------------------------------ */
/* 15) resignUrl                                                       */
/* ------------------------------------------------------------------ */
const RESIGN_TS = 1767225600000; // 2026-01-01T00:00:00.000Z
const resignUrl = [];
const resignCases = [
  {
    entries: [
      ['timestamp', '1767000000000'], ['signature_timestamp', '1767000000000'],
      ['requestId', 'req-42'], ['user_id', 'user-42'], ['token', 'tkn'],
      ['local_time', '2025-12-29T04:00:00.000Z'], ['utc_time', 'Mon, 29 Dec 2025 04:00:00 GMT'],
      ['title', 'Z.ai — Advanced']
    ],
    origin: 'https://chat.z.ai', pathname: '/api/v2/chat/completions',
    prompt: 'Hello, how are you?', requestId: 'req-42', userId: 'user-42'
  },
  {
    entries: [['requestId', 'r'], ['user_id', 'u'], ['timestamp', '1'], ['title', 'ş ğ ü — 🌊'], ['empty', '']],
    origin: 'https://chat.z.ai', pathname: '/api/v1/chat/completions',
    prompt: 'Salam dünya 🌊 — attachment var', requestId: 'r-ñ', userId: 'u-ñ'
  },
  {
    entries: [['a', '1'], ['a', '2'], ['b', 'x y+z&?']],
    origin: 'https://chat.z.ai', pathname: '/api/chat/completions',
    prompt: '', requestId: 'req', userId: 'usr'
  }
];
for (const c of resignCases) {
  const r = await C.resignUrl(c.entries, c.origin, c.pathname, c.prompt, c.requestId, c.userId, RESIGN_TS);
  resignUrl.push({ entries: c.entries, origin: c.origin, pathname: c.pathname, prompt: c.prompt, requestId: c.requestId, userId: c.userId, now: RESIGN_TS, out: r });
}

/* ------------------------------------------------------------------ */
/* 16) dates (toISOString / toUTCString)                               */
/* ------------------------------------------------------------------ */
const DATE_TSS = [
  1767225600000, 1730000000000, 0, -86400000, 951782400000,
  1709164800000, 1735689599999, 1735689600000, 4102444800000,
  253402300799999, 123456789, 9999999999999
];
const dates = DATE_TSS.map((ts) => ({
  ts,
  iso: new Date(ts).toISOString(),
  utc: new Date(ts).toUTCString()
}));

/* ------------------------------------------------------------------ */
/* write                                                               */
/* ------------------------------------------------------------------ */
const vectors = {
  signature, formEncode, b64, hmac, firstLine, countWords, isHtmlBody,
  classifyHttp, classifyBody, classifyStream,
  extractMessage, extractError, errText,
  delay: delayCases, retryAfter, congestion, resignUrl, dates
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(vectors, null, 1) + '\n', 'utf8');

const counts = Object.fromEntries(Object.entries(vectors).map(([k, v]) => [k, v.length]));
console.log('vectors.json written:', OUT);
console.log(JSON.stringify(counts), 'total =', Object.values(counts).reduce((a, b) => a + b, 0));
