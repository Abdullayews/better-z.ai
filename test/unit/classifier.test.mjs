/* Classifier tests (LEGACY_SPEC §5 rules). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const C = loadCore();

test('classifyHttpError — busy JSON', () => {
  const r = C.classifyHttpError(429, '{"detail":"Too many requests. Please slow down."}', true);
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'busy');
});

test('classifyHttpError — WAF HTML (403)', () => {
  const r = C.classifyHttpError(403, '<!doctype html><html><body>blocked by WAF</body></html>', true);
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'waf');
});

test('classifyHttpError — invalid 400 → fatal', () => {
  const r = C.classifyHttpError(400, '{"detail":"invalid request parameters"}', true);
  assert.equal(r.outcome, 'fatal');
});

test('classifyHttpError — 401 session → fatal', () => {
  const r = C.classifyHttpError(401, '{"detail":"unauthorized"}', true);
  assert.equal(r.outcome, 'fatal');
});

test('classifyHttpError — signature error → fatal', () => {
  const r = C.classifyHttpError(401, '{"detail":"invalid signature (mock)"}', true);
  assert.equal(r.outcome, 'fatal');
  assert.match(r.msg, /signature/i);
});

test('classifyHttpError — 503', () => {
  const r = C.classifyHttpError(503, '{"detail":"service unavailable"}', true);
  assert.equal(r.outcome, 'retry');
});

test('classifyStream — global_limit (system is busy) → retry', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: false, errText: 'global_limit — The system is busy. Please try again later.' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'busy');
});

test('classifyStream — captcha → fast retry (1 s)', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: 'FRONTEND_CAPTCHA_REQUIRED — captcha' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'captcha');
  assert.equal(r.fastDelayMs, 1000);
});

test('classifyHttpError — captcha body (403) → fast retry, not fatal', () => {
  const r = C.classifyHttpError(403, '{"error":{"code":"FRONTEND_CAPTCHA_REQUIRED","detail":"captcha required"}}', false);
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'captcha');
  assert.equal(r.fastDelayMs, 1000);
});

test('classifyBodyText — captcha → fast retry', () => {
  const r = C.classifyBodyText('{"error":{"code":"FRONTEND_CAPTCHA_REQUIRED","detail":"captcha required"}}');
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'captcha');
});

test('classifyStream — ended without [DONE] → retry (no_done)', () => {
  const r = C.classifyStream({ ended: true, sawContent: true, gotDone: false, errText: '' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'no_done');
});

test('classifyStream — cut (ended=false), partial response → retry', () => {
  const r = C.classifyStream({ ended: false, sawContent: true, gotDone: false, errText: '' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'stream_cut');
});

test('classifyStream — empty [DONE] → await_user', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: '' });
  assert.equal(r.outcome, 'await_user');
  assert.equal(r.reason, 'empty_stream');
});

test('classifyStream — success', () => {
  const r = C.classifyStream({ ended: true, sawContent: true, gotDone: true, errText: '' });
  assert.equal(r.outcome, 'success');
});

test('classifyStream — unknown stream error → await_user (no auto)', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: 'weird unknown condition xyz' });
  assert.equal(r.outcome, 'await_user');
});

test('extractMessage — /data/message', () => {
  const m = C.extractMessage({ data: { message: { delta_content: 'hello', done: false } } });
  assert.equal(m.delta_content, 'hello');
});

test('extractMessage — /data/data/message', () => {
  const m = C.extractMessage({ data: { data: { message: { delta_content: 'x' } } } });
  assert.equal(m.delta_content, 'x');
});

test('extractMessage — /data/data/data fallback', () => {
  const m = C.extractMessage({ data: { data: { data: { delta_content: 'y', done: true } } } });
  assert.ok(m);
  assert.equal(m.done, true);
});

test('extractError + errText', () => {
  const e = C.extractError({ data: { error: { code: 'global_limit', detail: 'The system is busy.' } } });
  assert.equal(C.errText(e), 'global_limit — The system is busy.');
});

test('isHtmlBody', () => {
  assert.equal(C.isHtmlBody('<!doctype html><html>'), true);
  assert.equal(C.isHtmlBody('{"detail":"x"}'), false);
});

test('classifyBodyText — 200 JSON busy', () => {
  const r = C.classifyBodyText('{"detail":"The system is busy. Please try again later."}');
  assert.equal(r.outcome, 'retry');
});

/* ---------- word counter ---------- */

test('countWords — empty and whitespace texts', () => {
  assert.equal(C.countWords(''), 0);
  assert.equal(C.countWords(null), 0);
  assert.equal(C.countWords('   '), 0);
  assert.equal(C.countWords('\n\t  '), 0);
});

test('countWords — plain and multi-line text', () => {
  assert.equal(C.countWords('hello'), 1);
  assert.equal(C.countWords('  one two three  '), 3);
  assert.equal(C.countWords('one\ntwo\tthree\tfour'), 4);
});

test('countWords — non-ASCII letters and punctuation', () => {
  assert.equal(C.countWords('Hello, world! Again?'), 3);
  assert.equal(C.countWords('image — file.pdf uploaded'), 4); // «—» counts as its own token
});
