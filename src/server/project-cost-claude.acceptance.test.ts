import { publishFixtureRules } from "../projects/rules.fixture";
import { expect, test } from "bun:test";
import { buildProjectCost } from "./project-cost";
import { ACCOUNTS, PROJECT, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { createDataRead } from "./data-read";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";
import type { Database } from "../db/sqlite";

/** The ledger's stored valuations per source row; repricing would change them. */
const storedValuations = (db: Database) => new Map((db.query(`SELECT row_id,std_key,std_reason,std_nano,std_femto,
  act_key,act_reason,act_nano,act_femto,glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude'
  ORDER BY row_id`).all() as Array<Record<string, unknown>>).map(row => [row.row_id, JSON.stringify(row)]));

test("project report separates two Claude accounts, Standard equivalents and unknown-account coverage across restart", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const rates = structuredClone(fixture.rates);
  rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.fast = {
    in_uncached: 9, in_cache_read: 0.9, in_cache_write_5m: 11.25, in_cache_write_1h: 18, out_total: 45,
  };
  rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 100 }, [ACCOUNTS.b]: { usd_per_month: 200 } };
  const build = () => buildProjectCost(fixture.db, rates, new Map(), { since: "2026-09-13", until: "2026-09-17" });
  try {
    fixture.db.exec("UPDATE claude_events SET speed='fast' WHERE call_id='between'");
    fixture.db.exec("UPDATE claude_events SET project_id='second-project' WHERE call_id='unknown'");
    fixture.db.exec(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,project_id,in_uncached,out_total)
      VALUES('synthetic','unknown-account','synthetic.jsonl','2026-09-16T18:00:00.000Z','claude-sonnet-fixture','standard','claimed-project',1600,400)`);
    fixture.prepareFacts(rates);
    fixture.prepareSharedCapacities(rates);
    const first = build();
    const project = first.subjects.find(row => row.subject === `p:${PROJECT}`)!;
    // A: 40k Standard tokens cost .216 USD; one 30k call costs .486 Fast instead of .162.
    // B: 900k Standard tokens cost 4.86 USD. The physical 30k copy is excluded.
    expect(project.tokens).toBe(940_000);
    expect(project.calls).toBe(3);
    expect(project.by_sub[ACCOUNTS.a]).toBe(0.54);
    expect(project.by_sub[ACCOUNTS.b]).toBe(4.86);
    // Rule @3 includes the 11k SDK, 13k Desktop and 17k unmarked tokens along with the 70k CLI interval.
    // Standard capacity = .5994 / ((24*12 - 10*12)/10000); the project's Standard numerator remains .216, not .54 Fast.
    expect(first.subscriptions.find(row => row.id === ACCOUNTS.a)!.capacity!.weekly_window_value_usd)
      .toBeCloseTo(0.5994 / 0.0168, 9);
    // Stored weekly ratios are exact, not rounded for display.
    expect(project.subscriptions[ACCOUNTS.a]!.equivalents.weekly_cycles.value).toBeCloseTo(0.216 / (0.5994 / 0.0168), 12);
    expect(project.subscriptions[ACCOUNTS.b]!.equivalents.weekly_cycles.value).toBeCloseTo(0.72, 12);
    expect(first.subscriptions.find(row => row.id === ACCOUNTS.a)!.api_usd).toBe(1.24);
    expect(first.subscriptions.find(row => row.id === ACCOUNTS.b)!.api_usd).toBe(4.86);
    expect(first.subscriptions.some(row => row.id === "claude")).toBe(false);
    expect(first.subjects.find(row => row.subject === "p:second-project")!.tokens).toBe(17_000);
    expect(first.subjects.some(row => row.subject === "p:claimed-project")).toBe(false);
    expect(first.totals.tokens).toBe(1_072_000);
    expect(first.totals.calls).toBe(11);
    expect(first.coverage.unassigned.tokens).toBe(115_000);
    expect(first.coverage.unassigned.api_usd).toBeNull();
    const valuations = storedValuations(fixture.db);
    expect(valuations.size).toBeGreaterThan(0);

    fixture.changeShare(15);
    fixture.prepareSharedCapacities(rates);
    fixture.reopen();
    const second = build();
    const changed = second.subjects.find(row => row.subject === `p:${PROJECT}`)!;
    expect(changed.by_sub).toEqual(project.by_sub);
    // The changed share makes A's capacity .5994 / ((24*15 - 10*12)/10000) = 24.975 USD.
    expect(second.subscriptions.find(row => row.id === ACCOUNTS.a)!.capacity!.weekly_window_value_usd).toBeCloseTo(24.975, 9);
    expect(changed.subscriptions[ACCOUNTS.a]!.equivalents.weekly_cycles.value).toBeCloseTo(0.216 / 24.975, 12);
    expect(changed.subscriptions[ACCOUNTS.b]!.equivalents).toEqual(project.subscriptions[ACCOUNTS.b]!.equivalents);
    expect(storedValuations(fixture.db)).toEqual(valuations);
  } finally {
    fixture.teardown();
  }
});

test("project HTTP read covers both account scopes and answers the same after reopening", async () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const ctx = {
    sqlite: fixture.db, dbPath: fixture.dbPath, rateCards: fixture.rates, accounts: { version: 2, subscriptions: [], sources: [] },
    homeToSubId: new Map(), subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
    claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {}, plansCatalog: { provider_groups: [] },
    rootDir: fixture.directory, attribution: null,
  } as unknown as AppContext;
  let reader = createDataRead();
  // The analysis worker reads projects.json.
  const restoreRules = publishFixtureRules(fixture.db);
  const url = "http://local/api/project-cost?since=2026-09-13&until=2026-09-17";
  try {
    expect((await reader(ctx, new Request(url))).status).toBe(202);
    await reader.whenIdle();
    const before = fixture.db.query("SELECT total_changes() n").get();
    const ready = await reader(ctx, new Request(url));
    expect(ready.status, await ready.clone().text()).toBe(200);
    expect(ready.headers.get("X-Analysis")).toBe("memory");
    expect(fixture.db.query("SELECT total_changes() n").get()).toEqual(before);
    const report = await ready.json();
    expect(report.subjects.find((row: { subject: string }) => row.subject === `p:${PROJECT}`).tokens).toBe(940_000);
    expect(report.subscriptions.map((row: { id: string }) => row.id).sort()).toEqual([ACCOUNTS.a, ACCOUNTS.b]);
    await reader.close();
    ctx.sqlite = fixture.reopen();
    reader = createDataRead();
    // A restart keeps no answers; the stored rows give the same one again.
    expect((await reader(ctx, new Request(url))).status).toBe(202);
    await reader.whenIdle();
    const reopened = await reader(ctx, new Request(url));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual(report);
  } finally {
    await reader.close();
    restoreRules();
    fixture.teardown();
  }
}, 30000);

test("an unpriced call prevents a complete allocation of that account's subscription bill", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const rates = structuredClone(fixture.rates);
  rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 100 }, [ACCOUNTS.b]: { usd_per_month: 200 } };
  try {
    // A model without a rate (a record without a mode is Standard, so it would be priced).
    fixture.db.exec("UPDATE claude_events SET model='claude-unrated' WHERE call_id='between'");
    fixture.prepareFacts();
    const report = buildProjectCost(fixture.db, rates, new Map(), { since: "2026-09-13", until: "2026-09-17" });
    const project = report.subjects.find(row => row.subject === `p:${PROJECT}`)!;
    // One 30k-token event is unpriced. Its missing share cannot be allocated to priced traffic.
    expect(report.coverage.unpriced.tokens).toBe(30_000);
    expect(report.coverage.unpriced.calls).toBe(1);
    expect(project.subscriptions[ACCOUNTS.a]!.billed_usd).toBeNull();
    expect(project.billed_complete).toBe(false);
    expect(report.coverage.unassigned.billed_usd).toBeNull();
    expect(project.subscriptions[ACCOUNTS.b]!.billed_usd).toBeGreaterThan(0);
    expect(report.totals.tokens).toBe(1_070_000);
    expect(report.totals.calls).toBe(10);
  } finally {
    fixture.teardown();
  }
});

test("project account discovery selects UTC days even when the only source rows use adjacent local dates", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const insert = fixture.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,project_id,
      subscription_id,in_uncached,out_total) VALUES('synthetic',?,'synthetic.jsonl',?,'claude-sonnet-fixture',
      'standard','offset-project',?,?,?)`);
    insert.run("offset-positive", "2026-09-18T00:30:00+02:00", "claude-offset", 4000, 1000);
    insert.run("offset-negative", "2026-09-16T23:30:00-02:00", "claude-offset", 5600, 1400);
    insert.run("offset-unverified", "2026-09-18T00:30:00+02:00", null, 1600, 400);
    fixture.prepareFacts();
    const report = buildProjectCost(fixture.db, fixture.rates, new Map(), { since: "2026-09-17", until: "2026-09-17" });
    const project = report.subjects.find(row => row.subject === "p:offset-project")!;
    expect(project.tokens).toBe(12_000);
    expect(project.calls).toBe(2);
    expect(project.by_sub["claude-offset"]).toBe(0.06);
    expect(report.totals.tokens).toBe(63_000);
    expect(report.coverage.unassigned.tokens).toBe(51_000);
    expect(report.coverage.unassigned.api_usd).toBeNull();
  } finally {
    fixture.teardown();
  }
});

test("a corrected account, date and project matches a fresh report", () => {
  const incremental = createClaudeCodeAcceptanceFixture();
  const fresh = createClaudeCodeAcceptanceFixture();
  const build = (fixture: typeof incremental) => buildProjectCost(
    fixture.db, fixture.rates, new Map(), { since: "2026-09-13", until: "2026-09-17" },
  );
  const correct = (fixture: typeof incremental) => {
    fixture.db.query("UPDATE claude_events SET project_id='moved-project',ts='2026-09-18T12:00:00.000Z',subscription_id=? WHERE call_id='between'")
      .run(ACCOUNTS.b);
    fixture.prepareFacts();
  };
  try {
    build(incremental);
    correct(incremental);
    correct(fresh);
    incremental.reopen();
    const changed = build(incremental);
    const reference = build(fresh);
    expect(changed).toEqual(reference);
    expect(changed.subjects.find(row => row.subject === `p:${PROJECT}`)!.tokens).toBe(910_000);
    expect(changed.subjects.some(row => row.subject === "p:moved-project")).toBe(false);
  } finally {
    incremental.teardown();
    fresh.teardown();
  }
});

test("report totals round the complete amount once, rather than summing rounded project amounts", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    fixture.db.exec("DELETE FROM claude_events");
    const insert = fixture.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,project_id,
      subscription_id,in_uncached,out_total) VALUES('synthetic',?,'synthetic.jsonl',
      '2026-09-16T12:00:00.000Z','claude-sonnet-fixture','standard',?,?,800,200)`);
    for (let i = 0; i < 5; i++) insert.run(`small-${i}`, `small-project-${i}`, ACCOUNTS.a);
    fixture.prepareFacts();
    const report = buildProjectCost(fixture.db, fixture.rates, new Map(), { since: "2026-09-13", until: "2026-09-17" });
    // Each project costs .0054, so five cost .027, displayed as .03 (not .05).
    expect(report.subjects.map(row => row.api_usd)).toEqual([0.01, 0.01, 0.01, 0.01, 0.01]);
    expect(report.subscriptions[0]!.api_usd).toBe(0.03);
    expect(report.totals.api_usd).toBe(0.03);
  } finally {
    fixture.teardown();
  }
});

test("individually safe account token sums cannot produce an unsafe combined report", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    fixture.db.exec("DELETE FROM claude_events");
    const insert = fixture.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,project_id,
      subscription_id,in_uncached) VALUES('synthetic',?,'synthetic.jsonl',
      '2026-09-16T12:00:00.000Z','claude-sonnet-fixture','standard','huge-project',?,?)`);
    for (const account of Object.values(ACCOUNTS)) insert.run(`huge-${account}`, account, 2 ** 52);
    fixture.prepareFacts();
    expect(() => buildProjectCost(fixture.db, fixture.rates, new Map(), {
      since: "2026-09-13", until: "2026-09-17",
    })).toThrow(/Unsafe.*token/i);
  } finally {
    fixture.teardown();
  }
});

for (const tokens of [0, 2 ** 52]) {
  test(`a duplicated ${tokens}-token event keeps its canonical call and account slice`, () => {
    const fixture = createClaudeCodeAcceptanceFixture();
    const rates = { ...fixture.rates, subscriptions: { [ACCOUNTS.a]: { usd_per_month: 100 } } };
    try {
      fixture.db.exec("DELETE FROM claude_events");
      const insert = fixture.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,project_id,
        subscription_id,in_uncached) VALUES(?,'duplicated','synthetic.jsonl',
        '2026-09-16T12:00:00.000Z','claude-sonnet-fixture','standard','canonical-project',?,?)`);
      for (const store of ["primary", "copy"]) insert.run(store, ACCOUNTS.a, tokens);
      fixture.prepareFacts();
      const report = buildProjectCost(fixture.db, rates, new Map(), { since: "2026-09-13", until: "2026-09-17" });
      const project = report.subjects.find(row => row.subject === "p:canonical-project")!;
      expect(report.totals.tokens).toBe(tokens);
      expect(report.totals.calls).toBe(1);
      expect(project.subscriptions[ACCOUNTS.a]!.tokens).toBe(tokens);
      expect(project.subscriptions[ACCOUNTS.a]!.calls).toBe(1);
    } finally {
      fixture.teardown();
    }
  });
}
