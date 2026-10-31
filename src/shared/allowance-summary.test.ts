import { describe, expect, it } from "bun:test";
import type { CodexComparisonWindow as Window } from "./codex-accounting";
import type { ClaudeCapacityResult } from "./claude-capacity-result";
import { allowanceHeadline, allowanceRatios, summarizeAllowance } from "./allowance-summary";
import { capacityFull } from "./capacity-value";

const AS_OF = "2026-10-30T12:00:00Z";
type Model = { name: string; api: number; tokens?: number };

/**
 * One weekly cycle from `start` whose 100% value is `full` API dollars and 4 × `full` M tokens, measured on `pp` of the
 * meter; `models` split its API Standard value.
 */
function cycle(start: string, full: number, opts: { pp?: number; models?: Model[]; days?: number; over?: Partial<Window> } = {}): Window {
  const pp = opts.pp ?? 100, api = full * pp / 100, tokens = full * 4e6 * pp / 100;
  const end = new Date(Date.parse(start) + (opts.days ?? 7) * 86_400_000).toISOString();
  const usage = { events: 100, unpriced_events: 0, tokens, input: tokens * 0.9, cached: tokens * 0.8, output: tokens * 0.1, fast_tokens: 0,
    unknown_tokens: 0, priced_tokens: tokens, api_standard: api, credits_low: api * 25, credits_high: api * 50 };
  const models = (opts.models ?? [{ name: "gpt-6.1-sol", api }]).map(model => ({ ...usage, name: model.name, api_standard: model.api,
    tokens: model.tokens ?? tokens * model.api / api, priced_tokens: model.tokens ?? tokens * model.api / api }));
  return { id: start, account: "codex1", plan: "pro", start, end, reset: end, cycle_start: start, cycle_end: end, window_minutes: 10080,
    start_percent: 0, end_percent: pp, observed_pp: pp, probes: 10, max_gap_hours: 1, usage, sources: [], models, ...opts.over };
}

describe("allowance months", () => {
  it("takes Capacity's own value, months by UTC cycle start, and counts each unit on its own", () => {
    const windows = [cycle("2026-09-30T23:30:00Z", 1500), cycle("2026-10-01T08:00:00Z", 1100), cycle("2026-10-08T08:00:00Z", 1200),
      cycle("2026-10-15T08:00:00Z", 900, { over: { usage: { ...cycle("2026-01-01T00:00:00Z", 1).usage, events: 50, unpriced_events: 50 } } })];
    const summary = summarizeAllowance(windows, { asOf: AS_OF });
    expect(summary.months.map(month => month.month)).toEqual(["2026-09", "2026-10"]);
    const october = summary.months[1]!;
    // The unpriced cycle has tokens but no dollar value.
    expect([october.api_standard.n, october.tokens.n]).toEqual([2, 3]);
    expect(october.api_standard.median).toBe(1150);
    expect([october.api_standard.min, october.api_standard.max]).toEqual([1100, 1200]);
    expect(october.api_standard.median).toBe((capacityFull(windows[1]!, "api_standard")! + capacityFull(windows[2]!, "api_standard")!) / 2);
    expect(october.cycles).toEqual(["2026-10-01T08:00:00Z", "2026-10-08T08:00:00Z", "2026-10-15T08:00:00Z"]);
  });

  it("a cycle starting at 23:30 on Oct 31 is October, and a missing cycle_start falls back to start", () => {
    const late = cycle("2026-10-31T23:30:00Z", 1000, { over: { cycle_start: undefined } });
    const summary = summarizeAllowance([late], { asOf: "2026-11-20T00:00:00Z" });
    expect(summary.months.map(month => month.month)).toEqual(["2026-10"]);
  });

  it("keeps the open cycle apart, only when the range holds today, and keeps n = 1 months", () => {
    const open = cycle("2026-10-29T10:00:00Z", 1253, { pp: 17 });
    const summary = summarizeAllowance([cycle("2026-10-01T08:00:00Z", 1100), open], { asOf: AS_OF, since: "2026-10-01", until: "2026-10-31" });
    expect(summary.partial).toMatchObject({ id: open.id, observed_pp: 17 });
    expect(summary.partial!.api_standard).toBeCloseTo(1253, 6);
    expect(summary.months[0]!.api_standard).toMatchObject({ n: 1, median: 1100 });
    expect(summary.months[0]!.cycles).not.toContain(open.id);
    expect(summarizeAllowance([open], { asOf: AS_OF, since: "2026-09-01", until: "2026-09-30" }).partial).toBeNull();
    expect(summarizeAllowance([open], { asOf: AS_OF, since: "2026-11-01", until: "2026-11-30" }).partial).toBeNull();
  });

  it("selects closed cycles by start, not overlap, and reconciles the capacity ledger", () => {
    const windows = [cycle("2026-09-28T08:00:00Z", 1300), cycle("2026-10-02T08:00:00Z", 1000, { pp: 39 }),
      cycle("2026-10-03T08:00:00Z", 1000, { over: { plan_detail: { label: "Plus → Pro", multiplier: null, status: "mixed" } } }),
      cycle("2026-10-04T08:00:00Z", 1000, { over: { declared_plan_meter_mismatch: true } }),
      cycle("2026-10-05T08:00:00Z", 1000, { over: { window_minutes: 300 } }),
      cycle("2026-10-06T08:00:00Z", 1000, { over: { cycle_end_basis: "uncertain" } }),
      cycle("2026-10-07T08:00:00Z", 1000, { over: { manual_measurement: { id: "m1", approximate_time: true, note: "" } } })];
    const summary = summarizeAllowance([...windows, windows[0]!], { asOf: AS_OF, since: "2026-10-01", until: "2026-10-31" });
    expect(summary.closed).toBe(6);
    expect(summary.excluded).toEqual({ below_min_pp: 1, mixed_plan: 1, plan_meter_mismatch: 1, not_weekly: 1 });
    expect(summary.eligible + Object.values(summary.excluded).reduce((sum, n) => sum + n!, 0)).toBe(summary.closed);
    expect(summary.notes).toEqual({ uncertain_end: 1, manual: 1 });
    expect(summary.months[0]!.cycles).toEqual(["2026-10-06T08:00:00Z", "2026-10-07T08:00:00Z"]);
  });

  it("marks a lower-bound dollar value and keeps dated plans apart", () => {
    const partial = cycle("2026-10-10T08:00:00Z", 1000, { over: { plan: "plus" } });
    partial.usage = { ...partial.usage, unpriced_events: 5 };
    const summary = summarizeAllowance([cycle("2026-10-01T08:00:00Z", 1100), partial], { asOf: AS_OF });
    expect(summary.months[0]!.api_standard.lower_bound).toBe(true);
    expect(summary.months[0]!.tokens.lower_bound).toBe(false);
    expect(summary.months[0]!.plans).toEqual(["pro", "plus"]);
  });

  it("uses the normalised API value Capacity uses for the allowance", () => {
    const normalised = cycle("2026-10-01T08:00:00Z", 1000);
    normalised.usage = { ...normalised.usage, api_normalized: 800 };
    expect(summarizeAllowance([normalised], { asOf: AS_OF }).months[0]!.api_standard.median).toBe(800);
  });
});

describe("ratios and headline", () => {
  const months = (values: Array<[string, number[]]>, over: Partial<Window> = {}) =>
    values.flatMap(([month, fulls]) => fulls.map((full, index) => cycle(`${month}-0${index + 1}T08:00:00Z`, full, { over })));
  it("divides B by A per month, refuses a zero A, and takes the latest well-sampled exact month as the headline", () => {
    const a = summarizeAllowance(months([["2026-09", [1400, 1460]], ["2026-10", [1100, 1128]], ["2026-08", [0]]]), { asOf: AS_OF });
    const b = summarizeAllowance(months([["2026-09", [2245, 2245]], ["2026-10", [2648]], ["2026-08", [2900]]]), { asOf: AS_OF });
    const ratios = allowanceRatios(a, b, "api_standard");
    expect(ratios.map(ratio => ratio.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    // A $0 allowance on A's side gives no ratio rather than an infinite one.
    expect(ratios[0]).toMatchObject({ ratio: null, a: 0 });
    expect(ratios[1]!.ratio).toBeCloseTo(2245 / 1430, 6);
    expect(ratios[2]!.min_n).toBe(1);
    expect(allowanceHeadline(ratios)?.month).toBe("2026-09");
  });
  it("calls a ratio over a lower bound approximate and keeps it out of the headline", () => {
    const unpriced = { usage: { ...cycle("2026-01-01T00:00:00Z", 1).usage, unpriced_events: 3 } };
    const a = summarizeAllowance(months([["2026-10", [1000, 1000]]], unpriced), { asOf: AS_OF });
    const b = summarizeAllowance(months([["2026-10", [2000, 2000]]]), { asOf: AS_OF });
    const ratios = allowanceRatios(a, b, "api_standard");
    expect(ratios[0]).toMatchObject({ approximate: true, min_n: 2 });
    expect(allowanceHeadline(ratios)).toBeNull();
    expect(allowanceRatios(a, b, "tokens")[0]!.approximate).toBe(false);
  });
});

describe("dominant model groups", () => {
  it("groups by the model carrying ≥ 70% of API Standard and divides Σ API by Σ priced tokens", () => {
    const windows = [
      cycle("2026-10-01T08:00:00Z", 1300, { models: [{ name: "gpt-6-astra", api: 1200 }, { name: "gpt-6.1-sol", api: 100 }] }),
      cycle("2026-10-08T08:00:00Z", 1300, { models: [{ name: "gpt-6-astra", api: 1300 }] }),
      cycle("2026-10-15T08:00:00Z", 1100, { models: [{ name: "gpt-6.1-sol", api: 700 }, { name: "gpt-6-astra", api: 400 }] }),
      cycle("2026-10-22T08:00:00Z", 1100, { models: [{ name: "gpt-6.1-sol", api: 1100 }] }),
    ];
    const summary = summarizeAllowance(windows, { asOf: AS_OF });
    expect(summary.models.map(group => [group.model, group.n, group.thin])).toEqual([["gpt-6-astra", 2, false], ["gpt-6.1-sol", 1, true]]);
    expect(summary.dominance_excluded).toEqual({ below_threshold: 1 });
    const astra = summary.models[0]!;
    expect(astra.usd_per_million).toBeCloseTo((1300 + 1300) / (5.2e9 + 5.2e9) * 1e6, 9);
    expect(astra.n + summary.models[1]!.n + summary.dominance_excluded.below_threshold!).toBe(summary.eligible);
  });

  it("decides dominance on API Standard even where the allowance uses the normalised value", () => {
    const window = cycle("2026-10-01T08:00:00Z", 1000, { models: [{ name: "a", api: 650 }, { name: "b", api: 350 }] });
    window.usage = { ...window.usage, api_normalized: 2000 };
    window.models = window.models.map(model => ({ ...model, api_normalized: model.name === "a" ? 1900 : 100 }));
    expect(summarizeAllowance([window], { asOf: AS_OF }).dominance_excluded).toEqual({ below_threshold: 1 });
  });

  it("leaves out cycles with unpriced parts or a legacy Claude Code share sample", () => {
    const unpriced = cycle("2026-10-01T08:00:00Z", 1000);
    unpriced.usage = { ...unpriced.usage, unpriced_events: 2 };
    const shared = cycle("2026-10-08T08:00:00Z", 1000, { over: { account: "claude1", claude_code_capacity: {
      account: "claude1", window_id: "2026-10-08T08:00:00Z", api_value_basis: "standard", conditional: true, share_percent: 80, utilization_percent: 60,
      weekly_capacity_tokens: { value: 4e9, absent: null }, weekly_capacity_api_usd: { value: 1000, absent: null },
    } as unknown as Window["claude_code_capacity"] } });
    const summary = summarizeAllowance([unpriced, shared], { asOf: AS_OF });
    expect(summary.eligible).toBe(2);
    expect(summary.dominance_excluded).toEqual({ unpriced: 1, share_sample: 1 });
  });

  it("takes a Claude window's model mix from its prepared capacity sample, not the window's traffic", () => {
    const id = "2026-10-01T08:00:00Z";
    const prepared = { version: 1, account: "claude1", window_id: id, window_minutes: 10080, api_value_basis: "standard", basis: "code_share",
      conditional: true, coverage: null, reason: null, sample: null,
      capacity_tokens: { value: 6.9e9, absent: null }, capacity_api_usd: { value: 2600, absent: null },
      models: [{ model: "claude-opus-5-5", window: { calls: 10, usd: 900, gross: 2.5e9, fresh: 0, unpriced_calls: 0 } },
        { model: "claude-sonnet-5-5", window: { calls: 2, usd: 100, gross: 0.3e9, fresh: 0, unpriced_calls: 0 } }],
      price_reference_model: null, usage: { events: 12, tokens: 2.8e9, fresh: 0, api_usd: 1000, unpriced_events: 0 },
    } as unknown as ClaudeCapacityResult;
    // The window's own traffic says Sonnet; the prepared sample, which the value is computed on, says Opus.
    const window = cycle(id, 1000, { models: [{ name: "claude-sonnet-5-5", api: 1000 }], over: { account: "claude1", claude_capacity: prepared } });
    const summary = summarizeAllowance([window], { asOf: AS_OF });
    expect(summary.months[0]!.api_standard.median).toBe(2600);
    expect(summary.models.map(group => group.model)).toEqual(["claude-opus-5-5"]);
    expect(summary.models[0]!.usd_per_million).toBeCloseTo(1000 / 2.8e9 * 1e6, 9);
  });
});
