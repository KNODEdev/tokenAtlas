import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { canonicalJson } from "../config/canonical-json";
import { createProbeCollection, PROBE_FACT_TABLES, mergeProbeFacts, linkPublishedProbeFacts } from "../db/probe-facts";
import { loadAccountResolver } from "../server/account-resolver";
import type { ProbeSourceOptions } from "../server/probe-source";
import { restrictGaugeAccountPublication } from "./gauge-account-selection";

const sourceOptions: ProbeSourceOptions = {
  archiveRoot: "H:/Archive", defaultLogin: "sample_a",
  declarations: [
    { vendor: "codex", machine: "PC", home: "H:/Archive/codex/pc-profile", source_home: "C:/Users/sample_a/.codex-mr" },
    { vendor: "codex", machine: "LAPTOP", home: "H:/Archive/codex/laptop-profile", source_home: "C:/Users/sample_a/.codex-mr" },
  ],
};

function fixture(options = sourceOptions) {
  const db = new Database(":memory:"); applyDrizzleMigrations(drizzle(db));
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  db.exec("ATTACH DATABASE ':memory:' AS sync_stage");
  const tables = [...PROBE_FACT_TABLES, "probe_windows", "gauge_journal_receipts", "gauge_files"];
  for (const table of tables) {
    if (table === "probe_windows") {
      const { sql } = db.query("SELECT sql FROM main.sqlite_master WHERE type='table' AND name='probe_windows'").get() as {sql:string};
      db.exec(sql.replace(/^CREATE TABLE /i, "CREATE TABLE sync_stage."));
    } else db.exec(`CREATE TABLE sync_stage.${table} AS SELECT * FROM main.${table} WHERE 0`);
  }
  db.exec("CREATE TABLE sync_stage.gauge_replay_counters(counter_id TEXT PRIMARY KEY,ts TEXT)");
  const period = (source: string, from: string, until: string | null, account: string) =>
    db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,evidence)
      VALUES ('codex',?,?,?,?,'declared','fixture')`).run(source, from, until, account);
  const add = (ts: string, subject: string, machine = "PC", home: string | null = "C:/Users/sample_a/.codex-mr",
    replayed = true, extra: string | null = null) => {
    const fact = createProbeCollection([{ provider: "codex", subject, raw_subject: subject, ts, kind: "weekly",
      reported_percent_side: "used", used_percent: 20, machine, login: "sample_a", source_home: home, extra }])[0]!;
    db.query("INSERT INTO sync_stage.probe_observations VALUES (?,?)").run(fact.observation_id, canonicalJson(fact.header));
    db.query("INSERT INTO sync_stage.probe_counters VALUES (?,?,?,?,?)").run(fact.counter_id, fact.observation_id,
      canonicalJson(fact.discriminator), canonicalJson(fact.payload), fact.payload_digest);
    if (replayed) db.query("INSERT INTO sync_stage.gauge_replay_counters VALUES (?,?)").run(fact.counter_id, ts);
    return fact;
  };
  const select = (range?: {from:string|null;untilExclusive:string|null}) => db.transaction(() =>
    restrictGaugeAccountPublication(db, [{vendor:"codex",account:"a"}],
      {...options,resolver:loadAccountResolver(db, options.declarations)}, range)).immediate();
  const snapshot = () => Object.fromEntries([...tables,"gauge_replay_counters"].map(table =>
    [table, db.query(`SELECT * FROM sync_stage.${table} ORDER BY rowid`).all()]));
  return {db, add, period, select, snapshot};
}

test("recovery selects dated source, preserves originals and unrelated rows, and replays without duplicates", () => {
  const {db,add,period,select} = fixture();
  try {
    period("codex/pc-profile", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "a");
    period("codex/pc-profile", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z", "b");
    period("codex/laptop-profile", "2026-01-01T00:00:00Z", null, "b");
    const stale = add("2026-01-15T12:00:00Z", "B");
    const boundary = add("2026-02-01T00:00:00Z", "A");
    const laptop = add("2026-01-16T12:00:00Z", "A", "LAPTOP");
    add("2026-01-17T12:00:00Z", "A", "PC", "C:/Users/sample_a/.codex-mr", false);
    add("2026-03-15T12:00:00Z", "A");
    db.exec("INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side) VALUES ('codex','foreign','2025-01-01','weekly','used')");
    const unrelated = db.query("SELECT * FROM probe_windows").all();
    const original = db.query("SELECT * FROM sync_stage.probe_counters WHERE id=?").get(stale.counter_id);
    expect(select({from:"2026-01-01T00:00:00Z",untilExclusive:"2026-03-01T00:00:00Z"})).toEqual({
      days:[{vendor:"codex",account:"a",day:"2026-01-15"}],selectedCounters:1});
    expect(db.query("SELECT counter_id FROM sync_stage.gauge_replay_counters").all()).toEqual([{counter_id:stale.counter_id}]);
    expect(db.query("SELECT subject FROM sync_stage.probe_windows").all()).toEqual([{subject:"B"}]);
    expect(db.query("SELECT * FROM sync_stage.probe_counters WHERE id=?").get(stale.counter_id)).toEqual(original);
    expect(stale.payload_digest).toBe((original as {payload_digest:string}).payload_digest);
    expect(db.query("SELECT * FROM probe_windows").all()).toEqual(unrelated);
    const publish = () => db.transaction(() => {
      mergeProbeFacts(db,undefined,true);
      db.exec(`INSERT OR IGNORE INTO main.probe_windows
        (provider,subject,ts,kind,reported_percent_side,used_percent,extra,machine)
        SELECT provider,subject,ts,kind,reported_percent_side,used_percent,extra,machine
        FROM sync_stage.probe_windows s WHERE NOT EXISTS
          (SELECT 1 FROM main.probe_windows m WHERE m.provider=s.provider AND m.ts=s.ts
            AND m.kind IS s.kind AND m.machine IS s.machine)`);
      linkPublishedProbeFacts(db,true);
    }).immediate();
    publish(); publish();
    expect(db.query("SELECT subject,ts FROM probe_windows WHERE ts LIKE '2026%'").all()).toEqual([{subject:"B",ts:stale.payload.ts}]);
    expect(db.query("SELECT count(*) AS n FROM probe_counters").get()).toEqual({n:1});
    expect(db.query("SELECT count(*) AS n FROM probe_fact_legacy_map").get()).toEqual({n:1});
    expect(db.query("SELECT counter_id FROM probe_fact_legacy_map").get()).toEqual({counter_id:stale.counter_id});
    expect(db.query("SELECT payload,payload_digest FROM probe_counters WHERE id=?").get(stale.counter_id))
      .toEqual({payload:(original as {payload:string}).payload,payload_digest:stale.payload_digest});
    for (const fact of [boundary,laptop]) expect(db.query("SELECT 1 FROM probe_counters WHERE id=?").get(fact.counter_id)).toBeNull();
  } finally {db.close(true);}
});

test("period correction, gap, uncovered time, and source without observed account", () => {
  const {db,add,period,select} = fixture();
  try {
    period("codex/pc-profile", "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z", "a");
    period("codex/pc-profile", "2026-01-20T00:00:00Z", "2026-02-01T00:00:00Z", "b");
    const known = add("2026-01-03T00:00:00Z", "stale", "PC", "C:/Users/sample_a/.codex-mr", true, "{\"note\":\"no account id\"}");
    add("2026-01-15T00:00:00Z", "A");
    add("2025-12-15T00:00:00Z", "A");
    expect(select().selectedCounters).toBe(1);
    expect(db.query("SELECT counter_id FROM sync_stage.gauge_replay_counters").all()).toEqual([{counter_id:known.counter_id}]);
    db.query("UPDATE account_periods SET account='b' WHERE account='a'").run();
    db.query("INSERT INTO meta(key,value) VALUES ('account_periods_revision','fixture-correction')").run();
    expect(select().selectedCounters).toBe(0);
  } finally {db.close(true);}
});

test("missing or ambiguous source and invalid time fail before staged mutation", () => {
  for (const kind of ["missing", "ambiguous", "invalid"] as const) {
    const options = kind === "ambiguous" ? {...sourceOptions,declarations:[...sourceOptions.declarations,
      {vendor:"codex",machine:"PC",home:"H:/Archive/codex/other",source_home:"C:/Users/sample_a/.codex-mr"}]} : sourceOptions;
    const {db,add,period,select,snapshot} = fixture(options);
    try {
      period("codex/pc-profile", "2026-01-01T00:00:00Z", null, "a");
      add(kind === "invalid" ? "invalid-time" : "2026-01-15T00:00:00Z", "A", "PC",
        kind === "missing" ? null : "C:/Users/sample_a/.codex-mr");
      const before = snapshot();
      expect(() => select({from:"2026-01-01T00:00:00Z",untilExclusive:"2026-02-01T00:00:00Z"}))
        .toThrow(kind === "invalid" ? /Invalid canonical gauge timestamp/ : /physical source is missing or ambiguous/);
      expect(snapshot()).toEqual(before);
    } finally {db.close(true);}
  }
});
