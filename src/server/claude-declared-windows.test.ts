import { expect, test } from "bun:test";
import { cadenceAnchor, claudeDeclaredWindows } from "./claude-declared-windows";
import { anchoredWindows, resolveCadence, type CyclesConfig } from "./cycles";
import { planPeriodIndex, type DatedPeriod } from "./account-periods";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS } from "./claude-code-capacity.fixture";

const period = (from: string, until: string | null, value = "pro", origin: DatedPeriod["origin"] = "declared"): DatedPeriod =>
  ({ provider: "claude", subject: ACCOUNTS.a, from, until, value, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

test("a reset reported with sub-second jitter anchors the same reconstructed windows", () => {
  // Two consecutive Claude readings of the same weekly reset (live database, 06.10).
  const readings = ["2026-10-11T10:59:59.725248+00:00", "2026-10-11T11:00:00.314461+00:00"];
  expect(readings.map(cadenceAnchor)).toEqual(["2026-10-11T11:00:00.000Z", "2026-10-11T11:00:00.000Z"]);
  const windows = readings.map(resetsAt => anchoredWindows(resolveCadence({ windows: [] }, "claude-a", "weekly_all",
    { periodHours: 168, anchorIso: cadenceAnchor(resetsAt), source: "probe" }),
  { nowMs: Date.parse("2026-10-06T01:00:00Z"), earliestMs: Date.parse("2026-08-01T00:00:00Z"), limit: 12 })
    .map(window => `${window.startIso}:${window.resetIso}`));
  expect(windows[0]!.length).toBeGreaterThan(5);
  expect(windows[1]).toEqual(windows[0]!);
  expect(cadenceAnchor(null)).toBeNull();
});

test("declared plan ends bound both Claude counters, including an open observed alias", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const cycles = { windows: ["weekly_all", "weekly_scoped"].map(kind => ({ subscription: ACCOUNTS.a, kind,
      period_hours: 168, anchor_ts: "2026-09-20T00:00:00.000Z", history_windows: 2 })) };
    const plans = planPeriodIndex([period("2026-09-01", "2026-09-18"), period("2026-09-09", null, "default_claude_ai", "observed")]);
    // A long time after expiry, inactive weeks still cannot displace the last two valid weeks.
    const sets = claudeDeclaredWindows(f.db, ACCOUNTS.a, cycles, Date.parse("2027-09-21"), Date.parse("2026-08-01"), plans);
    expect(sets.map(set => set.kind)).toEqual(["weekly_all", "weekly_scoped"]);
    for (const set of sets) expect(set.windows.map(w => [w.startIso.slice(0, 10), w.resetIso.slice(0, 10)]))
      .toEqual([["2026-09-13", "2026-09-20"], ["2026-09-06", "2026-09-13"]]);
  } finally { f.teardown(); }
});

test("gaps and no-plan declarations exclude reconstructed weeks, while partial weeks keep their identity", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const now = Date.parse("2026-10-21"), earliest = Date.parse("2026-09-01");
    const starts = (periods: DatedPeriod[]) => claudeDeclaredWindows(f.db, ACCOUNTS.a, { windows: [] }, now, earliest,
      planPeriodIndex(periods)).find(set => set.kind === "weekly_all")?.windows.map(w => w.startIso.slice(0, 10)) ?? [];
    expect(starts([period("2026-09-01", "2026-09-13"), period("2026-09-27", "2026-10-01")]))
      .toEqual(["2026-09-27", "2026-09-06"]);
    for (const excluded of ["none", "free", "unknown"]) {
      expect(starts([period("2026-09-01", null, "default_claude_ai", "observed"),
        period("2026-09-13", "2026-10-04", excluded)]))
        .toEqual(["2026-10-18", "2026-10-11", "2026-10-04", "2026-09-06"]);
    }
    // An entitlement starting inside the week preserves that whole reset window.
    expect(starts([period("2026-09-10", "2026-09-12")])).toEqual(["2026-09-06"]);
    expect(starts([period("2026-11-01", null)])).toEqual([]);
    expect(starts([period("2026-10-22", null)])).toEqual([]);
  } finally { f.teardown(); }
});

test("missing plan history keeps the existing reconstructed traffic coverage", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const cycles: CyclesConfig = { windows: [] };
    const args = [f.db, ACCOUNTS.a, cycles, Date.parse("2026-09-21"), Date.parse("2026-09-01")] as const;
    expect(claudeDeclaredWindows(...args, planPeriodIndex([{ ...period("2026-09-01", "2026-09-13"), subject: ACCOUNTS.b }])))
      .toEqual(claudeDeclaredWindows(...args));
  } finally { f.teardown(); }
});
