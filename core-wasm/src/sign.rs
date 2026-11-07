/*
 * better z.ai — X-Signature algorithm, Rust port of src/core/sign.js
 * (LEGACY_SPEC §5, exact port — verified against the JS reference by
 * core-wasm/tests/vectors.rs).
 *
 *   1. ts = unix ms; requestId = uuid
 *   2. sorted_payload = "requestId,{requestId},timestamp,{ts},user_id,{user_id}"
 *   3. prompt_b64 = standard base64(prompt.trim() UTF-8)
 *   4. data = "{sorted_payload}|{prompt_b64}|{ts}"
 *   5. g = ts / 300000 (integer division — 5-minute window)
 *   6. subkey = HMAC_SHA256_hex(key=SIGNATURE_KEY, msg=str(g))
 *   7. signature = HMAC_SHA256_hex(key=subkey, msg=data)   ← subkey HEX STRING as the key
 */
#![allow(dead_code)]

use crate::dates;
use crate::jsutil::{js_num_to_string, js_trim};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const SIGNATURE_KEY: &str = "key-@@@@)))()((9))-xxxx&&&%%%%%";
pub const SIGNATURE_WINDOW_MS: f64 = 300000.0; // 5 minutes

type HmacSha256 = Hmac<Sha256>;

/// standard base64 (with padding) of the UTF-8 bytes — sign.js b64Utf8().
pub fn b64_utf8(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

/// HMAC-SHA256 hex digest with a UTF-8 string key — sign.js hmacHex().
pub fn hmac_hex(key: &str, msg: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(msg.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(out.len() * 2);
    for b in out {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// LEGACY_SPEC form_encode: [A-Za-z0-9*-._] kept, space→'+',
/// everything else as %XX (uppercase hex) per UTF-8 byte.
pub fn form_encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for ch in v.chars() {
        let c = ch as u32;
        let safe = (c >= 'A' as u32 && c <= 'Z' as u32)
            || (c >= 'a' as u32 && c <= 'z' as u32)
            || (c >= '0' as u32 && c <= '9' as u32)
            || c == '*' as u32
            || c == '-' as u32
            || c == '.' as u32
            || c == '_' as u32;
        if safe {
            out.push(ch);
        } else if ch == ' ' {
            out.push('+');
        } else {
            let mut buf = [0u8; 4];
            let bytes = ch.encode_utf8(&mut buf).as_bytes();
            for b in bytes {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

pub struct SignatureResult {
    pub signature: String,
    pub data: String,
}

/// sign.js computeSignature() — deterministic for a given ts.
pub fn compute_signature(prompt: &str, request_id: &str, user_id: &str, ts: f64) -> SignatureResult {
    let trimmed = js_trim(prompt);
    let b64 = b64_utf8(trimmed);
    let ts_s = js_num_to_string(ts);
    let data = format!(
        "requestId,{},timestamp,{},user_id,{}|{}|{}",
        request_id, ts_s, user_id, b64, ts_s
    );
    let g = (ts / SIGNATURE_WINDOW_MS).floor();
    let subkey = hmac_hex(SIGNATURE_KEY, &js_num_to_string(g));
    let sig = hmac_hex(&subkey, &data);
    SignatureResult { signature: sig, data }
}

pub struct ResignResult {
    pub url: String,
    pub signature: String,
    pub ts: f64,
}

/// sign.js resignUrl() — fresh signature + fresh URL for a stale request.
/// `query_entries` is the ORDERED [[k, v]] list of the intercepted request;
/// only time-dependent fields are refreshed, the fingerprint stays as-is.
pub fn resign_url(
    query_entries: &[(String, String)],
    origin: &str,
    pathname: &str,
    prompt: &str,
    request_id: &str,
    user_id: &str,
    now_ms: f64,
) -> ResignResult {
    let ts = now_ms; // `nowMs || Date.now()` is resolved by the JS wrapper
    let computed = compute_signature(prompt, request_id, user_id, ts);
    let ts_s = js_num_to_string(ts);
    let ts_i = ts as i64; // valid unix-ms range is assumed (same as JS Date)

    let mut qs_parts: Vec<String> = Vec::with_capacity(query_entries.len());
    for (k, v) in query_entries {
        let new_v: String = match k.as_str() {
            "timestamp" | "signature_timestamp" => ts_s.clone(),
            "local_time" => dates::iso_string(ts_i),
            "utc_time" => dates::utc_string(ts_i),
            _ => v.clone(),
        };
        qs_parts.push(format!("{}={}", form_encode(k), form_encode(&new_v)));
    }
    ResignResult {
        url: format!("{}{}?{}", origin, pathname, qs_parts.join("&")),
        signature: computed.signature,
        ts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_encode_spec() {
        assert_eq!(form_encode("a b"), "a+b");
        assert_eq!(form_encode("é!"), "%C3%A9%21");
        assert_eq!(form_encode("Z*-_.", ), "Z*-_.");
        assert_eq!(form_encode("Mon, 01 Nov 2026 12:00:00 GMT"),
            "Mon%2C+01+Nov+2026+12%3A00%3A00+GMT");
    }

    #[test]
    fn hmac_known_vector() {
        // RFC 4231 test case: key "key", data "The quick brown fox jumps over the lazy dog"
        // is a widely known HMAC-SHA256 vector ("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8")
        assert_eq!(
            hmac_hex("key", "The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn signature_shape() {
        let r = compute_signature("Hello", "req-1", "user-1", 1730000000000.0);
        assert_eq!(r.signature.len(), 64);
        assert!(r.data.contains("requestId,req-1,timestamp,1730000000000,user_id,user-1|"));
    }
}
