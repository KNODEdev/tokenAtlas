use crate::model::{AccountFacts, Batch, Meter, Point, Profile, Settings, hash};
use anyhow::{Context, Result, bail};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

const MAX_LINE: usize = 3 * 1024 * 1024;
pub const POINT_LIMIT: usize = 600;

pub struct Store {
    root: PathBuf,
    db: Connection,
    _lock: File,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_mode(root, true)
    }
    pub fn open_settings(root: &Path) -> Result<Self> {
        Self::open_mode(root, false)
    }
    fn open_mode(root: &Path, replay: bool) -> Result<Self> {
        if !root.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(root)
                .context("Nie można utworzyć folderu monitora")?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("monitor.lock"))?;
        lock.try_lock_exclusive()
            .context("Ten folder jest już używany przez inny monitor")?;
        if replay {
            fs::create_dir_all(root.join("originals"))?;
        }
        let db = Connection::open(root.join("monitor.sqlite"))?;
        db.busy_timeout(std::time::Duration::from_secs(2))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-1024;
            PRAGMA mmap_size=0; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
        )?;
        if replay {
            db.execute_batch("
            CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY,offset INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS latest(account TEXT PRIMARY KEY,at INTEGER NOT NULL,profile TEXT NOT NULL,meters TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS account_facts(account TEXT PRIMARY KEY,at INTEGER NOT NULL,facts TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS samples(batch TEXT NOT NULL,account TEXT NOT NULL,meter_key TEXT NOT NULL,
                at INTEGER NOT NULL,percent REAL NOT NULL,reset INTEGER,PRIMARY KEY(batch,meter_key));
            CREATE INDEX IF NOT EXISTS sample_range ON samples(account,meter_key,at);")?;
        }
        let mut out = Self {
            root: root.to_owned(),
            db,
            _lock: lock,
        };
        if replay {
            out.recover()?;
        }
        Ok(out)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn mode(&self, demo: bool) -> Result<()> {
        let mode = if demo { "demo" } else { "live" };
        let prior: Option<String> = self
            .db
            .query_row("SELECT value FROM settings WHERE key='mode'", [], |r| {
                r.get(0)
            })
            .optional()?;
        if prior.as_deref().is_some_and(|p| p != mode) {
            bail!("Dane demo i rzeczywiste wymagają osobnych folderów");
        }
        let marker = self.root.join("monitor.identity.json");
        if marker.exists() {
            let mut bytes = Vec::new();
            File::open(&marker)?.take(1025).read_to_end(&mut bytes)?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)?;
            if value["schema"] != 1 || value["mode"].as_str() != Some(mode) {
                bail!("Dane demo i rzeczywiste wymagają osobnych folderów");
            }
        } else {
            let mut marker = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(marker)?;
            marker.write_all(
                serde_json::json!({"schema":1,"mode":mode})
                    .to_string()
                    .as_bytes(),
            )?;
            marker.sync_all()?;
            sync_directory(&self.root)?;
        }
        self.db
            .execute("INSERT OR IGNORE INTO settings VALUES('mode',?)", [mode])?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT value FROM settings WHERE key='ui'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let settings = raw
            .map(|r| serde_json::from_str::<Settings>(&r))
            .transpose()?
            .unwrap_or_default();
        settings.validate()?;
        Ok(settings)
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        settings.validate()?;
        self.db.execute("INSERT INTO settings VALUES('ui',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(settings)?])?;
        Ok(())
    }
    pub fn count(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT count(*) FROM samples", [], |r| r.get(0))?)
    }

    /// The original is fsynced before its disposable SQLite projection is published.
    pub fn append(&mut self, batch: &Batch) -> Result<()> {
        Self::validate(batch)?;
        let line = serde_json::to_vec(batch)?;
        if line.len() > MAX_LINE {
            bail!("Odczyt jest zbyt duży");
        }
        let file_name = format!(
            "readings.{}.jsonl",
            crate::model::iso(batch.at)
                .get(..10)
                .context("Invalid timestamp")?
        );
        let file_path = self.root.join("originals").join(&file_name);
        if file_path.exists() {
            self.recover_file(&file_name)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)?;
        file.write_all(&line)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        sync_directory(file_path.parent().expect("originals directory"))?;
        self.recover_file(&file_name)
    }
    fn validate(batch: &Batch) -> Result<()> {
        if batch.version != 1
            || uuid::Uuid::parse_str(&batch.id).is_err()
            || batch.meters.is_empty()
            || batch.meters.len() > 128
            || chrono::DateTime::from_timestamp_millis(batch.at).is_none()
        {
            bail!("Invalid archived observation");
        }
        for meter in &batch.meters {
            meter.validate()?;
        }
        let keys = batch
            .meters
            .iter()
            .map(Meter::key)
            .collect::<std::collections::BTreeSet<_>>();
        if keys.len() != batch.meters.len() {
            bail!("Duplicate counter in archived observation");
        }
        Ok(())
    }
    fn recover(&mut self) -> Result<()> {
        let mut files =
            fs::read_dir(self.root.join("originals"))?.collect::<std::io::Result<Vec<_>>>()?;
        files.sort_by_key(|e| e.file_name());
        for file in files {
            let name = file.file_name().to_string_lossy().to_string();
            if name.starts_with("readings.") && name.ends_with(".jsonl") {
                self.recover_file(&name)?;
            }
        }
        Ok(())
    }
    fn recover_file(&mut self, name: &str) -> Result<()> {
        let file_path = self.root.join("originals").join(name);
        let mut file = OpenOptions::new().read(true).write(true).open(&file_path)?;
        let offset = self
            .db
            .query_row("SELECT offset FROM files WHERE name=?", [name], |r| {
                r.get::<_, u64>(0)
            })
            .optional()?
            .unwrap_or(0);
        if file.metadata()?.len() < offset {
            bail!("Archiwum monitora zostało skrócone: {name}");
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new(&mut file);
        let mut cursor = offset;
        loop {
            let mut bytes = Vec::new();
            // read_until is bounded even for a corrupted source with no LF.
            let length = std::io::Read::by_ref(&mut reader)
                .take((MAX_LINE + 2) as u64)
                .read_until(b'\n', &mut bytes)?;
            if length == 0 {
                break;
            }
            if bytes.len() > MAX_LINE + 1 {
                bail!("Zbyt duży wpis archiwum: {name}");
            }
            if bytes.last() != Some(&b'\n') {
                drop(reader);
                // Retain evidence of a killed append; never silently discard provider bytes.
                let partial = self
                    .root
                    .join("originals")
                    .join(format!("{name}.{}.partial", uuid::Uuid::new_v4()));
                let mut saved = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(partial)?;
                saved.write_all(&bytes)?;
                saved.sync_all()?;
                sync_directory(&self.root.join("originals"))?;
                file.set_len(cursor)?;
                file.sync_all()?;
                return Ok(());
            }
            let batch: Batch = serde_json::from_slice(&bytes)
                .with_context(|| format!("Nieczytelny wpis archiwum {name} przy {cursor}"))?;
            Self::validate(&batch)?;
            let digest = hash(&serde_json::to_string(&batch)?);
            let next = cursor + length as u64;
            let tx = self.db.transaction()?;
            let prior: Option<String> = tx
                .query_row("SELECT digest FROM batches WHERE id=?", [&batch.id], |r| {
                    r.get(0)
                })
                .optional()?;
            if prior.as_ref().is_some_and(|p| p != &digest) {
                bail!("Sprzeczne obserwacje o tej samej tożsamości");
            }
            if prior.is_none() {
                tx.execute("INSERT INTO batches VALUES(?,?)", params![batch.id, digest])?;
                for meter in &batch.meters {
                    tx.execute(
                        "INSERT INTO samples VALUES(?,?,?,?,?,?)",
                        params![
                            batch.id,
                            batch.profile.id,
                            meter.key(),
                            batch.at,
                            meter.percent,
                            meter.resets_at
                        ],
                    )?;
                }
                tx.execute("INSERT INTO latest VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET at=excluded.at,profile=excluded.profile,meters=excluded.meters WHERE excluded.at>=latest.at",
                    params![batch.profile.id,batch.at,serde_json::to_string(&batch.profile)?,serde_json::to_string(&batch.meters)?])?;
                tx.execute("INSERT INTO account_facts VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET at=excluded.at,facts=excluded.facts WHERE excluded.at>=account_facts.at",
                    params![batch.profile.id,batch.at,serde_json::to_string(&AccountFacts::from_batch(&batch))?])?;
            }
            tx.execute("INSERT INTO files VALUES(?,?) ON CONFLICT(name) DO UPDATE SET offset=excluded.offset",params![name,next])?;
            tx.commit()?;
            cursor = next;
        }
        Ok(())
    }
    pub fn latest(&self, account: &str) -> Result<Option<(i64, Vec<Meter>)>> {
        let value: Option<(i64, String)> = self
            .db
            .query_row(
                "SELECT at,meters FROM latest WHERE account=?",
                [account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        value
            .map(|(at, json)| Ok((at, serde_json::from_str(&json)?)))
            .transpose()
    }
    pub fn known_profiles(&self) -> Result<Vec<Profile>> {
        if !self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='latest')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Ok(vec![]);
        }
        let mut q = self
            .db
            .prepare("SELECT profile FROM latest ORDER BY account")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect()
    }
    pub fn facts(&self, account: &str) -> Result<AccountFacts> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT facts FROM account_facts WHERE account=?",
                [account],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw
            .map(|raw| serde_json::from_str(&raw))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn points(&self, account: &str, meter: &Meter) -> Result<Vec<Point>> {
        // Binning in SQLite bounds result memory, preserving the first and last sample of every bin.
        // Five-minute bins suffice for a five-hour window; longer windows scale to <=600 points.
        let latest = self.latest(account)?.map(|v| v.0).unwrap_or(0);
        let start = meter
            .resets_at
            .zip(meter.minutes)
            .map(|(r, m)| r - m * 60_000)
            .unwrap_or(latest - 30 * 86_400_000);
        let span = meter.minutes.unwrap_or(30 * 1440) * 60_000;
        let bin = (span / (POINT_LIMIT as i64 / 2)).max(1);
        let mut query=self.db.prepare("WITH source AS (
            SELECT at,percent,reset,lag(at) OVER(ORDER BY at,batch) prev_at,lag(percent) OVER(ORDER BY at,batch) prev_percent
            FROM samples WHERE account=?1 AND meter_key=?2 AND at>=?3 AND reset IS ?4),
            segmented AS (SELECT *,sum(CASE WHEN percent<prev_percent THEN 1 ELSE 0 END)
                OVER(ORDER BY at) segment FROM source),
            bins AS (SELECT min(at) first,max(at) last,segment FROM segmented GROUP BY segment,(at-?3)/?5),
            chosen AS (SELECT at,percent,reset,segment FROM segmented s WHERE EXISTS(
                SELECT 1 FROM bins b WHERE b.segment=s.segment AND (s.at=b.first OR s.at=b.last)) ORDER BY at DESC LIMIT 600)
            SELECT * FROM chosen ORDER BY at")?;
        let rows = query.query_map(
            params![account, meter.key(), start, meter.resets_at, bin],
            |r| {
                Ok(Point {
                    at: r.get(0)?,
                    percent: r.get(1)?,
                    reset: r.get(2)?,
                    segment: r.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_mode_never_replays_or_repairs_old_private_history() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("originals")).unwrap();
        let original = dir.path().join("originals/readings.2026-10-17.jsonl");
        fs::write(&original, "corrupt old standalone history\n").unwrap();
        let store = Store::open_settings(dir.path()).unwrap();
        assert!(store.known_profiles().unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(original).unwrap(),
            "corrupt old standalone history\n"
        );
        assert_eq!(
            store
                .db
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='samples'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    fn batch() -> Batch {
        Batch::new(
            &crate::common::demo_profiles()[0],
            serde_json::json!({"original":true}),
            vec![Meter {
                kind: "primary".into(),
                group: Some("codex".into()),
                scope: None,
                minutes: Some(300),
                percent: 0.0,
                resets_at: Some(crate::model::now_ms() + 60_000),
            }],
        )
        .unwrap()
    }
    #[test]
    fn restart_replay_and_rebuild_preserve_originals_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut b = batch();
        b.raw = serde_json::json!({"rateLimits":{"credits":{"balance":"12.5"}},"rateLimitResetCredits":{"availableCount":2}});
        store.append(&b).unwrap();
        store.append(&b).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        assert_eq!(
            store.facts(&b.profile.id).unwrap().credits.as_deref(),
            Some("12.5")
        );
        drop(store);
        for name in ["monitor.sqlite", "monitor.sqlite-wal", "monitor.sqlite-shm"] {
            let _ = fs::remove_file(dir.path().join(name));
        }
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        assert_eq!(
            store.latest(&b.profile.id).unwrap().unwrap().1[0].percent,
            0.0
        );
        assert_eq!(store.facts(&b.profile.id).unwrap().free_resets, Some(2));
    }
    #[test]
    fn partial_append_is_retained_and_completed_work_survives() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let b = batch();
        store.append(&b).unwrap();
        drop(store);
        let file = fs::read_dir(dir.path().join("originals"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"{\"killed\":")
            .unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        assert!(
            fs::read_dir(dir.path().join("originals"))
                .unwrap()
                .flatten()
                .any(|e| e.path().extension().is_some_and(|s| s == "partial"))
        );
    }
    #[test]
    fn another_append_repairs_a_killed_tail_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let b = batch();
        store.append(&b).unwrap();
        let file = fs::read_dir(dir.path().join("originals"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"{\"partial\":")
            .unwrap();
        let mut next = b.clone();
        next.id = uuid::Uuid::new_v4().to_string();
        next.at += 1;
        store.append(&next).unwrap();
        assert_eq!(store.count().unwrap(), 2);
        drop(store);
        assert_eq!(Store::open(dir.path()).unwrap().count().unwrap(), 2);
    }
    #[test]
    fn long_window_keeps_latest_data_bounded_and_preserves_hidden_decreases() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut b = batch();
        b.meters[0].minutes = Some(43200);
        let reset = b.meters[0].resets_at.unwrap();
        let start = reset - 43200 * 60_000;
        let tx = store.db.transaction().unwrap();
        for i in 0..8640 {
            let percent = if i < 4300 { 40.0 } else { 10.0 };
            tx.execute(
                "INSERT INTO samples VALUES(?,?,?,?,?,?)",
                params![
                    format!("b{i}"),
                    b.profile.id,
                    b.meters[0].key(),
                    start + i * 300_000,
                    percent,
                    reset
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let points = store.points(&b.profile.id, &b.meters[0]).unwrap();
        assert!(points.len() <= POINT_LIMIT);
        assert_eq!(points.last().unwrap().at, start + 8639 * 300_000);
        assert_eq!(
            points
                .iter()
                .map(|p| p.segment)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            2
        );
    }
    #[test]
    fn a_second_writer_and_demo_live_mixing_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(Store::open(dir.path()).is_err());
        store.mode(true).unwrap();
        assert!(store.mode(false).is_err());
        drop(store);
        for name in ["monitor.sqlite", "monitor.sqlite-wal", "monitor.sqlite-shm"] {
            let _ = fs::remove_file(dir.path().join(name));
        }
        let store = Store::open(dir.path()).unwrap();
        assert!(store.mode(false).is_err());
        assert!(store.mode(true).is_ok());
    }
    #[test]
    fn corrected_observation_is_added_without_rewriting_previous_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let b = batch();
        store.append(&b).unwrap();
        let mut correction = b.clone();
        correction.id = uuid::Uuid::new_v4().to_string();
        correction.at += 1;
        correction.meters[0].percent = 10.0;
        store.append(&correction).unwrap();
        assert_eq!(store.count().unwrap(), 2);
        assert_eq!(
            store.latest(&b.profile.id).unwrap().unwrap().1[0].percent,
            10.0
        );
    }
}
