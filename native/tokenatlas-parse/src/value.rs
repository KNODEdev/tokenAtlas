use num_bigint::BigInt;
use num_traits::FromPrimitive;

// JSON strings retain UTF-16 units: JSON.parse accepts unpaired surrogates.
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<V>),
    Obj(Vec<(Vec<u16>, V)>),
}
impl From<&str> for V {
    fn from(s: &str) -> Self {
        Self::Str(s.encode_utf16().collect())
    }
}
impl From<String> for V {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<f64> for V {
    fn from(n: f64) -> Self {
        Self::Num(n)
    }
}
impl V {
    pub fn obj() -> Self {
        Self::Obj(Vec::new())
    }
    pub fn get(&self, key: &str) -> &V {
        match self {
            Self::Obj(items) => items
                .iter()
                .find(|(k, _)| key_equal(k, key))
                .map(|(_, v)| v)
                .unwrap_or(&V::Null),
            _ => &V::Null,
        }
    }
    pub fn has(&self, key: &str) -> bool {
        matches!(self, Self::Obj(items) if items.iter().any(|(k,_)| key_equal(k, key)))
    }
    pub fn set(&mut self, key: &str, value: V) {
        self.insert(key.encode_utf16().collect(), value);
    }
    fn insert(&mut self, key: Vec<u16>, value: V) {
        if let Self::Obj(items) = self {
            if let Some((_, old)) = items.iter_mut().find(|(k, _)| *k == key) {
                *old = value;
            } else {
                items.push((key, value));
            }
        }
    }
    pub fn text(&self) -> Option<String> {
        if let Self::Str(s) = self {
            Some(String::from_utf16_lossy(s))
        } else {
            None
        }
    }
    pub fn is(&self, s: &str) -> bool {
        matches!(self, Self::Str(v) if v.iter().copied().eq(s.encode_utf16()))
    }
    pub fn dict(&self) -> bool {
        matches!(self, Self::Obj(_))
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(v) => *v,
            Self::Num(v) => *v != 0.0 && !v.is_nan(),
            Self::Str(v) => !v.is_empty(),
            Self::Arr(v) => !v.is_empty(),
            Self::Obj(v) => !v.is_empty(),
        }
    }
    pub fn or(&self, other: &V) -> V {
        if self.truthy() {
            self.clone()
        } else {
            other.clone()
        }
    }
    pub fn number(&self) -> Option<f64> {
        match self {
            Self::Num(n) => Some(*n),
            Self::Bool(b) => Some(u8::from(*b) as f64),
            _ => None,
        }
    }
    pub fn int(&self) -> bool {
        matches!(self, Self::Num(n) if n.is_finite() && n.fract() == 0.0)
    }
    pub fn valid_counter(&self) -> bool {
        self.int()
            && self
                .number()
                .is_some_and(|n| (0.0..=9007199254740991.0).contains(&n))
    }
    pub fn equal(&self, other: &V) -> bool {
        if let Some(a) = self.number() {
            return other.number() == Some(a);
        }
        match (self, other) {
            (Self::Obj(a), Self::Obj(b)) => {
                a.len() == b.len()
                    && a.iter().all(|(k, v)| {
                        b.iter()
                            .find(|(bk, _)| k == bk)
                            .is_some_and(|(_, bv)| v.equal(bv))
                    })
            }
            (Self::Arr(a), Self::Arr(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a.equal(b))
            }
            _ => self == other,
        }
    }
    pub fn keys(&self) -> Vec<&(Vec<u16>, V)> {
        let Self::Obj(items) = self else {
            return vec![];
        };
        let mut keys: Vec<_> = items.iter().collect();
        keys.sort_by_key(|(key, _)| index_key(key).map(|i| (0, i)).unwrap_or((1, 0)));
        keys
    }
    pub fn dumps(&self) -> String {
        self.encode(true, false)
    }
    pub fn json(&self) -> String {
        self.encode(false, false)
    }
    #[cfg(test)]
    pub fn key_json(&self) -> String {
        let mut out = String::new();
        self.write_encoded(&mut out, true);
        out
    }
    fn encode(&self, python: bool, key: bool) -> String {
        let comma = if python { ", " } else { "," };
        match self {
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string(),
            Self::Num(n) => {
                if python {
                    float_repr(*n, n.is_finite() && n.fract() == 0.0)
                } else if *n == 0.0 {
                    // Keys follow JSON.stringify; transport must retain structured-clone -0.
                    if !key && n.is_sign_negative() {
                        "-0".into()
                    } else {
                        "0".into()
                    }
                } else if n.is_finite() {
                    ryu::Buffer::new().format(*n).to_owned()
                } else if n.is_infinite() {
                    if key {
                        return "null".into();
                    }
                    // Valid JSON numeric syntax that JSON.parse rounds to infinity,
                    // preserving JS's overflow values across the JSON transport.
                    if *n > 0.0 {
                        "1e400".into()
                    } else {
                        "-1e400".into()
                    }
                } else {
                    "null".into()
                }
            }
            Self::Str(s) => quote(s, python),
            Self::Arr(a) => format!(
                "[{}]",
                a.iter()
                    .map(|v| v.encode(python, key))
                    .collect::<Vec<_>>()
                    .join(comma)
            ),
            Self::Obj(_) => format!(
                "{{{}}}",
                self.keys()
                    .iter()
                    .map(|(k, v)| format!(
                        "{}:{}{}",
                        quote(k, python),
                        if python { " " } else { "" },
                        v.encode(python, key)
                    ))
                    .collect::<Vec<_>>()
                    .join(comma)
            ),
        }
    }
    // IPC JSON is streamed into one buffer. Object insertion order is retained;
    // JSON.parse restores JS integer-key ordering on the Bun side.
    pub fn write_json(&self, out: &mut String) {
        self.write_encoded(out, false);
    }
    pub fn write_key_json(&self, out: &mut String) {
        self.write_encoded(out, true);
    }
    fn write_encoded(&self, out: &mut String, key: bool) {
        use std::fmt::Write as _;
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(true) => out.push_str("true"),
            Self::Bool(false) => out.push_str("false"),
            Self::Num(n) if *n == 0.0 => out.push_str(if !key && n.is_sign_negative() {
                "-0"
            } else {
                "0"
            }),
            Self::Num(n)
                if !key && n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0 =>
            {
                write!(out, "{}", *n as i64).unwrap();
            }
            Self::Num(n) if n.is_finite() => out.push_str(ryu::Buffer::new().format(*n)),
            Self::Num(n) if n.is_infinite() => out.push_str(if key {
                "null"
            } else if *n > 0.0 {
                "1e400"
            } else {
                "-1e400"
            }),
            Self::Num(_) => out.push_str("null"),
            Self::Str(s) => write_quote(s, out),
            Self::Arr(values) => {
                out.push('[');
                for (i, value) in values.iter().enumerate() {
                    if i != 0 {
                        out.push(',');
                    }
                    value.write_encoded(out, key);
                }
                out.push(']');
            }
            Self::Obj(values) => {
                out.push('{');
                fn items<'a>(
                    out: &mut String,
                    key: bool,
                    items: impl Iterator<Item = &'a (Vec<u16>, V)>,
                ) {
                    for (i, (name, value)) in items.enumerate() {
                        if i != 0 {
                            out.push(',');
                        }
                        write_quote(name, out);
                        out.push(':');
                        value.write_encoded(out, key);
                    }
                }
                if key {
                    items(out, key, self.keys().into_iter());
                } else {
                    items(out, key, values.iter());
                }
                out.push('}');
            }
        }
    }
    pub fn py_str(&self) -> Vec<u16> {
        match self {
            Self::Null => "None".encode_utf16().collect(),
            Self::Bool(true) => "True".encode_utf16().collect(),
            Self::Bool(false) => "False".encode_utf16().collect(),
            Self::Str(s) => s.clone(),
            _ => self.dumps().encode_utf16().collect(),
        }
    }
    pub fn hash_key(&self) -> Result<String, String> {
        match self {
            Self::Null => Ok("n".into()),
            Self::Num(_) | Self::Bool(_) => {
                let number = self.number().unwrap();
                Ok(if number == 0.0 {
                    "d0".into()
                } else {
                    format!("d{number}")
                })
            }
            Self::Str(s) => Ok(format!("s{}", quote(s, false))),
            _ => Err(format!("unhashable type: '{}'", self.py_type())),
        }
    }
    pub fn py_type(&self) -> &'static str {
        match self {
            Self::Null => "NoneType",
            Self::Bool(_) => "bool",
            Self::Num(_) if self.int() => "int",
            Self::Num(_) => "float",
            Self::Str(_) => "str",
            Self::Arr(_) => "list",
            Self::Obj(_) => "dict",
        }
    }
}
fn key_equal(key: &[u16], text: &str) -> bool {
    if text.is_ascii() {
        key.len() == text.len()
            && key
                .iter()
                .zip(text.as_bytes())
                .all(|(&a, &b)| a == b as u16)
    } else {
        key.iter().copied().eq(text.encode_utf16())
    }
}
fn index_key(s: &[u16]) -> Option<u32> {
    let text = String::from_utf16(s).ok()?;
    let n: u32 = text.parse().ok()?;
    (n != u32::MAX && n.to_string() == text).then_some(n)
}
fn quote(s: &[u16], python: bool) -> String {
    let mut out = String::from("\"");
    for &c in s {
        match c {
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            10 => out.push_str("\\n"),
            13 => out.push_str("\\r"),
            9 => out.push_str("\\t"),
            8 => out.push_str("\\b"),
            12 => out.push_str("\\f"),
            0..=31 | 0xd800..=0xdfff => out.push_str(&format!("\\u{c:04x}")),
            128..=65535 if python => out.push_str(&format!("\\u{c:04x}")),
            _ => out.push(char::from_u32(c as u32).unwrap()),
        }
    }
    out.push('"');
    out
}
fn write_quote(s: &[u16], out: &mut String) {
    const HEX: &[u8] = b"0123456789abcdef";
    out.push('"');
    for &c in s {
        match c {
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            10 => out.push_str("\\n"),
            13 => out.push_str("\\r"),
            9 => out.push_str("\\t"),
            8 => out.push_str("\\b"),
            12 => out.push_str("\\f"),
            0..=31 | 0xd800..=0xdfff => {
                out.push_str("\\u");
                for shift in [12, 8, 4, 0] {
                    out.push(HEX[((c >> shift) & 15) as usize] as char);
                }
            }
            _ => out.push(char::from_u32(c as u32).unwrap()),
        }
    }
    out.push('"');
}
pub fn float_repr(n: f64, integral: bool) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if !n.is_finite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if integral {
        return BigInt::from_f64(n).unwrap().to_string();
    }
    let mut buffer = ryu::Buffer::new();
    let raw = buffer.format(n.abs());
    let (mantissa, exp) = raw
        .split_once('e')
        .map(|(m, e)| (m, e.parse::<i32>().unwrap()))
        .unwrap_or((raw, 0));
    let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let leading = digits.chars().take_while(|c| *c == '0').count();
    let digits = digits[leading..].trim_end_matches('0');
    let exponent = exp + decimal - leading as i32 - 1;
    let sign = if n.is_sign_negative() { "-" } else { "" };
    if !(-4..16).contains(&exponent) {
        format!(
            "{sign}{}{}e{}{:02}",
            &digits[..1],
            if digits.len() > 1 {
                format!(".{}", &digits[1..])
            } else {
                String::new()
            },
            if exponent < 0 { "-" } else { "+" },
            exponent.abs()
        )
    } else if exponent < 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-exponent - 1) as usize))
    } else {
        let width = (exponent + 1) as usize;
        let whole = format!(
            "{}{}",
            &digits[..width.min(digits.len())],
            "0".repeat(width.saturating_sub(digits.len()))
        );
        format!(
            "{sign}{whole}.{}",
            if width < digits.len() {
                &digits[width..]
            } else {
                "0"
            }
        )
    }
}

// A small JSON.parse-compatible reader: all numbers are f64, duplicate keys retain
// their first position and last value, and escaped lone UTF-16 units are accepted.
pub fn parse(text: &str) -> Result<V, String> {
    let mut p = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.pos != p.bytes.len() {
        return Err("invalid JSON tail".into());
    }
    Ok(v)
}
struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl Parser<'_> {
    fn ws(&mut self) {
        while self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\n' | b'\r')
        {
            self.pos += 1;
        }
    }
    fn take(&mut self, c: u8) -> bool {
        self.ws();
        if self.bytes.get(self.pos) == Some(&c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn value(&mut self) -> Result<V, String> {
        self.ws();
        match self.bytes.get(self.pos).copied() {
            Some(b'"') => Ok(V::Str(self.string()?)),
            Some(b'{') => {
                self.pos += 1;
                let mut out = V::obj();
                if self.take(b'}') {
                    return Ok(out);
                }
                loop {
                    self.ws();
                    let key = self.string()?;
                    if !self.take(b':') {
                        return Err("expected colon".into());
                    }
                    out.insert(key, self.value()?);
                    if self.take(b'}') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err("expected comma".into());
                    }
                }
                Ok(out)
            }
            Some(b'[') => {
                self.pos += 1;
                let mut out = vec![];
                if self.take(b']') {
                    return Ok(V::Arr(out));
                }
                loop {
                    out.push(self.value()?);
                    if self.take(b']') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err("expected comma".into());
                    }
                }
                Ok(V::Arr(out))
            }
            Some(b't') if self.literal(b"true") => Ok(V::Bool(true)),
            Some(b'f') if self.literal(b"false") => Ok(V::Bool(false)),
            Some(b'n') if self.literal(b"null") => Ok(V::Null),
            Some(b'-' | b'0'..=b'9') => {
                let start = self.pos;
                if self.bytes[self.pos] == b'-' {
                    self.pos += 1;
                }
                if self.bytes.get(self.pos) == Some(&b'0') {
                    self.pos += 1;
                } else {
                    self.digits()?;
                }
                if self.bytes.get(self.pos) == Some(&b'.') {
                    self.pos += 1;
                    self.digits()?;
                }
                if matches!(self.bytes.get(self.pos), Some(b'e' | b'E')) {
                    self.pos += 1;
                    if matches!(self.bytes.get(self.pos), Some(b'+' | b'-')) {
                        self.pos += 1;
                    }
                    self.digits()?;
                }
                Ok(V::Num(
                    std::str::from_utf8(&self.bytes[start..self.pos])
                        .unwrap()
                        .parse::<f64>()
                        .map_err(|e| e.to_string())?,
                ))
            }
            _ => Err("invalid JSON value".into()),
        }
    }
    fn literal(&mut self, s: &[u8]) -> bool {
        if self.bytes[self.pos..].starts_with(s) {
            self.pos += s.len();
            true
        } else {
            false
        }
    }
    fn digits(&mut self) -> Result<(), String> {
        let start = self.pos;
        while self.bytes.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        if self.pos == start {
            Err("expected digit".into())
        } else {
            Ok(())
        }
    }
    fn string(&mut self) -> Result<Vec<u16>, String> {
        if self.bytes.get(self.pos) != Some(&b'"') {
            return Err("expected string".into());
        }
        self.pos += 1;
        let mut out = vec![];
        loop {
            let Some(&c) = self.bytes.get(self.pos) else {
                return Err("unfinished string".into());
            };
            self.pos += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(&e) = self.bytes.get(self.pos) else {
                        return Err("unfinished escape".into());
                    };
                    self.pos += 1;
                    out.push(match e {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let end = self.pos + 4;
                            let hex = self.bytes.get(self.pos..end).ok_or("unfinished unicode")?;
                            self.pos = end;
                            if !hex.iter().all(u8::is_ascii_hexdigit) {
                                return Err("invalid unicode".into());
                            }
                            u16::from_str_radix(std::str::from_utf8(hex).unwrap(), 16)
                                .map_err(|e| e.to_string())?
                        }
                        _ => return Err("invalid escape".into()),
                    });
                }
                0..=31 => return Err("control character".into()),
                32..=127 => out.push(c as u16),
                _ => {
                    // The source is already valid UTF-8; validate this scalar only,
                    // rather than rescanning the remaining JSON for every character.
                    let width = if c < 0xe0 {
                        2
                    } else if c < 0xf0 {
                        3
                    } else {
                        4
                    };
                    let ch = std::str::from_utf8(&self.bytes[self.pos - 1..self.pos - 1 + width])
                        .unwrap()
                        .chars()
                        .next()
                        .unwrap();
                    self.pos += ch.len_utf8() - 1;
                    let mut units = [0; 2];
                    out.extend_from_slice(ch.encode_utf16(&mut units));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_json_preserves_codec_values() {
        for input in [
            r#"[-0, 0, 1e400, -1e400, 1.0, 0.00001, 9007199254740993]"#,
            r#"{"z":"😀\ud800\u0000","2":true,"10":null,"1":{"b":1,"a":2}}"#,
        ] {
            let value = parse(input).unwrap();
            assert_eq!(value.key_json(), value.encode(false, true));
        }
        let value=parse(r#"{"z":["\ud800😀\u0000\n\r\t\b\f\\\"", -0.0,1e400,-1e400,9007199254740993,0.00001],"2":true,"a":null}"#).unwrap();
        let mut out = String::new();
        value.write_json(&mut out);
        let decoded = parse(&out).unwrap();
        assert!(value.equal(&decoded));
        if let V::Arr(values) = decoded.get("z") {
            assert!(values[1].number().unwrap().is_sign_negative());
            assert_eq!(values[2].number(), Some(f64::INFINITY));
            assert_eq!(values[3].number(), Some(f64::NEG_INFINITY));
        } else {
            panic!("missing array");
        }
    }

    #[test]
    fn js_keys_surrogates_and_numbers() {
        let v =
            parse(r#"{"z":"😀\ud800\u007f","10":1,"2":9007199254740993,"z":"\ud800","a":1e-5}"#)
                .unwrap();
        assert_eq!(
            v.dumps(),
            "{\"2\": 9007199254740992, \"10\": 1, \"z\": \"\\ud800\", \"a\": 1e-05}"
        );
        assert!(parse("\u{feff}{}").is_err());
        assert_eq!(float_repr(0.0001, false), "0.0001");
        assert_eq!(float_repr(1.0, false), "1.0");
        assert_eq!(float_repr(1e16, false), "1e+16");
        assert_eq!(V::from("😀\u{7f}").dumps(), "\"\\ud83d\\ude00\u{7f}\"");
        assert_eq!(parse("1e400").unwrap().json(), "1e400");
        assert_eq!(parse("-0.0").unwrap().json(), "-0");
        assert_eq!(parse("-0.0").unwrap().key_json(), "0");
    }
}
