/*
 * Z.ai Auto-Resend — eksponensial geri çəkilmə (backoff) modulu.
 */
(function (root) {
  'use strict';
  var C = root.__zaiExtCore = root.__zaiExtCore || {};

  /*
   * attempt: 1-əsaslı retry nömrəsi
   * cfg: { initialDelayMs, backoffFactor, maxDelayMs, jitter }
   * rand: test üçün əvəzlənə bilən təsadüfi funksiya
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

  /* Retry-After başlığı varsa onu prioritet veririk (serverin istəyi) */
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
   * v1.3.0 ADAPTİV BACKOFF — tıxanma (congestion) amili.
   * Ardıcıl busy/rate-limit nəticələri artdıqca gecikmələr uzanır:
   * 0 → x1.0, 1 → x1.5, 2 → x2.0, 3 → x2.5, 4+ → x3.0 (maksimum).
   * Uğur gələn kimi 0-a düşür (content.js tərəfindən idarə olunur).
   */
  C.congestionMultiplier = function (consecutiveBusy) {
    var n = Math.max(0, consecutiveBusy | 0);
    return 1 + 0.5 * Math.min(4, n);
  };
})(typeof self !== 'undefined' ? self : globalThis);
