/**
 * The stored activity read (`readActivityDays`, docs/stored-activity-plan-2026-10-07.md step 5) equals the oracle with
 * the real owners: account periods that change owner inside a session, an account that owns a source again after
 * another's period, sessions continued in a second source of the same account (mixed), all six cutoffs, ranges of 7,
 * 30 and 365 days and the whole history. Synthetic database; no production data is read.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { Database } from "../db/sqlite";
import { ACTIVITY_CUTOFF_MINUTES } from "../db/usage-ledger";
import { createTestDatabase } from "../sync/test-support";
import { oracleActivity, oracleGaps, oracleIntervalUnion, type OracleFact } from "./activity-oracle";
import type { ActivityInterval } from "../db/activity-intervals";
import { loadAccountResolver } from "./account-resolver";
import { RATES } from "./claude-code-capacity.fixture";
import { ActivityPending, activityDayKey, readActivityDays } from "./ledger-sums";
import { fillUsageLedger, fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { handleRepoHistory, type AppContext } from "./api";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import { buildEraIndex } from "./eras";
import { storedHistoryUsage } from "./stored-history-usage";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PERIODS: Array<[source: string, from: string, until: string | null, account: string]> = [
  ["claude/account-a", "2000-01-01", "2026-09-20T12:00:00.000Z", "acct-a"],
  ["claude/account-a", "2026-09-20T12:00:00.000Z", null, "acct-b"],
  ["claude/account-b", "2000-01-01", null, "acct-a"],
  ["claude/account-c", "2000-01-01", "2026-09-10T00:00:00.000Z", "acct-b"],
  ["claude/account-c", "2026-09-10T00:00:00.000Z", "2026-09-15T06:30:00.000Z", "acct-a"],
  ["claude/account-c", "2026-09-15T06:30:00.000Z", null, "acct-b"],
];

for (const seed of [31, 32, 33]) {
  test(`stored activity reads equal the oracle per account, day and dimension at every cutoff and range (seed ${seed})`, () => {
    const { directory, dbPath } = createTestDatabase();
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
      installAnalysisTracking(db);
      installFactDayRevisions(db);
      for (const [source, from, until, account] of PERIODS) db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
        VALUES('claude',?,?,?,?,'declared',0,'fixture')`).run(source, from, until, account);
      const random = prng(seed), pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
      const start = Date.parse("2026-09-01T00:00:00.000Z");
      const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id)
        VALUES ('primary',?,?,?,?,?,'standard',?,'cli','2.1.0',1000,100,?)`);
      for (let call = 0; call < 700; call++) {
        const folder = pick(["account-a", "account-a", "account-b", "account-c"]);
        const at = start + Math.floor(random() * 35 * 24 * 12) * 300_000 + Math.floor(random() * 200) * 1000;
        // Mostly sessions of one folder; a few continue in another folder (mixed sessions).
        const session = random() < 0.05 ? null : random() < 0.1 ? pick(["shared-1", "shared-2"]) : `${folder}-${pick(["s1", "s2", "s3", "s4"])}`;
        insert.run(`c${call}`, session, `${ARCHIVE_LOGICAL_ROOT}/claude/${folder}/${session ?? "none"}.jsonl`, new Date(at).toISOString(),
          pick(["claude-sonnet-fixture", "claude-other"]), folder, pick(["alpha", "beta", null]));
      }
      const resolver = () => loadAccountResolver(db);
      // Before the ledger publishes activity, readers answer "preparing".
      fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
      db.exec("UPDATE usage_ledger_state SET activity_published=0 WHERE provider='claude'");
      expect(() => readActivityDays(db, "claude", resolver().plan("claude", "acct-a"), 15)).toThrow(ActivityPending);
      expect(() => readActivityDays(db, "claude", resolver().plan("claude", "acct-a"), 20)).toThrow("Unsupported idle cutoff");
      db.exec("UPDATE usage_ledger_state SET activity_published=1 WHERE provider='claude'");
      const facts = db.query(`SELECT row_id id, identity, ts, day, session, copy_state, eligible, vendor, source, account_key, dim_id, accounting
        FROM usage_ledger_facts WHERE provider='claude'`).all() as Array<OracleFact & { source: string | null; account_key: string | null;
        dim_id: number; day: string; accounting: number }>;
      expect(new Set(facts.map(fact => fact.source))).toEqual(new Set(["claude/account-a", "claude/account-b", "claude/account-c"]));
      expect((db.query("SELECT COUNT(*) n FROM usage_ledger_mixed_sessions WHERE provider='claude'").get() as { n: number }).n).toBeGreaterThan(0);
      const plans = ["acct-a", "acct-b"].map(account => resolver().plan("claude", account));
      const ownerOf = (fact: typeof facts[number]) => plans.find(plan => plan.owns(fact.source, fact.account_key, fact.ts))?.account ?? null;
      const gaps = oracleGaps("claude", facts, ownerOf);
      let compared = 0;
      for (const range of [{ since: "2026-09-29", until: "2026-10-05" }, { since: "2026-09-06", until: "2026-10-05" },
        { since: "2025-10-06", until: "2026-10-05" }, {}] as Array<{ since?: string; until?: string }>)
        for (const minutes of ACTIVITY_CUTOFF_MINUTES) {
          const oracle = oracleActivity("claude", facts, { cutoffMinutes: minutes, ownerOf, groupOf: fact => String(fact.dim_id), ...range });
          for (const plan of plans) {
            const expected = new Map<string, number>();
            for (const [key, ms] of oracle) {
              const [day, owner, dim] = key.split("\u0000");
              if (owner === plan.account) expected.set(activityDayKey(day!, Number(dim)), ms);
            }
            const intervals = new Map<string, ActivityInterval[]>(), expectedIntervals = new Map<string, ActivityInterval[]>();
            for (const fact of facts) {
              const gap = gaps.get(fact.id);
              if (!gap || gap.gapMs <= 0 || ownerOf(fact) !== plan.account || !fact.accounting
                || range.since && fact.day < range.since || range.until && fact.day > range.until) continue;
              const key = activityDayKey(fact.day, fact.dim_id), until = Date.parse(fact.ts);
              const spans = expectedIntervals.get(key) ?? [];
              spans.push([until - Math.min(gap.gapMs, minutes * 60000), until]); expectedIntervals.set(key, spans);
            }
            const actual = readActivityDays(db, "claude", plan, minutes, range, "e", intervals);
            expect(Object.fromEntries([...actual].sort())).toEqual(Object.fromEntries([...expected].sort()));
            expect(new Map([...intervals].map(([key, spans]) => [key, oracleIntervalUnion(spans)])))
              .toEqual(new Map([...expectedIntervals].map(([key, spans]) => [key, oracleIntervalUnion(spans)])));
            compared += expected.size;
          }
        }
      expect(compared).toBeGreaterThan(500);
    } finally {
      db.close(true);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);
}

test("the history answers only the stored idle cutoffs (D3); anything else is a 400 before any read", async () => {
  for (const value of ["20", "1", "240", "abc", "15.5"]) {
    const response = await handleRepoHistory({} as AppContext, new URL(`http://test/api/repo-history?idle_gap=${value}`));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Expected one of 5, 10, 15, 30, 45, 60 minutes");
  }
});

test("the Claude history answers from committed rows while the usage ledger catches up, then equals the oracle", async () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    installAnalysisTracking(db);
    installFactDayRevisions(db);
    db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('claude','claude/account-a','2000-01-01',NULL,'acct-a','declared',0,'fixture')`).run();
    const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id)
      VALUES ('primary',?,'s',?,?,'claude-sonnet-fixture','standard','account-a','cli','2.1.0',1000,100,'alpha')`);
    const path = `${ARCHIVE_LOGICAL_ROOT}/claude/account-a/s.jsonl`;
    insert.run("c1", path, "2026-09-10T10:00:00.000Z"); insert.run("c2", path, "2026-09-10T10:10:00.000Z");
    fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    fillUsageLedgerFixture(db, RATES, ["grok", "glm"]);
    const ctx = { sqlite: db, rateCards: RATES, homeToSubId: new Map(), eras: buildEraIndex([]), accounts: { version: 2, subscriptions: [], sources: [] } } as unknown as AppContext;
    const read = async (query: string) => {
      const response = await handleRepoHistory(ctx, new URL(`http://test/api/repo-history?since=2026-09-10&until=2026-09-10&idle_gap=5${query}`));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ subjects?: Array<{ id: string; calls: number; active_seconds: number }>; totals?: { calls: number; active_seconds: number } }>;
    };
    const both = async () => [(await read("")).subjects!.find(row => row.id === "alpha"), (await read("&project=alpha&granularity=day&by=account")).totals];
    expect(await both()).toEqual([expect.objectContaining({ calls: 2, active_seconds: 300 }), expect.objectContaining({ calls: 2, active_seconds: 300 })]);
    insert.run("late", path, "2026-09-10T10:04:00.000Z");
    for (let step = 0; step < 3; step++) stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "claude")?.status).toBe("pending");
    await both();
    fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    // 10:00, 10:04 (240 s), 10:10 (360 s, capped at 300).
    expect(await both()).toEqual([expect.objectContaining({ calls: 3, active_seconds: 540 }), expect.objectContaining({ calls: 3, active_seconds: 540 })]);
  } finally {
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);

test("a session entering and leaving the mixed list reads one generation between every producer step", () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    installAnalysisTracking(db);
    installFactDayRevisions(db);
    for (const source of ["claude/account-a", "claude/account-b"]) db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('claude',?,'2000-01-01',NULL,'acct-a','declared',0,'fixture')`).run(source);
    const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
      VALUES ('primary',?,'s',?,?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',1000,100)`);
    const path = (folder: string) => `${ARCHIVE_LOGICAL_ROOT}/claude/${folder}/s.jsonl`;
    insert.run("c1", path("account-a"), "2026-09-10T10:00:00.000Z", "account-a");
    insert.run("c2", path("account-a"), "2026-09-10T10:10:00.000Z", "account-a");
    fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    const read = () => {
      const resolver = loadAccountResolver(db);
      // The history reads the same rows; it refuses activity without its day row.
      storedHistoryUsage(db, "claude", RATES, { idleGapMinutes: 15, resolver });
      return [...readActivityDays(db, "claude", resolver.plan("claude", "acct-a"), 15).values()].reduce((sum, ms) => sum + ms, 0);
    };
    const walk = (before: number, after: number) => {
      const seen: number[] = [read()];
      for (let step = 0; step < 50 && !stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT).complete; step++) seen.push(read());
      seen.push(read());
      expect(seen.filter(total => total !== before && total !== after)).toEqual([]);
      expect(seen.at(-1)).toBe(after);
    };
    expect(read()).toBe(600_000);
    // The session continues in another source of the same account: it becomes mixed.
    insert.run("c3", path("account-b"), "2026-09-10T10:20:00.000Z", "account-b");
    walk(600_000, 1_200_000);
    expect(db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='claude'").all()).toEqual([{ session: "s" }]);
    // ... and leaves the list again.
    db.query("DELETE FROM claude_events WHERE call_id='c3'").run();
    walk(1_200_000, 600_000);
    expect(db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='claude'").all()).toEqual([]);
  } finally {
    db.close(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);

/**
 * A late call whose day row is not built yet changes nobody's predecessor until it is: every read between producer steps
 * equals the published answer, which the late call leaves unchanged here (1 200 s before and after).
 */
function lateCallScene(periods: Array<[source: string, from: string, until: string | null, account: string]>) {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  for (const [source, from, until, account] of periods) db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
    VALUES('claude',?,?,?,?,'declared',0,'fixture')`).run(source, from, until, account);
  const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
    VALUES ('primary',?,'s',?,?,?,'standard',?,'cli','2.1.0',1000,100)`);
  const call = (id: string, folder: string, time: string, model = "claude-sonnet-fixture") =>
    insert.run(id, `${ARCHIVE_LOGICAL_ROOT}/claude/${folder}/s.jsonl`, `2026-09-10T${time}:00.000Z`, model, folder);
  const read = (account: string) => {
    const resolver = loadAccountResolver(db);
    storedHistoryUsage(db, "claude", RATES, { idleGapMinutes: 15, resolver });
    return [...readActivityDays(db, "claude", resolver.plan("claude", account), 15, { since: "2026-09-10", until: "2026-09-10" }).values()]
      .reduce((sum, ms) => sum + ms, 0);
  };
  const walk = (account: string) => {
    const seen: number[] = [read(account)];
    for (let step = 0; step < 50 && !stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT).complete; step++) seen.push(read(account));
    seen.push(read(account));
    return seen;
  };
  return { db, call, read, walk, close() { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("a late call of a mixed session on a dimension not built yet is no predecessor until it is", () => {
  const f = lateCallScene(["claude/account-a", "claude/account-b", "claude/account-c"].map(source => [source, "2000-01-01", null, "acct-a"]));
  try {
    f.call("c1", "account-a", "10:00"); f.call("c2", "account-a", "10:10"); f.call("c3", "account-b", "10:20");
    fillUsageLedger(f.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    expect(f.db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='claude'").all()).toEqual([{ session: "s" }]);
    expect(f.read("acct-a")).toBe(1_200_000);
    // 10:05 from a third source: 10:05 (300 s), 10:10 (300 s), 10:20 (600 s) once built - still 1 200 s.
    f.call("late", "account-c", "10:05");
    expect(new Set(f.walk("acct-a"))).toEqual(new Set([1_200_000]));
  } finally { f.close(); }
}, 60_000);

test("at a period boundary a late call on a dimension not built yet is no predecessor until it is", () => {
  // The source changes hands at 10:30: acct-a owns 10:00-10:20, acct-b the call at 10:40 (no predecessor of its own).
  const f = lateCallScene([["claude/account-a", "2000-01-01", "2026-09-10T10:30:00.000Z", "acct-a"], ["claude/account-a", "2026-09-10T10:30:00.000Z", null, "acct-b"]]);
  try {
    for (const [id, time] of [["c1", "10:00"], ["c2", "10:10"], ["c3", "10:20"], ["c4", "10:40"]]) f.call(id!, "account-a", time!);
    fillUsageLedger(f.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    expect([f.read("acct-a"), f.read("acct-b")]).toEqual([1_200_000, 0]);
    // A late 10:05 call of another model (another dimension) in the same chain: 300 + 300 + 600 s once built.
    f.call("late", "account-a", "10:05", "claude-other");
    const seen = f.walk("acct-a");
    expect(new Set(seen)).toEqual(new Set([1_200_000]));
    expect(f.read("acct-b")).toBe(0);
  } finally { f.close(); }
}, 60_000);

test("a long session crossing an ownership boundary is read in linear time (perf guard)", () => {
  const f = lateCallScene([["claude/account-a", "2000-01-01", "2026-09-10T09:00:00.000Z", "acct-a"], ["claude/account-a", "2026-09-10T09:00:00.000Z", null, "acct-b"]]);
  try {
    // 40 000 calls a second apart on one day of one session and dimension, cut by the boundary at 09:00 (32 400 s in).
    const calls = 40_000, start = Date.parse("2026-09-10T00:00:00.000Z");
    const insert = f.db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
      VALUES ('primary',?,'s',?,?,'claude-sonnet-fixture','standard','account-a','cli','2.1.0',1000,100)`);
    f.db.transaction(() => { for (let index = 0; index < calls; index++)
      insert.run(`c${index}`, `${ARCHIVE_LOGICAL_ROOT}/claude/account-a/s.jsonl`, new Date(start + index * 1_000).toISOString()); })();
    fillUsageLedger(f.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    const resolver = loadAccountResolver(f.db), total = (account: string) =>
      [...readActivityDays(f.db, "claude", resolver.plan("claude", account), 15).values()].reduce((sum, ms) => sum + ms, 0);
    const started = performance.now();
    const owned = [total("acct-a"), total("acct-b")];
    const elapsed = performance.now() - started;
    // acct-a: 32 400 calls, acct-b the rest; each account's first call has no predecessor of its own.
    expect(owned).toEqual([(32_400 - 1) * 1_000, (calls - 32_400 - 1) * 1_000]);
    // Linear work takes a fraction of a second; a scan of the chain per call takes seconds at this length.
    expect(elapsed).toBeLessThan(1_500);
  } finally { f.close(); }
}, 180_000);
