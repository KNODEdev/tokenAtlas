import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import { calibrateCodex as calibratePublishedCodex, loadCodexProbes, type CodexProbe, type CalibrationEvent } from "./codex-calibration";
import { publishedCodexComparisonFixture } from "./codex-ledger.fixture";
import { normalizePublishedCodexEvent } from "./codex-priced-events";
import { editCodexSpeed, editCodexStandardRates, normalizeCodexEvent, priceCodexEvent, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { handleRateCardsSave, type AppContext } from "./api";
import { buildFixtureCodexReport as buildCodexAccountingReport, codexFixturePeriods } from "./codex-v8.fixture";
import { buildAccountResolver, loadAccountResolver } from "./account-resolver";
import { prepareProbeReaderFixture, probeReaderFixtureSource, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { ACCOUNT_PERIODS, loadPeriods, PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { ProbeAccountIndexUnavailable, ProbeAccountReadLimitExceeded } from "./current/probe-account-reader";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeEquivalentsAndProvenance, type SubscriptionCapacity } from "./capacity-equivalents";
import type { RateCard } from "./pricing";

const card = (): RateCard => ({ version: 2, currency: "USD", unit: "per 1M", vendors: { openai: { models: {} } } });
const event = (patch: Partial<CalibrationEvent> = {}): CalibrationEvent => ({ model: "gpt-6-astra", speed: "fast", ts: "2026-09-08T01:05:00Z",
  in_tok: 100000, cached_in: 80000, cache_write: 0, out_tok: 10000, account: "codex1", home: "laptop", ...patch });
const config = resolveCodexAccountingConfig(card());
// Calibration consumes published prices; each synthetic edit is explicitly prepared before its read.
// The estimator receives interval sums; here they are the published events of each interval.
const calibrateCodex = (rules: Parameters<typeof calibratePublishedCodex>[0], rows: CalibrationEvent[], probes: CodexProbe[]) => {
  const published = publishedCodexComparisonFixture(rules, rows);
  return calibratePublishedCodex(rules, probes, (start, end) => {
    const inside = published.filter(row => row.account === start.subject && Date.parse(row.ts) > Date.parse(start.ts) && Date.parse(row.ts) <= Date.parse(end.ts));
    let credits = 0, normalized = 0, missing = 0;
    for (const row of inside) {
      const amount = normalizePublishedCodexEvent(rules, row);
      if (amount.credits === null || amount.normalized_usd === null) missing++;
      else { credits += amount.credits; normalized += amount.normalized_usd; }
    }
    return { credits, normalized, missing, events: inside.length, models: inside.map(row => row.model),
      sources: [...new Set(inside.flatMap(row => row.home ? [row.home] : []))].sort() };
  }, 0);
};

test("normalization uses 2.5 credit burden, not the 2x API premium; raw tokens stay unchanged", () => {
  const e = event(), saved = { ...e }, n = normalizeCodexEvent(config, e);
  expect(n.standard_api_usd).toBeCloseTo(.78); expect(n.normalized_usd).toBeCloseTo(1.95);
  expect(n.extra_credits).toBeCloseTo(29.25); expect(e).toEqual(saved);
  expect(normalizeCodexEvent(config, event({ speed: "unknown" })).normalized_usd).toBeNull();
  expect(normalizeCodexEvent(config, event({ cached_in: 200000 })).normalized_usd).toBeNull();
});

test("model edits preserve earlier history, update both bases independently and can be repeated", () => {
  const c = card(); editCodexSpeed(c, "gpt-6-astra", { credit_multiplier: 3, api_multiplier: 4, valid_from: "2026-09-09" });
  expect(normalizeCodexEvent(c.codex_accounting!, event()).multiplier).toBe(2.5);
  const later = event({ ts: "2026-09-09T01:00:00Z" });
  expect(normalizeCodexEvent(c.codex_accounting!, later).multiplier).toBe(3);
  expect(priceCodexEvent(c.codex_accounting!, later, "api_equivalent_usd").amount).toBeCloseTo(.78 * 4);
  editCodexSpeed(c, "gpt-6-astra", { credit_multiplier: 5, api_multiplier: 2, valid_from: "2026-09-09" });
  expect(normalizeCodexEvent(c.codex_accounting!, later).multiplier).toBe(5);
  expect(normalizeCodexEvent(c.codex_accounting!, event()).multiplier).toBe(2.5);
  editCodexSpeed(c, "gpt-5.6-luna", { credit_multiplier: 3, valid_from: "2026-09-09" });
  expect(priceCodexEvent(c.codex_accounting!, { ...later, model: "gpt-5.6-luna" }, "chatgpt_credits").amount).not.toBeNull();
});

test("invalid dates, multipliers and unavailable base rules reject without mutating config", async () => {
  const c = card(), original = JSON.stringify(c);
  for (const x of [0, -1, NaN, Infinity, 101]) expect(() => editCodexSpeed(c, "gpt-6-astra", { credit_multiplier: x, valid_from: "2026-09-09" })).toThrow();
  expect(() => editCodexSpeed(c, "gpt-6-astra", { credit_multiplier: 2, valid_from: "2026-02-30" })).toThrow();
  expect(() => editCodexSpeed(c, "unpriced", { credit_multiplier: 2, valid_from: "2026-09-09" })).toThrow();
  expect(JSON.stringify(c)).toBe(original);
  const ctx = { rateCards: c } as AppContext;
  const response = await handleRateCardsSave(ctx, new Request("http://local/api/rate-cards", { method: "POST",
    body: JSON.stringify({ vendor: "openai", model: "gpt-6-astra", codex_speed: { credit_multiplier: 0, valid_from: "2026-09-09" } }) }));
  expect(response.status).toBe(400); expect(JSON.stringify(c)).toBe(original);
});

test("editing model API prices updates accounting and long context, without changing credit multiplier", () => {
  const c = card(); editCodexStandardRates(c, "gpt-6-astra", { in_uncached: 20, in_cache_read: 2, out_total: 100 }, "2026-09-09");
  expect(normalizeCodexEvent(c.codex_accounting!, event()).standard_api_usd).toBeCloseTo(.78);
  const e = event({ ts: "2026-09-09T01:00:00Z" });
  expect(normalizeCodexEvent(c.codex_accounting!, e).standard_api_usd).toBeCloseTo(1.56);
  expect(normalizeCodexEvent(c.codex_accounting!, e).multiplier).toBe(2.5);
  expect(priceCodexEvent(c.codex_accounting!, e, "api_equivalent_usd").amount).toBeCloseTo(3.12);
});

function fixture() {
  const events: CalibrationEvent[] = [], probes: CodexProbe[] = [];
  for (const day of [8, 9, 10]) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    events.push(event({ ts: `${date}T01:05:00Z`, home: day === 9 ? "desktop" : "laptop" }));
    const p = { subject: "codex1", kind: "primary", plan: "pro", resets_at: `${date}T05:00:00Z`, window_minutes: 300 };
    probes.push({ ...p, ts: `${date}T01:00:00Z`, used_percent: 10 }, { ...p, ts: `${date}T01:10:00Z`, used_percent: 20 });
  }
  return { events, probes };
}
test("three reset windows train on two and validate on the untouched third, across machines", () => {
  const f = fixture(), r = calibrateCodex(config, f.events, f.probes), m = r.models[0]!;
  expect(m.status).toBe("validated"); expect(m.training_windows).toBe(2); expect(m.validation_intervals).toBe(1);
  expect(m.credits_per_1pct).toBeCloseTo(4.875); expect(m.standard_normalized_usd_per_1pct).toBeCloseTo(.195);
  expect(m.validation_mae_pp).toBeCloseTo(0); expect(r.quota_verified).toBe(false);
  const holdout = r.intervals.find(i => i.role === "validation")!;
  expect(holdout.predicted_pp).toBeCloseTo(10); expect(holdout.start_ts).toContain("09-10");
  f.events[2] = event({ ...f.events[2], in_tok: 200000 });
  const changed = calibrateCodex(config, f.events, f.probes).models[0]!;
  expect(changed.credits_per_1pct).toBeCloseTo(m.credits_per_1pct!); expect(changed.status).toBe("working");
});

test("unknown speed, counter decreases, stale probes and plan changes exclude intervals", () => {
  for (const reason of ["incomplete_pricing_or_speed", "counter_decreased", "probe_gap_over_2h", "plan_unknown_or_changed"]) {
    const { events, probes } = fixture();
    if (reason === "incomplete_pricing_or_speed") events[0]!.speed = "unknown";
    if (reason === "counter_decreased") probes[1]!.used_percent = 5;
    if (reason === "probe_gap_over_2h") probes[1]!.ts = "2026-09-08T04:00:00Z";
    if (reason === "plan_unknown_or_changed") probes[1]!.plan = "plus";
    expect(calibrateCodex(config, events, probes).intervals.some(i => !i.accepted && i.reason === reason)).toBe(true);
  }
});

test("reset timestamp wobble does not turn three intervals into independent windows", () => {
  const probes: CodexProbe[] = [], events: CalibrationEvent[] = [];
  for (let i = 0; i < 4; i++) {
    probes.push({ subject:"codex1",plan:"pro",kind:"primary",window_minutes:300, ts:`2026-09-08T01:${i * 10 === 0 ? "00" : i * 10}:00Z`,
      resets_at:`2026-09-08T05:00:0${i}Z`,used_percent:i * 10 });
    if (i < 3) events.push(event({ts:`2026-09-08T01:${String(i * 10 + 5).padStart(2,"0")}:00Z`}));
  }
  const r = calibrateCodex(config,events,probes);
  expect(r.models[0]!.training_windows).toBe(1); expect(r.models[0]!.validation_intervals).toBe(0);
});

test("report pricing, subject normalization, unknown coverage and probe limit separation agree", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,speed TEXT,in_tok INT,cached_in INT,cache_write INT,out_tok INT,project_id TEXT);
    CREATE TABLE probe_windows(provider TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INT,limit_group TEXT,ok INT);`);
  const f = fixture();
  for (const e of f.events) db.query("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'project')").run(e.home!, `session-${e.ts.slice(0,10)}`, e.ts, e.model, e.speed, e.in_tok, e.cached_in, e.cache_write, e.out_tok);
  for (const p of f.probes) for (const group of ["codex", "codex_bengalfox"]) db.query("INSERT INTO probe_windows VALUES ('codex',?,?,?,?,?,?,?,?,1)").run(p.subject,p.ts,p.kind,p.plan,p.used_percent,p.resets_at,p.window_minutes,group);
  // Window plans come from plan periods, never from a reading's label.
  codexFixturePeriods(db);
  replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "codex", subject: "codex1", from: "2026-09-01", until: null, value: "pro",
    origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
  const r = buildCodexAccountingReport(db,card(),{ since:"2026-09-08",until:"2026-09-10",account:"codex1",window_minutes:300 },new Map([["laptop","codex1"],["desktop","codex1"]]));
  expect(loadCodexProbes(db,"2026-09-08","2026-09-11",loadAccountResolver(db),"codex1")).toHaveLength(6);
  expect(r.normalization.normalized_usd.value).toBeCloseTo(5.85);
  expect(r.subjects[0]!.normalized_usd.value).toBeCloseTo(5.85); expect(r.calibration?.models[0]!.status).toBe("validated");
  db.close();
});

test("prepared calibration follows physical account periods, corrections and bounded account/time reads after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"codex-calibration-periods-"));
  const file = path.join(directory,"fixture.sqlite");
  let db = new Database(file);
  const sources = [probeReaderFixtureSource("codex","a"),probeReaderFixtureSource("codex","b")];
  const config = splitProbeReaderFixtureConfig(sources);
  const settle = () => {
    const now = "2026-09-09T00:00:00Z", registry = currentRegistry(config.subscriptions,now);
    for (let i=0; i<100; i++) if (!publishCurrentBatch(db,registry,now,32,config)) return;
    throw new Error("Probe projection did not settle");
  };
  try {
    db.exec(`CREATE TABLE probe_windows(provider TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,
      used_percent REAL,resets_at TEXT,window_minutes INTEGER,limit_group TEXT,ok INTEGER,
      machine TEXT)`);
    const insert = db.query(`INSERT INTO probe_windows VALUES('codex',?,?,'primary','pro',20,
      '2026-09-09T05:00:00Z',300,'codex',1,?)`);
    for (let i=0; i<20; i++) insert.run("stale-a",`2026-09-07T00:${String(i).padStart(2,"0")}:00Z`,null);
    for (const ts of ["2026-09-08T00:30:00Z","2026-09-08T01:30:00Z","2026-09-08T02:30:00Z"])
      insert.run("stale-a",ts,null);
    insert.run("b","2026-09-08T00:45:00Z",null);
    insert.run("stale-a","2026-09-08T01:45:00Z","UNKNOWN");
    prepareProbeReaderFixture(db,sources,row=>row.subject==="b"?"b":"a");
    const [a,b] = loadPeriods(db,ACCOUNT_PERIODS).filter(p=>p.origin==="declared").sort((x,y)=>x.value.localeCompare(y.value));
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{...a!,until:"2026-09-08T02:00:00Z"},b!]);
    settle();
    const resolver = loadAccountResolver(db);
    expect(loadCodexProbes(db,"2026-09-08","2026-09-09",resolver,"a").map(p=>p.ts))
      .toEqual(["2026-09-08T00:30:00Z","2026-09-08T01:30:00Z"]);
    expect(loadCodexProbes(db,"2026-09-08","2026-09-09",resolver,"b").map(p=>p.ts))
      .toEqual(["2026-09-08T00:45:00Z"]);
    const pointReads = (since:string) => {
      let reads = 0;
      const query = db.query.bind(db);
      (db as Database & {query:Database["query"]}).query = ((sql:string) => {
        const statement = query(sql);
        // Bun returns one cached statement per SQL text, so count through a proxy.
        return !sql.includes("JOIN probe_windows") ? statement : new Proxy(statement, { get(target, property) {
          if (property === "all") return (...args:Parameters<typeof target.all>) => { const rows = target.all(...args); reads += rows.length; return rows; };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }) as Database["query"];
      try { loadCodexProbes(db,since,"2026-09-09",resolver,"a"); }
      finally { (db as Database & {query:Database["query"]}).query=query; }
      return reads;
    };
    expect(pointReads("2026-09-08")).toBe(2);
    expect(pointReads("2026-09-07")).toBe(22);
    const beforeB = db.query("SELECT data FROM current_probe_subjects WHERE provider='codex' AND subject='b'").get();
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{...a!,until:"2026-09-08T00:00:00Z"},
      {...a!,value:"c",from:"2026-09-08T00:00:00Z",until:"2026-09-08T02:00:00Z"},b!]);
    settle();
    expect(db.query("SELECT data FROM current_probe_subjects WHERE provider='codex' AND subject='b'").get()).toEqual(beforeB);
    expect(loadCodexProbes(db,"2026-09-08","2026-09-09",loadAccountResolver(db),"a")).toEqual([]);
    expect(loadCodexProbes(db,"2026-09-08","2026-09-09",loadAccountResolver(db),"c").map(p=>p.ts))
      .toEqual(["2026-09-08T00:30:00Z","2026-09-08T01:30:00Z"]);
    db.close(); db = new Database(file);
    expect(loadCodexProbes(db,"2026-09-08","2026-09-09",loadAccountResolver(db),"c")).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS n FROM probe_windows WHERE subject='stale-a'").get())
      .toEqual({n:24});
  } finally { db.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});

test("calibration selects UTC instants and rejects invalid success flags", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE probe_windows(provider TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,
      used_percent REAL,resets_at TEXT,window_minutes INTEGER,limit_group TEXT,ok INTEGER)`);
    const insert=db.query("INSERT INTO probe_windows VALUES('codex','a',?,'primary','pro',20,'2026-09-08T05:00:00Z',300,'codex',?)");
    insert.run("2026-09-07T23:30:00-02:00",1);
    insert.run("2026-09-08T01:45:00Z",2);
    prepareProbeReaderFixture(db,[probeReaderFixtureSource("codex","a")]);
    const resolver=loadAccountResolver(db);
    const read=(from:string,until:string)=>loadCodexProbes(db,from,until,resolver,"a").map(row=>row.ts);
    expect(read("2026-09-08T01:00:00Z","2026-09-08T02:00:00Z")).toEqual(["2026-09-07T23:30:00-02:00"]);
    expect(read("2026-09-08T15:00:00+14:00","2026-09-08T16:00:00+14:00")).toEqual(["2026-09-07T23:30:00-02:00"]);
  } finally {db.close();}
});

test("unprepared and oversized probe ranges fail explicitly", () => {
  const db = new Database(":memory:");
  const sources = [probeReaderFixtureSource("codex","a")];
  try {
    expect(() => loadCodexProbes(db,"2026-09-08","2026-09-09",buildAccountResolver([]),"a"))
      .toThrow(ProbeAccountIndexUnavailable);
    prepareProbeReaderFixture(db,sources);
    db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,window_minutes,used_percent,reported_percent_side)
      VALUES('codex','a','2026-09-08T00:00:00.000Z','primary','codex',300,10,'used')`).run();
    prepareProbeReaderFixture(db,sources);
    // 20 000 more readings under the same physical evidence, stored as the projection writer stores it.
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,window_minutes,used_percent,reported_percent_side)
      SELECT 'codex','a','2026-09-08T00:00:00.000Z','primary','codex',300,10,'used' FROM n;
      INSERT INTO probe_sources(probe_id,ord,provider,machine,home,login,basis,tuples,at,accounting_at,observation_at,subject,bare,revision)
      SELECT p.id,0,s.provider,s.machine,s.home,s.login,s.basis,1,s.at,s.accounting_at,NULL,'a',0,s.revision
      FROM probe_windows p, (SELECT * FROM probe_sources LIMIT 1) s WHERE p.id NOT IN (SELECT probe_id FROM probe_sources);
      DELETE FROM probe_source_dirty;`);
    expect(() => loadCodexProbes(db,"2026-09-08","2026-09-09",loadAccountResolver(db),"a"))
      .toThrow(ProbeAccountReadLimitExceeded);
  } finally { db.close(); }
});

test("capacity refuses ordinary API dollars when its denominator requires normalized Standard dollars", () => {
  const c = { value_basis: "standard_normalized", capacity_basis: "single", weekly_window_value_usd: 19.5, window_hours:168,
    calibration_start_ts:"2026-09-08T00:00:00Z",calibration_end_ts:"2026-09-11T00:00:00Z" } as SubscriptionCapacity;
  const period = { since:"2026-09-08",until:"2026-09-10" };
  expect(computeEquivalentsAndProvenance(.78,c,period).equivalents.weekly_cycles.absent).toBe("invalid_usage");
  expect(computeEquivalentsAndProvenance(.78,c,period,1.95).equivalents.weekly_cycles.value).toBe(.1);
});
