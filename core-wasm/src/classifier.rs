/*
 * better z.ai — error classification, Rust port of src/core/classifier.js
 * (LEGACY_SPEC §5 — the z.ai SSE protocol error classification).
 *
 * The regex pattern texts are copied verbatim from classifier.js;
 * Rust's `(?i)` performs Unicode simple case folding, matching JS `/i`.
 */
#![allow(dead_code)]

use crate::jsutil::{count_words, first_line, js_truthy, js_to_string};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

const BUSY_PATTERN: &str = r"(?i)global_limit|user_limit|rate_limit|too many requests|system is busy|server is busy|busy|overload|overloaded|temporar|try again|timeout|timed out|unavailable|internal server|upstream|waf|频繁|繁忙|稍后再试|网络错误";
const FATAL_PATTERN: &str = r"(?i)outdated|signature|unauthor|forbidden|permission|invalid|not found|quota|exceed|policy|moderation|illegal|敏感|违规|登录|鉴权|签名";
const CAPTCHA_PATTERN: &str = r"(?i)captcha|验证码|人机验证";

const RETRYABLE_HTTP: [f64; 16] = [408.0, 425.0, 429.0, 500.0, 502.0, 503.0, 504.0, 509.0, 520.0, 521.0, 522.0, 523.0, 524.0, 525.0, 527.0, 529.0];
const NONRETRY_HTTP: [f64; 10] = [400.0, 401.0, 403.0, 404.0, 405.0, 409.0, 410.0, 413.0, 422.0, 426.0];

fn busy_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(BUSY_PATTERN).unwrap())
}
fn fatal_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(FATAL_PATTERN).unwrap())
}
fn captcha_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(CAPTCHA_PATTERN).unwrap())
}

/// /^\s*(?:<!doctype|<html|<head|<body)/i  (JS `\s` class, ASCII case fold)
pub fn is_html_body(t: &str) -> bool {
    let s = t.trim_start_matches(crate::jsutil::is_js_ws);
    const PREFIXES: [&str; 4] = ["<!doctype", "<html", "<head", "<body"];
    PREFIXES.iter().any(|p| {
        s.len() >= p.len() && s.as_bytes()[..p.len()].eq_ignore_ascii_case(p.as_bytes())
    })
}

/// classifier.js firstLine() — see jsutil::first_line.
pub fn first_line_str(t: &str, n: usize) -> String {
    first_line(t, n)
}

/* ---------------- classification results ---------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct ClassifyResult {
    pub outcome: &'static str,
    pub reason: String,
    pub msg: String,
    /// only present for the captcha branch (fast retry)
    pub fast_delay_ms: Option<f64>,
}

impl ClassifyResult {
    fn new(outcome: &'static str, reason: &str, msg: String) -> Self {
        ClassifyResult { outcome, reason: reason.to_string(), msg, fast_delay_ms: None }
    }
    fn captcha(msg: String) -> Self {
        ClassifyResult {
            outcome: "retry",
            reason: "captcha".to_string(),
            msg,
            fast_delay_ms: Some(1000.0),
        }
    }
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("outcome".into(), Value::String(self.outcome.to_string()));
        m.insert("reason".into(), Value::String(self.reason.clone()));
        m.insert("msg".into(), Value::String(self.msg.clone()));
        if let Some(f) = self.fast_delay_ms {
            let n = serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null);
            m.insert("fastDelayMs".into(), n);
        }
        Value::Object(m)
    }
}

fn http_reason(status: f64) -> String {
    format!("http_{}", crate::jsutil::js_num_to_string(status))
}

fn http_msg(status: f64) -> String {
    format!("HTTP {}", crate::jsutil::js_num_to_string(status))
}

/// classifyHttpError(status, bodyText, retryOnHttpError) — non-SSE responses.
pub fn classify_http_error(status: f64, body_text: &str, retry_on_http_error: bool) -> ClassifyResult {
    let t = body_text;

    // WAF: 403/405/429/509 + HTML body → retry (LEGACY_SPEC §8)
    if (status == 403.0 || status == 405.0 || status == 429.0 || status == 509.0) && is_html_body(t) {
        return ClassifyResult::new("retry", "waf", "WAF block (HTML)".to_string());
    }
    if captcha_re().is_match(t) {
        return ClassifyResult::captcha(first_line(t, 140));
    }
    if busy_re().is_match(t) {
        return ClassifyResult::new("retry", "busy", first_line(t, 140));
    }
    if RETRYABLE_HTTP.contains(&status) {
        return ClassifyResult::new("retry", &http_reason(status), http_msg(status));
    }
    if fatal_re().is_match(t) {
        return ClassifyResult::new("fatal", "fatal_text", first_line(t, 140));
    }
    if NONRETRY_HTTP.contains(&status) {
        return ClassifyResult::new("fatal", &http_reason(status), http_msg(status));
    }
    if retry_on_http_error && status >= 400.0 {
        return ClassifyResult::new("retry", &http_reason(status), http_msg(status));
    }
    ClassifyResult::new("fatal", &http_reason(status), http_msg(status))
}

/// classifyBodyText(bodyText) — HTTP 200 + JSON body (not event-stream).
pub fn classify_body_text(body_text: &str) -> ClassifyResult {
    let t = body_text;
    if captcha_re().is_match(t) {
        return ClassifyResult::captcha(first_line(t, 140));
    }
    if busy_re().is_match(t) {
        return ClassifyResult::new("retry", "busy", first_line(t, 140));
    }
    if fatal_re().is_match(t) {
        return ClassifyResult::new("fatal", "fatal_text", first_line(t, 140));
    }
    ClassifyResult::new("await_user", "body_200", first_line(t, 140))
}

/// classifyStream(s) — outcome of the SSE stream.
/// `s` mirrors the slim state {ended, sawContent, gotDone, errText, hadLines}.
pub fn classify_stream(ended: bool, saw_content: bool, got_done: bool, err_text: &str, _had_lines: bool) -> ClassifyResult {
    if !err_text.is_empty() {
        if captcha_re().is_match(err_text) {
            return ClassifyResult::captcha(first_line(err_text, 140));
        }
        if busy_re().is_match(err_text) {
            return ClassifyResult::new("retry", "busy", first_line(err_text, 140));
        }
        if fatal_re().is_match(err_text) {
            return ClassifyResult::new("fatal", "fatal_text", first_line(err_text, 140));
        }
        return ClassifyResult::new("await_user", "stream_error", first_line(err_text, 140));
    }
    if !ended {
        let msg = if saw_content {
            "Stream interrupted (partial response received)"
        } else {
            "Stream interrupted"
        };
        return ClassifyResult::new("retry", "stream_cut", msg.to_string());
    }
    if !got_done {
        // LEGACY_SPEC §5: stream ending without [DONE] or done=true → retry
        return ClassifyResult::new("retry", "no_done", "Stream ended without [DONE]".to_string());
    }
    if !saw_content {
        return ClassifyResult::new("await_user", "empty_stream", "Empty response (only [DONE])".to_string());
    }
    ClassifyResult::new("success", "ok", String::new())
}

/* ---------------- SSE payload digging ---------------- */

fn dig<'a>(obj: &'a Value, path: &[&str]) -> &'a Value {
    let mut cur = obj;
    for key in path {
        cur = match cur {
            Value::Object(m) => m.get(*key).unwrap_or(&Value::Null),
            _ => &Value::Null,
        };
    }
    cur
}

fn is_truthy_object(v: &Value) -> bool {
    // JS: m && typeof m === 'object'  → non-null object or array
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// LEGACY_SPEC §5: /data/message → /data/data/message → /message → /data/data/data
pub fn extract_message(j: &Value) -> Option<Value> {
    let paths: [&[&str]; 4] = [&["data", "message"], &["data", "data", "message"], &["message"], &["data", "data", "data"]];
    for p in paths {
        let m = dig(j, p);
        if is_truthy_object(m) {
            return Some(m.clone());
        }
    }
    None
}

/// /data/error → /data/data/error → /error
pub fn extract_error(j: &Value) -> Option<Value> {
    let paths: [&[&str]; 3] = [&["data", "error"], &["data", "data", "error"], &["error"]];
    for p in paths {
        let e = dig(j, p);
        if is_truthy_object(e) {
            return Some(e.clone());
        }
    }
    None
}

/// errText(e): [code||error_code, detail||message||''].filter(Boolean).join(' — ')
pub fn err_text(e: &Value) -> String {
    if !js_truthy(e) {
        return String::new();
    }
    let code = {
        let c = e.get("code").unwrap_or(&Value::Null);
        let s = if !c.is_null() { js_to_string(c) } else { String::new() };
        let ec = e.get("error_code").unwrap_or(&Value::Null);
        let es = if !ec.is_null() { js_to_string(ec) } else { String::new() };
        if !s.is_empty() { s } else { es }
    };
    let d = {
        // e.detail || e.message || ''
        let det = e.get("detail").unwrap_or(&Value::Null);
        let mes = e.get("message").unwrap_or(&Value::Null);
        if js_truthy(det) { js_to_string(det) } else if js_truthy(mes) { js_to_string(mes) } else { String::new() }
    };
    let parts: Vec<String> = [code, d].into_iter().filter(|s| !s.is_empty()).collect();
    parts.join(" — ")
}

/// countWords(text) — whitespace-separated word count.
pub fn count_words_str(text: &str) -> usize {
    count_words(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_bodies() {
        assert!(is_html_body("<!doctype html><html>"));
        assert!(is_html_body("  \n\t <BODY>"));
        assert!(!is_html_body("DOCTYPE"));
        assert!(!is_html_body("{\"e\":1}"));
    }

    #[test]
    fn waf_branch() {
        let r = classify_http_error(403.0, "<!doctype html><html>blocked", true);
        assert_eq!((r.outcome, r.reason.as_str()), ("retry", "waf"));
    }

    #[test]
    fn captcha_fast_retry() {
        let r = classify_http_error(400.0, "FRONTEND_CAPTCHA_REQUIRED", false);
        assert_eq!(r.outcome, "retry");
        assert_eq!(r.reason, "captcha");
        assert_eq!(r.fast_delay_ms, Some(1000.0));
    }

    #[test]
    fn busy_stream_error() {
        let r = classify_stream(true, true, true, "global_limit — system is busy", true);
        assert_eq!((r.outcome, r.reason.as_str()), ("retry", "busy"));
    }

    #[test]
    fn extract_paths() {
        let j: Value = serde_json::from_str(r#"{"data":{"message":{"done":true}}}"#).unwrap();
        assert!(extract_message(&j).is_some());
        let j2: Value = serde_json::from_str(r#"{"data":{"message":"string"}}"#).unwrap();
        assert!(extract_message(&j2).is_none());
    }
}
