import { expect, spyOn, test } from "bun:test";
import type { Database } from "../db/sqlite";
import { database, settle as prepareSums, card, sources, opened } from "./window-usage-codex.fixture";
import { ensureCapacityCycleResults, markCapacityCycleResultsDirty } from "../db/capacity-cycle-results";
import { advanceCapacityCycleResults } from "./capacity-cycle-producer";
import { handleCapacityCycles } from "./capacity-cycles";
import { handleAllowanceSummary } from "./allowance-summary";
import { DATA_VIEWS, serveDataView } from "./data-views";
import { summarizeAllowance, type AllowanceCandidatesResponse, type AllowanceSummaryResponse } from "../shared/allowance-summary";
import type { AppContext } from "./api";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const CLAUDE_COUNTERS = [["weekly_all", "weekly", 10080], ["weekly_scoped", "weekly", 10080], ["session", "session", 300]].map(part => JSON.stringify(part));
const summaryUrl = (query: string) => new URL(`http://local/api/allowance-summary?${query}`);
function context(sqlite: Database): AppContext {
  return { sqlite, accounts: { version: 2, subscriptions: [{ id: "codex1", vendor: "codex" }, { id: "claude1", vendor: "claude" }], sources },
    rateCards: card, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
}
function settle(ctx: AppContext) {
  for (let i = 0; i < 100; i++) if (!advanceCapacityCycleResults(ctx, { budgetMs: 10000 })?.pending) return;
  throw new Error("Capacity results did not settle");
}
/** A Claude account with an account-wide weekly meter, a scoped weekly sub-limit and a 5-hour one, and no published cycle. */
function claudeCounters(db: Database) {
  CLAUDE_COUNTERS.forEach((counter, seq) => db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,
      cycle_end_basis,window_minutes,plan,plan_detail,plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input)
    VALUES('claude','claude1',?,?,?,'2026-09-01T00:00:00Z','2026-09-08T00:00:00Z','2026-09-08T00:00:00Z','scheduled',?,'max',NULL,0,'[]',NULL,NULL,NULL,0,'')`)
    .run(counter, seq, `w${seq}`, JSON.parse(counter)[2]));
  // New readings mark the account for the producer, as an import does.
  markCapacityCycleResultsDirty(db, "claude", "claude1", Date.parse("2026-09-01"), null);
}
function close(db: Database) { opened.splice(opened.indexOf(db), 1); db.close(); }

test("answers from the stored register only, matches the shared summary of the same cycles, and is a registered view", async () => {
  const db = database(), ctx = context(db);
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx);
    expect(DATA_VIEWS["/api/allowance-summary"]?.sources).toContain("capacity_cycle_results");
    const url = summaryUrl("a=codex1&since=2026-09-01&until=2026-09-21&unit=api_standard");
    const before = db.query("SELECT total_changes() n").get();
    const query = spyOn(db, "query");
    let response: Response;
    try {
      response = await serveDataView(ctx, url);
      const sql = query.mock.calls.map(([text]) => text).join("\n");
      expect(sql).not.toMatch(/\b(?:events|probe_windows|usage_price_events|ratelimit|window_answers)\b/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
    } finally { query.mockRestore(); }
    expect(response!.status).toBe(200);
    expect(response!.headers.get("X-Data-Version")).toBeTruthy();
    const body = await response!.json() as AllowanceSummaryResponse;
    expect(db.query("SELECT total_changes() n").get()).toEqual(before);
    expect(body.sides).toHaveLength(1);
    expect(body.sides[0]).toMatchObject({ provider: "codex", account: "codex1", counter: "weekly", state: "current" });
    const stored = await handleCapacityCycles(ctx, new URL("http://local/api/capacity-cycles?since=2026-09-01&until=2026-09-21&window_minutes=10080"),
      { account: "codex1" }).json();
    expect(body.sides[0]!.summary).toEqual(summarizeAllowance(stored.accounts[0].windows, { asOf: body.read_at, since: "2026-09-01", until: "2026-09-21" }));
    expect(body.sides[0]!.summary!.closed).toBeGreaterThan(0);
    expect(body).toMatchObject({ ratios: [], headline: null });
  } finally { close(db); }
});

test("a recalculation keeps the last published cycles as updating, and one preparing side never blanks the other", async () => {
  const db = database(), ctx = context(db);
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx); claudeCounters(db);
    const url = summaryUrl("a=codex1&b=claude1&since=2026-09-01&until=2026-09-21&unit=tokens");
    const current = await (await handleAllowanceSummary(ctx, url, NOW)).json() as AllowanceSummaryResponse;
    // The Claude side resolves its account-wide weekly meter, never the scoped sub-limit or the 5-hour one.
    expect(current.sides.map(side => [side.account, side.counter, side.state])).toEqual([
      ["codex1", "weekly", "current"], ["claude1", CLAUDE_COUNTERS[0]!, "preparing"]]);
    expect(current.sides[0]!.summary).not.toBeNull();
    expect(current.sides[1]!.summary).toBeNull();
    expect(current.ratios).toEqual([]);
    markCapacityCycleResultsDirty(db, "codex", "codex1", Date.parse("2026-09-09"), Date.parse("2026-09-10"));
    const stale = await handleAllowanceSummary(ctx, url, NOW);
    expect(stale.headers.get("X-Analysis")).toBe("stale");
    const body = await stale.json() as AllowanceSummaryResponse;
    expect(body.sides[0]!.state).toBe("updating");
    expect(body.sides[0]!.summary).toEqual(current.sides[0]!.summary);
  } finally { close(db); }
});

test("lists candidates with their main weekly counter and recent cycles", async () => {
  const db = database(), ctx = context(db);
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx); claudeCounters(db);
    const body = await (await handleAllowanceSummary(ctx, summaryUrl("candidates=1"), Date.parse("2026-09-20T00:00:00Z"))).json() as AllowanceCandidatesResponse;
    const byAccount = Object.fromEntries(body.candidates.map(candidate => [candidate.account, candidate]));
    expect(byAccount.codex1).toMatchObject({ provider: "codex", counter: "weekly", state: "current" });
    expect(byAccount.codex1!.recent_cycles).toBeGreaterThan(0);
    // The catalog in this context prices nothing: unknown, never $0.
    expect(byAccount.codex1!.usd_per_month).toBeNull();
    expect(byAccount.claude1).toMatchObject({ counter: CLAUDE_COUNTERS[0]!, state: "preparing", recent_cycles: 0 });
  } finally { close(db); }
});

test("rejects bad input with a reason before reading cycles", async () => {
  const db = database(), ctx = context(db);
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx); claudeCounters(db);
    for (const query of ["since=2026-09-01&until=2026-09-21", "a=codex1&since=2026-02-30&until=2026-09-21", "a=codex1&since=2026-09-21&until=2026-09-01",
      "a=codex1&since=2026-09-01&until=2026-09-21&unit=credits", "a=nobody&since=2026-09-01&until=2026-09-21",
      `a=claude1&a_counter=${encodeURIComponent(CLAUDE_COUNTERS[2]!)}&since=2026-09-01&until=2026-09-21`,
      "a=codex1&b=codex1&since=2026-09-01&until=2026-09-21"]) {
      const response = await handleAllowanceSummary(ctx, summaryUrl(query), NOW);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
    }
    // A chosen scoped weekly sub-limit is a weekly counter the account has, so it is allowed.
    const scoped = await handleAllowanceSummary(ctx, summaryUrl(`a=claude1&a_counter=${encodeURIComponent(CLAUDE_COUNTERS[1]!)}&since=2026-09-01&until=2026-09-21`), NOW);
    expect(scoped.status).toBe(200);
  } finally { close(db); }
});
