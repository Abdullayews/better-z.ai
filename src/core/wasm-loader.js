/*
 * better z.ai — WASM core loader (Variant B glue).
 *
 * Loads the Rust core (zai-core-wasm, base64-embedded by build-wasm.py into
 * wasm-embedded.js) and patches __zaiExtCore with the WASM-backed versions.
 *
 * Design guarantees:
 *   - SYNCHRONOUS instantiation (new WebAssembly.Instance) — the patched
 *     functions are ready before the page's first fetch() fires, because
 *     inject.js hooks fetch at document_start;
 *   - ZERO wasm imports → no wasm-bindgen glue, works in the MAIN world
 *     (no chrome.runtime.getURL there), the ISOLATED world, extension
 *     pages and Node (tests) alike;
 *   - the original JS implementations are kept and used as a PER-CALL
 *     fallback: if WebAssembly is unavailable (CSP!), the blob is missing,
 *     the arena overflows or a call traps, that single call transparently
 *     runs the JS reference instead;
 *   - if src/core/wasm-embedded.js is absent (no Rust toolchain), this file
 *     is a no-op and the extension behaves exactly as the pure-JS build.
 */
(function (root) {
  'use strict';
  var C = root.__zaiExtCore;
  if (!C || C.__wasmPatched) return;
  var B64 = root.__zaiExtWasmB64;
  if (!B64 || typeof WebAssembly === 'undefined' || typeof atob !== 'function') return;

  /* ---------- instantiate ---------- */
  var E;
  try {
    var bin = atob(B64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    E = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
    if (!E || typeof E.wz_version !== 'function' || typeof E.walloc !== 'function') return;
  } catch (e) {
    return; // WebAssembly blocked (CSP) or blob corrupted → pure JS
  }

  var TE = new TextEncoder();
  var TD = new TextDecoder();
  var JS = {}; // original JS implementations (kept as fallback)

  /* ---------- marshalling ---------- */
  /* NOTE: a wasm call may allocate and grow memory, which DETACHES the old
   * ArrayBuffer — always re-read E.memory.buffer, never cache it. Contents
   * (and thus previously written inputs) survive a growth. */

  function writeStr(s) {
    var b = TE.encode(s);
    var p = E.walloc(b.length);
    if (p === 0) throw new Error('wasm arena exhausted');
    new Uint8Array(E.memory.buffer, p, b.length).set(b);
    return [p, b.length]; // UTF-8 byte length, NOT the UTF-16 string length
  }

  function readResult(p) {
    if (p === 0) throw new Error('wasm call failed');
    var m = E.memory.buffer;
    var len = new DataView(m).getUint32(p, true);
    return TD.decode(new Uint8Array(m, p + 4, len));
  }

  /* marshal(args): strings become (ptr,len) pairs, numbers pass through */
  function marshal(fn, args) {
    var argv = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') {
        var w = writeStr(a);
        argv.push(w[0], w[1]);
      } else {
        argv.push(a);
      }
    }
    try {
      return fn.apply(null, argv);
    } finally {
      E.wreset();
    }
  }

  function wstr(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var r = marshal(E[name], args);
    return readResult(r);
  }

  function wnum(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return marshal(E[name], args);
  }

  /* ---------- patching (each function: wasm first, JS fallback per call) ---------- */

  function patch(name, wrapped) {
    if (typeof C[name] !== 'function') return; // e.g. sign.js not loaded in the ISOLATED world
    JS[name] = C[name];
    C[name] = wrapped;
  }

  try {
    C.__wasmVersion = wstr('wz_version');
  } catch (e) {
    return; // incompatible binary → pure JS
  }
  C.__wasmPatched = true; // idempotency guard (set before patching begins)

  /* ----- sign.js ----- */

  patch('formEncode', function (v) {
    try { return wstr('wz_form_encode', String(v)); }
    catch (e) { return JS.formEncode.call(C, v); }
  });

  patch('b64Utf8', function (s) {
    try { return wstr('wz_b64_utf8', String(s)); }
    catch (e) { return JS.b64Utf8.call(C, s); }
  });

  patch('hmacHex', function (keyStr, msg) {
    try { return wstr('wz_hmac_hex', String(keyStr), String(msg)); }
    catch (e) { return JS.hmacHex.call(C, keyStr, msg); }
  });

  patch('computeSignature', function (prompt, requestId, userId, ts) {
    try {
      return JSON.parse(wstr('wz_compute_signature',
        String(prompt), String(requestId), String(userId), Number(ts)));
    } catch (e) {
      return JS.computeSignature.call(C, prompt, requestId, userId, ts);
    }
  });

  patch('resignUrl', function (queryEntries, origin, pathname, prompt, requestId, userId, nowMs) {
    try {
      var now = nowMs || Date.now();
      return JSON.parse(wstr('wz_resign_url',
        JSON.stringify(queryEntries || []),
        String(origin || ''), String(pathname || ''),
        String(prompt || ''), String(requestId || ''), String(userId || ''),
        now));
    } catch (e) {
      return JS.resignUrl.call(C, queryEntries, origin, pathname, prompt, requestId, userId, nowMs);
    }
  });

  /* ----- backoff.js ----- */

  patch('computeDelay', function (attempt, cfg, rand) {
    try {
      var r = typeof rand === 'function' ? rand() : Math.random();
      var c = cfg || {};
      return E.wz_compute_delay(
        Number(attempt) || 0,
        c.initialDelayMs || 5000,
        c.backoffFactor || 2,
        c.maxDelayMs || 120000,
        c.jitter || 0,
        r
      );
    } catch (e) {
      return JS.computeDelay.call(C, attempt, cfg, rand);
    }
  });

  patch('applyRetryAfter', function (delayMs, retryAfterMs) {
    try {
      var r = Number(retryAfterMs);
      if (!(r > 0)) return delayMs; // undefined/null/0/NaN → keep the backoff delay
      return E.wz_apply_retry_after(delayMs, r);
    } catch (e) {
      return JS.applyRetryAfter.call(C, delayMs, retryAfterMs);
    }
  });

  patch('congestionMultiplier', function (n) {
    try { return E.wz_congestion_multiplier(Number(n) || 0); }
    catch (e) { return JS.congestionMultiplier.call(C, n); }
  });

  /* ----- classifier.js ----- */

  patch('classifyHttpError', function (status, bodyText, retryOnHttpError) {
    try {
      return JSON.parse(wstr('wz_classify_http_error',
        Number(status), String(bodyText || ''), retryOnHttpError ? 1 : 0));
    } catch (e) {
      return JS.classifyHttpError.call(C, status, bodyText, retryOnHttpError);
    }
  });

  patch('classifyBodyText', function (bodyText) {
    try { return JSON.parse(wstr('wz_classify_body_text', String(bodyText || ''))); }
    catch (e) { return JS.classifyBodyText.call(C, bodyText); }
  });

  patch('classifyStream', function (s) {
    try {
      // only the fields classifyStream reads — `text` (up to 200 KB) is skipped
      var slim = {
        ended: !!(s && s.ended), sawContent: !!(s && s.sawContent),
        gotDone: !!(s && s.gotDone), errText: String((s && s.errText) || ''),
        hadLines: !!(s && s.hadLines)
      };
      return JSON.parse(wstr('wz_classify_stream', JSON.stringify(slim)));
    } catch (e) {
      return JS.classifyStream.call(C, s);
    }
  });

  patch('extractMessage', function (j) {
    try {
      var s = wstr('wz_extract_message', JSON.stringify(j === undefined ? null : j));
      return s === '' ? null : JSON.parse(s);
    } catch (e) {
      return JS.extractMessage.call(C, j);
    }
  });

  patch('extractError', function (j) {
    try {
      var s = wstr('wz_extract_error', JSON.stringify(j === undefined ? null : j));
      return s === '' ? null : JSON.parse(s);
    } catch (e) {
      return JS.extractError.call(C, j);
    }
  });

  patch('errText', function (e) {
    if (!e) return ''; // same guard as the JS reference
    try { return wstr('wz_err_text', JSON.stringify(e)); }
    catch (er) { return JS.errText.call(C, e); }
  });

  patch('firstLine', function (t, n) {
    try {
      var nn = Number(n);
      if (!isFinite(nn)) nn = 1e9; // n undefined → JS keeps the whole string
      return wstr('wz_first_line', String(t || ''), nn);
    } catch (e) {
      return JS.firstLine.call(C, t, n);
    }
  });

  patch('isHtmlBody', function (t) {
    try { return wnum('wz_is_html_body', String(t || '')) === 1; }
    catch (e) { return JS.isHtmlBody.call(C, t); }
  });

  patch('countWords', function (text) {
    try { return wnum('wz_count_words', String(text || '')); }
    catch (e) { return JS.countWords.call(C, text); }
  });

  /* ---------- markers ---------- */
  C.__wasmActive = true;
  C.__jsImpl = JS; // the saved JS originals (debugging / tests)
})(typeof self !== 'undefined' ? self : globalThis);
