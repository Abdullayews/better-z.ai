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
