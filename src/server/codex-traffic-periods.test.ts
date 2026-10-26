import { describe, expect, test } from "bun:test";
import { codexTrafficPeriods, historicalTrafficProbes } from "./codex-traffic-periods";
import { Database } from "../db/sqlite";
import type { CodexProbe } from "./codex-calibration";
import { buildAccountResolver } from "./account-resolver";
import type { DatedPeriod } from "./account-periods";
import { codexAccountSelector } from "./codex-source-account";

const probe = (ts: string, resets_at: string, used_percent = 10, subject = "codex1"): CodexProbe => ({
  ts, resets_at, used_percent, subject, kind: "weekly", plan: "pro", window_minutes: 10080,
});

describe("reset-based traffic periods", () => {
  test("accounts stay separate and historical anchors do not invent percentage drops or plan changes", () => {
    const rows = [
      probe("2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z", 40, "alice"),
      { ...probe("2026-09-01T01:00:00Z", "2026-09-04T00:00:00Z", 0, "alice"), kind: "historical-anchor", plan: null },
      probe("2026-09-01T02:00:00Z", "2026-09-04T00:00:00Z", 50, "alice"),
      probe("2026-09-01T00:30:00Z", "2026-09-03T00:00:00Z", 20, "bob"),
      probe("2026-09-01T03:00:00Z", "2026-09-03T00:00:00Z", 60, "bob"),
    ];
    const periods = codexTrafficPeriods(rows, "2026-09-01", "2026-09-02");
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ account: "alice", start: "2026-09-01T00:00:00.000Z", end: "2026-09-01T02:00:00.000Z" });
    expect(periods[1]).toMatchObject({ account: "bob", start: "2026-09-01T00:30:00.000Z", end: "2026-09-01T03:00:00.000Z" });
  });
  test("historical anchors take each home's period account: a shared anchor stays per account, an ownership change or gap certifies nothing", () => {
    const root = "H:/Archive/tokenUsage";
    const period = (subject: string, value: string, from: string, until: string | null): DatedPeriod =>
      ({ provider: "codex", subject, from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
    const db = new Database(":memory:");
    db.exec("CREATE TABLE ratelimit(home TEXT,ts TEXT,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT)");
    const main = `${root}/codex/MAIN`, mirror = "C:/Users/x/.codex", stk = `${root}/codex/STK`;
    const selector = codexAccountSelector({ sqlite: db, resolver: buildAccountResolver([
      period("codex/main", "acct-a", "2026-01-01", null),
      period("codex/stk", "acct-b", "2026-08-01", "2026-09-01T12:00:00.000Z"),
      period("codex/stk", "acct-c", "2026-09-10", null),
    ]), accounts: { sources: [{ vendor: "codex", home: main, source_home: mirror }] } }, "ratelimit", root);
    const reset = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
    const insert = db.query("INSERT INTO ratelimit VALUES (?,?,?,10080,?)");
    for (const [home, ts, anchor, limit] of [
      [main, "2026-09-01T00:00:00.000Z", "2026-09-04", "codex"], [main, "2026-09-01T01:00:00.000Z", "2026-09-04", "codex"],
      // The local mirror of MAIN reports the same anchor: the same account's cycle, merged.
      [mirror, "2026-09-01T02:00:00.000Z", "2026-09-04", "codex"],
      [main, "2026-09-01T03:00:00.000Z", "2026-09-04", "spark"],
      // Another account's counter with the same anchor stays that account's.
      [stk, "2026-09-01T00:30:00.000Z", "2026-09-04", "codex"], [stk, "2026-09-01T01:30:00.000Z", "2026-09-04", "codex"],
      // A reset whose samples reach from acct-b into the gap after it certifies neither.
      [stk, "2026-09-01T11:00:00.000Z", "2026-09-08", "codex"], [stk, "2026-09-01T13:00:00.000Z", "2026-09-08", "codex"],
      [stk, "2026-09-05T00:00:00.000Z", "2026-09-12", "codex"], [stk, "2026-09-11T00:00:00.000Z", "2026-09-15", "codex"],
    ] as const) insert.run(home, ts, reset(anchor), limit);
    try {
      const probes = historicalTrafficProbes(db, selector.accountAt);
      expect(probes.map(p => [p.subject, p.resets_at, p.ts])).toEqual([
        ["acct-a", "2026-09-04T00:00:00.000Z", "2026-09-01T00:00:00.000Z"], ["acct-a", "2026-09-04T00:00:00.000Z", "2026-09-01T02:00:00.000Z"],
        ["acct-b", "2026-09-04T00:00:00.000Z", "2026-09-01T00:30:00.000Z"], ["acct-b", "2026-09-04T00:00:00.000Z", "2026-09-01T01:30:00.000Z"],
        ["acct-c", "2026-09-15T00:00:00.000Z", "2026-09-11T00:00:00.000Z"], ["acct-c", "2026-09-15T00:00:00.000Z", "2026-09-11T00:00:00.000Z"],
      ]);
    } finally { db.close(); }
  });
  test("uses actual resets for short cycles, preserves leading and trailing partial periods", () => {
    const periods = codexTrafficPeriods([
      probe("2026-09-01T08:00:00Z", "2026-09-02T12:00:00Z"),
      probe("2026-09-02T11:00:00Z", "2026-09-02T12:00:00Z", 99),
      probe("2026-09-02T12:05:00Z", "2026-09-04T15:00:00Z", 0),
      probe("2026-09-04T14:55:00Z", "2026-09-04T15:00:00Z", 100),
      probe("2026-09-04T15:05:00Z", "2026-09-11T15:00:00Z", 0),
      probe("2026-09-05T10:00:00Z", "2026-09-11T15:00:00Z", 20),
    ], "2026-09-01", "2026-09-06");
    expect(periods).toHaveLength(3);
    expect(periods[1]).toMatchObject({ start: "2026-09-02T12:00:00.000Z", end: "2026-09-04T15:00:00.000Z", start_reset: true, end_reset: true });
    expect(periods[0]!.start_reset).toBe(false);
    expect(periods[2]!.end_reset).toBe(false);
    expect(periods[2]!.end).toBe("2026-09-05T10:00:00.000Z");
  });
  test("early reset leaves its uncertain interval unassigned, even with unchanged scheduled reset", () => {
    const periods = codexTrafficPeriods([
      probe("2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"),
      probe("2026-09-02T09:00:00Z", "2026-09-08T00:00:00Z", 80),
      probe("2026-09-02T10:00:00Z", "2026-09-08T00:00:00Z", 0),
      probe("2026-09-03T00:00:00Z", "2026-09-08T00:00:00Z", 30),
    ], "2026-09-01", "2026-09-04");
    expect(periods.map(p => [p.start, p.end])).toEqual([
      ["2026-09-01T00:00:00.000Z", "2026-09-02T09:00:00.000Z"],
      ["2026-09-02T10:00:00.000Z", "2026-09-03T00:00:00.000Z"],
    ]);
    expect(periods.every(p => !p.start_reset && !p.end_reset)).toBe(true);
  });
  test("clips the requested range and never fabricates cycles without evidence", () => {
    expect(codexTrafficPeriods([], "2026-09-01", "2026-09-10")).toEqual([]);
    const periods = codexTrafficPeriods([
      probe("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
      probe("2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z", 90),
    ], "2026-09-03", "2026-09-05");
    expect(periods[0]).toMatchObject({ start: "2026-09-03T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z", start_reset: false, end_reset: false });
  });
});
