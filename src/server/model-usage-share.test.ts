import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import type { AppContext } from "./api";
import { LIMIT_WINDOW_SCHEMA_SQL } from "../db/limit-windows";
import { WINDOW_USAGE_SCHEMA_SQL } from "../db/window-usage";
import type { ModelUsageShareResponse } from "../shared/model-usage-share";
import { handleModelUsageShare } from "./model-usage-share";
import { DATA_VIEWS } from "./data-views";
import { WINDOW_USAGE_CLOCK } from "./window-usage";

const opened: Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const counter = '["codex","codex",10080]';
const tokens = (n: number) => ({ in_uncached: n, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 0 });
const traffic = (model: string, api: number, excluded: string | null = null) => ({ model, excluded, calls: 1, input: 0, cached: 0,
  cache_write: 0, output: 0, reasoning: 0, api_standard: api, unpriced_tokens: 0 });
function fixture() {
  const db = new Database(":memory:"); opened.push(db);
  db.exec(LIMIT_WINDOW_SCHEMA_SQL); db.exec(WINDOW_USAGE_SCHEMA_SQL);
  db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','a',?,1,'ready')").run(counter);
  const add = (seq: number, start: string, end: string, readings: Array<[string, number]>,
    stored: { by_model: unknown[]; slices: unknown[] } | null, account = "a") => {
    db.query(`INSERT INTO limit_windows VALUES('codex',?,?,?,?,?,?,?,'scheduled',10080,'pro',NULL,0,?,NULL,NULL,NULL,1,'{}')`)
      .run(account, counter, seq, `w${seq}`, start, end, end, JSON.stringify(readings.map(([ts, percent]) => ({ ts, percent, source: "probe" }))));
    if (stored) db.query(`INSERT INTO window_usage VALUES('codex',?,?,?,?,?,'{}',?,'[]',?,NULL)`)
      .run(account, counter, `w${seq}`, start, end, JSON.stringify({ by_model: stored.by_model }), JSON.stringify(stored.slices));
  };
  const ctx = { sqlite: db } as unknown as AppContext;
  const request = async (extra = "", now = Date.parse("2026-10-01T00:00:00Z")) => (await handleModelUsageShare(ctx,
    new URL(`http://local/api/model-usage-share?provider=codex&account=a&since=2026-09-01&until=2026-09-30${extra}`), now).json()) as ModelUsageShareResponse;
  return { add, request };
}
const slice = (model: string, hour: string, n: number) => ({ model, speed: "standard", hour, paired: true, tokens: tokens(n) });

test("a stored-row route follows the window register clock and refuses invalid scopes", () => {
  expect(DATA_VIEWS["/api/model-usage-share"]).toMatchObject({ direct: true, clock: false });
  expect(DATA_VIEWS["/api/model-usage-share"]!.sources).toContain(WINDOW_USAGE_CLOCK);
  for (const query of ["provider=gemini&account=a&since=2026-09-01&until=2026-09-30", "provider=codex&account=all&since=2026-09-01&until=2026-09-30",
    "account=a&since=2026-09-01&until=2026-09-30&project=x"])
    expect(handleModelUsageShare({} as AppContext, new URL(`http://local/api/model-usage-share?${query}`)).status).toBe(400);
});

test("windows divide their meter by stored model values; excluded traffic and other accounts take no part", async () => {
  const f = fixture();
  // Hour 0 reaches 6% with $10 of each model (3 pp each); hour 1 adds 4% of big alone.
  f.add(1, "2026-09-10T00:00:00Z", "2026-09-17T00:00:00Z", [["2026-09-10T00:10:00Z", 2], ["2026-09-10T00:50:00Z", 6], ["2026-09-10T01:30:00Z", 10]],
    { by_model: [traffic("big", 30), traffic("small", 10), traffic("big", 999, "funding")],
      slices: [slice("big", "2026-09-10T00:00:00.000Z", 100), slice("small", "2026-09-10T00:00:00.000Z", 100), slice("big", "2026-09-10T01:00:00.000Z", 200)] });
  f.add(2, "2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z", [["2026-09-17T05:00:00Z", 3]], null);
  f.add(3, "2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z", [["2026-09-17T05:00:00Z", 90]],
    { by_model: [traffic("other", 500)], slices: [slice("other", "2026-09-17T05:00:00.000Z", 1)] }, "b");
  const r = await f.request();
  expect(r.models).toEqual(["big", "small"]);
  expect(r.preparing_windows).toBe(1);
  const [first, second] = r.windows;
  expect(first).toMatchObject({ window_id: "w1", meter: 10, preparing: false, current: false, pct: [7, 3], api_usd: [30, 10], unattributed_pct: 0 });
  expect(second).toMatchObject({ window_id: "w2", meter: 3, preparing: true, pct: [0, 0], unattributed_pct: 3 });
  // Without a requested window the detail is the latest one.
  expect(r.detail!.window_id).toBe("w2");
  const chosen = await f.request("&window=w1");
  expect(chosen.detail!.window_id).toBe("w1");
  expect(chosen.detail!.points.at(-1)).toMatchObject({ t: "2026-09-17T00:00:00.000Z", meter: 10, pct: [7, 3], api_usd: [30, 10] });
});

test("the current window stops at now and is marked current", async () => {
  const f = fixture();
  f.add(1, "2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z", [["2026-09-28T00:30:00Z", 4]],
    { by_model: [traffic("m", 5)], slices: [slice("m", "2026-09-28T00:00:00.000Z", 10)] });
  const r = await f.request("", Date.parse("2026-09-28T02:30:00Z"));
  expect(r.windows[0]).toMatchObject({ current: true, meter: 4, pct: [4] });
  expect(r.detail!.points.map(point => point.t)).toEqual(["2026-09-28T00:00:00.000Z", "2026-09-28T01:00:00.000Z",
    "2026-09-28T02:00:00.000Z", "2026-09-28T02:30:00.000Z"]);
});
