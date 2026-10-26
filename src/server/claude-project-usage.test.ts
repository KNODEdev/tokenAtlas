import { prepareClaudeReaderFixture } from "./subscription-reader.fixture";
/**
 * Acceptance for the Claude side of the project cost report.
 *
 * The fixture is synthetic and self-contained: its own temporary database, its own
 * rate card and its own events. No production database, archive or usage log is read,
 * and every expected number below is computed by hand in the comment next to it.
 */
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { storedProjectUsage, UnsafeProjectSum, type ProjectUsage } from "./stored-project-usage";
import { computeEquivalentsAndProvenance, type SubscriptionCapacity } from "./capacity-equivalents";
import { buildProjectCost } from "./project-cost";
import type { RateCard } from "./pricing";

const ACCOUNTS = { a: "acct-a", b: "acct-b" } as const;
const RANGE = { since: "2026-09-14", until: "2026-09-16" } as const;

/** Standard: 3 / 0.3 / 15 per 1M. Fast is exactly three times Standard. */
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
        // Priced in Fast only: the actual amount exists, the Standard one cannot.
        "m-fast-only": {
          in_uncached: null, in_cache_read: null, in_cache_write_5m: null, in_cache_write_1h: null, out_total: null,
          fast: { in_uncached: 9, in_cache_read: 0.9, in_cache_write_5m: 11.25, in_cache_write_1h: 18, out_total: 45 },
        },
      },
    },
  },
  // Only account A has a declared price. Account B must never inherit it.
  subscriptions: { "acct-a": { plan: "max", usd_per_month: 200 } },
};

interface EventSpec {
  call_id: string;
  ts: string;
  account?: string | null;
  conflict?: number;
  project?: string | null;
  repo?: string | null;
  model?: string;
  speed?: string;
  in_uncached?: number;
  in_cache_read?: number;
  out_total?: number;
  store?: string;
}

const EVENTS: EventSpec[] = [
  { call_id: "a-alpha", ts: "2026-09-14T01:00:00.000Z", project: "alpha", in_uncached: 100_000, out_total: 20_000 },
  // Byte-identical second copy of the same call: one event, priced once.
  { call_id: "a-alpha", ts: "2026-09-14T01:00:00.000Z", project: "alpha", in_uncached: 100_000, out_total: 20_000, store: "mirror" },
  { call_id: "a-beta", ts: "2026-09-15T01:00:00.000Z", repo: "beta", in_cache_read: 40_000, out_total: 10_000 },
  { call_id: "a-none", ts: "2026-09-15T02:00:00.000Z", in_uncached: 10_000 },
  { call_id: "a-fast", ts: "2026-09-16T01:00:00.000Z", project: "alpha", speed: "fast", in_uncached: 100_000, out_total: 20_000 },
  { call_id: "a-zero", ts: "2026-09-16T02:00:00.000Z", project: "alpha" },
  { call_id: "a-gamma", ts: "2026-09-16T03:00:00.000Z", project: "gamma", model: "m-fast-only", speed: "fast", in_uncached: 100_000, out_total: 20_000 },
  { call_id: "a-missing", ts: "2026-09-16T04:00:00.000Z", project: "alpha", model: "m-gone", in_uncached: 7_000 },
  { call_id: "a-missing-zero", ts: "2026-09-16T05:00:00.000Z", project: "alpha", model: "m-gone" },
  { call_id: "b-alpha", ts: "2026-09-15T03:00:00.000Z", account: ACCOUNTS.b, project: "alpha", in_uncached: 200_000, out_total: 40_000 },
  { call_id: "x-conflict", ts: "2026-09-15T04:00:00.000Z", conflict: 1, project: "alpha", in_uncached: 30_000, out_total: 5_000 },
  { call_id: "x-none", ts: "2026-09-15T05:00:00.000Z", account: null, project: "alpha", in_uncached: 20_000 },
  { call_id: "a-outside", ts: "2026-09-20T01:00:00.000Z", project: "alpha", in_uncached: 1_000 },
];

const SCHEMA = `
  CREATE TABLE claude_events(id INTEGER PRIMARY KEY, store TEXT, call_id TEXT, ts TEXT, model TEXT, speed TEXT,
    entrypoint TEXT, cc_version TEXT, project_id TEXT, repo TEXT, subscription_id TEXT,
    subscription_conflict INTEGER DEFAULT 0, in_uncached INTEGER DEFAULT 0, in_cache_read INTEGER DEFAULT 0,
    in_cache_write INTEGER DEFAULT 0, cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0,
    out_total INTEGER DEFAULT 0, out_thinking INTEGER DEFAULT 0);
  CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, subject TEXT, ts TEXT, kind TEXT, scope TEXT,
    used_percent REAL, resets_at TEXT, extra TEXT);
  CREATE TABLE analysis_source_revisions(source TEXT, bucket TEXT, revision INTEGER, PRIMARY KEY(source,bucket));`;

function createFixture(options: { events?: EventSpec[]; schema?: string; prepare?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claude-project-usage-"));
  const dbPath = join(directory, "atlas.db");
  let db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(options.schema ?? SCHEMA);
  installAnalysisTracking(db);
  const insert = db.query(`INSERT INTO claude_events(store,call_id,ts,model,speed,entrypoint,cc_version,
      project_id,repo,subscription_id,subscription_conflict,in_uncached,in_cache_read,out_total)
    VALUES(?,?,?,?,?,'cli','2.0.0',?,?,?,?,?,?,?)`);
  for (const event of options.events ?? EVENTS) {
    insert.run(event.store ?? "primary", event.call_id, event.ts, event.model ?? "m-std", event.speed ?? "standard",
      event.project ?? null, event.repo ?? null,
      event.account === undefined ? ACCOUNTS.a : event.account, event.conflict ?? 0,
      event.in_uncached ?? 0, event.in_cache_read ?? 0, event.out_total ?? 0);
  }
  insert.finalize();
  const fixture = {
    directory, get db() { return db; },
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
    teardown() { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
  if (options.prepare !== false) fixture.prepareFacts();
  return fixture;
}

const group = (usage: ProjectUsage, account: string, subject: string | null) =>
  usage.groups.find(row => row.account === account && row.subject === subject);

test("two accounts and two subjects stay separate, the duplicate copy is counted once", () => {
  const fixture = createFixture();
  try {
    const usage = fixture.usage();
    expect(usage.accounts).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
    expect(usage.days_by_account).toEqual([
      [ACCOUNTS.a, ["2026-09-14", "2026-09-15", "2026-09-16"]],
      [ACCOUNTS.b, ["2026-09-15"]],
    ]);
    // p:alpha on A = a-alpha (one of two identical copies) + a-fast + a-zero + a-missing-zero.
    // The last one has no rate card, but it also has no tokens, so its cost is a real zero.
    const alphaA = group(usage, ACCOUNTS.a, "p:alpha")!;
    expect(alphaA.tokens).toBe(240_000);
    expect(alphaA.calls).toBe(4);
    expect(alphaA.tokens_by_type).toEqual({ in_uncached: 200_000, cache_read: 0, cache_write: 0, out: 40_000 });
    // 0.6 standard + 1.8 fast + 0 empty call.
    expect(alphaA.api_usd).toBeCloseTo(2.4, 12);
    // r:beta = 40k cache reads at 0.3 + 10k output at 15 per 1M.
    const beta = group(usage, ACCOUNTS.a, "r:beta")!;
    expect(beta.tokens).toBe(50_000);
    expect(beta.api_usd).toBeCloseTo(0.012 + 0.15, 12);
    // Traffic with neither a project nor a repo keeps its own row.
    const unassigned = group(usage, ACCOUNTS.a, null)!;
    expect(unassigned.tokens).toBe(10_000);
    expect(unassigned.api_usd).toBeCloseTo(0.03, 12);
    // The other account's identical project keeps its own, separate amount.
    const alphaB = group(usage, ACCOUNTS.b, "p:alpha")!;
    expect(alphaB.tokens).toBe(240_000);
    expect(alphaB.calls).toBe(1);
    expect(alphaB.api_usd).toBeCloseTo(1.2, 12);
    expect(group(usage, ACCOUNTS.b, "r:beta")).toBeUndefined();
    // The duplicate copy is not a second call and the day outside the range is absent.
    expect(usage.groups.reduce((sum, row) => sum + row.calls, 0)).toBe(8);
  } finally { fixture.teardown(); }
});

test("unknown and conflicting ownership stay evidence rows, never a guessed account", () => {
  const fixture = createFixture();
  try {
    const usage = fixture.usage();
    // 30k + 5k conflicting, 20k without any subscription id: tokens and calls, no money.
    expect(usage.evidence).toEqual([{ reason: "unverified_account", tokens: 55_000, calls: 2 }]);
    expect(usage.accounts).not.toContain("claude");
    expect(usage.groups.every(row => row.account === ACCOUNTS.a || row.account === ACCOUNTS.b)).toBe(true);
    // Their tokens are nowhere in a priced account total.
    const priced = usage.groups.reduce((sum, row) => sum + row.tokens, 0);
    expect(priced).toBe(240_000 + 50_000 + 10_000 + 120_000 + 240_000);
  } finally { fixture.teardown(); }
});

test("actual Fast dollars and the Standard amount are summed separately and stay separately absent", () => {
  const fixture = createFixture();
  try {
    const usage = fixture.usage();
    // p:alpha: actual 0.6 + 1.8 (Fast) + 0; Standard 0.6 + 0.6 + 0.
    const alphaA = group(usage, ACCOUNTS.a, "p:alpha")!;
    expect(alphaA.api_usd).toBeCloseTo(2.4, 12);
    expect(alphaA.standard_usd).toBeCloseTo(1.2, 12);
    // p:gamma is priced in Fast only, so its Standard amount is missing, not zero.
    const gamma = group(usage, ACCOUNTS.a, "p:gamma")!;
    expect(gamma.api_usd).toBeCloseTo(1.8, 12);
    expect(gamma.standard_usd).toBeNull();
    const period = { since: RANGE.since, until: RANGE.until };
    const capacity: SubscriptionCapacity = {
      sub_id: ACCOUNTS.a, vendor: "claude", value_basis: "standard_normalized", plan: null, usd_per_month: 200,
      usd_per_point: 0.012, weekly_window_value_usd: 1.2, session_window_value_usd: null, window_hours: 168,
      session_hours: null, capacity_basis: "single", price_basis: "rate-card", cadence: "declared",
      calibration_start_ts: "2026-09-01T00:00:00Z", calibration_end_ts: "2026-09-30T00:00:00Z",
    };
    // One Standard weekly capacity of 1.2 covers exactly the 1.2 Standard dollars.
    // Dividing the 2.4 actual dollars instead would have claimed two whole cycles.
    expect(computeEquivalentsAndProvenance(alphaA.api_usd, capacity, period, alphaA.standard_usd)
      .equivalents.weekly_cycles).toEqual({ value: 1, absent: null });
    expect(computeEquivalentsAndProvenance(gamma.api_usd, capacity, period, gamma.standard_usd)
      .equivalents.weekly_cycles).toEqual({ value: null, absent: "invalid_usage" });
  } finally { fixture.teardown(); }
});

test("a missing rate hides only traffic that actually carries tokens", () => {
  const fixture = createFixture();
  try {
    const usage = fixture.usage();
    // The owning account travels with the unpriced group, so the report can refuse to
    // allocate that account's bill over the part of its traffic that does have a price.
    // Only a-missing is in it: a-missing-zero shares the absent card but spends nothing,
    // and a zero-token call costs zero whatever the card would have said.
    expect(usage.unpriced).toEqual([{ account: ACCOUNTS.a, model: "m-gone", reason: "missing_rate", tokens: 7_000, calls: 1 }]);
    const alphaA = group(usage, ACCOUNTS.a, "p:alpha")!;
    expect(alphaA.calls).toBe(4);
    // Neither empty call moves tokens or dollars into the priced subject.
    expect(alphaA.tokens).toBe(240_000);
  } finally { fixture.teardown(); }
});

test("selected date endpoints bound the sums exactly", () => {
  const fixture = createFixture();
  try {
    const oneDay = fixture.usage({ since: "2026-09-15", until: "2026-09-15" });
    expect(oneDay.days_by_account).toEqual([[ACCOUNTS.a, ["2026-09-15"]], [ACCOUNTS.b, ["2026-09-15"]]]);
    expect(group(oneDay, ACCOUNTS.a, "p:alpha")).toBeUndefined();
    expect(group(oneDay, ACCOUNTS.a, "r:beta")?.tokens).toBe(50_000);
    expect(group(oneDay, ACCOUNTS.b, "p:alpha")?.api_usd).toBeCloseTo(1.2, 12);
    expect(oneDay.evidence).toEqual([{ reason: "unverified_account", tokens: 55_000, calls: 2 }]);
    const firstDay = fixture.usage({ since: "2026-09-14", until: "2026-09-14" });
    expect(firstDay.accounts).toEqual([ACCOUNTS.a]);
    expect(group(firstDay, ACCOUNTS.a, "p:alpha")?.api_usd).toBeCloseTo(0.6, 12);
    expect(firstDay.evidence).toEqual([]);
    // The event outside the selection is reachable only when the range includes it.
    const wide = fixture.usage({ since: "2026-09-14", until: "2026-09-20" });
    expect(group(wide, ACCOUNTS.a, "p:alpha")?.calls).toBe(5);
  } finally { fixture.teardown(); }
});

test("discovery resolves preserved timestamp offsets to the canonical UTC day", () => {
  // Ingestion keeps the offset it was given, so the stored date and the fact date differ.
  const fixture = createFixture({ events: [
    { call_id: "east", ts: "2026-09-18T00:30:00+02:00", project: "offset", in_uncached: 4_000, out_total: 1_000 },
    { call_id: "west", ts: "2026-09-16T23:30:00-02:00", project: "offset", in_uncached: 5_600, out_total: 1_400 },
    { call_id: "loose", ts: "2026-09-18T00:30:00+02:00", account: null, in_uncached: 1_600, out_total: 400 },
    { call_id: "legacy", ts: "2026-09-17", project: "offset", in_uncached: 1_000 },
  ] });
  try {
    const usage = fixture.usage({ since: "2026-09-17", until: "2026-09-17" });
    expect(usage.accounts).toEqual([ACCOUNTS.a]);
    const offset = group(usage, ACCOUNTS.a, "p:offset")!;
    expect(offset.calls).toBe(3);
    expect(offset.tokens).toBe(13_000);
    // 0.027 + 0.0378 for the two offset rows, 0.003 for the date-only legacy row.
    expect(offset.api_usd).toBeCloseTo(0.0678, 12);
    // The unowned row on the same instant is selected into the same UTC day.
    expect(usage.evidence).toEqual([{ reason: "unverified_account", tokens: 2_000, calls: 1 }]);
    // The neighbouring local dates themselves hold nothing for this selection.
    expect(fixture.usage({ since: "2026-09-18", until: "2026-09-18" }).accounts).toEqual([]);
  } finally { fixture.teardown(); }
});

test("an unsafe sum fails explicitly across days, for priced groups and for source evidence", () => {
  const huge = 9_000_000_000_000_000;
  const day = (id: string, date: string, account: string | null) =>
    ({ call_id: id, ts: `${date}T01:00:00.000Z`, account, project: "alpha", in_uncached: huge });
  const priced = createFixture({ events: [day("h1", "2026-09-15", ACCOUNTS.a), day("h2", "2026-09-16", ACCOUNTS.a)] });
  try { expect(() => priced.usage()).toThrow(UnsafeProjectSum); } finally { priced.teardown(); }
  // Evidence is never repriced to be checked; its own counters are still validated.
  const evidence = createFixture({ events: [day("u1", "2026-09-15", null), day("u2", "2026-09-16", null)] });
  try { expect(() => evidence.usage()).toThrow(UnsafeProjectSum); } finally { evidence.teardown(); }
});

test("an unprepared fact index asks for background preparation; a published one answers until it catches up", () => {
  const fixture = createFixture({ prepare: false });
  try {
    expect(() => fixture.usage()).toThrow(SubscriptionFactsPending);
    fixture.prepareFacts();
    expect(fixture.usage().accounts).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
    fixture.db.query(`INSERT INTO claude_events(store,call_id,ts,model,speed,entrypoint,cc_version,project_id,
        subscription_id,in_uncached) VALUES('primary','a-late','2026-09-14T09:00:00.000Z','m-std','standard','cli','2.0.0','alpha',?,1000)`)
      .run(ACCOUNTS.a);
    // The published index answers as it stands until the producer reaches the late call (golden rules §9).
    expect(group(fixture.usage(), ACCOUNTS.a, "p:alpha")?.calls).toBe(4);
    fixture.prepareFacts();
    expect(group(fixture.usage(), ACCOUNTS.a, "p:alpha")?.calls).toBe(5);
  } finally { fixture.teardown(); }
});

test("a correction moves the subject, a late event counts on its own day, a move re-homes the account", () => {
  const fixture = createFixture();
  try {
    fixture.usage();
    const valuations = fixture.valuations();
    expect(valuations.size).toBeGreaterThan(0);

    // 1. A project correction: the same tokens, a different subject, the same prices.
    fixture.db.exec("UPDATE claude_events SET project_id='delta' WHERE call_id='a-alpha'");
    fixture.prepareFacts();
    const corrected = fixture.usage();
    expect(group(corrected, ACCOUNTS.a, "p:delta")?.tokens).toBe(120_000);
    expect(group(corrected, ACCOUNTS.a, "p:delta")?.api_usd).toBeCloseTo(0.6, 12);
    expect(group(corrected, ACCOUNTS.a, "p:alpha")?.tokens).toBe(120_000);
    // Moving a call between projects must not discard or redo its valuation.
    expect(fixture.valuations()).toEqual(valuations);

    // 2. A late event updates the day it happened on, not the day it arrived.
    fixture.db.query(`INSERT INTO claude_events(store,call_id,ts,model,speed,entrypoint,cc_version,repo,
        subscription_id,in_uncached) VALUES('primary','a-late','2026-09-15T23:00:00.000Z','m-std','standard','cli','2.0.0','beta',?,10000)`)
      .run(ACCOUNTS.a);
    fixture.prepareFacts();
    const late = fixture.usage();
    expect(group(late, ACCOUNTS.a, "r:beta")?.tokens).toBe(60_000);

    // 3. A historical account change moves the traffic, it does not duplicate it.
    fixture.db.exec(`UPDATE claude_events SET subscription_id='${ACCOUNTS.b}',path=NULL WHERE call_id='a-beta'`);
    fixture.prepareFacts();
    const moved = fixture.usage();
    expect(group(moved, ACCOUNTS.a, "r:beta")?.tokens).toBe(10_000);
    expect(group(moved, ACCOUNTS.b, "r:beta")?.tokens).toBe(50_000);
    expect(group(moved, ACCOUNTS.b, "r:beta")?.api_usd).toBeCloseTo(0.162, 12);
  } finally { fixture.teardown(); }
});

test("changing one account's call leaves the other account's sums unchanged", () => {
  const fixture = createFixture();
  try {
    fixture.usage();
    fixture.db.exec("UPDATE claude_events SET in_uncached=50000 WHERE call_id='a-fast'");
    fixture.prepareFacts();
    const usage = fixture.usage();
    // 50k Fast input at 9 plus 20k Fast output at 45 per 1M.
    expect(group(usage, ACCOUNTS.a, "p:alpha")?.api_usd).toBeCloseTo(0.6 + (0.45 + 0.9), 12);
    expect(group(usage, ACCOUNTS.b, "p:alpha")?.api_usd).toBeCloseTo(1.2, 12);
  } finally { fixture.teardown(); }
});

test("a restart and a share-only update change neither the sums nor the registered valuations", () => {
  const fixture = createFixture();
  try {
    const first = fixture.usage();
    const valuations = fixture.valuations();
    // Only the product share of a percentage reading changes; no usage is touched.
    fixture.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,extra) VALUES('claude',?,?,'weekly_all',24,'{\"claude.share.percent\":15}')")
      .run(ACCOUNTS.a, "2026-09-16T12:00:00.000Z");
    fixture.reopen();
    expect(fixture.usage()).toEqual(first);
    expect(fixture.valuations()).toEqual(valuations);
  } finally { fixture.teardown(); }
});

test("buildProjectCost reports one subscription per verified Claude account", () => {
  const fixture = createFixture();
  try {
    const report = buildProjectCost(fixture.db, RATES, new Map(), RANGE);
    expect(report.subscriptions.map(row => row.id).sort()).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
    const a = report.subscriptions.find(row => row.id === ACCOUNTS.a)!;
    // 2.4 + 0.162 + 0.03 + 1.8 actual dollars across three days.
    expect(a.api_usd).toBe(4.39);
    expect(a.attributed_usd).toBe(4.36);
    expect(a.vendor).toBe("claude");
    expect([a.first_day, a.last_day, a.days]).toEqual(["2026-09-14", "2026-09-16", 3]);
    expect(a.usd_per_month).toBe(200);
    expect(a.paid_usd).toBeCloseTo((200 * 3) / 30.44, 2);
    const b = report.subscriptions.find(row => row.id === ACCOUNTS.b)!;
    expect(b.api_usd).toBe(1.2);
    expect([b.first_day, b.last_day, b.days]).toEqual(["2026-09-15", "2026-09-15", 1]);
    // Account B declares no price, so it must not inherit account A's 200 USD.
    expect(b.usd_per_month).toBeNull();
    expect(b.paid_usd).toBeNull();

    const alpha = report.subjects.find(row => row.subject === "p:alpha")!;
    expect(alpha.tokens).toBe(480_000);
    expect(alpha.api_usd).toBe(3.6);
    expect(alpha.calls).toBe(5);
    expect(alpha.by_sub).toEqual({ [ACCOUNTS.a]: 2.4, [ACCOUNTS.b]: 1.2 });
    expect(alpha.subscriptions[ACCOUNTS.a]?.tokens).toBe(240_000);
    expect(alpha.subscriptions[ACCOUNTS.b]?.tokens).toBe(240_000);
    // Account A cannot price all of its own traffic (m-gone), so its known fee must not
    // be spread over the priced remainder. The fee itself stays published above.
    expect(alpha.subscriptions[ACCOUNTS.a]?.billed_usd).toBeNull();
    expect(alpha.subscriptions[ACCOUNTS.b]?.billed_usd).toBeNull();
    expect(alpha.billed_complete).toBe(false);
    expect(report.notes.some((note) => note.includes("missing_rate"))).toBe(true);
    expect(report.subjects.find(row => row.subject === "r:beta")).toMatchObject({ kind: "repo", tokens: 50_000, api_usd: 0.16 });
    expect(report.subjects.find(row => row.subject === "p:gamma")).toMatchObject({ tokens: 120_000, api_usd: 1.8 });

    // Rows nobody can own are counted once, in the established coverage counter:
    // 10k unassigned traffic of account A plus the 55k without a verified account.
    expect(report.coverage.unassigned).toMatchObject({ tokens: 65_000, calls: 3, api_usd: null, billed_usd: null });
    // The known part of those dollars is still published in the subtotal fields.
    expect(report.totals.unassigned_api_usd).toBe(0.03);
    expect(report.coverage.unpriced).toMatchObject({ tokens: 7_000, calls: 1, api_usd: null, models: { "m-gone": 7_000 } });
    // The diagnostic is a named subset of unassigned, not the only home of these rows.
    expect(report.coverage.unverified_account).toMatchObject({
      vendor: "claude", tokens: 55_000, calls: 2, api_usd: null, billed_usd: null, reasons: ["unverified_account"],
    });
    // 650k attributed + 10k unassigned + 7k unpriced + 55k without a verified account.
    expect(report.totals.tokens).toBe(722_000);
    expect(report.totals.calls).toBe(11);
    expect(report.totals.api_usd).toBe(5.59);
  } finally { fixture.teardown(); }
});

test("a range in which every actual price is known still allocates that account's bill", () => {
  const fixture = createFixture();
  try {
    // 09-14 and 09-15 hold no unpriced traffic: 0.6 + 0.162 + 0.03 = 0.792 for account A.
    // Rows without a verified account are on 09-15 and must not block that allocation.
    const report = buildProjectCost(fixture.db, RATES, new Map(), { since: "2026-09-14", until: "2026-09-15" });
    const a = report.subscriptions.find(row => row.id === ACCOUNTS.a)!;
    expect(a.api_usd).toBe(0.79);
    expect(a.paid_usd).toBeCloseTo((200 * 2) / 30.44, 2);
    const alpha = report.subjects.find(row => row.subject === "p:alpha")!;
    expect(alpha.subscriptions[ACCOUNTS.a]!.billed_usd!).toBeCloseTo((a.paid_usd! * 0.6) / 0.792, 1);
    expect(report.coverage.unassigned).toMatchObject({ tokens: 65_000, calls: 3, api_usd: null });
    expect(report.totals.unassigned_api_usd).toBe(0.03);
    expect(report.coverage.unverified_account).toMatchObject({ tokens: 55_000, calls: 2 });
    expect(report.notes.some((note) => note.includes("Rachunek nie jest dzielony"))).toBe(false);
  } finally { fixture.teardown(); }
});

test("a Claude source without call identity has no usage ledger: reports state their preparation, never a raw total", () => {
  const legacy = `
    CREATE TABLE claude_events(ts TEXT, repo TEXT, project_id TEXT, model TEXT, speed TEXT,
      in_uncached INTEGER DEFAULT 0, in_cache_read INTEGER DEFAULT 0, in_cache_write INTEGER DEFAULT 0,
      cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, out_total INTEGER DEFAULT 0,
      session_id TEXT, store TEXT);
    CREATE TABLE analysis_source_revisions(source TEXT, bucket TEXT, revision INTEGER, PRIMARY KEY(source,bucket));`;
  const directory = mkdtempSync(join(tmpdir(), "claude-legacy-"));
  const db = new Database(join(directory, "atlas.db"));
  try {
    db.exec(legacy);
    installAnalysisTracking(db);
    db.exec(`INSERT INTO claude_events(ts,repo,project_id,model,speed,in_uncached,out_total,session_id,store)
      VALUES('2026-09-15T01:00:00.000Z','beta','alpha','m-std','standard',100000,20000,'s1','claude')`);
    // Every number comes from the usage ledger, which a source without call identity cannot fill.
    expect(() => storedProjectUsage(db, "claude", RATES, RANGE)).toThrow(SubscriptionFactsPending);
    expect(() => buildProjectCost(db, RATES, new Map(), RANGE)).toThrow(SubscriptionFactsPending);
  } finally { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("an empty table and an absent source stay harmless", () => {
  const empty = createFixture({ events: [] });
  try {
    const usage = empty.usage();
    expect(usage).toMatchObject({ accounts: [], groups: [], unpriced: [], evidence: [] });
    expect(buildProjectCost(empty.db, RATES, new Map(), RANGE).coverage.unverified_account).toBeUndefined();
  } finally { empty.teardown(); }
  const directory = mkdtempSync(join(tmpdir(), "claude-absent-"));
  const db = new Database(join(directory, "atlas.db"));
  try {
    db.exec(`CREATE TABLE analysis_source_revisions(source TEXT, bucket TEXT, revision INTEGER, PRIMARY KEY(source,bucket));`);
    installAnalysisTracking(db);
    expect(storedProjectUsage(db, "claude", RATES, RANGE)).toMatchObject({ accounts: [], groups: [], evidence: [] });
    expect(buildProjectCost(db, RATES, new Map(), RANGE).totals.tokens).toBe(0);
  } finally { db.close(true); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
