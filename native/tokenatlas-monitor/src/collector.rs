use crate::model::{AccountFacts, Meter};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Tips(BTreeMap<(String, String), Vec<Tip>>);
impl Tips {
    pub fn retain_accounts(&mut self, accounts: &std::collections::BTreeSet<&String>) {
        self.0.retain(|(account, _), _| accounts.contains(account));
    }
    pub fn insert(&mut self, tip: Tip) {
        let key = (tip.account.clone(), tip.meter.key());
        if !self.0.contains_key(&key)
            && self.0.keys().filter(|(a, _)| a == &tip.account).count() >= 64
        {
            return;
        }
        let list = self.0.entry(key).or_default();
        if let Some(last) = list.last() {
            if last.counter_id == tip.counter_id || tip.at <= last.at {
                return;
            }
            if !same_reset(&last.meter, &tip.meter, tip.reset_tolerance_ms)
                || tip.meter.percent < last.meter.percent
            {
                list.clear();
            }
        }
        list.push(tip);
        if list.len() > crate::common::POINT_LIMIT {
            list.remove(1);
        }
        while self.0.values().map(Vec::len).sum::<usize>() > 4_800 {
            if let Some(list) = self.0.values_mut().max_by_key(|list| list.len()) {
                list.remove(1);
            }
        }
    }
    pub fn apply(
        &self,
        view: &mut crate::worker::AccountView,
        account: &str,
        requested: Option<&String>,
    ) {
        let key = requested
            .cloned()
            .or_else(|| view.points.keys().next().cloned())
            .or_else(|| {
                self.0
                    .iter()
                    .find(|((a, _), tips)| {
                        a == account
                            && tips
                                .first()
                                .is_some_and(|tip| tip.meter.minutes == Some(10080))
                    })
                    .map(|((_, k), _)| k.clone())
            })
            .or_else(|| {
                self.0
                    .keys()
                    .find(|(a, _)| a == account)
                    .map(|(_, k)| k.clone())
            });
        let Some(list) = key
            .as_ref()
            .and_then(|key| self.0.get(&(account.to_owned(), key.clone())))
        else {
            return;
        };
        if view.account != account {
            *view = crate::worker::AccountView {
                account: account.into(),
                ..Default::default()
            };
        }
        for tip in list {
            if view.at.is_some_and(|at| tip.at <= at) {
                continue;
            }
            let compatible = view
                .meters
                .iter()
                .find(|m| m.key() == tip.meter.key())
                .is_some_and(|m| {
                    same_reset(m, &tip.meter, tip.reset_tolerance_ms)
                        && tip.meter.percent >= m.percent
                });
            if !compatible {
                view.points.clear();
                view.bounds = None;
                view.baseline = None;
                view.rate_basis = None;
                view.facts = tip.facts.clone();
                view.facts_at = None;
                view.source_points = 0;
            }
            let points = view.points.entry(tip.meter.key()).or_default();
            let segment = points.last().map_or(0, |point| point.segment);
            points.push(crate::model::Point {
                at: tip.at,
                percent: tip.meter.percent,
                reset: tip.meter.resets_at,
                segment,
            });
            if points.len() > crate::common::POINT_LIMIT {
                let points = std::mem::take(points);
                view.points.insert(
                    tip.meter.key(),
                    crate::common::reduce(points, crate::common::POINT_LIMIT),
                );
            }
            if view.rate_basis.is_none() {
                view.rate_basis =
                    crate::trend::basis(&view.points[&tip.meter.key()], view.bounds, view.baseline);
            }
            view.meters.retain(|m| m.key() != tip.meter.key());
            view.meters.push(tip.meter.clone());
            view.at = Some(tip.at);
            view.meter_times.insert(tip.meter.key(), tip.at);
            view.source_points += 1;
            view.origin = Some(format!(
                "Wspólny dziennik procentów · {}\nHistoria i sumy: opublikowany rejestr tokenAtlas",
                tip.counter_id
            ));
            view.error = None;
        }
    }
}
fn same_reset(left: &Meter, right: &Meter, tolerance: i64) -> bool {
    left.resets_at
        .zip(right.resets_at)
        .is_some_and(|(a, b)| a.abs_diff(b) <= tolerance as u64)
}

#[derive(Clone, Deserialize)]
pub struct Tip {
    pub account: String,
    pub at: i64,
    pub counter_id: String,
    pub meter: Meter,
    pub facts: AccountFacts,
    pub reset_tolerance_ms: i64,
}
#[derive(Deserialize)]
pub struct AccountError {
    pub account: String,
    pub error: Option<String>,
}
#[derive(Deserialize)]
pub struct Reply {
    version: u32,
    pub main_pid: Option<u32>,
    pub handoff: bool,
    pub tips: Vec<Tip>,
    pub errors: Vec<AccountError>,
    pub error: Option<String>,
    pub pending: usize,
}

#[cfg(windows)]
struct Handle(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
pub struct MainProcess {
    #[cfg(windows)]
    handle: Handle,
    #[cfg(unix)]
    pid: u32,
}
impl MainProcess {
    pub fn open(pid: u32) -> Option<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            (!handle.is_null()).then_some(Self {
                handle: Handle(handle),
            })
        }
        #[cfg(unix)]
        {
            Some(Self { pid })
        }
    }
    pub fn alive(&self) -> bool {
        #[cfg(windows)]
        {
            let mut code = 0;
            unsafe {
                windows_sys::Win32::System::Threading::GetExitCodeProcess(self.handle.0, &mut code)
                    != 0
                    && code == 259
            }
        }
        #[cfg(unix)]
        {
            unsafe { libc::kill(self.pid as i32, 0) == 0 }
        }
    }
}

struct ProcessGroup {
    #[cfg(windows)]
    job: Handle,
    #[cfg(unix)]
    pid: u32,
}
impl ProcessGroup {
    fn attach(child: &mut Child) -> Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let job = Handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
            if job.0.is_null() {
                let _ = child.kill();
                let _ = child.wait();
                bail!("Nie można zabezpieczyć procesu kolektora");
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job.0, child.as_raw_handle() as _) == 0
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    bail!("Nie można zabezpieczyć potomków kolektora");
                }
            }
            Ok(Self { job })
        }
        #[cfg(unix)]
        {
            Ok(Self { pid: child.id() })
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let _ = &self.job;
        }
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
    }
}

pub fn collect(
    root: &Path,
    accounts: &[String],
    interval: u64,
    force: bool,
    cancelled: &AtomicBool,
) -> Result<Reply> {
    let binary = std::env::var_os("TOKENATLAS_BUN_BIN").unwrap_or_else(|| "bun".into());
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .arg(root.join("scripts/dev/monitor-gauges.ts"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Nie można uruchomić wspólnego kolektora (Bun)")?;
    let group = ProcessGroup::attach(&mut child)?;
    let request = serde_json::json!({"version":1,"accounts":accounts,"interval_minutes":interval,"force":force});
    let input = child.stdin.take().context("Brak wejścia kolektora")?;
    let mut output = child.stdout.take().context("Brak wyjścia kolektora")?;
    let mut errors = child.stderr.take().context("Brak diagnostyki kolektora")?;
    let read = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let diagnostics = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        errors
            .by_ref()
            .take(16 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    // No provider can start until after the job/group owns every child.
    let sent = (|| -> Result<()> {
        let mut input = input;
        serde_json::to_writer(&mut input, &request)?;
        input.flush()?;
        Ok(())
    })();
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if sent.is_err() || cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
            let _ = child.kill();
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                break None;
            }
        }
    };
    let _ = child.wait();
    drop(group);
    let bytes = read
        .join()
        .map_err(|_| anyhow::anyhow!("Błąd odpowiedzi kolektora"))??;
    let _ = diagnostics.join();
    if status.is_none_or(|status| !status.success()) || bytes.len() > 4 * 1024 * 1024 {
        bail!("Kolektor przerwany lub niedostępny; poprzedni pomiar zachowany");
    }
    let reply: Reply =
        serde_json::from_slice(&bytes).context("Niepoprawna odpowiedź wspólnego kolektora")?;
    if reply.version != 1 || reply.tips.len() > 1024 {
        bail!("Nieobsługiwana odpowiedź kolektora");
    }
    for tip in &reply.tips {
        tip.meter.validate()?;
        if tip.reset_tolerance_ms < 0 || tip.reset_tolerance_ms > 120_000 {
            bail!("Niepoprawna tolerancja resetu");
        }
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Point, worker::AccountView};
    fn tip(at: i64, percent: f64, reset: i64) -> Tip {
        Tip {
            account: "claude:seat".into(),
            at,
            counter_id: format!("counter-{at}"),
            meter: Meter {
                kind: "weekly_all".into(),
                group: Some("weekly".into()),
                scope: None,
                minutes: Some(10080),
                percent,
                resets_at: Some(reset),
            },
            facts: AccountFacts::default(),
            reset_tolerance_ms: 60_000,
        }
    }
    #[test]
    fn compatible_tip_extends_published_history_and_keeps_its_original_anchor() {
        let first = tip(1000, 10.0, 1_000_000);
        let key = first.meter.key();
        let mut view = AccountView {
            account: first.account.clone(),
            at: Some(1000),
            meters: vec![first.meter.clone()],
            points: BTreeMap::from([(
                key.clone(),
                vec![Point {
                    at: 1000,
                    percent: 10.0,
                    reset: first.meter.resets_at,
                    segment: 2,
                }],
            )]),
            rate_basis: Some(crate::trend::Basis {
                at: 0,
                percent: 5.0,
                whole_window: false,
            }),
            facts: AccountFacts {
                tokens: Some(123.0),
                ..Default::default()
            },
            facts_at: Some(1000),
            ..Default::default()
        };
        let mut tips = Tips::default();
        tips.insert(tip(2000, 40.0, 1_000_000));
        tips.apply(&mut view, "claude:seat", Some(&key));
        assert_eq!(view.at, Some(2000));
        assert_eq!(view.points[&key].len(), 2);
        assert_eq!(view.points[&key][1].segment, 2);
        assert_eq!(view.rate_basis.unwrap().percent, 5.0);
        assert_eq!(view.facts.tokens, Some(123.0));
        assert_eq!(view.facts_at, Some(1000));
        tips.apply(&mut view, "claude:seat", Some(&key));
        assert_eq!(view.points[&key].len(), 2);
    }
    #[test]
    fn new_reset_or_drop_discards_old_window_sums_and_never_invents_a_zero_baseline() {
        for reset in [1_000_000, 2_000_000] {
            let old = tip(1000, 97.0, 1_000_000);
            let key = old.meter.key();
            let mut view = AccountView {
                account: old.account.clone(),
                at: Some(1000),
                meters: vec![old.meter],
                facts: AccountFacts {
                    tokens: Some(123.0),
                    ..Default::default()
                },
                facts_at: Some(1000),
                bounds: Some((0, 1_000_000)),
                baseline: Some(0.0),
                ..Default::default()
            };
            let mut tips = Tips::default();
            tips.insert(tip(2000, 1.0, reset));
            tips.insert(tip(3000, 7.0, reset));
            tips.apply(&mut view, "claude:seat", Some(&key));
            assert_eq!(view.meters[0].percent, 7.0);
            assert_eq!(view.points[&key].len(), 2);
            assert!(view.facts.tokens.is_none());
            assert!(view.bounds.is_none());
            assert!(view.baseline.is_none());
            let basis = view.rate_basis.unwrap();
            assert_eq!(
                (basis.at, basis.percent, basis.whole_window),
                (2000, 1.0, false)
            );
        }
    }
    #[test]
    fn authoritative_register_catchup_or_correction_wins_over_the_same_old_tip() {
        let current = tip(2000, 3.0, 2_000_000);
        let key = current.meter.key();
        let mut view = AccountView {
            account: current.account.clone(),
            at: Some(2000),
            meters: vec![current.meter],
            ..Default::default()
        };
        let mut tips = Tips::default();
        tips.insert(tip(2000, 1.0, 2_000_000));
        tips.apply(&mut view, "claude:seat", Some(&key));
        assert_eq!(view.meters[0].percent, 3.0);
        assert!(view.points.is_empty());
    }
    #[test]
    fn failed_account_switch_cannot_relabel_an_old_accounts_facts() {
        let mut view = AccountView {
            account: "old".into(),
            at: Some(9000),
            facts: AccountFacts {
                tokens: Some(321.0),
                ..Default::default()
            },
            ..Default::default()
        };
        let fresh = tip(2000, 1.0, 2_000_000);
        let key = fresh.meter.key();
        let mut tips = Tips::default();
        tips.insert(fresh);
        tips.apply(&mut view, "claude:seat", Some(&key));
        assert_eq!(view.account, "claude:seat");
        assert_eq!(view.at, Some(2000));
        assert!(view.facts.tokens.is_none());
    }
    #[test]
    fn transient_chart_tips_are_bounded_and_unused_accounts_are_retired() {
        let mut tips = Tips::default();
        for step in 0..700 {
            for account in 0..8 {
                let mut t = tip(step, step as f64 / 10.0, 2_000_000);
                t.account = format!("seat-{account}");
                tips.insert(t);
            }
        }
        assert!(tips.0.values().map(Vec::len).sum::<usize>() <= 4800);
        assert!(
            tips.0
                .values()
                .all(|list| list.len() <= 600 && list[0].at == 0 && list.last().unwrap().at == 699)
        );
        let retained = "seat-0".to_owned();
        tips.retain_accounts(&std::collections::BTreeSet::from([&retained]));
        assert_eq!(tips.0.len(), 1);
    }
    #[test]
    fn cancelled_helper_terminates_its_entire_process_group() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("scripts/dev");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("monitor-gauges.ts"),r#"
            await Bun.stdin.json();
            const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});
            await Bun.write('child.pid',String(child.pid));
            setInterval(()=>{},1000);
        "#).unwrap();
        let cancelled = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let result =
                scope.spawn(|| collect(root.path(), &["fixture".into()], 20, false, &cancelled));
            let file = root.path().join("child.pid");
            let deadline = Instant::now() + Duration::from_secs(15);
            while !file.is_file() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            cancelled.store(true, Ordering::Relaxed);
            assert!(result.join().unwrap().is_err());
            let pid: u32 = std::fs::read_to_string(file).unwrap().parse().unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while MainProcess::open(pid).is_some_and(|child| child.alive())
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(MainProcess::open(pid).is_none_or(|child| !child.alive()));
        });
    }
}
