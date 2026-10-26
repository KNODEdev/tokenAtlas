use crate::{
    model::{Meter, Point, Profile, Provider, Settings, now_ms},
    worker::AccountView,
};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const POINT_LIMIT: usize = 600;
const MAX_JSON: usize = 4 * 1024 * 1024;
#[derive(Deserialize)]
struct Locations {
    version: u32,
    database: PathBuf,
    subscriptions: Vec<Value>,
}
pub struct Register {
    pub database: PathBuf,
    pub root: PathBuf,
    pub profiles: Vec<Profile>,
    db: Connection,
}

pub fn find_root(selected: Option<&Path>) -> Result<PathBuf> {
    if let Some(root) = selected {
        if root.join("scripts/dev/monitor-locations.ts").is_file() {
            return Ok(root.to_owned());
        }
        bail!("Nie znaleziono instalacji tokenAtlas: {}", root.display());
    }
    for start in [
        std::env::current_exe()?.parent().map(Path::to_owned),
        Some(std::env::current_dir()?),
    ]
    .into_iter()
    .flatten()
    {
        for root in start.ancestors() {
            if root.join("scripts/dev/monitor-locations.ts").is_file() {
                return Ok(root.to_owned());
            }
        }
    }
    bail!(
        "Wskaż instalację tokenAtlas przez --atlas-root PATH; monitor wymaga wspólnej bazy z Settings"
    )
}
fn locations(root: &Path) -> Result<Locations> {
    let bin = std::env::var_os("TOKENATLAS_BUN_BIN").unwrap_or_else(|| "bun".into());
    let mut command = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg(root.join("scripts/dev/monitor-locations.ts"))
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Nie można odczytać lokalizacji Settings (Bun)")?;
    let mut stdout = child
        .stdout
        .take()
        .context("Brak odpowiedzi lokalizatora")?;
    let read = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .by_ref()
            .take((MAX_JSON + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                break Err(anyhow::anyhow!(
                    "Przekroczono czas odczytu lokalizacji Settings"
                ));
            }
            Err(e) => break Err(e.into()),
        }
    };
    if !status.as_ref().is_ok_and(|s| s.success()) {
        let _ = child.kill();
    }
    let _ = child.wait();
    let bytes = read
        .join()
        .map_err(|_| anyhow::anyhow!("Błąd lokalizatora Settings"))??;
    if !status?.success() || bytes.len() > MAX_JSON {
        bail!("Nie można odczytać wspólnych lokalizacji i abonamentów Settings");
    }
    let result: Locations = serde_json::from_slice(&bytes)?;
    if result.version != 1 || !result.database.is_absolute() {
        bail!("Nieobsługiwany kontrakt lokalizacji Settings");
    }
    Ok(result)
}
impl Register {
    pub fn data_version(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("PRAGMA data_version", [], |row| row.get(0))?)
    }
    pub fn open(root: Option<&Path>) -> Result<Self> {
        let root = find_root(root)?;
        let config = locations(&root)?;
        Self::from_paths(root, config.database, &config.subscriptions)
    }
    fn from_paths(root: PathBuf, database: PathBuf, subscriptions: &[Value]) -> Result<Self> {
        let db = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .context("Nie można odczytać wspólnej bazy tokenAtlas")?;
        db.busy_timeout(Duration::from_millis(200))?;
        db.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-1024; PRAGMA mmap_size=0;")?;
        for table in ["limit_windows", "limit_window_state"] {
            if !db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
                [table],
                |r| r.get::<_, bool>(0),
            )? {
                bail!("Wspólny rejestr okien nie jest jeszcze przygotowany: {table}");
            }
        }
        let profiles = subscriptions
            .iter()
            .filter_map(|s| {
                let provider = match s["vendor"].as_str()?.trim().to_lowercase().as_str() {
                    "codex" | "openai" => Provider::Codex,
                    "claude" | "anthropic" => Provider::Claude,
                    _ => return None,
                };
                let id = s["id"].as_str()?.to_lowercase();
                if id.contains("::") {
                    return None;
                }
                let label = s["label"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .or(s["account"].as_str())
                    .unwrap_or(&id)
                    .to_owned();
                Some(Profile {
                    id: format!("{}:{id}", provider.name()),
                    provider,
                    home: root.clone(),
                    identity: s["account_key"].as_str().unwrap_or(&id).into(),
                    email: label.contains('@').then(|| label.clone()),
                    label,
                    account_id: Some(id.clone()),
                    organization_id: None,
                    plan: None,
                })
            })
            .collect();
        Ok(Self {
            database,
            root,
            profiles,
            db,
        })
    }
    // This migrates UI selection only. Event ownership is already resolved in the shared register.
    pub fn migrate_selection(&self, settings: &mut Settings, prior: &[Profile]) {
        let resolve = |id: &str| {
            self.profiles
                .iter()
                .find(|p| p.id.eq_ignore_ascii_case(id))
                .or_else(|| {
                    let matches: Vec<_> = self
                        .profiles
                        .iter()
                        .filter(|p| {
                            p.account_id
                                .as_deref()
                                .is_some_and(|a| a.eq_ignore_ascii_case(id))
                        })
                        .collect();
                    (matches.len() == 1).then(|| matches[0])
                })
                .or_else(|| {
                    let old = prior.iter().find(|p| p.id == id)?;
                    let matches: Vec<_> = self
                        .profiles
                        .iter()
                        .filter(|p| {
                            p.provider == old.provider
                                && (p.identity == old.identity
                                    || p.label.eq_ignore_ascii_case(&old.label))
                        })
                        .collect();
                    (matches.len() == 1).then(|| matches[0])
                })
                .map(|p| p.id.clone())
        };
        settings.selected = settings
            .selected
            .iter()
            .map(|id| resolve(id).unwrap_or_else(|| id.clone()))
            .collect();
        if let Some(active) = &settings.active {
            settings.active = resolve(active).or(Some(active.clone()));
        }
        for panel in &mut settings.panels {
            panel.account = resolve(&panel.account).unwrap_or_else(|| panel.account.clone());
        }
    }
    #[cfg(test)]
    pub fn view(&mut self, profile: &Profile, settings: &Settings) -> Result<AccountView> {
        self.view_meter(profile, settings.meters.get(&profile.id))
    }
    pub fn view_meter(
        &mut self,
        profile: &Profile,
        meter_key: Option<&String>,
    ) -> Result<AccountView> {
        let account = profile
            .account_id
            .as_deref()
            .context("Brak tożsamości wspólnego abonamentu")?;
        let tx = self.db.transaction()?;
        let rows = {
            let mut query=tx.prepare("SELECT counter,window_id,start_ts,end_ts,reset_ts,plan,plan_detail,start_drop FROM limit_windows w
                WHERE provider=?1 AND account=?2 AND seq=(SELECT MAX(seq) FROM limit_windows x WHERE x.provider=w.provider AND x.account=w.account AND x.counter=w.counter)
                ORDER BY window_minutes DESC,counter LIMIT 65")?;
            query
                .query_map(params![profile.provider.name(), account], |r| {
                    Ok(Window {
                        counter: r.get(0)?,
                        id: r.get(1)?,
                        start: r.get(2)?,
                        end: r.get(3)?,
                        reset: r.get(4)?,
                        plan: r.get(5)?,
                        detail: r.get(6)?,
                        drop: r.get(7)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if rows.len() > 64 {
            bail!("Zbyt wiele liczników wspólnego abonamentu");
        }
        let mut view = AccountView::default();
        for row in &rows {
            let scope = if profile.provider == Provider::Codex {
                row.counter.as_str()
            } else {
                "*"
            };
            let status:Option<String>=tx.query_row("SELECT status FROM limit_window_state WHERE provider=? AND account=? AND scope=?",params![profile.provider.name(),account,scope],|r|r.get(0)).optional()?;
            if status.as_deref() != Some("ready") {
                let c: Value = serde_json::from_str(&row.counter)?;
                let scope = if c[0].as_str().is_some_and(|s| s.contains("scoped")) {
                    Some("model")
                } else {
                    None
                };
                let key = serde_json::json!([c[0], c[1], scope, c[2]]).to_string();
                if meter_key == Some(&key) {
                    bail!("Wybrane wspólne okno jest przygotowywane");
                }
                continue;
            }
            let counter: Value = serde_json::from_str(&row.counter)?;
            let (at,percent):(Option<String>,Option<f64>)=tx.query_row("SELECT json_extract(value,'$.ts'),json_extract(value,'$.percent') FROM limit_windows w,json_each(w.readings)
                WHERE w.provider=? AND w.account=? AND w.counter=? AND w.window_id=? ORDER BY CAST(json_each.key AS INTEGER) DESC LIMIT 1",
                params![profile.provider.name(),account,row.counter,row.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.unwrap_or((None,None));
            let (Some(at), Some(percent)) = (at, percent) else {
                continue;
            };
            let mut meter = Meter {
                kind: counter[0]
                    .as_str()
                    .context("Niepoprawny licznik wspólnego rejestru")?
                    .into(),
                group: counter[1].as_str().map(str::to_owned),
                scope: None,
                minutes: counter[2].as_i64(),
                percent,
                resets_at: Some(timestamp(&row.reset)?),
            };
            if meter.kind.contains("scoped") {
                meter.scope = Some("model".into());
            }
            meter.validate()?;
            view.meters.push(meter);
            view.meter_times
                .insert(view.meters.last().unwrap().key(), timestamp(&at)?);
        }
        let selected = if let Some(key) = meter_key {
            Some(
                view.meters
                    .iter()
                    .find(|m| m.key() == *key)
                    .context("Wybrany licznik nie ma dostępnych wspólnych odczytów")?,
            )
        } else {
            choose_meter(&view.meters, None)
        };
        if !rows.is_empty() && view.meters.is_empty() {
            let ready:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM limit_window_state WHERE provider=? AND account=? AND status='ready')",params![profile.provider.name(),account],|r|r.get(0))?;
            if !ready {
                bail!("Wspólny rejestr tego abonamentu jest przygotowywany");
            }
        }
        if let Some(meter) = selected {
            let row = rows
                .iter()
                .find(|row| counter_matches(&row.counter, meter))
                .context("Brak wspólnego okna")?;
            view.at = view.meter_times.get(&meter.key()).copied();
            view.facts_at = Some(crate::model::now_ms());
            view.bounds = Some((timestamp(&row.start)?, timestamp(&row.end)?));
            if view.bounds.is_some_and(|(start, end)| end <= start) {
                bail!("Niepoprawne granice wspólnego okna");
            }
            view.baseline = row
                .drop
                .as_ref()
                .map(|s| serde_json::from_str::<Value>(s))
                .transpose()?
                .and_then(|d| d["after"].as_f64());
            if view.baseline.is_none()
                && meter
                    .minutes
                    .zip(meter.resets_at)
                    .is_some_and(|(minutes, reset)| {
                        Some(reset - minutes * 60_000) == view.bounds.map(|b| b.0)
                    })
            {
                view.baseline = Some(0.0);
            }
            view.facts.plan = row
                .detail
                .as_ref()
                .map(|s| serde_json::from_str::<Value>(s))
                .transpose()?
                .and_then(|d| d["label"].as_str().map(str::to_owned))
                .or(row.plan.clone());
            let raw:String=tx.query_row("SELECT readings FROM limit_windows WHERE provider=? AND account=? AND counter=? AND window_id=? AND length(readings)<=?",params![profile.provider.name(),account,row.counter,row.id,MAX_JSON],|r|r.get(0))?;
            let readings: Vec<Reading> = serde_json::from_str(&raw)?;
            if readings.len() > 40_000 {
                bail!("Historia wspólnego okna przekracza limit bezpiecznego odczytu");
            }
            view.source_points = readings.len();
            let mut points = Vec::with_capacity(readings.len());
            let mut segment = 0;
            for r in readings {
                if !r.percent.is_finite() || !(0.0..=100.0).contains(&r.percent) {
                    bail!("Niepoprawny procent w rejestrze");
                }
                let at = timestamp(&r.ts)?;
                if points.last().is_some_and(|p: &Point| at < p.at) {
                    bail!("Niepoprawna kolejność wspólnych odczytów");
                }
                if points.last().is_some_and(|p: &Point| r.percent < p.percent) {
                    segment += 1;
                }
                points.push(Point {
                    at,
                    percent: r.percent,
                    reset: meter.resets_at,
                    segment,
                });
            }
            view.rate_basis = crate::trend::basis(&points, view.bounds, view.baseline);
            view.points.insert(meter.key(), reduce(points, POINT_LIMIT));
            let rail: Option<String> = if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='window_usage')",
                [],
                |r| r.get::<_, bool>(0),
            )? {
                tx.query_row("SELECT rail FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?",params![profile.provider.name(),account,row.counter,row.id],|r|r.get(0)).optional()?
            } else {
                None
            };
            if let Some(rail) = rail {
                let facts: Value = serde_json::from_str(&rail)?;
                view.facts.tokens = facts["tokens"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0);
                view.facts.api_standard = facts["api_standard"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0);
                view.facts.unpriced_tokens = facts["unpriced_tokens"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0);
            }
            view.origin = Some(format!(
                "{}\n{}\n{} → {}\n{} odczytów",
                self.database.display(),
                row.id,
                row.start,
                row.end,
                view.source_points
            ));
        }
        view.account = profile.id.clone();
        tx.commit()?;
        Ok(view)
    }
}
struct Window {
    counter: String,
    id: String,
    start: String,
    end: String,
    reset: String,
    plan: Option<String>,
    detail: Option<String>,
    drop: Option<String>,
}
#[derive(Deserialize)]
struct Reading {
    ts: String,
    percent: f64,
}
fn timestamp(value: &str) -> Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(value)?.timestamp_millis())
}
fn counter_matches(counter: &str, m: &Meter) -> bool {
    serde_json::from_str::<Value>(counter).is_ok_and(|v| {
        v[0].as_str() == Some(&m.kind)
            && v[1].as_str() == m.group.as_deref()
            && v[2].as_i64() == m.minutes
    })
}
pub fn choose_meter<'a>(meters: &'a [Meter], key: Option<&String>) -> Option<&'a Meter> {
    meters
        .iter()
        .find(|m| Some(&m.key()) == key)
        .or_else(|| {
            meters
                .iter()
                .find(|m| m.minutes == Some(10080) && m.scope.is_none())
        })
        .or_else(|| {
            meters
                .iter()
                .find(|m| m.resets_at.is_some_and(|r| r > now_ms()) && m.scope.is_none())
        })
        .or(meters.first())
}
pub(crate) fn reduce(points: Vec<Point>, limit: usize) -> Vec<Point> {
    if points.len() <= limit {
        return points;
    }
    let mut chosen = BTreeMap::new();
    let bins = (limit - 2) / 2;
    for bin in 0..bins {
        let start = bin * points.len() / bins;
        let end = (bin + 1) * points.len() / bins;
        if let Some((lo, _)) = points[start..end]
            .iter()
            .enumerate()
            .min_by(|a, b| a.1.percent.total_cmp(&b.1.percent))
        {
            chosen.insert(start + lo, points[start + lo].clone());
        }
        if let Some((hi, _)) = points[start..end]
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.percent.total_cmp(&b.1.percent))
        {
            chosen.insert(start + hi, points[start + hi].clone());
        }
    }
    chosen.insert(0, points[0].clone());
    chosen.insert(points.len() - 1, points.last().unwrap().clone());
    chosen.into_values().collect()
}

pub fn demo_profiles() -> Vec<Profile> {
    [Provider::Codex, Provider::Claude, Provider::Codex]
        .into_iter()
        .enumerate()
        .map(|(i, provider)| Profile {
            id: format!("demo-{i}"),
            provider,
            home: PathBuf::from("demo"),
            identity: format!("demo:{i}"),
            label: format!("{}@example.com", ["praca", "studio", "osobiste"][i]),
            account_id: None,
            organization_id: None,
            email: Some(format!(
                "{}@example.com",
                ["praca", "studio", "osobiste"][i]
            )),
            plan: None,
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    pub(crate) fn fixture() -> (tempfile::TempDir, Connection, Register) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shared.sqlite");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE limit_windows(provider TEXT,account TEXT,counter TEXT,seq INTEGER,window_id TEXT,start_ts TEXT,end_ts TEXT,reset_ts TEXT,plan TEXT,plan_detail TEXT,start_drop TEXT,window_minutes INTEGER,readings TEXT);
            CREATE TABLE limit_window_state(provider TEXT,account TEXT,scope TEXT,status TEXT);
            CREATE TABLE window_usage(provider TEXT,account TEXT,counter TEXT,window_id TEXT,rail TEXT);").unwrap();
        let counter = "[\"codex\",\"codex\",10080]";
        let readings=(0..1201).map(|i|json!({"ts":crate::model::iso(1_760_512_788_000+i*60_000),"percent":i as f64/15.0,"source":"probe"})).collect::<Vec<_>>();
        db.execute("INSERT INTO limit_windows VALUES('codex','codex1',?,66,'window-66','2025-10-15T06:19:48Z','2025-10-22T06:19:48Z','2025-10-22T06:19:48Z','pro',NULL,NULL,10080,?)",params![counter,serde_json::to_string(&readings).unwrap()]).unwrap();
        db.execute(
            "INSERT INTO limit_window_state VALUES('codex','codex1',?,'ready')",
            [counter],
        )
        .unwrap();
        db.execute(
            "INSERT INTO window_usage VALUES('codex','codex1',?,'window-66',?)",
            params![
                counter,
                json!({"tokens":5000,"api_standard":12.3,"unpriced_tokens":25}).to_string()
            ],
        )
        .unwrap();
        let register = Register::from_paths(
            dir.path().to_owned(),
            file,
            &[json!({"id":"codex1","vendor":"codex","label":"work@example.com"})],
        )
        .unwrap();
        (dir, db, register)
    }
    #[test]
    fn reads_published_history_and_sums_without_a_shadow_register_or_writes() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        let view = shared.view(&profile, &Settings::default()).unwrap();
        assert_eq!(view.source_points, 1201);
        let points = view.points.values().next().unwrap();
        assert!(points.len() <= 600 && points.len() > 2);
        assert_eq!(points.first().unwrap().percent, 0.0);
        assert_eq!(points.last().unwrap().percent, 80.0);
        assert_eq!(view.facts.tokens, Some(5000.0));
        assert_eq!(view.facts.api_standard, Some(12.3));
        assert_eq!(view.facts.unpriced_tokens, Some(25.0));
        assert_eq!(shared.db.total_changes(), 0);
        assert!(shared.db.execute("DELETE FROM limit_windows", []).is_err());
        assert_eq!(
            writer
                .query_row("SELECT count(*) FROM limit_windows", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn shared_correction_and_restart_are_visible_without_rebuilding() {
        let (dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        let _ = shared.view(&profile, &Settings::default()).unwrap();
        writer
            .execute(
                "UPDATE limit_windows SET readings=json_set(readings,'$[1200].percent',81)",
                [],
            )
            .unwrap();
        assert_eq!(
            shared.view(&profile, &Settings::default()).unwrap().meters[0].percent,
            81.0
        );
        let database = shared.database.clone();
        drop(shared);
        let mut restarted = Register::from_paths(
            dir.path().to_owned(),
            database,
            &[json!({"id":"codex1","vendor":"codex"})],
        )
        .unwrap();
        assert_eq!(
            restarted
                .view(&restarted.profiles[0].clone(), &Settings::default())
                .unwrap()
                .meters[0]
                .percent,
            81.0
        );
        assert_eq!(restarted.db.total_changes(), 0);
    }
    #[test]
    fn unprepared_and_missing_history_never_become_zero() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        writer
            .execute("UPDATE limit_window_state SET status='filling'", [])
            .unwrap();
        assert!(shared.view(&profile, &Settings::default()).is_err());
        writer
            .execute("UPDATE limit_window_state SET status='ready'", [])
            .unwrap();
        writer
            .execute("UPDATE limit_windows SET readings='[]'", [])
            .unwrap();
        let view = shared.view(&profile, &Settings::default()).unwrap();
        assert!(view.at.is_none() && view.meters.is_empty() && view.facts.tokens.is_none());
    }
    #[test]
    fn migration_changes_selection_not_the_shared_account_ids() {
        let (_dir, _writer, shared) = fixture();
        let mut old = demo_profiles().remove(0);
        old.id = "old-auth-id".into();
        old.label = "work@example.com".into();
        let mut settings = Settings {
            selected: vec![old.id.clone()],
            active: Some(old.id.clone()),
            ..Default::default()
        };
        shared.migrate_selection(&mut settings, &[old]);
        assert_eq!(settings.selected, vec!["codex:codex1"]);
        assert_eq!(settings.active.as_deref(), Some("codex:codex1"));
        assert_eq!(shared.profiles[0].account_id.as_deref(), Some("codex1"));
    }
    #[test]
    fn optional_unready_counter_does_not_hide_the_ready_weekly_window() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        writer.execute("INSERT INTO limit_windows SELECT provider,account,'[\"codex\",\"codex\",300]',1,'short',start_ts,end_ts,reset_ts,plan,plan_detail,start_drop,300,readings FROM limit_windows",[]).unwrap();
        writer.execute("INSERT INTO limit_window_state VALUES('codex','codex1','[\"codex\",\"codex\",300]','filling')",[]).unwrap();
        assert_eq!(
            shared
                .view(&profile, &Settings::default())
                .unwrap()
                .source_points,
            1201
        );
        let mut settings = Settings::default();
        settings
            .meters
            .insert(profile.id.clone(), "[\"codex\",\"codex\",null,300]".into());
        assert!(shared.view(&profile, &settings).is_err());
    }
    #[test]
    fn independent_shared_windows_keep_their_own_history_facts_and_corrections() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        let short = "[\"codex\",\"codex\",null,300]".to_string();
        assert!(shared.view_meter(&profile, Some(&short)).is_err());
        writer.execute("INSERT INTO limit_windows SELECT provider,account,'[\"codex\",\"codex\",300]',1,'short','2025-10-17T06:19:48Z','2025-10-17T11:19:48Z','2025-10-17T11:19:48Z',plan,plan_detail,NULL,300,? FROM limit_windows LIMIT 1",[json!([
            {"ts":"2025-10-17T06:19:48Z","percent":0,"source":"probe"},
            {"ts":"2025-10-17T07:19:48Z","percent":50,"source":"probe"}
        ]).to_string()]).unwrap();
        writer.execute("INSERT INTO limit_window_state VALUES('codex','codex1','[\"codex\",\"codex\",300]','ready')",[]).unwrap();
        writer.execute("INSERT INTO window_usage VALUES('codex','codex1','[\"codex\",\"codex\",300]','short','{\"tokens\":100,\"api_standard\":1}')",[]).unwrap();
        let weekly = "[\"codex\",\"codex\",null,10080]".to_string();
        let long = shared.view_meter(&profile, Some(&weekly)).unwrap();
        let short_view = shared.view_meter(&profile, Some(&short)).unwrap();
        assert_eq!(long.account, short_view.account);
        assert_ne!(long.bounds, short_view.bounds);
        assert_eq!(long.source_points, 1201);
        assert_eq!(short_view.source_points, 2);
        assert_eq!(long.facts.tokens, Some(5000.0));
        assert_eq!(short_view.facts.tokens, Some(100.0));
        writer.execute("UPDATE limit_windows SET readings=json_set(readings,'$[1].percent',60) WHERE window_id='short'",[]).unwrap();
        assert_eq!(
            shared
                .view_meter(&profile, Some(&weekly))
                .unwrap()
                .meters
                .iter()
                .find(|m| m.key() == weekly)
                .unwrap()
                .percent,
            80.0
        );
        let fixed = shared.view_meter(&profile, Some(&short)).unwrap();
        assert_eq!(
            fixed
                .meters
                .iter()
                .find(|m| m.key() == short)
                .unwrap()
                .percent,
            60.0
        );
        writer
            .execute(
                "UPDATE limit_windows SET readings='[]' WHERE window_id='short'",
                [],
            )
            .unwrap();
        assert!(shared.view_meter(&profile, Some(&short)).is_err());
        assert_eq!(shared.db.total_changes(), 0);
    }
    #[test]
    fn provider_namespaces_and_account_case_preserve_identity() {
        let (dir, _writer, shared) = fixture();
        let source = Register::from_paths(
            dir.path().to_owned(),
            shared.database.clone(),
            &[
                json!({"id":"CODEX1","vendor":" OpenAI "}),
                json!({"id":"codex1","vendor":"Anthropic"}),
            ],
        )
        .unwrap();
        assert_eq!(source.profiles[0].id, "codex:codex1");
        assert_eq!(source.profiles[1].id, "claude:codex1");
        assert_eq!(source.profiles[0].account_id.as_deref(), Some("codex1"));
    }
    #[test]
    fn decreases_are_classified_before_point_reduction() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        writer
            .execute(
                "UPDATE limit_windows SET readings=json_set(readings,'$[700].percent',1)",
                [],
            )
            .unwrap();
        let view = shared.view(&profile, &Settings::default()).unwrap();
        let points = view.points.values().next().unwrap();
        assert!(points.windows(2).any(|p| p[0].segment != p[1].segment));
        assert!(points.len() <= 600);
    }
    #[test]
    fn missing_readings_join_existing_points_without_adding_observations() {
        let (_dir, writer, mut shared) = fixture();
        let readings=(0..1201).map(|i|json!({
            "ts":crate::model::iso(1_760_512_788_000+i*60_000+if i>=600 {21_600_000} else {0}),
            "percent":i as f64/15.0,"source":"probe"
        })).collect::<Vec<_>>();
        writer
            .execute(
                "UPDATE limit_windows SET readings=?",
                [serde_json::to_string(&readings).unwrap()],
            )
            .unwrap();
        let view = shared
            .view(&shared.profiles[0].clone(), &Settings::default())
            .unwrap();
        let points = view.points.values().next().unwrap();
        assert_eq!(view.source_points, 1201);
        assert!(points.len() <= 600);
        assert_eq!(
            crate::model::segments_in(points, &view.meters[0], view.bounds).len(),
            1
        );
        assert_eq!(shared.db.total_changes(), 0);
    }
    #[test]
    fn shifted_start_without_drop_never_invents_a_zero_baseline() {
        let (_dir, writer, mut shared) = fixture();
        let profile = shared.profiles[0].clone();
        assert_eq!(
            shared
                .view(&profile, &Settings::default())
                .unwrap()
                .baseline,
            Some(0.0)
        );
        writer.execute("UPDATE limit_windows SET start_ts='2025-10-15T07:19:48Z',readings=json_set(readings,'$[0].percent',30)",[]).unwrap();
        assert_eq!(
            shared
                .view(&profile, &Settings::default())
                .unwrap()
                .baseline,
            None
        );
        writer
            .execute(
                "UPDATE limit_windows SET start_drop='{\"before\":80,\"after\":30}'",
                [],
            )
            .unwrap();
        assert_eq!(
            shared
                .view(&profile, &Settings::default())
                .unwrap()
                .baseline,
            Some(30.0)
        );
    }
}
