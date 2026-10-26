import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { createTestDatabase } from "../sync/test-support";
import { installAnalysisTracking } from "../db/analysis";
import { prepareProviderReaderFacts as prepareSubscriptionFacts } from "./provider-reader.fixture";
import { buildEraIndex } from "./eras";
import { buildProjectCost } from "./project-cost";
import { buildRepoHistory } from "./repo-history";
import type { RateCard } from "./pricing";

const RANGE = { since: "2026-09-01", until: "2026-09-02" };
const rates: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  xai: { source: "synthetic", models: { fixture: { in_uncached: 1, in_cache_read: 2, in_cache_write: 3, out_total: 4 } } },
  zai: { source: "synthetic", models: { fixture: { in_uncached: 1, in_cache_read: 2, in_cache_write: 3, out_total: 4 } } },
}, subscriptions: { "grok-seat": { usd_per_month: 30.44 }, "glm-seat": { usd_per_month: 60.88 } } };
const eras = buildEraIndex([
  { id: "grok-seat", vendor: "grok", home: "grok-original", source_home: "grok-copy" },
  { id: "glm-seat", vendor: "glm", home: "glm-original", source_home: "glm-copy" },
]);

function fixture() {
  const { directory, dbPath } = createTestDatabase();
  let db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  for (const table of ["grok_events", "oc_events"]) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
    for (const column of ["repo", "repo_group"]) if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  installAnalysisTracking(db);
  db.exec(`INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
    in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,cost_ticks)
    VALUES('grok-original','first','grok-session','prompt','fixture','2026-09-01T12:00:00.000Z','synthetic.jsonl',
      1000000,200000,10000,100000,30000,'alpha','repo-alpha',9000000000);
    INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
      in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,cost_ticks)
      SELECT 'grok-copy','copy',session_id,prompt_id,model,ts,path,
        in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,cost_ticks FROM grok_events;
    INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,project_id,repo,
      in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES('glm-original','message','glm-session','2026-09-01T13:00:00.000Z','fixture','zai-coding-plan','alpha','repo-alpha',
        1000000,100000,30000,200000,10000,7);
    INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,project_id,repo,
      in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      SELECT 'glm-copy',message_id,session_id,ts,model,provider,project_id,repo,
        in_tok,out_tok,reasoning,cache_read,cache_write,cost FROM oc_events;`);
  const prepare = () => {
    for (const [provider, account] of [["grok", "grok-seat"], ["glm", "glm-seat"]]) {
      let steps = 0;
      while (!prepareSubscriptionFacts(db, provider!, account!, eras, 5, rates).complete) {
        if (++steps > 100) throw new Error("Synthetic fact preparation did not finish");
      }
    }
  };
  prepare();
  const project = () => buildProjectCost(db, rates, new Map(), { ...RANGE, eras });
  const history = () => buildRepoHistory(db, { ...RANGE, eras, rateCards: rates, homeToSubId: new Map(),
    projectId: "alpha", repo: null, granularity: "day", by: "account", idleGapMinutes: 15 });
  // The usage ledger's stored per-event valuations; reported money is not one of them.
  const valuations = () => db.query(`SELECT provider,row_id,identity,copy_state,std_usd,std_nano,std_femto,std_reason,
    act_usd,act_nano,act_femto,act_reason,glb_usd,glb_nano,glb_femto,glb_reason FROM usage_ledger_facts ORDER BY provider,row_id`).all();
  return { get db() { return db; }, prepare, project, history, valuations,
    reopen() { db.close(true); db = new Database(dbPath); },
    close() { db.close(true); Bun.gc(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}

test("Grok and GLM project amounts use canonical accounts, disjoint tokens and API rates instead of reported money", () => {
  const f = fixture();
  try {
    const report = f.project();
    // Grok: .8M fresh + .2M cache + .01M write + .1M total output = 1.11M / $1.63.
    // GLM: 1M fresh + .2M cache + .01M write + (.1M visible + .03M reasoning) = 1.34M / $1.95.
    expect(report.totals).toMatchObject({ tokens: 2_450_000, calls: 2, api_usd: 3.58, api_complete: true });
    expect(report.subscriptions.map(row => row.id).sort()).toEqual(["glm-seat", "grok-seat"]);
    const subject = report.subjects.find(row => row.subject === "p:alpha")!;
    expect(subject.tokens).toBe(2_450_000);
    expect(subject.by_sub).toEqual({ "grok-seat": 1.63, "glm-seat": 1.95 });
  } finally { f.close(); }
});

test("repository history uses the same canonical Grok and GLM calls and API amounts as project cost", () => {
  const f = fixture();
  try {
    const history = f.history();
    expect(history.totals).toMatchObject({ tokens: 2_450_000, calls: 2, api_usd: 3.58, api_complete: true });
    expect(Object.keys(history.totals.by_sub).sort()).toEqual(["glm-seat", "grok-seat"]);
    expect(history.points).toHaveLength(1);
    expect(history.points[0]!.split!["grok-seat"]!.tokens).toBe(1_110_000);
    expect(history.points[0]!.split!["glm-seat"]!.tokens).toBe(1_340_000);
  } finally { f.close(); }
});

test("money corrections and restart preserve provider valuations and canonical project totals", () => {
  const f = fixture();
  try {
    const before = { project: f.project(), history: f.history() };
    const priced = f.valuations();
    expect(priced.length).toBeGreaterThan(0);
    f.db.exec("UPDATE grok_events SET cost_ticks=11000000000; UPDATE oc_events SET cost=99;");
    f.prepare(); f.reopen();
    const after = { project: f.project(), history: f.history() };
    expect(after.project.totals).toEqual(before.project.totals);
    expect(after.history.totals).toEqual(before.history.totals);
    expect(f.valuations()).toEqual(priced);
  } finally { f.close(); }
});

test("a late contradictory Grok copy outside the selected days excludes its original and preserves GLM", () => {
  const f = fixture();
  try {
    f.project(); f.history();
    f.db.exec("UPDATE grok_events SET ts='2026-09-20T12:00:00.000Z',in_tok=2000000 WHERE store='grok-copy'");
    f.prepare(); f.reopen();
    const after = { project: f.project(), history: f.history() };
    expect(after.project.totals).toMatchObject({ tokens: 1_340_000, calls: 1, api_usd: 1.95, api_complete: false });
    expect(after.history.totals).toMatchObject({ tokens: 1_340_000, calls: 1, api_usd: 1.95, api_complete: false });
    expect(after.project.subscriptions.find(row => row.id === "glm-seat")!.api_complete).toBe(true);
    expect(after.project.notes.join(" ")).toMatch(/conflict|sprzeczn/i);
    expect(after.history.notes.join(" ")).toMatch(/conflict|sprzeczn/i);
  } finally { f.close(); }
});
