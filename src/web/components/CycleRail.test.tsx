import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiActivityPoint, ApiCycle, ApiMachineTraffic, ApiPoint } from "../lib/api";
import { buildCycleView } from "../lib/cycle";
import { sampleCurveAt } from "../lib/window-insights";
import { railWindowsFromCycles, type RailWindow } from "../lib/windows";
import { WindowRail } from "./CycleRail";

const shortenedCycle: ApiCycle = {
  index: 57,
  label: "2026-08-25",
  anchor: Date.parse("2026-09-01T14:00:00.000Z") / 1000,
  resets_at_iso: "2026-09-01T14:00:00.000Z",
  window_start_iso: "2026-08-25T14:00:00.000Z",
  is_active: false,
  shadow: false,
  status: "closed",
  start_ts: "2026-08-25T14:11:00.000Z",
  end_ts: "2026-08-27T15:42:00.000Z",
  work_from_ts: "2026-08-25T14:00:00.000Z",
  work_to_ts: "2026-08-27T16:00:00.000Z",
  sample_count: 20,
  lag_fraction: 0,
  distinct_steps: 10,
  first_percent: 2,
  peak_percent: 86,
  end_percent: 86,
  hit_100: false,
  window_hours: 168,
  elapsed_hours: 50,
  observed_hours: 49.52,
  remaining_hours: 0,
  pace_percent_per_day: 41.28,
  projected_end_percent: null,
  eta_100_iso: null,
  calls: 4,
  usd: 27,
  usd_per_percent: 0.31,
  usd_at_100_percent: 31.4,
  tokens: { in: 100, cached_in: 80, cache_write: 0, out: 20, reasoning: 0, total: 120 },
  top_model: "gpt-5",
  source_models: [],
  model_usage: [],
  surface_usage: [],
  plan_types: ["pro"],
  limit_names: [],
  delta_peak_percent: null,
  delta_usd: null,
  delta_calls: null,
  pct_of_prev_peak: null,
  pct_of_prev_usd: null,
};

describe("WindowRail historical duration", () => {
  it("shows the real shortened span instead of the nominal seven days", () => {
    const cycle = buildCycleView(shortenedCycle, [], 57);
    const windows = railWindowsFromCycles([cycle], []);
    const html = renderToStaticMarkup(
      <WindowRail
        windows={windows}
        activeKey={windows[0]!.key}
        cycleDetails={{ cycles: [cycle], points: [] }}
        medianPercent={null}
        medianTokens={null}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("Aug 25 · 2d 02h");
    expect(html).not.toContain("Aug 25 · 7d 00h");
    expect(html).not.toContain("rail-row-reserve");
  });

  it("shows the reserve pool used after the window ran out as a note on that window", () => {
    const spent = buildCycleView({ ...shortenedCycle, peak_percent: 100, end_percent: 100, hit_100: true,
      reserve: { peak_percent: 7, first_ts: new Date(2026,7,27,16).toISOString(), peak_ts: new Date(2026,7,29,18).toISOString(),
        resets_at_iso: "2026-09-03T16:00:00.000Z", calls: 234, usd: 0.89,
        tokens: { in: 20_000_000, cached_in: 18_000_000, cache_write: 0, out: 186_580, reasoning: 0, total: 20_186_580 } } }, [], 57);
    const windows = railWindowsFromCycles([spent], []);
    const html = renderToStaticMarkup(
      <WindowRail windows={windows} activeKey={windows[0]!.key} cycleDetails={{ cycles: [spent], points: [] }}
        medianPercent={null} medianTokens={null} onSelect={() => {}} />,
    );
    expect(html).toMatch(/class="rail-row-reserve"[^>]*>\+7(\.0)?%/);
    expect(html).toContain("7% · 20.19M tokens · Aug 27 16:00 → Aug 29 18:00");
  });

  it("carries real Codex activity into the shared curve and separates changed capacity", () => {
    const points: ApiPoint[] = [
      { ts: "2026-08-25T14:00:00.000Z", ts_last: "2026-08-25T14:00:00.000Z", cycle: 57, percent: 2, percent_min: 2, percent_last: 2, samples: 1, cycle_progress: 0 },
      { ts: "2026-08-26T14:00:00.000Z", ts_last: "2026-08-26T14:00:00.000Z", cycle: 57, percent: 30, percent_min: 30, percent_last: 30, samples: 1, cycle_progress: 14.29 },
      { ts: "2026-08-27T14:00:00.000Z", ts_last: "2026-08-27T14:00:00.000Z", cycle: 57, percent: 60, percent_min: 60, percent_last: 60, samples: 1, cycle_progress: 28.57 },
    ];
    const activity: ApiActivityPoint[] = [
      { cycle: 57, t: 0, amount: 0 },
      { cycle: 57, t: 8, amount: 10 },
      { cycle: 57, t: 20, amount: 100 },
      { cycle: 57, t: 25, amount: 240 },
    ];
    const traffic: ApiMachineTraffic[] = [
      { cycle: 57, machine: "EXAMPLE-MAIN", amount: 180 },
      { cycle: 57, machine: "EXAMPLE-LAPTOP-A", amount: 60 },
    ];
    const measured = buildCycleView({ ...shortenedCycle, sample_count: 60 }, points, 57);
    const changed = buildCycleView({
      ...shortenedCycle,
      index: 58,
      sample_count: 60,
      tokens: { ...shortenedCycle.tokens, in: 1_000, out: 200, total: 1_200 },
    }, [], 58);
    const windows = railWindowsFromCycles([measured, changed], points, activity, traffic);

    expect(windows[0]?.activityShape).toEqual([
      { t: 0, amount: 0 },
      { t: 8, amount: 10 },
      { t: 20, amount: 100 },
      { t: 25, amount: 240 },
    ]);
    expect(sampleCurveAt(windows[0]?.shape ?? null, 10, windows[0]?.activityShape)).toEqual({
      value: 30,
      basis: "activity-interpolated",
    });
    expect(windows[0]?.trafficByMachine).toEqual([
      { machine: "EXAMPLE-MAIN", amount: 180 },
      { machine: "EXAMPLE-LAPTOP-A", amount: 60 },
    ]);
    expect(windows[0]?.regimeKey).not.toBe(windows[1]?.regimeKey);
  });
});

describe("WindowRail reconstructed windows", () => {
  const reconstructed: RailWindow = {
    key: "weekly_all:2026-09-06T11:00:00.000Z",
    label: "7d",
    dateLabel: "2026-08-30 → 2026-09-06",
    source: "probe",
    isCurrent: false,
    usedPercent: null,
    percentBasis: null,
    elapsedPercent: 100,
    ppAhead: null,
    windowHours: 168,
    startIso: "2026-08-30T11:00:00.000Z",
    resetIso: "2026-09-06T11:00:00.000Z",
    shape: null,
    tokensTotal: 2_726_778_490,
    usd: 1860.13,
    note: null,
    scope: null,
    sublimits: [],
  };

  it("shows the measured tokens and API-equivalent cost when the account never reported a percentage", () => {
    const html = renderToStaticMarkup(
      <WindowRail
        windows={[reconstructed]}
        activeKey={reconstructed.key}
        medianPercent={null}
        medianTokens={null}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("2.73B");
    expect(html).toContain("API-eq");
  });

  it("starts a measured curve at the window start, not at the first reading", () => {
    const window: RailWindow = { ...reconstructed, isCurrent: true, usedPercent: 98, percentBasis: "measured",
      shape: [{ t: 20.5, pct: 66 }, { t: 30, pct: 80 }, { t: 44, pct: 98 }] };
    const html = renderToStaticMarkup(
      <WindowRail windows={[window]} activeKey={window.key} medianPercent={null} medianTokens={null} onSelect={() => {}} />,
    );
    expect(html).toContain('d="M0.00,100.00 L20.50,34.00');
  });

  it("leaves a measured window's row to its percentage alone", () => {
    const html = renderToStaticMarkup(
      <WindowRail
        windows={[{ ...reconstructed, usedPercent: 57, percentBasis: "measured" }]}
        activeKey={reconstructed.key}
        medianPercent={null}
        medianTokens={null}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("57%");
    expect(html).not.toContain("API-eq");
  });
});

describe("WindowRail credits", () => {
  const pools: NonNullable<ApiCycle["credit_pools"]> = {
    read_at: "2026-10-10T07:31:00.000Z",
    pools: [{ key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: 60749.9557035,
      remaining_text: "60749.9557035000", unlimited: false, granted_at: null, expires_at: null, items: null }],
    flows: [],
  };
  const funded = { calls: 3127, tokens: 549e6, credits: 4500, credits_unpriced: 0, api_standard: 238, api_unpriced: 0,
    first: "2026-10-01T08:00:00.000Z", last: "2026-10-02T20:00:00.000Z", hours: [] };
  const render = (cycles: ReturnType<typeof buildCycleView>[]) => {
    const windows = railWindowsFromCycles(cycles, []);
    return renderToStaticMarkup(<WindowRail windows={windows} activeKey={windows[0]!.key} cycleDetails={{ cycles, points: [] }}
      medianPercent={null} medianTokens={null} onSelect={() => {}} />);
  };

  it("tags a window with credit-funded calls and adds the Credits block under the point rate", () => {
    const html = render([buildCycleView({ ...shortenedCycle, peak_percent: 100, end_percent: 100, hit_100: true, credit_funded: funded,
      credit_pools: pools }, [], 57)]);
    expect(html).toMatch(/class="rail-row-credit"[^>]*>\+4.5k cr</);
    expect(html).toContain("data-rail-credits");
    expect(html).toMatch(/rail-credits-balance">60,750</);
    expect(html).toContain("used in the visible windows</span><span>4,500</span>");
  });

  it("leaves a rail without credits unchanged", () => {
    const html = render([buildCycleView(shortenedCycle, [], 57)]);
    expect(html).not.toContain("rail-row-credit");
    expect(html).not.toContain("data-rail-credits");
  });
});
