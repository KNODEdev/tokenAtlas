import { expect, test } from "bun:test";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import { emptyWindowEvidence } from "../../server/subscription-evidence";
import { battleRows, catalogTiers, deriveSources, readBattlePicks, writeBattlePicks, type PlanPick } from "./capacity-battle";

/** A weekly cycle that used `usd` of API value over 50 pp: a full window of 2 × usd. */
function cycle(id: string, usd: number, multiplier: number | null, observedPp = 50): CodexComparisonWindow {
  const start = "2026-09-01T00:00:00Z", reset = "2026-09-08T00:00:00Z";
  return { id, account: "a", plan: "pro", window_minutes: 10080, start, end: reset, reset, cycle_start: start, cycle_end: reset,
    start_percent: 0, end_percent: observedPp, observed_pp: observedPp, probes: 20, max_gap_hours: 0.25,
    usage: { ...emptyWindowUsage(), events: 20, tokens: 500_000, input: 400_000, cached: 300_000, output: 100_000, priced_tokens: 500_000, api_standard: usd, credits_low: usd * 20, credits_high: usd * 20 },
    sources: [], models: [], plan_detail: { status: "resolved", label: "Pro", multiplier }, evidence: emptyWindowEvidence(),
    promotion: { status: "configured", factor: 1, regime_ids: [], notes: [], sources: [] } } as CodexComparisonWindow;
}
const windows = (...list: CodexComparisonWindow[]) => new Map(list.map(window => [window.id, window]));

test("catalog tiers carry the newest price; Claude Pro is the ×1 base", () => {
  expect(catalogTiers("claude", "2026-10-10")).toEqual([
    { tier: 1, label: "Pro", usdPerMonth: 20 }, { tier: 5, label: "Max", usdPerMonth: 100 }, { tier: 20, label: "Max", usdPerMonth: 200 }]);
  expect(catalogTiers("codex", "2026-10-10").map(tier => tier.tier)).toEqual([1, 5, 20]);
});

test("partial-price cycles cannot become exact plan medians or a battle winner", () => {
  const partial = cycle("partial", 900, 20);
  partial.usage.unpriced_events = 1;
  const rows = battleRows(windows(partial), { "codex:20": { cycles: ["partial"], from: null } }, "api_standard", "observed", 10080);
  expect(rows.find(row => row.tier === 20)!.cells.codex).toMatchObject({ counted: 0, value: null });
  expect(rows.find(row => row.tier === 20)!.winner).toBeNull();
});

test("a plan shows only its attached cycles; nothing attached stays empty", () => {
  const all = windows(cycle("x1", 40, 1), cycle("x20a", 700, 20), cycle("x20b", 800, 20), cycle("c20", 1200, 20));
  const picks: Record<string, PlanPick> = { "codex:20": { cycles: ["x20a", "x20b"], from: null }, "claude:20": { cycles: ["c20"], from: null } };
  const rows = battleRows(all, picks, "api_standard", "observed", 10080);
  expect(rows.map(row => [row.tier, row.cells.codex?.value, row.cells.codex?.source, row.cells.claude?.value, row.cells.claude?.source])).toEqual([
    [1, null, "empty", null, "empty"], [5, null, "empty", null, "empty"], [20, 1500, "attached", 2400, "attached"]]);
  expect(rows[2]!.winner).toBe("claude");
  expect(rows[2]!.lead).toBeCloseTo(60, 6);
  expect(rows[2]!.cells.claude!.perDollar).toBeCloseTo(2400 * 365.25 / 12 / 7 / 200, 6);
});

test("derive from another attached plan of the same provider, only on request and never from a derived one", () => {
  const all = windows(cycle("x20", 1000, 20), cycle("small", 10, 5, 1));
  const picks: Record<string, PlanPick> = { "codex:20": { cycles: ["x20"], from: null }, "codex:5": { cycles: ["small"], from: 20 }, "codex:1": { cycles: [], from: 5 } };
  const rows = battleRows(all, picks, "api_standard", "observed", 10080);
  // The ×5 cycle has a 1 pp sample and no estimate, so ×5 is derived from ×20; ×1 asked for ×5, which is itself derived.
  expect(rows.map(row => [row.tier, row.cells.codex?.value, row.cells.codex?.source])).toEqual([[1, null, "empty"], [5, 500, "derived"], [20, 2000, "attached"]]);
  expect(deriveSources(rows, "codex", 1)).toEqual([20]);
});

test("picks survive a round trip and a broken store reads as empty", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } as Storage;
  writeBattlePicks({ "10080": { "codex:1": { cycles: ["a"], from: null } } }, storage);
  expect(readBattlePicks(storage)).toEqual({ "10080": { "codex:1": { cycles: ["a"], from: null } } });
  store.set("tokenatlas.capacity-battle.v1", "{");
  expect(readBattlePicks(storage)).toEqual({});
});
