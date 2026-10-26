import { describe, expect, it } from "bun:test";
import type { ApiCycle, ApiPoint } from "./api";
import { buildModel, emptySeries, sameCodexWindow, type CycleView } from "./cycle";
import {
  allowanceSummary, anomalyLanes, findAnomalies, heatScale, niceCeil, orderAnomalies, typicalCourse, type Anomaly,
} from "./cycle-insights";

const DAY = 86_400_000;
const start = Date.parse("2026-06-01T00:00:00Z");

/** A closed weekly cycle; `span` pp of meter increase over `tokens` tokens gives its calibrated allowance. */
function apiCycle(index: number, overrides: Partial<ApiCycle> & { span?: number; quality?: "high" | "medium" | "low" } = {}): ApiCycle {
  const { span = 100, quality = "high", ...rest } = overrides;
  const from = start + index * 7 * DAY;
  const steps = quality === "high" ? 80 : quality === "medium" ? 40 : 5;
  return {
    index, limit_id: "codex", label: new Date(from).toISOString().slice(0, 10), anchor: (from + 7 * DAY) / 1000,
    resets_at_iso: new Date(from + 7 * DAY).toISOString(), window_start_iso: new Date(from).toISOString(),
    is_active: false, shadow: false, status: "reset", start_ts: new Date(from).toISOString(), end_ts: new Date(from + 7 * DAY).toISOString(),
    work_from_ts: new Date(from).toISOString(), work_to_ts: new Date(from + 7 * DAY).toISOString(),
    sample_count: 200, lag_fraction: quality === "low" ? 0.3 : 0, distinct_steps: steps,
    first_percent: 0, peak_percent: span, end_percent: span, hit_100: span >= 100, window_hours: 168, elapsed_hours: 168,
    observed_hours: 168, remaining_hours: null, pace_percent_per_day: span / 7, projected_end_percent: null, eta_100_iso: null,
    calls: 10, usd: 1, usd_per_percent: null, usd_at_100_percent: null,
    tokens: { in: 0, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: 1000 },
    top_model: "gpt", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
    ...rest,
  };
}
it("equal reset timestamps cannot join a 30-day reading to a weekly cycle", () => {
  const weekly = apiCycle(0);
  const live = { used_percent: 100, ts: weekly.end_ts!, age_minutes: 0, window_minutes: 43200, resets_at_iso: weekly.resets_at_iso };
  expect(sameCodexWindow(live, weekly)).toBe(false);
  expect(sameCodexWindow(live, { ...weekly, window_hours: 720 })).toBe(true);
});

const withAllowance = (index: number, allowance: number, extra: Partial<ApiCycle> & { span?: number; quality?: "high" | "medium" | "low" } = {}) => {
  const span = extra.span ?? 100;
  return apiCycle(index, { ...extra, span, tokens: { in: 0, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: (allowance * span) / 100 } });
};

describe("canonical allowance median (decision 6)", () => {
  it("takes only the newest plan's samples of at least 20 pp with medium or high confidence", () => {
    const model = buildModel(emptySeries("codex1", 10080, [
      withAllowance(1, 100, { plan_types: ["plus"] }),
      withAllowance(2, 1000),
      withAllowance(3, 3000, { span: 50, quality: "medium" }),
      withAllowance(4, 90_000, { span: 30, quality: "low" }),
      withAllowance(5, 100_000, { span: 30, quality: "low" }),
      withAllowance(6, 2000),
    ]));
    const summary = allowanceSummary(model);
    // Every calibrated window (the old Analytics median) and the last ten (the old Patterns median) give 2,500.
    expect(model.median.allowanceTokens).toBe(2500);
    expect(summary.median).toMatchObject({ value: 2000, count: 3, plan: "Pro · ×20" });
    expect(summary.latest?.index).toBe(6);
    expect(summary.lowConfidence).toBe(2);
    expect(summary.quartiles).toBeNull();
  });

  it("gives the middle half from four values and flags only reliable samples outside the usual range", () => {
    const model = buildModel(emptySeries("codex1", 10080, [
      withAllowance(1, 1000), withAllowance(2, 1100), withAllowance(3, 1200), withAllowance(4, 1300), withAllowance(5, 9000),
      withAllowance(6, 100_000, { span: 30, quality: "low" }),
    ]));
    const summary = allowanceSummary(model);
    expect(summary.quartiles).toEqual({ q1: 1100, q3: 1300 });
    const allowance = findAnomalies(model, summary).filter((a) => a.kind === "allowance");
    expect(allowance.map((a) => a.cycle.index)).toEqual([5]);
  });
});

describe("anomaly order and lanes", () => {
  const cycle = (index: number) => ({ index }) as CycleView;
  const anomaly = (kind: Anomaly["kind"], index: number, score: number): Anomaly => ({ kind, cycle: cycle(index), ratio: null, score });
  it("puts exhaustions first, then near-exhaustions, newest first, then the rest by score", () => {
    const ordered = orderAnomalies([
      anomaly("allowance", 9, 2.9), anomaly("exhausted", 3, 7), anomaly("pace", 4, 12), anomaly("near", 8, 4),
      anomaly("exhausted", 7, 5), anomaly("lag", 10, 1.5), anomaly("tokens", 5, 3.1),
    ]);
    expect(ordered.map((a) => `${a.kind}#${a.cycle.index}`)).toEqual([
      "exhausted#7", "exhausted#3", "near#8", "pace#4", "tokens#5", "allowance#9", "lag#10",
    ]);
  });
  it("groups the anomalies into one lane per kind in lane order", () => {
    const lanes = anomalyLanes([anomaly("tokens", 2, 3), anomaly("exhausted", 4, 5), anomaly("tokens", 6, 3)]);
    expect(lanes).toEqual([{ kind: "exhausted", indices: [4] }, { kind: "tokens", indices: [2, 6] }]);
  });
});

describe("typical course", () => {
  it("averages the closed windows every 5% and counts the windows behind each point", () => {
    const point = (cycle: number, progress: number, percent: number): ApiPoint => ({
      ts: new Date(start + cycle * 7 * DAY + progress * 0.07 * DAY).toISOString(), ts_last: "", cycle, percent, percent_min: percent, percent_last: percent,
      samples: 1, cycle_progress: progress,
    });
    // Window 2 resets at half its time; only window 1 reaches the end.
    const series = { ...emptySeries("codex1", 10080, [apiCycle(1), apiCycle(2)]),
      points: [point(1, 0, 0), point(1, 100, 100), point(2, 0, 0), point(2, 50, 20)] };
    const course = typicalCourse(buildModel(series));
    expect(course.find((p) => p.t === 50)).toEqual({ t: 50, v: 35, windows: 2 });
    expect(course.find((p) => p.t === 100)).toEqual({ t: 100, v: 100, windows: 1 });
    expect(typicalCourse(buildModel(emptySeries("codex1", 10080, [apiCycle(1)])))).toEqual([]);
  });
});

describe("chart helpers", () => {
  it("rounds an axis maximum to a readable value", () => {
    expect(niceCeil(7.06e9)).toBe(1e10);
    expect(niceCeil(1.7)).toBe(2);
    expect(niceCeil(2.4)).toBe(2.5);
    expect(niceCeil(0)).toBe(1);
  });
  it("splits active hours into five equal steps and leaves silent hours out", () => {
    const scale = heatScale([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scale.edges).toEqual([1, 2, 4, 6, 8, 10]);
    expect([0, 1, 2, 3, 5, 9, 10].map(scale.level)).toEqual([-1, 0, 0, 1, 2, 4, 4]);
  });
});
