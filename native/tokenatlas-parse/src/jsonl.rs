//! JSONL validity shared by every provider parser, checked on the bytes the parser already reads
//! (one read per file). Same rule as `validateArchivedJsonl` in TS: each line, decoded like
//! Buffer.toString and trimmed like String.trim, is blank or JSON; a final line without a newline
//! is an incomplete record unless it parses.
use crate::value;

/// JavaScript `String.prototype.trim`: Unicode White_Space without U+0085, plus U+FEFF.
fn js_space(c: char) -> bool {
    c == '\u{FEFF}' || c != '\u{85}' && c.is_whitespace()
}

/// serde_json is the fast path; `value::parse` (JSON.parse semantics, e.g. lone surrogates)
/// decides what serde rejects.
pub fn valid_record(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    let body = text.trim_matches(js_space);
    body.is_empty()
        || serde_json::from_str::<serde::de::IgnoredAny>(body).is_ok()
        || value::parse(body).is_ok()
}

pub fn invalid_record_message(file: &str, byte: usize) -> String {
    format!("Invalid JSONL record in {file} at byte {byte}")
}

pub fn incomplete_record_message(file: &str) -> String {
    format!("Accepted archive contains an incomplete JSONL record: {file}")
}

/// The first invalid record of a whole file held in memory.
pub fn invalid(file: &str, bytes: &[u8]) -> Option<String> {
    let mut start = 0;
    for newline in memchr::memchr_iter(b'\n', bytes) {
        if !valid_record(&bytes[start..newline]) {
            return Some(invalid_record_message(file, start));
        }
        start = newline + 1;
    }
    (!valid_record(&bytes[start..])).then(|| incomplete_record_message(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validity_matches_the_ts_rule() {
        assert_eq!(invalid("f", b"{\"a\":1}\n\n  \r\n[1]\n"), None);
        assert_eq!(invalid("f", b"\xEF\xBB\xBF{\"a\":1}\n"), None);
        assert_eq!(invalid("f", b"{\"s\":\"\\ud800\"}\n"), None);
        assert_eq!(invalid("f", b"{\"a\":1}\n{bad\n"), Some(invalid_record_message("f", 8)));
        assert_eq!(invalid("f", b"{\"a\":1}\n{\"b\":"), Some(incomplete_record_message("f")));
        assert_eq!(invalid("f", b"{\"a\":1}\n{\"b\":2}"), None);
        // String.trim removes NBSP and BOM at either edge, never U+0085.
        assert_eq!(invalid("f", "\u{A0}{}\u{A0}\n \u{FEFF}{}\n{}\u{FEFF}\n".as_bytes()), None);
        assert_eq!(invalid("f", "{}\u{85}\n".as_bytes()), Some(invalid_record_message("f", 0)));
    }
}
