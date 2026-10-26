import { test, expect } from "bun:test";
import { codexWindowsFixture } from "./window-usage.fixture";
import { publishedCodexComparisonFixture } from "./codex-ledger.fixture";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import type { CalibrationEvent, CodexProbe } from "./codex-calibration";

const config = resolveCodexAccountingConfig({});
const compareCodexWindows = (config: ReturnType<typeof resolveCodexAccountingConfig>, events: CalibrationEvent[], probes: CodexProbe[],
  _scope?: undefined, minutes: 300 | 10080 | 43200 = 10080, referenceDay?: string, detailCycleId?: string) =>
  codexWindowsFixture(config, publishedCodexComparisonFixture(config, events), probes, minutes, referenceDay, detailCycleId);
const event = (patch: Partial<CalibrationEvent> = {}): CalibrationEvent => ({ account: "codex1", home: "MAIN",
  ts: "2026-09-08T01:00:00Z", model: "gpt-6-astra", speed: "standard", in_tok: 100000, cached_in: 80000, out_tok: 10000, cache_write: 0, ...patch });
const probe = (ts: string, used_percent: number, patch: Partial<CodexProbe> = {}): CodexProbe => ({ subject: "codex1", ts, used_percent,
  kind: "weekly", plan: "pro", resets_at: "2026-09-15T00:00:00Z", window_minutes: 10080, ...patch });
const endpoints = [probe("2026-09-08T00:00:00Z", 0), probe("2026-09-08T02:00:00Z", 100)];

test("a 30-day Free sample uses its own denominator and stops at the first 100%", () => {
  const monthly = [probe("2026-09-08T00:00:00Z", 0, { plan: "free", window_minutes: 43200, resets_at: "2026-10-08T00:00:00Z" }),
    probe("2026-09-08T02:00:00Z", 100, { plan: "free", window_minutes: 43200, resets_at: "2026-10-08T00:00:00Z" }),
    probe("2026-09-08T04:00:00Z", 100, { plan: "free", window_minutes: 43200, resets_at: "2026-10-08T00:00:00Z" })];
  const rows = [event({ meter_reset: Date.parse("2026-09-15T00:00:00Z") / 1000 }), event({ ts: "2026-09-08T03:00:00Z" }),
    event({ billing_mode: "credits" }), event({ account: "other" }), event({ model: "gpt-5.3-codex-spark" })];
  const [cycle] = compareCodexWindows(config, rows, [...endpoints, ...monthly], undefined, 43200);
  expect(cycle).toMatchObject({ plan: "free", window_minutes: 43200, observed_pp: 100, usage: { events: 1, tokens: 110000 }, cycle_usage: { events: 2, tokens: 220000 } });
  expect(cycle!.usage.api_standard).toBeCloseTo(0.78);
  expect(Date.parse(cycle!.end)).toBe(Date.parse("2026-09-08T02:00:00Z"));
});

test("on-demand timeline keeps exact event times and the same account, funding and reset cohort", () => {
  const rows = [event(), event({ home: "LAPTOP" }), event({ account: "other" }), event({ billing_mode: "credits" }),
    event({ model: "gpt-5.3-codex-spark" }), event({ meter_reset: Date.parse("2026-09-16") / 1000 }), event({ ts: "2026-09-08T03:00:00Z" })];
  const probes = [...endpoints, probe("2026-09-08T03:00:00Z", 100)];
  const normal = compareCodexWindows(config, rows, probes);
  expect(normal[0]!.timeline).toBeUndefined();
  const [detailed] = compareCodexWindows(config, rows, probes, undefined, 10080, undefined, normal[0]!.id);
  expect(detailed!.usage).toEqual(normal[0]!.usage);
  expect(detailed!.cycle_usage).toEqual(normal[0]!.cycle_usage);
  expect(detailed!.timeline!.readings).toHaveLength(3);
  expect(detailed!.timeline!.usage).toHaveLength(2);
  expect(detailed!.timeline!.usage[0]).toMatchObject({ ts: Date.parse(event().ts), events: 2, tokens: 220000 });
  expect(detailed!.timeline!.usage.reduce((sum, p) => sum + p.tokens, 0)).toBe(detailed!.cycle_usage!.tokens);
});

test("timeline does not invent a reading at the inferred cycle reset", () => {
  const probes = [probe("2026-09-08T02:00:00Z", 70)];
  const [normal] = compareCodexWindows(config, [event()], probes);
  const [detailed] = compareCodexWindows(config, [event()], probes, undefined, 10080, undefined, normal!.id);
  expect(detailed!.start_basis).toBe("reset");
  expect(detailed!.timeline!.readings).toEqual([{ ts: Date.parse(probes[0]!.ts), percent: 70, source: "probe" }]);
});

test("simultaneous 5h and weekly counters stay separate, and event weekly anchors do not erase 5h usage", () => {
  const five = [probe("2026-09-08T00:00:00Z", 0, { window_minutes: 300, resets_at: "2026-09-08T05:00:00Z" }),
    probe("2026-09-08T02:00:00Z", 40, { window_minutes: 300, resets_at: "2026-09-08T05:00:00Z" })];
  const events = [event({ meter_reset: Date.parse("2026-09-15T00:00:00Z") / 1000 }), event({ billing_mode: "credits" }), event({ model: "gpt-5.3-codex-spark" })];
  const weekly = compareCodexWindows(config, events, [...endpoints, ...five]);
  const short = compareCodexWindows(config, events, [...endpoints, ...five], undefined, 300);
  expect(short).toHaveLength(1); expect(weekly).toHaveLength(1);
  expect(short[0]).toMatchObject({ window_minutes: 300, observed_pp: 40, usage: { events: 1, tokens: 110000 } });
  expect(weekly[0]).toMatchObject({ window_minutes: 10080, observed_pp: 100, usage: { events: 1 } });
  expect(short[0]!.usage.api_standard).toBeCloseTo(0.78);
});

test("combines both PCs in one account; preserves known Fast and bounds unknown mode", () => {
  const [w] = compareCodexWindows(config, [event(), event({ home: "LAPTOP", speed: "fast" }), event({ speed: "unknown" }),
    event({ account: "other" }), event({ model: "gpt-5.3-codex-spark" })], endpoints);
  expect(w!.observed_pp).toBe(100);
  expect(w!.usage.events).toBe(3);
  expect(w!.usage.tokens).toBe(330000);
  expect(w!.usage.api_standard).toBeCloseTo(2.34);
  expect(w!.usage.api_normalized).toBeCloseTo(3.51);
  expect(w!.cycle_usage!.api_normalized).toBeCloseTo(3.51);
  expect(w!.models.reduce((n, m) => n + (m.api_normalized ?? 0), 0)).toBeCloseTo(3.51);
  expect(w!.sources.reduce((n, s) => n + (s.api_normalized ?? 0), 0)).toBeCloseTo(3.51);
  expect(w!.usage.credits_low).toBeCloseTo(19.5 * 4.5);
  expect(w!.usage.credits_high).toBeCloseTo(19.5 * 6);
  expect(w!.sources).toHaveLength(2);
  expect(w!.sources.reduce((n, s) => n + s.credits_low, 0)).toBeCloseTo(w!.usage.credits_low);
});

test("cycle model detail includes post-saturation traffic, cache and unpriced reasons without changing the meter cohort", () => {
  const rows = [event({ speed: "fast" }), event({ model: "codex-auto-review" }),
    event({ ts: "2026-09-08T03:00:00Z", model: "gpt-5.6-luna", speed: "unknown", cache_write: 7 }),
    event({ account: "other" }), event({ model: "gpt-5.3-codex-spark" })];
  const [base] = compareCodexWindows(config, rows, endpoints);
  const [cycle] = compareCodexWindows(config, rows, endpoints, undefined, 10080, undefined, base!.id);
  const models = cycle!.timeline!.models!;
  expect(models.map(row => row.name).sort()).toEqual(["codex-auto-review", "gpt-5.6-luna", "gpt-6-astra"]);
  for (const key of ["events", "tokens", "input", "cached", "output", "api_standard", "credits_low", "unpriced_events"] as const)
    expect(models.reduce((sum, model) => sum + model[key], 0)).toBeCloseTo(cycle!.cycle_usage![key]);
  expect(cycle!.usage).toEqual(base!.usage);
  expect(cycle!.models.some(row => row.name === "gpt-5.6-luna")).toBe(false);
  expect(models.find(row => row.name === "gpt-5.6-luna")).toMatchObject({ cache_write: 7, pricing_issues: { cache_write_semantics_unknown: { events: 1, tokens: 110000 } } });
  expect(models.find(row => row.name === "codex-auto-review")).toMatchObject({ cache_write: 0, pricing_issues: { missing_rate: { events: 1, tokens: 110000 } } });
  expect(models.find(row => row.name === "gpt-6-astra")!.credits_low).toBeCloseTo(48.75);
});
test("capacity normalization uses the configured 2x credit burden independently of the Fast API premium", () => {
  const custom = { ...config, rules: config.rules.map(rule => rule.speed !== "fast" || rule.model !== "gpt-6-astra" ? rule : {
    ...rule, multiplier: rule.billing_basis === "chatgpt_credits" ? 2 : 1,
    ...(rule.billing_basis === "api_equivalent_usd" ? {
      rates: Object.fromEntries(Object.entries(rule.rates).map(([key,value])=>[key,value === undefined ? value : value * 4.5])) as typeof rule.rates,
      ...(rule.long_context ? {long_context:{...rule.long_context,rates:Object.fromEntries(Object.entries(rule.long_context.rates).map(([key,value])=>[key,value === undefined ? value : value * 4.5])) as typeof rule.rates}} : {}),
    } : {}),
  }) };
  const [w] = compareCodexWindows(custom, [event(), event({ speed: "fast" })], endpoints);
  expect(w!.usage.api_standard).toBeCloseTo(1.56);
  expect(w!.usage.api_normalized).toBeCloseTo(2.34);
  expect(w!.usage.tokens).toBe(220000);
});
test("missing prices stay visible in coverage and do not masquerade as complete zero-valued usage", () => {
  const [w] = compareCodexWindows(config, [event(), event({ model: "gpt-6-astra-auto-review" }), event({ cache_write: 1 })], endpoints);
  expect(w!.usage.events).toBe(3); expect(w!.usage.unpriced_events).toBe(2);
  expect(w!.usage.priced_tokens).toBe(110000); expect(w!.usage.tokens).toBe(330000);
  expect(w!.usage.credits_low).toBeCloseTo(19.5);
});
test("stops at first 100%, excludes start boundary, ignores 5h counters and missing reset anchors", () => {
  const [w] = compareCodexWindows(config, [event({ ts: endpoints[0]!.ts }), event({ ts: endpoints[1]!.ts }), event({ ts: "2026-09-08T03:00:00Z" })],
    [...endpoints, probe("2026-09-08T03:00:00Z", 100), probe("2026-09-08T04:00:00Z", 0, { window_minutes: 300 }), probe("2026-09-08T05:00:00Z", 0, { resets_at: null })]);
  expect(w!.end).toBe("2026-09-08T02:00:00.000Z"); expect(w!.usage.events).toBe(1);
});
test("separates resets and real counter drops without a plan-label cut; tolerates two-PC wobble", () => {
  const windows = compareCodexWindows(config, [], [
    probe("2026-09-08T00:00:00Z", 0), probe("2026-09-08T01:00:00Z", 30),
    probe("2026-09-08T01:01:00Z", 29, { resets_at: "2026-09-15T00:01:00Z" }),
    probe("2026-09-08T02:00:00Z", 40), probe("2026-09-08T03:00:00Z", 0), probe("2026-09-08T04:00:00Z", 10),
    probe("2026-09-08T05:00:00Z", 0, { resets_at: "2026-09-15T05:00:00Z" }), probe("2026-09-08T06:00:00Z", 15, { resets_at: "2026-09-15T05:00:00Z" }),
    probe("2026-09-08T07:00:00Z", 0, { plan: "plus" }), probe("2026-09-08T08:00:00Z", 20, { plan: "plus" }),
  ]);
  expect(windows.map(w => w.observed_pp)).toEqual([40, 10, 15]);
});

test("a first reading at 70% prices the whole cycle from reset, including earlier sessions", () => {
  const [w] = compareCodexWindows(config, [event({ ts: "2026-09-08T00:00:00Z" }), event(), event({ home: "LAPTOP" })],
    [probe("2026-09-08T02:00:00Z", 70)]);
  expect(w).toMatchObject({ start: "2026-09-08T00:00:00.000Z", start_basis: "reset", start_percent: 0, end_percent: 70, observed_pp: 70,
    first_probe: { ts: "2026-09-08T02:00:00.000Z", percent: 70 } });
  expect(w!.usage.events).toBe(3);
  expect(w!.usage.api_standard / w!.observed_pp * 100).toBeCloseTo(2.34 / 70 * 100);
});

test("keeps whole-cycle totals separate from the maximum meter-aligned calculation", () => {
  const [w] = compareCodexWindows(config, [event(), event({ ts: "2026-09-08T04:00:00Z" }), event({ ts: "2026-09-08T06:00:00Z" })], [
    probe("2026-09-08T02:00:00Z", 34), probe("2026-09-08T03:00:00Z", 70),
    probe("2026-09-08T06:01:00Z", 0, { resets_at: "2026-09-15T06:00:00Z" }),
    probe("2026-09-08T07:00:00Z", 5, { resets_at: "2026-09-15T06:00:00Z" }),
  ]);
  expect(w).toMatchObject({ observed_pp: 70, cycle_start: "2026-09-08T00:00:00.000Z", cycle_end: "2026-09-08T06:00:00.000Z", cycle_end_basis: "reset", unpaired_events: 1 });
  expect(w!.cycle_usage!.events).toBe(2);
  expect(w!.usage.events).toBe(1);
});

test("delayed probes from a superseded reset do not split 0–66% into fragments", () => {
  const reset = { resets_at: "2026-09-15T03:00:00Z" };
  const windows = compareCodexWindows(config, [event({ ts: "2026-09-08T04:30:00Z" })], [
    probe("2026-09-08T01:00:00Z", 60), probe("2026-09-08T02:00:00Z", 70),
    probe("2026-09-08T03:01:00Z", 0, reset), probe("2026-09-08T04:00:00Z", 48, reset),
    probe("2026-09-08T04:10:00Z", 70), probe("2026-09-08T04:40:00Z", 48, reset),
    probe("2026-09-08T05:00:00Z", 66, reset),
  ]);
  expect(windows).toHaveLength(2);
  expect(windows[1]).toMatchObject({ start_percent: 0, end_percent: 66, observed_pp: 66, probes: 4 });
  expect(windows[1]!.usage.events).toBe(1);
});

test("the register's confirmed reset baseline pairs from the reset, whatever range a screen shows", () => {
  const windows = compareCodexWindows(config, [], [probe("2026-09-08T01:00:00Z", 34), probe("2026-09-08T02:00:00Z", 70)]);
  expect(windows[0]).toMatchObject({ start_percent: 0, observed_pp: 70, start_basis: "reset" });
});

test("a gap in history never stretches an expired cycle to the next observed cycle", () => {
  const windows = compareCodexWindows(config, [], [probe("2026-09-08T01:00:00Z", 70),
    probe("2026-09-20T01:00:00Z", 20, { resets_at: "2026-09-27T00:00:00Z" })]);
  expect(windows).toHaveLength(2);
  expect(windows[0]).toMatchObject({ cycle_end: "2026-09-15T00:00:00.000Z", cycle_end_basis: "reset" });
  expect(windows[1]!.cycle_start).toBe("2026-09-20T00:00:00.000Z");
});


test("Business, extra credits and a parallel meter cannot inflate subscription capacity", () => {
  const probe = (ts: string, used_percent: number) => ({ subject: "p", ts, used_percent, plan: "pro", kind: "weekly", window_minutes: 10080, resets_at: "2026-09-15T00:00:00Z" });
  const base = { account: "p", home: "/home", ts: "2026-09-08T01:00:00Z", model: "gpt-6-astra", speed: "standard", in_tok: 100, cached_in: 0, cache_write: 0, out_tok: 10 };
  const rows = [base, { ...base, billing_mode: "business_credits" }, { ...base, billing_mode: "credits" },
    { ...base, meter_reset: Date.parse("2026-09-15T03:00:00Z") / 1000 }];
  const windows = compareCodexWindows(resolveCodexAccountingConfig({}), rows,
    [probe("2026-09-08T00:00:00Z", 0), probe("2026-09-08T02:00:00Z", 10)]);
  expect(windows[0]!.usage.events).toBe(1);
  expect(windows[0]!.observed_pp).toBe(10);
});

test("before credit billing began an API value alone prices the event, and credits read as unavailable", () => {
  // gpt-5.3-codex ran from February 2026; Codex only started charging credits on 2026-04-02.
  const before = [event({ ts: "2026-03-10T01:00:00Z", model: "gpt-5.3-codex" })];
  const window = compareCodexWindows(config, before, [probe("2026-03-10T00:00:00Z", 0, { resets_at: "2026-03-17T00:00:00Z" }),
    probe("2026-03-10T02:00:00Z", 100, { resets_at: "2026-03-17T00:00:00Z" })])[0]!;
  expect(window.usage.unpriced_events).toBe(0);
  expect(window.usage.api_standard).toBeGreaterThan(0);
  expect(window.usage.api_normalized).toBe(window.usage.api_standard);
  expect(window.usage.priced_tokens).toBe(window.usage.tokens);
  expect(window.usage.credits_unavailable_events).toBe(window.usage.events);
  // A credit total of zero would be an invention, so the columns stay empty rather than zeroed.
  expect(window.usage.credits_low).toBe(0);

  // Once credits exist, a model without a credit rule is a real gap and stays unpriced.
  const after = [event({ ts: "2026-04-10T01:00:00Z", model: "gpt-5.2-codex" })];
  const later = compareCodexWindows(config, after, [probe("2026-04-10T00:00:00Z", 0, { resets_at: "2026-04-17T00:00:00Z" }),
    probe("2026-04-10T02:00:00Z", 100, { resets_at: "2026-04-17T00:00:00Z" })])[0]!;
  expect(later.usage.unpriced_events).toBe(later.usage.events);
  expect(later.usage.credits_unavailable_events ?? 0).toBe(0);
});

test("reserve traffic is funded beside the allowance, so it leaves the counter and the cycle totals", () => {
  const allowance = event({ ts: "2026-09-08T01:00:00Z" });
  const reserve = event({ ts: "2026-09-08T01:30:00Z", model: "gpt-reserve" });
  const [window] = compareCodexWindows(config, [allowance, reserve], endpoints);
  expect(window!.usage.events).toBe(1);
  expect(window!.cycle_usage!.events).toBe(1);
  expect(window!.evidence!.excluded_events.funding).toBe(1);
  // Spark keeps its own reason: a separate counter is not separate funding.
  const [spark] = compareCodexWindows(config, [event({ model: "gpt-5.3-codex-spark" })], endpoints);
  expect(spark!.evidence!.excluded_events.counter).toBe(1);
});
