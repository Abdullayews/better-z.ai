/*
 * Signature (X-Signature) tests — a CROSS-IMPLEMENTATION check:
 * src/core/sign.js (crypto.subtle)  ==  an independent Node crypto implementation.
 * Both were written separately from LEGACY_SPEC §5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadCore } from './harness.mjs';

const C = loadCore();
const KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';

/* Independent implementation (node:crypto) */
function refSignature(prompt, requestId, userId, ts) {
  const b64 = Buffer.from(String(prompt).trim(), 'utf8').toString('base64');
  const data = `requestId,${requestId},timestamp,${ts},user_id,${userId}|${b64}|${ts}`;
  const g = Math.floor(ts / 300000);
  const subkey = createHmac('sha256', KEY).update(String(g)).digest('hex');
  return createHmac('sha256', subkey).update(data).digest('hex');
}

test('computeSignature — identical to the reference (ASCII)', async () => {
  const ts = 1730000000000;
  const mine = await C.computeSignature('Hello, how are you?', 'req-42', 'user-42', ts);
  const ref = refSignature('Hello, how are you?', 'req-42', 'user-42', ts);
  assert.equal(mine.signature, ref);
});

test('computeSignature — identical to the reference (UTF-8 + emoji + spaces)', async () => {
  const ts = 1730001234567;
  const prompt = '  Hello world 🌊 — with attachments!  ';
  const mine = await C.computeSignature(prompt, 'req-ñ-42', 'user_Ñ', ts);
  const ref = refSignature(prompt, 'req-ñ-42', 'user_Ñ', ts);
  assert.equal(mine.signature, ref);
});

test('b64Utf8 — identical to Buffer', () => {
  const s = 'Baku — 4°C, lots of work 🖼';
  assert.equal(C.b64Utf8(s), Buffer.from(s, 'utf8').toString('base64'));
});

test('formEncode — spec rules', () => {
  assert.equal(C.formEncode('a b'), 'a+b');
  assert.equal(C.formEncode('é!'), '%C3%A9%21');
  assert.equal(C.formEncode('Z*-_.'), 'Z*-_.');
  assert.equal(C.formEncode('2026-11-01T12:00:00.000Z'), '2026-11-01T12%3A00%3A00.000Z');
  assert.equal(C.formEncode('Mon, 01 Nov 2026 12:00:00 GMT'), 'Mon%2C+01+Nov+2026+12%3A00%3A00+GMT');
});

test('resignUrl — signature refreshed, order preserved, ts renewed', async () => {
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
  const r = await C.resignUrl(entries, 'https://chat.z.ai', '/api/v2/chat/completions', 'prompt text', 'req-42', 'user-42', undefined);
  assert.ok(r.ts > Date.now() - 5000);
  // reference signature (with the new ts)
  const ref = refSignature('prompt text', 'req-42', 'user-42', r.ts);
  assert.equal(r.signature, ref);
  // new ts and order in the URL
  const u = new URL(r.url);
  assert.equal(u.pathname, '/api/v2/chat/completions');
  assert.equal(u.searchParams.get('timestamp'), String(r.ts));
  assert.equal(u.searchParams.get('title'), 'Z.ai — Advanced');
  const keys = [...u.searchParams.keys()];
  assert.deepEqual(keys.slice(0, 4), ['timestamp', 'requestId', 'user_id', 'token']);
  // local_time / utc_time were renewed
  assert.equal(u.searchParams.get('local_time'), new Date(r.ts).toISOString());
  assert.match(r.url, /\/api\/v2\/chat\/completions\?timestamp=\d+/);
});
