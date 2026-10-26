use crate::{codex, value::V};
use serde_json::json;
use std::{
    fs, io,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};

#[derive(Default)]
pub struct Metrics {
    pub active: AtomicUsize,
    pub files: AtomicU64,
    pub parse: AtomicU64,
    pub archive_digest: AtomicU64,
    pub serialize: AtomicU64,
    pub cleanup: AtomicU64,
    pub write: AtomicU64,
    pub writer_wait: AtomicU64,
    pub queue: AtomicU64,
    pub idle: AtomicU64,
    pub bytes: AtomicU64,
}
pub fn elapsed(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u64::MAX as u128) as u64
}
pub fn add(target: &AtomicU64, value: u64) {
    target.fetch_add(value, Ordering::Relaxed);
}
impl Metrics {
    pub fn snapshot(&self) -> serde_json::Value {
        let sec = |n: &AtomicU64| n.load(Ordering::Relaxed) as f64 / 1e9;
        json!({"files":self.files.load(Ordering::Relaxed), "parseElapsedSeconds":sec(&self.parse),
            "archiveDigestElapsedSeconds":sec(&self.archive_digest),
            "serializationElapsedSeconds":sec(&self.serialize), "cleanupElapsedSeconds":sec(&self.cleanup),
            "pipeWriteSeconds":sec(&self.write), "writerLockWaitSeconds":sec(&self.writer_wait),
            "queueWaitSeconds":sec(&self.queue), "workerIdleSeconds":sec(&self.idle),
            "responseBytes":self.bytes.load(Ordering::Relaxed), "parseDetail":crate::trace::snapshot()})
    }
}
pub fn bench(manifest: &str, workers: usize, serialize: bool) -> io::Result<()> {
    let values: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest)?).map_err(io::Error::other)?;
    let inputs: Vec<(String, u64)> = values
        .as_array()
        .ok_or_else(|| io::Error::other("manifest must be an array"))?
        .iter()
        .map(|v| {
            Ok((
                v["file"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("invalid file"))?
                    .to_owned(),
                v["size"]
                    .as_u64()
                    .ok_or_else(|| io::Error::other("invalid size"))?,
            ))
        })
        .collect::<io::Result<_>>()?;
    let inputs = Arc::new(inputs);
    let next = Arc::new(AtomicUsize::new(0));
    let metrics = Arc::new(Metrics::default());
    let wall = Instant::now();
    thread::scope(|scope| -> io::Result<()> {
        let mut handles = vec![];
        for _ in 0..workers {
            let inputs = inputs.clone();
            let next = next.clone();
            let metrics = metrics.clone();
            handles.push(scope.spawn(move || -> io::Result<()> {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((file, size)) = inputs.get(index) else {
                        return Ok(());
                    };
                    let started = Instant::now();
                    let value = codex::prepare(file, *size, false).map_err(io::Error::other)?;
                    add(&metrics.parse, elapsed(started));
                    if !value.get("kind").is("ok") {
                        return Err(io::Error::other(value.json()));
                    }
                    if serialize {
                        let started = Instant::now();
                        let bytes = encode_response(&serde_json::Value::from(index as u64), &value);
                        add(&metrics.serialize, elapsed(started));
                        add(&metrics.bytes, bytes.len() as u64);
                        std::hint::black_box(&bytes);
                    }
                    let started = Instant::now();
                    drop(value);
                    add(&metrics.cleanup, elapsed(started));
                    add(&metrics.files, 1);
                }
            }));
        }
        for handle in handles {
            handle
                .join()
                .map_err(|_| io::Error::other("benchmark worker panicked"))??;
        }
        Ok(())
    })?;
    println!(
        "{}",
        json!({"entryPoint":"codex::prepare (same producer as ParsePool)", "mode":if serialize {"parse+serialization; no pipe"} else {"parse only; no serialization or pipe"},
        "workers":workers, "wallSeconds":wall.elapsed().as_secs_f64(), "metrics":metrics.snapshot(),
        "excludes":"discovery, manifest read, DB, archive writes, Bun, pipe; summed worker elapsed times overlap and include IO"})
    );
    Ok(())
}
pub fn encode_response(id: &serde_json::Value, value: &V) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(8192);
    write!(&mut out, "{{\"id\":{id},\"ok\":true,\"value\":").unwrap();
    value.write_json(&mut out);
    out.push('}');
    out
}
