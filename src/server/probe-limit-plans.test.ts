import { expect, test } from "bun:test";
import { buildProbeLimitWindows, codexLimitCounter, type ProbeLimitReading } from "./probe-limit-windows";
import type { DatedPeriod } from "./account-periods";

const periods: DatedPeriod[] = [{ provider: "codex", subject: "codex1", value: "plus", origin: "declared",
  from: "2026-03-01", until: "2026-05-01", firstSeen: null, lastSeen: null, readings: 0, evidence: "payment" }];
const readings = (plan: string | null = "free"): ProbeLimitReading[] => [
  { ts: "2026-04-11T09:06:09.027Z", used_percent: 8, resets_at: "2026-04-18T09:03:23Z", window_minutes: 10080, source: "session", plan },
  { ts: "2026-04-11T09:54:24.825Z", used_percent: 95, resets_at: "2026-04-18T09:03:23Z", window_minutes: 10080, source: "session", plan },
];
const windows = (rows: ProbeLimitReading[]) => buildProbeLimitWindows({ provider: "codex", account: "codex1",
  counter: codexLimitCounter(10080), periods, readings: rows });

test("a Free meter retains its reported plan inside a paid Plus billing period", () => {
  const before = structuredClone(periods);
  expect(windows(readings())[0]).toMatchObject({ plan: "free", start: "2026-04-11T09:03:23.000Z",
    readings: [{ percent: 8, plan: "free" }, { percent: 95, plan: "free" }] });
  expect(periods).toEqual(before);
});

test("a short paid tail before the first Free reading does not name the entire meter Plus", () => {
  const rows = readings().map(row => ({ ...row, ts: row.ts.replace("2026-04-11", "2026-03-26"), resets_at: "2026-04-02T09:03:23Z" }));
  const paid = [{ ...periods[0]!, until: "2026-03-26T09:06:09Z" }];
  expect(buildProbeLimitWindows({ provider: "codex", account: "codex1", counter: codexLimitCounter(10080), periods: paid, readings: rows })[0]!.plan).toBe("free");
});

test("missing source plan falls back to dated periods, never inventing Free", () => {
  expect(windows(readings(null))[0]!.plan).toBe("plus");
});

test("different reported plans on one meter remain mixed", () => {
  const rows = readings(); rows[1]!.plan = "plus";
  expect(windows(rows)[0]).toMatchObject({ plan: null, plan_detail: { status: "mixed", multiplier: null }, declared_plan_meter_mismatch: true });
});

test("non-Codex plan resolution remains based on its dated periods", () => {
  expect(buildProbeLimitWindows({ provider: "claude", account: "codex1", counter: '["weekly_all","weekly",10080]',
    periods: periods.map(period => ({ ...period, provider: "claude" })), readings: readings() })[0]!.plan).toBe("plus");
});
