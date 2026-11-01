/*
 * better z.ai — exponential backoff module.
 */
(function (root) {
  'use strict';
  var C = root.__zaiExtCore = root.__zaiExtCore || {};

  /*
   * attempt: 1-based retry number
   * cfg: { initialDelayMs, backoffFactor, maxDelayMs, jitter }
   * rand: replaceable random function for tests
   */
  C.computeDelay = function (attempt, cfg, rand) {
    if (typeof rand !== 'function') rand = Math.random;
    attempt = Math.max(1, attempt | 0);
    var initial = cfg && cfg.initialDelayMs || 5000;
    var factor = cfg && cfg.backoffFactor || 2;
    var maxDelay = cfg && cfg.maxDelayMs || 120000;
    var jitter = cfg && cfg.jitter || 0;

    var base = initial * Math.pow(factor, attempt - 1);
    base = Math.min(base, maxDelay);
    var spread = base * jitter;
    var d = Math.round(base - spread / 2 + spread * rand());
    if (d < 400) d = 400;
    return Math.min(d, maxDelay);
  };

  /* If a Retry-After header is present, it takes priority (the server's request) */
  C.applyRetryAfter = function (delayMs, retryAfterMs) {
    var r = Number(retryAfterMs);
    if (r > 0) {
      r = Math.round(r);
      if (r < 1000) r = 1000;
      if (r > 300000) r = 300000;
      return r;
    }
    return delayMs;
  };

  /*
   * ADAPTIVE BACKOFF — congestion factor.
   * Delays stretch as serial busy/rate-limit results pile up:
   * 0 → x1.0, 1 → x1.5, 2 → x2.0, 3 → x2.5, 4+ → x3.0 (maximum).
   * Resets to 0 as soon as a success arrives (managed by content.js).
   */
  C.congestionMultiplier = function (consecutiveBusy) {
    var n = Math.max(0, consecutiveBusy | 0);
    return 1 + 0.5 * Math.min(4, n);
  };
})(typeof self !== 'undefined' ? self : globalThis);
