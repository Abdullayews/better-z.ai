/*
 * better z.ai — exponential + adaptive backoff, Rust port of src/core/backoff.js.
 *
 * The JS wrappers (wasm-loader.js) resolve `cfg.X || default` coercion in JS,
 * so these functions receive explicit numeric settings and stay pure math.
 */
#![allow(dead_code)]

use crate::jsutil::{js_max, js_min, js_round, js_to_int32};

/// backoff.js computeDelay() — attempt is 1-based.
/// `rand` is the injected random value ([0,1)) — passed in for determinism.
pub fn compute_delay(
    attempt: f64,
    initial: f64,
    factor: f64,
    max_delay: f64,
    jitter: f64,
    rand: f64,
) -> f64 {
    // attempt = Math.max(1, attempt | 0)
    let attempt = js_max(1.0, js_to_int32(attempt) as f64);

    // base = initial * Math.pow(factor, attempt - 1)
    let base = initial * factor.powf(attempt - 1.0);

    // base = Math.min(base, maxDelay)
    let base = js_min(base, max_delay);

    // spread = base * jitter; d = Math.round(base - spread/2 + spread*rand())
    let spread = base * jitter;
    let mut d = js_round(base - spread / 2.0 + spread * rand);

    // if (d < 400) d = 400;
    if d < 400.0 {
        d = 400.0;
    }
    // return Math.min(d, maxDelay);
    js_min(d, max_delay)
}

/// backoff.js applyRetryAfter() — a server Retry-After takes priority.
/// `retry_after_ms` is already Number()-coerced by the JS wrapper
/// (undefined/null/non-numeric arrive as NaN and fall through).
pub fn apply_retry_after(delay_ms: f64, retry_after_ms: f64) -> f64 {
    let mut r = retry_after_ms;
    if r > 0.0 {
        r = js_round(r);
        if r < 1000.0 {
            r = 1000.0;
        }
        if r > 300000.0 {
            r = 300000.0;
        }
        return r;
    }
    delay_ms
}

/// backoff.js congestionMultiplier():
///   0 → ×1.0, 1 → ×1.5, 2 → ×2.0, 3 → ×2.5, 4+ → ×3.0 (maximum)
pub fn congestion_multiplier(consecutive_busy: f64) -> f64 {
    // var n = Math.max(0, consecutiveBusy | 0);
    let n = js_max(0.0, js_to_int32(consecutive_busy) as f64);
    // return 1 + 0.5 * Math.min(4, n);
    1.0 + 0.5 * js_min(4.0, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_grows_and_clamps() {
        assert_eq!(compute_delay(1.0, 5000.0, 2.0, 120000.0, 0.0, 0.0), 5000.0);
        assert_eq!(compute_delay(2.0, 5000.0, 2.0, 120000.0, 0.0, 0.5), 10000.0);
        assert_eq!(compute_delay(9.0, 5000.0, 2.0, 120000.0, 0.0, 0.5), 120000.0); // max clamp
        assert_eq!(compute_delay(1.0, 100.0, 2.0, 120000.0, 0.0, 0.5), 400.0); // min clamp
    }

    #[test]
    fn attempt_floor() {
        // attempt | 0 then max(1, ·): 0 → 1, -2 → 1, 2.9 → 2
        assert_eq!(compute_delay(0.0, 5000.0, 2.0, 120000.0, 0.0, 0.0), 5000.0);
        assert_eq!(compute_delay(-2.0, 5000.0, 2.0, 120000.0, 0.0, 0.0), 5000.0);
        assert_eq!(compute_delay(2.9, 5000.0, 2.0, 120000.0, 0.0, 0.0), 10000.0);
    }

    #[test]
    fn retry_after_clamps() {
        assert_eq!(apply_retry_after(5000.0, f64::NAN), 5000.0);
        assert_eq!(apply_retry_after(5000.0, 0.0), 5000.0);
        assert_eq!(apply_retry_after(5000.0, 0.5), 1000.0);   // min clamp
        assert_eq!(apply_retry_after(5000.0, 1500.4), 1500.0); // js round
        assert_eq!(apply_retry_after(5000.0, 999999.0), 300000.0); // max clamp
    }

    #[test]
    fn congestion_ladder() {
        assert_eq!(congestion_multiplier(0.0), 1.0);
        assert_eq!(congestion_multiplier(1.0), 1.5);
        assert_eq!(congestion_multiplier(2.0), 2.0);
        assert_eq!(congestion_multiplier(3.0), 2.5);
        assert_eq!(congestion_multiplier(9.0), 3.0);
        assert_eq!(congestion_multiplier(2.7), 2.0); // 2.7|0 → 2
    }
}
