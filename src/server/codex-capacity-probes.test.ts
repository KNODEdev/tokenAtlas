import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { loadCapacitySessionProbes, mergeCapacityProbes } from "./codex-capacity-probes";
import { codexWindowsFixture } from "./window-usage.fixture";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import type { CodexProbe } from "./codex-calibration";
import { publishedCodexComparisonFixture } from "./codex-ledger.fixture";

const p = (ts: string, used_percent: number, patch: Partial<CodexProbe> = {}): CodexProbe => ({ subject: "codex1", ts,
  used_percent, kind: "session", plan: "pro", resets_at: "2026-08-30T15:50:56Z", window_minutes: 10080, ...patch });

test("an isolated false 100 cannot discard the continuing 55–100% cycle or its Fast usage", () => {
  const rows=[p("2026-08-24T09:42:14Z",55),p("2026-08-24T09:43:02Z",100),
    p("2026-08-24T09:48:02Z",55),p("2026-08-24T09:49:31Z",56),
    p("2026-08-24T12:04:05Z",63,{kind:"weekly"}),p("2026-08-24T21:56:23Z",100,{kind:"weekly"})];
  const merged=mergeCapacityProbes(rows.filter(p=>p.kind!=="session"),rows.filter(p=>p.kind==="session"));
  expect(merged.conflictingReadings).toBe(1);
  expect(merged.probes.map(p=>p.used_percent)).toEqual([55,55,56,63,100]);
  const config={version:1 as const,rules:resolveCodexAccountingConfig({}).rules
    .filter(rule=>rule.model==="gpt-6-astra" && rule.valid_from==="2026-09-08")
    .map(rule=>({...rule,valid_from:"2026-08-01",confidence:"user" as const,sources:["https://example.test/synthetic-price"]}))};
  const [window]=codexWindowsFixture(config,publishedCodexComparisonFixture(config,[{account:"codex1",home:"LAPTOP",
    ts:"2026-08-24T15:00:00Z",model:"gpt-6-astra",speed:"fast" as const,in_tok:100000,cached_in:80000,out_tok:10000,cache_write:0}]),merged.probes);
  expect(window!.end).toBe("2026-08-24T21:56:23.000Z");expect(window!.usage.events).toBe(1);
  expect(window!.usage.api_normalized).toBeCloseTo(window!.usage.api_standard*2.5);
});

test("rounding, repeated saturation, unknown plans and a single stale sample do not erase 100%",()=>{
  for(const rows of [
    [p("2026-08-24T01:00:00Z",98),p("2026-08-24T02:00:00Z",100),p("2026-08-24T03:00:00Z",99),p("2026-08-24T04:00:00Z",99.5)],
    [p("2026-08-24T01:00:00Z",55),p("2026-08-24T02:00:00Z",100),p("2026-08-24T03:00:00Z",55),p("2026-08-24T04:00:00Z",100)],
    [p("2026-08-24T01:00:00Z",55,{plan:null}),p("2026-08-24T02:00:00Z",100,{plan:null}),p("2026-08-24T03:00:00Z",55,{plan:null}),p("2026-08-24T04:00:00Z",56,{plan:null})],
    [p("2026-08-24T01:00:00Z",55),p("2026-08-24T02:00:00Z",100),p("2026-08-24T03:00:00Z",55)],
  ]) {
    const result=mergeCapacityProbes([],rows);expect(result.conflictingReadings).toBe(0);
    expect(result.probes.some(p=>p.used_percent===100)).toBe(true);
  }
});

test("repeated rounded polls between a false session saturation and continuing growth retain the whole cycle",()=>{
  const rows=[p("2026-08-24T09:42:14Z",55),p("2026-08-24T09:43:02Z",100),
    p("2026-08-24T09:48:02Z",55),p("2026-08-24T09:48:38Z",55),p("2026-08-24T09:49:04Z",56),
    p("2026-08-24T21:56:23Z",100,{kind:"weekly"})];
  const merged=mergeCapacityProbes(rows.filter(p=>p.kind!=="session"),rows.filter(p=>p.kind==="session"));
  expect(merged.conflictingReadings).toBe(1);
  expect(merged.probes.map(p=>p.used_percent)).toEqual([55,55,55,56,100]);
  expect(codexWindowsFixture(resolveCodexAccountingConfig({}),[],merged.probes)[0]?.end).toBe("2026-08-24T21:56:23.000Z");
});

test("a periodic zero followed by growth preserves a genuine reset on an unchanged clock",()=>{
  const merged=mergeCapacityProbes([p("2026-08-24T03:00:00Z",0,{kind:"weekly"}),p("2026-08-24T04:00:00Z",5,{kind:"weekly"})],
    [p("2026-08-24T01:00:00Z",55),p("2026-08-24T02:00:00Z",100)]);
  expect(merged.conflictingReadings).toBe(0);
  expect(codexWindowsFixture(resolveCodexAccountingConfig({}),[],merged.probes).map(w=>w.observed_pp)).toEqual([100,5]);
});

test("5h merge uses its own duration and never borrows a weekly clock at the same reset", () => {
  const reset = "2026-08-30T15:50:56Z";
  const five = [p("2026-08-30T11:00:00Z", 20, { window_minutes: 300 }), p("2026-08-30T12:00:00Z", 40, { window_minutes: 300 })];
  const periodic = [p("2026-08-30T12:00:00Z", 90, { kind: "weekly", resets_at: reset })];
  const short = mergeCapacityProbes(periodic, [...five, p("2026-08-29T12:00:00Z", 1, { window_minutes: 300 })], 300);
  expect(short.probes.map(row => row.used_percent)).toEqual([20, 40]);
  expect(short.probes.every(row => row.window_minutes === 300)).toBe(true);
  expect(mergeCapacityProbes(periodic, five).probes.map(row => row.used_percent)).toEqual([90]);
});

test("loads actual historical percentages with dated attribution, not fake zero anchors or Spark", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);
    INSERT INTO ratelimit VALUES
    ('PC','main','2026-02-14T09:50:21Z',77,1771255520,10080,'codex',NULL),
    ('PC','spark','2026-02-14T10:00:00Z',25,1771255520,10080,'codex','pro'),
    ('PC','other','2026-02-14T10:00:00Z',25,1771255520,10080,'codex-spark','pro'),
    ('PC','five','2026-02-14T10:00:00Z',25,1771255520,300,'codex','pro');`);
  try {
    const rows = loadCapacitySessionProbes(db, "2025-09-12", "2026-09-12", (_home, ts) => ts.startsWith("2026-02") ? "codex1" : null,
      new Set([JSON.stringify(["PC", "spark"])]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "codex1", kind: "session", used_percent: 77, plan: null });
    expect(loadCapacitySessionProbes(db, "2025-09-12", "2026-09-12", () => null)).toHaveLength(0);
  } finally { db.close(); }
});

test("mixed meter evidence on the same clock is kept, and classification stays within its source",()=>{
  const db=new Database(":memory:"),reset=Date.parse("2026-08-30T15:50:56Z")/1000;
  db.exec("CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT)");
  const put=db.query("INSERT INTO ratelimit VALUES(?,'mixed','2026-08-24T10:00:00Z',44,?,10080,'codex','pro')");
  put.run("PC",reset);put.run("OTHER",reset);
  const models=new Map([[JSON.stringify(["PC","mixed"]),[{reset,spark:true,main:false}]]]);
  try {
    expect(loadCapacitySessionProbes(db,"2026-08-24","2026-08-25",()=>"codex1",new Set(),10080,models)).toHaveLength(1);
    models.get(JSON.stringify(["PC","mixed"]))!.push({reset:reset+1,spark:false,main:true});
    expect(loadCapacitySessionProbes(db,"2026-08-24","2026-08-25",()=>"codex1",new Set(),10080,models)).toHaveLength(2);
  }finally{db.close();}
});

test("Aug 23 uses the complete 0–35% cycle, tolerates wobble and discards stale readings after an early reset", () => {
  const next = { resets_at: "2026-08-31T00:43:28Z" };
  const merged = mergeCapacityProbes([p("2026-08-23T19:07:00Z", 11, { kind: "weekly" }),
    p("2026-08-24T02:00:00Z", 34, { ...next, kind: "weekly" })], [
    p("2026-08-23T15:53:00Z", 0, { resets_at: "2026-08-30T15:50:57Z" }),
    p("2026-08-24T00:26:44Z", 35), p("2026-08-24T00:43:47Z", 0, next),
    p("2026-08-24T01:00:00Z", 5, next), p("2026-08-24T06:12:30Z", 35), p("2026-08-25T14:13:30Z", 71, next),
  ]);
  const windows = codexWindowsFixture(resolveCodexAccountingConfig({}), [], merged.probes);
  expect(windows).toHaveLength(2);
  expect(windows[0]).toMatchObject({ start_percent: 0, end_percent: 35, observed_pp: 35, end: "2026-08-24T00:26:44.000Z",
    cycle_start: "2026-08-23T15:50:56.000Z", cycle_end: "2026-08-24T00:43:28.000Z", cycle_end_basis: "reset" });
  expect(windows[1]).toMatchObject({ start_percent: 0, observed_pp: 71 });
});

test("a lower periodic value cannot fragment the cycle after a more recent session percentage", () => {
  const merged = mergeCapacityProbes([p("2026-08-24T00:00:00Z", 25, { kind: "weekly" })],
    [p("2026-08-23T16:00:00Z", 34), p("2026-08-24T00:26:00Z", 70)]);
  const windows = codexWindowsFixture(resolveCodexAccountingConfig({}), [], merged.probes);
  expect(windows).toHaveLength(1);
  expect(windows[0]!.observed_pp).toBe(70);
});

test("confirmed account clock wins over overlapping unconfirmed clocks, but historical probe gaps remain discoverable", () => {
  const merged = mergeCapacityProbes([p("2026-08-24T02:00:00Z", 35, { kind: "weekly" })], [
    p("2026-08-24T01:00:05Z", 5, { resets_at: "2026-08-31T01:00:00Z" }),
    p("2026-08-24T01:30:00Z", 20, { plan: "plus" }),
    p("2026-08-25T03:00:00Z", 10, { resets_at: "2026-09-01T00:00:00Z" }),
    p("2026-02-14T09:50:00Z", 77, { resets_at: "2026-02-16T15:25:20Z", plan: null }),
  ]);
  expect(merged.conflictingReadings).toBe(2);
  expect(merged.probes).toHaveLength(3);
  expect(merged.probes[0]!.plan).toBeNull();
  expect(merged.probes.at(-1)!.used_percent).toBe(10);
});

test("a parallel low counter cannot reset a still-advancing main counter", () => {
  const alternate = { resets_at: "2026-08-30T16:00:00Z" };
  const rows = [p("2026-08-23T16:00:00Z", 5), p("2026-08-23T17:00:00Z", 0, alternate),
    p("2026-08-23T18:00:00Z", 10), p("2026-08-23T19:00:00Z", 1, alternate), p("2026-08-23T19:01:00Z", 18)];
  const merged = mergeCapacityProbes([], rows);
  expect(merged.conflictingReadings).toBe(2);
  expect(codexWindowsFixture(resolveCodexAccountingConfig({}), [], merged.probes)).toHaveLength(1);
  // A stale repeat of the old peak after an early reset does not invalidate the new clock.
  const reset = mergeCapacityProbes([], [rows[0]!, rows[1]!, p("2026-08-23T18:00:00Z", 5), rows[3]!]);
  expect(reset.probes.some(p => p.resets_at === alternate.resets_at)).toBe(true);
});


test("temporary zero polling windows cannot truncate the fresh account's continuing 22% cycle", () => {
  const merged = mergeCapacityProbes([
    p("2026-08-23T16:00:00Z", 0, { kind: "primary" }),
    p("2026-08-23T17:00:00Z", 1, { kind: "primary" }),
    p("2026-08-23T18:00:00Z", 0, { kind: "primary", resets_at: "2026-08-30T18:00:00Z" }),
    p("2026-08-23T18:05:00Z", 0, { kind: "primary", resets_at: "2026-08-30T18:05:00Z" }),
    p("2026-08-25T18:00:00Z", 22, { kind: "primary" }),
  ], []);
  const windows = codexWindowsFixture(resolveCodexAccountingConfig({}), [], merged.probes);
  expect(merged.conflictingReadings).toBe(2);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ observed_pp: 22, end: "2026-08-25T18:00:00.000Z" });
});
