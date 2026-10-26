import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { codexCallsScene, card, openedDatabases } from "./codex-window-calls.fixture";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { readCodexWindowDetail } from "./codex-window-detail";
import { handleModelCacheHistory, modelCacheRequest, readModelCacheHistory } from "./model-cache-history";
import { WINDOW_SCREENS } from "./window-screens";
import { storedAnswerConfiguration } from "./data-read";
import type { AppContext } from "./api";

afterEach(() => { for (const db of openedDatabases.splice(0)) db.close(); });

function scene() {
  const { db, base } = codexCallsScene();
  const accounts = { version: 2 as const, sources: subscriptionDeclarations(base.homeToSubId!), subscriptions:
    ["acct", "before", "other"].map(id => ({ id, vendor: "codex" })) };
  return { db, base, ctx: { sqlite: db, rateCards: card, accounts } };
}
const request = (model = "gpt-6-astra", account = "acct") => ({ account, model, since: "2026-09-10", until: "2026-09-13" });
const totals = (rows: Array<{ input: number; cached: number }>) => rows.reduce((sum, row) =>
  ({ input: sum.input + row.input, cached: sum.cached + row.cached }), { input: 0, cached: 0 });

test("long cache history uses the selected account/model's canonical valid counters, including unpriced traffic", () => {
  const { db, base, ctx } = scene();
  for (const account of ["acct", "before", "other"]) for (const model of ["gpt-6-astra", "not-shipped-model", "codex-auto-review"]) {
    const selected = request(model, account);
    const actual = readModelCacheHistory(ctx, selected);
    const reference = readCodexWindowDetail(db, card, { ...base, account, from: "2026-09-10T00:00:00Z", until: "2026-09-14T00:00:00Z", filterCounter: false, includeBurn: false });
    expect(totals(actual.hours)).toEqual(totals(reference.detail.rows.filter(row => row.model === model)));
    expect(actual.hours.every(point => point.model === model && point.hour.endsWith("T00:00:00.000Z"))).toBe(true);
    expect(actual).toMatchObject({ account, model, grain: "day", from: "2026-09-10T00:00:00.000Z", until: "2026-09-14T00:00:00.000Z" });
  }
});

test("All discovers the selected model's full stored span and a readonly reopen returns identical counters", () => {
  const { db, ctx } = scene();
  const selected = { ...request(), since: undefined };
  const expected = readModelCacheHistory(ctx, selected);
  expect(expected.hours.length).toBeGreaterThan(0);
  expect(expected.from).toBe(expected.hours[0]!.hour);
  const reopened = Database.deserialize(db.serialize(), { readonly: true });
  try {
    const changes = () => (reopened.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    expect(readModelCacheHistory({ ...ctx, sqlite: reopened }, selected)).toEqual(expected);
    expect(changes()).toBe(before);
  } finally { reopened.close(); }
  expect(readModelCacheHistory(ctx, request("absent-model")).hours).toEqual([]);
});

test("every model of an account in one read equals the per-model reads", () => {
  const { ctx } = scene();
  const all = readModelCacheHistory(ctx, request("*"));
  expect(all.model).toBe("*");
  const models = [...new Set(all.hours.map(point => point.model))];
  expect(models.length).toBeGreaterThan(1);
  for (const model of models) expect(totals(all.hours.filter(point => point.model === model))).toEqual(totals(readModelCacheHistory(ctx, request(model)).hours));
  expect(totals(all.hours)).toEqual(totals(models.flatMap(model => readModelCacheHistory(ctx, request(model)).hours)));
});

test("the cache request rejects missing scope and invalid dates; stored scope preserves the business pool", () => {
  const { ctx } = scene();
  for (const query of ["", "account=all&model=a&until=2026-10-17", "account=a&model=m&since=2026-10-18&until=2026-10-17", "account=a&model=m&until=2026-02-30"])
    expect(handleModelCacheHistory(ctx, new URL(`http://local/api/model-cache-history?${query}`)).status).toBe(400);
  const url = new URL("http://local/api/model-cache-history?account=acct::business&model=m&until=2026-10-17");
  expect(modelCacheRequest(url).account).toBe("acct::business");
  expect(WINDOW_SCREENS[url.pathname]!.scope(url, ctx as AppContext)).toMatchObject({ provider: "codex", account: "acct::business", untilMs: Date.parse("2026-10-18") });
  const configuration = { ...ctx, subIdToHomes: new Map(), accounts: { ...ctx.accounts, sources: [] } } as unknown as AppContext;
  expect(storedAnswerConfiguration(configuration, url)).toBe(storedAnswerConfiguration({ ...configuration,
    rateCards: { ...card, currency: "other" } }, url));
});
