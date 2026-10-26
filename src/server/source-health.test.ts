import { expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { installAnalysisTracking } from "../db/analysis";
import { buildSourceHealth, buildSourceInventory } from "./source-health";
import type { AppContext } from "./api";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareClaudeLabelPeriods } from "./subscription-reader.fixture";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { prepareSourceProfileEdit } from "./source-profile";
import { createTestDatabase } from "../sync/test-support";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const now = "2026-09-15T12:00:00Z";
// Archive folders whose account periods name kuba: a Codex row's account (stage 4, W6).
const MAIN = `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN-agy11`, LAPTOP = `${ARCHIVE_LOGICAL_ROOT}/codex/LAPTOP-mr`;
test("source configuration needs no event database", () => {
  const { db, ctx } = fixture();
  try {
    const inventory = buildSourceInventory(ctx, now, "LAPTOP");
    expect(inventory.activity_pending).toBe(true);
    expect(inventory.sources.find(row => row.machine === "LAPTOP")).toMatchObject({
      local: true, configured: true, status: "configured",
    });
  } finally { db.close(); }
});
test("activity stays explicit while the probe profile index initializes", () => {
  const { db, ctx } = fixture();
  try {
    const result = buildSourceHealth(ctx, now, "LAPTOP");
    expect(result.activity_pending).toBe(true);
    expect(result.sources.every(row => row.activity_pending)).toBe(true);
  } finally { db.close(); }
});
test("a configured local physical source remains editable before an account period owns its archive", () => {
  const { db, ctx } = fixture();
  try {
    const source = { vendor: "claude", machine: "LAPTOP", login: "fixture",
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/unassigned-local`, source_home: "C:/Users/fixture/.claude-extra" };
    ctx.accounts.sources.push(source);
    const row = buildSourceInventory(ctx, now, "LAPTOP").sources.find(candidate => candidate.archive === source.home);
    expect(row).toMatchObject({ machine: "LAPTOP", profile: source.source_home, archive: source.home,
      configured: true, historical: false, local: true, status: "configured" });
    expect(ctx.accounts.sources).toContain(source);
    const prepared = prepareSourceProfileEdit({ revision: "fixture", machine: "LAPTOP", login: "fixture",
      declarations: [source], resolved: [{ archive: source.home, profile: source.source_home }] },
    { revision: "fixture", index: 0, subscription: "unassigned-local", vendor: "claude",
      profile: source.source_home, archive: source.home });
    expect(prepared.sources).toEqual([source]);
  } finally { db.close(); }
});
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT);
    CREATE INDEX events_ts ON events(ts);
    CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,used_percent REAL,window_minutes INTEGER,limit_id TEXT);
    CREATE TABLE claude_events(id INTEGER PRIMARY KEY,path TEXT,subscription_id TEXT,ts TEXT,account_key TEXT,subscription_conflict INTEGER);
    CREATE TABLE grok_events(id INTEGER PRIMARY KEY,path TEXT,store TEXT,ts TEXT);
    CREATE TABLE gemini_events(id INTEGER PRIMARY KEY,path TEXT,store TEXT,ts TEXT);
    CREATE TABLE oc_events(id INTEGER PRIMARY KEY,store TEXT,ts TEXT);
    CREATE TABLE probe_windows(id INTEGER PRIMARY KEY,provider TEXT,subject TEXT,machine TEXT,ts TEXT,ok INTEGER,error TEXT,extra TEXT,
      kind TEXT,limit_group TEXT,scope TEXT,window_minutes REAL,profile TEXT,used_percent REAL,remaining_percent REAL,
      used REAL,remaining REAL,allowance REAL,resets_at TEXT,rate_limit_reached INTEGER,plan TEXT);
    INSERT INTO events VALUES(1,'${MAIN}','a','2026-09-13T10:00:00Z'),(2,'${LAPTOP}','b','2026-09-15T10:00:00Z');`);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");
  db.exec(fs.readFileSync(new URL("../../drizzle/0021_current_read_models.sql", import.meta.url), "utf8"));
  installFactDayRevisions(db);
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  const declarations = [
    { id: "kuba", vendor: "codex", account: "kuba@example.test", machine: "MAIN", home: MAIN, source_home: "C:/Users/sample_a/.codex-mr" },
    { id: "kuba", vendor: "codex", account: "kuba@example.test", machine: "LAPTOP", home: LAPTOP, source_home: "C:/Users/sample_a/.codex-mr" },
  ];
  const accounts = splitProbeReaderFixtureConfig(declarations);
  const ctx = { sqlite: db, accounts, codexDiscovery: { accounts: [], profiles: [] }, vendorDiscovery: { accounts: [], profiles: [] } } as unknown as AppContext;
  declareCodexEraPeriods(db, declarations);
  installAnalysisTracking(db);
  const probe = (machine: string | null, ts: string, ok = 1, error: string | null = null) => {
    const inserted = db.query(`INSERT INTO probe_windows(provider,subject,machine,ts,ok,error,extra,
      kind,profile,used_percent) VALUES('codex','stale',?,?,?,?,?,'primary','sample_a',?)`)
      .run(machine, ts, ok, error, JSON.stringify({ home: "C:/Users/sample_a/.codex-mr" }), ok ? 50 : null);
    for (let step = 0; publishCurrentBatch(db, currentRegistry(accounts.subscriptions, now), now, 32, accounts); step++) {
      if (step > 100) throw new Error("source fixture projection did not settle");
    }
    return inserted;
  };
  return { db, ctx, probe };
}

test("identical profile paths on two PCs retain independent session and meter freshness", () => {
  const { db, ctx, probe } = fixture();
  try {
    probe("MAIN", "2026-09-15T11:00:00Z"); probe("LAPTOP", "2026-09-15T11:05:00Z");
    const result = buildSourceHealth(ctx, now, "LAPTOP");
    expect(result.sources).toHaveLength(2);
    const main = result.sources.find(row => row.machine === "MAIN")!;
    expect(main.profile).toBe("C:/Users/sample_a/.codex-mr");
    expect(main.archive).toBe(MAIN);
    expect(main.last_session).toBe("2026-09-13T10:00:00Z");
    expect(main.status).toBe("older");
    expect(main.local).toBe(false);
    expect(result.sources.find(row => row.local)?.last_session).toBe("2026-09-15T10:00:00Z");
  } finally { db.close(); }
});

test("a fresh laptop gauge cannot stand in for its missing session assignment", () => {
  const { db, ctx, probe } = fixture();
  try {
    ctx.accounts.subscriptions!.pop(); db.exec("DELETE FROM events WHERE id=2");
    ctx.accounts.sources.splice(ctx.accounts.sources.findIndex(source => source.machine === "LAPTOP"), 1);
    probe("LAPTOP", "2026-09-15T11:00:00Z");
    probe(null, "2026-09-14T11:00:00Z");
    const rows = buildSourceHealth(ctx, now, "LAPTOP").sources;
    const laptop = rows.find(row => row.machine === "LAPTOP")!;
    expect(laptop.status).toBe("missing-assignment");
    expect(laptop.last_session).toBeNull();
    expect(laptop.last_meter).toBe("2026-09-15T11:00:00Z");
    expect(rows.find(row => row.machine === null)?.local).toBe(false);
  } finally { db.close(); }
});

test("a successful later reading clears an old error on only that physical source", () => {
  const { db, ctx, probe } = fixture();
  try {
    probe("MAIN", "2026-09-14T10:00:00Z", 0, "old error");
    probe("MAIN", "2026-09-15T11:00:00Z");
    probe("LAPTOP", "2026-09-15T11:00:00Z", 0, "login expired");
    const rows = buildSourceHealth(ctx, now, "LAPTOP").sources;
    expect(rows.find(row => row.machine === "MAIN")?.error).toBeNull();
    expect(rows.find(row => row.machine === "LAPTOP")?.error).toBe("login expired");
  } finally { db.close(); }
});

test("prepared profile health reads point probes without scanning probe history", () => {
  const { db, ctx, probe } = fixture();
  try {
    probe("MAIN", "2026-09-15T11:00:00Z");
    const query = db.query.bind(db);
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
      if (/FROM probe_windows/i.test(sql) && !/WHERE id=\?/i.test(sql))
        throw new Error("source health attempted a historical probe scan");
      return query(sql);
    }) as typeof db.query);
    try {
      expect(buildSourceHealth(ctx, now, "LAPTOP").sources.find(row => row.machine === "MAIN")?.last_meter)
        .toBe("2026-09-15T11:00:00Z");
    } finally { spy.mockRestore(); }
  } finally { db.close(); }
});

test("diagnostics show a session that arrives later with an older date", () => {
  const { db, ctx, probe } = fixture();
  try {
    probe("MAIN", "2026-09-15T11:00:00Z");
    const first = buildSourceHealth(ctx, now, "LAPTOP");
    expect(buildSourceHealth(ctx, now, "LAPTOP")).toEqual(first);
    db.query("INSERT INTO events VALUES(3,?,'a','2026-09-13T15:00:00Z')").run(MAIN);
    const changed = buildSourceHealth(ctx, now, "LAPTOP");
    expect(changed.sources.find(row => row.machine === "MAIN")?.last_session).toBe("2026-09-13T15:00:00Z");
  } finally { db.close(); }
});

test("vendor source paths map to declarations; absent computer provenance remains explicit", () => {
  const { db, ctx } = fixture();
  try {
    ctx.accounts.subscriptions!.push({ id: "claude1", vendor: "claude" });
    ctx.accounts.sources.push({ vendor: "claude", machine: "MAIN", login: "fixture",
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/claude1`, source_home: "C:/Users/fixture/.claude" });
    // The session names no account; the declared period of its archive folder gives it to claude1.
    db.exec(`INSERT INTO claude_events(id,path,subscription_id,ts) VALUES(1,'/archive/claude-main/projects/a.jsonl','claude1','2026-09-15T10:00:00Z');`);
    declareClaudeLabelPeriods(db);
    const rows = buildSourceHealth(ctx, now, "LAPTOP").sources;
    expect(rows.find(row => row.vendor === "claude")).toMatchObject({ machine: "MAIN", last_session: "2026-09-15T10:00:00Z" });
  } finally { db.close(); }
});

test("unowned prepared vendor sources keep unknown computer provenance", () => {
  const fixture = createTestDatabase(), db = new Database(fixture.dbPath);
  try {
    db.exec(`CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,used_percent REAL,window_minutes INTEGER,limit_id TEXT);
      INSERT INTO grok_events (store,session_id,prompt_id,ts,path,model,in_tok,cached_in,cache_write,out_tok,cost_ticks)
        VALUES ('source:grok:unknown','s','p','2026-09-15T10:00:00Z','${ARCHIVE_LOGICAL_ROOT}/grok/unknown/a.jsonl','grok-4',1,0,0,1,0);
      INSERT INTO gemini_events (store,conversation_id,gen_idx,ts,ts_basis,path,fresh_in,cached_in,out_total,usd)
        VALUES ('source:gemini:unknown','c',0,'2026-09-15T10:00:00Z','event','${ARCHIVE_LOGICAL_ROOT}/gemini/unknown/b.db',1,0,1,0);
      INSERT INTO oc_events (store,message_id,ts,provider,in_tok,out_tok,cache_read,cache_write,cost)
        VALUES ('unknown','m','2026-09-15T10:00:00Z','zai',1,1,0,0,0);`);
    prepareUsageRegisters(db,{version:1,currency:"USD",unit:"per 1M",vendors:{}});
    const accounts={version:2 as const,subscriptions:[],sources:[]};
    const rows=buildSourceHealth({sqlite:db,accounts},now,"LAPTOP").sources;
    for(const vendor of ["grok","gemini","opencode"]) {
      const row=rows.find(candidate=>candidate.vendor===vendor);
      expect(row).toMatchObject({subscription:"unassigned",machine:null,status:"unknown",
        last_session:"2026-09-15T10:00:00.000Z"});
    }
  } finally { db.close(); fs.rmSync(fixture.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});

test("thousands of session paths collapse into machine sources while native Codex limits remain visible", () => {
  const { db, ctx } = fixture();
  try {
    const insert = db.query("INSERT INTO claude_events(path,subscription_id,ts) VALUES(?,'claude1','2026-09-15T10:00:00Z')");
    for (let i = 0; i < 2000; i++) insert.run(`/archive/claude/LAPTOP/project/${i}.jsonl`);
    // The meter belongs to kuba through the account period of its archive folder.
    const meterHome = `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN-agy11`;
    ctx.accounts.subscriptions![0] = { ...ctx.accounts.subscriptions![0]!, home: meterHome };
    declareCodexEraPeriods(db, ctx.accounts.subscriptions!.slice(0, 1));
    db.query("INSERT INTO ratelimit VALUES(1,?,'a','2026-09-15T10:00:00Z',70,10080,'codex')").run(meterHome);
    const rows = buildSourceHealth(ctx, now, "LAPTOP", "/archive").sources;
    expect(rows.filter(row => row.vendor === "claude")).toHaveLength(1);
    expect(rows.find(row => row.vendor === "claude")).toMatchObject({ machine: "LAPTOP", archive: "/archive/claude/LAPTOP" });
    expect(rows.find(row => row.machine === "MAIN")?.last_meter).toBe("2026-09-15T10:00:00Z");
  } finally { db.close(); }
});
