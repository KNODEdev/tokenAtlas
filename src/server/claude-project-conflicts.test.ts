import { prepareClaudeReaderFixture } from "./subscription-reader.fixture";
/**
 * Acceptance for visible conflicting-copy exclusions (plan M12).
 *
 * A canonical call whose live copies contradict each other is accepted by nobody: the shared
 * fact reader drops it from every sum, so before this feature it vanished without a trace.
 * These tests pin what is published instead - distinct identities per ACCOUNT and per selected
 * range - and prove that the excluded traffic is never given tokens, a price, a project or a
 * zero, that the fee of an affected account is no longer spread over its remaining traffic,
 * and that an unaffected account keeps its correct allocation.
 *
 * The fixture is synthetic and self-contained: its own temporary database, its own rate card
 * and its own events. No production database, archive or usage log is read, and every expected
 * number below is computed by hand in the comment next to it.
 *
 * Timeline (UTC). Prices per 1M: 3 fresh in, 0.3 cache read, 15 out.
 *
 *   09-14 01:00  a-ok1     A  p:alpha  100k in + 20k out   0.6    accepted
 *   09-14 02:00  a-split   A  p:alpha  50k in              CONFLICT with the 09-15 copy
 *   09-14 03:00  a-mirror  A  p:alpha  10k in              0.03   accepted (two equal copies)
 *   09-15 01:00  b-ok      B  p:alpha  200k in + 40k out   1.2    accepted
 *   09-15 02:00  a-split   A  p:gamma  70k in              other copy: other day, other project
 *   09-15 04:00  a-outside A  p:alpha  20k in              CONFLICT with the 09-20 copy
 *   09-16 05:00  a-zero    A  p:alpha  empty call          CONFLICT with the 09-16 06:00 copy
 *   09-16 06:00  a-zero    A  p:alpha  empty call          other copy, one hour later
 *   09-20 04:00  a-outside A  p:alpha  25k in              other copy, outside the selection
 */
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { storedProjectUsage, type ProjectUsage } from "./stored-project-usage";
import { storedHistoryUsage } from "./stored-history-usage";
import { buildRepoHistory, type RepoHistory, type RepoHistoryOpts } from "./repo-history";
import { buildProjectCost } from "./project-cost";
import type { RateCard } from "./pricing";

const ACCOUNTS = { a: "acct-a", b: "acct-b" } as const;
const RANGE = { since: "2026-09-14", until: "2026-09-16" } as const;

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
  // Both accounts declare a fee: only then can a blocked split be told from a missing price.
  subscriptions: { "acct-a": { plan: "max", usd_per_month: 200 }, "acct-b": { plan: "pro", usd_per_month: 100 } },
};

interface EventSpec {
  id: number;
  call_id: string;
  ts: string;
  account?: string | null;
  project?: string | null;
  session?: string | null;
  model?: string;
  speed?: string;
  in_uncached?: number;
  out_total?: number;
  store?: string;
  /** The second, contradicting copy of a call: removing it makes the call canonical again. */
  contradicting?: boolean;
}

const EVENTS: EventSpec[] = [
  { id: 1, call_id: "a-ok1", ts: "2026-09-14T01:00:00.000Z", project: "alpha", in_uncached: 100_000, out_total: 20_000 },
  { id: 4, call_id: "a-split", ts: "2026-09-14T02:00:00.000Z", project: "alpha", in_uncached: 50_000 },
  { id: 2, call_id: "a-mirror", ts: "2026-09-14T03:00:00.000Z", project: "alpha", in_uncached: 10_000 },
  // Byte-identical second copy: a duplicate, never a conflict.
  { id: 3, call_id: "a-mirror", ts: "2026-09-14T03:00:00.000Z", project: "alpha", in_uncached: 10_000, store: "mirror" },
  { id: 20, call_id: "b-ok", ts: "2026-09-15T01:00:00.000Z", account: ACCOUNTS.b, project: "alpha",
    in_uncached: 200_000, out_total: 40_000, session: "sb" },
  // Another day, another project and other counters: the copies cannot both be true.
  { id: 5, call_id: "a-split", ts: "2026-09-15T02:00:00.000Z", project: "gamma", in_uncached: 70_000,
    store: "mirror", contradicting: true },
  { id: 6, call_id: "a-outside", ts: "2026-09-15T04:00:00.000Z", project: "alpha", in_uncached: 20_000 },
  { id: 8, call_id: "a-zero", ts: "2026-09-16T05:00:00.000Z", project: "alpha" },
  { id: 9, call_id: "a-zero", ts: "2026-09-16T06:00:00.000Z", project: "alpha", store: "mirror", contradicting: true },
  // The contradicting copy of an in-range call, dated outside the selection.
  { id: 7, call_id: "a-outside", ts: "2026-09-20T04:00:00.000Z", project: "alpha", in_uncached: 25_000,
    store: "mirror", contradicting: true },
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

const HISTORY: Omit<RepoHistoryOpts, "projectId"> = {
  repo: null, granularity: "day", by: "none", idleGapMinutes: 15, rateCards: RATES, homeToSubId: new Map(),
};

function createFixture(options: { events?: EventSpec[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claude-conflicts-"));
  const dbPath = join(directory, "atlas.db");
  let db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  installAnalysisTracking(db);
  const insert = db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,
      project_id,subscription_id,in_uncached,out_total) VALUES(?,?,?,?,?,?,?,'cli','2.0.0',?,?,?,?)`);
  for (const event of options.events ?? EVENTS) {
    insert.run(event.id, event.store ?? "primary", event.call_id, event.session === undefined ? "sa" : event.session,
      event.ts, event.model ?? "m-std", event.speed ?? "standard", event.project ?? null,
      event.account === undefined ? ACCOUNTS.a : event.account, event.in_uncached ?? 0, event.out_total ?? 0);
  }
  insert.finalize();
  const fixture = {
    directory, get db() { return db; },
    /** Background preparation, always outside a report's own read. */
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
    usage(range: { since?: string; until?: string } = RANGE): ProjectUsage {
      return storedProjectUsage(db, "claude", RATES, range);
    },
    history(overrides: Partial<RepoHistoryOpts> = {}): RepoHistory {
      return buildRepoHistory(db, { ...HISTORY, ...RANGE, projectId: "alpha", ...overrides } as RepoHistoryOpts);
    },
    report(range: { since?: string; until?: string } = RANGE) {
      return buildProjectCost(db, RATES, new Map(), range);
    },
    teardown() { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
  fixture.prepareFacts();
  return fixture;
}

const group = (usage: ProjectUsage, account: string, subject: string | null) =>
  usage.groups.find(row => row.account === account && row.subject === subject);
const point = (history: RepoHistory, bucket: string) => history.points.find(row => row.bucket === bucket);

test("one conflicted identity is counted once for the whole range, never per day", () => {
  const fixture = createFixture();
  try {
    // a-split (copies on 09-14 and 09-15), a-outside (09-15 and 09-20), a-zero (twice on 09-16).
    expect(fixture.usage().conflicts).toEqual([{ account: ACCOUNTS.a, identities: 3 }]);
    // Per day: a-split on the 14th; a-split and a-outside on the 15th; a-zero on the 16th.
    const perDay = ["2026-09-14", "2026-09-15", "2026-09-16"]
      .map(day => fixture.usage({ since: day, until: day }).conflicts[0]?.identities ?? 0);
    expect(perDay).toEqual([1, 2, 1]);
    // Summing those distinct counts would report four exclusions where there are three.
    expect(perDay.reduce((sum, n) => sum + n, 0)).toBe(4);
    // The account with no contradicting copy publishes nothing at all.
    expect(fixture.usage().conflicts.some(row => row.account === ACCOUNTS.b)).toBe(false);
  } finally { fixture.teardown(); }
});

test("equal copies are duplicates, a copy outside the selection still invalidates its call", () => {
  const fixture = createFixture();
  try {
    // a-mirror has two byte-identical copies: one accepted call, no conflict.
    expect(group(fixture.usage(), ACCOUNTS.a, "p:alpha")?.calls).toBe(2);
    // Two identities touch the 15th: a-outside, whose contradicting copy is dated the 20th,
    // and a-split, whose own copies straddle the 14th and the 15th.
    expect(fixture.usage({ since: "2026-09-15", until: "2026-09-15" }).conflicts)
      .toEqual([{ account: ACCOUNTS.a, identities: 2 }]);
    // a-outside alone, seen from the other side of the calendar: the 09-15 copy is outside
    // this selection now, and it still invalidates the call the 09-20 copy contradicts.
    expect(fixture.usage({ since: "2026-09-18", until: "2026-09-20" }).conflicts)
      .toEqual([{ account: ACCOUNTS.a, identities: 1 }]);
    // A range no copy touches carries no exclusion of its own.
    expect(fixture.usage({ since: "2026-09-17", until: "2026-09-17" }).conflicts).toEqual([]);
  } finally { fixture.teardown(); }
});

test("excluded identities stay out of every token, call, money and coverage sum", () => {
  const fixture = createFixture();
  try {
    const usage = fixture.usage();
    // Only a-ok1 (120k) and a-mirror (10k) survive on account A; 0.6 + 0.03 dollars.
    const alphaA = group(usage, ACCOUNTS.a, "p:alpha")!;
    expect(alphaA.tokens).toBe(130_000);
    expect(alphaA.calls).toBe(2);
    expect(alphaA.api_usd).toBeCloseTo(0.63, 12);
    // Everything here is Standard, so the two bases agree: the exclusion disturbs neither.
    expect(alphaA.standard_usd).toBeCloseTo(0.63, 12);
    // The contradicting copy claimed p:gamma; no project may inherit that traffic.
    expect(group(usage, ACCOUNTS.a, "p:gamma")).toBeUndefined();
    // Not a missing price, not a zero-token call, not source evidence: a different category.
    expect(usage.unpriced).toEqual([]);
    expect(usage.evidence).toEqual([]);

    const report = fixture.report();
    // 130k on A plus 240k on B. None of the excluded 50k/70k/20k/25k tokens appear.
    expect(report.totals.tokens).toBe(370_000);
    expect(report.totals.calls).toBe(3);
    expect(report.coverage.totals.tokens).toBe(0);
    expect(report.coverage.totals.calls).toBe(0);
    expect(report.coverage.conflicting_usage).toMatchObject({
      vendor: "claude", identities: 3, tokens: null, api_usd: null, billed_usd: null,
      accounts: [{ account: ACCOUNTS.a, identities: 3 }],
    });
    // The diagnostic counts excluded identities; they are added to no accepted counter.
    expect(report.coverage.conflicting_usage!.note).toContain("calego konta");
    expect(report.coverage.conflicting_usage!.note).toContain("NIEZNANE");
    expect(report.coverage.unpriced).toMatchObject({ tokens: 0, calls: 0 });
    expect(report.coverage.unverified_account).toBeUndefined();
  } finally { fixture.teardown(); }
});

test("a conflicted account cannot have its fee split, an unaffected account still can", () => {
  const fixture = createFixture();
  try {
    const report = fixture.report();
    const a = report.subscriptions.find(row => row.id === ACCOUNTS.a)!;
    const b = report.subscriptions.find(row => row.id === ACCOUNTS.b)!;
    // The known amounts stay published: A's accepted 0.63 and its declared, prorated fee.
    expect(a.api_usd).toBe(0.63);
    expect(a.usd_per_month).toBe(200);
    expect(a.paid_usd).toBeCloseTo(200 / 30.44, 2);
    expect(a.api_complete).toBe(false);
    // B has no contradicting copy of its own, so nothing about it becomes uncertain.
    expect(b.api_usd).toBe(1.2);
    expect(b.paid_usd).toBeCloseTo(100 / 30.44, 2);
    expect(b.api_complete).toBe(true);

    const alpha = report.subjects.find(row => row.subject === "p:alpha")!;
    // A's share of its own bill is withheld; B's share is the whole of its one subject.
    expect(alpha.subscriptions[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(alpha.subscriptions[ACCOUNTS.a]!.api_usd).toBe(0.63);
    expect(alpha.subscriptions[ACCOUNTS.b]!.billed_usd).toBeCloseTo(b.paid_usd!, 2);
    expect(alpha.billed_complete).toBe(false);
    // The report never claims complete API value while an exclusion is published.
    expect(report.totals.api_complete).toBe(false);
    expect(report.notes.some(note => note.includes("Rachunek nie jest dzielony"))).toBe(true);
    expect(report.notes.some(note => note.includes("sprzeczne kopie"))).toBe(true);
  } finally { fixture.teardown(); }
});

test("history publishes the same account exclusions and stops asserting bucket completeness", () => {
  const fixture = createFixture();
  try {
    const history = fixture.history();
    // 09-14: a-ok1 120k + a-mirror 10k; the excluded 02:00 copy is in neither total.
    expect(point(history, "2026-09-14")).toMatchObject({ tokens: 130_000, calls: 2, api_usd: 0.63 });
    // The gap runs from the accepted 01:00 call to the accepted 03:00 call, capped at 900 s;
    // an excluded copy neither receives a gap nor bridges one.
    expect(point(history, "2026-09-14")?.active_seconds).toBe(900);
    expect(point(history, "2026-09-15")).toMatchObject({ tokens: 240_000, calls: 1, api_usd: 1.2 });
    // 09-16 holds only the conflicted empty call, so the day has no accepted traffic at all.
    expect(point(history, "2026-09-16")).toBeUndefined();
    expect(history.totals).toMatchObject({ tokens: 370_000, calls: 3, api_complete: false });
    // A conflicted call has no certain timestamp, so no bucket of this range claims completeness.
    expect(history.points.map(row => row.api_complete)).toEqual([false, false]);
    expect(history.claude?.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 3 }]);
    expect(history.totals.by_sub[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(history.totals.by_sub[ACCOUNTS.b]!.billed_usd).toBeCloseTo(3.29, 2);
    expect(history.notes.some(note => note.includes("copies contradict each other"))).toBe(true);
    // The same shared decision reaches the history helper and the project helper alike.
    const shared = storedHistoryUsage(fixture.db, "claude", RATES, { ...RANGE, idleGapMinutes: 15 });
    expect(shared.conflicts).toEqual(fixture.usage().conflicts);
  } finally { fixture.teardown(); }
});

test("an account whose every identity is excluded still reports its exclusions", () => {
  const fixture = createFixture({ events: [
    { id: 1, call_id: "only", ts: "2026-09-15T01:00:00.000Z", project: "alpha", in_uncached: 10_000 },
    { id: 2, call_id: "only", ts: "2026-09-15T02:00:00.000Z", project: "beta", in_uncached: 30_000, store: "mirror" },
  ] });
  try {
    const usage = fixture.usage();
    // No accepted group, no active day, no account - and therefore nothing but the exclusion.
    expect(usage.accounts).toEqual([]);
    expect(usage.groups).toEqual([]);
    expect(usage.days_by_account).toEqual([]);
    expect(usage.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 1 }]);

    const report = fixture.report();
    expect(report.subscriptions).toEqual([]);
    expect(report.subjects).toEqual([]);
    expect(report.totals.tokens).toBe(0);
    expect(report.totals.api_usd).toBe(0);
    expect(report.totals.api_complete).toBe(false);
    expect(report.coverage.conflicting_usage).toMatchObject({ identities: 1, tokens: null, api_usd: null });

    const history = fixture.history();
    expect(history.points).toEqual([]);
    expect(history.totals).toMatchObject({ tokens: 0, calls: 0, api_usd: 0, api_complete: false });
    expect(history.claude?.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 1 }]);
  } finally { fixture.teardown(); }
});

test("a zero-token conflict is an excluded identity, not an empty accepted call", () => {
  const fixture = createFixture({ events: [
    { id: 1, call_id: "empty", ts: "2026-09-15T01:00:00.000Z", project: "alpha" },
    { id: 2, call_id: "empty", ts: "2026-09-15T02:00:00.000Z", project: "alpha", store: "mirror" },
    { id: 3, call_id: "kept", ts: "2026-09-15T03:00:00.000Z", project: "alpha", in_uncached: 10_000 },
  ] });
  try {
    const usage = fixture.usage();
    // The accepted call is the only call; the conflicted one is not a zero-token call of alpha.
    expect(group(usage, ACCOUNTS.a, "p:alpha")).toMatchObject({ tokens: 10_000, calls: 1 });
    expect(usage.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 1 }]);
    // Zero tokens are not zero evidence: the exclusion is still published and still counts.
    const report = fixture.report();
    expect(report.totals.calls).toBe(1);
    expect(report.coverage.conflicting_usage!.identities).toBe(1);
  } finally { fixture.teardown(); }
});

test("removing a contradicting copy restores the canonical call, the fee split and a fresh reference", () => {
  const incremental = createFixture();
  const reference = createFixture({ events: EVENTS.filter(event => !event.contradicting) });
  try {
    const before = incremental.report();
    expect(before.coverage.conflicting_usage!.identities).toBe(3);
    const valuations = incremental.valuations();
    expect(valuations.size).toBeGreaterThan(0);

    // 1. The copy dated outside the selection is corrected away. Correcting it marks every day
    //    of that identity, the selected 09-15 day included, so the in-range count follows it.
    incremental.db.exec("DELETE FROM claude_events WHERE id=7");
    incremental.prepareFacts();
    expect(incremental.usage().conflicts).toEqual([{ account: ACCOUNTS.a, identities: 2 }]);
    expect(group(incremental.usage(), ACCOUNTS.a, "p:alpha")?.tokens).toBe(150_000);

    // 2. The remaining contradictions are corrected away as well, across a restart.
    incremental.db.exec("DELETE FROM claude_events WHERE id IN (5,9)");
    incremental.prepareFacts();
    incremental.reopen();
    const after = incremental.report();
    expect(after).toEqual(reference.report());
    expect(after.coverage.conflicting_usage).toBeUndefined();
    expect(after.totals.api_complete).toBe(true);
    // 120k + 50k + 10k + 20k + 0 tokens, five calls, 0.6 + 0.15 + 0.03 + 0.06 dollars.
    const alpha = after.subjects.find(row => row.subject === "p:alpha")!;
    expect(alpha.subscriptions[ACCOUNTS.a]).toMatchObject({ tokens: 200_000, calls: 5, api_usd: 0.84 });
    // The fee of account A is allocated again, and account B is exactly where it was.
    const a = after.subscriptions.find(row => row.id === ACCOUNTS.a)!;
    expect(a.api_complete).toBe(true);
    expect(alpha.subscriptions[ACCOUNTS.a]!.billed_usd).toBeCloseTo(a.paid_usd!, 2);
    expect(alpha.subscriptions[ACCOUNTS.b]!.billed_usd)
      .toBe(before.subjects.find(row => row.subject === "p:alpha")!.subscriptions[ACCOUNTS.b]!.billed_usd);
    expect(after.notes.some(note => note.includes("sprzeczne kopie"))).toBe(false);
    expect(incremental.history().claude?.conflicts).toBeUndefined();
    expect(incremental.history().totals.api_complete).toBe(true);

    // Previously registered valuations of the unaffected calls are preserved.
    const remaining = incremental.valuations();
    expect(remaining.size).toBeGreaterThan(0);
    for (const [key, value] of remaining) expect(valuations.get(key)).toBe(value);
  } finally { incremental.teardown(); reference.teardown(); }
});

test("a restart and a share-only update change neither the counts nor the registered valuations", () => {
  const fixture = createFixture();
  try {
    const first = fixture.usage();
    expect(first.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 3 }]);
    const valuations = fixture.valuations();
    // Only the product share of a percentage reading changes; no usage and no price is touched.
    fixture.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,extra) VALUES('claude',?,?,'weekly_all',24,'{\"claude.share.percent\":15}')")
      .run(ACCOUNTS.a, "2026-09-16T12:00:00.000Z");
    fixture.reopen();
    expect(fixture.usage()).toEqual(first);
    expect(fixture.valuations()).toEqual(valuations);
  } finally { fixture.teardown(); }
});

test("later unrelated traffic leaves the selected count; a late contradicting copy of a selected call joins it", () => {
  const fixture = createFixture();
  const insert = (id: number, call: string, ts: string, tokens: number) =>
    fixture.db.query(`INSERT INTO claude_events(id,store,call_id,session_id,ts,model,speed,entrypoint,cc_version,
        project_id,subscription_id,in_uncached,out_total) VALUES(?,'mirror',?,'sa',?,'m-std','standard','cli','2.0.0',
        'alpha',?,?,0)`).run(id, call, ts, ACCOUNTS.a, tokens);
  try {
    const first = fixture.usage();

    // A wholly new call of the same account, nine days after the selection. It shares no
    // identity with anything selected, so it cannot change a count taken over 09-14..09-16.
    insert(99, "a-later", "2026-09-25T01:00:00.000Z", 5_000);
    fixture.prepareFacts();
    fixture.reopen();
    expect(fixture.usage()).toEqual(first);

    // A late copy that contradicts a SELECTED call is the opposite case: dated outside the
    // selection, it still excludes the selected original.
    insert(100, "a-ok1", "2026-09-26T01:00:00.000Z", 60_000);
    fixture.prepareFacts();
    const third = fixture.usage();
    expect(third.conflicts).toEqual([{ account: ACCOUNTS.a, identities: 4 }]);
    // a-ok1 is excluded now, so only a-mirror survives on the selected days.
    expect(group(third, ACCOUNTS.a, "p:alpha")).toMatchObject({ tokens: 10_000, calls: 1 });
  } finally { fixture.teardown(); }
});
