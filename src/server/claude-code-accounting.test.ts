import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { expect, test } from "bun:test";
import { buildSubscriptionAccountingReport } from "./subscription-accounting";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture, PROJECT, TIMES } from "./claude-code-capacity.fixture";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";

const counter = JSON.stringify(["weekly_all", "weekly", 10080]);
const options = {since: "2026-09-13", until: "2026-09-17", account: ACCOUNTS.a, counter};
function report(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>, project?: string, manualCapacity: ManualCapacityMeasurement[] = []) {
  // The producer reads the same manual measurements as the report (the measurement file in production).
  prepareLimitWindowsFixture(f.db, { manualCapacity: provider => provider === "claude" ? manualCapacity : [] });
  return buildSubscriptionAccountingReport({sqlite: f.db, rateCards: f.rates, plans: {}, plansCatalog: {provider_groups: []}, manualCapacity},
    "claude", {...options, project});
}

test("sub-millisecond vendor boundaries survive the real accounting window attachment", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const precise = "2026-09-17T00:00:00.000123Z";
    f.db.query("UPDATE probe_windows SET extra=json_set(extra, '$.\"claude.share.as_of\"', ?) WHERE subject=? AND used_percent=24")
      .run(precise,ACCOUNTS.a);
    f.prepareProbes();
    const result = report(f), window = result.windows![0]!;
    expect(window.end).toBe(precise);
    expect(window.claude_code_capacity!.source_through).toBe(precise);
    expect(window.claude_code_capacity!.weekly_capacity_tokens.value).toBeCloseTo(111_000 * 10_000 / (24 * 12 - 10 * 12), 6);
    expect(window.usage.tokens).toBe(161_000);
  } finally { f.teardown(); }
});

test("the account summary does not select an observation at midnight after the requested dates", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const before = report(f).claude_code_capacity;
    const nextDay = "2026-09-18T00:00:00.000Z";
    f.db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,reported_percent_side,used_percent,resets_at,window_minutes,ok,machine,extra)
      SELECT provider,subject,?,'weekly_all','weekly','used',30,resets_at,10080,1,'synthetic',json_set(extra,'$."claude.share.as_of"',?)
      FROM probe_windows WHERE subject=? AND used_percent=24`).run(nextDay,nextDay,ACCOUNTS.a);
    f.prepareProbes();
    expect(report(f).claude_code_capacity).toEqual(before);
  } finally { f.teardown(); }
});

test("Claude accounting attaches the same scoped estimate and keeps measured totals at vendor boundaries", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const result = report(f), window = result.windows![0]!;
    expect(result.windows).toHaveLength(1);
    expect(result.tokens).toBe(170_000);
    expect(window.usage.tokens).toBe(161_000);
    expect(window.start).toBe(TIMES.start);
    expect(window.end).toBe(TIMES.asOf);
    expect(window.claude_code_capacity).toEqual(result.claude_code_capacity);
    // Rule @3: every call between the readings is Code, whatever launched it.
    expect(window.claude_code_capacity!.observed_code_tokens).toBe(111_000);
    expect(window.claude_code_capacity!.weekly_capacity_tokens.value).toBeCloseTo(111_000 * 10_000 / (24 * 12 - 10 * 12), 6);
    const project = report(f, PROJECT);
    expect(project.tokens).toBe(40_000);
    expect(project.windows).toBeNull();
    expect(project.claude_code_capacity).toEqual(result.claude_code_capacity);
  } finally { f.teardown(); }
});

test("automatic windows retain the unavailable marker without losing traffic or borrowing a scoped model meter", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,reported_percent_side,used_percent,resets_at,window_minutes,ok,machine) VALUES('claude',?,?,'weekly_all','model','used',80,?,10080,1,'synthetic')")
      .run(ACCOUNTS.a,TIMES.asOf,TIMES.reset);
    f.prepareProbes();
    const baseline = report(f);
    expect(baseline.windows).toHaveLength(1);
    f.db.query("UPDATE probe_windows SET extra=NULL WHERE subject=?").run(ACCOUNTS.a);
    f.prepareProbes();
    const missing = report(f);
    expect(missing.tokens).toBe(baseline.tokens);
    const window = missing.windows![0]!;
    expect("claude_code_capacity" in window).toBe(true);
    expect(window.claude_code_capacity!.weekly_capacity_tokens.value).toBeNull();
    expect(window.claude_code_capacity!.reason).toBe("share_absent");
  } finally { f.teardown(); }
});

test("manual intervals keep their provenance and a weekly share never supplies session capacity", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const manual: ManualCapacityMeasurement = {id:"manual",account:ACCOUNTS.a,counter,start:TIMES.first,end:TIMES.asOf,
      start_percent:10,end_percent:24,approximate_time:false,note:"explicit",updated_at:TIMES.asOf};
    const measured = report(f,undefined,[manual]);
    expect(measured.windows).toHaveLength(1);
    expect(measured.windows![0]!.manual_measurement?.id).toBe("manual");
    expect(measured.windows![0]!.claude_code_capacity?.window_id).toBe(measured.windows![0]!.id);
    const reset = "2026-09-17T05:00:00.000Z";
    for (const [ts,percent] of [["2026-09-17T01:00:00.000Z",10],["2026-09-17T02:00:00.000Z",30]] as const) {
      f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,reported_percent_side,used_percent,resets_at,window_minutes,ok,machine) VALUES('claude',?,?,'session','session','used',?,?,300,1,'synthetic')")
        .run(ACCOUNTS.a,ts,percent,reset);
    }
    f.prepareProbes();
    const session = buildSubscriptionAccountingReport({sqlite:f.db,rateCards:f.rates,plans:{},plansCatalog:{provider_groups:[]},manualCapacity:[]},
      "claude",{...options,counter:JSON.stringify(["session","session",300])});
    expect(session.windows!.length).toBeGreaterThan(0);
    expect(session.windows!.every(w => w.claude_code_capacity === null)).toBe(true);
  } finally { f.teardown(); }
});
