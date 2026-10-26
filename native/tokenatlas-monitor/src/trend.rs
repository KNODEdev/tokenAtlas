use crate::model::{Meter, Point};

#[derive(Clone, Copy, Debug)]
pub struct Basis {
    pub at: i64,
    pub percent: f64,
    pub whole_window: bool,
}

pub fn basis(points: &[Point], bounds: Option<(i64, i64)>, baseline: Option<f64>) -> Option<Basis> {
    let last = points.last()?;
    if last.segment == 0
        && let (Some((start, _)), Some(percent)) = (bounds, baseline)
        && percent.is_finite()
        && (0.0..100.0).contains(&percent)
    {
        return Some(Basis {
            at: start,
            percent,
            whole_window: true,
        });
    }
    let first = points.iter().find(|p| p.segment == last.segment)?;
    Some(Basis {
        at: first.at,
        percent: first.percent,
        whole_window: false,
    })
}

#[derive(Default, Debug)]
pub struct Estimate {
    pub remaining_percent: f64,
    pub percent_per_hour: Option<f64>,
    pub multiplier: Option<f64>,
    pub ceiling_at: Option<i64>,
    pub basis_at: Option<i64>,
}
impl Estimate {
    pub fn new(
        meter: &Meter,
        at: Option<i64>,
        basis: Option<Basis>,
        bounds: Option<(i64, i64)>,
        now: i64,
        interval: u64,
    ) -> Self {
        let mut out = Self {
            remaining_percent: (100.0 - meter.percent).max(0.0),
            ..Self::default()
        };
        let Some(at) = at else { return out };
        let Some(basis) = basis else { return out };
        let duration = at - basis.at;
        if duration <= 0 || meter.percent < basis.percent {
            return out;
        }
        let rate = (meter.percent - basis.percent) / duration as f64;
        if !rate.is_finite() {
            return out;
        }
        out.basis_at = Some(basis.at);
        out.percent_per_hour = Some(rate * 3_600_000.0);
        if basis.whole_window
            && let Some((start, end)) = bounds
            && end > start
            && at <= end
            && basis.percent < 100.0
        {
            out.multiplier = Some(
                (meter.percent - basis.percent)
                    / (100.0 - basis.percent)
                    / (duration as f64 / (end - start) as f64),
            );
        }
        // A historical rate stays useful; a countdown needs a fresh, current-window reading.
        if rate > 0.0
            && at <= now + 60_000
            && now - at <= (interval * 180_000) as i64
            && meter.resets_at.is_some_and(|reset| reset > now)
            && bounds.is_none_or(|(start, end)| start <= at && at <= end && now < end)
        {
            let forecast = at as f64 + out.remaining_percent / rate;
            if forecast.is_finite() && forecast <= i64::MAX as f64 {
                out.ceiling_at = Some(forecast.round() as i64);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meter(percent: f64) -> Meter {
        Meter {
            kind: "weekly".into(),
            group: None,
            scope: None,
            minutes: Some(240),
            percent,
            resets_at: Some(14_400_000),
        }
    }
    #[test]
    fn remaining_rate_pace_and_eta_share_the_nonzero_published_baseline() {
        let e = Estimate::new(
            &meter(80.0),
            Some(7_200_000),
            Some(Basis {
                at: 0,
                percent: 50.0,
                whole_window: true,
            }),
            Some((0, 14_400_000)),
            7_200_000,
            20,
        );
        assert_eq!(e.remaining_percent, 20.0);
        assert_eq!(e.percent_per_hour, Some(15.0));
        assert_eq!(e.multiplier, Some(1.2));
        assert_eq!(e.ceiling_at, Some(12_000_000));
    }
    #[test]
    fn observed_pair_can_estimate_rate_without_inventing_a_window_baseline() {
        let points = vec![
            Point {
                at: 3_600_000,
                percent: 30.0,
                reset: None,
                segment: 0,
            },
            Point {
                at: 10_800_000,
                percent: 80.0,
                reset: None,
                segment: 0,
            },
        ];
        let b = basis(&points, Some((0, 14_400_000)), None).unwrap();
        let e = Estimate::new(
            &meter(80.0),
            Some(10_800_000),
            Some(b),
            Some((0, 14_400_000)),
            10_800_000,
            20,
        );
        assert_eq!(e.percent_per_hour, Some(25.0));
        assert_eq!(e.multiplier, None);
        assert_eq!(e.ceiling_at, Some(13_680_000));
    }
    #[test]
    fn a_decrease_starts_a_new_rate_basis_before_display_reduction() {
        let points = vec![
            Point {
                at: 0,
                percent: 80.0,
                reset: None,
                segment: 0,
            },
            Point {
                at: 3_600_000,
                percent: 10.0,
                reset: None,
                segment: 1,
            },
            Point {
                at: 7_200_000,
                percent: 30.0,
                reset: None,
                segment: 1,
            },
        ];
        let b = basis(&points, Some((0, 14_400_000)), Some(0.0)).unwrap();
        let e = Estimate::new(
            &meter(30.0),
            Some(7_200_000),
            Some(b),
            Some((0, 14_400_000)),
            7_200_000,
            20,
        );
        assert_eq!(e.percent_per_hour, Some(20.0));
        assert_eq!(e.multiplier, None);
    }
    #[test]
    fn stale_zero_rate_and_expired_windows_have_no_live_countdown() {
        let b = Some(Basis {
            at: 0,
            percent: 0.0,
            whole_window: true,
        });
        let e = Estimate::new(
            &meter(80.0),
            Some(7_200_000),
            b,
            Some((0, 14_400_000)),
            11_000_000,
            20,
        );
        assert!(e.percent_per_hour.is_some() && e.ceiling_at.is_none());
        assert!(
            Estimate::new(&meter(0.0), Some(7_200_000), b, None, 7_200_000, 20)
                .ceiling_at
                .is_none()
        );
        assert!(
            Estimate::new(&meter(80.0), Some(7_200_000), b, None, 15_000_000, 120)
                .ceiling_at
                .is_none()
        );
        assert!(
            Estimate::new(&meter(80.0), Some(7_200_000), None, None, 7_200_000, 20)
                .percent_per_hour
                .is_none()
        );
    }
    #[test]
    fn published_window_end_limits_forecasts_even_when_vendor_reset_is_later() {
        let b = Some(Basis {
            at: 0,
            percent: 0.0,
            whole_window: true,
        });
        let e = Estimate::new(
            &meter(80.0),
            Some(7_200_000),
            b,
            Some((0, 7_500_000)),
            7_600_000,
            20,
        );
        assert!(e.percent_per_hour.is_some());
        assert!(e.ceiling_at.is_none());
        assert!(
            Estimate::new(
                &meter(80.0),
                Some(7_200_000),
                b,
                Some((7_300_000, 9_000_000)),
                7_600_000,
                20
            )
            .ceiling_at
            .is_none()
        );
    }
}
