/**
 * The activity oracle (activity-oracle.ts) equals the Claude history activity on randomized synthetic Claude traffic -
 * frozen on 07.10.2026 against the engine of that day (`buildClaudeHistoryUsage`), now checked against the stored read
 * path that replaced it (`storedHistoryUsage`, and `buildRepoHistory` at every granularity and breakdown): two verified accounts sharing session ids, calls without a session,
 * simultaneous calls, duplicate copies carrying another session, a preserved timestamp offset, and ranges that
 * start after a session's earlier calls. Self-contained temporary database; no production data is read.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../db/sqlite";
import { installAnalysisTracking } from "../db/analysis";
import { loadAccountResolver } from "./account-resolver";
import { storedHistoryUsage } from "./stored-history-usage";
import { buildRepoHistory, type Breakdown, type Granularity } from "./repo-history";
import { ACTIVITY_CUTOFF_MINUTES } from "../db/usage-ledger";
import { oracleActivity, oracleGaps, oracleIntervalUnion, type OracleFact } from "./activity-oracle";
import { prepareClaudeReaderFixture } from "./subscription-reader.fixture";
import type { RateCard } from "./pricing";

const RATES: RateCard = {
  version: 1, currency: "USD", unit: "per 1M",
  vendors: { anthropic: { source: "synthetic", models: { "m-std": { in_uncached: 3, in_cache_read: 0.3, in_cache_write_5m: 3.75,
    in_cache_write_1h: 6, out_total: 15 }, "m-two": { in_uncached: 1, in_cache_read: 0.1, in_cache_write_5m: 1.25, in_cache_write_1h: 2,
    out_total: 5 } } } },
};
const SCHEMA = `
  CREATE TABLE claude_events(id INTEGER PRIMARY KEY, store TEXT, call_id TEXT, session_id TEXT, ts TEXT,
    model TEXT, speed TEXT, entrypoint TEXT, cc_version TEXT, project_id TEXT, repo TEXT, repo_group TEXT,
    subscription_id TEXT, subscription_conflict INTEGER DEFAULT 0, in_uncached INTEGER DEFAULT 0,
    in_cache_read INTEGER DEFAULT 0, in_cache_write INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0,
    cache_write_1h INTEGER DEFAULT 0, out_total INTEGER DEFAULT 0, out_thinking INTEGER DEFAULT 0);
  CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, subject TEXT, ts TEXT, kind TEXT, scope TEXT,
    used_percent REAL, resets_at TEXT, extra TEXT);
  CREATE TABLE analysis_source_revisions(source TEXT, bucket TEXT, revision INTEGER, PRIMARY KEY(source,bucket));`;

/** Deterministic PRNG (mulberry32). */
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

function randomTraffic(seed: number) {
  const random = prng(seed), pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const start = Date.parse("2026-09-10T00:00:00.000Z");
  const rows: Array<[number, string, string, string | null, string, string, string | null, string | null, string]> = [];
  let id = 1;
  for (let call = 0; call < 260; call++) {
    // Minutes on a coarse grid so equal instants and exact-cap gaps occur; a few hours-long silences.
    const at = start + Math.floor(random() * 7 * 24 * 12) * 5 * 60_000 + (random() < 0.2 ? 0 : Math.floor(random() * 300) * 1000);
    let ts = new Date(at).toISOString();
    // A preserved offset: the stored text names another calendar day than the UTC instant.
    if (random() < 0.05) ts = new Date(at + 2 * 3_600_000).toISOString().replace("Z", "+02:00").replace(/\.\d{3}/, "");
    const session = random() < 0.1 ? null : pick(["s1", "s2", "s3", "s4", "s5", "s6"]);
    const account = pick(["acct-a", "acct-a", "acct-b"]);
    const project = pick(["alpha", "beta", null]);
    rows.push([id++, "primary", `c${call}`, session, ts, pick(["m-std", "m-two"]), project, project ? `repo-${project}` : "repo-x", account]);
    // A second copy of the same call: the canonical copy is the lexically least row id, its session wins.
    if (random() < 0.08) rows.push([id++ + 1000, "mirror", `c${call}`, pick(["s1", "s7", null]), ts, rows.at(-1)![5], project,
      rows.at(-1)![7], account]);
  }
  return rows;
}

function fixture(seed: number) {
  const directory = mkdtempSync(join(tmpdir(), "activity-oracle-"));
  const db = new Database(join(directory, "atlas.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  installAnalysisTracking(db);
  const insert = db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,project_id,repo,repo_group,
    subscription_id,in_uncached,out_total) VALUES(?,?,?,?,?,?,'standard','cli','2.0.0',?,?,'grp',?,1000,100)`);
  for (const row of randomTraffic(seed)) insert.run(...row);
  insert.finalize();
  prepareClaudeReaderFixture(db, RATES);
  return { db, teardown() { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

type LedgerFact = OracleFact & { source: string | null; account_key: string | null; subject: string | null; repo: string | null;
  repo_group: string | null; model: string | null };
function ledgerFacts(db: Database): LedgerFact[] {
  return (db.query(`SELECT row_id id, identity, ts, session, copy_state, eligible, vendor, source, account_key, subject, repo, repo_group, model
    FROM usage_ledger_facts WHERE provider='claude'`).all() as LedgerFact[]);
}

for (const seed of [1, 2, 3, 4, 5]) {
  test(`the oracle equals the Claude history activity per account, day, subject and model (seed ${seed})`, () => {
    const { db, teardown } = fixture(seed);
    try {
      const resolver = loadAccountResolver(db);
      const plans = ["acct-a", "acct-b"].map(account => resolver.plan("claude", account));
      const facts = ledgerFacts(db);
      const ownerOf = (fact: LedgerFact) => plans.find(plan => plan.owns(fact.source, fact.account_key, fact.ts))?.account ?? null;
      const groupOf = (fact: LedgerFact) => JSON.stringify([fact.subject, fact.repo, fact.repo_group, fact.model]);
      // Both accounts own calls of one session id, and some copies disagree about the session.
      expect(new Set(facts.filter(fact => fact.session === "s1" && fact.copy_state === "canonical").map(ownerOf)).size).toBe(2);
      let compared = 0;
      for (const range of [{}, { since: "2026-09-12" }, { since: "2026-09-13", until: "2026-09-14" }] as Array<{ since?: string; until?: string }>)
        for (const cutoffMinutes of ACTIVITY_CUTOFF_MINUTES) {
          const usage = storedHistoryUsage(db, "claude", RATES, { ...range, idleGapMinutes: cutoffMinutes, resolver });
          const today = new Map<string, number>();
          for (const row of usage.rows) if (row.active_seconds > 0) {
            const key = `${row.day}\u0000${row.account}\u0000${JSON.stringify([row.subject, row.repo, row.repo_group, row.model])}`;
            today.set(key, (today.get(key) ?? 0) + row.active_seconds * 1000);
          }
          const oracle = oracleActivity("claude", facts, { cutoffMinutes, ownerOf, groupOf, ...range });
          expect([...oracle.keys()].sort()).toEqual([...today.keys()].sort());
          for (const [key, ms] of oracle) { expect(Math.abs(ms - today.get(key)!)).toBeLessThan(1e-6); compared++; }
        }
      expect(compared).toBeGreaterThan(100);
      // A gap is positive or zero, its predecessor is earlier, and the first call of a chain has none.
      const gaps = oracleGaps("claude", facts, ownerOf);
      for (const fact of facts) {
        const gap = gaps.get(fact.id);
        if (!gap) continue;
        expect(gap.gapMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(fact.ts) - Date.parse(gap.from)).toBe(gap.gapMs);
        expect(fact.copy_state).toBe("canonical");
        expect(fact.session).not.toBeNull();
      }
    } finally { teardown(); }
  }, 60_000);
}

test("the oracle's rule on a hand-checked chain: cap, zero gap, no session, other owner, OpenCode-other class", () => {
  const fact = (id: number, ts: string, session: string | null, extra: Partial<OracleFact & { owner: string }> = {}) =>
    ({ id, identity: `i${id}`, ts, session, copy_state: "canonical", eligible: 1, vendor: "zai", owner: "a", ...extra });
  const facts = [
    fact(1, "2026-09-01T10:00:00.000Z", "s"),
    fact(2, "2026-09-01T10:00:00.000Z", "s"), // same instant: gap 0
    fact(3, "2026-09-01T10:10:00.000Z", "s"), // 600 s
    fact(4, "2026-09-15T10:00:00.000Z", "s"), // two weeks later: capped
    fact(5, "2026-09-15T10:01:00.000Z", null), // no session
    fact(6, "2026-09-15T10:02:00.000Z", "s", { owner: "b" }), // another owner: new chain
    fact(7, "2026-09-15T10:03:00.000Z", "s", { copy_state: "duplicate" }), // not canonical
    fact(8, "2026-09-15T10:04:00.000Z", "s", { eligible: 0, vendor: "openrouter" }), // OpenCode-other: own class
    fact(9, "2026-09-15T10:06:00.000Z", "s", { eligible: 0, vendor: "openrouter" }),
    fact(10, "2026-09-15T10:07:00.000Z", "s", { eligible: 0, vendor: "zai" }), // ineligible on a zai rate: no chain
  ];
  const ownerOf = (f: typeof facts[number]) => f.owner;
  expect([...oracleGaps("glm", facts, ownerOf)].map(([id, gap]) => [id, gap.gapMs])).toEqual([[2, 0], [3, 600_000], [4, 1_209_000_000], [9, 120_000]]);
  expect(oracleGaps("claude", facts, ownerOf).has(9)).toBe(false);
  const sums = oracleActivity("glm", facts, { cutoffMinutes: 15, ownerOf, groupOf: () => "g" });
  expect(Object.fromEntries(sums)).toEqual({ "2026-09-01\u0000a\u0000g": 600_000, "2026-09-15\u0000a\u0000g": 900_000 + 120_000 });
  // A range starting on the later day still bridges from the call two weeks before it.
  expect(oracleActivity("glm", facts, { cutoffMinutes: 15, ownerOf, groupOf: () => "g", since: "2026-09-15" }).get("2026-09-15\u0000a\u0000g"))
    .toBe(1_020_000);
});

/** Monday-based week or month of a UTC day, as the history buckets it. */
const bucketOf = (day: string, granularity: Granularity) => granularity === "month" ? day.slice(0, 7) : granularity === "day" ? day
  : new Date(Date.parse(`${day}T00:00:00.000Z`) - ((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);

test("project history preserves session sums and unions wall time at every cutoff, granularity and breakdown", () => {
  const { db, teardown } = fixture(9);
  try {
    const resolver = loadAccountResolver(db);
    const plans = ["acct-a", "acct-b"].map(account => resolver.plan("claude", account));
    const facts = ledgerFacts(db);
    const ownerOf = (fact: LedgerFact) => plans.find(plan => plan.owns(fact.source, fact.account_key, fact.ts))?.account ?? null;
    let compared = 0;
    for (const range of [{ since: "2026-09-10", until: "2026-09-16" }, { since: "2026-09-13", until: "2026-09-14" }])
      for (const cutoffMinutes of ACTIVITY_CUTOFF_MINUTES) {
        const oracle = oracleActivity("claude", facts, { cutoffMinutes, ownerOf, groupOf: fact => JSON.stringify([fact.subject, fact.model]), ...range });
        const gaps = oracleGaps("claude", facts, ownerOf);
        for (const granularity of ["day", "week", "month"] as const) for (const by of ["none", "vendor", "model", "account"] as const) {
          const history = buildRepoHistory(db, { repo: null, projectId: "alpha", granularity, by: by as Breakdown, idleGapMinutes: cutoffMinutes, ...range,
            rateCards: RATES, homeToSubId: new Map(), machineOf: () => "ORACLE-PC" });
          const buckets = new Map<string, number>(), splits = new Map<string, number>();
          const intervals = new Map<string, Array<[number, number]>>();
          const add = (key: string, a: number, b: number) => {
            const spans = intervals.get(key) ?? []; spans.push([a, b]); intervals.set(key, spans);
          };
          for (const fact of facts) {
            const gap = gaps.get(fact.id), account = ownerOf(fact);
            if (!gap || !account || fact.subject !== "p:alpha" || gap.gapMs <= 0) continue;
            const until = Math.min(Date.parse(fact.ts), Date.parse(range.until) + 86_400_000);
            let start = Math.max(Date.parse(fact.ts) - Math.min(gap.gapMs, cutoffMinutes * 60_000), Date.parse(range.since));
            while (start < until) {
              const day = new Date(start).toISOString().slice(0, 10), end = Math.min(until, Date.parse(day) + 86_400_000);
              const bucket = bucketOf(day, granularity);
              add(bucket, start, end);
              if (by !== "none") add(`${bucket}|${by === "vendor" ? "claude" : by === "model" ? `claude/${fact.model ?? "?"}` : account}`, start, end);
              start = end;
            }
          }
          for (const [key, ms] of oracle) {
            const [day, account, group] = key.split(" ");
            const [subject, model] = JSON.parse(group!) as [string | null, string | null];
            if (subject !== "p:alpha") continue;
            const bucket = bucketOf(day!, granularity);
            buckets.set(bucket, (buckets.get(bucket) ?? 0) + ms / 1000);
            if (by === "none") continue;
            const split = by === "vendor" ? "claude" : by === "model" ? `claude/${model ?? "?"}` : account!;
            splits.set(`${bucket}|${split}`, (splits.get(`${bucket}|${split}`) ?? 0) + ms / 1000);
          }
          for (const point of history.points) {
            const unionSeconds = (key: string) => oracleIntervalUnion(intervals.get(key) ?? []).reduce((sum, [a, b]) => sum + (b - a) / 1000, 0);
            expect(Math.abs(point.session_seconds - (buckets.get(point.bucket) ?? 0))).toBeLessThan(1e-6);
            expect(Math.abs(point.active_seconds - unionSeconds(point.bucket))).toBeLessThan(1e-6);
            for (const [key, value] of Object.entries(point.split ?? {}))
              expect(Math.abs(value.active_seconds - unionSeconds(`${point.bucket}|${key}`))).toBeLessThan(1e-6);
            compared++;
          }
          expect([...buckets.keys()].filter(bucket => !history.points.some(point => point.bucket === bucket))).toEqual([]);
        }
      }
    expect(compared).toBeGreaterThan(200);
  } finally { teardown(); }
}, 120_000);
