use anyhow::{Result, bail};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf};

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}
pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("valid timestamp")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
}
impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub provider: Provider,
    pub home: PathBuf,
    pub identity: String,
    pub label: String,
    pub account_id: Option<String>,
    pub organization_id: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Meter {
    pub kind: String,
    pub group: Option<String>,
    pub scope: Option<String>,
    pub minutes: Option<i64>,
    pub percent: f64,
    pub resets_at: Option<i64>,
}
impl Meter {
    pub fn key(&self) -> String {
        json!([self.kind, self.group, self.scope, self.minutes]).to_string()
    }
    pub fn duration(&self) -> String {
        match self.minutes {
            Some(m) if m % 1440 == 0 => format!("{} dni", m / 1440),
            Some(m) if m % 60 == 0 => format!("{} h", m / 60),
            Some(m) => format!("{m} min"),
            None => "nieznane okno".into(),
        }
    }
    pub fn label(&self) -> String {
        let scope = self.scope.as_deref().filter(|s| !s.is_empty());
        match scope {
            Some(s) => format!("{} · {s}", self.duration()),
            None => self.duration(),
        }
    }
    pub fn validate(&self) -> Result<()> {
        if !self.percent.is_finite() || !(0.0..=100.0).contains(&self.percent) {
            bail!("Invalid percentage");
        }
        if self.minutes.is_some_and(|m| m <= 0 || m > 525_600) {
            bail!("Invalid window duration");
        }
        if self
            .resets_at
            .is_some_and(|r| chrono::DateTime::from_timestamp_millis(r).is_none())
        {
            bail!("Invalid reset time");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Batch {
    pub version: u32,
    pub id: String,
    pub at: i64,
    pub profile: Profile,
    pub raw: Value,
    pub meters: Vec<Meter>,
}
impl Batch {
    pub fn new(profile: &Profile, raw: Value, meters: Vec<Meter>) -> Result<Self> {
        if meters.is_empty() {
            bail!("Brak rozpoznanych liczników");
        }
        for m in &meters {
            m.validate()?;
        }
        Ok(Self {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            at: now_ms(),
            profile: profile.clone(),
            raw,
            meters,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub atlas_root: Option<PathBuf>,
    pub selected: Vec<String>,
    pub active: Option<String>,
    pub meters: BTreeMap<String, String>,
    pub interval_minutes: u64,
    pub dark: bool,
    pub always_on_top: bool,
    pub extra_profiles: Vec<(Provider, PathBuf)>,
    pub panels: Vec<PanelChoice>,
}
pub const MAX_PANELS: usize = 8;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PanelChoice {
    pub id: String,
    pub account: String,
    pub meter: Option<String>,
}
impl PanelChoice {
    pub fn new(account: String, meter: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            account,
            meter,
        }
    }
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            atlas_root: None,
            selected: vec![],
            active: None,
            meters: BTreeMap::new(),
            interval_minutes: 20,
            dark: false,
            always_on_top: false,
            extra_profiles: vec![],
            panels: vec![],
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AccountFacts {
    pub tokens: Option<f64>,
    pub api_standard: Option<f64>,
    pub unpriced_tokens: Option<f64>,
    pub plan: Option<String>,
    pub credits: Option<String>,
    pub free_resets: Option<u64>,
}
impl AccountFacts {
    pub fn from_batch(batch: &Batch) -> Self {
        let mut facts = Self {
            plan: batch.profile.plan.clone(),
            ..Default::default()
        };
        if batch.profile.provider == Provider::Codex {
            let raw = &batch.raw;
            let snapshots = raw.get("rateLimits").into_iter().chain(
                raw["rateLimitsByLimitId"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values()),
            );
            for snapshot in snapshots {
                if facts.plan.is_none() {
                    facts.plan = snapshot["planType"].as_str().map(str::to_owned);
                }
                if facts.credits.is_none() {
                    facts.credits = snapshot["credits"]["balance"]
                        .as_str()
                        .filter(|s| s.parse::<f64>().is_ok_and(f64::is_finite))
                        .map(str::to_owned);
                }
            }
            facts.free_resets = raw["rateLimitResetCredits"]["availableCount"].as_u64();
        }
        facts
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        if !(5..=120).contains(&self.interval_minutes)
            || self.selected.len() > 64
            || self.panels.len() > MAX_PANELS
            || self
                .panels
                .iter()
                .any(|p| p.id.is_empty() || !self.selected.contains(&p.account))
            || self
                .panels
                .iter()
                .map(|p| &p.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.panels.len()
        {
            bail!("Invalid monitor settings");
        }
        Ok(())
    }
    pub fn ensure_panels(&mut self, profiles: &[Profile]) {
        if !self.panels.is_empty() {
            return;
        }
        let chosen: Vec<_> = profiles
            .iter()
            .filter(|p| self.selected.contains(&p.id))
            .collect();
        let first = chosen
            .iter()
            .copied()
            .find(|p| self.active.as_ref() == Some(&p.id))
            .or(chosen.first().copied());
        if let Some(first) = first {
            for profile in std::iter::once(first)
                .chain(chosen.iter().copied().filter(|p| p.id != first.id))
                .take(2)
            {
                self.panels.push(PanelChoice::new(
                    profile.id.clone(),
                    self.meters.get(&profile.id).cloned(),
                ));
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Point {
    pub at: i64,
    pub percent: f64,
    pub reset: Option<i64>,
    pub segment: i64,
}

/// Join observed points across missing readings, retaining resets and counter decreases.
#[cfg(test)]
pub fn segments(points: &[Point], meter: &Meter) -> Vec<Vec<[f64; 2]>> {
    segments_in(points, meter, None)
}
pub fn segments_in(
    points: &[Point],
    meter: &Meter,
    bounds: Option<(i64, i64)>,
) -> Vec<Vec<[f64; 2]>> {
    let start = bounds.map(|b| b.0).or_else(|| {
        meter
            .resets_at
            .zip(meter.minutes)
            .map(|(r, m)| r - m * 60_000)
    });
    let end = bounds.map(|b| b.1).or(meter.resets_at);
    let mut out: Vec<Vec<[f64; 2]>> = vec![];
    let mut previous: Option<&Point> = None;
    for p in points.iter().filter(|p| {
        p.reset == meter.resets_at
            && start.is_none_or(|s| p.at >= s)
            && end.is_none_or(|r| p.at <= r)
    }) {
        let gap = previous.is_none_or(|prev| p.segment != prev.segment || p.percent < prev.percent);
        if gap {
            out.push(vec![]);
        }
        out.last_mut()
            .expect("segment")
            .push([p.at as f64 / 1000.0, p.percent]);
        previous = Some(p);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_preferences_gain_two_stable_independent_panels_with_a_hard_limit() {
        let profiles = crate::common::demo_profiles();
        let mut settings: Settings =
            serde_json::from_value(json!({"selected":["demo-0","demo-1"],"active":"demo-1"}))
                .unwrap();
        settings.ensure_panels(&profiles);
        assert_eq!(settings.panels.len(), 2);
        assert_eq!(settings.panels[0].account, "demo-1");
        let restarted: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(settings.panels, restarted.panels);
        settings.panels[1].account = settings.panels[0].account.clone();
        settings.validate().unwrap();
        settings.panels[1].id = settings.panels[0].id.clone();
        assert!(settings.validate().is_err());
        settings.panels = (0..=MAX_PANELS)
            .map(|_| PanelChoice::new("demo-0".into(), None))
            .collect();
        assert!(settings.validate().is_err());
    }
    #[test]
    fn optional_facts_distinguish_missing_and_invalid_from_real_zero() {
        let profile = crate::common::demo_profiles().remove(0);
        let missing = Batch::new(
            &profile,
            json!({}),
            vec![Meter {
                kind: "primary".into(),
                group: None,
                scope: None,
                minutes: None,
                percent: 0.0,
                resets_at: None,
            }],
        )
        .unwrap();
        let facts = AccountFacts::from_batch(&missing);
        assert!(facts.credits.is_none());
        assert!(facts.free_resets.is_none());
        for invalid in ["unknown", "NaN", "inf"] {
            let mut batch = missing.clone();
            batch.raw = json!({"rateLimits":{"credits":{"balance":invalid}}});
            assert!(AccountFacts::from_batch(&batch).credits.is_none());
        }
        let mut zero = missing;
        zero.raw = json!({"rateLimitsByLimitId":{"codex":{"credits":{"balance":"0"}}},"rateLimitResetCredits":{"availableCount":0}});
        let facts = AccountFacts::from_batch(&zero);
        assert_eq!(facts.credits.as_deref(), Some("0"));
        assert_eq!(facts.free_resets, Some(0));
    }
    #[test]
    fn graph_joins_missing_readings_but_never_resets_or_decreases() {
        let m = Meter {
            kind: "primary".into(),
            group: None,
            scope: None,
            minutes: Some(300),
            percent: 40.0,
            resets_at: Some(20_000_000),
        };
        let points = vec![
            Point {
                at: 3_000_000,
                percent: 10.0,
                reset: Some(19_000_000),
                segment: 0,
            },
            Point {
                at: 3_000_000,
                percent: 10.0,
                reset: m.resets_at,
                segment: 0,
            },
            Point {
                at: 3_300_000,
                percent: 20.0,
                reset: m.resets_at,
                segment: 0,
            },
            Point {
                at: 8_000_000,
                percent: 30.0,
                reset: m.resets_at,
                segment: 0,
            },
            Point {
                at: 8_300_000,
                percent: 5.0,
                reset: m.resets_at,
                segment: 2,
            },
        ];
        assert_eq!(
            segments(&points, &m)
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            vec![3, 1]
        );
    }
    #[test]
    fn no_duration_is_invented_from_a_slot() {
        let m = Meter {
            kind: "primary".into(),
            group: None,
            scope: None,
            minutes: None,
            percent: 0.0,
            resets_at: None,
        };
        assert_eq!(m.duration(), "nieznane okno");
        assert!(m.validate().is_ok());
        assert!(
            Meter {
                percent: f64::NAN,
                ..m
            }
            .validate()
            .is_err()
        );
    }
}
