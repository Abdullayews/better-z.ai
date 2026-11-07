/*
 * better z.ai — date formatting (core-wasm).
 *
 * Exact ports of the two Date methods sign.js resignUrl() uses:
 *   new Date(ts).toISOString()  → "YYYY-MM-DDTHH:MM:SS.sssZ"
 *   new Date(ts).toUTCString()  → "Www, DD Mmm YYYY HH:MM:SS GMT"
 *
 * Pure integer math (Howard Hinnant's civil_from_days); no chrono dependency.
 */
#![allow(dead_code)]

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// days since 1970-01-01 → (year, month 1-12, day 1-31)
/// Howard Hinnant's civil_from_days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

struct Utc {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
    ms: u32,
    weekday: usize, // 0 = Sunday
}

fn utc_parts(ts_ms: i64) -> Utc {
    // JS Date uses floor division for pre-1970 timestamps
    let secs = ts_ms.div_euclid(1000);
    let ms = ts_ms.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    // 1970-01-01 was a Thursday (weekday index 4 with 0 = Sunday)
    let weekday = (days + 4).rem_euclid(7) as usize;
    Utc {
        year: y,
        month: m,
        day: d,
        hour: (sod / 3600) as u32,
        min: ((sod % 3600) / 60) as u32,
        sec: (sod % 60) as u32,
        ms,
        weekday,
    }
}

/// `new Date(ts).toISOString()`
pub fn iso_string(ts_ms: i64) -> String {
    let u = utc_parts(ts_ms);
    // JS pads the year to 4 digits for 0..=9999 (the realistic range here).
    if !(0..=9999).contains(&u.year) {
        // years outside 0..9999 get a +/- prefix in JS — out of protocol range
        return format!("+{:05}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            u.year, u.month, u.day, u.hour, u.min, u.sec, u.ms);
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        u.year, u.month, u.day, u.hour, u.min, u.sec, u.ms)
}

/// `new Date(ts).toUTCString()`
pub fn utc_string(ts_ms: i64) -> String {
    let u = utc_parts(ts_ms);
    format!("{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAY_NAMES[u.weekday], u.day, MONTH_NAMES[(u.month - 1) as usize],
        u.year, u.hour, u.min, u.sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc_string(0), "Thu, 01 Jan 1970 00:00:00 GMT");
    }

    #[test]
    fn pre_epoch_uses_floor() {
        // -86400000 → 1969-12-31 (JS floor semantics, not truncation)
        assert_eq!(iso_string(-86400000), "1969-12-31T00:00:00.000Z");
        assert_eq!(utc_string(-86400000), "Wed, 31 Dec 1969 00:00:00 GMT");
        // -1 → 1969-12-31T23:59:59.999Z
        assert_eq!(iso_string(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn known_dates() {
        // 2026-01-01T00:00:00.000Z is a Thursday
        assert_eq!(iso_string(1767225600000), "2026-01-01T00:00:00.000Z");
        assert_eq!(utc_string(1767225600000), "Thu, 01 Jan 2026 00:00:00 GMT");
        // 2024-02-29 (leap day) 1709164800000
        assert_eq!(iso_string(1709164800000), "2024-02-29T00:00:00.000Z");
        assert_eq!(utc_string(1709164800000), "Thu, 29 Feb 2024 00:00:00 GMT");
        // 2100-01-01 (2100 is NOT a leap year) 4102444800000
        assert_eq!(iso_string(4102444800000), "2100-01-01T00:00:00.000Z");
        assert_eq!(utc_string(4102444800000), "Fri, 01 Jan 2100 00:00:00 GMT");
        // 2024-12-31T23:59:59.999 → 1735689599999
        assert_eq!(iso_string(1735689599999), "2024-12-31T23:59:59.999Z");
        assert_eq!(utc_string(1735689599999), "Tue, 31 Dec 2024 23:59:59 GMT");
        // 2000-02-29 (leap day) 951782400000 — day 60 of year 2000
        assert_eq!(iso_string(951782400000), "2000-02-29T00:00:00.000Z");
        assert_eq!(utc_string(951782400000), "Tue, 29 Feb 2000 00:00:00 GMT");
    }
}
