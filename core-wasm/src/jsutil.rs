// better z.ai — JS semantics helpers (core-wasm).
//
// The JavaScript reference implementation (src/core modules) is the SPEC.
// These helpers replicate the exact ECMAScript behaviors the core relies on,
// so the Rust/WASM port produces bit-identical results:
//   - JS `\s` character class (includes U+FEFF, unlike Unicode White_Space)
//   - String.prototype.trim / replace(/\s+/g, ' ')
//   - String.prototype.length / slice()  → UTF-16 code units
//   - Math.round / Math.min / Math.max NaN semantics
//   - ToInt32 (`x | 0`), truthiness, String() coercion
#![allow(dead_code)]

/// JS `\s` class (ECMA-262 WhiteSpace + LineTerminator + U+FEFF).
/// Note: U+FEFF is in the JS class but is NOT Unicode White_Space,
/// so Rust's `char::is_whitespace()` alone would be wrong here.
pub fn is_js_ws(c: char) -> bool {
    matches!(c,
        '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `s.replace(/\s+/g, ' ')` followed by `s.trim()`
/// (the exact operations classifier.js firstLine() performs, in order).
pub fn collapse_and_trim(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_ws(c) {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    // trim: leading/trailing runs were collapsed to single ASCII spaces
    let t = out.trim_matches(|c| c == ' ');
    t.to_string()
}

/// JS `String.prototype.trim()` (used by sign.js on the prompt).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// classifier.js `firstLine(t, n)`:
///   t = String(t || '').replace(/\s+/g, ' ').trim();
///   return t.length > n ? t.slice(0, n) + '…' : t;
/// `.length` and `.slice` are UTF-16 code-unit based.
pub fn first_line(t: &str, n: usize) -> String {
    let collapsed = collapse_and_trim(t);
    let units: Vec<u16> = collapsed.encode_utf16().collect();
    if units.len() > n {
        let mut cut: Vec<u16> = units[..n].to_vec();
        cut.push(0x2026); // '…'
        // a cut could split a surrogate pair — from_utf16_lossy mirrors the
        // visually-broken output a lone surrogate produces in JS (U+FFFD).
        String::from_utf16_lossy(&cut)
    } else {
        collapsed
    }
}

/// classifier.js `countWords(text)`: trim, then `split(/\s+/).length`.
pub fn count_words(text: &str) -> usize {
    let mut t = text;
    // js trim
    t = t.trim_matches(is_js_ws);
    if t.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut in_ws = true;
    for c in t.chars() {
        if is_js_ws(c) {
            in_ws = true;
        } else {
            if in_ws {
                n += 1;
            }
            in_ws = false;
        }
    }
    n
}

/// Math.round: floor(x + 0.5)  (rounds halves toward +Infinity, unlike Rust's
/// `f64::round` which rounds halves away from zero).
pub fn js_round(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() || x == 0.0 {
        return x;
    }
    (x + 0.5).floor()
}

/// Math.min: any NaN operand → NaN (Rust's f64::min would swallow NaN).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Math.max: any NaN operand → NaN.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// ToInt32 (`x | 0`) — truncate toward zero, wrap to i32.
/// Realistic inputs here are small non-negative retry counters.
pub fn js_to_int32(x: f64) -> i32 {
    if !x.is_finite() || x == 0.0 {
        0
    } else {
        (x.trunc() as i64) as i32
    }
}

/// ECMAScript number-to-string for the cases the core can hit
/// (integer-valued timestamps / HTTP statuses / error codes).
/// Non-integer fallback uses Rust's shortest round-trip formatting, which
/// matches JS for common magnitudes (exponent formatting differs only for
/// extremes that cannot occur in this protocol).
pub fn js_num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if x == 0.0 {
        return "0".to_string(); // covers -0 → "0", same as JS
    }
    if x.fract() == 0.0 && x.abs() < 1e21 {
        let i = x as i128;
        return i.to_string();
    }
    format!("{}", x)
}

// ---------- serde_json Value helpers (JS coercion semantics) ----------

use serde_json::Value;

/// JS truthiness for a JSON value.
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            f != 0.0 && !f.is_nan()
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `String(v)` for the types error objects can contain.
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        Value::Number(n) => js_num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".to_string(),
        Value::Array(a) => a
            .iter()
            .map(|e| if e.is_null() { String::new() } else { js_to_string(e) })
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// Normalize every number in a JSON tree to f64 so that u64/f64 representation
/// differences never break equality comparisons in the differential tests.
pub fn norm_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
        }
        Value::Array(a) => Value::Array(a.iter().map(norm_numbers).collect()),
        Value::Object(o) => {
            let mut m = serde_json::Map::new();
            for (k, val) in o {
                m.insert(k.clone(), norm_numbers(val));
            }
            Value::Object(m)
        }
        other => other.clone(),
    }
}
