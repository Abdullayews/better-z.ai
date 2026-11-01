/*
 * İmza (X-Signature) testləri — CROSS-IMPLEMENTATION yoxlaması:
 * src/core/sign.js (crypto.subtle)  ==  müstəqil Node crypto implementasiyası.
 * Hər ikisi LEGACY_SPEC §5-dən ayrı-ayrı yazılıb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadCore } from './harness.mjs';

const C = loadCore();
const KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

/* Müstəqil implementasiya (node:crypto) */
function refSignature(prompt, requestId, userId, ts) {
  const b64 = Buffer.from(String(prompt).trim(), 'utf8').toString('base64');
  const data = `requestId,${requestId},timestamp,${ts},user_id,${userId}|${b64}|${ts}`;
  const g = Math.floor(ts / 300000);
  const subkey = createHmac('sha256', KEY).update(String(g)).digest('hex');
  return createHmac('sha256', subkey).update(data).digest('hex');
}

test('computeSignature — referans ilə eyni (ASCII)', async () => {
  const ts = 1730000000000;
  const mine = await C.computeSignature('Salam, necesən?', 'req-42', 'user-42', ts);
  const ref = refSignature('Salam, necesən?', 'req-42', 'user-42', ts);
  assert.equal(mine.signature, ref);
});

test('computeSignature — referans ilə eyni (UTF-8 + emoji + boşluqlar)', async () => {
  const ts = 1730001234567;
  const prompt = '  Salam dünya 🌊 — attachment-larla birlikdə!  ';
  const mine = await C.computeSignature(prompt, 'req-ü-42', 'user_Ü', ts);
  const ref = refSignature(prompt, 'req-ü-42', 'user_Ü', ts);
  assert.equal(mine.signature, ref);
});

test('b64Utf8 — Buffer ilə eyni', () => {
  const s = 'Bakı — 4°C, çox iş 🖼';
  assert.equal(C.b64Utf8(s), Buffer.from(s, 'utf8').toString('base64'));
});

test('formEncode — spec qaydaları', () => {
  assert.equal(C.formEncode('a b'), 'a+b');
  assert.equal(C.formEncode('ü!'), '%C3%BC%21');
  assert.equal(C.formEncode('Z*-_.'), 'Z*-_.');
  assert.equal(C.formEncode('2026-11-01T12:00:00.000Z'), '2026-11-01T12%3A00%3A00.000Z');
  assert.equal(C.formEncode('Mon, 01 Nov 2026 12:00:00 GMT'), 'Mon%2C+01+Nov+2026+12%3A00%3A00+GMT');
});

test('resignUrl — imza yenilənir, sıra qorunur, ts təzələnir', async () => {
  const oldTs = Date.now() - 600000;
  const entries = [
    ['timestamp', String(oldTs)],
    ['requestId', 'req-42'],
    ['user_id', 'user-42'],
    ['token', 'tkn'],
    ['local_time', new Date(oldTs).toISOString()],
    ['utc_time', new Date(oldTs).toUTCString()],
    ['title', 'Z.ai — Advanced']
  ];
  const r = await C.resignUrl(entries, 'https://chat.z.ai', '/api/v2/chat/completions', 'prompt mətn', 'req-42', 'user-42', undefined);
  assert.ok(r.ts > Date.now() - 5000);
  // referans imza (yeni ts ilə)
  const ref = refSignature('prompt mətn', 'req-42', 'user-42', r.ts);
  assert.equal(r.signature, ref);
  // URL-də yeni ts və sıra
  const u = new URL(r.url);
  assert.equal(u.pathname, '/api/v2/chat/completions');
  assert.equal(u.searchParams.get('timestamp'), String(r.ts));
  assert.equal(u.searchParams.get('title'), 'Z.ai — Advanced');
  const keys = [...u.searchParams.keys()];
  assert.deepEqual(keys.slice(0, 4), ['timestamp', 'requestId', 'user_id', 'token']);
  // local_time / utc_time yeniləndi
  assert.equal(u.searchParams.get('local_time'), new Date(r.ts).toISOString());
  assert.match(r.url, /\/api\/v2\/chat\/completions\?timestamp=\d+/);
});
