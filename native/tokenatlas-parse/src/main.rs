// File results allocate many small vectors and strings across worker threads.
#[cfg(windows)]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;
mod claude;
mod claude_cloud;
mod codex;
mod js_date;
mod jsonl;
mod other;
mod profile;
mod rollout_codec;
mod trace;
mod value;

use profile::{Metrics, add, elapsed};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    thread,
    time::Instant,
};

const MAX_REQUEST: usize = 16 * 1024 * 1024;
fn default_workers() -> usize {
    thread::available_parallelism()
        .map_or(1, usize::from)
        .saturating_sub(2)
        .clamp(1, 8)
}
fn execute(request: Value, metrics: &Metrics, partials: &mut Vec<String>) -> String {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if matches!(
        request["format"].as_str(),
        Some("grok" | "gaugesJournal" | "gemini" | "opencode" | "archiveDigest")
    ) {
        let started = Instant::now();
        let mut result = other::execute(request["format"].as_str().unwrap(), &request["input"]);
        let digest = request["format"] == "archiveDigest";
        add(
            if digest {
                &metrics.archive_digest
            } else {
                &metrics.parse
            },
            elapsed(started),
        );
        let started = Instant::now();
        if request["format"] == "gaugesJournal"
            && request["input"]["chunkedTransport"].as_bool() == Some(true)
            && let Ok(value::V::Obj(fields)) = &mut result
            && let Some((_, value::V::Arr(lines))) = fields
                .iter_mut()
                .find(|(k, _)| k.iter().copied().eq("lines".encode_utf16()))
        {
            for line in std::mem::take(lines) {
                let mut frame =
                    format!("{{\"id\":{id},\"ok\":true,\"partial\":true,\"value\":{{\"lines\":[");
                line.write_json(&mut frame);
                frame.push_str("],\"bytes\":[]}}");
                partials.push(frame);
            }
        }
        let response = match &result {
            Ok(value) => profile::encode_response(&id, value),
            Err(message) => json!({"id":id,"ok":false,"message":message}).to_string(),
        };
        add(&metrics.serialize, elapsed(started));
        if !digest {
            add(&metrics.files, 1);
        }
        return response;
    }
    if request["format"] != "codex" && request["format"] != "claude" {
        return json!({"id":id,"ok":false,"code":"unsupported","message":"native format not supported"}).to_string();
    }
    let Some(file) = request["input"]["file"].as_str() else {
        return json!({"id":id,"ok":false,"message":"missing file"}).to_string();
    };
    if request["format"] == "claude" {
        let Some(store) = request["input"]["store"].as_str() else {
            return json!({"id":id,"ok":false,"message":"missing store"}).to_string();
        };
        let started = Instant::now();
        let validate = request["input"]["validate"].as_bool() == Some(true);
        let result = claude::parse(store, file, request["input"]["since"].as_str(), validate);
        add(&metrics.parse, elapsed(started));
        let started = Instant::now();
        let response = match &result {
            Ok(value) => profile::encode_response(&id, value),
            Err(error) => {
                json!({"id":id,"ok":false,"message":error.message,"code":error.code}).to_string()
            }
        };
        add(&metrics.serialize, elapsed(started));
        let started = Instant::now();
        drop(result);
        add(&metrics.cleanup, elapsed(started));
        add(&metrics.files, 1);
        return response;
    }
    let Some(size) = request["input"]["size"].as_u64() else {
        return json!({"id":id,"ok":false,"message":"invalid size"}).to_string();
    };
    let started = Instant::now();
    let validate = request["input"]["validate"].as_bool() == Some(true);
    let result = codex::prepare(file, size, validate);
    add(&metrics.parse, elapsed(started));
    let started = Instant::now();
    let response = match &result {
        Ok(value) => profile::encode_response(&id, value),
        Err(message) => json!({"id":id,"ok":false,"message":message}).to_string(),
    };
    add(&metrics.serialize, elapsed(started));
    let started = Instant::now();
    drop(result);
    add(&metrics.cleanup, elapsed(started));
    add(&metrics.files, 1);
    response
}
fn write_frame(output: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    let length = u32::try_from(bytes.len())
        .map_err(|_| io::Error::other("response exceeds framing limit"))?;
    output.write_all(&length.to_le_bytes())?;
    output.write_all(bytes)?;
    output.flush()
}
fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|v| v == "--decode-rollout" || v == "--encode-rollout") {
        let source = args
            .get(2)
            .ok_or_else(|| io::Error::other("missing source"))?;
        let destination = args
            .get(3)
            .ok_or_else(|| io::Error::other("missing destination"))?;
        return if args[1] == "--encode-rollout" {
            rollout_codec::encode(source, std::path::Path::new(destination))
        } else {
            rollout_codec::decode(source, std::path::Path::new(destination))
        };
    }
    if args.get(1).is_some_and(|v| v == "--bench") {
        let manifest = args
            .get(2)
            .ok_or_else(|| io::Error::other("missing manifest"))?;
        let workers = args
            .get(3)
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or_else(default_workers)
            .clamp(1, 256);
        return profile::bench(
            manifest,
            workers,
            args.get(4).is_some_and(|v| v == "serialize"),
        );
    }
    let workers = args
        .get(1)
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or_else(default_workers)
        .clamp(1, 256);
    let (tx, rx) = mpsc::sync_channel::<(Value, Instant)>(workers * 2);
    let rx = Arc::new(Mutex::new(rx));
    let output = Arc::new(Mutex::new(io::stdout()));
    let metrics = Arc::new(Metrics::default());
    let mut threads = vec![];
    for _ in 0..workers {
        let rx = rx.clone();
        let output = output.clone();
        let metrics = metrics.clone();
        threads.push(thread::spawn(move || -> io::Result<()> {
            loop {
                let idle = Instant::now();
                let (request, queued) = match rx.lock().unwrap().recv() {
                    Ok(r) => r,
                    Err(_) => return Ok(()),
                };
                add(&metrics.idle, elapsed(idle));
                add(&metrics.queue, elapsed(queued));
                metrics.active.fetch_add(1, Ordering::SeqCst);
                let (result, partials) = match std::panic::catch_unwind(|| {
                    let mut partials = vec![];
                    let result = execute(request, &metrics, &mut partials);
                    (result, partials)
                }) {
                    Ok(result) => result,
                    Err(_) => std::process::exit(1),
                };
                let wait = Instant::now();
                let mut writer = output.lock().unwrap();
                add(&metrics.writer_wait, elapsed(wait));
                let started = Instant::now();
                let mut bytes = result.len() as u64;
                for frame in partials {
                    write_frame(&mut *writer, frame.as_bytes())?;
                    bytes += frame.len() as u64;
                }
                write_frame(&mut *writer, result.as_bytes())?;
                add(&metrics.write, elapsed(started));
                add(&metrics.bytes, bytes);
                metrics.active.fetch_sub(1, Ordering::SeqCst);
            }
        }));
    }
    let mut input = io::stdin().lock();
    loop {
        let mut prefix = [0; 4];
        match input.read(&mut prefix[..1])? {
            0 => break,
            _ => input.read_exact(&mut prefix[1..])?,
        }
        let length = u32::from_le_bytes(prefix) as usize;
        if length > MAX_REQUEST {
            return Err(io::Error::other("request exceeds framing limit"));
        }
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let request: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if request["format"] == "profile" {
            while metrics.active.load(Ordering::SeqCst) != 0 {
                thread::yield_now();
            }
            let response =
                json!({"id":request["id"],"ok":true,"value":metrics.snapshot()}).to_string();
            write_frame(&mut *output.lock().unwrap(), response.as_bytes())?;
        } else {
            tx.send((request, Instant::now()))
                .map_err(io::Error::other)?;
        }
    }
    drop(tx);
    for thread in threads {
        thread
            .join()
            .map_err(|_| io::Error::other("native worker panicked"))??;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_is_typed_and_keeps_request_id() {
        let response: Value = serde_json::from_str(&execute(
            json!({"id":7,"format":"unknown","input":{}}),
            &Metrics::default(),
            &mut vec![],
        ))
        .unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["ok"], false);
        assert_eq!(response["code"], "unsupported");
    }
}
