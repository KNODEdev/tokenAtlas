import { describe, expect, test } from "bun:test";
import type { AccountPeriodRow, PeriodSource, PlanPeriodRow } from "../../shared/account-periods";
import { currentPlan, effectivePeriodRows, groupAccountPeriods, placesInPlan } from "./AccountPeriodGroups";
import { buildSourceTimeline } from "./AccountPeriodsSettings";

const base = { provider: "claude", origin: "observed" as const, firstSeen: null, lastSeen: null, readings: 1, evidence: "profile-reading", note: null };
const account = (id: number, value: string, from: string, until: string | null, origin: "observed" | "declared" = "observed"): AccountPeriodRow =>
  ({ ...base, id, source: "claude/pc", account: value, from, until, origin });
const plan = (id: number, value: string, from: string, until: string | null, origin: "observed" | "declared" = "observed"): PlanPeriodRow =>
  ({ ...base, id, account: "a", plan: value, from, until, origin, amountMinor: null, currency: null });
const source: PeriodSource = { provider: "claude", key: "claude/pc", machine: "PC", profile: ".claude", events: null };

describe("account history presentation", () => {
  test("ending the observed account and Pro plan does not resurrect their automatic tails", () => {
    const observed = account(1, "a", "2026-09-10T10:19:47.724Z", null);
    const correction = account(2, "a", "2026-09-10T10:19:00Z", "2026-09-17T10:19:00Z", "declared");
    const rows = buildSourceTimeline(source, [observed, correction]);
    expect(rows.map(row => [row.from, row.until])).toEqual([[correction.from, correction.until]]);
    expect(rows[0]?.covered).toEqual([observed]);
    const plans = [plan(1, "default_claude_ai", "2026-09-09T10:43:24.032Z", null),
      plan(2, "pro", "2026-09-09T10:43:00Z", "2026-09-16T10:43:00Z", "declared")];
    expect(currentPlan(plans, Date.parse("2026-09-16T10:42:59Z"))).toBe("pro");
    expect(currentPlan(plans, Date.parse("2026-09-16T10:43:00Z"))).toBeNull();
    expect(currentPlan(plans, Date.parse("2026-09-22"))).toBeNull();
  });
  test("recognized e-mail joins aliases and computers only within the same provider", () => {
    const second = { ...source, key: "claude/laptop", machine: "LAPTOP" };
    const groups = groupAccountPeriods([
      { provider: "claude", id: "a", label: "same@email.com", current: true },
      { provider: "codex", id: "a", label: "same@email.com", current: true },
      { provider: "claude", id: "b", label: "SAME@email.com", current: false },
    ], [
      { source, rows: buildSourceTimeline(source, [account(1, "a", "2026-01-01", null)]) },
      { source: second, rows: buildSourceTimeline(second, [{ ...account(2, "a", "2026-02-01", null), source: second.key }]) },
    ], [plan(1, "max-5x", "2026-01-01", null)]);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.provider === "claude")?.aliases).toEqual(["a", "b"]);
    expect(groups.find((group) => group.provider === "claude" && group.account === "a")?.timelines).toHaveLength(2);
    expect(groups.find((group) => group.provider === "codex")?.plans).toHaveLength(0);
  });

  test("unidentified accounts with a shared generic label remain distinct", () => {
    expect(groupAccountPeriods([
      { provider: "gemini", id: "a", label: "Profile", current: true },
      { provider: "gemini", id: "b", label: "Profile", current: true },
    ], [], [])).toHaveLength(2);
  });

  test("a historical correction cuts only its dates out of an observation and retains the original for editing", () => {
    const original = account(1, "a", "2026-01-01", null);
    const correction = account(2, "b", "2026-02-01", "2026-03-01", "declared");
    const rows = buildSourceTimeline(source, [original, correction]);
    expect(rows.map((row) => [row.period?.account, row.from, row.until])).toEqual([
      ["a", "2026-01-01", "2026-02-01"], ["b", "2026-02-01", "2026-03-01"], ["a", "2026-03-01", null],
    ]);
    expect(rows[0]?.period).toBe(original);
    expect(rows[1]?.covered).toEqual([original]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  test("plan history handles multiple corrections without overlapping effective rows", () => {
    const original = plan(1, "pro", "2026-01-01", null);
    const result = effectivePeriodRows([original,
      plan(2, "max-5x", "2026-02-01", "2026-03-01", "declared"),
      plan(3, "max-20x", "2026-04-01", null, "declared"),
    ]);
    expect(result.map(({ row, from, until }) => [row.plan, from, until])).toEqual([
      ["pro", "2026-01-01", "2026-02-01"], ["max-5x", "2026-02-01", "2026-03-01"],
      ["pro", "2026-03-01", "2026-04-01"], ["max-20x", "2026-04-01", null],
    ]);
    expect(result[2]?.row).toBe(original);
  });

  test("current plan uses date bounds and declarations; absence and conflicting observations stay unknown", () => {
    const now = Date.parse("2026-09-22");
    const observed = plan(1, "default_claude_max_5x", "2026-09-01", null);
    expect(currentPlan([observed], now)).toBe("max-5x");
    expect(currentPlan([observed, plan(2, "max-20x", "2026-09-20", "2026-09-23", "declared")], now)).toBe("max-20x");
    expect(currentPlan([plan(1, "pro", "2026-01-01", "2026-09-22")], now)).toBeNull();
    expect(currentPlan([plan(1, "pro", "2026-09-23", null)], now)).toBeNull();
    expect(currentPlan([observed, plan(2, "max-20x", "2026-09-01", null)], now)).toBeNull();
    expect(currentPlan([], now)).toBeNull();
  });

  test("selected plan intersects actual account intervals and excludes gaps and touching boundaries", () => {
    const rows = buildSourceTimeline(source, [account(1, "a", "2026-01-01", "2026-02-01"), account(2, "a", "2026-03-01", null)]);
    const selected = plan(1, "pro", "2026-01-15", "2026-03-10");
    expect(placesInPlan([{ source, rows }], selected).map(({ from, until }) => [from, until])).toEqual([
      ["2026-01-15T00:00:00.000Z", "2026-02-01T00:00:00.000Z"], ["2026-03-01T00:00:00.000Z", "2026-03-10T00:00:00.000Z"],
    ]);
    expect(placesInPlan([{ source, rows }], plan(2, "pro", "2026-02-01", "2026-03-01"))).toEqual([]);
    expect(placesInPlan([{ source, rows }], { ...selected, provider: "codex" })).toEqual([]);
    expect(placesInPlan([{ source, rows }], { ...selected, account: "b" })).toEqual([]);
  });
});
