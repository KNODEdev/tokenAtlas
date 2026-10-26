import { describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiCycle, CycleBreakdownResponse, UsageSeries } from "./api";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { buildCycleView, buildModel, emptySeries } from "./cycle";
import { useCodexSections } from "../components/CodexSections";
import type { ScreenProps } from "./screens";
import { cyclePlanLabel, historyThroughCycle, modelThroughCycle, withWindowTraffic, observationOf, observedRates, windowForecast, comparableStatWindows, usageAtSameTime, trafficRangeOf, windowRates } from "./codex-window-stats";
import { CodexWindowStats } from "../components/CodexWindowStats";
import { WindowStatusCard } from "../components/WindowStatusCard";
import type { WindowInsight } from "./window-insights";
import { windowTrafficSummary, medianDailyTraffic } from "./codex-window-stats";
import { api } from "./api";
import { installTestDom } from "./test-dom-harness";

const hour = 3_600_000;
const start = Date.parse("2026-09-01T00:00:00Z");
describe("daily traffic summary", () => {
  it("uses the selected window duration and daily totals, not gauge calibration", () => {
    const c = cycle({ is_active: false, work_to_ts: new Date(start + 48 * hour).toISOString() });
    const range = trafficRangeOf(c);
    const d = { ...data(c), since_ts: range.from, until_ts: range.until,
      days: [{ date: "2026-09-01", tokens: 1000 }, { date: "2026-09-02", tokens: 3000 }] } as CycleBreakdownResponse;
    expect(windowTrafficSummary(c, d)).toEqual({ perDay: 2000, peak: { date: "2026-09-02", tokens: 3000, share: 75 } });
    expect(windowTrafficSummary(c, { ...d, limit_id: "other" })).toEqual({ perDay: null, peak: null });
    expect(windowTrafficSummary(c, null)).toEqual({ perDay: null, peak: null });
    expect(windowTrafficSummary(c, { ...d, totals: { ...d.totals, tokens: 0 }, days: [] })).toEqual({ perDay: 0, peak: null });
    const active = cycle();
    const activeRange = trafficRangeOf(active);
    expect(windowTrafficSummary(active, { ...d, since_ts: activeRange.from, until_ts: activeRange.until }, start + 24 * hour).perDay).toBe(4000);
  });
  it("requires four usable historical windows and computes an even-sized median", () => {
    expect(medianDailyTraffic([10, 20, 30, null, NaN])).toBeNull();
    expect(medianDailyTraffic([40, 10, 30, 20, null])).toBe(25);
    expect(medianDailyTraffic([0, 0, 0, 0])).toBe(0);
  });
  it("exposes an exhaustion date only for a fresh future projection before reset", () => {
    expect(windowForecast(cycle(), start + 51 * hour).exhaustionIso).toBe("2026-09-04T11:20:00.000Z");
    expect(windowForecast(cycle(), start + 57 * hour).exhaustionIso).toBeNull();
    expect(windowForecast(cycle({ is_active: false }), start + 51 * hour).exhaustionIso).toBeNull();
    expect(windowForecast(cycle({ end_percent: 10, peak_percent: 10 }), start + 51 * hour).exhaustionIso).toBeNull();
  });
});
function cycle(overrides: Partial<ApiCycle> = {}) {
  return buildCycleView({
    index: 2, limit_id: "codex", label: "Sep 1", anchor: (start + 168 * hour) / 1000,
    resets_at_iso: new Date(start + 168 * hour).toISOString(), window_start_iso: new Date(start).toISOString(),
    start_ts: new Date(start + 10 * hour).toISOString(), end_ts: new Date(start + 50 * hour).toISOString(),
    work_from_ts: new Date(start).toISOString(), work_to_ts: new Date(start + 168 * hour).toISOString(),
    is_active: true, shadow: false, status: "active", sample_count: 100, lag_fraction: 0, distinct_steps: 40,
    first_percent: 20, peak_percent: 60, end_percent: 60, hit_100: false, window_hours: 168, elapsed_hours: 55,
    observed_hours: 40, remaining_hours: 113, pace_percent_per_day: 26, projected_end_percent: 183,
    eta_100_iso: null, calls: 100, usd: 800, usd_per_percent: 13.33, usd_at_100_percent: 1333,
    tokens: { in: 7000, cached_in: 5000, out: 1000, cache_write: 0, reasoning: 0, total: 8000 },
    top_model: "model", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
    ...overrides,
  }, []);
}
function data(c = cycle()): CycleBreakdownResponse {
  const o = observationOf(c);
  return { account: "codex1", since_ts: o.from!, until_ts: o.until!, limit_id: "codex",
    totals: { calls: 50, usd: 400, tokens: 4000, tokens_fresh: 1000 }, unpriced: { tokens: 0, models: {} },
    credit_equivalent: { value: 800, priced_credits: 800, unpriced_calls: 0, basis: "Standard" },
  } as CycleBreakdownResponse;
}
function accounting(c: ReturnType<typeof cycle>, factor = 2): CodexComparisonWindow {
  return { id: String(c.index), account: "codex1", plan: "pro", reset: c.resetIso,
    promotion: { status: "configured", factor, regime_ids: [], notes: [], sources: [] },
  } as unknown as CodexComparisonWindow;
}
function previous() {
  return cycle({ index: 1, is_active: false,
    window_start_iso: new Date(start - 168 * hour).toISOString(),
    work_from_ts: new Date(start - 168 * hour).toISOString(),
    start_ts: new Date(start - 158 * hour).toISOString(),
    end_ts: new Date(start - hour).toISOString(),
    work_to_ts: new Date(start).toISOString(), resets_at_iso: new Date(start).toISOString(),
  });
}

it("changing the Overview account cancels its reads and stops remaining historical batches", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const originalCancelFrame = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  const selected = cycle();
  const past = Array.from({ length: 4 }, (_, index) => {
    const from = start - (index + 1) * 168 * hour, until = from + 168 * hour;
    return cycle({ index: 10 + index, is_active: false, window_start_iso: new Date(from).toISOString(),
      work_from_ts: new Date(from).toISOString(), work_to_ts: new Date(until).toISOString(),
      start_ts: new Date(from + 10 * hour).toISOString(), end_ts: new Date(until - hour).toISOString(),
      resets_at_iso: new Date(until).toISOString() });
  });
  type Params = Parameters<typeof api.cycleBreakdown>[0];
  const requests: Array<{ params: Params; signal?: AbortSignal; finish?: () => void }> = [];
  const breakdownSpy = spyOn(api, "cycleBreakdown").mockImplementation((params, signal) => {
    const source = [...past, selected].find(c => c.raw.anchor === params.anchor) ?? selected;
    const response = { ...data(source), account: params.account, since_ts: params.since_ts, until_ts: params.until_ts };
    const request = { params, signal, finish: undefined as (() => void) | undefined };
    requests.push(request);
    // An old read may finish despite abort; the loop must still stop before its next batch.
    if (params.account === "old") return new Promise(resolve => { request.finish = () => resolve(response); });
    return Promise.resolve(response);
  });
  const accountingSpy = spyOn(api, "codexAccounting").mockResolvedValue({ windows: [...past, selected].map(c => accounting(c)) } as never);
  function Hook({ account }: { account: string }) {
    const model = buildModel(emptySeries(account, 10080, [...past.map(c => c.raw), selected.raw]));
    useCodexSections({ model, account, unit: "percent", project: "project", chosen: selected,
      openDrawer() {}, selectCycle() {}, windowRailInShell: true, card: null } as unknown as ScreenProps);
    return <div>{account}</div>;
  }
  const historical = (account: string) => requests.filter(row => row.params.account === account && Date.parse(row.params.since_ts) < start);
  try {
    await act(async () => root.render(<Hook account="old" />));
    expect(historical("old").length).toBe(2);
    const oldRequests = requests.filter(row => row.params.account === "old");
    expect(oldRequests.length).toBeGreaterThan(2);
    await act(async () => root.render(<Hook account="new" />));
    expect(oldRequests.every(row => row.signal?.aborted)).toBe(true);
    await act(async () => { oldRequests.forEach(row => row.finish!()); });
    expect(historical("old").length).toBe(2);
    expect(historical("new").length).toBe(4);
    expect(dom.host.textContent).toBe("new");
  } finally {
    await act(async () => root.unmount());
    breakdownSpy.mockRestore(); accountingSpy.mockRestore();
    globalThis.cancelAnimationFrame = originalCancelFrame;
    dom.restore();
  }
});
describe("paired Codex window statistics", () => {
  it("restores the current reset boundary after a live correction, but preserves closed window cutoffs", () => {
    const cutoff = new Date(start + 20 * hour).toISOString();
    const active = cycle({ work_to_ts: cutoff });
    expect(trafficRangeOf(active).until).toBe(active.resetIso!);
    expect(observationOf(active).from).not.toBeNull();
    const closed = cycle({ work_to_ts: cutoff, is_active: false });
    expect(trafficRangeOf(closed).until).toBe(cutoff);
    expect(observationOf(closed).from).toBeNull();
  });

  it("divides only traffic between gauge readings by their delta, even when recording started at 20%", () => {
    const c = cycle(), o = observationOf(c), rates = observedRates(c, data(c));
    expect(o.span).toBe(40);
    expect(Date.parse(o.from!)).toBe(Date.parse(c.raw.start_ts) + 1);
    expect(rates.tokens).toBe(100);
    expect(rates.api).toBe(10);
    expect(rates.credits).toBe(20);
    expect(rates.api).not.toBe(c.usd / c.usedPercent);
  });
  it("rejects a previous interval's cached response and a span under 5 pp", () => {
    const c = cycle(), d = data();
    d.until_ts = new Date(Date.parse(d.until_ts) - hour).toISOString();
    expect(observedRates(c, d).api).toBeNull();
    expect(observationOf(cycle({ first_percent: 58 })).from).toBeNull();
    expect(observationOf(cycle({ end_percent: 59 })).from).toBeNull();
    expect(observationOf(cycle({ plan_types: ["pro", "plus"] })).from).toBeNull();
    expect(observationOf(cycle({ lag_fraction: 0.2 })).from).toBeNull();
  });
  it("keeps missing prices separate from true zero and reports partial amounts", () => {
    const d = data();
    d.unpriced.tokens = 50; d.totals.usd = 0;
    d.credit_equivalent = { value: null, priced_credits: 200, unpriced_calls: 2, basis: "Standard" };
    expect(observedRates(cycle(), d)).toMatchObject({ api: null, apiPartial: true, credits: 5, creditsPartial: true });
    d.unpriced.tokens = 0;
    expect(observedRates(cycle(), d).api).toBe(0);
    d.totals.calls = 0;
    expect(observedRates(cycle(), d).tokens).toBeNull();
  });
  it("uses the reading time for pace instead of diluting usage by later idle time", () => {
    const c = cycle();
    const first = windowForecast(c, start + 51 * hour), later = windowForecast(c, start + 55 * hour);
    expect(first.perHour).toBe(1.2);
    expect(later.perHour).toBe(first.perHour);
    expect(later.projected).toBeCloseTo(201.6);
    expect(later.beforeResetHours).toBeCloseTo(84.6667, 3);
    expect(windowForecast(c, start + 57 * hour).projected).toBeNull();
    expect(windowForecast(cycle({ is_active: false }), start + 51 * hour).projected).toBeNull();
  });
  it("does not show remaining token capacity with insufficient calibration", () => {
    const c = cycle({ sample_count: 2 });
    expect(c.calibration.confidence).toBe("none");
    expect(c.remainingTokens).toBeNull();
    expect(c.sustainablePerDay).toBeNull();
  });
  it("compares preceding observations, excluding known conflicting plans and promotion factors", () => {
    const current = cycle(), before = previous(), windows = [accounting(current), accounting(before)];
    expect(comparableStatWindows([current, before], current, windows)).toEqual([before]);
    windows[1]!.promotion!.factor = 1;
    expect(comparableStatWindows([before], current, windows)).toEqual([]);
    windows[1]!.promotion!.factor = 2; windows[1]!.promotion!.status = "unknown";
    expect(comparableStatWindows([before], current, windows)).toEqual([before]);
    windows[1]!.promotion!.status = "configured"; windows[1]!.plan = "plus";
    expect(comparableStatWindows([before], current, windows)).toEqual([]);
    expect(comparableStatWindows([before], current, [...windows, accounting(current)])).toEqual([]);
  });
  it("allows observed same-plan comparisons without declared promotions, but rejects tiny, mixed and overlapping windows", () => {
    const current = cycle(), before = previous();
    expect(comparableStatWindows([before], current, [])).toEqual([before]);
    expect(comparableStatWindows([{ ...before, usedPercent: 9 }], current, [])).toEqual([]);
    expect(comparableStatWindows([before], { ...current, usedPercent: 9 }, [])).toEqual([]);
    expect(comparableStatWindows([{ ...before, raw: { ...before.raw, plan_types: ["pro", "plus"] } }], current, [])).toEqual([]);
    expect(comparableStatWindows([{ ...before, raw: { ...before.raw, work_to_ts: current.endIso } }], current, [])).toEqual([]);
    // An early reset ends the old window before its previously scheduled reset.
    expect(comparableStatWindows([{ ...before, resetIso: current.resetIso }], current, [])).toHaveLength(1);
  });
  it("compares the same elapsed time, never the previous window's final total", () => {
    const c = cycle(), before = previous();
    const elapsed = 50 / 168 * 100;
    const series = { ...emptySeries("codex1", 10080), points: [0, elapsed, 100].map((progress, i) => ({
      cycle: before.index, cycle_progress: progress, percent: [0, 45, 90][i]!,
      ts: "", ts_last: "", percent_min: 0, percent_last: 0, samples: 1,
    })) } as UsageSeries;
    expect(usageAtSameTime(before, c, series)).toEqual({ value: 45, basis: "measured" });
    series.points = [];
    expect(usageAtSameTime(before, c, series)).toBeNull();
  });
  it("folds the reference values and never turns unavailable rates into zero", () => {
    const c = cycle(), rates = windowRates(c, null);
    const html = renderToStaticMarkup(<CodexWindowStats totals={null} rates={rates} usedPercent={c.usedPercent}
      previousRates={null} historyRates={[]} loading={false} error="read failed" />);
    expect(html).toContain("<details>");
    expect(html).toContain("Reference values and comparisons");
    expect(html).not.toContain("Usage in this window");
    expect(html).not.toContain("Pace and forecast");
    expect(html).toContain("Could not read this window&#x27;s traffic.");
    expect(html).toContain("— no comparison");
    expect(html).not.toContain("$0.00");
  });
});

describe("descriptive averages for closed windows", () => {
  function windowData(c: ReturnType<typeof cycle>, tokens: number, api: number, credits: number) {
    const range = trafficRangeOf(c);
    return { ...data(c), since_ts: range.from, until_ts: range.until,
      totals: { calls: 2116, tokens, tokens_fresh: tokens / 30, usd: api },
      credit_equivalent: { value: null, priced_credits: credits, unpriced_calls: 168, basis: "Standard" },
    };
  }
  it("calculates #61-style averages at 100% despite later replayed readings", () => {
    const c = cycle({ is_active: false, first_percent: 0, peak_percent: 100, end_percent: 100,
      work_to_ts: new Date(start + 8 * hour).toISOString(), lag_fraction: 0.78, elapsed_hours: 8 });
    const r = windowRates(c, windowData(c, 256_050_000, 308.23, 7196.58));
    expect(r.tokens).toBe(2_560_500);
    expect(r.api).toBeCloseTo(3.0823);
    expect(r.credits).toBeCloseTo(71.9658);
    expect(r.creditsPartial).toBe(true);
    expect(windowForecast(c).perHour).toBe(12.5);
    expect(windowForecast(c).projected).toBeNull();
  });
  it("calculates #62-style cumulative averages without treating the first recorded 16% as zero", () => {
    const c = cycle({ is_active: false, first_percent: 16, peak_percent: 39, end_percent: 39,
      work_to_ts: new Date(start + 8 * hour).toISOString() });
    const r = windowRates(c, windowData(c, 922_830_000, 1068.90, 26091.32));
    expect(r.tokens).toBeCloseTo(922_830_000 / 39);
    expect(r.api).toBeCloseTo(27.407692);
    expect(r.credits).toBeCloseTo(669.008205);
  });
  it("does not require calibration samples, a known plan or a previous window for a descriptive average", () => {
    const c = cycle({ is_active: false, sample_count: 1, plan_types: [], first_percent: 60 });
    expect(windowRates(c, windowData(c, 6000, 60, 600)).api).toBe(1);
  });
  it("refuses a different window's cached response, missing traffic and division by zero", () => {
    const c = cycle(), d = windowData(c, 6000, 60, 600);
    expect(windowRates(c, { ...d, until_ts: new Date(start).toISOString() }).api).toBeNull();
    expect(windowRates(c, { ...d, limit_id: "different" }).api).toBeNull();
    expect(windowRates(c, null).api).toBeNull();
    const zero = cycle({ peak_percent: 0, end_percent: 0 });
    expect(windowRates(zero, windowData(zero, 6000, 60, 600)).api).toBeNull();
  });
  it("keeps valid current values visible while comparison history is missing or fails", () => {
    const c = cycle({ is_active: false, first_percent: 0, peak_percent: 100, end_percent: 100,
      work_to_ts: new Date(start + 8 * hour).toISOString(), lag_fraction: 0.78, elapsed_hours: 8 });
    const d = windowData(c, 256_050_000, 308.23, 7196.58);
    const html = renderToStaticMarkup(<CodexWindowStats totals={d} rates={windowRates(c, d)} usedPercent={c.usedPercent}
      previousRates={null} historyRates={[]} loading={false} error={null}
      historyError="history unavailable" />);
    expect(html).toContain("≈ $3.08");
    expect(html).toContain("≈ 2.56M");
    expect(html).toContain("≥ 71.97");
    expect(html).toContain("comparison history read failed");
    expect(html).not.toContain("Rates require two consistent");
  });
  it("labels a partial-cost comparison as priced portions rather than complete allowance cost", () => {
    const c = cycle(), d = windowData(c, 6000, 60, 600);
    const r = windowRates(c, d);
    const html = renderToStaticMarkup(<CodexWindowStats totals={d} rates={r} usedPercent={c.usedPercent}
      previousRates={{ ...r, credits: r.credits! / 2 }} historyRates={[]} loading={false} error={null} />);
    expect(html).toContain("+100% priced part vs previous");
    expect(html).toContain("not a comparison of complete costs");
  });
});

describe("window status block", () => {
  it("shows both forecasts' state, the counters and unassigned samples without repeating tiles", () => {
    const c = cycle();
    const insight = {
      counterKey: "codex:codex:168h", label: "7d", parentLabel: null, isSublimit: false,
      current: { windowKey: String(c.index), usedPercent: 60, percentBasis: "measured", isCurrent: true, elapsedPercent: c.elapsedPercent,
        resetIso: c.resetIso, shape: null, trafficByMachine: [{ machine: "MAIN", amount: 93 }, { machine: "LAPTOP", amount: 7 }] },
      comparableClosedCount: 3, comparableWindows: [], baselineCount: 3, typicalAtElapsed: 44, typicalEndPercent: 100,
      deviationPp: 16, forecastPercent: 87, forecastEstimated: false, risk: "neutral", buildingHistory: false, fresh: true,
    } as unknown as WindowInsight;
    const html = renderToStaticMarkup(<WindowStatusCard cycle={c} insights={[insight]} account="codex1" totals={null}
      loading={false} error={null} remainingTokens={null} dailyMedian={null}
      ownershipGap={{ samples: 4, text: "Unassigned: 4 samples." }} />);
    expect(html).toContain("At reset");
    expect(html).toContain("typical 87%");
    // The reading in this fixture is weeks old, so the current-pace forecast asks for a new one.
    expect(html).toContain("refresh the limit reading");
    // A single counter repeats the Used and Until reset tiles, so the column leaves it out.
    expect(html).not.toContain(">7d</b>");
    expect(html).toContain("MAIN 93%");
    expect(html).toContain("unassigned samples: 4");
    expect(html).toContain('title="Unassigned: 4 samples."');
    expect(html).not.toContain("Usage in this window");
    const second = { ...insight, counterKey: "codex:codex:5h", label: "5h" } as WindowInsight;
    const both = renderToStaticMarkup(<WindowStatusCard cycle={c} insights={[insight, second]} account="codex1" totals={null}
      loading={false} error={null} remainingTokens={null} dailyMedian={null} ownershipGap={null} />);
    expect(both).toContain(">7d</b>");
    expect(both).toContain(">5h</b>");
  });
});

describe("selected window dates", () => {
  function render(c: ReturnType<typeof cycle>) {
    return renderToStaticMarkup(<WindowStatusCard cycle={c} insights={[]} account="codex1" totals={null}
      loading={false} error={null} remainingTokens={null} dailyMedian={null} ownershipGap={null} />);
  }
  it("shows the selected historical window's boundaries rather than the last reading or nominal reset", () => {
    const end = new Date(start + 24 * hour).toISOString();
    const c = cycle({ is_active: false, work_to_ts: end });
    c.number = 3;
    const markup = render(c);
    expect(markup).toContain("Window #3");
    expect(markup).toContain('dateTime="' + c.startIso + '"');
    expect(markup).toContain('dateTime="' + end + '"');
    expect(markup).not.toContain('dateTime="' + c.resetIso + '"');
    expect(markup).toContain("Window result");
    expect(markup).toContain("Pro · ×20");
    expect(markup).toContain("closed");
  });
  it("labels the active window end as scheduled reset and ignores a superseded cutoff", () => {
    const cutoff = new Date(start + 24 * hour).toISOString();
    const c = cycle({ work_to_ts: cutoff });
    const markup = render(c);
    expect(markup).toContain("Until reset");
    expect(markup).toContain('dateTime="' + c.resetIso + '"');
    expect(markup).not.toContain('dateTime="' + cutoff + '"');
  });
  it("scopes cycle history and reference medians to the selected window, excluding future cycles", () => {
    const current = cycle(), before = previous();
    expect(historyThroughCycle([current, before], before)).toEqual([before]);
    expect(cyclePlanLabel(cycle({ plan_types: ["prolite"] }))).toBe("Pro · ×5");
    expect(cyclePlanLabel(cycle({ plan_types: [] }))).toBeNull();
    const model = buildModel(emptySeries("codex1", 10080, [before.raw, current.raw]));
    const scoped = modelThroughCycle(model, before, []);
    expect(scoped.current).toBe(before);
    expect(scoped.cycles).toEqual([before]);
    expect(scoped.median.peakPercent).toBeNull();
  });
  it("renders a selected closed cycle without the live shadow counter or current forecast label", () => {
    const current = cycle(), before = previous();
    const model = buildModel(emptySeries("codex1", 10080, [before.raw, current.raw]));
    function SelectedSections() {
      const sections = useCodexSections({ model, chosen: before, account: "codex1", unit: "percent", project: "",
        openDrawer: () => {}, selectCycle: () => {}, windowRailInShell: true,
        card: { shadow: { index: 99, percent: 21, top_model: "future-shadow-model", sample_count: 40 } },
      } as unknown as ScreenProps);
      return <>{sections.lead}{sections.planWindows}{sections.history}</>;
    }
    const markup = renderToStaticMarkup(<SelectedSections />);
    expect(markup).toContain("Pro · ×20");
    expect(markup).toContain("Window result");
    expect(markup).toContain("Recorded traffic before window end");
    expect(markup).toContain("closed");
    expect(markup).not.toContain("future-shadow-model");
    expect(markup).not.toContain("Next reset");
    expect(markup).not.toContain("at reset: typical · pace");
    expect(markup).toContain("Selected first.");
  });
  it("updates the model share and displayed totals from one window's canonical model detail", () => {
    const c = cycle(), d = data(c);
    d.model_detail = { basis: "dated-standard-reference", excluded_mirror_events: 1, excluded_counter_events: 0, unknown_speed_tokens: 0, invalid_token_events: 0,
      rows: [{ model: "astra", speed: "standard", first: c.startIso, last: c.endIso, calls: 50, input: 3500, cached: 3000, cache_write: 0,
        output: 500, reasoning: 300, tokens: 4000, long_context: false, api: { total: 400 } as any, credits: null, actual_api: 400, actual_credits: null, unpriced_reason: null }] };
    const updated = withWindowTraffic(c, d);
    expect(updated.tokensTotal).toBe(4000);
    expect(updated.raw.tokens.total).toBe(4000);
    expect(updated.raw.model_usage).toEqual([{ name: "astra", calls: 50, tokens: 4000, fresh: 1000, usd: 400 }]);
    expect(updated.raw.usd_per_percent).toBeCloseTo(400 / 60);
  });
});
