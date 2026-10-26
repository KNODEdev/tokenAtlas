import { expect, spyOn, test } from "bun:test";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { buildProjectCost } from "./project-cost";
import { DATA_VIEWS, serveDataView } from "./data-views";
import { DATA_VERSION_HEADER } from "./data-version";
import { buildEraIndex } from "./eras";
import type { AppContext } from "./api";
import type { Database } from "../db/sqlite";
import { SubscriptionFactsPending } from "../db/subscription-facts";

const PERIOD = { since: "2026-09-13", until: "2026-09-17" };
/** The ledger's stored valuations per source row; repricing would change them. */
const valuations = (db: Database) => db.query(`SELECT row_id,std_key,std_reason,std_nano,std_femto,act_key,act_reason,
  act_nano,act_femto,glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all();

for (const [label, period] of [["bounded", PERIOD], ["all history", {}]] as const) {
  test(`${label} project values survive minute, reset and reopen without repricing`, () => {
    const f = createClaudeCodeAcceptanceFixture();
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-17T12:59:50Z"));
    const rates = structuredClone(f.rates);
    rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 100 }, [ACCOUNTS.b]: { usd_per_month: 200 } };
    const read = () => buildProjectCost(f.db, rates, new Map(), period);
    try {
      const before = read();
      expect(before.totals.tokens).toBeGreaterThan(0);
      const priced = valuations(f.db);
      expect(priced.length).toBeGreaterThan(0);
      for (const now of ["2026-09-17T13:00:01Z", "2026-09-21T01:00:00Z"]) {
        clock.mockReturnValue(Date.parse(now));
        f.reopen();
        expect(read()).toEqual(before);
        expect(valuations(f.db)).toEqual(priced);
      }
    } finally { clock.mockRestore(); f.teardown(); }
  });
}

test("an empty report stays the same across midnight and reopen", () => {
  const f = createClaudeCodeAcceptanceFixture();
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-17T23:59:59Z"));
  try {
    f.db.exec("DELETE FROM claude_events");
    f.prepareFacts();
    const before = buildProjectCost(f.db, f.rates, new Map(), {});
    clock.mockReturnValue(Date.parse("2026-09-18T00:00:01Z"));
    f.reopen();
    const after = buildProjectCost(f.db, f.rates, new Map(), {});
    expect(after).toEqual(before);
    expect(after.totals.tokens).toBe(0);
  } finally { clock.mockRestore(); f.teardown(); }
});

test("share, source and rate changes update their dependent project values", () => {
  const f = createClaudeCodeAcceptanceFixture();
  let rates = structuredClone(f.rates);
  const read = () => buildProjectCost(f.db, rates, new Map(), PERIOD);
  try {
    f.prepareSharedCapacities();
    const before = read();
    const priced = valuations(f.db);
    f.changeShare(15);
    f.prepareSharedCapacities();
    f.reopen();
    const share = read();
    expect(share.totals).toEqual(before.totals);
    expect(share.subjects).not.toEqual(before.subjects);
    // A share-only change reprices nothing.
    expect(valuations(f.db)).toEqual(priced);
    f.db.exec("UPDATE claude_events SET in_uncached=in_uncached+800,out_total=out_total+200 WHERE call_id='between'");
    f.prepareFacts();
    f.prepareSharedCapacities();
    const source = read();
    expect(source.totals.tokens).toBe(before.totals.tokens + 1000);
    // A reloaded card is a new object; until the ledger revalues under it, no stale price is served.
    rates = structuredClone(rates);
    rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.out_total = 30;
    expect(read).toThrow(SubscriptionFactsPending);
    f.prepareFacts(rates);
    f.prepareSharedCapacities(rates);
    const repriced = read();
    expect(repriced.totals.tokens).toBe(source.totals.tokens);
    expect(repriced.totals.api_usd).toBeGreaterThan(source.totals.api_usd);
  } finally { f.teardown(); }
});

test("a project GET is built from stored rows on its request, answers 400 for invalid days, and writes nothing", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  const ctx = { sqlite: f.db, dbPath: f.dbPath, rateCards: f.rates, accounts: { version: 2, subscriptions: [], sources: [] },
    homeToSubId: new Map(), subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
    claudeGauge: {}, grokGauge: {}, cycles: {}, plans: {}, plansCatalog: { provider_groups: [] },
    rootDir: f.directory, attribution: null } as unknown as AppContext;
  const url = new URL("http://local/api/project-cost?since=2026-09-13&until=2026-09-17");
  try {
    expect(DATA_VIEWS["/api/project-cost"]?.direct).toBe(true);
    const changes = f.db.query("SELECT total_changes() n").get();
    const first = await serveDataView(ctx, url);
    expect(first.status).toBe(200);
    expect(first.headers.get(DATA_VERSION_HEADER)).toBeString();
    const before = await first.json();
    expect(before).toEqual(JSON.parse(JSON.stringify(buildProjectCost(f.db, f.rates, new Map(), PERIOD))));
    expect(await (await serveDataView(ctx, url)).json()).toEqual(before);
    expect((await serveDataView(ctx, new URL("http://local/api/project-cost?since=not-a-day"))).status).toBe(400);
    expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { f.teardown(); }
}, 30_000);
