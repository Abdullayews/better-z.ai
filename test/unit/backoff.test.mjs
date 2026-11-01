/* Backoff testləri. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const C = loadCore();

const cfg = { initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 10000, jitter: 0 };

test('computeDelay — artım 1s→2s→4s', () => {
  const zero = () => 0.5; // jitter 0 → rand əhəmiyyətsiz
  assert.equal(C.computeDelay(1, cfg, zero), 1000);
  assert.equal(C.computeDelay(2, cfg, zero), 2000);
  assert.equal(C.computeDelay(3, cfg, zero), 4000);
});

test('computeDelay — maxDelay limiti', () => {
  assert.equal(C.computeDelay(5, cfg, () => 0.5), 10000);
  assert.equal(C.computeDelay(20, cfg, () => 0.5), 10000);
});

test('computeDelay — jitter aşağı/uxarı sərhədləri', () => {
  const j = { initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 100000, jitter: 0.2 };
  const lo = C.computeDelay(3, j, () => 0);   // 4000 → -400
  const hi = C.computeDelay(3, j, () => 1);   // 4000 → +400
  assert.equal(lo, 3600);
  assert.equal(hi, 4400);
});

test('computeDelay — min 400ms clamp', () => {
  const tiny = { initialDelayMs: 300, backoffFactor: 2, maxDelayMs: 100000, jitter: 0 };
  assert.equal(C.computeDelay(1, tiny, () => 0.5), 400);
});

test('applyRetryAfter — server başlığı üstünlük təşkil edir', () => {
  assert.equal(C.applyRetryAfter(5000, 1200), 1200);
  assert.equal(C.applyRetryAfter(5000, null), 5000);
  assert.equal(C.applyRetryAfter(5000, 0), 5000);
});

test('applyRetryAfter — clamp 1s..300s', () => {
  assert.equal(C.applyRetryAfter(5000, 200), 1000);
  assert.equal(C.applyRetryAfter(5000, 999999), 300000);
});

/* ---------- adaptiv backoff (congestion amili) ---------- */

test('congestionMultiplier — 0→x1.0, 1→x1.5, 2→x2.0', () => {
  assert.equal(C.congestionMultiplier(0), 1.0);
  assert.equal(C.congestionMultiplier(1), 1.5);
  assert.equal(C.congestionMultiplier(2), 2.0);
  assert.equal(C.congestionMultiplier(3), 2.5);
});

test('congestionMultiplier — 4+ → maksimum x3.0 (cap)', () => {
  assert.equal(C.congestionMultiplier(4), 3.0);
  assert.equal(C.congestionMultiplier(9), 3.0);
  assert.equal(C.congestionMultiplier(100), 3.0);
});

test('congestionMultiplier — mənfi/yalnış dəyirlər x1.0 verir', () => {
  assert.equal(C.congestionMultiplier(-5), 1.0);
  assert.equal(C.congestionMultiplier(NaN), 1.0);
});

test('adaptiv gecikmə = computeDelay × amil (x1.5 halı)', () => {
  const d = C.computeDelay(2, cfg, () => 0.5); // 2000
  assert.equal(Math.round(d * C.congestionMultiplier(1)), 3000);
});
