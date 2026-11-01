/*
 * better z.ai — X-Signature imza alqoritmi (LEGACY_SPEC §5, dəqiq port).
 *
 * Alqoritm (z.ai web tətbiqindən geri mühəndisliklə alınmışdır):
 *   1. ts = unix ms; requestId = uuid
 *   2. sorted_payload = "requestId,{requestId},timestamp,{ts},user_id,{user_id}"
 *   3. prompt_b64 = standart base64(prompt.trim() UTF-8)
 *   4. data = "{sorted_payload}|{prompt_b64}|{ts}"
 *   5. g = ts / 300000 (tam bölmə — 5 dəqiqəlik pəncərə)
 *   6. subkey = HMAC_SHA256_hex(key=SIGNATURE_KEY, msg=str(g))
 *   7. signature = HMAC_SHA256_hex(key=subkey, msg=data)   ← subkey hex-SİTRİNGİ açar kimi
 *
 * İmza köhnələndikdə (>5 dəq) retry üçün yenidən imzalamaq olar —
 * funksiyalar safdır və Node vm testlərində də işləyir (crypto.subtle Node≥20-də qlobal).
 */
(function (root) {
  'use strict';
  var C = root.__zaiExtCore = root.__zaiExtCore || {};

  C.SIGNATURE_KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
  C.SIGNATURE_WINDOW_MS = 300000; // 5 dəqiqə

  var TE = new TextEncoder();

  /* LEGACY_SPEC form_encode: [A-Za-z0-9*-._] saxlanılır, boşluq→'+', qalanı %XX (böyük hərflə) */
  C.formEncode = function (v) {
    v = String(v);
    var out = '';
    for (var ch of v) {
      if (/[A-Za-z0-9\*\-\._]/.test(ch)) {
        out += ch;
      } else if (ch === ' ') {
        out += '+';
      } else {
        var bytes = TE.encode(ch);
        for (var b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  };

  C.b64Utf8 = function (s) {
    var bytes = TE.encode(String(s));
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin); // standart base64, padding ilə
  };

  C.hmacHex = async function (keyStr, msg) {
    var enc = TE;
    var key = await crypto.subtle.importKey(
      'raw', enc.encode(String(keyStr)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    var sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(msg)));
    var hex = '';
    var u = new Uint8Array(sig);
    for (var i = 0; i < u.length; i++) hex += u[i].toString(16).padStart(2, '0');
    return hex;
  };

  C.computeSignature = async function (prompt, requestId, userId, ts) {
    var b64 = C.b64Utf8(String(prompt).trim());
    var data = 'requestId,' + requestId + ',timestamp,' + ts + ',user_id,' + userId + '|' + b64 + '|' + ts;
    var g = Math.floor(ts / C.SIGNATURE_WINDOW_MS);
    var subkey = await C.hmacHex(C.SIGNATURE_KEY, String(g));
    var sig = await C.hmacHex(subkey, data);
    return { signature: sig, data: data };
  };

  /*
   * Köhnəlmiş sorğu üçün yeni imza + yeni URL.
   * queryEntries: tutulmuş sorğunun SIRAQLI [[k,v]] siyahısı (dəyişdirilməz qaydada saxlanılır).
   * Yalnız zamanla bağlı sahələr yenilənir: timestamp, signature_timestamp,
   * local_time, utc_time; qalan fingerprint sahələri olduqca kimi saxlanılır.
   */
  C.resignUrl = async function (queryEntries, origin, pathname, prompt, requestId, userId, nowMs) {
    var ts = nowMs || Date.now();
    var computed = await C.computeSignature(prompt, requestId, userId, ts);
    var d = new Date(ts);
    var entries = queryEntries.map(function (kv) {
      var k = kv[0], v = kv[1];
      if (k === 'timestamp' || k === 'signature_timestamp') return [k, String(ts)];
      if (k === 'local_time') return [k, d.toISOString()];
      if (k === 'utc_time') return [k, d.toUTCString()];
      return [k, String(v)];
    });
    var qs = entries.map(function (kv) {
      return C.formEncode(kv[0]) + '=' + C.formEncode(kv[1]);
    }).join('&');
    return {
      url: origin + pathname + '?' + qs,
      signature: computed.signature,
      ts: ts
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
