//! Date.parse forms used by Claude, including local legacy dates and millisecond TimeClip.
use chrono::{Local, LocalResult, NaiveDateTime, Offset, TimeZone};
use regex::Regex;
use std::sync::LazyLock;

const DAY: i64 = 86_400_000;
const MAX_TIME: f64 = 8_640_000_000_000_000.0;
pub fn space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub fn regex(pattern: &str) -> Regex {
    // Rust's Unicode \d/\s include characters excluded by the JS regex contract.
    Regex::new(&pattern.replace(r"\d", "[0-9]").replace(r"\s", r"[\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]")).unwrap()
}

fn days(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yo = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * mp + 2) / 5 + day - 1 - 719468
}
fn civil(day: i64) -> (i64, i64, i64) {
    let z = day + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yo = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yo + era * 400;
    let doy = doe - (365 * yo + yo / 4 - yo / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + i64::from(m <= 2), m, d)
}
pub fn clip(ms: f64) -> Option<i64> {
    (ms.is_finite() && ms.abs() <= MAX_TIME).then_some(ms.trunc() as i64)
}
pub fn iso(ms: i64) -> String {
    let (year, month, day) = civil(ms.div_euclid(DAY));
    let rem = ms.rem_euclid(DAY);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}
fn local_result<T: TimeZone>(zone: &T, wall: NaiveDateTime) -> Option<i64> {
    match zone.from_local_datetime(&wall) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(a, b) => Some(a.timestamp_millis().min(b.timestamp_millis())),
        LocalResult::None => {
            // JS uses the pre-transition offset for a nonexistent local wall time.
            for hour in 1..=48 {
                let before = wall.checked_sub_signed(chrono::TimeDelta::hours(hour))?;
                if let Some(t) = zone.from_local_datetime(&before).earliest() {
                    return Some(
                        wall.and_utc().timestamp_millis()
                            - i64::from(t.offset().fix().local_minus_utc()) * 1000,
                    );
                }
            }
            None
        }
    }
}
fn local(ms: i64) -> Option<i64> {
    let wall = chrono::DateTime::from_timestamp_millis(ms)?.naive_utc();
    if let Ok(zone) = std::env::var("TZ")
        && let Ok(zone) = zone.parse::<chrono_tz::Tz>()
    {
        return local_result(&zone, wall);
    }
    local_result(&Local, wall)
}
fn instant(parts: [i64; 7], zone: Option<i64>, date_only: bool) -> Option<i64> {
    let [y, m, d, h, min, s, frac] = parts;
    if !(-1_000_000..=1_000_000).contains(&y)
        || !(1..=12).contains(&m)
        || !(1..=31).contains(&d)
        || !(0..=24).contains(&h)
        || !(0..=59).contains(&min)
        || !(0..=59).contains(&s)
        || (h == 24 && (min != 0 || s != 0 || frac != 0))
    {
        return None;
    }
    let ms = days(y, m, d) * DAY + h * 3_600_000 + min * 60_000 + s * 1000 + frac;
    let ms = match zone {
        Some(offset) => ms - offset * 60_000,
        None if date_only => ms,
        None => local(ms)?,
    };
    clip(ms as f64)
}
fn zone(text: &str) -> Option<i64> {
    let upper = text.to_ascii_uppercase();
    match upper.as_str() {
        "Z" | "GMT" | "UTC" | "UT" => Some(0),
        "EST" => Some(-300),
        "EDT" => Some(-240),
        "CST" => Some(-360),
        "CDT" => Some(-300),
        "MST" => Some(-420),
        "MDT" => Some(-360),
        "PST" => Some(-480),
        "PDT" => Some(-420),
        _ => {
            let text = upper
                .strip_prefix("GMT")
                .or_else(|| upper.strip_prefix("UTC"))
                .unwrap_or(&upper);
            let sign = if text.starts_with('+') {
                1
            } else if text.starts_with('-') {
                -1
            } else {
                return None;
            };
            let digits = text[1..].replace(':', "");
            let (h, m) = match digits.len() {
                1 | 2 => (digits.parse::<i64>().ok()?, 0),
                3 | 4 => (
                    digits[..digits.len() - 2].parse::<i64>().ok()?,
                    digits[digits.len() - 2..].parse::<i64>().ok()?,
                ),
                _ => return None,
            };
            (h <= 23 && m <= 59).then_some(sign * (h * 60 + m))
        }
    }
}
/// An instant precise enough to time a call: a full date and time with seconds and an explicit zone. A date
/// alone, minutes only or a local time parse as instants too, but their error can be hours.
pub fn precise(text: &str) -> Option<i64> {
    static FULL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2})$").unwrap()
    });
    if FULL.is_match(text) { parse(text) } else { None }
}
pub fn parse(text: &str) -> Option<i64> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^([0-9]{4}|[+-][0-9]{6})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?$").unwrap()
    });
    if let Some(c) = ISO.captures(text) {
        if c[1].eq("-000000") || (c.get(4).is_some() && c.get(3).is_none()) {
            return None;
        }
        let n = |i, default| {
            c.get(i)
                .map_or(Some(default), |x| x.as_str().parse::<i64>().ok())
        };
        let f = c.get(7).map_or("", |v| v.as_str());
        let frac: i64 = format!("{}000", &f[..f.len().min(3)])
            .get(..3)?
            .parse()
            .ok()?;
        return instant(
            [
                n(1, 0)?,
                n(2, 1)?,
                n(3, 1)?,
                n(4, 0)?,
                n(5, 0)?,
                n(6, 0)?,
                frac,
            ],
            match c.get(8) {
                Some(v) => Some(zone(v.as_str())?),
                None => None,
            },
            c.get(4).is_none(),
        );
    }
    // JSC rejects invalid ISO-like strings instead of feeding them to the legacy parser.
    if text
        .trim_matches(space)
        .as_bytes()
        .get(10)
        .is_some_and(|c| *c == b'T' || *c == b't')
    {
        return None;
    }
    legacy(text)
}
fn legacy(text: &str) -> Option<i64> {
    static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([^)]*\)").unwrap());
    static TIME: LazyLock<Regex> =
        LazyLock::new(|| regex(r"(?i)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(am|pm)?"));
    static ZONE: LazyLock<Regex> = LazyLock::new(|| {
        regex(
            r"(?i)(?:\s|^)(GMT|UTC|UT|[ECMP][SD]T)([+-]\d{1,4}(?::\d{2})?)?\s*$|([+-]\d{4}|[+-]\d{2}:\d{2}|Z)\s*$",
        )
    });
    let mut text = COMMENTS
        .replace_all(text.trim_matches(space), "")
        .to_string();
    let mut offset = None;
    if let Some(c) = ZONE.captures(&text) {
        offset = Some(zone(&format!(
            "{}{}",
            c.get(1).map_or("", |v| v.as_str()),
            c.get(2).or_else(|| c.get(3)).map_or("", |v| v.as_str())
        ))?);
        text.truncate(c.get(0)?.start());
    }
    let mut clock = [0, 0, 0, 0];
    if let Some(c) = TIME.captures(&text) {
        clock[0] = c[1].parse().ok()?;
        clock[1] = c[2].parse().ok()?;
        clock[2] = c.get(3).map_or(Some(0), |v| v.as_str().parse().ok())?;
        let f = c.get(4).map_or("", |v| v.as_str());
        clock[3] = format!("{}000", &f[..f.len().min(3)])[..3].parse().ok()?;
        if let Some(meridiem) = c.get(5) {
            if !(1..=12).contains(&clock[0]) {
                return None;
            }
            clock[0] = clock[0] % 12
                + if meridiem.as_str().eq_ignore_ascii_case("pm") {
                    12
                } else {
                    0
                };
        }
        let all = c.get(0)?;
        text.replace_range(all.start()..all.end(), " ");
    }
    let tokens: Vec<_> = text
        .split(|c: char| space(c) || matches!(c, ',' | '/' | '-'))
        .filter(|s| !s.is_empty())
        .collect();
    let mut month = None;
    let mut numbers = vec![];
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    for token in tokens {
        if token.bytes().all(|c| c.is_ascii_digit()) {
            numbers.push((token.parse::<i64>().ok()?, token.len()));
        } else {
            let lower = token.to_ascii_lowercase();
            if let Some(m) = months.iter().position(|m| lower.starts_with(m)) {
                if month.replace(m as i64 + 1).is_some() {
                    return None;
                }
            } else if !["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                .iter()
                .any(|d| lower.starts_with(d))
            {
                return None;
            }
        }
    }
    let (mut y, m, d) = if let Some(m) = month {
        if numbers.len() != 2 {
            return None;
        }
        if numbers[0].1 >= 3 || numbers[0].0 > 31 {
            (numbers[0].0, m, numbers[1].0)
        } else {
            (numbers[1].0, m, numbers[0].0)
        }
    } else {
        match numbers.as_slice() {
            [(y, len)] if *len >= 4 => (*y, 1, 1),
            [(n, _)] if *n <= 12 => (
                if *n == 0 { 2000 } else { 2001 },
                if *n == 0 { 1 } else { *n },
                1,
            ),
            [(n, _)] if *n >= 32 => (*n, 1, 1),
            [(a, len), (b, _)] if *len >= 4 || *a > 31 => (*a, *b, 1),
            [(a, _), (b, _)] => (2001, *a, *b),
            [(a, len), (b, _), (c, _)] if *len >= 4 || *a > 31 => (*a, *b, *c),
            [(a, _), (b, _), (c, _)] => (*c, *a, *b),
            _ => return None,
        }
    };
    if (0..=49).contains(&y) {
        y += 2000;
    } else if (50..=99).contains(&y) {
        y += 1900;
    }
    instant(
        [y, m, d, clock[0], clock[1], clock[2], clock[3]],
        offset,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_date_parse_and_clip() {
        for (source, expected) in [
            ("2026-02-30T00:00:00Z", "2026-03-02T00:00:00.000Z"),
            ("2026-01-01T24:00:00Z", "2026-01-02T00:00:00.000Z"),
            ("2026-01", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T12:34+0230", "2026-01-01T10:04:00.000Z"),
            ("+275760-09-13T00:00:00Z", "+275760-09-13T00:00:00.000Z"),
            ("Thu, 01 Jan 2026 12:34:56 GMT", "2026-01-01T12:34:56.000Z"),
        ] {
            assert_eq!(iso(parse(source).unwrap()), expected, "{source}");
        }
        for source in [
            "2026-01-01T24:01Z",
            "2026-13-01",
            "invalid",
            " 2026-01-01T00:00:00Z ",
            "2026-01-01T00:00:00+24:00",
        ] {
            assert!(parse(source).is_none(), "{source}");
        }
        assert_eq!(clip(-1.9), Some(-1));
    }
}
