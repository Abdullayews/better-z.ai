/* Classifier testləri (LEGACY_SPEC §5 qaydaları). */
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

test('classifyHttpError — 401 sessiya → fatal', () => {
  const r = C.classifyHttpError(401, '{"detail":"unauthorized"}', true);
  assert.equal(r.outcome, 'fatal');
});

test('classifyHttpError — imza xətası → fatal', () => {
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

test('classifyStream — captcha → fatal', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: 'FRONTEND_CAPTCHA_REQUIRED — captcha' });
  assert.equal(r.outcome, 'fatal');
});

test('classifyStream — [DONE] olmadan bitdi → retry (no_done)', () => {
  const r = C.classifyStream({ ended: true, sawContent: true, gotDone: false, errText: '' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'no_done');
});

test('classifyStream — kəsinti (ended=false), qismən cavab → retry', () => {
  const r = C.classifyStream({ ended: false, sawContent: true, gotDone: false, errText: '' });
  assert.equal(r.outcome, 'retry');
  assert.equal(r.reason, 'stream_cut');
});

test('classifyStream — boş [DONE] → await_user', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: '' });
  assert.equal(r.outcome, 'await_user');
  assert.equal(r.reason, 'empty_stream');
});

test('classifyStream — uğur', () => {
  const r = C.classifyStream({ ended: true, sawContent: true, gotDone: true, errText: '' });
  assert.equal(r.outcome, 'success');
});

test('classifyStream — naməlum axın xətası → await_user (avtomatik yox)', () => {
  const r = C.classifyStream({ ended: true, sawContent: false, gotDone: true, errText: 'weird unknown condition xyz' });
  assert.equal(r.outcome, 'await_user');
});

test('extractMessage — /data/message', () => {
  const m = C.extractMessage({ data: { message: { delta_content: 'salam', done: false } } });
  assert.equal(m.delta_content, 'salam');
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

/* ---------- söz sayğacı ---------- */

test('countWords — boş və boşluqlu mətnlər', () => {
  assert.equal(C.countWords(''), 0);
  assert.equal(C.countWords(null), 0);
  assert.equal(C.countWords('   '), 0);
  assert.equal(C.countWords('\n\t  '), 0);
});

test('countWords — adi və çoxsətirli mətn', () => {
  assert.equal(C.countWords('salam'), 1);
  assert.equal(C.countWords('  bir iki üç  '), 3);
  assert.equal(C.countWords('bir\niki\tüç\tdörd'), 4);
});

test('countWords — Azərbaycan hərfləri və punktuasiya', () => {
  assert.equal(C.countWords('Salam, dünya! Necəsən?'), 3);
  assert.equal(C.countWords('şəkil — fayl.pdf yükləndi'), 4); // «—» ayrı token kimi sayılır
});
