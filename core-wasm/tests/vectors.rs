// better z.ai — DIFFERENTIAL TEST (native Rust side).
//
// cargo test in core-wasm/ replays every vector recorded by
// `node test/differential/gen-vectors.mjs` (which runs the REAL JavaScript
// core, the src/core modules, in a Node vm). Every value produced here must
// match the JavaScript reference exactly.
//
// Run:  cd core-wasm && cargo test
use serde::Deserialize;
use serde_json::Value;

use zai_core_wasm::backoff;
use zai_core_wasm::classifier;
use zai_core_wasm::dates;
use zai_core_wasm::jsutil::{count_words, first_line, norm_numbers};
use zai_core_wasm::sign;

#[derive(Deserialize)]
struct Vectors {
    signature: Vec<SigV>,
    #[serde(rename = "formEncode")]
    form_encode: Vec<In2>,
    b64: Vec<In2>,
    hmac: Vec<HmacV>,
    #[serde(rename = "firstLine")]
    first_line: Vec<FirstLineV>,
    #[serde(rename = "countWords")]
    count_words: Vec<In2Num>,
    #[serde(rename = "isHtmlBody")]
    is_html_body: Vec<In2Bool>,
    #[serde(rename = "classifyHttp")]
    classify_http: Vec<HttpV>,
    #[serde(rename = "classifyBody")]
    classify_body: Vec<BodyV>,
    #[serde(rename = "classifyStream")]
    classify_stream: Vec<StreamV>,
    #[serde(rename = "extractMessage")]
    extract_message: Vec<ExtractV>,
    #[serde(rename = "extractError")]
    extract_error: Vec<ExtractV>,
    #[serde(rename = "errText")]
    err_text: Vec<ErrTextV>,
    delay: Vec<DelayV>,
    #[serde(rename = "retryAfter")]
    retry_after: Vec<RetryAfterV>,
    congestion: Vec<CongestionV>,
    #[serde(rename = "resignUrl")]
    resign_url: Vec<ResignV>,
    dates: Vec<DateV>,
}

#[derive(Deserialize)]
struct SigV { prompt: String, req: String, user: String, ts: f64, sig: String, data: String }

#[derive(Deserialize)]
struct In2 {
    #[serde(rename = "in")]
    input: String,
    out: String,
}

#[derive(Deserialize)]
struct HmacV { key: String, msg: String, out: String }

#[derive(Deserialize)]
struct FirstLineV { t: String, n: f64, out: String }

#[derive(Deserialize)]
struct In2Num {
    #[serde(rename = "in")]
    input: String,
    out: f64,
}

#[derive(Deserialize)]
struct In2Bool {
    #[serde(rename = "in")]
    input: String,
    out: bool,
}

#[derive(Deserialize)]
struct HttpV { status: f64, body: String, retry: bool, out: Value }

#[derive(Deserialize)]
struct BodyV { body: String, out: Value }

#[derive(Deserialize)]
struct StreamV { state: StreamState, out: Value }

#[derive(Deserialize, Debug)]
struct StreamState {
    ended: bool,
    #[serde(rename = "sawContent")]
    saw_content: bool,
    #[serde(rename = "gotDone")]
    got_done: bool,
    #[serde(rename = "errText")]
    err_text: String,
    #[serde(rename = "hadLines")]
    had_lines: bool,
}

#[derive(Deserialize)]
struct ExtractV { raw: String, out: Option<String> }

#[derive(Deserialize)]
struct ErrTextV { raw: String, out: String }

#[derive(Deserialize)]
struct DelayV { attempt: f64, rand: f64, resolved: ResolvedCfg, out: f64 }

#[derive(Deserialize, Debug)]
struct ResolvedCfg { initial: f64, factor: f64, max: f64, jitter: f64 }

#[derive(Deserialize)]
struct RetryAfterV { d: f64, ra: Option<Value>, out: f64 }

#[derive(Deserialize)]
struct CongestionV { n: f64, out: f64 }

#[derive(Deserialize)]
struct ResignV {
    entries: Vec<(String, String)>,
    origin: String,
    pathname: String,
    prompt: String,
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "userId")]
    user_id: String,
    now: f64,
    out: Value,
}

#[derive(Deserialize)]
struct DateV { ts: i64, iso: String, utc: String }

fn vectors() -> Vectors {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json");
    let data = std::fs::read_to_string(path).expect("vectors.json missing — run: node test/differential/gen-vectors.mjs");
    serde_json::from_str(&data).expect("vectors.json parse error")
}

fn assert_json_eq(got: &Value, want: &Value, ctx: &str) {
    let a = norm_numbers(got);
    let b = norm_numbers(want);
    assert_eq!(a, b, "context: {ctx}");
}

/* ---------------- 1. signature ---------------- */

#[test]
fn v_signature() {
    for v in vectors().signature {
        let r = sign::compute_signature(&v.prompt, &v.req, &v.user, v.ts);
        assert_eq!(r.signature, v.sig, "prompt={:?} ts={}", v.prompt, v.ts);
        assert_eq!(r.data, v.data, "data mismatch, prompt={:?}", v.prompt);
    }
}

/* ---------------- 2. formEncode / b64 / hmac ---------------- */

#[test]
fn v_form_encode() {
    for v in vectors().form_encode {
        assert_eq!(sign::form_encode(&v.input), v.out, "input={:?}", v.input);
    }
}

#[test]
fn v_b64() {
    for v in vectors().b64 {
        assert_eq!(sign::b64_utf8(&v.input), v.out, "input={:?}", v.input);
    }
}

#[test]
fn v_hmac() {
    for v in vectors().hmac {
        assert_eq!(sign::hmac_hex(&v.key, &v.msg), v.out, "key={:?}", v.key);
    }
}

/* ---------------- 3. text utilities ---------------- */

#[test]
fn v_first_line() {
    for v in vectors().first_line {
        let got = first_line(&v.t, v.n as usize);
        assert_eq!(got, v.out, "t={:?} n={}", v.t, v.n);
    }
}

#[test]
fn v_count_words() {
    for v in vectors().count_words {
        assert_eq!(count_words(&v.input) as f64, v.out, "input={:?}", v.input);
    }
}

#[test]
fn v_is_html_body() {
    for v in vectors().is_html_body {
        assert_eq!(classifier::is_html_body(&v.input), v.out, "input={:?}", v.input);
    }
}

/* ---------------- 4. classification ---------------- */

fn classify_to_value(r: classifier::ClassifyResult) -> Value {
    serde_json::from_str(&{
        let mut s = format!("{{\"outcome\":\"{}\",\"reason\":\"{}\",\"msg\":{}",
            r.outcome, r.reason, serde_json::to_string(&r.msg).unwrap());
        if let Some(f) = r.fast_delay_ms {
            s.push_str(&format!(",\"fastDelayMs\":{}", serde_json::to_string(&f).unwrap()));
        }
        s.push('}');
        s
    })
    .unwrap()
}

#[test]
fn v_classify_http() {
    for v in vectors().classify_http {
        let r = classifier::classify_http_error(v.status, &v.body, v.retry);
        assert_json_eq(&classify_to_value(r), &v.out,
            &format!("status={} body={:?}", v.status, v.body));
    }
}

#[test]
fn v_classify_body() {
    for v in vectors().classify_body {
        let r = classifier::classify_body_text(&v.body);
        assert_json_eq(&classify_to_value(r), &v.out, &format!("body={:?}", v.body));
    }
}

#[test]
fn v_classify_stream() {
    for v in vectors().classify_stream {
        let s = &v.state;
        let r = classifier::classify_stream(s.ended, s.saw_content, s.got_done, &s.err_text, s.had_lines);
        assert_json_eq(&classify_to_value(r), &v.out, &format!("state={:?}", s));
    }
}

/* ---------------- 5. SSE digging ---------------- */

#[test]
fn v_extract_message() {
    for v in vectors().extract_message {
        let j: Value = serde_json::from_str(&v.raw).unwrap();
        match classifier::extract_message(&j) {
            Some(m) => {
                let want = v.out.expect("JS returned null, Rust returned a value");
                let want_v: Value = serde_json::from_str(&want).unwrap();
                assert_json_eq(&m, &want_v, &format!("raw={}", v.raw));
            }
            None => assert!(v.out.is_none(), "JS returned {:?}, Rust returned null; raw={}", v.out, v.raw),
        }
    }
}

#[test]
fn v_extract_error() {
    for v in vectors().extract_error {
        let j: Value = serde_json::from_str(&v.raw).unwrap();
        match classifier::extract_error(&j) {
            Some(e) => {
                let want = v.out.expect("JS returned null, Rust returned a value");
                let want_v: Value = serde_json::from_str(&want).unwrap();
                assert_json_eq(&e, &want_v, &format!("raw={}", v.raw));
            }
            None => assert!(v.out.is_none(), "JS returned {:?}, Rust returned null; raw={}", v.out, v.raw),
        }
    }
}

#[test]
fn v_err_text() {
    for v in vectors().err_text {
        let j: Value = serde_json::from_str(&v.raw).unwrap();
        let e = classifier::extract_error(&j);
        let got = classifier::err_text(e.as_ref().unwrap_or(&Value::Null));
        assert_eq!(got, v.out, "raw={}", v.raw);
    }
}

/* ---------------- 6. backoff ---------------- */

#[test]
fn v_delay() {
    for v in vectors().delay {
        let got = backoff::compute_delay(
            v.attempt, v.resolved.initial, v.resolved.factor, v.resolved.max, v.resolved.jitter, v.rand,
        );
        assert_eq!(got, v.out, "attempt={} cfg={:?} rand={}", v.attempt, v.resolved, v.rand);
    }
}

#[test]
fn v_retry_after() {
    for v in vectors().retry_after {
        let ra = match &v.ra {
            None => f64::NAN, // JS: Number(undefined) — the wrapper passes NaN
            Some(Value::Null) => f64::NAN, // Number(null) = 0 → not > 0 → falls through;
            Some(Value::Number(n)) => n.as_f64().unwrap(),
            Some(Value::String(s)) => s.parse::<f64>().unwrap_or(f64::NAN), // Number("abc") = NaN
            Some(_) => f64::NAN,
        };
        // NOTE: Number(null) is 0 (not NaN), but both fall through identically.
        let ra = if v.ra.as_ref().map(|x| x.is_null()).unwrap_or(false) { 0.0 } else { ra };
        let got = backoff::apply_retry_after(v.d, ra);
        assert_eq!(got, v.out, "d={} ra={:?}", v.d, v.ra);
    }
}

#[test]
fn v_congestion() {
    for v in vectors().congestion {
        assert_eq!(backoff::congestion_multiplier(v.n), v.out, "n={}", v.n);
    }
}

/* ---------------- 7. resignUrl ---------------- */

#[test]
fn v_resign_url() {
    for v in vectors().resign_url {
        let r = sign::resign_url(&v.entries, &v.origin, &v.pathname, &v.prompt, &v.request_id, &v.user_id, v.now);
        assert_json_eq(
            &serde_json::json!({ "url": r.url, "signature": r.signature, "ts": r.ts }),
            &v.out,
            &format!("entries={:?}", v.entries),
        );
    }
}

/* ---------------- 8. dates ---------------- */

#[test]
fn v_dates() {
    for v in vectors().dates {
        assert_eq!(dates::iso_string(v.ts), v.iso, "ts={}", v.ts);
        assert_eq!(dates::utc_string(v.ts), v.utc, "ts={}", v.ts);
    }
}
