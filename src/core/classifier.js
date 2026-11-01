/*
 * better z.ai — ortaq təsnifat modulu.
 * MAIN world, ISOLATED world və Node vm test kontekstində işləyir.
 * Mənbə: LEGACY_SPEC §5 (zai_protokol_spec.md) — z.ai SSE protokolunun dəqiq
 * xəta təsnifatı əsasında.
 */
(function (root) {
  'use strict';
  var C = root.__zaiExtCore = root.__zaiExtCore || {};

  var RETRYABLE_HTTP = [408, 425, 429, 500, 502, 503, 504, 509, 520, 521, 522, 523, 524, 525, 527, 529];
  var NONRETRY_HTTP = [400, 401, 403, 404, 405, 409, 410, 413, 422, 426];
  var BUSY_RE = /global_limit|user_limit|rate_limit|too many requests|system is busy|server is busy|busy|overload|overloaded|temporar|try again|timeout|timed out|unavailable|internal server|upstream|waf|频繁|繁忙|稍后再试|网络错误/i;
  var FATAL_RE = /captcha|outdated|signature|unauthor|forbidden|permission|invalid|not found|quota|exceed|policy|moderation|illegal|敏感|违规|登录|鉴权|签名/i;

  C.RETRYABLE_HTTP = RETRYABLE_HTTP;
  C.NONRETRY_HTTP = NONRETRY_HTTP;
  C.BUSY_RE = BUSY_RE;
  C.FATAL_RE = FATAL_RE;

  C.isHtmlBody = function (t) {
    return /^\s*(?:<!doctype|<html|<head|<body)/i.test(String(t || ''));
  };

  C.firstLine = function (t, n) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  /* HTTP status + body əsasında təsnifat (SSE-olmayan cavablar, 4xx/5xx) */
  C.classifyHttpError = function (status, bodyText, retryOnHttpError) {
    var t = String(bodyText || '');
    // WAF: 403/405/429/509 + HTML gövdə → retry (LEGACY_SPEC §8)
    if ((status === 403 || status === 405 || status === 429 || status === 509) && C.isHtmlBody(t)) {
      return { outcome: 'retry', reason: 'waf', msg: 'WAF blok (HTML)' };
    }
    if (BUSY_RE.test(t)) return { outcome: 'retry', reason: 'busy', msg: C.firstLine(t, 140) };
    if (RETRYABLE_HTTP.indexOf(status) >= 0) return { outcome: 'retry', reason: 'http_' + status, msg: 'HTTP ' + status };
    if (FATAL_RE.test(t)) return { outcome: 'fatal', reason: 'fatal_text', msg: C.firstLine(t, 140) };
    if (NONRETRY_HTTP.indexOf(status) >= 0) return { outcome: 'fatal', reason: 'http_' + status, msg: 'HTTP ' + status };
    if (retryOnHttpError && status >= 400) return { outcome: 'retry', reason: 'http_' + status, msg: 'HTTP ' + status };
    return { outcome: 'fatal', reason: 'http_' + status, msg: 'HTTP ' + status };
  };

  /* HTTP 200 + JSON gövdə (event-stream deyil) */
  C.classifyBodyText = function (bodyText) {
    var t = String(bodyText || '');
    if (BUSY_RE.test(t)) return { outcome: 'retry', reason: 'busy', msg: C.firstLine(t, 140) };
    if (FATAL_RE.test(t)) return { outcome: 'fatal', reason: 'fatal_text', msg: C.firstLine(t, 140) };
    return { outcome: 'await_user', reason: 'body_200', msg: C.firstLine(t, 140) };
  };

  /*
   * SSE axınının nəticəsi.
   * s: { ended, sawContent, gotDone, errText, hadLines }
   */
  C.classifyStream = function (s) {
    if (s.errText) {
      if (BUSY_RE.test(s.errText)) return { outcome: 'retry', reason: 'busy', msg: C.firstLine(s.errText, 140) };
      if (FATAL_RE.test(s.errText)) return { outcome: 'fatal', reason: 'fatal_text', msg: C.firstLine(s.errText, 140) };
      return { outcome: 'await_user', reason: 'stream_error', msg: C.firstLine(s.errText, 140) };
    }
    if (!s.ended) {
      return { outcome: 'retry', reason: 'stream_cut', msg: s.sawContent ? 'Axın kəsildi (qismən cavab gəldi)' : 'Axın kəsildi' };
    }
    if (!s.gotDone) {
      // LEGACY_SPEC §5: [DONE] və ya done=true olmadan bitən axın = şəbəkə kəsintisi → retry
      return { outcome: 'retry', reason: 'no_done', msg: 'Axın [DONE] olmadan bitdi' };
    }
    if (!s.sawContent) return { outcome: 'await_user', reason: 'empty_stream', msg: 'Boş cavab (yalnız [DONE])' };
    return { outcome: 'success', reason: 'ok', msg: '' };
  };

  function dig(obj, path) {
    for (var i = 0; i < path.length; i++) {
      if (!obj || typeof obj !== 'object') return undefined;
      obj = obj[path[i]];
    }
    return obj;
  }

  /* LEGACY_SPEC §5: message obyekti /data/message → /data/data/message → /message → /data/data/data */
  C.extractMessage = function (j) {
    var m = dig(j, ['data', 'message']);
    if (m && typeof m === 'object') return m;
    m = dig(j, ['data', 'data', 'message']);
    if (m && typeof m === 'object') return m;
    m = dig(j, ['message']);
    if (m && typeof m === 'object') return m;
    m = dig(j, ['data', 'data', 'data']);
    if (m && typeof m === 'object') return m;
    return null;
  };

  C.extractError = function (j) {
    var paths = [['data', 'error'], ['data', 'data', 'error'], ['error']];
    for (var i = 0; i < paths.length; i++) {
      var e = dig(j, paths[i]);
      if (e && typeof e === 'object') return e;
    }
    return null;
  };

  C.errText = function (e) {
    if (!e) return '';
    var c = e.code != null ? String(e.code) : '';
    var ec = e.error_code != null ? String(e.error_code) : '';
    var d = e.detail || e.message || '';
    return [c || ec, d].filter(Boolean).join(' — ');
  };

  /* SÖZ SAYĞACI — boşluqlarla ayrılmış söz sayı (Unicode-safe trim) */
  C.countWords = function (text) {
    var t = String(text || '').trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  };
})(typeof self !== 'undefined' ? self : globalThis);
