//! Provider file readers only. Attribution, compact expansion and pricing stay in Bun.
use crate::{
    js_date,
    value::{V, parse},
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

fn obj<const N: usize>(items: [(&str, V); N]) -> V {
    let mut out = V::obj();
    for (key, value) in items {
        out.set(key, value);
    }
    out
}
fn truthy(value: &V) -> bool {
    matches!(value, V::Arr(_) | V::Obj(_)) || value.truthy()
}
fn zero(value: &V) -> V {
    if truthy(value) {
        value.clone()
    } else {
        V::Num(0.0)
    }
}
fn date(value: &V) -> Result<String, String> {
    let ms = match value {
        V::Num(n) => js_date::clip(*n),
        V::Bool(b) => Some(i64::from(*b)),
        V::Str(_) => js_date::parse(&value.text().unwrap()),
        _ => js_date::parse(&crate::claude::js_string(value)),
    };
    ms.map(js_date::iso)
        .ok_or_else(|| "Invalid time value".into())
}
fn project(directory: &V) -> V {
    match directory {
        V::Str(units) if !units.is_empty() => {
            let replaced: Vec<u16> = units
                .iter()
                .map(|u| if *u == 92 { 47 } else { *u })
                .collect();
            V::Str(
                replaced
                    .split(|u| *u == 47)
                    .rfind(|part| !part.is_empty())
                    .map_or(units.clone(), |part| part.to_vec()),
            )
        }
        _ => V::from("-"),
    }
}
fn entries(value: &V) -> Vec<(V, V)> {
    match value {
        V::Obj(_) => value
            .keys()
            .into_iter()
            .map(|(k, v)| (V::Str(k.clone()), v.clone()))
            .collect(),
        V::Arr(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (V::from(i.to_string()), v.clone()))
            .collect(),
        V::Str(units) => units
            .iter()
            .enumerate()
            .map(|(i, u)| (V::from(i.to_string()), V::Str(vec![*u])))
            .collect(),
        _ => vec![],
    }
}
pub fn grok(file: &str, cwd: Option<&str>, strict: bool) -> Result<V, String> {
    let bytes = match (|| -> std::io::Result<Vec<u8>> {
        let mut input = crate::rollout_codec::reader(file, std::fs::metadata(file)?.len())?;
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes)?;
        Ok(bytes)
    })() {
        Ok(bytes) => bytes,
        Err(error) => {
            return if strict || crate::rollout_codec::compressed(file) {
                Err(error.to_string())
            } else {
                Ok(V::Arr(vec![]))
            };
        }
    };
    if (strict || crate::rollout_codec::compressed(file))
        && let Some(error) = crate::jsonl::invalid(file, &bytes)
    {
        return Err(error);
    }
    let text = String::from_utf8_lossy(&bytes);
    let cwd = cwd.map(V::from).unwrap_or(V::Null);
    let mut rows = vec![];
    for line in text.split('\n') {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(o) = parse(line) else {
            continue;
        };
        if matches!(o, V::Null) {
            return Err("Cannot read properties of null".into());
        }
        let params = o.get("params");
        let update = params.get("update");
        let usage = update.get("usage");
        if !matches!(usage, V::Obj(_) | V::Arr(_)) {
            continue;
        }
        let session = params.get("sessionId");
        let prompt = update.get("prompt_id");
        if !truthy(session) || !truthy(prompt) {
            continue;
        }
        let meta_ms = params.get("_meta").get("agentTimestampMs");
        let ts_ms = if !matches!(meta_ms, V::Null) {
            meta_ms
        } else if matches!(o.get("timestamp"), V::Num(_)) {
            o.get("timestamp")
        } else {
            &V::Null
        };
        if !truthy(ts_ms) {
            continue;
        }
        let ts = V::from(date(ts_ms)?);
        let models = entries(usage.get("modelUsage"));
        let models = if models.is_empty() {
            vec![(V::from("?"), usage.clone())]
        } else {
            models
        };
        for (model, mu) in models {
            if matches!(mu, V::Null) {
                return Err("Cannot read properties of null".into());
            }
            let input = zero(mu.get("inputTokens"));
            let output = zero(mu.get("outputTokens"));
            if matches!(input, V::Num(n) if n == 0.0) && matches!(output, V::Num(n) if n == 0.0) {
                continue;
            }
            rows.push(obj([
                ("session_id", session.clone()),
                ("prompt_id", prompt.clone()),
                ("ts", ts.clone()),
                ("model", model),
                ("stop_reason", update.get("stop_reason").clone()),
                ("cwd", cwd.clone()),
                ("project", project(&cwd)),
                ("path", V::from(file)),
                ("in_tok", input),
                ("cached_in", zero(mu.get("cachedReadTokens"))),
                ("cache_write", zero(mu.get("cacheCreationTokens"))),
                ("out_tok", output),
                ("reasoning", zero(mu.get("reasoningTokens"))),
                ("model_calls", zero(mu.get("modelCalls"))),
                ("api_duration_ms", zero(mu.get("apiDurationMs"))),
                ("cost_ticks", zero(mu.get("costUsdTicks"))),
            ]));
        }
    }
    Ok(V::Arr(rows))
}
fn prefix_hash(file: &str, length: u64) -> Result<V, String> {
    let mut input = File::open(file).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut remaining = length;
    let mut buf = vec![0; 1024 * 1024];
    while remaining > 0 {
        let cap = remaining.min(buf.len() as u64) as usize;
        let n = input.read(&mut buf[..cap]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("Gauge journal shortened during read: {file}"));
        }
        hash.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(V::from(format!("{:x}", hash.finalize())))
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for part in bytes.chunks(3) {
        let a = part[0] as usize;
        let b = part.get(1).copied().unwrap_or(0) as usize;
        let c = part.get(2).copied().unwrap_or(0) as usize;
        out.push(TABLE[a >> 2] as char);
        out.push(TABLE[(a & 3) << 4 | b >> 4] as char);
        out.push(if part.len() > 1 {
            TABLE[(b & 15) << 2 | c >> 6] as char
        } else {
            '='
        });
        out.push(if part.len() > 2 {
            TABLE[c & 63] as char
        } else {
            '='
        });
    }
    out
}
pub fn gauges(
    file: &str,
    offset: u64,
    size: u64,
    max_bytes: u64,
    include_bytes: bool,
    compact_transport: bool,
) -> Result<V, String> {
    let mut input = File::open(file).map_err(|e| e.to_string())?;
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut position = offset;
    let mut consumed = 0;
    let mut evidence_offset = offset;
    let mut chunk = vec![0; 4 * 1024 * 1024];
    let mut carry = vec![];
    let mut lines = vec![];
    let mut bytes = vec![];
    let mut done = true;
    while position < size {
        let cap = (size - position).min(chunk.len() as u64) as usize;
        let n = input.read(&mut chunk[..cap]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        position += n as u64;
        carry.extend_from_slice(&chunk[..n]);
        let Some(end) = carry.iter().rposition(|b| *b == b'\n') else {
            continue;
        };
        if include_bytes {
            bytes.push(V::from(base64(&carry[..=end])));
        }
        let text = String::from_utf8_lossy(&carry[..=end]);
        if compact_transport {
            // One chunk avoids a wire object and a second JSON tree per journal line.
            lines.push(V::Arr(vec![
                V::from(base64(&carry[..=end])),
                V::Num(evidence_offset as f64),
            ]));
            evidence_offset += text.len() as u64;
        } else {
            for line in text.split_terminator('\n') {
                let raw = parse(line).ok().filter(V::dict).unwrap_or(V::Null);
                let entry = raw.get("journal_entry_id");
                let entry = if matches!(entry, V::Str(_)) {
                    entry.clone()
                } else {
                    V::Null
                };
                let canonical = raw
                    .keys()
                    .iter()
                    .any(|(k, _)| String::from_utf16_lossy(k).starts_with("canonical_"));
                lines.push(obj([
                    ("line", V::from(line)),
                    ("offset", V::Num(evidence_offset as f64)),
                    ("entry_id", entry),
                    (
                        "compact",
                        V::Bool(matches!(raw.get("journal_version"), V::Num(n) if *n == 3.0)),
                    ),
                    ("canonical", V::Bool(canonical)),
                    ("raw", raw),
                ]));
                evidence_offset += line.len() as u64 + 1;
            }
        }
        consumed += end as u64 + 1;
        carry.drain(..=end);
        if consumed >= max_bytes && position < size {
            done = false;
            break;
        }
    }
    Ok(obj([
        ("lines", V::Arr(lines)),
        ("bytes", V::Arr(bytes)),
        ("consumed", V::Num(consumed as f64)),
        ("done", V::Bool(done)),
        (
            "prefixHash",
            if done && !include_bytes {
                prefix_hash(file, offset + consumed)?
            } else {
                V::Null
            },
        ),
    ]))
}
fn sqlite(file: &str) -> Result<Connection, String> {
    if std::fs::metadata(format!("{file}-wal")).is_ok_and(|s| s.len() > 0) {
        return Err(format!(
            "Archive database has uncheckpointed WAL; consistent snapshot required: {file}"
        ));
    }
    let absolute = std::path::absolute(file).map_err(|e| e.to_string())?;
    let path = absolute.to_string_lossy().replace('\\', "/");
    let mut uri = String::from("file:");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/:._~-".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())
}
fn column(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<V> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null => V::Null,
        ValueRef::Integer(n) => V::Num(n as f64),
        ValueRef::Real(n) => V::Num(n),
        ValueRef::Text(s) => V::from(String::from_utf8_lossy(s).into_owned()),
        ValueRef::Blob(_) => {
            return Err(rusqlite::Error::InvalidColumnType(
                index,
                "source field".into(),
                rusqlite::types::Type::Blob,
            ));
        }
    })
}
pub fn opencode(file: &str) -> Result<V, String> {
    let db = sqlite(file)?;
    let mut sessions = HashMap::new();
    let mut query = db
        .prepare("SELECT id, directory FROM session")
        .map_err(|e| e.to_string())?;
    let mapped = query
        .query_map([], |row| Ok((column(row, 0)?, column(row, 1)?)))
        .map_err(|e| e.to_string())?;
    for row in mapped {
        let (id, directory) = row.map_err(|e| e.to_string())?;
        sessions.insert(id.json(), directory);
    }
    let mut query = db
        .prepare("SELECT id, session_id, data FROM message")
        .map_err(|e| e.to_string())?;
    let mapped = query
        .query_map([], |row| {
            Ok((column(row, 0)?, column(row, 1)?, column(row, 2)?))
        })
        .map_err(|e| e.to_string())?;
    let mut rows = vec![];
    for row in mapped {
        let (id, session, data) = row.map_err(|e| e.to_string())?;
        let d = parse(&data.text().unwrap_or_else(|| data.json()))
            .map_err(|e| format!("Invalid archived OpenCode message JSON: {e}"))?;
        if matches!(d, V::Null) {
            return Err("Cannot read properties of null".into());
        }
        if !d.get("role").is("assistant") {
            continue;
        }
        let t = d.get("tokens");
        let created = d.get("time").get("created");
        if !truthy(created) {
            continue;
        }
        let directory = sessions.get(&session.json()).cloned().unwrap_or(V::Null);
        rows.push(V::Arr(vec![
            id,
            session,
            V::from(date(created)?),
            d.get("modelID").clone(),
            d.get("providerID").clone(),
            d.get("agent").clone(),
            d.get("mode").clone(),
            project(&directory),
            directory,
            zero(t.get("input")),
            zero(t.get("output")),
            zero(t.get("reasoning")),
            zero(t.get("cache").get("read")),
            zero(t.get("cache").get("write")),
            zero(d.get("cost")),
        ]));
    }
    Ok(V::Arr(rows))
}

#[derive(Default)]
struct Wire {
    nums: HashMap<String, f64>,
    strs: HashMap<String, String>,
}
fn varint(b: &[u8], i: &mut usize) -> Option<f64> {
    let mut shift = 0;
    let mut result = 0.0;
    while *i < b.len() {
        let byte = b[*i];
        *i += 1;
        result += f64::from(byte & 0x7f) * 2_f64.powi(shift);
        shift += 7;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        if shift > 70 {
            return None;
        }
    }
    None
}
fn message(b: &[u8]) -> bool {
    let mut i = 0;
    let mut fields = 0;
    while i < b.len() {
        let Some(key) = varint(b, &mut i) else {
            return false;
        };
        let wire = (key % 8.0) as u8;
        if (key / 8.0).floor() == 0.0 {
            return false;
        }
        match wire {
            0 => {
                if varint(b, &mut i).is_none() {
                    return false;
                }
            }
            1 => i += 8,
            5 => i += 4,
            2 => {
                let Some(len) = varint(b, &mut i) else {
                    return false;
                };
                if len > (b.len().saturating_sub(i)) as f64 {
                    return false;
                }
                i += len as usize;
            }
            _ => return false,
        }
        fields += 1;
    }
    i == b.len() && fields > 0
}
fn walk(b: &[u8], path: &str, out: &mut Wire, depth: usize) {
    if depth > 8 {
        return;
    }
    let mut i = 0;
    while i < b.len() {
        let Some(key) = varint(b, &mut i) else {
            break;
        };
        let field = (key / 8.0).floor();
        let p = format!("{path}.{field}");
        match (key % 8.0) as u8 {
            0 => {
                let Some(v) = varint(b, &mut i) else {
                    break;
                };
                out.nums.entry(p).or_insert(v);
            }
            1 => i += 8,
            5 => i += 4,
            2 => {
                let Some(len) = varint(b, &mut i) else {
                    break;
                };
                let end = i.saturating_add(len as usize);
                let sub = &b[i.min(b.len())..end.min(b.len())];
                i = end;
                if sub.len() > 1 && message(sub) {
                    walk(sub, &p, out, depth + 1);
                } else if let Ok(text) = std::str::from_utf8(sub) {
                    // TextDecoder removes the UTF-8 BOM and measures JS UTF-16 length.
                    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
                    let len = text.encode_utf16().count();
                    if len > 0 && len < 200 {
                        out.strs.entry(p).or_insert_with(|| text.to_owned());
                    }
                }
            }
            _ => break,
        }
    }
}
fn scan(b: &[u8]) -> Wire {
    let mut out = Wire::default();
    walk(b, "", &mut out, 0);
    out
}
fn gemini_rows(
    file: &str,
    db: &Connection,
    rows: &mut Vec<V>,
    invariant: &mut V,
    mtime: Option<f64>,
) -> Result<(), String> {
    let conversation = Path::new(file)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let conversation = conversation.strip_suffix(".db").unwrap_or(&conversation);
    let meta = (|| -> rusqlite::Result<Wire> {
        let data: Option<Vec<u8>> = db.query_row(
            "SELECT data FROM trajectory_metadata_blob LIMIT 1",
            [],
            |r| r.get(0),
        )?;
        Ok(data.map_or_else(Wire::default, |b| scan(&b)))
    })()
    .unwrap_or_default();
    let seconds = meta.nums.get(".2.1").copied();
    let seconds = seconds.filter(|s| *s > 1_600_000_000.0 && *s < 2_000_000_000.0);
    let (ts, basis) = if let Some(s) = seconds {
        (date(&V::Num(s * 1000.0))?, "conversation")
    } else {
        let ms = match mtime {
            Some(ms) => ms,
            None => {
                std::fs::metadata(file)
                    .and_then(|s| s.modified())
                    .map_err(|e| e.to_string())?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs_f64()
                    * 1000.0
            }
        };
        (date(&V::Num(ms))?, "mtime")
    };
    let workspace = meta
        .strs
        .get(".18")
        .map(|s| V::from(s.clone()))
        .unwrap_or(V::Null);
    let mut query = db
        .prepare("SELECT idx, data FROM gen_metadata ORDER BY idx")
        .map_err(|e| e.to_string())?;
    let mapped = query
        .query_map([], |r| Ok((column(r, 0)?, r.get::<_, Option<Vec<u8>>>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in mapped {
        let (idx, data) = row.map_err(|e| e.to_string())?;
        let Some(data) = data else {
            continue;
        };
        let scan = scan(&data);
        let Some(fresh) = scan.nums.get(".1.4.2").copied() else {
            continue;
        };
        let n = |p: &str| scan.nums.get(p).copied().unwrap_or(0.0);
        let total = n(".1.4.3");
        let thinking = n(".1.4.9");
        let visible = n(".1.4.10");
        if total > 0.0 {
            invariant.set(
                "checked",
                V::Num(invariant.get("checked").number().unwrap() + 1.0),
            );
            if thinking + visible != total {
                invariant.set(
                    "violations",
                    V::Num(invariant.get("violations").number().unwrap() + 1.0),
                );
                if let V::Arr(examples) = invariant.get("examples")
                    && examples.len() < 5
                {
                    let mut examples = examples.clone();
                    // Number text is emitted through the JS-compatible serializer on Bun.
                    examples.push(V::from(format!(
                        "{conversation}#{}: out_total={} != thinking={} + visible={}",
                        number_text(&idx),
                        number_text(&V::Num(total)),
                        number_text(&V::Num(thinking)),
                        number_text(&V::Num(visible))
                    )));
                    invariant.set("examples", V::Arr(examples));
                }
            }
        }
        rows.push(obj([
            ("conversation_id", V::from(conversation)),
            ("gen_idx", idx),
            ("ts", V::from(ts.clone())),
            ("ts_basis", V::from(basis)),
            ("workspace", workspace.clone()),
            ("path", V::from(file)),
            (
                "model",
                scan.strs
                    .get(".1.19")
                    .map(|s| V::from(s.clone()))
                    .unwrap_or(V::Null),
            ),
            ("fresh_in", V::Num(fresh)),
            ("cached_in", V::Num(n(".1.4.5"))),
            ("out_total", V::Num(total)),
            ("out_thinking", V::Num(thinking)),
            ("out_visible", V::Num(visible)),
            ("context_tokens", V::Num(n(".1.9.10.1"))),
            ("context_limit", V::Num(n(".1.9.10.4"))),
        ]));
    }
    Ok(())
}
fn number_text(value: &V) -> String {
    crate::claude::js_string(value)
}

pub fn gemini(file: &str, strict: bool, mtime: Option<f64>) -> Result<V, String> {
    let mut rows = vec![];
    let mut invariant = obj([
        ("checked", V::Num(0.0)),
        ("violations", V::Num(0.0)),
        ("examples", V::Arr(vec![])),
    ]);
    let result =
        sqlite(file).and_then(|db| gemini_rows(file, &db, &mut rows, &mut invariant, mtime));
    if strict {
        result?;
    }
    Ok(obj([("rows", V::Arr(rows)), ("invariant", invariant)]))
}
pub fn execute(format: &str, input: &Value) -> Result<V, String> {
    let file = input["file"].as_str().ok_or("missing file")?;
    match format {
        "archiveDigest" => {
            let mut input = File::open(file).map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            let mut buf = vec![0; 1024 * 1024];
            loop {
                let n = input.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            Ok(V::from(format!("{:x}", hash.finalize())))
        }
        "grok" => grok(
            file,
            input["cwd"].as_str(),
            input["strictRead"].as_bool().unwrap_or(false),
        ),
        "gaugesJournal" => gauges(
            file,
            input["offset"].as_u64().ok_or("invalid offset")?,
            input["size"].as_u64().ok_or("invalid size")?,
            input["maxBytes"].as_u64().unwrap_or(u64::MAX),
            input["includeBytes"].as_bool().unwrap_or(false),
            input["compactTransport"].as_bool().unwrap_or(false),
        ),
        "opencode" => opencode(file),
        "gemini" => gemini(
            file,
            input["strictRead"].as_bool().unwrap_or(false),
            input["mtimeMs"].as_f64(),
        ),
        _ => Err("unsupported format".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_retains_first_value_and_rejects_invalid_utf8() {
        let wire = scan(&[8, 1, 8, 2, 18, 3, 0xed, 0xa0, 0x80]);
        assert_eq!(wire.nums.get(".1"), Some(&1.0));
        assert!(wire.strs.is_empty());
        assert_eq!(
            scan(&[10, 4, 0xef, 0xbb, 0xbf, b'X']).strs.get(".1"),
            Some(&"X".into())
        );
    }
    #[test]
    fn source_uri_is_read_only_and_does_not_create_missing_files() {
        let file =
            std::env::temp_dir().join(format!("atlas-native-missing-{}.db", std::process::id()));
        assert!(sqlite(file.to_str().unwrap()).is_err());
        assert!(!file.exists());
    }
}
