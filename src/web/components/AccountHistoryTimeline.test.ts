import { describe, expect, test } from "bun:test";
import type { PlanPeriodRow } from "../../shared/account-periods";
import { planSegments, shiftPeriod } from "./AccountHistoryTimeline";

const at = (day: number) => Date.parse(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`);
const row = (id: number, account: string, plan: string, first: number, last: number | null, origin: "observed" | "declared" = "observed"): PlanPeriodRow => ({
  id, provider: "codex", account, plan, from: new Date(at(first)).toISOString(), until: last === null ? null : new Date(at(last)).toISOString(),
  origin, readings: 1, evidence: "profile-reading", note: null, firstSeen: null, lastSeen: null, amountMinor: null, currency: null,
});

describe("plan timeline", () => {
  test("a saved plan end cuts the chart even when the old profile still says Pro", () => {
    const result = planSegments([row(1, "a", "default_claude_ai", 9, null), row(2, "a", "pro", 9, 16, "declared")], at(9), at(22));
    expect(result.map(part => [part.from, part.until, part.label])).toEqual([
      [at(9), at(16), "pro"], [at(16), at(22), null],
    ]);
  });
  test("same-plan aliases produce one bar and retain original edit targets", () => {
    const a = row(1, "codex3", "plus", 2, null), b = row(2, "chatgpt-alias", "plus", 10, null);
    const result = planSegments([a, b], at(1), at(22));
    expect(result.map((part) => [part.from, part.until, part.label])).toEqual([[at(1), at(2), null], [at(2), at(22), "plus"]]);
    expect(result[1]?.records).toEqual([a, b]);
  });

  test("conflicting aliases stay explicit and a declaration affects only its own alias", () => {
    const rows = [row(1, "a", "pro", 1, null), row(2, "a", "plus", 10, 15, "declared"), row(3, "b", "pro", 1, null)];
    const result = planSegments(rows, at(1), at(22));
    expect(result.map((part) => [part.from, part.until, part.label, part.conflict])).toEqual([
      [at(1), at(10), "pro", false], [at(10), at(15), "plus / pro", true], [at(15), at(22), "pro", false],
    ]);
  });

  test("unknown intervals remain visible before, between and after known plans", () => {
    expect(planSegments([row(1, "a", "plus", 3, 8), row(2, "a", "pro", 12, 18)], at(1), at(22)).map((part) => part.label))
      .toEqual([null, "plus", null, "pro", null]);
  });

  test("clipping excludes touching periods and keeps sub-day boundaries exact", () => {
    const precise = { ...row(2, "a", "pro", 8, 12), from: new Date(at(8) + 1000).toISOString() };
    const result = planSegments([row(1, "a", "plus", 1, 8), precise, row(3, "a", "plus", 12, null)], at(8), at(12));
    expect(result.map((part) => [part.from, part.until, part.label])).toEqual([[at(8), at(8) + 1000, null], [at(8) + 1000, at(12), "pro"]]);
    expect(result[1]?.records).toEqual([precise]);
  });
});

describe("dragging a period", () => {
  const H = 3_600_000, DAY = 24 * H;
  test("moving shifts both ends and an ongoing period stays ongoing", () => {
    expect(shiftPeriod("2026-01-02", "2026-01-05T00:00:00Z", { mode: "move", delta: 2 * H, end: 0 }))
      .toEqual({ from: "2026-01-02T02:00:00.000Z", until: "2026-01-05T02:00:00.000Z" });
    expect(shiftPeriod("2026-01-02T00:00:00Z", null, { mode: "move", delta: -H, end: at(9) }))
      .toEqual({ from: "2026-01-01T23:00:00.000Z", until: null });
  });
  test("an edge drag changes one end; dragging an ongoing end closes it at the drawn end", () => {
    expect(shiftPeriod("2026-01-02T00:00:00Z", null, { mode: "start", delta: H, end: at(9) })).toEqual({ from: "2026-01-02T01:00:00.000Z", until: null });
    expect(shiftPeriod("2026-01-02T00:00:00Z", null, { mode: "end", delta: -DAY, end: at(9) })).toEqual({ from: "2026-01-02T00:00:00Z", until: "2026-01-08T00:00:00.000Z" });
  });
});
