/*
 * better z.ai — WASM C-ABI layer (core-wasm).
 *
 * A dependency-free ABI (no wasm-bindgen): the module has ZERO imports, so
 * src/core/wasm-loader.js can instantiate it synchronously from an inline
 * base64 blob in ANY context (MAIN world, ISOLATED world, extension pages,
 * Node tests) with `new WebAssembly.Instance(new WebAssembly.Module(bytes))`.
 *
 * Calling convention:
 *   - string arguments are passed as (ptr, len) pairs; the JS side writes
 *     UTF-8 bytes into the bump arena via walloc(len), calls the function,
 *     then resets the arena with wreset();
 *   - string/JSON results are written to a single result buffer and the
 *     function returns a pointer to [u32 length][bytes] (little-endian);
 *     0 means "error" — the loader then falls back to the JS implementation;
 *   - numeric results (delays, multipliers) are returned as f64 directly.
 *
 * Panics inside a call become WASM traps → a JS exception in the loader →
 * per-call fallback to the original JavaScript implementation.
 */
#![allow(clippy::missing_safety_doc)]

pub mod backoff;
pub mod classifier;
pub mod dates;
pub mod jsutil;
pub mod sign;

use std::cell::{Cell, RefCell};

const ARENA_LEN: usize = 4 * 1024 * 1024; // 4 MiB scratch (inputs only)

thread_local! {
    static ARENA: RefCell<Option<Box<[u8]>>> = const { RefCell::new(None) };
    static ARENA_OFF: Cell<usize> = const { Cell::new(0) };
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/* ---------------- arena ---------------- */

/// Bump-allocate `len` bytes for a string input. Returns 0 on exhaustion.
/// The buffer is allocated once (lazily) and never moves, so pointers handed
/// out stay valid until wreset().
#[no_mangle]
pub extern "C" fn walloc(len: u32) -> u32 {
    ARENA.with(|a| {
        let mut slot = a.borrow_mut();
        if slot.is_none() {
            // one-time allocation; wasm memory grows lazily, so this does not
            // bloat the binary (a static array WOULD — wasm has no .bss)
            *slot = Some(vec![0u8; ARENA_LEN].into_boxed_slice());
        }
        let buf = slot.as_ref().expect("arena just initialized");
        let off = ARENA_OFF.get();
        if off + len as usize > buf.len() {
            ARENA_OFF.set(buf.len());
            return 0;
        }
        ARENA_OFF.set(off + len as usize);
        buf.as_ptr() as u32 + off as u32
    })
}

/// Reset the input arena (the loader calls this after every logical call).
#[no_mangle]
pub extern "C" fn wreset() {
    ARENA_OFF.set(0);
}

/* ---------------- result buffer ---------------- */

/// Writes to the result buffer; returns the address as usize.
/// (On wasm32 usize == u32; native tests use the full-width value.)
fn result_into(bytes: &[u8]) -> usize {
    RESULT.with(|r| {
        let mut v = r.borrow_mut();
        v.clear();
        v.reserve(bytes.len() + 4);
        v.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        v.extend_from_slice(bytes);
        v.as_ptr() as usize
    })
}

/// ABI result writer: pointer to [u32 length][bytes] in the result buffer.
fn write_result(bytes: &[u8]) -> u32 {
    result_into(bytes) as u32
}

fn write_json(v: &serde_json::Value) -> u32 {
    write_result(v.to_string().as_bytes())
}

/* ---------------- input reading ---------------- */

unsafe fn input(p: u32, l: u32) -> Result<&'static str, ()> {
    if l == 0 {
        return Ok("");
    }
    if p == 0 {
        return Err(());
    }
    let slice = unsafe { core::slice::from_raw_parts(p as *const u8, l as usize) };
    core::str::from_utf8(slice).map_err(|_| ())
}

macro_rules! inputs {
    ($($p:ident, $l:ident),* $(,)?) => {
        match ($(unsafe { input($p, $l) },)*) {
            ($(Ok($p),)*) => ($($p,)*),
            _ => return Default::default(),
        }
    };
}

/* ---------------- exports ---------------- */

/// Version marker — the loader checks this to detect a compatible binary.
#[no_mangle]
pub extern "C" fn wz_version() -> u32 {
    write_result(env!("CARGO_PKG_VERSION").as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_form_encode(p: u32, l: u32) -> u32 {
    let (s,) = inputs!(p, l);
    write_result(sign::form_encode(s).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_b64_utf8(p: u32, l: u32) -> u32 {
    let (s,) = inputs!(p, l);
    write_result(sign::b64_utf8(s).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_hmac_hex(kp: u32, kl: u32, mp: u32, ml: u32) -> u32 {
    let (k, m) = inputs!(kp, kl, mp, ml);
    write_result(sign::hmac_hex(k, m).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_compute_signature(
    pp: u32, pl: u32, rp: u32, rl: u32, up: u32, ul: u32, ts: f64,
) -> u32 {
    let (prompt, req, user) = inputs!(pp, pl, rp, rl, up, ul);
    let r = sign::compute_signature(prompt, req, user, ts);
    write_json(&serde_json::json!({ "signature": r.signature, "data": r.data }))
}

#[no_mangle]
pub extern "C" fn wz_resign_url(
    qp: u32, ql: u32,          // query entries (JSON array [[k,v],..])
    op: u32, ol: u32,          // origin
    hp: u32, hl: u32,          // pathname
    pp: u32, pl: u32,          // prompt (signature_prompt)
    rp: u32, rl: u32,          // requestId
    up: u32, ul: u32,          // user_id
    now: f64,
) -> u32 {
    let (qe_json, origin, pathname, prompt, req, user) =
        inputs!(qp, ql, op, ol, hp, hl, pp, pl, rp, rl, up, ul);
    let qe: Vec<(String, String)> = match serde_json::from_str(qe_json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let r = sign::resign_url(&qe, origin, pathname, prompt, req, user, now);
    write_json(&serde_json::json!({ "url": r.url, "signature": r.signature, "ts": r.ts }))
}

#[no_mangle]
pub extern "C" fn wz_compute_delay(
    attempt: f64, initial: f64, factor: f64, max_delay: f64, jitter: f64, rand: f64,
) -> f64 {
    backoff::compute_delay(attempt, initial, factor, max_delay, jitter, rand)
}

#[no_mangle]
pub extern "C" fn wz_apply_retry_after(delay_ms: f64, retry_after_ms: f64) -> f64 {
    backoff::apply_retry_after(delay_ms, retry_after_ms)
}

#[no_mangle]
pub extern "C" fn wz_congestion_multiplier(n: f64) -> f64 {
    backoff::congestion_multiplier(n)
}

#[no_mangle]
pub extern "C" fn wz_classify_http_error(
    status: f64, bp: u32, bl: u32, retry_on_http_error: u32,
) -> u32 {
    let (body,) = inputs!(bp, bl);
    let r = classifier::classify_http_error(status, body, retry_on_http_error != 0);
    write_json(&r.to_json())
}

#[no_mangle]
pub extern "C" fn wz_classify_body_text(bp: u32, bl: u32) -> u32 {
    let (body,) = inputs!(bp, bl);
    let r = classifier::classify_body_text(body);
    write_json(&r.to_json())
}

#[no_mangle]
pub extern "C" fn wz_classify_stream(sp: u32, sl: u32) -> u32 {
    let (state_json,) = inputs!(sp, sl);
    // {ended, sawContent, gotDone, errText, hadLines} — built by the loader
    let v: serde_json::Value = match serde_json::from_str(state_json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let getb = |k: &str| v.get(k).map(|x| x.as_bool().unwrap_or(false)).unwrap_or(false);
    let gets = || v.get("errText").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let r = classifier::classify_stream(
        getb("ended"), getb("sawContent"), getb("gotDone"), &gets(), getb("hadLines"),
    );
    write_json(&r.to_json())
}

/// Takes the RAW SSE payload JSON (not a re-stringified object).
/// Returns the message object re-serialized as JSON, or "" for null.
#[no_mangle]
pub extern "C" fn wz_extract_message(pp: u32, pl: u32) -> u32 {
    let (raw,) = inputs!(pp, pl);
    let j: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    match classifier::extract_message(&j) {
        Some(m) => write_result(m.to_string().as_bytes()),
        None => write_result(b""),
    }
}

#[no_mangle]
pub extern "C" fn wz_extract_error(pp: u32, pl: u32) -> u32 {
    let (raw,) = inputs!(pp, pl);
    let j: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    match classifier::extract_error(&j) {
        Some(e) => write_result(e.to_string().as_bytes()),
        None => write_result(b""),
    }
}

#[no_mangle]
pub extern "C" fn wz_err_text(ep: u32, el: u32) -> u32 {
    let (raw,) = inputs!(ep, el);
    let e: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    write_result(classifier::err_text(&e).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_first_line(tp: u32, tl: u32, n: f64) -> u32 {
    let (t,) = inputs!(tp, tl);
    let n = if n.is_nan() || n < 0.0 { 0 } else { n as usize };
    write_result(jsutil::first_line(t, n).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_is_html_body(tp: u32, tl: u32) -> u32 {
    let (t,) = inputs!(tp, tl);
    classifier::is_html_body(t) as u32
}

#[no_mangle]
pub extern "C" fn wz_count_words(tp: u32, tl: u32) -> f64 {
    let (t,) = inputs!(tp, tl);
    jsutil::count_words(t) as f64
}

#[no_mangle]
pub extern "C" fn wz_iso_string(ts: f64) -> u32 {
    if !ts.is_finite() {
        return 0;
    }
    write_result(dates::iso_string(ts as i64).as_bytes())
}

#[no_mangle]
pub extern "C" fn wz_utc_string(ts: f64) -> u32 {
    if !ts.is_finite() {
        return 0;
    }
    write_result(dates::utc_string(ts as i64).as_bytes())
}

/* ---------------- native smoke test of the ABI result writer ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_buffer_roundtrip() {
        // On native the returned value is an absolute pointer; the JS loader
        // reads it as an offset into wasm memory. Here we convert back.
        let bytes = RESULT.with(|r| {
            let ptr = result_into("ünïcode ✓".as_bytes());
            let v = r.borrow();
            let off = ptr - v.as_ptr() as usize;
            let len = u32::from_le_bytes([v[off], v[off + 1], v[off + 2], v[off + 3]]) as usize;
            v[off + 4..off + 4 + len].to_vec()
        });
        assert_eq!(String::from_utf8(bytes).unwrap(), "ünïcode ✓");
    }

    #[test]
    fn arena_alloc_and_reset() {
        let p1 = walloc(100);
        assert!(p1 > 0);
        let p2 = walloc(100);
        assert_eq!(p2, p1 + 100);
        wreset();
        let p3 = walloc(50);
        assert_eq!(p3, p1);
        // exhaustion (beyond the 4 MiB arena) → 0
        assert_eq!(walloc(u32::MAX), 0);
        wreset();
    }
}
