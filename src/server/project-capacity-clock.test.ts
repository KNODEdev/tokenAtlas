/**
 * The project report and the capacities it publishes must be a function of saved evidence
 * only: the same sources and the same configuration must give the same numbers a minute
 * later, after a counter window resets and after a restart. A new observation, a corrected
 * source row or a changed rate must still move them.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createTestDatabase } from "../sync/test-support";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { GrokGaugeConfig } from "./grok-gauge-spans";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
import { prepareProviderReaderFacts as prepareSubscriptionFacts } from "./provider-reader.fixture";
import { buildGlmCalibration } from "./glm-limit";
import { storedGrokCalibration } from "./grok-limit";
import { buildSubscriptionCapacities, indexSubscriptionHomes } from "./capacity-equivalents";
import { buildProjectCost, type ProjectCostResponse } from "./project-cost";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";

const PROBE_SOURCES = [probeReaderFixtureSource("glm", "glm"), probeReaderFixtureSource("grok", "grok")];

/** $1 per input token keeps every expectation below an exact, readable integer. */
const CARDS = {
  version: 2,
  currency: "USD",
  unit: "USD per 1,000,000 tokens",
  vendors: {
    xai: { models: { grok: { in_uncached: 1_000_000, in_cache_read: 0, in_cache_write: 0, out_total: 0 } } },
    zai: {
      models: {
        "glm-test": { in_uncached: 1_000_000, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
      },
    },
  },
  subscriptions: {
    opencode: { plan: "coding", usd_per_month: 6 },
    grok: { plan: "SuperGrok", usd_per_month: 30 },
    codex1: { plan: "pro", usd_per_month: 200 },
  },
};
const HOMES = new Map<string, string>([["c:/users/test/.codex", "codex1"]]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oc_events (
    id INTEGER PRIMARY KEY, store TEXT DEFAULT 'opencode', message_id TEXT,
    ts TEXT, repo TEXT, project_id TEXT, model TEXT, provider TEXT,
    in_tok INTEGER, cache_read INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning INTEGER, session_id TEXT, cost_ticks INTEGER
  );
  CREATE TABLE IF NOT EXISTS grok_events (
    id INTEGER PRIMARY KEY, prompt_id TEXT,
    ts TEXT, repo TEXT, project_id TEXT, model TEXT, store TEXT, model_calls INTEGER,
    in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning INTEGER, cost_ticks INTEGER, session_id TEXT
  );
  CREATE TABLE IF NOT EXISTS probe_windows (
    provider TEXT, subject TEXT, ts TEXT, plan TEXT, kind TEXT,
    used_percent REAL, window_minutes REAL, allowance REAL, used REAL, remaining REAL,
    vendor_percent REAL, resets_at TEXT, extra TEXT
  );
`;

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-project-clock-"));
  fs.writeFileSync(path.join(dir, "rate-cards.json"), JSON.stringify(CARDS), "utf8");
  return dir;
}
function openDb(file = ":memory:"): Database {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}
function prepareAnalysis(db: Database, cards = CARDS): void {
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  for (const [provider, account] of [["grok", "grok"], ["glm", "opencode"]] as const) {
    let attempts = 0;
    while (!prepareSubscriptionFacts(db, provider, account,undefined,100,cards).complete) {
      if (++attempts > 100) throw new Error("Synthetic provider facts did not finish preparation");
    }
  }
}
function addGlmSample(
  db: Database,
  row: { kind: string; minutes: number; ts: string; percent: number; used: number; resets: string }
): void {
  db.query(
    `INSERT INTO probe_windows (provider, subject, ts, plan, kind, used_percent, window_minutes,
                                allowance, used, remaining, vendor_percent, resets_at, extra)
     VALUES ('glm', 'glm', ?, 'coding', ?, ?, ?, 100, ?, NULL, ?, ?, NULL)`
  ).run(row.ts, row.kind, row.percent, row.minutes, row.used, row.percent, row.resets);
  prepareProbeReaderFixture(db, PROBE_SOURCES);
}
function addZaiTraffic(db: Database, ts: string, tokens: number): void {
  db.query(
    `INSERT INTO oc_events (ts, repo, project_id, model, provider, in_tok, cache_read, cache_write,
                            out_tok, reasoning, session_id, message_id)
     VALUES (?, 'repo', 'app', 'glm-test', 'zai', ?, 0, 0, 0, 0, 's1', ?)`
  ).run(ts, tokens, ts);
}
function addGrokTurn(db: Database, ts: string, ticks: number): void {
  db.query(
    `INSERT INTO grok_events (ts, repo, project_id, model, store, model_calls, in_tok, cached_in,
                              cache_write, out_tok, reasoning, cost_ticks, session_id, prompt_id)
     VALUES (?, 'repo', 'app', 'grok', 'grok', 1, 10, 0, 0, 5, 0, ?, 's1', ?)`
  ).run(ts, ticks, ts);
}

const WEEKLY = {
  kind: "weekly",
  minutes: 10080,
  ts: "2026-08-18T12:00:00.000Z",
  percent: 50,
  used: 50,
  resets: "2026-08-20T00:00:00.000Z",
};
const SESSION = {
  kind: "session",
  minutes: 300,
  ts: "2026-08-18T16:00:00.000Z",
  percent: 40,
  used: 40,
  resets: "2026-08-18T18:00:00.000Z",
};

/**
 * A full-schema database with the GLM and Grok accounts' archive sources, then what the maintenance worker
 * publishes after the facts: limit windows, the usage ledger and window usage (with the Grok gauge given).
 */
function capacityDb() {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  cleanups.push(() => { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  const [glm, grok] = PROBE_SOURCES as [ReturnType<typeof probeReaderFixtureSource>, ReturnType<typeof probeReaderFixtureSource>];
  let n = 0;
  return {
    db,
    glmSample(row: { kind: string; minutes: number; ts: string; percent: number; used: number; resets: string }) {
      db.query(`INSERT INTO probe_windows (provider, subject, ts, plan, kind, reported_percent_side, used_percent, window_minutes,
          allowance, used, remaining, vendor_percent, resets_at, ok) VALUES ('glm', 'glm', ?, 'coding', ?, 'used', ?, ?, 100, ?, NULL, ?, ?, 1)`)
        .run(row.ts, row.kind, row.percent, row.minutes, row.used, row.percent, row.resets || null);
    },
    zai(ts: string, tokens: number) {
      db.query(`INSERT INTO oc_events (store, message_id, session_id, ts, model, provider, in_tok, out_tok, reasoning, cache_read, cache_write)
        VALUES (?, ?, 's1', ?, 'glm-test', 'zai', ?, 0, 0, 0, 0)`).run(glm.machine, `m${n++}`, ts, tokens);
    },
    grokTurn(ts: string, ticks: number) {
      db.query(`INSERT INTO grok_events (store, source_id, session_id, prompt_id, ts, model, path, in_tok, cached_in, out_tok, model_calls, cost_ticks)
        VALUES ('grok', '', 's1', ?, ?, 'grok', ?, 10, 0, 5, 1, ?)`).run(`p${n++}`, ts, `${grok.home}/sessions/s/updates.jsonl`, ticks);
    },
    grokProbe(ts: string, percent: number, minutes: number, reset: string, periodStart: string) {
      db.query(`INSERT INTO probe_windows (provider, subject, ts, plan, kind, reported_percent_side, used_percent, window_minutes, resets_at, ok, extra)
        VALUES ('grok', 'grok', ?, 'SuperGrok', 'weekly', 'used', ?, ?, ?, 1, ?)`)
        .run(ts, percent, minutes, reset, JSON.stringify({ period_start: periodStart, period_type: "USAGE_PERIOD_TYPE_WEEKLY" }));
    },
    publish(grokGauge: GrokGaugeConfig = {}) {
      prepareProbeReaderFixture(db, PROBE_SOURCES);
      fillUsageLedgerFixture(db, CARDS as never, ["glm", "grok"]);
      prepareWindowUsageFixture(db, { rateCards: CARDS as never, grokGauge, claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
    },
  };
}
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
/** The fixture publishes probe facts and three producers; under a loaded machine it needs more than the default 5 s. */
const FIXTURE_MS = 60_000;

describe("GLM capacity is fixed by each window's own observation", () => {
  function seed(f: ReturnType<typeof capacityDb>): void {
    f.glmSample(WEEKLY);
    f.glmSample(SESSION);
    f.zai("2026-08-12T00:00:00.000Z", 5); // before the weekly window start
    f.zai("2026-08-14T00:00:00.000Z", 3); // inside the weekly window
    f.zai("2026-08-18T12:00:00.000Z", 7); // exactly at the weekly reading
    f.zai("2026-08-18T14:00:00.000Z", 2); // inside the session window only
    f.zai("2026-08-19T00:00:00.000Z", 11); // after the weekly reading
    f.publish();
  }
  it("ends the numerator of a saved percentage at that percentage's own reading", () => {
    const f = capacityDb();
    seed(f);
    const report = buildGlmCalibration(f.db)!;
    // The running total at a reading includes the calls at its instant (window sums are (from, to]).
    expect(report.windows.find((w) => w.kind === "weekly")!.spend_usd).toBe(10);
    // Later traffic must not join a percentage that was read before it arrived.
    f.zai("2026-08-19T12:00:00.000Z", 100);
    f.publish();
    expect(buildGlmCalibration(f.db)!.windows.find((w) => w.kind === "weekly")?.spend_usd).toBe(10);
  }, FIXTURE_MS);
  it("aligns two window kinds to their own readings instead of the newest sample", () => {
    const f = capacityDb();
    seed(f);
    const dir = tempRoot();
    try {
      const report = buildGlmCalibration(f.db)!;
      const weekly = report.windows.find((w) => w.kind === "weekly")!;
      const session = report.windows.find((w) => w.kind === "session")!;
      expect([weekly.measured_at, session.measured_at]).toEqual([WEEKLY.ts, SESSION.ts]);
      expect(session.spend_usd).toBe(2);
      // The newest sample belongs to the session counter and may not date the weekly one.
      expect(report.measured_at).toBe(SESSION.ts);
      const capacity = buildSubscriptionCapacities(f.db, CARDS as never, HOMES, {
        rootDir: dir, claudeAccounts: [], subscriptions: ["opencode"], period: { since: "2026-08-13", until: "2026-08-19" },
      }).get("opencode")!;
      expect(capacity.usd_per_point).toBe(0.2); // 10 USD / 50 pp
      expect(capacity.weekly_window_value_usd).toBe(20);
      expect(capacity.session_window_value_usd).toBe(5); // 2 USD / 40 pp * 100
      expect(capacity.calibration_start_ts).toBe(WEEKLY.ts);
      expect(capacity.calibration_end_ts).toBe(SESSION.ts);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, FIXTURE_MS);
  it("keeps an unknown boundary unknown instead of measuring a zero", () => {
    const f = capacityDb();
    f.glmSample({ ...WEEKLY, resets: "" });
    f.zai("2026-08-14T00:00:00.000Z", 3);
    f.publish();
    const dir = tempRoot();
    try {
      expect(buildGlmCalibration(f.db)!.windows[0]!.spend_usd).toBeNull();
      const capacity = buildSubscriptionCapacities(f.db, CARDS as never, HOMES, {
        rootDir: dir, claudeAccounts: [], subscriptions: ["opencode"], period: { since: "2026-08-13", until: "2026-08-19" },
      }).get("opencode")!;
      expect(capacity.capacity_basis).toBe("none");
      expect(capacity.usd_per_point).toBeNull();
      expect(capacity.weekly_window_value_usd).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, FIXTURE_MS);
});

describe("Grok manual calibration is independent of the live probe", () => {
  const GAUGE = {
    subscription: "grok",
    store: "grok",
    observations: [{ ts: "2026-08-24T00:00:00.000Z", percent: 100 }],
  };
  it("does not let the probe row exist or expire change the capacity it publishes", () => {
    const f = capacityDb();
    f.grokTurn("2026-08-19T00:00:00.000Z", 40_000_000_000); // inside 168 h, outside 72 h
    f.grokTurn("2026-08-23T00:00:00.000Z", 60_000_000_000); // inside both
    // A live weekly reading whose own period is only 72 h long.
    f.grokProbe("2026-08-30T12:00:00.000Z", 33, 4320, "2026-09-01T18:00:00.000Z", "2026-08-29T18:00:00.000Z");
    f.publish(GAUGE);
    const dir = tempRoot();
    try {
      const measure = () => buildSubscriptionCapacities(f.db, CARDS as never, HOMES, {
        rootDir: dir, grokGauge: GAUGE, claudeAccounts: [], subscriptions: ["grok"], period: { since: "2026-08-17", until: "2026-08-24" },
      }).get("grok")!;
      const withProbe = measure();
      f.db.exec("DELETE FROM probe_windows WHERE provider='grok'");
      const withoutProbe = measure();
      expect(withoutProbe).toEqual(withProbe);
      expect(withProbe.window_hours).toBe(168);
      expect(withProbe.capacity_basis).toBe("single");
      // xAI's own price of both turns (100 USD) at 100%: 1 USD per point, over the declared window.
      expect(withProbe.usd_per_point).toBe(1);
      expect(storedGrokCalibration(f.db, GAUGE).window_hours).toBe(168);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, FIXTURE_MS);
});

describe("Subscription capacity selection", () => {
  const unknownBindings = (ids: string[]) => [
    new Map<string,string>(),
    ...[undefined, '', '   '].map(vendor => indexSubscriptionHomes(
      ids.map(id => ({id,home:`C:/synthetic/unknown-${id}`})),
      ids.map(id => ({vendor,home:`C:/synthetic/unknown-${id}`})),
    )),
  ];
  it("keeps Grok calibration without a monthly price for omitted, explicit and empty selections", () => {
    const f=capacityDb(),dir=tempRoot();
    const gauge={subscription:'grok',store:'grok',observations:[{ts:'2026-08-24T00:00:00.000Z',percent:50}]};
    try {
      f.grokTurn('2026-08-23T00:00:00.000Z',75_000_000_000);f.publish(gauge);
      for(const homes of unknownBindings(['grok']))
        for(const subscriptions of [{grok:{usd_per_month:30}},{}]) for(const selection of [undefined,['GROK'],[]]) {
        const cards={...CARDS,subscriptions},opts={rootDir:dir,grokGauge:gauge,claudeAccounts:[],subscriptions:selection};
        const read=buildSubscriptionCapacities(f.db,cards as never,homes,opts);
        const native=buildSubscriptionCapacities(f.db,cards as never,homes,{...opts,fromStored:false});
        expect(read.get('grok')).toEqual(native.get('grok'));
        if(selection?.length===0) expect(read.size).toBe(0);
        else expect(read.get('grok')).toMatchObject({vendor:'grok',weekly_window_value_usd:150,capacity_basis:'single',
          usd_per_month:'grok' in subscriptions?30:null,price_basis:'grok' in subscriptions?'rate-card':'none'});
      }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  },FIXTURE_MS);
  it("preserves both GLM aliases independently of configured price keys and selection case", () => {
    const f=capacityDb(),dir=tempRoot();
    try {
      f.glmSample(WEEKLY);f.zai('2026-08-14T00:00:00.000Z',3);f.publish();
      for(const homes of unknownBindings(['glm','opencode']))
        for(const subscriptions of [{opencode:{usd_per_month:20}},{glm:{usd_per_month:20}},{}])
        for(const selection of [undefined,['GLM'],['OpenCode'],[]]) {
          const cards={...CARDS,subscriptions},opts={rootDir:dir,claudeAccounts:[],subscriptions:selection};
          const read=buildSubscriptionCapacities(f.db,cards as never,homes,opts);
          const native=buildSubscriptionCapacities(f.db,cards as never,homes,{...opts,fromStored:false});
          const keys=selection===undefined?['glm','opencode']:selection.map(id=>id.toLowerCase());
          if(selection?.length===0)expect(read.size).toBe(0);
          for(const key of keys){
            expect(read.get(key)).toEqual(native.get(key));
            expect(read.get(key)).toMatchObject({weekly_window_value_usd:6,capacity_basis:'single',
              usd_per_month:Object.keys(subscriptions).length?20:null});
          }
          if(selection?.length) for(const key of ['glm','opencode']) if(!keys.includes(key))expect(read.has(key)).toBe(false);
        }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  },FIXTURE_MS);
  it("measures only the accounts the caller will read", () => {
    const f = capacityDb();
    f.glmSample(WEEKLY);
    f.zai("2026-08-14T00:00:00.000Z", 3);
    f.publish();
    const dir = tempRoot();
    try {
      const period = { since: "2026-08-13", until: "2026-08-19" };
      const all = buildSubscriptionCapacities(f.db, CARDS as never, HOMES, { rootDir: dir, claudeAccounts: [], period });
      expect(all.get("opencode")?.capacity_basis).toBe("single");
      expect(all.get("glm")?.capacity_basis).toBe("single");
      const other = buildSubscriptionCapacities(f.db, CARDS as never, HOMES, { rootDir: dir, claudeAccounts: [], subscriptions: ["grok"], period });
      // Explicit account selection excludes unrelated calibration and fallback price rows.
      expect(other.has("opencode")).toBe(false);
      expect(other.has("glm")).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, FIXTURE_MS);
  it("leaves a period without any boundary unknown instead of dating it today", () => {
    const db = openDb();
    const dir = tempRoot();
    try {
      const codex = buildSubscriptionCapacities(db, CARDS as never, HOMES, {
        rootDir: dir,
        claudeAccounts: [],
        period: { since: null, until: null },
      }).get("codex1")!;
      expect(codex.capacity_basis).toBe("none");
      expect(codex.calibration_start_ts).toBeNull();
      expect(codex.calibration_end_ts).toBeNull();
      expect(codex.note).toBe("nieznany zakres pomiaru: okres bez granic");
      expect(codex.usd_per_month).toBe(200);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("selects nothing at all for an empty report", () => {
    const f = capacityDb();
    f.glmSample(WEEKLY);
    f.zai("2026-08-14T00:00:00.000Z", 3);
    f.publish();
    const dir = tempRoot();
    try {
      const none = buildSubscriptionCapacities(f.db, CARDS as never, HOMES, {
        rootDir: dir, claudeAccounts: [], subscriptions: [], period: { since: null, until: null },
      });
      for (const capacity of none.values()) expect(capacity.capacity_basis).toBe("none");
      expect(none.has("glm")).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, FIXTURE_MS);
  it("answers an empty report with zeros and no dates of its own", () => {
    const db = openDb();
    prepareAnalysis(db);
    try {
      const report = buildProjectCost(db, CARDS as never, HOMES, {});
      expect(report.since).toBeNull();
      expect(report.until).toBeNull();
      expect(report.subscriptions).toEqual([]);
      expect(report.subjects).toEqual([]);
      expect(report.totals.api_usd).toBe(0);
      expect(report.totals.paid_usd).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("A project report survives the clock", () => {
  function seedReport(db: Database): void {
    addGrokTurn(db, "2026-08-19T00:00:00.000Z", 40_000_000_000);
    addGrokTurn(db, "2026-08-23T00:00:00.000Z", 60_000_000_000);
    addZaiTraffic(db, "2026-08-14T00:00:00.000Z", 3);
    addGlmSample(db, WEEKLY);
    addGlmSample(db, SESSION);
  }
  function survivesRestart(options: { since?: string; until?: string }): void {
    const dir = tempRoot();
    const file = path.join(dir, "index.sqlite");
    const before = ((): ProjectCostResponse => {
      const first = openDb(file);
      try {
        seedReport(first);
        prepareAnalysis(first);
        return buildProjectCost(first, CARDS as never, HOMES, options);
      } finally {
        first.close();
      }
    })();
    const second = openDb(file);
    try {
      prepareAnalysis(second);
      // A later minute, and a counter window that has since reset, with no new evidence.
      const read = (() => {
        const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-30T00:00:00.000Z"));
        try {
          return buildProjectCost(second, CARDS as never, HOMES, options);
        } finally {
          clock.mockRestore();
        }
      })();
      expect(read).toEqual(before);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  it("answers a bounded historical range the same after a minute, a window reset and a restart", () => {
    survivesRestart({ since: "2026-08-01", until: "2026-08-31" });
  });
  it("answers an unbounded range resolved from the traffic it found the same", () => {
    survivesRestart({});
  });
  it("still answers with the evidence it has: a correction, a new observation and a new rate", () => {
    const db = openDb();
    try {
      seedReport(db);
      prepareAnalysis(db);
      const options = { since: "2026-08-01", until: "2026-08-31" };
      const before = buildProjectCost(db, CARDS as never, HOMES, options);
      expect(before.totals.api_usd).toBeGreaterThan(0);
      // A token correction changes API value; vendor-reported money is separate evidence.
      db.exec("UPDATE grok_events SET in_tok = in_tok * 2 WHERE ts = '2026-08-23T00:00:00.000Z'");
      prepareAnalysis(db);
      const corrected = buildProjectCost(db, CARDS as never, HOMES, options);
      expect(corrected.totals.api_usd).toBeGreaterThan(before.totals.api_usd);
      expect(buildProjectCost(db, CARDS as never, HOMES, options)).toEqual(corrected);
      // A new percentage reading is new evidence for the capacity this report publishes.
      addGlmSample(db, { ...WEEKLY, ts: "2026-08-19T12:00:00.000Z", percent: 25, used: 25 });
      const observed = buildProjectCost(db, CARDS as never, HOMES, options);
      // An observation is not traffic: the money stays exactly where it was.
      expect(observed.totals.api_usd).toBe(corrected.totals.api_usd);
      // A changed rate changes the valuation of the same traffic.
      const dearer = {
        ...CARDS,
        vendors: {
          ...CARDS.vendors,
          zai: {
            models: {
              "glm-test": { in_uncached: 2_000_000, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
            },
          },
        },
      };
      prepareAnalysis(db,dearer);
      const repriced = buildProjectCost(db, dearer as never, HOMES, options);
      expect(repriced.totals.api_usd).toBeGreaterThan(corrected.totals.api_usd);
    } finally {
      db.close();
    }
  });
});
