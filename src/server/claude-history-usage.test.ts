import { prepareClaudeReaderFixture } from "./subscription-reader.fixture";
/**
 * Acceptance for the Claude side of the repository/project history and the subject selector.
 *
 * The fixture is synthetic and self-contained: its own temporary database, its own rate card
 * and its own events. No production database, archive or usage log is read, and every expected
 * number below is computed by hand in the comment next to it.
 *
 * Timeline (UTC), idle cap 15 minutes = 900 s. Account A and account B share one store, so a
 * store can never stand in for an account. Prices per 1M: 3 fresh in, 0.3 cache read, 15 out;
 * Fast is exactly three times Standard.
 *
 *   09-13 23:52  a0   A s1  p:alpha  1k fresh                 (before the selected range)
 *   09-14 00:00  a1   A s1  p:alpha  100k fresh + 20k out     0.6   gap 480 s from a0
 *   09-14 00:00  a1   A s1  duplicate copy, other metadata    one call, priced once
 *   09-14 00:10  a2   A s1  p:alpha  empty call               0.0   gap 600 s
 *   09-14 01:00  a3   A s1  r:beta   40k cache read + 10k out 0.162 gap 3000 s -> capped 900
 *   09-14 23:50  a4   A s2  p:alpha  10k fresh                0.03  new session -> 0
 *   09-15 00:00  a5   A s2  p:alpha  100k fresh + 20k out Fast 1.8   gap 600 s across midnight
 *   09-15 00:05  b1   B s2  p:alpha  200k fresh + 40k out     1.2   same session id, other
 *   09-15 00:20  b2   B s2  p:alpha  empty call               0.0   account -> gap 900 s
 *   09-15 01:00  a6   A --  p:alpha  20k fresh                0.06  no session -> 0
 *   09-15 01:05  a7   A --  p:alpha  20k fresh                0.06  no session -> 0
 *   09-15 05:00  x1   ?     p:alpha  30k fresh                evidence, never an account
 *   09-15 06:00  x2   ?     p:alpha  5k fresh + 1k out        conflicting owner -> evidence
 *   09-16 01:00  a8   A s3  p:alpha  7k fresh, model m-gone   no rate  -> new session -> 0
 *   09-16 01:30  a9   A s3  p:alpha  5k fresh, mode unknown   0.015 at Standard -> gap 1800 -> 900
 *   09-16 23:30  a10  A s4  p:alpha  1k fresh, stored +02:00  0.003 (stored date is 09-17)
 */
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { buildProjectCost } from "./project-cost";
import {
  buildRepoHistory,
  buildRepoHistoryCancellable,
  HistoryAbortedError,
  listSubjects,
  type RepoHistory,
  type RepoHistoryOpts,
} from "./repo-history";
import type { RateCard } from "./pricing";

const ACCOUNTS = { a: "acct-a", b: "acct-b" } as const;
const RANGE = { since: "2026-09-14", until: "2026-09-16" } as const;
const CAP = 900;

const RATES: RateCard = {
  version: 1, currency: "USD", unit: "per 1M",
  vendors: {
    anthropic: {
      source: "independent-synthetic-fixture",
      models: {
        "m-std": {
          in_uncached: 3, in_cache_read: 0.3, in_cache_write_5m: 3.75, in_cache_write_1h: 6, out_total: 15,
          fast: { in_uncached: 9, in_cache_read: 0.9, in_cache_write_5m: 11.25, in_cache_write_1h: 18, out_total: 45 },
        },
      },
    },
  },
  // Only account A has a declared price. Account B must never inherit it.
  subscriptions: { "acct-a": { plan: "max", usd_per_month: 200 } },
};

interface EventSpec {
  id: number;
  call_id: string;
  ts: string;
  session?: string | null;
  account?: string | null;
  conflict?: number;
  project?: string | null;
  repo?: string | null;
  group?: string | null;
  model?: string;
  speed?: string;
  in_uncached?: number;
  in_cache_read?: number;
  out_total?: number;
  store?: string;
}

const ALPHA = { project: "alpha", repo: "repo-a", group: "grp-1" } as const;
const EVENTS: EventSpec[] = [
  { id: 1, call_id: "a0", ts: "2026-09-13T23:52:00.000Z", session: "s1", ...ALPHA, in_uncached: 1_000 },
  { id: 2, call_id: "a1", ts: "2026-09-14T00:00:00.000Z", session: "s1", ...ALPHA, in_uncached: 100_000, out_total: 20_000 },
  // The same call, read again from another store, with different project and session evidence.
  // Its source key ("20") is not the lexically least one, so the canonical copy above wins.
  { id: 20, call_id: "a1", ts: "2026-09-14T00:00:00.000Z", session: "s9", project: "delta", repo: "repo-z",
    group: "grp-9", store: "mirror", in_uncached: 100_000, out_total: 20_000 },
  { id: 3, call_id: "a2", ts: "2026-09-14T00:10:00.000Z", session: "s1", ...ALPHA },
  { id: 4, call_id: "a3", ts: "2026-09-14T01:00:00.000Z", session: "s1", repo: "beta", group: "grp-2",
    in_cache_read: 40_000, out_total: 10_000 },
  { id: 5, call_id: "a4", ts: "2026-09-14T23:50:00.000Z", session: "s2", ...ALPHA, in_uncached: 10_000 },
  { id: 6, call_id: "a5", ts: "2026-09-15T00:00:00.000Z", session: "s2", ...ALPHA, speed: "fast",
    in_uncached: 100_000, out_total: 20_000 },
  { id: 7, call_id: "b1", ts: "2026-09-15T00:05:00.000Z", session: "s2", account: ACCOUNTS.b, ...ALPHA,
    in_uncached: 200_000, out_total: 40_000 },
  { id: 8, call_id: "b2", ts: "2026-09-15T00:20:00.000Z", session: "s2", account: ACCOUNTS.b, ...ALPHA },
  { id: 9, call_id: "a6", ts: "2026-09-15T01:00:00.000Z", session: null, ...ALPHA, in_uncached: 20_000 },
  { id: 10, call_id: "a7", ts: "2026-09-15T01:05:00.000Z", session: null, ...ALPHA, in_uncached: 20_000 },
  { id: 11, call_id: "x1", ts: "2026-09-15T05:00:00.000Z", session: "s5", account: null, ...ALPHA, in_uncached: 30_000 },
  { id: 12, call_id: "x2", ts: "2026-09-15T06:00:00.000Z", session: "s6", conflict: 1, ...ALPHA,
    in_uncached: 5_000, out_total: 1_000 },
  { id: 13, call_id: "a8", ts: "2026-09-16T01:00:00.000Z", session: "s3", ...ALPHA, model: "m-gone", in_uncached: 7_000 },
  { id: 14, call_id: "a9", ts: "2026-09-16T01:30:00.000Z", session: "s3", ...ALPHA, speed: "", in_uncached: 5_000 },
  { id: 15, call_id: "a10", ts: "2026-09-17T01:30:00+02:00", session: "s4", ...ALPHA, in_uncached: 1_000 },
];

const SCHEMA = `
  CREATE TABLE claude_events(id INTEGER PRIMARY KEY, store TEXT, call_id TEXT, session_id TEXT, ts TEXT,
    model TEXT, speed TEXT, entrypoint TEXT, cc_version TEXT, project_id TEXT, repo TEXT, repo_group TEXT,
    subscription_id TEXT, subscription_conflict INTEGER DEFAULT 0, in_uncached INTEGER DEFAULT 0,
    in_cache_read INTEGER DEFAULT 0, in_cache_write INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0,
    cache_write_1h INTEGER DEFAULT 0, out_total INTEGER DEFAULT 0, out_thinking INTEGER DEFAULT 0);
  CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, subject TEXT, ts TEXT, kind TEXT, scope TEXT,
    used_percent REAL, resets_at TEXT, extra TEXT);
  CREATE TABLE analysis_source_revisions(source TEXT, bucket TEXT, revision INTEGER, PRIMARY KEY(source,bucket));`;

const BASE: Omit<RepoHistoryOpts, "projectId"> = {
  repo: null, granularity: "day", by: "none", idleGapMinutes: 15, rateCards: RATES, homeToSubId: new Map(),
};

function createFixture(options: { events?: EventSpec[]; prepare?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claude-history-usage-"));
  const dbPath = join(directory, "atlas.db");
  let db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  installAnalysisTracking(db);
  const insert = db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,
      project_id,repo,repo_group,subscription_id,subscription_conflict,in_uncached,in_cache_read,out_total)
    VALUES(?,?,?,?,?,?,?,'cli','2.0.0',?,?,?,?,?,?,?,?)`);
  for (const event of options.events ?? EVENTS) {
    insert.run(event.id, event.store ?? "primary", event.call_id, event.session === undefined ? "s0" : event.session,
      event.ts, event.model ?? "m-std", event.speed ?? "standard",
      event.project ?? null, event.repo ?? null, event.group ?? null,
      event.account === undefined ? ACCOUNTS.a : event.account, event.conflict ?? 0,
      event.in_uncached ?? 0, event.in_cache_read ?? 0, event.out_total ?? 0);
  }
  insert.finalize();
  const fixture = {
    directory, get db() { return db; },
    /** Background preparation, always outside the report's own read. */
    prepareFacts() {
      prepareClaudeReaderFixture(db, RATES);
    },
    reopen() { db.close(true); db = new Database(dbPath); db.exec("PRAGMA journal_mode=WAL"); return db; },
    /** The ledger's stored valuations per source row; repricing would change them. */
    valuations() {
      return new Map((db.query(`SELECT row_id,std_key,std_reason,std_nano,std_femto,act_key,act_reason,act_nano,act_femto,
        glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all() as
        Array<Record<string, unknown>>).map(row => [row.row_id, JSON.stringify(row)]));
    },
    history(overrides: Partial<RepoHistoryOpts> = {}): RepoHistory {
      return buildRepoHistory(db, { ...BASE, ...RANGE, projectId: "alpha", ...overrides } as RepoHistoryOpts);
    },
    subjects(range: { since?: string; until?: string } = RANGE) {
      return listSubjects(db, 15, range, { rateCards: RATES });
    },
    teardown() { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
  if (options.prepare !== false) fixture.prepareFacts();
  return fixture;
}

const point = (history: RepoHistory, bucket: string) => history.points.find(row => row.bucket === bucket);

test("tokens, calls and money come from the canonical facts, per verified account", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    // 09-14: a1 120k + a2 empty + a4 10k = 130k in three calls, 0.6 + 0 + 0.03 dollars.
    expect(point(history, "2026-09-14")).toMatchObject({ tokens: 130_000, calls: 3, api_usd: 0.63, api_complete: true });
    // 09-15: A 120k + 20k + 20k, B 240k; 1.8 + 0.06 + 0.06 on A and 1.2 on B.
    expect(point(history, "2026-09-15")).toMatchObject({ tokens: 400_000, calls: 5, api_usd: 3.12 });
    // 09-16: 7k unpriced model, 5k unknown mode at Standard 0.015, 1k priced at 0.003 -> a subtotal, not a zero.
    expect(point(history, "2026-09-16")).toMatchObject({ tokens: 13_000, calls: 3, api_usd: 0.02, api_complete: false });
    // 2.568 on A and 1.2 on B, rounded once from the unrounded account sums.
    expect(history.totals).toMatchObject({ tokens: 543_000, calls: 11, api_usd: 3.77, api_complete: false });
    expect(history.totals.by_sub[ACCOUNTS.a]?.api_usd).toBe(2.57);
    expect(history.totals.by_sub[ACCOUNTS.b]?.api_usd).toBe(1.2);
    // The store the copies were read from is never an account, and neither is a literal vendor.
    expect(Object.keys(history.totals.by_sub).sort()).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
  } finally { fixture.teardown(); }
});

test("a duplicate copy with different metadata is one call under the canonical subject", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    // The mirror copy claims p:delta, session s9 and repo-z; none of it may appear.
    expect(point(history, "2026-09-14")?.calls).toBe(3);
    expect(fixture.history({ projectId: "delta" }).totals).toMatchObject({ tokens: 0, calls: 0, api_usd: 0 });
    // A duplicate copy adds no activity either: 480 s from a0 plus 600 s from a1 to a2.
    expect(point(history, "2026-09-14")?.active_seconds).toBe(1080);
  } finally { fixture.teardown(); }
});

test("activity is bridged only inside one account and one session, and only up to the cap", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    // 09-14: 480 s across the selected range start plus 600 s between a1 and a2.
    expect(point(history, "2026-09-14")?.active_seconds).toBe(1080);
    // 09-15: 600 s across midnight on A, 900 s (exactly the cap) between b1 and b2 on B.
    // The two sessions share an id and must not bridge into each other.
    expect(point(history, "2026-09-15")?.active_seconds).toBe(1500);
    // 09-16: a9 follows a8 by 1800 s in one session, capped at 900; a10 opens a session.
    expect(point(history, "2026-09-16")?.active_seconds).toBe(900);
    expect(history.totals.active_seconds).toBe(1080 + 1500 + 900);
    // r:beta gets the capped 3000 s gap that ends on its own call, not on p:alpha's.
    const beta = fixture.history({ projectId: null, repo: "beta" });
    expect(beta.totals).toMatchObject({ tokens: 50_000, calls: 1, active_seconds: CAP });
    // Cutting the range at the second day removes the bridge that starts before it.
    const later = fixture.history({ since: "2026-09-15" });
    expect(point(later, "2026-09-15")?.active_seconds).toBe(1500);
    expect(later.totals.active_seconds).toBe(1500 + 900);
  } finally { fixture.teardown(); }
});

test("active time is split by the computer of its source and the parts add up to the bucket", () => {
  const fixture = createFixture();
  try {
    const seen = new Set<string | null>();
    const history = fixture.history({ machineOf: (source) => { seen.add(source); return source ? `pc:${source}` : null; } });
    const sum = (parts: Record<string, number>) => Object.values(parts).reduce((a, b) => a + b, 0);
    expect(seen.size).toBeGreaterThan(0);
    for (const p of history.points) {
      expect(sum(p.active_by_machine)).toBeCloseTo(p.active_seconds, 9);
      for (const key of Object.keys(p.active_by_machine)) expect(key === "?" || key.startsWith("pc:")).toBe(true);
    }
    expect(sum(history.totals.active_by_machine)).toBeCloseTo(history.totals.active_seconds, 9);
    // One computer for every source: the whole range on it.
    const single = fixture.history({ machineOf: () => "DESK" });
    expect(single.totals.active_by_machine).toEqual({ DESK: single.totals.active_seconds });
  } finally { fixture.teardown(); }
});

test("calls without a session neither receive nor bridge activity", () => {
  // a6 and a7 are five minutes apart with no session id at all.
  const fixture = createFixture({ events: [
    { id: 1, call_id: "n1", ts: "2026-09-15T01:00:00.000Z", session: null, ...ALPHA, in_uncached: 20_000 },
    { id: 2, call_id: "n2", ts: "2026-09-15T01:05:00.000Z", session: null, ...ALPHA, in_uncached: 20_000 },
  ] });
  try {
    const history = fixture.history();
    expect(history.totals).toMatchObject({ tokens: 40_000, calls: 2, active_seconds: 0 });
  } finally { fixture.teardown(); }
});

test("a preserved timestamp offset is counted on its canonical UTC day", () => {
  const fixture = createFixture();
  try {
    // a10 is stored as 09-17 local and belongs to 09-16 in UTC.
    expect(point(fixture.history(), "2026-09-16")?.tokens).toBe(13_000);
    expect(fixture.history({ since: "2026-09-17", until: "2026-09-17" }).points).toEqual([]);
    const lastDay = fixture.history({ since: "2026-09-16", until: "2026-09-16" });
    expect(lastDay.totals).toMatchObject({ tokens: 13_000, calls: 3, api_usd: 0.02, api_complete: false });
  } finally { fixture.teardown(); }
});

test("a missing rate stays visible and blocks that account's fee split; an unknown mode is priced at Standard", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    expect(history.claude?.unpriced).toEqual([
      { account: ACCOUNTS.a, model: "m-gone", reason: "missing_rate", tokens: 7_000, calls: 1 },
    ]);
    // The tokens and calls are counted, the dollars are an explicit subtotal.
    expect(point(history, "2026-09-16")).toMatchObject({ tokens: 13_000, calls: 3, api_complete: false });
    // The account cannot account for all of its own traffic, so its fee is not split.
    expect(history.totals.by_sub[ACCOUNTS.a]?.billed_usd).toBeNull();
    expect(history.totals.billed_complete).toBe(false);
    expect(JSON.stringify(history.totals.by_sub[ACCOUNTS.a])).toContain('"billed_usd":null');
    // Account B declares no price at all: absent, never a measured zero.
    expect(history.totals.by_sub[ACCOUNTS.b]?.billed_usd).toBeNull();
    expect(history.notes.some(note => note.includes("missing_rate") && !note.includes("unknown_mode"))).toBe(true);
  } finally { fixture.teardown(); }
});

test("rows without a verified account stay evidence and never join the selected subject", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    // 30k unowned plus 5k+1k conflicting, on days the subject also uses.
    expect(history.claude?.evidence).toEqual([{ reason: "unverified_account", tokens: 36_000, calls: 2 }]);
    expect(history.claude?.accounts).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
    // Their tokens are in no bucket, no account total and no subject total.
    expect(point(history, "2026-09-15")?.tokens).toBe(400_000);
    expect(history.totals.tokens).toBe(543_000);
    expect(Object.keys(history.totals.by_sub)).not.toContain("claude");
    expect(history.notes.some(note => note.includes("unverified_account"))).toBe(true);
  } finally { fixture.teardown(); }
});

test("the account and model split names the verified subscription, not the store", () => {
  const fixture = createFixture();
  try {
    const byAccount = fixture.history({ by: "account" });
    expect(point(byAccount, "2026-09-15")?.split).toEqual({
      [ACCOUNTS.a]: { tokens: 160_000, calls: 3, active_seconds: 600 },
      [ACCOUNTS.b]: { tokens: 240_000, calls: 2, active_seconds: 900 },
    });
    const byModel = fixture.history({ by: "model" });
    expect(point(byModel, "2026-09-16")?.split).toEqual({
      // Fast and Standard are one model; an unpriced model keeps its own key and its tokens.
      "claude/m-std": { tokens: 6_000, calls: 2, active_seconds: 900 },
      "claude/m-gone": { tokens: 7_000, calls: 1, active_seconds: 0 },
    });
    expect(point(fixture.history({ by: "vendor" }), "2026-09-14")?.split)
      .toEqual({ claude: { tokens: 130_000, calls: 3, active_seconds: 1080 } });
  } finally { fixture.teardown(); }
});

test("week and month buckets agree with the day sums", () => {
  const fixture = createFixture();
  try {
    // 2026-09-14 is a Monday, so the whole selection is one calendar week.
    const week = fixture.history({ granularity: "week" });
    expect(week.points.map(row => row.bucket)).toEqual(["2026-09-14"]);
    expect(week.totals).toMatchObject({ tokens: 543_000, calls: 11, api_usd: 3.77, active_seconds: 3480 });
    const month = fixture.history({ granularity: "month" });
    expect(month.points.map(row => row.bucket)).toEqual(["2026-09"]);
    expect(month.totals.api_usd).toBe(week.totals.api_usd);
    expect(month.totals.active_seconds).toBe(week.totals.active_seconds);
  } finally { fixture.teardown(); }
});

test("a fully priced range allocates the account fee exactly as the project report does", () => {
  const fixture = createFixture();
  try {
    // 09-14 and 09-15 hold no unpriced traffic. A is active on two days, so
    // paid = round2(200 * 2 / 30.44) = 13.14 is split over p:alpha 2.55 and r:beta 0.162:
    //   exact alpha = 13.14 * 2.55 / 2.712 = 12.355088..., exact beta = 0.784911...
    //   largest-remainder cents: 1235 + 78 = 1313 of 1314, the odd cent goes to the larger
    //   remainder (.5088 > .4911) -> alpha 12.36, beta 0.78.
    // Alpha's two days: 12.36 * 0.63 / 2.55 = 3.053647 and 12.36 * 1.92 / 2.55 = 9.306352,
    //   cents 305 + 930 = 1235 of 1236, the odd cent to .6352 -> 3.05 and 9.31.
    const range = { since: "2026-09-14", until: "2026-09-15" };
    const history = fixture.history(range);
    expect(history.totals).toMatchObject({ api_usd: 3.75, api_complete: true });
    expect(history.totals.by_sub[ACCOUNTS.a]).toEqual({ api_usd: 2.55, billed_usd: 12.36 });
    expect(point(history, "2026-09-14")?.by_sub[ACCOUNTS.a]?.billed_usd).toBe(3.05);
    expect(point(history, "2026-09-15")?.by_sub[ACCOUNTS.a]?.billed_usd).toBe(9.31);
    expect(history.totals.billed_usd).toBe(12.36);
    const cost = buildProjectCost(fixture.db, RATES, new Map(), range);
    const alpha = cost.subjects.find(row => row.subject === "p:alpha")!;
    // The same subject, the same account and the same fee share in both reports.
    expect(alpha.subscriptions[ACCOUNTS.a]?.api_usd).toBe(history.totals.by_sub[ACCOUNTS.a]?.api_usd);
    expect(alpha.subscriptions[ACCOUNTS.a]?.billed_usd).toBe(history.totals.by_sub[ACCOUNTS.a]?.billed_usd);
    const beta = fixture.history({ ...range, projectId: null, repo: "beta" });
    expect(beta.totals.by_sub[ACCOUNTS.a]?.billed_usd).toBe(0.78);
    expect(cost.subjects.find(row => row.subject === "r:beta")?.subscriptions[ACCOUNTS.a]?.billed_usd).toBe(0.78);
  } finally { fixture.teardown(); }
});

test("the selector and the history report the same prepared numbers", () => {
  const fixture = createFixture();
  try {
    const subjects = fixture.subjects();
    const alpha = subjects.find(row => row.id === "alpha")!;
    expect(alpha).toMatchObject({ kind: "project", group: "grp-1", tokens: 543_000, calls: 11, active_seconds: 3480 });
    expect(alpha.repos).toEqual(["repo-a"]);
    const history = fixture.history();
    expect([alpha.tokens, alpha.calls, alpha.active_seconds])
      .toEqual([history.totals.tokens, history.totals.calls, history.totals.active_seconds]);
    const beta = subjects.find(row => row.id === "beta")!;
    expect(beta).toMatchObject({ kind: "repo", group: "grp-2", tokens: 50_000, calls: 1, active_seconds: CAP });
    // The mirror copy's project and the rows without a verified account are not subjects.
    expect(subjects.map(row => row.id).sort()).toEqual(["alpha", "beta"]);
  } finally { fixture.teardown(); }
});

test("an unprepared fact index asks for background preparation; a published one answers until it catches up", () => {
  const fixture = createFixture({ prepare: false });
  try {
    expect(() => fixture.history()).toThrow(SubscriptionFactsPending);
    expect(() => fixture.subjects()).toThrow(SubscriptionFactsPending);
    fixture.prepareFacts();
    expect(fixture.history().totals.calls).toBe(11);
    fixture.db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,
        project_id,repo,repo_group,subscription_id,in_uncached)
      VALUES(99,'primary','a-late','s1','2026-09-14T00:20:00.000Z','m-std','standard','cli','2.0.0','alpha','repo-a','grp-1',?,1000)`)
      .run(ACCOUNTS.a);
    // The published index answers as it stands until the producer reaches the late call (golden rules §9).
    expect(point(fixture.history(), "2026-09-14")?.calls).toBe(3);
    fixture.prepareFacts();
    // 600 s more activity: the late call follows a2 by ten minutes inside session s1.
    expect(point(fixture.history(), "2026-09-14")).toMatchObject({ calls: 4, active_seconds: 1680 });
  } finally { fixture.teardown(); }
});

test("a restart and a share-only update change neither the history nor the registered valuations", () => {
  const fixture = createFixture();
  try {
    const first = fixture.history();
    const valuations = fixture.valuations();
    // Only the product share of a percentage reading changes; no usage is touched.
    fixture.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,extra) VALUES('claude',?,?,'weekly_all',24,'{\"claude.share.percent\":15}')")
      .run(ACCOUNTS.a, "2026-09-16T12:00:00.000Z");
    fixture.reopen();
    expect(fixture.history()).toEqual(first);
    expect(fixture.valuations()).toEqual(valuations);
  } finally { fixture.teardown(); }
});

test("a correction moves activity and subjects and preserves the registered valuations", () => {
  const fixture = createFixture();
  try {
    fixture.history();
    const valuations = fixture.valuations();
    expect(valuations.size).toBeGreaterThan(0);

    // 1. A session-only correction: the same tokens, the same prices, different bridging.
    fixture.db.exec("UPDATE claude_events SET session_id='s1b' WHERE call_id='a3'");
    fixture.prepareFacts();
    const corrected = fixture.history({ projectId: null, repo: "beta" });
    // a3 now opens its own session, so the capped 900 s gap it used to receive is gone.
    expect(corrected.totals).toMatchObject({ tokens: 50_000, calls: 1, active_seconds: 0 });
    // Moving a call between sessions must not discard or redo its valuation.
    expect(fixture.valuations()).toEqual(valuations);

    // 2. A subject correction moves the tokens without repricing them.
    fixture.db.exec("UPDATE claude_events SET project_id='gamma' WHERE call_id='a5'");
    fixture.prepareFacts();
    expect(fixture.history({ projectId: "gamma" }).totals).toMatchObject({ tokens: 120_000, calls: 1, api_usd: 1.8 });
    expect(fixture.valuations()).toEqual(valuations);
  } finally { fixture.teardown(); }
});

test("a corrected previous day corrects the next day's boundary contribution", () => {
  const fixture = createFixture();
  try {
    expect(point(fixture.history(), "2026-09-15")?.active_seconds).toBe(1500);
    // a4 moves five minutes later, so the midnight gap to a5 shrinks from 600 s to 300 s.
    fixture.db.exec("UPDATE claude_events SET ts='2026-09-14T23:55:00.000Z' WHERE call_id='a4'");
    fixture.prepareFacts();
    expect(point(fixture.history(), "2026-09-15")?.active_seconds).toBe(1200);
  } finally { fixture.teardown(); }
});

test("vendor coverage and the cancellation checkpoints keep working", async () => {
  const fixture = createFixture();
  try {
    const opts = { ...BASE, ...RANGE, projectId: "alpha" } as RepoHistoryOpts;
    const claudeCoverage = fixture.history().vendor_coverage.find(row => row.vendor === "claude");
    // Canonical UTC days of the rows the source still holds: a10 is stored on 09-17 (+02:00)
    // and observed on 09-16, and a0 on 09-13 is coverage even though it is before the range.
    expect(claudeCoverage).toEqual({ vendor: "claude", first: "2026-09-13", last: "2026-09-16" });

    const phases: string[] = [];
    expect(await buildRepoHistoryCancellable(fixture.db, opts, { onCheckpoint: phase => phases.push(phase) }))
      .toEqual(buildRepoHistory(fixture.db, opts));
    expect(phases[0]).toBe("sources:claude");
    expect(phases).toContain("dollars:claude");

    const aborted = new AbortController();
    const stopped: string[] = [];
    await expect(buildRepoHistoryCancellable(fixture.db, opts, {
      signal: aborted.signal,
      onCheckpoint(phase) { stopped.push(phase); if (phase === "sources:claude") aborted.abort(); },
    })).rejects.toBeInstanceOf(HistoryAbortedError);
    expect(stopped).toEqual(["sources:claude"]);
  } finally { fixture.teardown(); }
});

test("an empty table stays harmless and reports no Claude coverage", () => {
  const fixture = createFixture({ events: [] });
  try {
    const history = fixture.history();
    expect(history.points).toEqual([]);
    expect(history.totals).toMatchObject({ tokens: 0, calls: 0, api_usd: 0, api_complete: true });
    expect(history.claude).toBeUndefined();
    expect(history.vendor_coverage.find(row => row.vendor === "claude"))
      .toEqual({ vendor: "claude", first: null, last: null });
    expect(fixture.subjects()).toEqual([]);
  } finally { fixture.teardown(); }
});

test("a session silent for two weeks is still bridged, a never-seen session is not", () => {
  // Unrelated sessions keep the account busy on the three days before the selection; they
  // must not become the resumed session's predecessor, and must not hide it either.
  const fixture = createFixture({ events: [
    { id: 1, call_id: "old", ts: "2026-09-01T10:00:00.000Z", session: "long", ...ALPHA, in_uncached: 1_000 },
    { id: 2, call_id: "n12", ts: "2026-09-12T10:00:00.000Z", session: "other-12", ...ALPHA, in_uncached: 1_000 },
    { id: 3, call_id: "n13", ts: "2026-09-13T10:00:00.000Z", session: "other-13", ...ALPHA, in_uncached: 1_000 },
    { id: 4, call_id: "n14", ts: "2026-09-14T10:00:00.000Z", session: "other-14", ...ALPHA, in_uncached: 1_000 },
    { id: 5, call_id: "resumed", ts: "2026-09-15T10:00:00.000Z", session: "long", ...ALPHA, in_uncached: 1_000 },
    { id: 6, call_id: "fresh", ts: "2026-09-15T11:00:00.000Z", session: "never-seen", ...ALPHA, in_uncached: 1_000 },
  ] });
  try {
    const history = fixture.history({ since: "2026-09-15", until: "2026-09-16" });
    // The cap bounds the contribution; it does not end the session. The unseen session gets none.
    expect(point(history, "2026-09-15")?.active_seconds).toBe(CAP);
    expect(history.totals.calls).toBe(2);
    // Starting one day earlier changes nothing for the resumed call and still bridges nothing
    // for the unrelated session that opened on 09-14.
    const wider = fixture.history({ since: "2026-09-14", until: "2026-09-16" });
    expect(point(wider, "2026-09-14")?.active_seconds).toBe(0);
    expect(point(wider, "2026-09-15")?.active_seconds).toBe(CAP);
  } finally { fixture.teardown(); }
});

test("simultaneous calls keep their order when a smaller source key arrives later", () => {
  // c-a and c-b are two different calls at the same instant, five seconds after c-0.
  // Ordered by canonical identity, c-a is first and takes the gap; the physical source keys
  // (200 before 100, then a copy keyed 10) must not move those five seconds to c-b.
  const tie = "2026-09-15T10:00:05.000Z";
  const fixture = createFixture({ events: [
    { id: 1, call_id: "c-0", ts: "2026-09-15T10:00:00.000Z", session: "tie", project: "base",
      repo: "repo-base", group: "g", in_uncached: 1_000 },
    { id: 200, call_id: "c-a", ts: tie, session: "tie", ...ALPHA, in_uncached: 2_000 },
    { id: 100, call_id: "c-b", ts: tie, session: "tie", project: "bravo", repo: "repo-b",
      group: "g", in_uncached: 3_000 },
  ] });
  try {
    const alpha = () => fixture.history({ projectId: "alpha" });
    const bravo = () => fixture.history({ projectId: "bravo" });
    expect(alpha().totals).toMatchObject({ tokens: 2_000, calls: 1, active_seconds: 5 });
    expect(bravo().totals).toMatchObject({ tokens: 3_000, calls: 1, active_seconds: 0 });
    // The mirror copy of c-a arrives with the lexically smallest source key.
    fixture.db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,
        project_id,repo,repo_group,subscription_id,in_uncached)
      VALUES(10,'mirror','c-a','tie',?,'m-std','standard','cli','2.0.0','alpha','repo-a','grp-1',?,2000)`)
      .run(tie, ACCOUNTS.a);
    fixture.prepareFacts();
    expect(alpha().totals).toMatchObject({ tokens: 2_000, calls: 1, active_seconds: 5 });
    expect(bravo().totals).toMatchObject({ tokens: 3_000, calls: 1, active_seconds: 0 });
  } finally { fixture.teardown(); }
});

test("coverage is the canonical UTC evidence the source still holds", () => {
  const fixture = createFixture({ events: [
    { id: 1, call_id: "gone-early", ts: "2026-09-12T10:00:00.000Z", session: "e", ...ALPHA, in_uncached: 1_000 },
    { id: 2, call_id: "keep-a", ts: "2026-09-14T10:00:00.000Z", session: "k", ...ALPHA, in_uncached: 1_000 },
    { id: 3, call_id: "keep-b", ts: "2026-09-16T10:00:00.000Z", session: "k", ...ALPHA, in_uncached: 1_000 },
    { id: 4, call_id: "gone-late", ts: "2026-09-20T10:00:00.000Z", session: "l", ...ALPHA, in_uncached: 1_000 },
  ] });
  try {
    const coverage = (granularity: "day" | "week" | "month" = "day") =>
      fixture.history({ granularity }).vendor_coverage.find(row => row.vendor === "claude");
    expect(coverage()).toEqual({ vendor: "claude", first: "2026-09-12", last: "2026-09-20" });
    fixture.db.exec("DELETE FROM claude_events WHERE call_id IN ('gone-early','gone-late')");
    fixture.prepareFacts();
    // Deleted rows stop counting as coverage.
    expect(coverage()).toEqual({ vendor: "claude", first: "2026-09-14", last: "2026-09-16" });
    // 2026-09-14 is a Monday, so both remaining days map into its week.
    expect(coverage("week")).toEqual({ vendor: "claude", first: "2026-09-14", last: "2026-09-14" });
    expect(coverage("month")).toEqual({ vendor: "claude", first: "2026-09", last: "2026-09" });
  } finally { fixture.teardown(); }
});

test("sub-second gaps are summed, not rounded away per model", () => {
  const fixture = createFixture({ events: [
    { id: 1, call_id: "f1", ts: "2026-09-15T10:00:00.000Z", session: "frac", model: "m-a", ...ALPHA },
    { id: 2, call_id: "f2", ts: "2026-09-15T10:00:00.333Z", session: "frac", model: "m-b", ...ALPHA },
    { id: 3, call_id: "f3", ts: "2026-09-15T10:00:00.999Z", session: "frac", model: "m-c", ...ALPHA },
    { id: 4, call_id: "f4", ts: "2026-09-15T10:00:01.998Z", session: "frac", model: "m-d", ...ALPHA },
  ] });
  try {
    // 0.333 + 0.666 + 0.999 of real work, in four different models on one day.
    const history = fixture.history();
    expect(history.totals.active_seconds).toBeCloseTo(1.998, 9);
    expect(point(history, "2026-09-15")?.active_seconds).toBeCloseTo(1.998, 9);
    const split = point(fixture.history({ by: "model" }), "2026-09-15")!.split!;
    expect(Object.keys(split).sort()).toEqual(["claude/m-a", "claude/m-b", "claude/m-c", "claude/m-d"]);
    expect(Object.values(split).reduce((sum, row) => sum + row.active_seconds, 0)).toBeCloseTo(1.998, 9);
    expect(split["claude/m-b"]?.active_seconds).toBeCloseTo(0.333, 9);
    // The selector must not disagree with the history it links to.
    expect(fixture.subjects().find(row => row.id === "alpha")?.active_seconds).toBeCloseTo(1.998, 9);
  } finally { fixture.teardown(); }
});

test("a bucket amount is rounded once from the original amounts, not from account cents", () => {
  // 1800 fresh tokens at 3 per 1M = 0.0054 USD in each of two accounts: 0.0108 together.
  const fixture = createFixture({ events: [
    { id: 1, call_id: "h-a", ts: "2026-09-15T10:00:00.000Z", session: "a", ...ALPHA, in_uncached: 1_800 },
    { id: 2, call_id: "h-b", ts: "2026-09-15T11:00:00.000Z", session: "b", account: ACCOUNTS.b, ...ALPHA,
      in_uncached: 1_800 },
  ] });
  try {
    const history = fixture.history();
    expect(point(history, "2026-09-15")?.api_usd).toBe(0.01);
    expect(history.totals.api_usd).toBe(0.01);
    // The per-account detail keeps its own cent allocation, which is what a reader can bill.
    expect(history.totals.by_sub[ACCOUNTS.a]?.api_usd).toBe(0.01);
    expect(history.totals.by_sub[ACCOUNTS.b]?.api_usd).toBe(0.01);
  } finally { fixture.teardown(); }
});

test("a verified account with canonical calls stays visible even when its subtotal is zero", () => {
  const unpriced = createFixture({ events: [
    { id: 1, call_id: "u1", ts: "2026-09-15T10:00:00.000Z", session: "u", ...ALPHA, model: "m-gone", in_uncached: 4_000 },
    { id: 2, call_id: "u2", ts: "2026-09-15T10:05:00.000Z", session: "u", ...ALPHA, model: "m-gone" },
  ] });
  try {
    const history = unpriced.history();
    // Nothing here has a price, so the money is missing - not a complete zero.
    expect(history.totals).toMatchObject({ tokens: 4_000, calls: 2, api_usd: 0, api_complete: false,
      active_seconds: 300, billed_complete: false });
    expect(history.totals.by_sub[ACCOUNTS.a]).toEqual({ api_usd: 0, billed_usd: null });
    const bucket = point(history, "2026-09-15")!;
    expect(bucket).toMatchObject({ tokens: 4_000, calls: 2, api_usd: 0, api_complete: false, billed_complete: false });
    expect(bucket.by_sub[ACCOUNTS.a]).toEqual({ api_usd: 0, billed_usd: null });
  } finally { unpriced.teardown(); }
  // A priced but empty call is a different case: the price is known and the share is zero.
  const empty = createFixture({ events: [
    { id: 1, call_id: "z1", ts: "2026-09-15T10:00:00.000Z", session: "z", ...ALPHA },
  ] });
  try {
    const history = empty.history();
    expect(history.totals).toMatchObject({ tokens: 0, calls: 1, api_usd: 0, api_complete: true });
    expect(history.totals.by_sub[ACCOUNTS.a]).toEqual({ api_usd: 0, billed_usd: 0 });
  } finally { empty.teardown(); }
});
