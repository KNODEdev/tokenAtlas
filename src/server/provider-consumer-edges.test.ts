import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { createTestDatabase } from "../sync/test-support";
import { installAnalysisTracking } from "../db/analysis";
import { prepareProviderReaderFacts as prepareSubscriptionFacts } from "./provider-reader.fixture";
import { buildEraIndex, type EraIndex } from "./eras";
import { storedProjectUsage } from "./stored-project-usage";
import { storedHistoryUsage } from "./stored-history-usage";
import { buildRepoHistory, listSubjects, UnsafeRepoHistorySum } from "./repo-history";
import type { RateCard } from "./pricing";

function ensureColumns(db: Database): void {
  for (const table of ["grok_events", "oc_events"]) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((row) => row.name));
    for (const column of ["repo", "repo_group"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
}
function prepare(db: Database, eras: EraIndex, pairs: Array<["grok" | "glm", string]>): void {
  for (const [provider, account] of pairs) {
    let steps = 0;
    while (!prepareSubscriptionFacts(db, provider, account, eras, 10, edgeRates).complete) {
      if (++steps > 100) throw new Error("fact preparation did not finish");
    }
  }
}
function fixture() {
  const { directory, dbPath } = createTestDatabase();
  let db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  ensureColumns(db);
  installAnalysisTracking(db);
  return {
    get db() { return db; },
    reopen() { db.close(true); db = new Database(dbPath); },
    close() {
      db.close(true);
      Bun.gc(true);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

const edgeRates: RateCard = {
  version: 1, currency: "USD", unit: "per 1M",
  vendors: {
    xai: { source: "manual", models: {
      "grok-family": { in_uncached: 1, in_cache_read: 0, in_cache_write: 0, out_total: 0,
        until: "2026-08-31", after: { in_uncached: 2, in_cache_read: 0, in_cache_write: 0, out_total: 0 } },
      activity: { in_uncached: 1, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
      zero: { in_uncached: 0, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
    } },
    zai: { source: "manual", models: {
      known: { in_uncached: 1, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
      zero: { in_uncached: 0, in_cache_read: 0, in_cache_write: 0, out_total: 0 },
    } },
  },
  subscriptions: {},
};

test("stored era day, canonical UTC day, family pricing, mirrored selector and boundary activity stay disjoint", () => {
  const f = fixture();
  const eras = buildEraIndex([
    { id: "grok-old", vendor: "grok", home: "offset-original", source_home: "offset-copy", until: "2026-09-01" },
    { id: "grok-new", vendor: "grok", home: "offset-original", source_home: "offset-copy", from: "2026-09-01" },
    { id: "grok-activity", vendor: "grok", home: "activity-home" },
  ]);
  try {
    f.db.exec(`INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
      in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,repo_group,cost_ticks)
      VALUES('offset-original','one','offset-session','offset-prompt','grok-family-control',
        '2026-08-31T23:30:00-02:00','offset.jsonl',1000000,0,0,0,0,'alpha','repo-alpha','group-a',9000000000);
      INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
        in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,repo_group,cost_ticks)
      SELECT 'offset-copy','mirror',session_id,prompt_id,model,ts,path,
        in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,repo_group,cost_ticks
        FROM grok_events WHERE store='offset-original';
      INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
        in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,repo_group,cost_ticks)
      VALUES('activity-home','before','activity-session','before','activity','2026-08-31T23:58:00.000Z',
        'activity.jsonl',10,0,0,0,0,'alpha','repo-alpha','group-a',1),
        ('activity-home','selected','activity-session','selected','activity','2026-09-01T00:03:00.000Z',
        'activity.jsonl',10,0,0,0,0,'alpha','repo-alpha','group-a',1);`);
    prepare(f.db, eras, [["grok", "grok-old"], ["grok", "grok-new"], ["grok", "grok-activity"]]);
    const range = { since: "2026-09-01", until: "2026-09-01" };
    const project = storedProjectUsage(f.db, "grok", edgeRates, range);
    const old = project.groups.find((row) => row.account === "grok-new")!;
    expect(old).toMatchObject({ subject: "p:alpha", tokens: 1_000_000, calls: 1, api_usd: 2 });
    expect(project.accounts).not.toContain("grok-old");

    const history = storedHistoryUsage(f.db, "grok", edgeRates, { ...range, idleGapMinutes: 15 });
    const activity = history.rows.find((row) => row.account === "grok-activity")!;
    expect(activity).toMatchObject({ day: "2026-09-01", tokens: 10, calls: 1, active_seconds: 300 });
    const subjects = listSubjects(f.db, 15, range, { eras, rateCards: edgeRates });
    expect(subjects.find((row) => row.id === "alpha")).toMatchObject({
      tokens: 1_000_010, calls: 2, active_seconds: 180, session_seconds: 300, repos: ["repo-alpha"],
    });

    f.db.query("UPDATE grok_events SET ts=? WHERE store=? AND prompt_id=?")
      .run("2026-08-31T23:40:00.000Z", "activity-home", "before");
    prepare(f.db, eras, [["grok", "grok-old"], ["grok", "grok-new"], ["grok", "grok-activity"]]);
    f.reopen();
    const corrected = storedHistoryUsage(f.db, "grok", edgeRates, { ...range, idleGapMinutes: 15 });
    expect(corrected.rows.find((row) => row.account === "grok-activity")!.active_seconds).toBe(900);
    // The longer session gap remains mostly before the selected UTC day.
    expect(listSubjects(f.db, 15, range, { eras, rateCards: edgeRates }).find(row => row.id === "alpha"))
      .toMatchObject({ active_seconds: 180, session_seconds: 900 });
  } finally { f.close(); }
});

test("missing provider identities remain evidence and reported-money corrections never fill missing API rates", () => {
  const f = fixture();
  const eras = buildEraIndex([{ id: "glm-seat", vendor: "glm", home: "glm-home" }]);
  try {
    f.db.exec(`INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,project_id,repo,repo_group,
      in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES('glm-home','good','session','2026-09-01T12:00:00.000Z','not-configured','zai-coding-plan',
        'alpha','repo-alpha','group-a',100,0,0,0,0,7),
        ('glm-home','','bad-session','2026-09-01T13:00:00.000Z','known','zai-coding-plan',
        'alpha','repo-alpha','group-a',4,0,0,0,0,50),
        ('unmapped-home','orphan','orphan-session','2026-09-01T14:00:00.000Z','known','zai-coding-plan',
        'alpha','repo-alpha','group-a',8,0,0,0,0,80);`);
    prepare(f.db, eras, [["glm", "glm-seat"]]);
    const range = { since: "2026-09-01", until: "2026-09-01" };
    const before = storedProjectUsage(f.db, "glm", edgeRates, range);
    expect(before.groups).toEqual([]);
    expect(before.unpriced).toEqual([{ account: "glm-seat", model: "not-configured",
      reason: "missing_rate", tokens: 100, calls: 1 }]);
    expect(before.evidence).toHaveLength(2);
    expect(before.evidence).toEqual(expect.arrayContaining([
      { reason: "source_without_identity", tokens: 4, calls: 1 },
      { reason: "unmapped_account", tokens: 8, calls: 1 },
    ]));
    const history = storedHistoryUsage(f.db, "glm", edgeRates, { ...range, idleGapMinutes: 15 });
    expect(history.rows).toEqual([expect.objectContaining({ account: "glm-seat", subject: "p:alpha",
      tokens: 100, calls: 1, api_usd: 0, unpriced_calls: 1 })]);
    expect(history.evidence).toHaveLength(2);
    expect(history.evidence).toEqual(expect.arrayContaining([
      { reason: "source_without_identity", tokens: 4, calls: 1 },
      { reason: "unmapped_account", tokens: 8, calls: 1 },
    ]));

    f.db.exec("UPDATE oc_events SET cost=99 WHERE message_id='good'");
    prepare(f.db, eras, [["glm", "glm-seat"]]);
    const after = storedProjectUsage(f.db, "glm", edgeRates, range);
    // Vendor-reported money is no API valuation: the call stays unpriced.
    expect(after.groups).toEqual([]);
    expect(after.unpriced).toEqual(before.unpriced);
  } finally { f.close(); }
});

test("history reads corrected adjacent stored-day evidence after restart", () => {
  const f = fixture();
  const eras = buildEraIndex([]);
  const options = { since: "2026-09-01", until: "2026-09-01", eras, idleGapMinutes: 15 };
  try {
    f.db.exec(`INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES('unmapped','','session','2026-08-31T23:30:00-02:00','known','zai-coding-plan',4,0,0,0,0,0);`);
    prepare(f.db, eras, [["glm", "unmapped"]]);
    const before = storedHistoryUsage(f.db, "glm", edgeRates, options);
    expect(before.evidence).toEqual([{ reason: "source_without_identity", tokens: 4, calls: 1 }]);
    f.db.exec("UPDATE oc_events SET in_tok=9");
    prepare(f.db, eras, [["glm", "unmapped"]]);
    f.reopen();
    const corrected = storedHistoryUsage(f.db, "glm", edgeRates, options);
    expect(corrected.evidence).toEqual([{ reason: "source_without_identity", tokens: 9, calls: 1 }]);
  } finally { f.close(); }
});

test("zero-token conflicting identities are excluded globally and remain visible", () => {
  const f = fixture();
  const eras = buildEraIndex([
    { id: "grok-seat", vendor: "grok", home: "grok-original", source_home: "grok-copy" },
  ]);
  try {
    f.db.exec(`INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
      in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,cost_ticks)
      VALUES('grok-original','one','session','prompt','zero','2026-09-01T12:00:00.000Z','one.jsonl',
        0,0,0,0,0,'alpha','repo-alpha',0),
        ('grok-copy','two','session','prompt','zero','2026-09-20T12:00:00.000Z','two.jsonl',
        0,0,0,0,0,'alpha','repo-alpha',0);`);
    prepare(f.db, eras, [["grok", "grok-seat"]]);
    const range = { since: "2026-09-01", until: "2026-09-01" };
    const project = storedProjectUsage(f.db, "grok", edgeRates, range);
    expect(project.groups).toEqual([]);
    expect(project.conflicts).toEqual([{ account: "grok-seat", identities: 1 }]);
    const history = buildRepoHistory(f.db, { ...range, eras, rateCards: edgeRates,
      homeToSubId: new Map(), projectId: "alpha", repo: null, granularity: "day",
      by: "account", idleGapMinutes: 15 });
    expect(history.totals).toMatchObject({ tokens: 0, calls: 0, api_usd: 0, api_complete: false });
    expect(history.providers?.find((row) => row.provider === "grok")?.conflicts)
      .toEqual([{ account: "grok-seat", identities: 1 }]);
  } finally { f.close(); }
});

test("history and selector reject unsafe combined provider counters", () => {
  const f = fixture();
  const eras = buildEraIndex([
    { id: "grok-seat", vendor: "grok", home: "grok-home" },
    { id: "glm-seat", vendor: "glm", home: "glm-home" },
  ]);
  const huge = 4_600_000_000_000_000;
  try {
    f.db.query(`INSERT INTO grok_events(store,source_id,session_id,prompt_id,model,ts,path,
      in_tok,cached_in,cache_write,out_tok,reasoning,project_id,repo,cost_ticks)
      VALUES('grok-home','one','grok-session','prompt','zero','2026-09-01T12:00:00.000Z','one.jsonl',
        ?,0,0,0,0,'alpha','repo-alpha',0)`).run(huge);
    f.db.query(`INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,project_id,repo,
      in_tok,out_tok,reasoning,cache_read,cache_write,cost)
      VALUES('glm-home','message','glm-session','2026-09-01T13:00:00.000Z','zero','zai-coding-plan',
        'alpha','repo-alpha',?,0,0,0,0,0)`).run(huge);
    prepare(f.db, eras, [["grok", "grok-seat"], ["glm", "glm-seat"]]);
    const range = { since: "2026-09-01", until: "2026-09-01" };
    const history = () => buildRepoHistory(f.db, { ...range, eras, rateCards: edgeRates,
      homeToSubId: new Map(), projectId: "alpha", repo: null, granularity: "day",
      by: "account", idleGapMinutes: 15 });
    expect(history).toThrow(UnsafeRepoHistorySum);
    expect(() => listSubjects(f.db, 15, range, { eras, rateCards: edgeRates }))
      .toThrow(UnsafeRepoHistorySum);
  } finally { f.close(); }
});
