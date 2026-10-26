import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { handleCycleBreakdown, handleRoster, handleUsageSeries, handleWindows, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { card, database, opened, settle, sources } from "./window-usage-codex.fixture";

afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function context(db: ReturnType<typeof database>): AppContext {
  return { sqlite: db, rateCards: card, accounts: splitProbeReaderFixtureConfig(sources), eras: buildEraIndex(sources),
    subIdToHomes: new Map([["codex1", ["/archive"]]]), homeToSubId: new Map([["/archive", "codex1"]]), eraErrors: [], homeConflict: null,
    cycles: { windows: [] }, plans: {}, plansCatalog: { provider_groups: [] }, claudeGauge: {}, grokGauge: {} } as unknown as AppContext;
}
const series = async (ctx: AppContext, query = "") => {
  const response = handleUsageSeries(ctx, new URL(`http://test/api/usage-series?account=codex1&window=10080${query}`));
  return { status: response.status, body: await response.json() as Record<string, any> };
};

test("current point samples follow a corrected prepared row and survive reopening without ledger access or writes", async () => {
  const db = database();
  db.query("UPDATE limit_windows SET plan='pro' WHERE provider='codex' AND account='codex1'").run();
  settle(db);
  const before = (await series(context(db))).body.cycles;
  const candidate = before.find((cycle: any) => cycle.point_basis !== null);
  expect(candidate).toBeDefined();
  const row = db.query("SELECT window_id,cycle FROM window_usage WHERE provider='codex' AND account='codex1' AND start_ts=?")
    .get(candidate.window_start_iso) as { window_id: string; cycle: string };
  const stored = JSON.parse(row.cycle);
  stored.usage.api_normalized = (stored.usage.api_normalized ?? stored.usage.api_standard) * 1.5;
  db.query("UPDATE window_usage SET cycle=? WHERE window_id=?").run(JSON.stringify(stored), row.window_id);
  db.exec("DROP TABLE codex_price_ledger_aggregates; DROP TABLE codex_price_ledger_events");
  const copy = Database.deserialize(db.serialize(), { readonly: true });
  try {
    const changes = copy.query("SELECT total_changes() n").get();
    const after = (await series(context(copy))).body.cycles;
    const corrected = after.find((cycle: any) => cycle.window_start_iso === candidate.window_start_iso);
    expect(corrected.point_basis.usd).toBeCloseTo(candidate.point_basis.usd * 1.5, 9);
    expect(corrected.point_basis.credits).toBe(candidate.point_basis.credits);
    expect(after.filter((cycle: any) => cycle.window_start_iso !== candidate.window_start_iso))
      .toEqual(before.filter((cycle: any) => cycle.window_start_iso !== candidate.window_start_iso));
    expect(copy.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { copy.close(); }
});

test("usage-series answers with the established fields from stored windows and their sums", async () => {
  const db = database();
  const ctx = context(db);
  expect((await series(ctx)).status).toBe(202); // No stored sums yet: preparing, never computed here.
  settle(db);
  const { status, body } = await series(ctx);
  expect(status).toBe(200);
  expect(Object.keys(body)).toEqual(["account", "window_minutes", "limit_id", "sample_count", "bucket_minutes", "first_ts", "last_ts",
    "points", "activity", "traffic", "cycles", "latest", "stats", "ownership", "unpriced"]);
  expect(Object.keys(body.cycles[1]).sort()).toEqual(["anchor", "calls", "context_price", "credit_funded", "credits", "delta_calls", "delta_peak_percent",
    "delta_usd", "distinct_steps", "elapsed_hours", "end_percent", "end_ts", "eta_100_iso", "first_percent", "hit_100", "index", "is_active",
    "label", "lag_fraction", "limit_id", "limit_names", "model_usage", "observed_hours", "pace_percent_per_day", "pct_of_prev_peak",
    "pct_of_prev_usd", "peak_percent", "plan_types", "projected_end_percent", "remaining_hours", "reserve", "resets_at_iso", "sample_count",
    "shadow", "source_models", "start_ts", "status", "surface_usage", "tokens", "top_model", "usd", "usd_at_100_percent", "usd_per_percent", "point_basis",
    "window_hours", "window_start_iso", "work_from_ts", "work_to_ts"].sort());
  expect(body.cycles).toHaveLength(3);
  const week = body.cycles[1];
  // The whole cycle of the stored window, with its canonical admission.
  expect(week).toMatchObject({ index: 1, shadow: false, work_from_ts: "2026-09-08T00:00:00.000Z", work_to_ts: "2026-09-15T00:00:00.000Z",
    sample_count: 3, first_percent: 2, peak_percent: 80, calls: 2, tokens: { in: 200_000, cached_in: 40_000, out: 20_000, total: 220_000 },
    top_model: "gpt-6-astra", source_models: [{ model: "gpt-6-astra", calls: 2 }], reserve: { calls: 1, peak_percent: null } });
  expect(week.usd).toBeGreaterThan(0);
  // The credit-funded call is the window's own, beside its counted traffic; the other windows carry none.
  expect(week.credit_funded).toMatchObject({ calls: 1, tokens: 110_000, first: "2026-09-12T03:00:00.000Z" });
  expect(body.cycles[0].credit_funded).toBeUndefined();
  expect(body.cycles.map((cycle: { status: string }) => cycle.status)).toEqual(["closed", "closed", "closed"]);
  // Spark, reserve, credits and the contradicting reset stay outside the cycle's work, explicitly.
  expect(body.stats).toMatchObject({ raw_cycle_count: 3, cycle_count: 3, shadow_cycle_count: 0, total_calls: 5, span_calls: 9, unattributed_calls: 4 });
  expect(body.sample_count).toBe(8);
  expect(body.latest).toMatchObject({ ts: "2026-09-16T00:00:00.000Z", percent: 10, cycle: 2 });
  expect(body.traffic.filter((row: { cycle: number }) => row.cycle === 1).reduce((sum: number, row: { amount: number }) => sum + row.amount, 0))
    .toBe(220_000);
});

test("a range inside a cycle returns the whole cycle, never a clipped part", async () => {
  const db = database();
  settle(db);
  const { body } = await series(context(db), "&since=2026-09-12&until=2026-09-12");
  expect(body.cycles).toHaveLength(1);
  expect(body.cycles[0]).toMatchObject({ work_from_ts: "2026-09-08T00:00:00.000Z", work_to_ts: "2026-09-15T00:00:00.000Z", calls: 2 });
});

test("cycles are read from stored rows: the ledger is not read in the request", async () => {
  const db = database();
  settle(db);
  db.exec("DROP TABLE codex_price_ledger_aggregates; DROP TABLE codex_price_ledger_events");
  const { status, body } = await series(context(db));
  expect(status).toBe(200);
  expect(body.cycles.map((cycle: { calls: number }) => cycle.calls)).toEqual([2, 2, 1]);
});

test("series and roster expose whole-cycle and at-limit stored splits without changing amounts or pricing", async () => {
  const db = database();
  settle(db);
  const ctx = context(db);
  prepareProbeReaderFixture(db, sources, row => row.subject, false);
  const before = (await series(ctx)).body.cycles;
  const stored = db.query("SELECT window_id,cycle,rail,readings FROM window_usage WHERE provider='codex' AND account='codex1' ORDER BY start_ts").all() as
    Array<{ window_id: string; cycle: string; rail: string; readings: string }>;
  for (const row of stored) {
    const cycle = JSON.parse(row.cycle), readings = JSON.parse(row.readings), rail = JSON.parse(row.rail);
    Object.assign(cycle.cycle_usage, { api_normalized: 10, context_api_base: 10, context_api_extra: 5,
      context_priced_tokens: cycle.cycle_usage.priced_tokens });
    Object.assign(cycle.usage, { api_normalized: 10, context_api_base: 10, context_api_extra: 9,
      context_priced_tokens: cycle.usage.priced_tokens });
    const last = readings.at(-1);
    Object.assign(last.usage, { api_normalized: 10, context_api_base: 10, context_api_extra: 2,
      context_priced_tokens: last.usage.priced_tokens });
    rail.at_limit = { ts: last.ts, tokens: last.usage.tokens, api_standard: last.usage.api_standard, api_unpriced: 0,
      credits: 1, credits_unpriced: 0 };
    db.query("UPDATE window_usage SET cycle=?,rail=?,readings=? WHERE window_id=?")
      .run(JSON.stringify(cycle), JSON.stringify(rail), JSON.stringify(readings), row.window_id);
  }
  const changes = db.query("SELECT total_changes() n").get();
  const after = (await series(ctx)).body.cycles;
  expect(after.map((row: any) => [row.usd, row.usd_per_percent, row.usd_at_100_percent]))
    .toEqual(before.map((row: any) => [row.usd, row.usd_per_percent, row.usd_at_100_percent]));
  for (const cycle of after) {
    expect(cycle.context_price).toBeDefined();
    expect(cycle.context_price.extra).toBeCloseTo(cycle.context_price.base * 0.5, 12);
    expect(cycle.at_limit_context_price.extra).toBeCloseTo(cycle.at_limit.api_standard * 0.2, 12);
  }
  const roster = await (await handleRoster(ctx, new URL("http://test/api/roster?window=10080"))).json() as any;
  expect(roster.accounts.find((account: any) => account.id === "codex1").cycles).toEqual(after);
  const fallback = await (await handleWindows(ctx, new URL("http://test/api/windows?account=codex1"))).json() as any;
  expect(fallback.windows.length).toBeGreaterThan(0);
  for (const window of fallback.windows) expect(window.context_price.extra).toBeCloseTo(window.context_price.base * 0.5, 12);
  expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  db.exec("DROP TABLE codex_price_ledger_aggregates; DROP TABLE codex_price_ledger_events");
  expect((await series(ctx)).body.cycles).toEqual(after);
});

test("account cards show the stored cycles of the account, the same as Overview", async () => {
  const db = database();
  settle(db);
  const ctx = context(db);
  // The card list reads the prepared probe index of the declared accounts.
  prepareProbeReaderFixture(db, sources, row => row.subject, false);
  const overview = (await series(ctx)).body;
  const roster = await (await handleRoster(ctx, new URL("http://test/api/roster?window=10080"))).json() as { accounts: Array<{ id: string; cycles: unknown[]; shadow: unknown }> };
  const card = roster.accounts.find(account => account.id === "codex1")!;
  expect(card.shadow).toBeNull();
  expect(card.cycles).toEqual(overview.cycles);
});

test("breakdown totals expose whole and reading-span ratios with identical stored amounts and ledger reads", async () => {
  const db = database();
  settle(db);
  const ctx = context(db);
  prepareProbeReaderFixture(db, sources, row => row.subject, false);
  const window = (await series(ctx)).body.cycles[1];
  const url = (from: string, until: string, inclusive = false) => new URL(`http://test/api/cycle-breakdown?${new URLSearchParams({
    account: "codex1", valuation: "dated", since_ts: from, until_ts: until, anchor: String(window.anchor),
    limit_id: "codex", end_inclusive: String(inclusive),
  })}`);
  const wholeUrl = url(window.work_from_ts, window.work_to_ts);
  const pairedUrl = url(new Date(Date.parse(window.start_ts) + 1).toISOString(), window.end_ts, true);
  const queries: string[] = [], originalQuery = db.query.bind(db);
  const trace = spyOn(db, "query").mockImplementation(((sql: string) => { queries.push(sql); return originalQuery(sql); }) as typeof db.query);
  try {
    const read = async (request: URL) => {
      queries.length = 0;
      const response = handleCycleBreakdown(ctx, request);
      expect(response.status).toBe(200);
      return { body: await response.json() as any, ledger: queries.filter(sql => /\b(events|codex_price_ledger\w*)\b/.test(sql)) };
    };
    const wholeBefore = await read(wholeUrl), pairedBefore = await read(pairedUrl);
    const row = db.query("SELECT window_id,cycle,readings FROM window_usage WHERE start_ts=?").get(window.work_from_ts) as
      { window_id: string; cycle: string; readings: string };
    const cycle = JSON.parse(row.cycle), readings = JSON.parse(row.readings);
    Object.assign(cycle.cycle_usage, { api_normalized: 10, context_api_base: 10, context_api_extra: 5,
      context_priced_tokens: cycle.cycle_usage.priced_tokens });
    for (const reading of readings) Object.assign(reading.usage, { api_normalized: reading.usage.api_standard,
      context_api_base: reading.usage.api_standard, context_api_extra: reading.usage.api_standard * 0.2,
      context_priced_tokens: reading.usage.priced_tokens });
    db.query("UPDATE window_usage SET cycle=?,readings=? WHERE window_id=?")
      .run(JSON.stringify(cycle), JSON.stringify(readings), row.window_id);
    const changes = db.query("SELECT total_changes() n").get();
    const wholeAfter = await read(wholeUrl), pairedAfter = await read(pairedUrl);
    expect(wholeAfter.body.totals.context_price.extra).toBeCloseTo(wholeAfter.body.totals.context_price.base * 0.5, 12);
    expect(pairedAfter.body.totals.context_price.extra).toBeCloseTo(pairedAfter.body.totals.context_price.base * 0.2, 12);
    for (const [before, after] of [[wholeBefore, wholeAfter], [pairedBefore, pairedAfter]] as const) {
      expect(after.body.totals.usd).toBe(before.body.totals.usd);
      expect(after.body.days).toEqual(before.body.days);
      expect(after.body.sessions).toEqual(before.body.sessions);
      expect(after.body.model_detail).toEqual(before.body.model_detail);
      expect(after.ledger).toEqual(before.ledger);
    }
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    const project = new URL(wholeUrl); project.searchParams.set("project_id", "missing");
    expect((await read(project)).body.totals.context_price).toBeUndefined();
  } finally { trace.mockRestore(); }
});

test("an account without stored sums marks itself preparing instead of the whole card list", async () => {
  const db = database();
  const ctx = context(db);
  prepareProbeReaderFixture(db, sources, row => row.subject, false);
  const response = await handleRoster(ctx, new URL("http://test/api/roster?window=10080"));
  expect(response.status).toBe(200);
  const body = await response.json() as { accounts: Array<{ id: string; cycles: unknown[]; preparing?: boolean; empty_reason: string | null }>;
    preparing_accounts?: Array<{ vendor: string; id: string | null }> };
  expect(body.preparing_accounts).toEqual([{ vendor: "codex", id: "codex1" }]);
  // Never presented as an account without samples.
  expect(body.accounts.find(account => account.id === "codex1")).toMatchObject({ cycles: [], preparing: true, empty_reason: null });
  settle(db);
  const ready = await (await handleRoster(ctx, new URL("http://test/api/roster?window=10080"))).json() as Record<string, unknown>;
  expect(ready.preparing_accounts).toBeUndefined();
  expect((ready.accounts as Array<{ id: string; preparing?: boolean }>).find(account => account.id === "codex1")!.preparing).toBeUndefined();
});
