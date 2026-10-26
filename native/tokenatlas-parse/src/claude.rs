use crate::{
    js_date,
    value::{self, V},
};
use chrono::{Datelike, TimeZone, Timelike};
use num_traits::ToPrimitive;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, BufReader},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::SystemTime,
};

type Owners = HashMap<Vec<u16>, Vec<String>>;
struct CachedOwners {
    size: u64,
    modified: SystemTime,
    owners: Arc<Owners>,
}
static OWNER_CACHE: LazyLock<Mutex<HashMap<String, CachedOwners>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap());

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub code: Option<&'static str>,
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}
pub(crate) fn io_error(error: io::Error, file: &str) -> Error {
    let code = match error.kind() {
        io::ErrorKind::NotFound => Some("ENOENT"),
        io::ErrorKind::PermissionDenied => Some("EACCES"),
        _ => None,
    };
    Error {
        message: match code {
            Some("ENOENT") => format!("ENOENT: no such file or directory, open '{file}'"),
            Some("EACCES") => format!("EACCES: permission denied, open '{file}'"),
            _ => error.to_string(),
        },
        code,
    }
}
fn lines(
    file: &str,
    owners_only: bool,
    validate: bool,
    visit: impl FnMut(V) -> Result<(), Error>,
    skipped: impl FnMut(&[u8]),
) -> Result<(String, usize), Error> {
    records(
        file,
        validate,
        |bytes| {
            let contains = |needle: &[u8]| memchr::memmem::find(bytes, needle).is_some();
            contains(b"bridge-session")
                || if owners_only {
                    contains(b"\"init\"")
                } else {
                    contains(b"assistant")
                }
        },
        visit,
        skipped,
    )
}
/// Every record of a JSONL file that `keep` admits (a byte prefilter), with the file's SHA-256 and length.
pub(crate) fn records(
    file: &str,
    validate: bool,
    keep: impl Fn(&[u8]) -> bool,
    mut visit: impl FnMut(V) -> Result<(), Error>,
    mut skipped: impl FnMut(&[u8]),
) -> Result<(String, usize), Error> {
    let mut reader = BufReader::with_capacity(
        1 << 20,
        crate::rollout_codec::reader(
            file, fs::metadata(file).map_err(|e| io_error(e, file))?.len(),
        ).map_err(|e| io_error(e, file))?,
    );
    let mut bytes = Vec::new();
    let mut offset = 0;
    // The whole file's SHA-256 from this same read: the sync queue's identity of the parsed bytes.
    let mut sha = Sha256::new();
    loop {
        bytes.clear();
        let read = reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| io_error(e, file))?;
        if read == 0 {
            break;
        }
        sha.update(&bytes);
        let complete = bytes.last() == Some(&b'\n');
        if complete {
            bytes.pop();
        }
        // A queued file is validated in this read instead of a separate pass over the whole file.
        if (validate || crate::rollout_codec::compressed(file)) && !crate::jsonl::valid_record(&bytes) {
            let message = if complete {
                crate::jsonl::invalid_record_message(file, offset)
            } else {
                crate::jsonl::incomplete_record_message(file)
            };
            return Err(Error { message, code: Some("EINVAL") });
        }
        offset += read;
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        if !keep(&bytes) {
            skipped(&bytes);
            continue;
        }
        // Match Buffer.toString and JSON.parse, including BOM rejection and last duplicate key.
        if let Ok(obj) = value::parse(&String::from_utf8_lossy(&bytes)) {
            visit(obj)?;
        }
    }
    Ok((format!("{:x}", sha.finalize()), offset))
}
fn truthy(v: &V) -> bool {
    matches!(v, V::Arr(_) | V::Obj(_)) || v.truthy()
}
fn or(a: &V, b: &V) -> V {
    if truthy(a) { a.clone() } else { b.clone() }
}
fn coalesce(a: &V, b: &V) -> V {
    if matches!(a, V::Null) {
        b.clone()
    } else {
        a.clone()
    }
}
fn fallback(v: &V) -> V {
    or(v, &V::Null)
}
fn zero(v: &V) -> V {
    coalesce(v, &V::Num(0.0))
}
fn key_json(v: &V) -> String {
    let mut out = String::new();
    v.write_key_json(&mut out);
    out
}
pub(super) fn number_string(n: f64) -> String {
    if !n.is_finite() {
        return value::float_repr(n, false);
    }
    if n == 0.0 {
        return "0".into();
    }
    let mut buffer = ryu::Buffer::new();
    let raw = buffer.format(n.abs());
    let (mantissa, exp) = raw
        .split_once('e')
        .map(|(m, e)| (m, e.parse::<i32>().unwrap()))
        .unwrap_or((raw, 0));
    let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let leading = digits.bytes().take_while(|c| *c == b'0').count();
    let digits = digits[leading..].trim_end_matches('0');
    let exponent = exp + decimal - leading as i32 - 1;
    let sign = if n.is_sign_negative() { "-" } else { "" };
    if !(-6..21).contains(&exponent) {
        format!(
            "{sign}{}{}e{exponent:+}",
            &digits[..1],
            if digits.len() > 1 {
                format!(".{}", &digits[1..])
            } else {
                String::new()
            }
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
            "{sign}{whole}{}",
            if width < digits.len() {
                format!(".{}", &digits[width..])
            } else {
                String::new()
            }
        )
    }
}
pub(super) fn js_string(v: &V) -> String {
    match v {
        V::Str(_) => v.text().unwrap(),
        V::Obj(_) => "[object Object]".into(),
        V::Arr(items) => items
            .iter()
            .map(|v| {
                if matches!(v, V::Null) {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        V::Num(n) => number_string(*n),
        _ => key_json(v),
    }
}
fn number(v: &V) -> f64 {
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap()
    });
    match v {
        V::Num(n) => *n,
        V::Bool(b) => u8::from(*b) as f64,
        V::Null => 0.0,
        _ => {
            let owned = js_string(v);
            let text = owned.trim_matches(js_date::space);
            if text.is_empty() {
                0.0
            } else if text == "Infinity" || text == "+Infinity" {
                f64::INFINITY
            } else if text == "-Infinity" {
                f64::NEG_INFINITY
            } else if let Some((digits, base)) = text
                .strip_prefix("0x")
                .or_else(|| text.strip_prefix("0X"))
                .map(|s| (s, 16))
                .or_else(|| {
                    text.strip_prefix("0b")
                        .or_else(|| text.strip_prefix("0B"))
                        .map(|s| (s, 2))
                })
                .or_else(|| {
                    text.strip_prefix("0o")
                        .or_else(|| text.strip_prefix("0O"))
                        .map(|s| (s, 8))
                })
            {
                num_bigint::BigUint::parse_bytes(digits.as_bytes(), base)
                    .map_or(f64::NAN, |n| n.to_f64().unwrap_or(f64::INFINITY))
            } else if DECIMAL.is_match(text) {
                text.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
    }
}
fn add(a: &V, b: &V) -> V {
    if matches!(a, V::Str(_) | V::Arr(_) | V::Obj(_))
        || matches!(b, V::Str(_) | V::Arr(_) | V::Obj(_))
    {
        // Concatenation must retain lone UTF-16 surrogates, just as JS does.
        let units = |v: &V| match v {
            V::Str(s) => s.clone(),
            _ => js_string(v).encode_utf16().collect(),
        };
        let mut text = units(a);
        text.extend(units(b));
        V::Str(text)
    } else {
        V::Num(number(a) + number(b))
    }
}
fn greater(a: &V, b: &V) -> bool {
    // Relational comparison uses lexicographic UTF-16 when both primitives are strings.
    let primitive = |v: &V| {
        if matches!(v, V::Arr(_) | V::Obj(_)) {
            V::from(js_string(v))
        } else {
            v.clone()
        }
    };
    let (a, b) = (primitive(a), primitive(b));
    if let (V::Str(a), V::Str(b)) = (&a, &b) {
        a > b
    } else {
        number(&a) > number(&b)
    }
}
fn account(a: &V, b: &V) -> Option<String> {
    let (a, b) = (a.text()?, b.text()?);
    (UUID.is_match(&a) && UUID.is_match(&b)).then(|| {
        format!(
            "claude:{}:{}",
            a.to_ascii_lowercase(),
            b.to_ascii_lowercase()
        )
    })
}
fn add_owner(owners: &mut Owners, session: &V, key: Option<String>) {
    if let (V::Str(session), Some(key)) = (session, key) {
        let values = owners.entry(session.clone()).or_default();
        if !values.contains(&key) {
            values.push(key);
        }
    }
}
pub fn companion(store: &str, file: &str) -> Option<String> {
    static AUDIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-audit\.jsonl$").unwrap());
    static DESKTOP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^([0-9a-f]{8})-([0-9a-f-]{36})\.jsonl$").unwrap());
    let canonical = file.strip_suffix(".zst").unwrap_or(file);
    let path = Path::new(canonical);
    let name = path.file_name()?.to_str()?;
    let parent = path.parent()?;
    if store == "desktop" && AUDIT.is_match(name) {
        return Some(file.into());
    }
    if parent.file_name()?.to_str()? == "subagents" {
        let session = parent.parent()?;
        if UUID.is_match(session.file_name()?.to_str()?) {
            return Some(format!("{}.jsonl", session.display()));
        }
    }
    if store == "desktop"
        && let Some(c) = DESKTOP.captures(name)
    {
        return Some(
            parent
                .join(format!("{}-audit.jsonl", &c[1]))
                .to_string_lossy()
                .into(),
        );
    }
    None
}
fn companion_owners(file: &str) -> Result<Arc<Owners>, Error> {
    static CWD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)/Claude/local-agent-mode-sessions/([^/]+)/([^/]+)/local_([^/]+)(?:/|$)")
            .unwrap()
    });
    // No negative cache: a companion created later in the same process must be visible.
    let stat = match fs::metadata(file) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Arc::new(Owners::new())),
        Err(e) => return Err(io_error(e, file)),
    };
    let modified = stat.modified().map_err(|e| io_error(e, file))?;
    if let Some(cached) = OWNER_CACHE.lock().unwrap().get(file)
        && cached.size == stat.len()
        && cached.modified == modified
    {
        return Ok(cached.owners.clone());
    }
    let mut owners = Owners::new();
    lines(file, true, false, |obj| {
        if obj.get("type").is("bridge-session") {
            add_owner(
                &mut owners,
                obj.get("sessionId"),
                account(
                    obj.get("ownerAccountUuid"),
                    obj.get("ownerOrganizationUuid"),
                ),
            );
        }
        if obj.get("type").is("system")
            && obj.get("subtype").is("init")
            && let Some(cwd) = obj.get("cwd").text()
            && let Some(c) = CWD.captures(&cwd.replace('\\', "/"))
        {
            let name = Path::new(file)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let prefix = name
                .to_ascii_lowercase()
                .trim_end_matches("-audit.jsonl")
                .to_string();
            if c[3].to_ascii_lowercase().starts_with(&(prefix + "-")) {
                add_owner(
                    &mut owners,
                    obj.get("session_id"),
                    account(&V::from(&c[1]), &V::from(&c[2])),
                );
            }
        }
        Ok(())
    }, |_| {})?;
    let after = fs::metadata(file).map_err(|e| io_error(e, file))?;
    if after.len() != stat.len() || after.modified().map_err(|e| io_error(e, file))? != modified {
        return Err("Claude identity companion changed while parsing"
            .to_string()
            .into());
    }
    let owners = Arc::new(owners);
    let mut cache = OWNER_CACHE.lock().unwrap();
    if cache.len() >= 4096 {
        cache.clear();
    }
    cache.insert(
        file.into(),
        CachedOwners {
            size: stat.len(),
            modified,
            owners: owners.clone(),
        },
    );
    Ok(owners)
}
#[derive(Clone)]
struct Refusal {
    kind: String,
    reset: V,
    basis: &'static str,
}
fn text_refusal(text: &V, timestamp: &V) -> Option<Refusal> {
    static TEXT: LazyLock<Regex> = LazyLock::new(|| {
        js_date::regex(
            r"(?i)^You've hit your (weekly |session )?limit\s*·\s*resets\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?(am|pm)\s+\(([^)]+)\)$",
        )
    });
    let text = text.text()?;
    let c = TEXT.captures(text.trim_matches(js_date::space))?;
    let at = js_date::parse(&js_string(timestamp))?;
    let name = &c[7];
    let zone = chrono_tz::TZ_VARIANTS
        .iter()
        .find(|z| z.name().eq_ignore_ascii_case(name));
    // Intl also accepts numeric offset timezone identifiers.
    static FIXED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([+-])([0-9]{2})(?::?([0-9]{2}))?$").unwrap());
    let fixed = FIXED.captures(name).and_then(|c| {
        let hours = c[2].parse::<i32>().ok()?;
        let minutes = c
            .get(3)
            .map_or(Some(0), |v| v.as_str().parse::<i32>().ok())?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        chrono::FixedOffset::east_opt(
            (hours * 3600 + minutes * 60) * if &c[1] == "+" { 1 } else { -1 },
        )
    });
    let parts = |ms| {
        if let Some(zone) = zone {
            zone.timestamp_millis_opt(ms)
                .single()
                .map(|d| d.naive_local())
        } else {
            fixed?
                .timestamp_millis_opt(ms)
                .single()
                .map(|d| d.naive_local())
        }
    };
    let local = parts(at)?;
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = if let Some(m) = c.get(2) {
        months
            .iter()
            .position(|v| v.eq_ignore_ascii_case(m.as_str()))? as u32
            + 1
    } else {
        local.month()
    };
    let day = c
        .get(3)
        .map_or(Some(local.day()), |v| v.as_str().parse::<u32>().ok())?;
    let raw_hour = c[4].parse::<u32>().ok()?;
    let hour = raw_hour % 12
        + if c[6].eq_ignore_ascii_case("pm") {
            12
        } else {
            0
        };
    let minute = c
        .get(5)
        .map_or(Some(0), |v| v.as_str().parse::<u32>().ok())?;
    if !(1..=31).contains(&day) || !(1..=12).contains(&raw_hour) || minute > 59 {
        return None;
    }
    let mut reset = None;
    for step in 0..if c.get(2).is_some() { 2 } else { 3 } {
        let date = if c.get(2).is_some() {
            chrono::NaiveDate::from_ymd_opt(local.year() + step, month, day)
        } else {
            local
                .date()
                .checked_add_signed(chrono::TimeDelta::days(i64::from(step)))
        };
        let Some(date) = date else {
            continue;
        };
        let wall = date
            .and_hms_opt(hour, minute, 0)?
            .and_utc()
            .timestamp_millis();
        for offset in (-14 * 60..=14 * 60).step_by(15) {
            let candidate = wall - i64::from(offset) * 60_000;
            if candidate <= at || reset.is_some_and(|r| candidate >= r) {
                continue;
            }
            let v = parts(candidate)?;
            if v.date() == date && v.hour() == hour && v.minute() == minute {
                reset = Some(candidate);
            }
        }
        if reset.is_some() {
            break;
        }
    }
    let reset = reset?;
    let named = c.get(1).map(|v| v.as_str().trim().to_ascii_lowercase());
    Some(Refusal {
        kind: match named.as_deref() {
            Some("weekly") => "seven_day",
            Some("session") => "five_hour",
            _ if reset - at > 5 * 60 * 60_000 => "seven_day",
            _ => "five_hour",
        }
        .into(),
        reset: V::from(js_date::iso(reset)),
        basis: if named.is_some() {
            "text"
        } else {
            "inferred_from_reset"
        },
    })
}
fn refusal(obj: &V) -> Result<Option<Refusal>, Error> {
    static KIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9_]{1,40}$").unwrap());
    let quota = obj.get("quotaLimits");
    if !matches!(quota, V::Null) {
        if !quota.get("status").is("rejected") {
            return Ok(None);
        }
        let Some(kind) = quota
            .get("rateLimitType")
            .text()
            .filter(|s| KIND.is_match(s))
        else {
            return Ok(None);
        };
        let reset = if let V::Num(n) = quota.get("resetsAt") {
            if n.is_finite() {
                let ms = n * 1000.0;
                if ms.is_finite() {
                    V::from(js_date::iso(
                        js_date::clip(ms)
                            .ok_or_else(|| Error::from("Invalid time value".to_string()))?,
                    ))
                } else {
                    V::Null
                }
            } else {
                V::Null
            }
        } else {
            V::Null
        };
        return Ok(Some(Refusal {
            kind,
            reset,
            basis: "vendor",
        }));
    }
    if !obj.get("error").is("rate_limit") || obj.get("isApiErrorMessage") != &V::Bool(true) {
        return Ok(None);
    }
    let content = obj.get("message").get("content");
    let text = if let V::Arr(items) = content {
        items
            .iter()
            .find(|v| v.get("type").is("text"))
            .map_or(&V::Null, |v| v.get("text"))
    } else {
        &V::Null
    };
    Ok(text_refusal(
        text,
        &coalesce(obj.get("timestamp"), obj.get("_audit_timestamp")),
    ))
}
/// What a call's start is found from: the records its first block's `parentUuid` chain passes.
#[derive(Clone, Copy, PartialEq)]
enum HeadKind {
    /// The prompt or tool result the call answers: its timestamp is the request start.
    User,
    /// Records Claude Code writes between that user record and the request (reminders, hook progress).
    Pass,
    /// A retried request (`system` `api_error`): the time would include the failed attempt and the wait.
    Stop,
}
struct Head {
    kind: HeadKind,
    parent: Option<String>,
    at: Option<i64>,
    /// The record's place in the file: of two records with one uuid the earlier is read.
    line: usize,
}
const HEAD_HOPS: usize = 64;
fn head_kind(kind: Option<&str>, subtype: Option<&str>) -> Option<HeadKind> {
    match kind? {
        "user" => Some(HeadKind::User),
        "attachment" | "progress" => Some(HeadKind::Pass),
        "system" if subtype == Some("api_error") => Some(HeadKind::Stop),
        "system" => Some(HeadKind::Pass),
        // Another call or an unknown record type ends the chain without a start.
        _ => None,
    }
}
fn add_head(
    heads: &mut HashMap<String, Head>,
    line: usize,
    kind: Option<&str>,
    subtype: Option<&str>,
    uuid: Option<String>,
    parent: Option<String>,
    timestamp: Option<&str>,
) {
    let (Some(kind), Some(uuid)) = (head_kind(kind, subtype), uuid) else {
        return;
    };
    // A repeated uuid (a copied record) keeps its first reading in the file.
    heads.entry(uuid).or_insert(Head {
        kind,
        parent,
        at: timestamp.and_then(js_date::precise),
        line,
    });
}
/// Reads only the top-level fields a header needs; the rest of a (possibly large) record is skipped.
fn raw_head(bytes: &[u8], line: usize, heads: &mut HashMap<String, Head>) {
    const WANTED: [&str; 5] = ["type", "subtype", "uuid", "parentUuid", "timestamp"];
    struct Fields(HashMap<&'static str, serde_json::Value>);
    impl<'de> serde::Deserialize<'de> for Fields {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct Visit;
            impl<'de> serde::de::Visitor<'de> for Visit {
                type Value = Fields;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a record")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Fields, A::Error> {
                    let mut out = HashMap::new();
                    while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                        // The last duplicate key wins, as JSON.parse reads it.
                        if let Some(k) = WANTED.into_iter().find(|k| *k == key) {
                            out.insert(k, map.next_value::<serde_json::Value>()?);
                        } else {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                    Ok(Fields(out))
                }
            }
            d.deserialize_map(Visit)
        }
    }
    if memchr::memmem::find(bytes, b"\"uuid\"").is_none() {
        return;
    }
    let Ok(Fields(fields)) = serde_json::from_slice::<Fields>(bytes) else {
        return;
    };
    let text = |k: &str| fields.get(k).and_then(|v| v.as_str());
    add_head(
        heads,
        line,
        text("type"),
        text("subtype"),
        text("uuid").map(str::to_owned),
        text("parentUuid").map(str::to_owned),
        text("timestamp"),
    );
}
/// The request start of a call: the user record its first block's parent chain reaches in this file.
fn request_start(heads: &HashMap<String, Head>, parent: Option<&str>) -> Option<i64> {
    let mut uuid = parent?;
    for _ in 0..HEAD_HOPS {
        let head = heads.get(uuid)?;
        match head.kind {
            HeadKind::User => return head.at,
            HeadKind::Pass => uuid = head.parent.as_deref()?,
            HeadKind::Stop => return None,
        }
    }
    None
}
struct Call {
    id: V,
    stop: V,
    out: V,
    obj: V,
    /// `parentUuid` of the call's first block.
    parent: Option<String>,
    /// Latest recorded `timestamp` of its blocks; None once any block lacks a precise one.
    end: Option<i64>,
}
fn map_key(v: &V, index: usize) -> String {
    // JS Map compares object keys by identity, primitives by value (including -0).
    if matches!(v, V::Obj(_) | V::Arr(_)) {
        format!("object:{index}")
    } else {
        format!(
            "{}:{}",
            match v {
                V::Str(_) => "s",
                V::Num(_) => "n",
                V::Bool(_) => "b",
                _ => "null",
            },
            if let V::Num(n) = v {
                number_string(*n)
            } else {
                key_json(v)
            }
        )
    }
}
fn identity(row: &mut V, obj: &V, owners: &Owners) {
    let session = or(obj.get("sessionId"), &fallback(obj.get("session_id")));
    let keys = if let V::Str(s) = &session {
        owners.get(s)
    } else {
        None
    };
    let conflict = keys.is_some_and(|k| k.len() > 1);
    let key = keys.filter(|k| k.len() == 1).map(|k| k[0].clone());
    row.set("session_id", session);
    row.set("account_key", key.clone().map_or(V::Null, V::from));
    row.set(
        "subscription_conflict",
        V::Num(if conflict { 1.0 } else { 0.0 }),
    );
    row.set(
        "subscription_id",
        key.map_or(V::Null, |key| {
            V::from(format!(
                "claude-{}",
                &format!("{:x}", Sha256::digest(key.as_bytes()))[..16]
            ))
        }),
    );
}
fn timestamp(obj: &V, since: Option<&str>) -> Option<String> {
    let ts = js_date::iso(js_date::parse(&obj.get("timestamp").text()?)?);
    if since.is_some_and(|s| !s.is_empty() && ts.encode_utf16().cmp(s.encode_utf16()).is_lt()) {
        None
    } else {
        Some(ts)
    }
}
/// The project name of a working directory: its last path segment (Bun's `path.basename`), as the remap reads it.
pub(crate) fn project_of(cwd: &V) -> Result<V, Error> {
    if !truthy(cwd) {
        return Ok(V::Null);
    }
    let V::Str(units) = cwd else {
        return Err("cwd.replace is not a function. (In 'cwd.replace(/\\\\/g, \"/\")', 'cwd.replace' is undefined)".to_string().into());
    };
    let text: Vec<u16> = units
        .iter()
        .map(|u| if *u == 92 { 47 } else { *u })
        .collect();
    let mut end = text.len();
    while end > 0 && text[end - 1] == 47 {
        end -= 1;
    }
    let drive = if cfg!(windows)
        && text.len() >= 2
        && (text[0] as u8).is_ascii_alphabetic()
        && text[0] < 128
        && text[1] == 58
    {
        2
    } else {
        0
    };
    let start = text[..end]
        .iter()
        .rposition(|u| *u == 47)
        .map_or(drive, |p| p + 1);
    Ok(if start >= end {
        cwd.clone()
    } else {
        // Bun's path.basename goes through UTF-8, replacing lone surrogates.
        V::from(String::from_utf16_lossy(&text[start..end]))
    })
}
pub fn parse(store: &str, file: &str, since: Option<&str>, validate: bool) -> Result<V, Error> {
    if crate::claude_cloud::is_events_file(file) {
        return crate::claude_cloud::parse(store, file, since, validate);
    }
    let mut calls = Vec::<Call>::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut refusals = Vec::<(V, V, Refusal)>::new();
    let mut refusal_positions = HashMap::<String, usize>::new();
    let mut owners = Owners::new();
    let mut index = 0;
    // Headers come from two readings (whole records and header-only ones), merged by their place in the file.
    let mut heads = HashMap::<String, Head>::new();
    let mut raw_heads = HashMap::<String, Head>::new();
    let line = std::cell::Cell::new(0usize);
    let next_line = || {
        line.set(line.get() + 1);
        line.get()
    };
    let (source_sha256, source_bytes) = lines(file, false, validate, |mut obj| {
        if obj.get("type").is("bridge-session") {
            add_owner(
                &mut owners,
                obj.get("sessionId"),
                account(
                    obj.get("ownerAccountUuid"),
                    obj.get("ownerOrganizationUuid"),
                ),
            );
            return Ok(());
        }
        let position = next_line();
        if !obj.get("type").is("assistant") {
            add_head(
                &mut heads,
                position,
                obj.get("type").text().as_deref(),
                obj.get("subtype").text().as_deref(),
                obj.get("uuid").text(),
                obj.get("parentUuid").text(),
                obj.get("timestamp").text().as_deref(),
            );
            return Ok(());
        }
        // A record copied from a cloud session by teleport is counted from the cloud source
        // (claude_cloud.rs), which also carries the turn's output; counting it here too would double it.
        if truthy(obj.get("remoteSourced")) {
            return Ok(());
        }
        // Only a recorded, precise `timestamp` times a block; the desktop audit fallback below and a date, minutes or
        // local time alone do not (js_date::precise).
        let at = obj.get("timestamp").text().as_deref().and_then(js_date::precise);
        if store == "desktop" && !truthy(obj.get("timestamp")) {
            obj.set("timestamp", obj.get("_audit_timestamp").clone());
        }
        let id = or(
            obj.get("message").get("id"),
            &or(obj.get("requestId"), obj.get("uuid")),
        );
        if !truthy(&id) {
            return Ok(());
        }
        let key = map_key(&id, index);
        index += 1;
        if let Some(hit) = refusal(&obj)? {
            if let Some(&p) = refusal_positions.get(&key) {
                if hit.basis == "vendor" && refusals[p].2.basis != "vendor" {
                    refusals[p] = (id.clone(), obj.clone(), hit);
                }
            } else {
                refusal_positions.insert(key.clone(), refusals.len());
                refusals.push((id.clone(), obj.clone(), hit));
            }
        }
        let stop = coalesce(obj.get("message").get("stop_reason"), &V::Null);
        let out = coalesce(
            obj.get("message").get("usage").get("output_tokens"),
            &zero(obj.get("usage").get("output_tokens")),
        );
        if let Some(&p) = positions.get(&key) {
            let old = &mut calls[p];
            old.end = old.end.zip(at).map(|(a, b)| a.max(b));
            if !matches!(stop, V::Null) || matches!(old.stop, V::Null) && greater(&out, &old.out) {
                let ts = or(obj.get("timestamp"), old.obj.get("timestamp"));
                let session = or(obj.get("sessionId"), old.obj.get("sessionId"));
                if let V::Obj(entries) = &obj {
                    for (k, v) in entries {
                        old.obj.set(&String::from_utf16_lossy(k), v.clone());
                    }
                }
                old.obj.set("timestamp", ts);
                old.obj.set("sessionId", session);
                if !matches!(stop, V::Null) {
                    old.stop = stop;
                }
                old.out = out;
            } else {
                for key in ["timestamp", "sessionId"] {
                    if !truthy(old.obj.get(key)) {
                        old.obj.set(key, obj.get(key).clone());
                    }
                }
            }
        } else {
            positions.insert(key, calls.len());
            let parent = obj.get("parentUuid").text();
            calls.push(Call {
                id,
                stop,
                out,
                obj,
                parent,
                end: at,
            });
        }
        Ok(())
    }, |bytes| raw_head(bytes, next_line(), &mut raw_heads))?;
    for (uuid, head) in raw_heads {
        match heads.get(&uuid) {
            Some(kept) if kept.line < head.line => {}
            _ => {
                heads.insert(uuid, head);
            }
        }
    }
    if let Some(companion) = companion(store, file) {
        let companion = crate::rollout_codec::select_jsonl_source(&companion)
            .map_err(|error| io_error(error, &companion))?;
        for (session, keys) in companion_owners(&companion)?.iter() {
            for key in keys {
                add_owner(&mut owners, &V::Str(session.clone()), Some(key.clone()));
            }
        }
    }
    let mut events = vec![];
    let mut limits = vec![];
    for call in calls {
        // Raw duration, never clamped: unknown (null), never 0, when it cannot be measured.
        let resp_ms = request_start(&heads, call.parent.as_deref())
            .zip(call.end)
            .map(|(start, end)| end - start)
            .filter(|ms| *ms > 0);
        let obj = call.obj;
        let Some(ts) = timestamp(&obj, since) else {
            continue;
        };
        let u = or(
            obj.get("message").get("usage"),
            &or(obj.get("usage"), &V::obj()),
        );
        let cwd = fallback(obj.get("cwd"));
        let project = project_of(&cwd)?;
        let mut row = V::obj();
        for (key, v) in [
            ("store", V::from(store)),
            ("call_id", call.id),
            ("ts", V::from(ts)),
            ("path", V::from(file)),
            ("cwd", cwd),
            ("project", project),
            ("request_id", fallback(obj.get("requestId"))),
            (
                "model",
                or(obj.get("message").get("model"), &fallback(obj.get("model"))),
            ),
            (
                "is_sidechain",
                V::Num(if truthy(obj.get("isSidechain")) {
                    1.0
                } else {
                    0.0
                }),
            ),
        ] {
            row.set(key, v);
        }
        for (key, source) in [
            ("effort", "effort"),
            ("git_branch", "gitBranch"),
            ("entrypoint", "entrypoint"),
            ("agent_id", "agentId"),
            ("attribution_agent", "attributionAgent"),
            ("cc_version", "version"),
        ] {
            row.set(key, fallback(obj.get(source)));
        }
        for key in ["service_tier", "speed"] {
            row.set(key, or(u.get(key), &fallback(obj.get(key))));
        }
        for (key, source) in [
            ("in_uncached", "input_tokens"),
            ("in_cache_read", "cache_read_input_tokens"),
            ("out_total", "output_tokens"),
        ] {
            row.set(key, zero(u.get(source)));
        }
        let cache = u.get("cache_creation");
        let five = zero(cache.get("ephemeral_5m_input_tokens"));
        let hour = zero(cache.get("ephemeral_1h_input_tokens"));
        row.set(
            "in_cache_write",
            coalesce(u.get("cache_creation_input_tokens"), &add(&five, &hour)),
        );
        row.set("cache_write_5m", five);
        row.set("cache_write_1h", hour);
        row.set(
            "out_thinking",
            zero(u.get("output_tokens_details").get("thinking_tokens")),
        );
        row.set("resp_ms", resp_ms.map_or(V::Null, |ms| V::Num(ms as f64)));
        identity(&mut row, &obj, &owners);
        events.push(row);
    }
    for (id, obj, hit) in refusals {
        let Some(ts) = timestamp(&obj, since) else {
            continue;
        };
        let mut row = V::obj();
        for (key, value) in [
            ("store", V::from(store)),
            ("call_id", id),
            ("ts", V::from(ts)),
            ("limit_type", V::from(hit.kind)),
            ("status", V::from("rejected")),
            ("resets_at", hit.reset),
            ("type_basis", V::from(hit.basis)),
            ("path", V::from(file)),
        ] {
            row.set(key, value);
        }
        identity(&mut row, &obj, &owners);
        limits.push(row);
    }
    let mut result = V::obj();
    result.set("events", V::Arr(events));
    result.set("limitHits", V::Arr(limits));
    let mut source = V::obj();
    source.set("sha256", V::from(source_sha256));
    source.set("byteLength", V::Num(source_bytes as f64));
    result.set("source", source);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn golden_calls_and_since() {
        let file = format!(
            "{}/tests/golden/claude/calls.jsonl",
            env!("CARGO_MANIFEST_DIR")
        );
        let parsed = parse("live", &file, None, false).unwrap();
        let V::Arr(events) = parsed.get("events") else {
            panic!("missing events")
        };
        let complete = events
            .iter()
            .find(|e| e.get("call_id").is("complete"))
            .unwrap();
        assert_eq!(complete.get("out_total"), &V::Num(0.0));
        assert_eq!(complete.get("in_cache_write"), &V::Num(11.0));
        let conflict = events
            .iter()
            .find(|e| e.get("call_id").is("conflict"))
            .unwrap();
        assert_eq!(conflict.get("subscription_conflict"), &V::Num(1.0));
        assert_eq!(conflict.get("account_key"), &V::Null);
        assert_eq!(
            parse("live", &file, Some("2027-01-01T00:00:00.000Z"), false)
                .unwrap()
                .get("events"),
            &V::Arr(vec![])
        );
    }
    #[test]
    fn records_copied_from_a_cloud_session_are_left_to_the_cloud_source() {
        let file = format!(
            "{}/tests/golden/claude/remote-sourced.jsonl",
            env!("CARGO_MANIFEST_DIR")
        );
        let parsed = parse("live", &file, None, true).unwrap();
        let V::Arr(events) = parsed.get("events") else {
            panic!("missing events")
        };
        let ids: Vec<String> = events.iter().map(|e| e.get("call_id").text().unwrap()).collect();
        assert_eq!(ids, ["msg_local"]);
    }
    #[test]
    fn text_resets_match_wall_clock_search() {
        for (text, at, reset) in [
            (
                "You've hit your session limit · resets 2:30am (Europe/Warsaw)",
                "2026-10-25T00:45:00Z",
                "2026-10-25T01:30:00.000Z",
            ),
            (
                "You've hit your session limit · resets 2:30am (Europe/Warsaw)",
                "2026-03-29T00:30:00Z",
                "2026-03-30T00:30:00.000Z",
            ),
            (
                "You've hit your weekly limit · resets Feb 29, 1pm (UTC)",
                "2027-02-01T12:00:00Z",
                "2028-02-29T13:00:00.000Z",
            ),
        ] {
            assert_eq!(
                text_refusal(&V::from(text), &V::from(at)).unwrap().reset,
                V::from(reset)
            );
        }
        assert!(
            text_refusal(
                &V::from("You've hit your limit · resets 1pm (Invalid/Zone)"),
                &V::from("2026-01-01T00:00:00Z")
            )
            .is_none()
        );
    }
    #[test]
    fn response_time_follows_the_parent_chain() {
        let file = format!(
            "{}/tests/golden/claude/timing.jsonl",
            env!("CARGO_MANIFEST_DIR")
        );
        let resp = |store: &str| {
            let parsed = parse(store, &file, None, false).unwrap();
            let V::Arr(events) = parsed.get("events").clone() else {
                panic!("missing events")
            };
            events
                .iter()
                .map(|e| (e.get("call_id").text().unwrap(), e.get("resp_ms").clone()))
                .collect::<HashMap<_, _>>()
        };
        let live = resp("live");
        for (call, expected) in [
            // Last block minus the user record of the first block's parent.
            ("multi", V::Num(4500.0)),
            // A sidechain interleaved with the main thread keeps its own parent.
            ("side", V::Num(2000.0)),
            // Through an attachment written after the tool result.
            ("chain", V::Num(2000.0)),
            // A user record that mentions "assistant" is read as a whole record.
            ("v-path", V::Num(1250.0)),
            ("orphan", V::Null),
            ("retry", V::Null),
            ("after-assistant", V::Null),
            ("backwards", V::Null),
            ("untimed-block", V::Null),
            // Imprecise instants (a date, a local time, minutes only) time nothing.
            ("date-only", V::Null),
            ("zone-free", V::Null),
            ("minutes", V::Null),
            // A uuid read twice (header-only first, whole record later): the first reading in the file counts.
            ("dup-first", V::Num(4000.0)),
        ] {
            assert_eq!(live.get(call), Some(&expected), "{call}");
        }
        // Without a recorded timestamp the live store drops the call; the desktop store keeps it untimed.
        assert!(!live.contains_key("audit"));
        assert_eq!(resp("desktop").get("audit"), Some(&V::Null));
    }
    #[test]
    fn js_primitives_retain_comparison_and_string_rules() {
        assert!(!greater(&V::from("10"), &V::from("9")));
        assert!(greater(&V::from("0x10"), &V::Num(9.0)));
        assert_eq!(
            add(&V::from("prefix:"), &V::Num(1e-7)),
            V::from("prefix:1e-7")
        );
        assert_eq!(
            add(&V::from("prefix:"), &V::Num(1e20)),
            V::from("prefix:100000000000000000000")
        );
        assert_ne!(
            map_key(&V::Num(f64::INFINITY), 0),
            map_key(&V::Num(f64::NEG_INFINITY), 1)
        );
        assert!(truthy(&V::obj()));
    }
}
