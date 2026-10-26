use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};
pub static OPEN: AtomicU64 = AtomicU64::new(0);
pub static SETUP: AtomicU64 = AtomicU64::new(0);
pub static SOURCE_CLEANUP: AtomicU64 = AtomicU64::new(0);
pub static READ: AtomicU64 = AtomicU64::new(0);
pub static HASH: AtomicU64 = AtomicU64::new(0);
pub static JSON: AtomicU64 = AtomicU64::new(0);
pub static SCAN: AtomicU64 = AtomicU64::new(0);
pub static UTF8: AtomicU64 = AtomicU64::new(0);
pub static RECONCILE: AtomicU64 = AtomicU64::new(0);
pub static BUILD: AtomicU64 = AtomicU64::new(0);
pub static CLONE: AtomicU64 = AtomicU64::new(0);
pub fn add(counter: &AtomicU64, start: Instant) {
    counter.fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
}
pub fn snapshot() -> serde_json::Value {
    let s = |n: &AtomicU64| n.load(Ordering::Relaxed) as f64 / 1e9;
    serde_json::json!({"fileOpenElapsedSeconds":s(&OPEN),"readSetupElapsedSeconds":s(&SETUP),"sourceCleanupElapsedSeconds":s(&SOURCE_CLEANUP),"fileReadElapsedSeconds":s(&READ),"sha256ElapsedSeconds":s(&HASH),"jsonTreeElapsedSeconds":s(&JSON),"recordCloneElapsedSeconds":s(&CLONE),"tagScanElapsedSeconds":s(&SCAN),"utf8ValidationElapsedSeconds":s(&UTF8),"reconcileElapsedSeconds":s(&RECONCILE),"resultBuildElapsedSeconds":s(&BUILD)})
}
