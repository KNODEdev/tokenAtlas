use crate::{
    common,
    model::{AccountFacts, Batch, Meter, PanelChoice, Point, Profile, Settings, now_ms},
    store::Store,
    trend,
};
use anyhow::{Result, anyhow};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

const REGISTER_CHECK: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct AccountView {
    pub account: String,
    pub bounds: Option<(i64, i64)>,
    pub baseline: Option<f64>,
    pub rate_basis: Option<trend::Basis>,
    pub meter_times: BTreeMap<String, i64>,
    pub source_points: usize,
    pub origin: Option<String>,
    pub facts: AccountFacts,
    pub facts_at: Option<i64>,
    pub at: Option<i64>,
    pub meters: Vec<Meter>,
    pub points: BTreeMap<String, Vec<Point>>,
    pub error: Option<String>,
}
#[derive(Clone, Default)]
pub struct Snapshot {
    pub profiles: Vec<Profile>,
    // The stable panel ID keeps independent windows of one subscription separate.
    pub accounts: BTreeMap<String, AccountView>,
    pub busy: bool,
    pub next_at: Option<i64>,
    pub error: Option<String>,
}
pub enum Command {
    Configure(Settings),
    Refresh,
    Discover,
    Stop,
}
pub struct Worker {
    pub tx: mpsc::Sender<Command>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}
impl Worker {
    pub fn start(
        store: Store,
        mut settings: Settings,
        demo: bool,
        ctx: egui::Context,
        initial: Option<common::Register>,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        let output = snapshot.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let handle = std::thread::spawn(move || {
            let mut register = initial;
            let mut state = Snapshot::default();
            let mut force_read = true;
            let mut last_version = None;
            let mut retry_at = None;
            let mut retry_delay = REGISTER_CHECK;
            let mut next_collection = Instant::now();
            let mut main_process: Option<crate::collector::MainProcess> = None;
            let mut tips = crate::collector::Tips::default();
            let mut collection_error = None;
            let mut register_error = None;
            let mut account_errors = Vec::<crate::collector::AccountError>::new();
            let mut force_collection = false;
            let mut next_discovery =
                Instant::now() + Duration::from_secs(settings.interval_minutes * 60);
            let publish = |state: &Snapshot| {
                *output.lock().unwrap_or_else(|e| e.into_inner()) = state.clone();
                ctx.request_repaint();
            };
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }
                if retry_at.is_some_and(|at| Instant::now() >= at) {
                    retry_at = None;
                    force_read = true;
                }
                if Instant::now() >= next_discovery {
                    register = None;
                    next_discovery =
                        Instant::now() + Duration::from_secs(settings.interval_minutes * 60);
                    force_read = true;
                }
                let version = register
                    .as_ref()
                    .map(common::Register::data_version)
                    .transpose();
                let changed = match version {
                    Ok(version) => force_read || version != last_version,
                    Err(ref error) => {
                        register_error = Some(error.to_string());
                        state.error = collection_error.clone().or(register_error.clone());
                        force_read = true;
                        publish(&state);
                        false
                    }
                };
                if changed {
                    state.busy = true;
                    state.error = None;
                    publish(&state);
                    if demo {
                        state.profiles = common::demo_profiles();
                    } else {
                        if register.is_none() {
                            match common::Register::open(settings.atlas_root.as_deref()) {
                                Ok(shared) => {
                                    match store.known_profiles() {
                                        Ok(prior) => {
                                            shared.migrate_selection(&mut settings, &prior)
                                        }
                                        Err(e) => state.error = Some(e.to_string()),
                                    }
                                    settings.atlas_root = Some(shared.root.clone());
                                    if let Err(e) = store.save_settings(&settings) {
                                        state.error = Some(e.to_string());
                                    }
                                    register = Some(shared);
                                }
                                Err(e) => state.error = Some(e.to_string()),
                            }
                        }
                        if let Some(shared) = &register {
                            state.profiles = shared.profiles.clone();
                        }
                    }
                    let retry = load_panels(&store, &settings, &mut state, register.as_mut(), demo);
                    register_error = state.error.clone();
                    apply_collected(&settings, &mut state, &tips, &account_errors);
                    state.error = collection_error.clone().or(register_error.clone());
                    state.busy = false;
                    state.next_at = Some(now_ms() + (settings.interval_minutes * 60_000) as i64);
                    publish(&state);
                    // Remember the revision from before the read: a concurrent commit must be read next turn.
                    last_version = version.unwrap_or(None);
                    force_read = false;
                    if retry {
                        retry_at = Some(Instant::now() + retry_delay);
                        retry_delay = (retry_delay * 2).min(Duration::from_secs(60));
                    } else if !demo && register.is_none() {
                        retry_at = Some(Instant::now() + Duration::from_secs(60));
                    } else {
                        retry_delay = REGISTER_CHECK;
                    }
                }
                if main_process.as_ref().is_some_and(|main| !main.alive()) {
                    main_process = None;
                    next_collection = Instant::now();
                }
                let collect_due =
                    force_collection || main_process.is_none() && Instant::now() >= next_collection;
                if !demo
                    && collect_due
                    && let Some(shared) = register.as_ref()
                    && shared.root.join("scripts/dev/monitor-gauges.ts").is_file()
                {
                    state.busy = true;
                    publish(&state);
                    let accounts: Vec<_> = settings
                        .panels
                        .iter()
                        .map(|p| p.account.clone())
                        .collect::<std::collections::BTreeSet<_>>()
                        .into_iter()
                        .collect();
                    match crate::collector::collect(
                        &shared.root,
                        &accounts,
                        settings.interval_minutes,
                        force_collection,
                        &cancelled,
                    ) {
                        Ok(reply) => {
                            main_process =
                                reply.main_pid.and_then(crate::collector::MainProcess::open);
                            for tip in reply.tips {
                                tips.insert(tip);
                            }
                            account_errors = reply.errors;
                            collection_error = reply.error;
                            next_collection = Instant::now()
                                + Duration::from_secs(if reply.handoff || reply.pending > 0 {
                                    60
                                } else {
                                    settings.interval_minutes * 60
                                });
                        }
                        Err(error) => {
                            collection_error = Some(error.to_string());
                            next_collection = Instant::now() + Duration::from_secs(60);
                        }
                    }
                    force_collection = false;
                    apply_collected(&settings, &mut state, &tips, &account_errors);
                    state.error = collection_error.clone().or(register_error.clone());
                    state.busy = false;
                    publish(&state);
                }
                match rx.recv_timeout(REGISTER_CHECK) {
                    Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(Command::Configure(next)) => match store.save_settings(&next) {
                        Ok(()) => {
                            let before: std::collections::BTreeSet<_> =
                                settings.panels.iter().map(|p| &p.account).collect();
                            let after: std::collections::BTreeSet<_> =
                                next.panels.iter().map(|p| &p.account).collect();
                            force_collection = before != after;
                            tips.retain_accounts(&after);
                            account_errors.retain(|error| after.contains(&error.account));
                            if settings.atlas_root != next.atlas_root {
                                register = None;
                                state.accounts.clear();
                                state.profiles.clear();
                                main_process = None;
                                tips = crate::collector::Tips::default();
                                collection_error = None;
                                account_errors.clear();
                                force_collection = true;
                            }
                            settings = next;
                            next_discovery = Instant::now()
                                + Duration::from_secs(settings.interval_minutes * 60);
                            state.error = None;
                            register_error = None;
                            force_read = true;
                        }
                        Err(e) => {
                            state.error = Some(e.to_string());
                            publish(&state);
                        }
                    },
                    Ok(Command::Refresh) | Ok(Command::Discover) => {
                        register = None;
                        state.error = None;
                        register_error = None;
                        force_read = true;
                        force_collection = true;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        Self {
            tx,
            snapshot,
            stop,
            handle: Some(handle),
        }
    }
}
fn apply_collected(
    settings: &Settings,
    state: &mut Snapshot,
    tips: &crate::collector::Tips,
    errors: &[crate::collector::AccountError],
) {
    for panel in &settings.panels {
        let view = state.accounts.entry(panel.id.clone()).or_default();
        tips.apply(view, &panel.account, panel.meter.as_ref());
        if let Some(error) = errors
            .iter()
            .find(|error| error.account == panel.account)
            .and_then(|error| error.error.as_ref())
        {
            view.error = Some(error.clone());
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.tx.send(Command::Stop);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
fn load_panels(
    store: &Store,
    settings: &Settings,
    state: &mut Snapshot,
    mut register: Option<&mut common::Register>,
    demo: bool,
) -> bool {
    let mut retry = false;
    state
        .accounts
        .retain(|id, _| settings.panels.iter().any(|p| p.id == *id));
    let mut memo = BTreeMap::<(String, Option<String>), AccountView>::new();
    for panel in &settings.panels {
        let key = (panel.account.clone(), panel.meter.clone());
        let result = if let Some(cached) = memo.get(&key) {
            Ok(cached.clone())
        } else {
            match state.profiles.iter().find(|p| p.id == panel.account) {
                Some(profile) if demo => read_demo(store, profile, panel),
                Some(profile) => register
                    .as_mut()
                    .ok_or_else(|| anyhow!("Brak wspólnej bazy"))
                    .and_then(|shared| shared.view_meter(profile, panel.meter.as_ref())),
                None => Err(anyhow!("Abonament jest niedostępny w Settings tokenAtlas")),
            }
        };
        match result {
            Ok(view) => {
                memo.insert(key, view.clone());
                state.accounts.insert(panel.id.clone(), view);
            }
            Err(e) => {
                retry |= matches!(
                    e.downcast_ref::<rusqlite::Error>(),
                    Some(rusqlite::Error::SqliteFailure(code, _))
                        if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy
                            | rusqlite::ErrorCode::DatabaseLocked
                            | rusqlite::ErrorCode::SystemIoFailure
                            | rusqlite::ErrorCode::CannotOpen)
                );
                let view = state.accounts.entry(panel.id.clone()).or_default();
                if view.account.is_empty() {
                    view.account = panel.account.clone();
                }
                view.error = Some(e.to_string());
            }
        }
    }
    retry
}
fn read_demo(store: &Store, profile: &Profile, panel: &PanelChoice) -> Result<AccountView> {
    let mut view = AccountView {
        account: profile.id.clone(),
        facts: store.facts(&profile.id)?,
        ..Default::default()
    };
    if let Some((at, meters)) = store.latest(&profile.id)? {
        view.at = Some(at);
        view.meters = meters;
        let selected = if let Some(key) = panel.meter.as_ref() {
            Some(
                view.meters
                    .iter()
                    .find(|m| m.key() == *key)
                    .ok_or_else(|| anyhow!("Brak wybranego licznika"))?,
            )
        } else {
            common::choose_meter(&view.meters, None)
        };
        if let Some(meter) = selected {
            let points = store.points(&profile.id, meter)?;
            view.bounds = meter
                .resets_at
                .zip(meter.minutes)
                .map(|(reset, minutes)| (reset - minutes * 60_000, reset));
            view.baseline = Some(0.0);
            view.rate_basis = trend::basis(&points, view.bounds, view.baseline);
            view.source_points = points.len();
            view.points.insert(meter.key(), points);
        }
    }
    Ok(view)
}
pub fn seed_demo(store: &mut Store, settings: &mut Settings) -> Result<()> {
    if store.count()? != 0 {
        return Ok(());
    }
    let profiles = common::demo_profiles();
    let now = now_ms();
    let reset = now + 60 * 60_000;
    let week = 10080 * 60_000;
    let elapsed = week * 37 / 100;
    for (index, profile) in profiles.iter().enumerate() {
        for step in 0..=96 {
            let at = now - elapsed + elapsed * step / 96;
            let percent =
                ([80.0, 39.0, 92.0][index] * (step as f64 / 96.0).powf(0.8) * 10.0).round() / 10.0;
            let kind = if profile.provider == crate::model::Provider::Codex {
                "primary"
            } else {
                "session"
            };
            let mut batch = Batch::new(
                profile,
                if profile.provider == crate::model::Provider::Codex {
                    serde_json::json!({"demo":true,"rateLimits":{"planType":"pro","credits":{"balance":"58.86"}},"rateLimitResetCredits":{"availableCount":2}})
                } else {
                    serde_json::json!({"demo":true})
                },
                {
                    let mut meters = vec![Meter {
                        kind: "weekly_all".into(),
                        group: Some(profile.provider.name().into()),
                        scope: None,
                        minutes: Some(10080),
                        percent,
                        resets_at: Some(now + week - elapsed),
                    }];
                    if at >= now - 4 * 60 * 60_000 {
                        meters.push(Meter {
                            kind: kind.into(),
                            group: Some(profile.provider.name().into()),
                            scope: None,
                            minutes: Some(300),
                            percent: [68.0, 39.0, 92.0][index]
                                * (at - (now - 4 * 60 * 60_000)) as f64
                                / (4 * 60 * 60_000) as f64,
                            resets_at: Some(reset),
                        });
                    }
                    if step == 96 {
                        settings.meters.insert(profile.id.clone(), meters[0].key());
                    }
                    meters
                },
            )?;
            batch.at = at;
            store.append(&batch)?;
        }
    }
    settings.selected = profiles.iter().map(|p| p.id.clone()).collect();
    store.save_settings(settings)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_commits_reach_an_open_widget_without_waiting_for_profile_discovery() {
        let (_source, db, register) = crate::common::tests::fixture();
        let preferences = tempfile::tempdir().unwrap();
        let store = Store::open_settings(preferences.path()).unwrap();
        let mut settings = Settings {
            selected: vec![register.profiles[0].id.clone()],
            interval_minutes: 120,
            ..Default::default()
        };
        settings.ensure_panels(&register.profiles);
        let panel = settings.panels[0].id.clone();
        let worker = Worker::start(
            store,
            settings,
            false,
            egui::Context::default(),
            Some(register),
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        while worker.snapshot.lock().unwrap().accounts.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let before = worker.snapshot.lock().unwrap().accounts[&panel].at.unwrap();
        let at = before + 60_000;
        let point = serde_json::json!({"ts":crate::model::iso(at),"percent":81.0,"source":"probe"});
        db.execute(
            "UPDATE limit_windows SET readings=json_insert(readings,'$[#]',json(?))",
            [point.to_string()],
        )
        .unwrap();
        while worker.snapshot.lock().unwrap().accounts[&panel].at != Some(at)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let state = worker.snapshot.lock().unwrap();
        assert_eq!(state.accounts[&panel].at, Some(at));
        assert_eq!(state.accounts[&panel].meters[0].percent, 81.0);
    }
    #[test]
    fn two_windows_of_one_account_remain_independent_and_reload_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut settings = Settings::default();
        seed_demo(&mut store, &mut settings).unwrap();
        let profile = common::demo_profiles().remove(0);
        let meters = store.latest(&profile.id).unwrap().unwrap().1;
        settings.panels = meters
            .iter()
            .map(|m| PanelChoice::new(profile.id.clone(), Some(m.key())))
            .collect();
        store.save_settings(&settings).unwrap();
        let mut state = Snapshot {
            profiles: common::demo_profiles(),
            ..Default::default()
        };
        load_panels(&store, &settings, &mut state, None, true);
        assert_eq!(state.accounts.len(), 2);
        let before = state
            .accounts
            .iter()
            .map(|(id, v)| {
                (
                    id.clone(),
                    (v.bounds, v.points.keys().cloned().collect::<Vec<_>>()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_ne!(
            before[&settings.panels[0].id],
            before[&settings.panels[1].id]
        );
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        let settings = store.settings().unwrap();
        load_panels(&store, &settings, &mut state, None, true);
        let after = state
            .accounts
            .iter()
            .map(|(id, v)| {
                (
                    id.clone(),
                    (v.bounds, v.points.keys().cloned().collect::<Vec<_>>()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(before, after);
        settings.validate().unwrap();
    }
    #[test]
    fn failed_account_or_counter_switch_retains_the_actual_source_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut settings = Settings::default();
        seed_demo(&mut store, &mut settings).unwrap();
        settings.ensure_panels(&common::demo_profiles());
        let mut state = Snapshot {
            profiles: common::demo_profiles(),
            ..Default::default()
        };
        load_panels(&store, &settings, &mut state, None, true);
        let id = settings.panels[0].id.clone();
        let source = state.accounts[&id].account.clone();
        let old_keys = state.accounts[&id]
            .points
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        settings.panels[0].meter = Some("missing".into());
        load_panels(&store, &settings, &mut state, None, true);
        assert!(state.accounts[&id].error.is_some());
        assert_eq!(
            state.accounts[&id]
                .points
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            old_keys
        );
        settings.panels[0].account = "unavailable".into();
        load_panels(&store, &settings, &mut state, None, true);
        assert_eq!(state.accounts[&id].account, source);
        assert!(state.accounts[&id].error.is_some());
    }
}
