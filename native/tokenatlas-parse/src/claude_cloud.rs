//! Claude Code cloud sessions archived from the session API (`<id>.events.jsonl` beside `<id>.session.jsonl`
//! in a `-cloud` archive folder; docs/cloud-sessions-import-2026-10-23.md, decisions 3 and 4).
//!
//! A call's input and cache counts are exact, but the stream records its output at the start of the
//! response. The exact output is known per turn and model: each `result` carries the session's running
//! `modelUsage`. So a call row carries no output, and one turn row per model carries the turn's output and
//! what the turn's calls do not explain (requests outside the stream). Sums over a session equal the
//! provider's own totals; no row is negative.
use crate::{
    claude::{project_of, records, Error},
    js_date,
    value::{self, V},
};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::LazyLock,
};

const SUFFIX: &str = ".events.jsonl";
static OWNER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^claude:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap()
});
const DECLARATION_SUFFIX: &str = ".session.jsonl";
/// `modelUsage` counter, then the matching per-call `usage` field (none for output and thinking).
const COUNTERS: [(&str, Option<&str>); 5] = [
    ("inputTokens", Some("input_tokens")),
    ("cacheReadInputTokens", Some("cache_read_input_tokens")),
    ("cacheCreationInputTokens", Some("cache_creation_input_tokens")),
    ("outputTokens", None),
    ("thinkingTokens", None),
];
type Counts = [f64; 5];

pub fn is_events_file(file: &str) -> bool {
    file.to_ascii_lowercase().ends_with(SUFFIX)
}

struct Place {
    remote: String,
    local: String,
}
/// What the sync declared for this session: the last record of its declaration file.
fn declaration(file: &str) -> V {
    let path = format!("{}{DECLARATION_SUFFIX}", &file[..file.len() - SUFFIX.len()]);
    fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.lines().rev().find(|line| !line.trim().is_empty()).map(str::to_owned))
        .and_then(|last| value::parse(&last).ok())
        .unwrap_or(V::Null)
}
fn places(declaration: &V) -> Vec<Place> {
    let V::Arr(items) = declaration.get("places") else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|place| {
            Some(Place {
                remote: place.get("remote").text()?,
                local: place.get("local").text()?,
            })
        })
        .collect()
}
/// The container checkout rewritten to its local clone, so the project rules see the same place.
fn local_cwd(cwd: &str, places: &[Place]) -> String {
    for place in places {
        if let Some(rest) = cwd.strip_prefix(place.remote.as_str()) {
            if rest.is_empty() || rest.starts_with('/') {
                return format!("{}{rest}", place.local);
            }
        }
    }
    cwd.to_string()
}
fn number(v: &V) -> f64 {
    v.number().filter(|n| n.is_finite()).unwrap_or(0.0)
}
fn iso(text: Option<String>) -> Option<String> {
    Some(js_date::iso(js_date::parse(&text?)?))
}
/// Where the session stood when a record arrived.
#[derive(Clone, Default)]
struct Where {
    cwd: Option<String>,
    branch: Option<String>,
    version: Option<String>,
}
struct Turn {
    id: String,
    ts: Option<String>,
    session: V,
    at: Where,
    /// Per model: the turn's change of the running totals minus what its calls account for.
    rest: Vec<(String, Counts)>,
    /// Where the turn's `result` lies among the session's records (for its funding).
    position: usize,
}
/**
 * Whether the provider billed a record at `position` from a promotional cloud credit (`ccr_promotional`). A turn's
 * `rate_limit_event` arrives with the answer to its first request and speaks for the whole turn (`results` are the
 * turn ends); a turn without one takes the latest earlier event, and a session's start the first event.
 */
fn promotional(marks: &[(usize, bool)], results: &[usize], position: usize, inclusive: bool) -> bool {
    let from = results.partition_point(|at| *at < position).checked_sub(1).map_or(0, |i| results[i]);
    let to = if inclusive { position } else { results.iter().copied().find(|at| *at > position).unwrap_or(usize::MAX) };
    let first = marks.partition_point(|(at, _)| *at <= from);
    let own = marks.get(first).filter(|(at, _)| *at < to);
    let before = marks.partition_point(|(at, _)| *at < position);
    own.or_else(|| marks.get(before.wrapping_sub(1))).or_else(|| marks.get(before)).is_some_and(|(_, promo)| *promo)
}
/// Moves negative amounts (a call streamed after its turn's `result`) to neighbouring turns, earlier
/// first, keeping the total; whatever cannot be absorbed is dropped rather than shown as negative.
fn settle(values: &mut [f64]) {
    let mut debt = 0.0;
    for v in values.iter_mut().rev() {
        let x = *v + debt;
        (*v, debt) = if x < 0.0 { (0.0, x) } else { (x, 0.0) };
    }
    for v in values.iter_mut() {
        if debt == 0.0 {
            break;
        }
        let x = *v + debt;
        (*v, debt) = if x < 0.0 { (0.0, x) } else { (x, 0.0) };
    }
}
#[allow(clippy::too_many_arguments)]
fn row(
    store: &str,
    file: &str,
    id: V,
    ts: String,
    at: &Where,
    model: V,
    sidechain: bool,
    counts: [f64; 7],
    session: V,
    request: V,
    usage: &V,
) -> Result<V, Error> {
    let cwd = at.cwd.clone().map_or(V::Null, V::from);
    let mut row = V::obj();
    let text = |v: &Option<String>| v.clone().map_or(V::Null, V::from);
    let [input, read, write, five, hour, out, thinking] = counts;
    for (key, value) in [
        ("store", V::from(store)),
        ("call_id", id),
        ("ts", V::from(ts)),
        ("path", V::from(file)),
        ("project", project_of(&cwd)?),
        ("cwd", cwd),
        ("request_id", request),
        ("model", model),
        ("is_sidechain", V::Num(if sidechain { 1.0 } else { 0.0 })),
        ("effort", V::Null),
        ("git_branch", text(&at.branch)),
        ("entrypoint", V::from("cloud")),
        ("agent_id", V::Null),
        ("attribution_agent", V::Null),
        ("cc_version", text(&at.version)),
        ("service_tier", usage.get("service_tier").clone()),
        ("speed", usage.get("speed").clone()),
        ("in_uncached", V::Num(input)),
        ("in_cache_read", V::Num(read)),
        ("out_total", V::Num(out)),
        ("in_cache_write", V::Num(write)),
        ("cache_write_5m", V::Num(five)),
        ("cache_write_1h", V::Num(hour)),
        ("out_thinking", V::Num(thinking)),
        ("resp_ms", V::Null),
        ("session_id", session),
        ("account_key", V::Null),
        ("subscription_conflict", V::Num(0.0)),
        ("subscription_id", V::Null),
    ] {
        row.set(key, value);
    }
    Ok(row)
}

pub fn parse(store: &str, file: &str, since: Option<&str>, validate: bool) -> Result<V, Error> {
    let declaration = declaration(file);
    let places = places(&declaration);
    // The session's identity: the account whose token listed it, keyed as a transcript's session owner is.
    let owner = declaration
        .get("owner")
        .get("account_key")
        .text()
        .filter(|key| OWNER.is_match(key));
    let own = |mut row: V| {
        if let Some(key) = &owner {
            row.set("account_key", V::from(key.as_str()));
            row.set(
                "subscription_id",
                V::from(format!("claude-{}", &format!("{:x}", Sha256::digest(key.as_bytes()))[..16])),
            );
        }
        row
    };
    let mut at = Where::default();
    let mut calls = vec![];
    let mut seen = HashSet::<String>::new();
    // Calls since the previous `result`, per model, and the running totals that `result` reported.
    let mut window = HashMap::<String, Counts>::new();
    let mut totals = HashMap::<String, Counts>::new();
    let mut turns = Vec::<Turn>::new();
    // Each call's place among the records, and the rate limit buckets the session reported (`ccr_promotional`).
    let mut call_at = Vec::<usize>::new();
    let mut marks = Vec::<(usize, bool)>::new();
    let mut position = 0usize;
    let mut results = Vec::<usize>::new();
    let keep = |bytes: &[u8]| {
        ["\"assistant\"", "\"result\"", "\"system\"", "\"rate_limit_event\""]
            .iter()
            .any(|needle| memchr::memmem::find(bytes, needle.as_bytes()).is_some())
    };
    let (sha256, bytes) = records(file, validate, keep, |envelope| {
        let payload = envelope.get("payload");
        position += 1;
        match payload.get("type").text().as_deref() {
            Some("rate_limit_event") => {
                let kind = payload.get("rate_limit_info").get("rateLimitType");
                marks.push((position, kind.is("ccr_promotional")));
            }
            Some("system") => {
                if let Some(cwd) = payload.get("cwd").text().filter(|c| !c.is_empty()) {
                    at.cwd = Some(local_cwd(&cwd, &places));
                }
                if let Some(branch) = payload.get("branch").text().filter(|b| !b.is_empty()) {
                    at.branch = Some(branch);
                }
                if let Some(version) = payload.get("claude_code_version").text() {
                    at.version = Some(version);
                }
            }
            Some("assistant") => {
                let message = payload.get("message");
                let usage = message.get("usage");
                let (Some(id), true) = (message.get("id").text(), usage.dict()) else {
                    return Ok(());
                };
                // A response streams as several records of one message; its usage is the same in each.
                if !seen.insert(id.clone()) {
                    return Ok(());
                }
                let model = message.get("model").text().unwrap_or_default();
                let window = window.entry(model.clone()).or_default();
                for (slot, (_, field)) in COUNTERS.iter().enumerate() {
                    if let Some(field) = field {
                        window[slot] += number(usage.get(field));
                    }
                }
                let Some(ts) = iso(payload.get("timestamp").text()).or_else(|| iso(envelope.get("created_at").text()))
                else {
                    return Ok(());
                };
                let cache = usage.get("cache_creation");
                call_at.push(position);
                calls.push(own(row(
                    store,
                    file,
                    V::from(id),
                    ts,
                    &at,
                    V::from(model),
                    payload.get("parent_tool_use_id").truthy(),
                    [
                        number(usage.get("input_tokens")),
                        number(usage.get("cache_read_input_tokens")),
                        number(usage.get("cache_creation_input_tokens")),
                        number(cache.get("ephemeral_5m_input_tokens")),
                        number(cache.get("ephemeral_1h_input_tokens")),
                        0.0,
                        0.0,
                    ],
                    payload.get("session_id").clone(),
                    payload.get("request_id").clone(),
                    usage,
                )?));
            }
            Some("result") => {
                let V::Obj(models) = payload.get("modelUsage") else {
                    return Ok(());
                };
                let mut current = HashMap::<String, Counts>::new();
                for (model, counters) in models {
                    let mut counts = Counts::default();
                    for (slot, (name, _)) in COUNTERS.iter().enumerate() {
                        counts[slot] = number(counters.get(name));
                    }
                    current.insert(String::from_utf16_lossy(model), counts);
                }
                // A process that started over reports from zero again.
                let restarted = totals.iter().any(|(model, before)| {
                    current
                        .get(model)
                        .is_none_or(|now| now.iter().zip(before).any(|(n, b)| n < b))
                });
                let mut rest = vec![];
                for (model, now) in &current {
                    let before = if restarted { None } else { totals.get(model) };
                    let streamed = window.get(model);
                    let mut counts = Counts::default();
                    for slot in 0..COUNTERS.len() {
                        counts[slot] = now[slot] - before.map_or(0.0, |b| b[slot])
                            - streamed.map_or(0.0, |s| s[slot]);
                    }
                    rest.push((model.clone(), counts));
                }
                rest.sort_by(|a, b| a.0.cmp(&b.0));
                let id = payload
                    .get("uuid")
                    .text()
                    .or_else(|| envelope.get("event_id").text())
                    .unwrap_or_else(|| format!("{}", turns.len()));
                turns.push(Turn {
                    id,
                    ts: iso(envelope.get("created_at").text()),
                    session: payload.get("session_id").clone(),
                    at: at.clone(),
                    rest,
                    position,
                });
                results.push(position);
                window.clear();
                totals = current;
            }
            _ => {}
        }
        Ok(())
    }, |_| {})?;
    // Settle each model's counters across the turns that report it.
    let mut models: Vec<String> = turns
        .iter()
        .flat_map(|turn| turn.rest.iter().map(|(model, _)| model.clone()))
        .collect();
    models.sort();
    models.dedup();
    for model in &models {
        for slot in 0..COUNTERS.len() {
            let mut column: Vec<f64> = turns
                .iter()
                .filter_map(|turn| turn.rest.iter().find(|(m, _)| m == model).map(|(_, c)| c[slot]))
                .collect();
            settle(&mut column);
            let mut values = column.into_iter();
            for turn in &mut turns {
                if let Some((_, counts)) = turn.rest.iter_mut().find(|(m, _)| m == model) {
                    counts[slot] = values.next().unwrap_or(0.0);
                }
            }
        }
    }
    let after = |ts: &str| since.is_none_or(|s| s.is_empty() || ts >= s);
    let funded = |mut row: V, at: usize, turn: bool| {
        if promotional(&marks, &results, at, turn) {
            row.set("billing_mode", V::from("grant"));
        }
        row
    };
    let mut events: Vec<V> = calls
        .into_iter()
        .zip(call_at)
        .map(|(call, at)| funded(call, at, false))
        .filter(|call| call.get("ts").text().is_some_and(|ts| after(&ts)))
        .collect();
    for turn in turns {
        let Some(ts) = turn.ts.filter(|ts| after(ts)) else {
            continue;
        };
        for (model, [input, read, write, out, thinking]) in turn.rest {
            if input + read + write + out + thinking <= 0.0 {
                continue;
            }
            events.push(funded(own(row(
                store,
                file,
                V::from(format!("turn:{}:{model}", turn.id)),
                ts.clone(),
                &turn.at,
                V::from(model),
                false,
                // The turn reports cache writes without their 5 min / 1 h split.
                [input, read, write, 0.0, 0.0, out, thinking],
                turn.session.clone(),
                V::Null,
                &V::Null,
            )?), turn.position, true));
        }
    }
    let mut result = V::obj();
    result.set("events", V::Arr(events));
    result.set("limitHits", V::Arr(vec![]));
    let mut source = V::obj();
    source.set("sha256", V::from(sha256));
    source.set("byteLength", V::Num(bytes as f64));
    result.set("source", source);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn golden(name: &str) -> String {
        format!("{}/tests/golden/{name}", env!("CARGO_MANIFEST_DIR"))
    }
    fn events(since: Option<&str>) -> Vec<V> {
        let parsed = crate::claude::parse("live", &golden("claude-cloud/session_t.events.jsonl"), since, true).unwrap();
        let V::Arr(events) = parsed.get("events").clone() else {
            panic!("missing events")
        };
        events
    }
    fn by_id<'a>(events: &'a [V], id: &str) -> &'a V {
        events.iter().find(|e| e.get("call_id").is(id)).unwrap_or_else(|| panic!("no {id}"))
    }
    fn n(row: &V, key: &str) -> f64 {
        row.get(key).number().unwrap()
    }
    #[test]
    fn calls_carry_exact_input_and_turns_carry_output_and_the_rest() {
        let events = events(None);
        let ids: Vec<String> = events.iter().map(|e| e.get("call_id").text().unwrap()).collect();
        assert_eq!(ids, ["msg_1", "msg_2", "msg_3", "turn:r1:model-a", "turn:r2:model-a", "turn:r2:model-b"]);
        let first = by_id(&events, "msg_1");
        assert_eq!(first.get("cwd"), &V::from("H:/repos/Repo/web"));
        assert_eq!(first.get("project"), &V::from("web"));
        assert_eq!(first.get("entrypoint"), &V::from("cloud"));
        assert_eq!(first.get("cc_version"), &V::from("2.1.300"));
        assert_eq!(first.get("session_id"), &V::from("s-1"));
        assert_eq!(first.get("request_id"), &V::from("req_1"));
        assert_eq!(first.get("ts"), &V::from("2026-10-21T07:00:02.500Z"));
        assert_eq!((n(first, "in_uncached"), n(first, "in_cache_read"), n(first, "in_cache_write")), (10.0, 100.0, 5.0));
        assert_eq!((n(first, "cache_write_5m"), n(first, "cache_write_1h"), n(first, "out_total")), (0.0, 5.0, 0.0));
        assert_eq!(first.get("git_branch"), &V::Null);
        let owner = "claude:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-0000000000aa";
        assert_eq!(first.get("account_key"), &V::from(owner));
        assert_eq!(
            first.get("subscription_id"),
            &V::from(format!("claude-{}", &format!("{:x}", Sha256::digest(owner.as_bytes()))[..16]))
        );
        let sub = by_id(&events, "msg_2");
        assert_eq!(n(sub, "is_sidechain"), 1.0);
        assert_eq!(sub.get("git_branch"), &V::from("claude/feature"));
        // msg_3 streamed after r1 although r1 counted it: r2's negative cache read is settled into r1.
        let r1 = by_id(&events, "turn:r1:model-a");
        assert_eq!(r1.get("ts"), &V::from("2026-10-21T07:00:06.250Z"));
        assert_eq!(
            ["in_uncached", "in_cache_read", "in_cache_write", "out_total", "out_thinking", "cache_write_1h"].map(|k| n(r1, k)),
            [4.0, 30.0, 0.0, 40.0, 4.0, 0.0]
        );
        let r2 = by_id(&events, "turn:r2:model-a");
        assert_eq!(["in_uncached", "in_cache_read", "out_total"].map(|k| n(r2, k)), [0.0, 0.0, 10.0]);
        let b = by_id(&events, "turn:r2:model-b");
        assert_eq!(["in_uncached", "out_total"].map(|k| n(b, k)), [7.0, 2.0]);
        assert_eq!(n(b, "is_sidechain"), 0.0);
        // The promotional credit paid the first turn (its event answers msg_1); the plan paid the second.
        let grant: Vec<String> = events
            .iter()
            .filter(|e| e.get("billing_mode").is("grant"))
            .map(|e| e.get("call_id").text().unwrap())
            .collect();
        assert_eq!(grant, ["msg_1", "msg_2", "turn:r1:model-a"]);
        // Session sums equal the provider's last running totals.
        let sum = |key: &str, model: &str| -> f64 {
            events.iter().filter(|e| e.get("model").is(model)).map(|e| n(e, key)).sum()
        };
        assert_eq!(
            ["in_uncached", "in_cache_read", "in_cache_write", "out_total"].map(|k| sum(k, "model-a")),
            [17.0, 380.0, 5.0, 50.0]
        );
    }
    #[test]
    fn since_keeps_only_later_rows() {
        let ids: Vec<String> = events(Some("2026-10-21T07:30:00.000Z"))
            .iter()
            .map(|e| e.get("call_id").text().unwrap())
            .collect();
        assert_eq!(ids, ["turn:r2:model-a", "turn:r2:model-b"]);
    }
    #[test]
    fn settle_keeps_the_total_without_negative_rows() {
        for (input, expected) in [
            (vec![8.0, -5.0], vec![3.0, 0.0]),
            (vec![-5.0, 8.0], vec![0.0, 3.0]),
            (vec![4.0, -1.0, 2.0, -3.0], vec![2.0, 0.0, 0.0, 0.0]),
            (vec![1.0, -3.0], vec![0.0, 0.0]),
        ] {
            let mut values = input;
            settle(&mut values);
            assert_eq!(values, expected);
        }
    }
    #[test]
    fn a_turns_rate_limit_event_decides_its_funding() {
        // Turn 1 ends at 7 with its event at 3 (promotional); turn 2 ends at 12 with its event at 9 (plan).
        let (marks, results) = ([(3, true), (9, false)], [7, 12]);
        assert!(promotional(&marks, &results, 2, false));
        assert!(promotional(&marks, &results, 7, true));
        assert!(!promotional(&marks, &results, 8, false));
        assert!(!promotional(&marks, &results, 12, true));
        // A turn without its own event keeps the latest earlier one; no event at all means the plan.
        assert!(promotional(&[(3, true)], &[7, 12], 10, false));
        assert!(!promotional(&[], &results, 3, false));
    }
    #[test]
    fn a_restarted_process_reports_from_zero() {
        let dir = std::env::temp_dir().join(format!("atlas-cloud-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.events.jsonl");
        let result = |id: &str, out: u32| {
            format!(r#"{{"event_id":"{id}","sequence_num":"1","created_at":"2026-10-21T07:00:00Z","payload":{{"type":"result","uuid":"{id}","modelUsage":{{"m":{{"outputTokens":{out}}}}}}}}}"#)
        };
        fs::write(&file, [result("a", 30), result("b", 50), result("c", 20)].join("\n") + "\n").unwrap();
        let parsed = parse("live", file.to_str().unwrap(), None, true).unwrap();
        let V::Arr(events) = parsed.get("events").clone() else { panic!() };
        let out: Vec<f64> = events.iter().map(|e| n(e, "out_total")).collect();
        assert_eq!(out, [30.0, 20.0, 20.0]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
