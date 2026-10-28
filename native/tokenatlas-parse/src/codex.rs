use crate::value::{V, parse};
use aho_corasick::AhoCorasick;
use chrono::{Datelike, NaiveDate, TimeDelta, Timelike};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fs::OpenOptions,
    io::Read,
    sync::LazyLock,
};

const FIELDS: [&str; 6] = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
];
const TAGS: [&[u8]; 7] = [
    b"\"session_meta\"",
    b"\"turn_context\"",
    b"\"thread_settings_applied\"",
    b"\"token_count\"",
    b"\"token_usage_record\"",
    b"\"task_started\"",
    b"\"task_complete\"",
];
/// Lines `TAG_SCAN` skips that the response-time rule reads (header fields only, `head_fields`).
const HEAD_TAGS: [&[u8]; 6] = [
    b"\"response_item\"",
    b"\"compacted\"",
    b"\"context_compacted\"",
    b"\"task_complete\"",
    b"\"turn_aborted\"",
    b"\"thread_rolled_back\"",
];
/// The first producer version whose rollouts keep the record order the rule relies on.
const TIMED_FROM: [u64; 3] = [0, 142, 5];
/// A first output written within this of its input is a copied history (fork, guardian), not a response.
const REPLAY_GAP_MS: i64 = 250;
/// What a record is to the response-time rule (docs/verification/model-speed-2026-10-06.md, Codex).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Mark {
    /// The prompt or a tool result: what a response answers.
    Input,
    /// An item the model produced, written when complete.
    Output,
    /// End of a turn, an abort, a rollback or a compaction: no response starts across it.
    Barrier,
}
fn mark_of(kind: Option<&str>, item: Option<&str>, role: Option<&str>) -> Option<Mark> {
    match (kind?, item) {
        ("response_item", Some("message")) => match role {
            Some("user") => Some(Mark::Input),
            Some("assistant") => Some(Mark::Output),
            _ => None,
        },
        (
            "response_item",
            Some(
                "function_call_output"
                | "custom_tool_call_output"
                | "tool_search_output"
                | "local_shell_call_output"
                | "mcp_tool_call_output"
                | "agent_message",
            ),
        ) => Some(Mark::Input),
        (
            "response_item",
            Some(
                "reasoning"
                | "function_call"
                | "custom_tool_call"
                | "tool_search_call"
                | "web_search_call"
                | "image_generation_call"
                | "local_shell_call"
                | "compaction",
            ),
        ) => Some(Mark::Output),
        (
            "event_msg",
            Some("task_complete" | "turn_aborted" | "thread_rolled_back" | "context_compacted"),
        ) => Some(Mark::Barrier),
        ("compacted", _) => Some(Mark::Barrier),
        _ => None,
    }
}
/// A record's mark from a fully parsed value (a payload that is not an object has no item type).
fn value_mark(value: &V) -> Option<Mark> {
    let payload = value.get("payload");
    let field = |k: &str| {
        if payload.dict() {
            payload.get(k).text()
        } else {
            None
        }
    };
    mark_of(
        value.get("type").text().as_deref(),
        field("type").as_deref(),
        field("role").as_deref(),
    )
}
fn instant(value: &V) -> Option<i64> {
    crate::js_date::precise(&value.text()?)
}
/// `type`, `timestamp` and the payload's `type` and `role` of a line, without building the rest (a
/// response item can hold megabytes of encrypted reasoning or tool output). The last duplicate key wins.
fn head_fields(bytes: &[u8]) -> Option<(Option<Mark>, Option<i64>, bool)> {
    use serde::de::{IgnoredAny, MapAccess, Visitor};
    use std::borrow::Cow;
    struct Payload(Option<String>, Option<String>);
    impl<'de> serde::Deserialize<'de> for Payload {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct Visit;
            impl<'de> Visitor<'de> for Visit {
                type Value = Payload;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a payload")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Payload, A::Error> {
                    let mut out = Payload(None, None);
                    while let Some(key) = map.next_key::<Cow<'de, str>>()? {
                        match key.as_ref() {
                            "type" => out.0 = text(map.next_value::<serde_json::Value>()?),
                            "role" => out.1 = text(map.next_value::<serde_json::Value>()?),
                            _ => {
                                map.next_value::<IgnoredAny>()?;
                            }
                        }
                    }
                    Ok(out)
                }
                // A payload that is not an object has no item type.
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Payload, A::Error> {
                    while seq.next_element::<IgnoredAny>()?.is_some() {}
                    Ok(Payload(None, None))
                }
                fn visit_str<E>(self, _: &str) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
                fn visit_bool<E>(self, _: bool) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
                fn visit_i64<E>(self, _: i64) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
                fn visit_u64<E>(self, _: u64) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
                fn visit_f64<E>(self, _: f64) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
                fn visit_unit<E>(self) -> Result<Payload, E> {
                    Ok(Payload(None, None))
                }
            }
            d.deserialize_any(Visit)
        }
    }
    fn text(value: serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        }
    }
    struct Head(Option<String>, Option<String>, Payload);
    impl<'de> serde::Deserialize<'de> for Head {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct Visit;
            impl<'de> Visitor<'de> for Visit {
                type Value = Head;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a record")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Head, A::Error> {
                    let mut out = Head(None, None, Payload(None, None));
                    while let Some(key) = map.next_key::<Cow<'de, str>>()? {
                        match key.as_ref() {
                            "type" => out.0 = text(map.next_value::<serde_json::Value>()?),
                            "timestamp" => out.1 = text(map.next_value::<serde_json::Value>()?),
                            "payload" => out.2 = map.next_value::<Payload>()?,
                            _ => {
                                map.next_value::<IgnoredAny>()?;
                            }
                        }
                    }
                    Ok(out)
                }
            }
            d.deserialize_map(Visit)
        }
    }
    let Head(kind, timestamp, Payload(item, role)) = serde_json::from_slice::<Head>(bytes).ok()?;
    Some((
        mark_of(kind.as_deref(), item.as_deref(), role.as_deref()),
        timestamp.as_deref().and_then(crate::js_date::precise),
        kind.as_deref() == Some("turn_context") || kind.as_deref() == Some("event_msg")
            && matches!(item.as_deref(), Some("task_started" | "task_complete" | "token_count")),
    ))
}
/// Input, output and barrier records of a file in order: (byte start, mark, timestamp).
type Marks = Vec<(usize, Mark, Option<i64>)>;
/// `input_tokens` and `output_tokens` of a usage object; None for a value that is not a number.
fn in_out(usage: &V) -> (Option<f64>, Option<f64>) {
    (
        usage.get("input_tokens").number(),
        usage.get("output_tokens").number(),
    )
}
/// Input and output tokens of a usage object when both are numbers; None otherwise.
fn pair(usage: &V) -> Option<(f64, f64)> {
    if !usage.dict() {
        return None;
    }
    match in_out(usage) {
        (Some(i), Some(o)) if i.is_finite() && o.is_finite() => Some((i, o)),
        _ => None,
    }
}
/// A token_count's `info`, when it has one: its total and last usage, each None when absent or not two numbers.
type Counted = (Option<(f64, f64)>, Option<(f64, f64)>);
fn counted(payload: &V) -> Option<Counted> {
    let info = payload.get("info");
    info.dict().then(|| (pair(info.get("total_token_usage")), pair(info.get("last_token_usage"))))
}
/// Whether a producer version (`x.y.z[-alpha.n.m]`) is at least `TIMED_FROM`, comparing its numbers in order.
fn timed_producer(producer: &V) -> bool {
    static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9]+").unwrap());
    let Some(text) = producer.text() else {
        return false;
    };
    let parts: Vec<u64> = DIGITS
        .find_iter(&text)
        .map(|m| m.as_str().parse::<u64>().unwrap_or(u64::MAX))
        .collect();
    parts.as_slice() >= TIMED_FROM.as_slice()
}
/**
 * Milliseconds from the input a response answers to the end of the response, for an emitted event (the rule
 * in docs/verification/model-speed-2026-10-06.md, Codex). `previous` is the byte start of the previous emitted
 * event; `end` the event's end marker: its token_usage_record (`rich`, with its timestamp) or the event itself.
 * `chain` is false when the event's totals do not continue the previous count's. None means unknown, never 0.
 */
fn response_ms(marks: &Marks, previous: Option<usize>, end: usize, rich: Option<Option<i64>>, chain: bool) -> Option<i64> {
    let from = previous.map_or(0, |p| marks.partition_point(|m| m.0 <= p));
    let until = marks.partition_point(|m| m.0 < end);
    let outputs: Vec<usize> = (from..until)
        .filter(|&i| marks[i].1 == Mark::Output)
        .collect();
    let (&first, &last) = (outputs.first()?, outputs.last()?);
    // One run of outputs: an input between two of them means two responses (or an aborted one) in one window.
    if outputs
        .windows(2)
        .any(|w| (w[0] + 1..w[1]).any(|i| marks[i].1 == Mark::Input))
    {
        return None;
    }
    // The input before the first output; a barrier, an earlier output or the file start first: no start.
    // Records between them that are none of the three (counts, events, context) are passed.
    let input = first.checked_sub(1).filter(|&i| marks[i].1 == Mark::Input)?;
    let start = marks[input].2?;
    let end_at = match rich {
        Some(at) => at?,
        // Never the token_count itself: it is written after the tools of the response ran.
        None => marks[last].2?,
    };
    if !chain {
        return None;
    }
    let first_at = marks[first].2?;
    if first_at - start < REPLAY_GAP_MS {
        return None;
    }
    Some(end_at - start).filter(|ms| *ms > 0)
}
fn or_empty(value: &V) -> &V {
    static EMPTY: V = V::Obj(Vec::new());
    if value.truthy() { value } else { &EMPTY }
}
fn dictionary(value: &V) -> Result<(), String> {
    if value.dict() {
        Ok(())
    } else {
        Err(format!(
            "'{}' object has no attribute 'get'",
            value.py_type()
        ))
    }
}
fn obj<const N: usize>(items: [(&str, V); N]) -> V {
    let mut v = V::obj();
    for (k, x) in items {
        v.set(k, x);
    }
    v
}
fn n(n: usize) -> V {
    V::Num(n as f64)
}
fn hash(bytes: &[u8]) -> V {
    let started = std::time::Instant::now();
    let result = V::from(format!("{:x}", Sha256::digest(bytes)));
    crate::trace::add(&crate::trace::HASH, started);
    result
}
fn vector_key(usage: &V, out: &mut String) {
    out.push('[');
    for (index, field) in FIELDS.iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        if usage.has(field) {
            usage.get(field).write_key_json(out);
        } else {
            V::Num(0.0).write_key_json(out);
        }
    }
    out.push(']');
}
fn unit_key(usage: &V) -> Option<String> {
    usage.dict().then(|| {
        let mut out = String::with_capacity(96);
        vector_key(usage, &mut out);
        out
    })
}
fn pair_key(usage: &V, total: &V) -> Option<String> {
    (usage.dict()
        && total.dict()
        && total.get("input_tokens").int()
        && total.get("output_tokens").int())
    .then(|| {
        let mut out = String::with_capacity(192);
        out.push('[');
        vector_key(usage, &mut out);
        out.push(',');
        vector_key(total, &mut out);
        out.push(']');
        out
    })
}
#[derive(Clone)]
struct Record {
    value: V,
    evidence: V,
    start: usize,
    end: usize,
    offset: f64,
    skip: bool,
    conflict: bool,
    repeated: bool,
    paired: bool,
    accounting: Option<usize>,
    duplicates: Vec<V>,
}
struct FirstTokenCollector {
    contexts: HashMap<String, V>,
    starts: HashMap<String, (i64, V)>,
    turns: std::collections::BTreeMap<String, V>,
    active: Option<String>,
    tier: V,
    effort: V,
    model: V,
}
impl Default for FirstTokenCollector {
    fn default() -> Self {
        Self { contexts: HashMap::new(), starts: HashMap::new(), turns: std::collections::BTreeMap::new(),
            active: None, tier: V::Null, effort: V::Null, model: V::Null }
    }
}
impl FirstTokenCollector {
    fn observe(&mut self, value: &V) {
        let payload = value.get("payload");
        if value.get("type").is("thread_settings_applied") || value.get("type").is("event_msg") && payload.get("type").is("thread_settings_applied") {
            let settings = payload.get("thread_settings");
            if settings.has("service_tier") { self.tier = settings.get("service_tier").clone(); }
            self.effort = settings.get("reasoning_effort").or(&self.effort);
            self.model = settings.get("model").or(&self.model);
        }
        let Some(id) = payload.get("turn_id").text().filter(|s| !s.trim().is_empty()) else {
            self.pool(value);
            return;
        };
        if value.get("type").is("turn_context") {
            self.model = payload.get("model").or(&self.model);
            self.effort = payload.get("effort").or(&self.effort);
            self.contexts.insert(id, obj([("model", self.model.clone()), ("service_tier", self.tier.clone()), ("effort", self.effort.clone())]));
            return;
        }
        if !value.get("type").is("event_msg") { return; }
        if payload.get("type").is("task_started") {
            self.active = Some(id.clone());
            if let Some(at) = Self::instant(value.get("timestamp")) {
                self.starts.insert(id.clone(), (at, V::from("unknown")));
            }
        }
        self.pool(value);
        if !payload.get("type").is("task_complete") { return; }
        let (Some((start, billing)), Some(end)) = (self.starts.get(&id), Self::instant(value.get("timestamp"))) else { return; };
        if end < *start { return; }
        let ms = payload.get("time_to_first_token_ms");
        let duration = payload.get("duration_ms");
        let valid = ms.valid_counter() && duration.valid_counter()
            && duration.number().unwrap() >= ms.number().unwrap()
            && ms.number().unwrap() <= (end - start + 1000) as f64;
        let ts = chrono::DateTime::from_timestamp_millis(*start).unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut turn = obj([
            ("id", V::from(id.as_str())), ("model", self.contexts.get(&id).map_or(V::Null, |v| v.get("model").clone())),
            ("service_tier", self.contexts.get(&id).map_or(V::Null, |v| v.get("service_tier").clone())),
            ("effort", self.contexts.get(&id).map_or(V::Null, |v| v.get("effort").clone())),
            ("ts", V::from(ts)), ("ms", if valid { ms.clone() } else { V::Null }), ("billing", billing.clone()),
            ("reason", if valid { V::Null } else if matches!(ms, V::Null) { V::from("not_recorded") } else { V::from("invalid") }),
        ]);
        if let Some(previous) = self.turns.get(&id) && previous != &turn {
            turn = previous.clone(); turn.set("ms", V::Null); turn.set("reason", V::from("conflicting_completion"));
        }
        self.turns.insert(id.clone(), turn);
        if self.active.as_ref() == Some(&id) { self.active = None; }
    }
    fn instant(value: &V) -> Option<i64> {
        static ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$").unwrap());
        let text = value.text()?;
        ISO.is_match(&text).then(|| crate::js_date::precise(&text)).flatten()
    }
    fn pool(&mut self, value: &V) {
        let payload = value.get("payload");
        if !value.get("type").is("event_msg") || !payload.get("type").is("token_count") { return; }
        if let Some(id) = &self.active && let Some((_, billing)) = self.starts.get_mut(id) {
            let plan = payload.get("rate_limits").get("plan_type");
            if billing.is("unknown") && plan.truthy() {
                *billing = V::from(if plan.is("self_serve_business_usage_based") { "business_credits" } else { "allowance" });
            }
        }
    }
    fn result(self) -> V {
        obj([("version", n(2)), ("turns", V::Arr(self.turns.into_values().collect()))])
    }
}
fn reconcile(bytes: &[u8], first_token_only: bool) -> Result<(Vec<Record>, bool, Marks, V), String> {
    let mut records: Vec<Record> = vec![];
    let mut marks: Marks = vec![];
    let mut rich = vec![];
    let mut counts: HashMap<String, VecDeque<usize>> = HashMap::new();
    let mut units: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut meter = None;
    let mut start = 0;
    let mut first_token = FirstTokenCollector::default();
    for newline in memchr::memchr_iter(b'\n', bytes) {
        let end = newline + 1;
        let raw = &bytes[start..end];
        let byte_start = start;
        start = end;
        static TAG_SCAN: LazyLock<AhoCorasick> = LazyLock::new(|| AhoCorasick::new(TAGS).unwrap());
        let scan_start = std::time::Instant::now();
        let selected = TAG_SCAN.is_match(raw);
        crate::trace::add(&crate::trace::SCAN, scan_start);
        if !selected {
            // Unicode escapes can spell tags differently; inspect just headers before allocating a payload.
            if raw.windows(2).any(|pair| pair == b"\\u")
                && !matches!(head_fields(raw), Some((_, _, false)))
                && let Ok(value) = parse(String::from_utf8_lossy(raw).trim_matches(js_space))
            { first_token.observe(&value); }
            if first_token_only { continue; }
            static HEAD_SCAN: LazyLock<AhoCorasick> =
                LazyLock::new(|| AhoCorasick::new(HEAD_TAGS).unwrap());
            if HEAD_SCAN.is_match(raw)
                && let Some((Some(mark), at, _)) = head_fields(raw)
            {
                marks.push((byte_start, mark, at));
            }
            continue;
        }
        // from_utf8_lossy follows the maximal-subpart replacement rule; retain BOM.
        let utf8_start = std::time::Instant::now();
        let line = String::from_utf8_lossy(raw);
        crate::trace::add(&crate::trace::UTF8, utf8_start);
        let parse_start = std::time::Instant::now();
        let parsed = parse(&line);
        crate::trace::add(&crate::trace::JSON, parse_start);
        let Ok(value) = parsed else {
            // TTFT's reference trims JSONL boundaries; retain the usage parser's established BOM behavior.
            if let Ok(value) = parse(line.trim_matches(js_space)) { first_token.observe(&value); }
            continue;
        };
        first_token.observe(&value);
        if first_token_only { continue; }
        if !value.dict() {
            return Err(format!(
                "'{}' object has no attribute 'get'",
                value.py_type()
            ));
        }
        if let Some(mark) = value_mark(&value) {
            marks.push((byte_start, mark, instant(value.get("timestamp"))));
        }
        let payload = value.get("payload");
        if !payload.dict() {
            continue;
        }
        let kind = value.get("type");
        let is_rich = kind.is("token_usage_record");
        let is_count = kind.is("event_msg") && payload.get("type").is("token_count");
        if !(is_rich
            || is_count
            || kind.is("session_meta")
            || kind.is("turn_context")
            || kind.is("thread_settings_applied")
            || kind.is("event_msg") && payload.get("type").is("thread_settings_applied"))
        {
            continue;
        }
        let index = records.len();

        let mut record = Record {
            value: V::Null,
            evidence: obj([
                ("byteStart", n(byte_start)),
                ("byteEnd", n(end)),
                ("sha256", hash(raw)),
            ]),
            start: byte_start,
            end,
            offset: end as f64 - line.len() as f64,
            skip: false,
            conflict: false,
            repeated: false,
            paired: false,
            accounting: None,
            duplicates: vec![],
        };
        if is_rich {
            let thread = payload.get("thread_id").or(payload.get("session_id"));
            let response = payload.get("response_id");
            if response.truthy() {
                let key = format!("{}\0{}", thread.hash_key()?, response.hash_key()?);
                if let Some(&previous) = seen.get(&key) {
                    if !records[previous]
                        .value
                        .get("payload")
                        .get("usage")
                        .equal(payload.get("usage"))
                    {
                        records[previous].conflict = true;
                    }
                    records[previous].duplicates.push(record.evidence.clone());
                    record.skip = true;
                } else {
                    seen.insert(key, index);
                }
            }
            rich.push(index);
        } else if is_count {
            let info = or_empty(payload.get("info"));
            dictionary(info)?;
            let current = unit_key(info.get("total_token_usage"));
            record.repeated = current.is_some() && current == meter;
            if current.is_some() {
                meter = current;
            }
            if let Some(key) = pair_key(info.get("last_token_usage"), info.get("total_token_usage"))
            {
                counts.entry(key).or_default().push_back(index);
            }
            units
                .entry(unit_key(info.get("last_token_usage")))
                .or_default()
                .push(index);
        }
        record.value = value;
        records.push(record);
    }
    for (position, &current) in rich.iter().enumerate() {
        let payload = records[current].value.get("payload");
        let key = pair_key(payload.get("usage"), payload.get("thread_token_usage"));
        let mut count = None;
        if let Some(matches) = key.and_then(|k| counts.get_mut(&k)) {
            while matches.front().is_some_and(|&i| records[i].paired) {
                matches.pop_front();
            }
            count = matches.pop_front();
        }
        if count.is_none() {
            let previous = if position > 0 {
                Some(rich[position - 1])
            } else {
                None
            };
            let following = rich.get(position + 1).copied().unwrap_or(records.len());
            if let Some(candidates) = units.get(&unit_key(payload.get("usage"))) {
                for &candidate in candidates {
                    if records[candidate].paired
                        || records[candidate].repeated
                        || previous.is_some_and(|p| candidate <= p)
                        || candidate >= following
                    {
                        continue;
                    }
                    if count.is_none_or(|best: usize| {
                        candidate.abs_diff(current) < best.abs_diff(current)
                    }) {
                        count = Some(candidate);
                    }
                }
            }
        }
        if let Some(count) = count {
            records[count].paired = true;
            if records[current].skip {
                records[count].skip = true;
                continue;
            }
            records[count].accounting = Some(current);
            records[count].conflict = records[current].conflict;
            records[current].skip = true;
        }
    }
    Ok((records, !rich.is_empty(), marks, first_token.result()))
}
fn canonical_ts(value: &V) -> V {
    // A 24-unit UTC millisecond timestamp is already the canonical spelling.
    // Invalid calendar values also stay unchanged in the reference parser.
    if let V::Str(s) = value
        && s.len() == 24
        && s[4] == 45
        && s[7] == 45
        && s[10] == 84
        && s[13] == 58
        && s[16] == 58
        && s[19] == 46
        && s[23] == 90
        && s.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19 | 23) || (48..=57).contains(c))
    {
        return value.clone();
    }
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|z|[+-][0-9]{2}:?[0-9]{2})$").unwrap()
    });
    let Some(text) = value.text() else {
        return value.clone();
    };
    let Some(c) = ISO
        .captures(text.trim_matches(|c: char| js_space(c) || ('\u{1c}'..='\u{1f}').contains(&c)))
    else {
        return value.clone();
    };
    let num = |i| c.get(i).unwrap().as_str().parse::<u32>().unwrap();
    let year = num(1);
    if year == 0 {
        return value.clone();
    }
    let Some(date) = NaiveDate::from_ymd_opt(year as i32, num(2), num(3)) else {
        return value.clone();
    };
    let fraction = format!("{}000", c.get(7).map_or("0", |m| m.as_str()));
    let Some(mut time) =
        date.and_hms_milli_opt(num(4), num(5), num(6), fraction[..3].parse().unwrap())
    else {
        return value.clone();
    };
    let zone = c.get(8).unwrap().as_str();
    if zone != "Z" && zone != "z" {
        let hours: i64 = zone[1..3].parse().unwrap();
        let minutes: i64 = zone[zone.len() - 2..].parse().unwrap();
        time -=
            TimeDelta::minutes((hours * 60 + minutes) * if zone.starts_with('+') { 1 } else { -1 });
    }
    V::from(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        time.month(),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.and_utc().timestamp_subsec_millis()
    ))
}
fn js_space(c: char) -> bool {
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
fn evidence_id(value: &V) -> V {
    if let V::Str(s) = value {
        if s.iter().any(|c| matches!(c, 0 | 10 | 13))
            || value.text().unwrap().trim_matches(js_space).is_empty()
        {
            return V::Null;
        }
        return value.clone();
    }
    V::Null
}
fn project(cwd: &V) -> Result<V, String> {
    if !cwd.truthy() {
        return Ok(V::from("-"));
    }
    let V::Str(text) = cwd else {
        return Err("cwd must be a string".into());
    };
    let slash: Vec<u16> = text.iter().map(|&c| if c == 92 { 47 } else { c }).collect();
    let end = slash.iter().rposition(|&c| c != 47).map_or(0, |i| i + 1);
    let trimmed = &slash[..end];
    // path.win32.basename treats drive prefixes specially, including drive-relative paths.
    let trimmed = if cfg!(windows)
        && trimmed.get(1) == Some(&58)
        && trimmed[0] < 128
        && (trimmed[0] as u8).is_ascii_alphabetic()
    {
        &trimmed[2..]
    } else {
        trimmed
    };
    let base = trimmed.rsplit(|&c| c == 47).next().unwrap_or(&[]);
    Ok(if base.is_empty() {
        cwd.clone()
    } else {
        // Bun's path.win32.basename crosses UTF-8 and replaces lone surrogates.
        V::from(String::from_utf16_lossy(base))
    })
}
fn classify(payload: &V) -> Result<V, String> {
    let raw = payload.get("originator").or(&V::from(""));
    let Some(origin) = raw.text() else {
        return Err(format!(
            "'{}' object has no attribute 'lower'",
            raw.py_type()
        ));
    };
    let lower = origin.to_lowercase();
    let mut base = match lower.as_str() {
        "codex desktop" => "ide-app",
        "codex-tui" => "cli-tui",
        "codex_exec" => "cli-exec",
        "codex_cli_rs" => "mcp-server",
        "" => "unknown",
        other => other,
    };
    if payload.get("source").is("mcp") {
        base = "mcp-server";
    }
    Ok(V::from(format!(
        "{base}{}",
        if payload.get("thread_source").is("user") {
            ""
        } else {
            "+nested"
        }
    )))
}
fn nested(thread: &V) -> V {
    if matches!(thread, V::Str(_)) {
        return thread.clone();
    }
    if thread.dict() {
        let sub = thread.get("subagent");
        let value = if sub.dict() {
            sub.keys()
                .first()
                .map(|(_, v)| v.py_str())
                .unwrap_or_else(|| "?".encode_utf16().collect())
        } else if sub.truthy() {
            sub.py_str()
        } else {
            return V::from("unknown");
        };
        let mut units: Vec<u16> = "subagent:".encode_utf16().collect();
        units.extend(value);
        return V::Str(units);
    }
    V::from("unknown")
}
fn thread_lineage(payload: &V) -> V {
    let spawn = payload.get("source").get("subagent").get("thread_spawn");
    // Modern producers keep the actual parent under source, while thread_source is just "subagent".
    if spawn.dict() && spawn.get("parent_thread_id").text().is_some() {
        let mut value: Vec<u16> = "subagent:".encode_utf16().collect();
        value.extend(spawn.py_str());
        V::Str(value)
    } else {
        nested(payload.get("thread_source"))
    }
}
fn metadata(usage: &V) -> (Vec<V>, &'static str, &'static str) {
    let write = if !usage.has("cache_write_input_tokens") {
        "missing"
    } else if usage.get("cache_write_input_tokens").valid_counter() {
        "reported"
    } else {
        "invalid"
    };
    let values: Vec<V> = FIELDS[..5]
        .iter()
        .map(|k| {
            if usage.has(k) {
                usage.get(k).clone()
            } else {
                n(0)
            }
        })
        .collect();
    let mut valid = values.iter().all(V::valid_counter);
    if valid {
        let nums: Vec<f64> = values.iter().map(|v| v.number().unwrap()).collect();
        valid = nums[1] + nums[2] <= nums[0]
            && nums[4] <= nums[3]
            && nums[0] + nums[3] <= 9007199254740991.0;
        if usage.has("total_tokens") {
            valid = valid
                && usage.get("total_tokens").valid_counter()
                && usage.get("total_tokens").number() == Some(nums[0] + nums[3]);
        }
    }
    let quality = if !valid {
        "invalid"
    } else if ["input_tokens", "cached_input_tokens", "output_tokens"]
        .iter()
        .all(|k| usage.has(k))
    {
        "valid"
    } else {
        "incomplete"
    };
    (
        values
            .into_iter()
            .map(|v| if v.valid_counter() { v } else { n(0) })
            .collect(),
        write,
        quality,
    )
}
fn percentage(value: &V) -> Result<V, String> {
    if let Some(n) = value.number() {
        return Ok(V::Num(n));
    }
    if let Some(text) = value.text() {
        let text = text.trim_matches(js_space);
        let result = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
        {
            u64::from_str_radix(hex, 16).ok().map(|n| n as f64)
        } else if let Some(bin) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
            u64::from_str_radix(bin, 2).ok().map(|n| n as f64)
        } else if let Some(oct) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
            u64::from_str_radix(oct, 8).ok().map(|n| n as f64)
        } else {
            text.parse::<f64>().ok()
        };
        if let Some(n) = result.filter(|n| n.is_finite()) {
            return Ok(V::Num(n));
        }
    }
    Err(format!(
        "float() argument must be a string or a real number, not '{}'",
        value.py_type()
    ))
}
struct State<'a> {
    surface: V,
    nested: V,
    model: V,
    effort: V,
    project: V,
    cwd: V,
    tier: V,
    speed: V,
    speed_source: V,
    speed_offset: V,
    identity: V,
    total: &'a V,
    consumed: usize,
}
impl State<'_> {
    fn snapshot(&self) -> V {
        obj([
            ("surface", self.surface.clone()),
            ("nested", self.nested.clone()),
            ("model", self.model.clone()),
            ("effort", self.effort.clone()),
            ("project", self.project.clone()),
            ("cwd", self.cwd.clone()),
            ("service_tier", self.tier.clone()),
            ("speed", self.speed.clone()),
            ("speed_source", self.speed_source.clone()),
            ("speed_source_offset", self.speed_offset.clone()),
            ("account_id", self.identity.clone()),
            ("last_total", (*self.total).clone()),
            ("offset", n(self.consumed)),
        ])
    }
}
pub fn prepare(file: &str, size: u64, validate: bool) -> Result<V, String> {
    prepare_mode(file, size, validate, false)
}
pub fn prepare_first_token(file: &str) -> Result<V, String> {
    let selected = crate::rollout_codec::select_jsonl_source(file).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&selected).map_err(|e| e.to_string())?.len();
    prepare_mode(&selected, size, false, true)
}
fn prepare_mode(file: &str, size: u64, validate: bool, first_token_only: bool) -> Result<V, String> {
    thread_local! {
        static READ_BUFFER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }
    READ_BUFFER.with(|buffer| {
        let mut buffer = buffer.borrow_mut();
        let result = prepare_buffered(file, size, validate, first_token_only, &mut buffer);
        // Keep common files allocation-free without retaining an oversized file per lane.
        if buffer.capacity() > 64 << 20 {
            *buffer = Vec::new();
        }
        result
    })
}
fn prepare_buffered(file: &str, size: u64, validate: bool, first_token_only: bool, buffer: &mut Vec<u8>) -> Result<V, String> {
    let mut read = || -> std::io::Result<(usize, V)> {
        let open_start = std::time::Instant::now();
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x08000000); // FILE_FLAG_SEQUENTIAL_SCAN
        }
        let mut reader: Box<dyn Read> = if crate::rollout_codec::compressed(file) {
            crate::rollout_codec::reader(file, size)?
        } else {
            Box::new(options.open(file)?.take(size))
        };
        crate::trace::add(&crate::trace::OPEN, open_start);
        let setup_start = std::time::Instant::now();
        let mut used = 0usize;
        let mut remaining = if crate::rollout_codec::compressed(file) {
            u64::MAX
        } else {
            size
        };
        let mut sha = Sha256::new();
        crate::trace::add(&crate::trace::SETUP, setup_start);
        while remaining > 0 {
            let wanted = remaining.min(1 << 20) as usize;
            let end = used
                .checked_add(wanted)
                .ok_or_else(|| std::io::Error::other("source size exceeds address range"))?;
            if buffer.len() < end {
                buffer.resize(end, 0);
            }
            let read_start = std::time::Instant::now();
            let count = match reader.read(&mut buffer[used..end]) {
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if count == 0 {
                break;
            }
            crate::trace::add(&crate::trace::READ, read_start);
            let hash_start = std::time::Instant::now();
            sha.update(&buffer[used..used + count]);
            crate::trace::add(&crate::trace::HASH, hash_start);
            remaining -= count as u64;
            used += count;
        }
        let hash_start = std::time::Instant::now();
        let digest = V::from(format!("{:x}", sha.finalize()));
        crate::trace::add(&crate::trace::HASH, hash_start);
        Ok((used, digest))
    };
    let (used, source_sha) = match read() {
        Ok(result) => result,
        Err(e) => {
            let (code, errno) = match e.kind() {
                std::io::ErrorKind::NotFound => ("ENOENT", if cfg!(windows) { -4058 } else { -2 }),
                std::io::ErrorKind::PermissionDenied => {
                    ("EACCES", if cfg!(windows) { -4092 } else { -13 })
                }
                _ => ("EIO", if cfg!(windows) { -4070 } else { -5 }),
            };
            // Bun uses node-style errno/messages in the typed preparation result.
            let reason = match code {
                "ENOENT" => "no such file or directory",
                "EACCES" => "permission denied",
                _ => "i/o error",
            };
            return Ok(obj([
                ("kind", V::from("read_error")),
                ("errno", V::Num(errno as f64)),
                (
                    "message",
                    V::from(if crate::rollout_codec::compressed(file) && code == "EIO" {
                        format!("Cannot decode Zstandard rollout '{file}': {e}")
                    } else {
                        format!("{code}: {reason}, open '{file}'")
                    }),
                ),
                ("code", V::from(code)),
            ]));
        }
    };
    let bytes = &buffer[..used];
    // A queued file is validated in this read instead of a separate pass over the whole file.
    if !first_token_only && (validate || crate::rollout_codec::compressed(file))
        && let Some(message) = crate::jsonl::invalid(file, bytes)
    {
        return Ok(obj([
            ("kind", V::from("read_error")),
            ("errno", V::Num(if cfg!(windows) { -4071.0 } else { -22.0 })),
            ("message", V::from(message)),
            ("code", V::from("EINVAL")),
        ]));
    }
    let complete = &bytes[..bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1)];
    let first_token_valid = if !first_token_only && (validate || crate::rollout_codec::compressed(file)) {
        None
    } else { crate::jsonl::invalid(file, complete) };
    if first_token_only && let Some(message) = &first_token_valid { return Err(message.clone()); }
    let reconcile_start = std::time::Instant::now();
    let (records, has_rich, marks, first_token) = reconcile(bytes, first_token_only)?;
    let first_token = if first_token_valid.is_none() { first_token } else { V::Null };
    if first_token_only {
        return Ok(obj([("kind", V::from("ok")), ("parse", obj([("firstToken", first_token)]))]));
    }
    crate::trace::add(&crate::trace::RECONCILE, reconcile_start);
    let build_start = std::time::Instant::now();
    let mut state = State {
        surface: V::from("unknown"),
        nested: V::from("user"),
        model: V::from("?"),
        effort: V::from("?"),
        project: V::from("-"),
        cwd: V::Null,
        tier: V::Null,
        speed: V::from("unknown"),
        speed_source: V::Null,
        speed_offset: V::Null,
        identity: V::Null,
        total: &V::Null,
        consumed: 0,
    };
    let mut declared: HashMap<String, V> = HashMap::new();
    for record in &records {
        let payload = record.value.get("payload");
        let kind = record.value.get("type");
        let model = if kind.is("turn_context") {
            payload.get("model")
        } else if kind.is("thread_settings_applied")
            || kind.is("event_msg") && payload.get("type").is("thread_settings_applied")
        {
            if payload.get("thread_settings").dict() {
                payload.get("thread_settings").get("model")
            } else {
                &V::Null
            }
        } else {
            &V::Null
        };
        if model.truthy() {
            declared
                .entry(model.hash_key()?)
                .or_insert_with(|| model.clone());
        }
    }
    if declared.len() == 1 {
        state.model = declared.into_values().next().unwrap();
    }
    // Only the final committed bookmark needs a state snapshot, including lossy-offset tails.
    let final_token = records.iter().rposition(|r| {
        let kind = r.value.get("type");
        kind.is("token_usage_record") && !r.skip
            || kind.is("event_msg") && r.value.get("payload").get("type").is("token_count")
    });
    let token_end = final_token.map_or(0, |i| records[i].end);
    let commits_tail = records.last().is_some_and(|r| r.offset >= token_end as f64);
    let mut checkpoint = obj([("offset", n(0))]);
    let (mut events, mut limits, mut event_evidence, mut headers) = (vec![], vec![], vec![], vec![]);
    let mut last_pct: HashMap<String, V> = HashMap::new();
    let mut producer = V::Null;
    let mut previous_end = 0;
    // Response time: the byte start of the previous emitted event and the last count totals before this record.
    let mut previous_event: Option<usize> = None;
    let mut last_total: Option<(f64, f64)> = None;
    for (index, current) in records.iter().enumerate() {
        let parsed = &current.value;
        let payload = parsed.get("payload");
        previous_end = current.end;
        let offset = V::Num(current.offset);
        let mut kind = parsed.get("type").clone();
        if kind.is("session_meta") {
            let mut h = current.evidence.clone();
            h.set("sourceOffset", offset.clone());
            h.set("providerSessionId", evidence_id(payload.get("id")));
            // A forked thread may open with a replay of its parent's calls; the ledger resolves them.
            h.set("providerForkedFromId", evidence_id(payload.get("forked_from_id")));
            headers.push(h);
        }
        if kind.is("event_msg") && payload.get("type").is("thread_settings_applied") {
            kind = V::from("thread_settings_applied");
        }
        let is_rich = kind.is("token_usage_record");
        let token = is_rich || kind.is("event_msg") && payload.get("type").is("token_count");
        let timestamp = canonical_ts(parsed.get("timestamp"));
        if current.skip && is_rich {
            continue;
        }
        let identity = payload
            .get("account_id")
            .or(payload.get("chatgpt_account_id"));
        if matches!(identity, V::Str(_)) {
            state.identity = identity;
        }
        if kind.is("session_meta") {
            producer = payload.get("cli_version").or(payload.get("version"));
            state.surface = classify(payload)?;
            state.nested = thread_lineage(payload);
            state.project = project(payload.get("cwd"))?;
            state.cwd = payload.get("cwd").or(&state.cwd);
        } else if kind.is("turn_context") {
            state.model = payload.get("model").or(&state.model);
            state.effort = payload.get("effort").or(&state.effort);
            if payload.get("cwd").truthy() {
                state.project = project(payload.get("cwd"))?;
                state.cwd = payload.get("cwd").clone();
            }
        } else if kind.is("thread_settings_applied") {
            if payload.has("thread_settings") {
                let settings = payload.get("thread_settings");
                if !settings.dict() {
                    return Err(format!(
                        "'{}' object has no attribute 'get'",
                        settings.py_type()
                    ));
                }
                state.model = settings.get("model").or(&state.model);
                state.effort = settings.get("reasoning_effort").or(&state.effort);
                if settings.has("service_tier") {
                    let tier = settings.get("service_tier");
                    state.tier = if matches!(tier, V::Str(_) | V::Null) {
                        tier.clone()
                    } else {
                        V::from(tier.dumps())
                    };
                    state.speed = V::from(if state.tier.is("priority") {
                        "fast"
                    } else if state.tier.is("default") {
                        "standard"
                    } else {
                        "unknown"
                    });
                    state.speed_source = V::from("thread_settings_applied");
                    state.speed_offset = offset.clone();
                }
                if settings.get("cwd").truthy() {
                    state.project = project(settings.get("cwd"))?;
                    state.cwd = settings.get("cwd").clone();
                }
            }
        } else if token {
            let accounting = current.accounting.unwrap_or(index);
            let observation = if is_rich || current.accounting.is_some() {
                Some(records[accounting].value.get("payload"))
            } else {
                None
            };
            let info = or_empty(payload.get("info"));
            if !is_rich {
                dictionary(info)?;
            }
            let lu = if let Some(observation) = observation {
                if observation.has("usage") {
                    observation.get("usage")
                } else {
                    or_empty(&V::Null)
                }
            } else {
                or_empty(info.get("last_token_usage"))
            };
            let total = if is_rich {
                &V::Null
            } else {
                info.get("total_token_usage")
            };
            let cumulative = total.dict()
                && ["input_tokens", "output_tokens"].iter().all(|k| {
                    total
                        .get(k)
                        .number()
                        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= 0.0)
                });
            let repeated =
                current.skip || observation.is_none() && cumulative && total.equal(state.total);
            if cumulative {
                state.total = total;
            }
            let ts = timestamp.or(&V::from(""));
            let rl = or_empty(payload.get("rate_limits"));
            dictionary(rl)?;
            let plan = rl.get("plan_type");
            let slots: Vec<&V> = ["primary", "secondary"]
                .iter()
                .map(|k| rl.get(k))
                .filter(|v| v.dict())
                .collect();
            let empty = V::obj();
            let weekly = slots
                .iter()
                .copied()
                .find(|v| v.get("window_minutes").equal(&n(10080)))
                .unwrap_or(&empty);
            let credits = or_empty(rl.get("credits"));
            if !plan.is("self_serve_business_usage_based") {
                dictionary(credits)?;
            }
            let billing = if plan.is("self_serve_business_usage_based") {
                "business_credits"
            } else if credits.get("has_credits") == &V::Bool(true)
                && (slots.is_empty()
                    || slots
                        .iter()
                        .any(|v| v.get("used_percent").number().is_some_and(|n| n >= 100.0)))
            {
                "credits"
            } else if !slots.is_empty() {
                "allowance"
            } else {
                "unknown"
            };
            if !repeated && lu.truthy() {
                dictionary(lu)?;
            }
            if !repeated
                && lu.truthy()
                && ["input_tokens", "output_tokens"]
                    .iter()
                    .any(|k| lu.get(k).truthy())
            {
                let (values, write, quality) = metadata(lu);
                // A record whose offset is not its byte start (a lossy line) has no response window, but it
                // closes one like every emitted event: later events never take its outputs.
                let window_from = previous_event.replace(current.start);
                let resp_ms = if current.offset != current.start as f64 {
                    None
                } else {
                    let rich = if is_rich {
                        Some((current.start, instant(parsed.get("timestamp"))))
                    } else {
                        current.accounting.map(|a| {
                            (records[a].start, instant(records[a].value.get("timestamp")))
                        })
                    };
                    // The total must continue the last valid total of an earlier count (none yet: from zero) by
                    // exactly the last usage; a total or last usage that is missing or not numbers cannot show it.
                    let chain = is_rich
                        || counted(payload).is_none_or(|(total, last)| {
                            let (bi, bo) = last_total.unwrap_or((0.0, 0.0));
                            matches!((total, last), (Some((ti, to)), Some((li, lo))) if ti - bi == li && to - bo == lo)
                        });
                    let ms = response_ms(
                        &marks,
                        window_from,
                        rich.map_or(current.start, |r| r.0),
                        rich.map(|r| r.1),
                        chain,
                    );
                    ms.filter(|_| timed_producer(&producer))
                };
                let mut row = vec![
                    ts.clone(),
                    state.surface.clone(),
                    state.nested.clone(),
                    state.model.clone(),
                    state.effort.clone(),
                    state.project.clone(),
                ];
                row.extend(values);
                row.extend([
                    state.cwd.clone(),
                    state.tier.clone(),
                    state.speed.clone(),
                    state.speed_source.clone(),
                    state.speed_offset.clone(),
                    offset.clone(),
                    plan.clone(),
                    V::from(billing),
                    weekly.get("resets_at").clone(),
                    rl.get("account_id")
                        .or(rl.get("chatgpt_account_id"))
                        .or(&state.identity),
                    observation.map_or(V::Null, |v| v.get("response_id").clone()),
                    observation.map_or(V::Null, |v| v.get("turn_id").clone()),
                    V::from(if observation.is_some() && !is_rich {
                        "token_usage_record+token_count"
                    } else if is_rich {
                        "token_usage_record"
                    } else {
                        "token_count"
                    }),
                    producer.clone(),
                    V::from(write),
                    V::from(if current.conflict { "invalid" } else { quality }),
                    resp_ms.map_or(V::Null, |ms| V::Num(ms as f64)),
                ]);
                events.push(V::Arr(row));
                let source = &records[accounting];
                let provider = source.value.get("payload");
                event_evidence.push(obj([
                    ("sourceOffset", offset.clone()),
                    ("accountingRecord", source.evidence.clone()),
                    ("acceptedEventRecord", current.evidence.clone()),
                    ("providerThreadId", evidence_id(provider.get("thread_id"))),
                    ("providerSessionId", evidence_id(provider.get("session_id"))),
                    (
                        "providerResponseId",
                        evidence_id(provider.get("response_id")),
                    ),
                    ("providerTurnId", evidence_id(provider.get("turn_id"))),
                    ("conflictingUsage", V::Bool(current.conflict)),
                    ("duplicateRecords", V::Arr(source.duplicates.clone())),
                ]));
            }
            let limit = if state.model.is("gpt-reserve") && rl.get("limit_id").is("codex") {
                V::from("base_model_inference")
            } else {
                rl.get("limit_id").or(&V::from("?"))
            };
            for slot in ["primary", "secondary"] {
                let reading = rl.get(slot);
                if !reading.dict() {
                    continue;
                }
                let window = reading.get("window_minutes");
                let pct = reading.get("used_percent");
                if *window == V::Null || *pct == V::Null {
                    continue;
                }
                let key = [
                    &limit,
                    window,
                    reading.get("resets_at"),
                    rl.get("plan_type"),
                ]
                .iter()
                .map(|v| v.hash_key())
                .collect::<Result<Vec<_>, _>>()?
                .join("\0");
                if last_pct.get(&key).is_some_and(|v| v.equal(pct)) {
                    continue;
                }
                last_pct.insert(key, pct.clone());
                limits.push(V::Arr(vec![
                    ts.clone(),
                    window.clone(),
                    percentage(pct)?,
                    reading.get("resets_at").clone(),
                    plan.clone(),
                    limit.clone(),
                    rl.get("limit_name").clone(),
                    offset.clone(),
                    V::from(slot),
                ]));
            }
            // Every valid total is the next baseline, emitted or not, with or without last usage.
            if !is_rich && let Some((Some(total), _)) = counted(payload) {
                last_total = Some(total);
            }
            state.consumed = current.end;
            if !commits_tail && final_token == Some(index) {
                checkpoint = state.snapshot();
            }
        }
    }
    if commits_tail {
        state.consumed = previous_end;
        checkpoint = state.snapshot();
    }
    checkpoint.set("producer_version", producer);
    checkpoint.set("has_usage_records", V::Bool(has_rich));
    let evidence = obj([
        (
            "source",
            obj([
                ("sha256", source_sha),
                ("byteLength", n(bytes.len())),
                ("scope", V::from("file-prefix")),
            ]),
        ),
        ("events", V::Arr(event_evidence)),
        ("sessionHeaders", V::Arr(headers)),
    ]);
    crate::trace::add(&crate::trace::BUILD, build_start);
    let value = obj([
        ("kind", V::from("ok")),
        (
            "parse",
            obj([
                ("events", V::Arr(events)),
                ("rateLimits", V::Arr(limits)),
                ("consumed", n(state.consumed)),
                ("state", checkpoint),
                ("evidence", evidence),
                ("firstToken", first_token),
            ]),
        ),
    ]);
    let cleanup_start = std::time::Instant::now();
    drop(records);
    crate::trace::add(&crate::trace::SOURCE_CLEANUP, cleanup_start);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spawned_thread_preserves_parent_lineage() {
        let payload = parse(r#"{"thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"11111111-1111-4111-8111-111111111111","depth":1}}}}"#).unwrap();
        let value = thread_lineage(&payload).text().unwrap();
        assert!(value.starts_with("subagent:"));
        assert!(value.contains("\"parent_thread_id\": \"11111111-1111-4111-8111-111111111111\""));
        assert_eq!(thread_lineage(&parse(r#"{"thread_source":"user"}"#).unwrap()), V::from("user"));
        assert_eq!(thread_lineage(&parse(r#"{"thread_source":"guardian_review","source":{"subagent":{"other":"guardian"}}}"#).unwrap()), V::from("guardian_review"));
    }
    #[test]
    fn timestamps_and_decode() {
        assert_eq!(
            canonical_ts(&V::from("2026-10-02 10:00:00.12345+0200")),
            V::from("2026-10-02T08:00:00.123Z")
        );
        assert_eq!(
            String::from_utf8_lossy(&[0xe1, 0x80, b'X', 0xed, 0xa0, 0x80]),
            "�X���"
        );
    }
    #[test]
    fn response_time_rule() {
        let times = |name: &str| {
            let path = format!("{}/tests/golden/{name}.jsonl", env!("CARGO_MANIFEST_DIR"));
            let result = prepare(&path, u64::MAX, false).unwrap();
            let V::Arr(events) = result.get("parse").get("events").clone() else {
                panic!("missing events")
            };
            events
                .iter()
                .map(|row| {
                    let V::Arr(row) = row else { panic!("row") };
                    (row[9].number().unwrap(), row[27].number())
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            times("codex-timing"),
            vec![
                // Input to the last output; the token_count waits for the tool.
                (50.0, Some(3100.0)),
                // The tool result to its token_usage_record.
                (80.0, Some(2500.0)),
                // No output since the previous event.
                (1.0, None),
                // Two runs of outputs.
                (2.0, None),
                // Totals that do not continue the previous count's.
                (5.0, None),
                // A replayed history (first output 100 ms after its input).
                (1.0, None),
                // A compaction before the response.
                (1.0, None),
                // A new turn after task_complete; a fully parsed assistant line.
                (2.0, Some(2000.0)),
                // turn_aborted between the input and the output.
                (3.0, None),
                // An unpaired token_usage_record is its own end.
                (9.0, Some(1500.0)),
                // Imprecise instants (date only, no zone, minutes only) time nothing.
                (4.0, None),
                (6.0, None),
                (6.0, None),
            ]
        );
        assert_eq!(
            times("codex-timing-edges"),
            vec![
                (5.0, Some(2000.0)),
                // An invalid total: emitted without outputs, and no baseline.
                (5.0, None),
                // (30,15) against the last valid total (10,5) is not (10,5): the chain is broken.
                (5.0, None),
                // The total without last usage (40,20) is the baseline: (50,25) continues it.
                (5.0, Some(2000.0)),
                // A last usage without output tokens cannot be compared.
                (0.0, None),
                // A lossy record has no window but closes it: the next event has no outputs.
                (1.0, None),
                (1.0, None),
            ]
        );
        // A fork's copy of its parent's history (one instant): untimed; its own first response is timed.
        assert_eq!(
            times("codex-timing-fork"),
            vec![(5.0, None), (5.0, None), (5.0, Some(3000.0))]
        );
        // Producers before 0.142.5 keep another record order: unknown.
        assert!(times("codex-timing-old").iter().all(|(_, ms)| ms.is_none()));
        assert!(timed_producer(&V::from("0.142.5")) && timed_producer(&V::from("0.160.1")));
        assert!(timed_producer(&V::from("0.144.0-alpha.4")) && !timed_producer(&V::from("0.142.4")));
        assert!(!timed_producer(&V::Null) && !timed_producer(&V::from("dev")));
    }
    #[test]
    fn golden_files_parse() {
        for name in ["numbers", "strings", "usage"] {
            let path = format!("{}/tests/golden/{name}.jsonl", env!("CARGO_MANIFEST_DIR"));
            let result = prepare(&path, u64::MAX, false).unwrap();
            assert!(result.get("kind").is("ok"));
        }
    }
}
