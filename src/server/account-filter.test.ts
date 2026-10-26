import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { handleActivity, handleEvents, handleModelSpeed, type AppContext } from "./api";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { buildAccountResolver } from "./account-resolver";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";

// No prices: the tests read accounts and tokens, and unpriced rows stay listed.
const RATES = { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {} };

function fixture(): AppContext {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,surface TEXT,project_id TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,billing_mode TEXT,resp_ms INTEGER);
    INSERT INTO events VALUES
      ('C:/source','a','2026-06-02T10:15:00Z','test','cli','p1',100,40,0,10,0,'allowance',1000),
      ('C:/source','a','2026-06-02T10:45:00Z','test','cli','p2',200,0,0,20,0,'allowance',2000),
      ('C:/source','a','2026-06-03T08:00:00Z','test','cli','p1',300,0,0,30,0,'business_credits',500),
      ('C:/other','b','2026-06-02T10:30:00Z','test','cli','p1',900,0,0,90,0,'allowance',NULL);`);
  const subscriptions = [{ id: "main", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/source`, source_home: "C:/source" },
    { id: "other", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/other`, source_home: "C:/other" }];
  declareCodexEraPeriods(sqlite, subscriptions);
  const ctx = { sqlite, accounts: splitProbeReaderFixtureConfig(subscriptions), subIdToHomes: new Map([["main", ["C:/source"]]]),
    homeToSubId: new Map([["c:/source", "main"], ["c:/other", "other"]]), rateCards: RATES } as unknown as AppContext;
  // Activity reads the Codex ledger, which the background writer keeps; the account comes from the periods at read time.
  prepareCodexLedgerFixture(sqlite, ctx.rateCards, ctx.homeToSubId, ctx.accounts.sources);
  return ctx;
}

type Activity = {
  account?: string;
  vendor: string;
  totals: { calls: number; tokens: number; tokens_fresh: number };
  cells: Array<{ dow: number; hour: number; calls: number; tokens: number }>;
  burn: { anchor_ts: string | null; windows: Array<{ label: string; calls: number; tokens: number }> };
};
const read = async (ctx: AppContext, query: string) => {
  const response = handleActivity(ctx, new URL(`http://local/api/activity?${query}`));
  return { status: response.status, body: await response.json() as Activity & { error?: string } };
};

test("an account's activity holds only the events its periods own, without its business pool", async () => {
  const ctx = fixture();
  try {
    const { status, body } = await read(ctx, "vendor=both&account=main");
    expect(status).toBe(200);
    expect(body.account).toBe("main");
    expect(body.vendor).toBe("codex");
    // Gross is input + output; fresh subtracts cached input, per event, as the hourly rollups do.
    expect(body.totals).toEqual({ calls: 2, tokens: 330, tokens_fresh: 290 });
    expect(body.cells.reduce((sum, cell) => sum + cell.calls, 0)).toBe(2);
    // The two events share one local hour, so one cell carries both.
    expect(body.cells).toHaveLength(1);
    expect(body.burn.anchor_ts).toBe("2026-06-02T10:45:00Z");
    expect(body.burn.windows.find((w) => w.label === "1h")).toMatchObject({ calls: 2, tokens: 330 });

    const pool = await read(ctx, "account=main::business");
    expect(pool.body.totals).toEqual({ calls: 1, tokens: 330, tokens_fresh: 330 });
    const other = await read(ctx, "account=other");
    expect(other.body.totals.tokens).toBe(990);
  } finally {
    ctx.sqlite.close();
  }
});

test("the project filter narrows the account's activity", async () => {
  const ctx = fixture();
  try {
    const { body } = await read(ctx, "account=main&project_id=p2");
    expect(body.totals).toEqual({ calls: 1, tokens: 220, tokens_fresh: 220 });
  } finally {
    ctx.sqlite.close();
  }
});

test("a period change moves the activity without touching the events", async () => {
  const ctx = fixture();
  try {
    declareCodexEraPeriods(ctx.sqlite, [
      { id: "main", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/source`, source_home: "C:/source", until: "2026-06-02T10:30:00Z" },
      { id: "other", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/source`, source_home: "C:/source", from: "2026-06-02T10:30:00Z" },
      { id: "other", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/other`, source_home: "C:/other" },
    ], { replace: true });
    expect((await read(ctx, "account=main")).body.totals.calls).toBe(1);
    expect((await read(ctx, "account=other")).body.totals.calls).toBe(2);
  } finally {
    ctx.sqlite.close();
  }
});

test("a conversation moved into archived sessions counts once, as in the breakdown", async () => {
  const ctx = fixture();
  try {
    const file = "rollout-2026-06-02T10-15-00-01900000-0000-7000-8000-000000000001.jsonl";
    const active = `C:/source/sessions/2026/06/02/${file}`;
    // Both copies hold the same records at the same byte offsets (the archive keeps the moved file).
    if (!(ctx.sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(column => column.name === "source_offset"))
      ctx.sqlite.exec("ALTER TABLE events ADD COLUMN source_offset INTEGER");
    ctx.sqlite.query("UPDATE events SET path=?,source_offset=CAST(strftime('%s',ts) AS INTEGER) WHERE path='a'").run(active);
    ctx.sqlite.query("UPDATE events SET source_offset=0 WHERE path='b'").run();
    ctx.sqlite.query(`INSERT INTO events(home,path,ts,model,surface,project_id,in_tok,cached_in,cache_write,out_tok,reasoning_out,billing_mode,source_offset)
      SELECT home,?,ts,model,surface,project_id,in_tok,cached_in,cache_write,
      out_tok,reasoning_out,billing_mode,source_offset FROM events WHERE path=?`).run(`C:/source/archived_sessions/${file}`, active);
    prepareCodexLedgerFixture(ctx.sqlite, ctx.rateCards, ctx.homeToSubId, ctx.accounts.sources);
    expect((await read(ctx, "account=main")).body.totals.calls).toBe(2);
    // While the copies are resolved again, the raw reader counts the copies last resolved as canonical:
    // the moved file still counts once (golden rules §9).
    ctx.sqlite.query("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','identity',?)").run(`codex/source|${file}`);
    expect((await read(ctx, "account=main")).body.totals.calls).toBe(2);
  } finally {
    ctx.sqlite.close();
  }
});

function claudeFixture(): AppContext {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE claude_events(id INTEGER PRIMARY KEY, store TEXT, call_id TEXT, path TEXT, ts TEXT, model TEXT, entrypoint TEXT, project TEXT,
    project_id TEXT, speed TEXT, account_key TEXT, subscription_id TEXT, subscription_conflict INTEGER NOT NULL DEFAULT 0,
    in_uncached INTEGER, in_cache_read INTEGER, in_cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
    out_total INTEGER, out_thinking INTEGER)`);
  installFactDayRevisions(sqlite);
  const insert = sqlite.query(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached,in_cache_read,in_cache_write,out_total)
    VALUES (?,?,?,?,?,?,?,?)`);
  const main = `${ARCHIVE_LOGICAL_ROOT}/claude/MAIN/p/a.jsonl`;
  insert.run("live", "c1", main, "2026-06-02T10:00:00.000Z", 10, 100, 5, 20);
  insert.run("desktop", "c1", main, "2026-06-02T10:00:00.000Z", 10, 100, 5, 20);
  insert.run("live", "c2", main, "2026-06-10T10:00:00.000Z", 1, 0, 0, 2);
  insert.run("live", null, main, "2026-06-02T11:00:00.000Z", 3, 0, 0, 4);
  const period = (value: string, from: string, until: string | null) => ({ provider: "claude", subject: "claude/main", from, until,
    value, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  // Activity reads the usage ledger, which the background writer keeps.
  fillUsageLedgerFixture(sqlite, RATES as never, ["claude"]);
  return { sqlite, accounts: { subscriptions: [{ id: "acct-a", vendor: "claude", home: "" }, { id: "acct-b", vendor: "claude", home: "" }], sources: [] },
    resolver: buildAccountResolver([period("acct-a", "2026-01-01", "2026-06-05"), period("acct-b", "2026-06-05", null)], []),
    subIdToHomes: new Map(), homeToSubId: new Map(), rateCards: RATES } as unknown as AppContext;
}

test("a Claude account's activity follows its periods and counts a copied call once", async () => {
  const ctx = claudeFixture();
  try {
    const a = await read(ctx, "account=acct-a");
    expect(a.status).toBe(200);
    expect(a.body.vendor).toBe("claude");
    // c1 once (gross 135, fresh 30) and the call without an id (gross 7, fresh 7).
    expect(a.body.totals).toEqual({ calls: 2, tokens: 142, tokens_fresh: 37 });
    expect((await read(ctx, "account=acct-b")).body.totals).toEqual({ calls: 1, tokens: 3, tokens_fresh: 3 });
  } finally {
    ctx.sqlite.close();
  }
});

test("an unknown account or a contradicting vendor is refused", async () => {
  const ctx = fixture();
  try {
    expect((await read(ctx, "account=nobody")).status).toBe(400);
    const contradiction = await read(ctx, "vendor=claude&account=main");
    expect(contradiction.status).toBe(400);
    expect(contradiction.body.error).toContain("contradicts");
    const events = handleEvents(ctx, new URL("http://local/api/events?vendor=grok&account=main"));
    expect(events.status).toBe(400);
  } finally {
    ctx.sqlite.close();
  }
});

type Events = { vendor: string; account: string | null; rows: Array<{ ts: string; vendor: string; account: string | null; tokens: number }> };
const events = async (ctx: AppContext, query: string) =>
  await handleEvents(ctx, new URL(`http://local/api/events?${query}`)).json() as Events;

test("every Codex event names its account, and the account filter lists only that account's events", async () => {
  // The fixture's events carry a project column (rules.fixture.ts adds it for their projects).
  const ctx = fixture();
  prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,ctx.homeToSubId,ctx.accounts.sources);
  try {
    const all = await events(ctx, "vendor=codex&order=ts_asc");
    expect(all.rows.map((row) => row.account)).toEqual(["main", "other", "main", "main::business"]);
    const main = await events(ctx, "account=main");
    expect(main.vendor).toBe("codex");
    expect(main.account).toBe("main");
    expect(main.rows.map((row) => row.ts)).toEqual(["2026-06-02T10:45:00Z", "2026-06-02T10:15:00Z"]);
    const pool = await events(ctx, "vendor=both&account=main::business");
    expect(pool.rows.map((row) => row.tokens)).toEqual([330]);
    const dated = await events(ctx, "account=main&since=2026-06-03&until=2026-06-03");
    expect(dated.rows).toEqual([]);
  } finally {
    ctx.sqlite.close();
  }
});

test("every Claude event names its account, and the filter follows the periods", async () => {
  const ctx = claudeFixture();
  try {
    const all = await events(ctx, "vendor=claude&order=ts_asc");
    expect(all.rows.map((row) => row.account)).toEqual(["acct-a", "acct-a", "acct-a", "acct-b"]);
    const b = await events(ctx, "account=acct-b");
    expect(b.rows.map((row) => row.ts)).toEqual(["2026-06-10T10:00:00.000Z"]);
  } finally {
    ctx.sqlite.close();
  }
});

test("model speed of a Codex account sums the timed calls its periods own, per model and hour", async () => {
  const ctx = fixture();
  try {
    const read = async (query: string) => { const response = handleModelSpeed(ctx, new URL(`http://local/api/model-speed?${query}`));
      return { status: response.status, body: await response.json() as { provider: string; models: Array<{ model: string;
        total: Record<string, number | null>; points: Array<{ at: string }> }> } }; };
    const main = await read("account=main&grain=hour");
    expect(main.status).toBe(200);
    expect(main.body.provider).toBe("codex");
    expect(main.body.models.map(model => model.model)).toEqual(["test"]);
    // The two allowance calls of its source; the business pool and the other source are not this account's.
    expect(main.body.models[0]!.total).toMatchObject({ calls: 2, timed_calls: 2, timed_out: 30, timed_ms: 3000, speed: 10,
      long_calls: 0, long_speed: null, coverage: 1 });
    expect(main.body.models[0]!.points.map(point => point.at)).toEqual(["2026-06-02T10:00:00.000Z"]);
    // Another account's call without a time: counted, not timed.
    const other = await read("account=other");
    expect(other.body.models[0]!.total).toMatchObject({ calls: 1, timed_calls: 0, speed: null, coverage: 0 });
  } finally { ctx.sqlite.close(); }
});

test("model speed of a Codex account splits an hour a period boundary cuts, and reads its business pool apart", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,surface TEXT,project_id TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,billing_mode TEXT,resp_ms INTEGER);
    INSERT INTO events VALUES
      ('C:/source','a','2026-06-02T10:15:00Z','test','cli','p1',100,0,0,10,0,'allowance',1000),
      ('C:/source','a','2026-06-02T10:45:00Z','test','cli','p1',200,0,0,300,0,'allowance',2000),
      ('C:/source','a','2026-06-02T10:50:00Z','test','cli','p1',300,0,0,30,0,'business_credits',500);`);
  // One archive source, signed in to "main" until 10:30 and to "later" from then on.
  const home = `${ARCHIVE_LOGICAL_ROOT}/codex/source`;
  const subscriptions = [{ id: "main", vendor: "codex", home, source_home: "C:/source", until: "2026-06-02T10:30:00.000Z" },
    { id: "later", vendor: "codex", home, source_home: "C:/source", from: "2026-06-02T10:30:00.000Z" }];
  declareCodexEraPeriods(sqlite, subscriptions);
  const ctx = { sqlite, accounts: splitProbeReaderFixtureConfig(subscriptions), subIdToHomes: new Map([["main", ["C:/source"]]]),
    homeToSubId: new Map([["c:/source", "main"]]), rateCards: RATES } as unknown as AppContext;
  prepareCodexLedgerFixture(sqlite, ctx.rateCards, ctx.homeToSubId, ctx.accounts.sources);
  try {
    const read = async (account: string) => (await handleModelSpeed(ctx, new URL(`http://local/api/model-speed?account=${account}&grain=hour`))
      .json()) as { models: Array<{ total: Record<string, number | null>; points: Array<{ at: string }> }> };
    expect((await read("main")).models.map(model => model.total)).toEqual([expect.objectContaining({ calls: 1, timed_out: 10, timed_ms: 1000 })]);
    const later = (await read("later")).models;
    expect(later.map(model => model.total)).toEqual([expect.objectContaining({ calls: 1, timed_out: 300, timed_ms: 2000, long_calls: 1 })]);
    expect(later[0]!.points.map(point => point.at)).toEqual(["2026-06-02T10:00:00.000Z"]);
    expect((await read("later::business")).models.map(model => model.total)).toEqual([expect.objectContaining({ calls: 1, timed_ms: 500 })]);
    // Speed's "All" reads every account and pool apart: together they hold each of the three calls exactly once.
    const scopes = await Promise.all(["main", "main::business", "later", "later::business"].map(async account => {
      const response = handleModelSpeed(ctx, new URL(`http://local/api/model-speed?account=${account}`));
      return response.status === 200 ? ((await response.json()) as { models: Array<{ total: { calls: number } }> }).models : [];
    }));
    expect(scopes.flat().reduce((sum, model) => sum + model.total.calls, 0)).toBe(3);
  } finally { sqlite.close(); }
});

// IA-2026-10-19 v1.1, T-10: exact bounds are [from_ts, until_ts), whatever precision a row's timestamp has.
test("exact event bounds include the start instant, exclude the end and never mix with whole-day dates", async () => {
  const ctx = fixture();
  try {
    const first = await events(ctx, "account=main&order=ts_asc&from_ts=2026-06-02T10:15:00.000Z&until_ts=2026-06-02T10:45:00.000Z");
    expect(first.rows.map((row) => row.ts)).toEqual(["2026-06-02T10:15:00Z"]);
    const shifted = await events(ctx, "account=main&order=ts_asc&from_ts=2026-06-02T10:15:00.001Z&until_ts=2026-06-02T10:45:00.001Z");
    expect(shifted.rows.map((row) => row.ts)).toEqual(["2026-06-02T10:45:00Z"]);
    const vendor = await events(ctx, "vendor=codex&order=ts_asc&from_ts=2026-06-02T10:15:00Z&until_ts=2026-06-02T10:45:00Z");
    expect(vendor.rows.map((row) => [row.ts, row.account])).toEqual([["2026-06-02T10:15:00Z", "main"], ["2026-06-02T10:30:00Z", "other"]]);
    const open = await events(ctx, "account=main&order=ts_asc&from_ts=2026-06-02T10:30:00Z") as Events & { from_ts: string | null; until_ts: string | null };
    expect(open.rows.map((row) => row.ts)).toEqual(["2026-06-02T10:45:00Z"]);
    expect([open.from_ts, open.until_ts]).toEqual(["2026-06-02T10:30:00.000Z", null]);
    for (const query of ["since=2026-06-02&from_ts=2026-06-02T10:00:00Z", "from_ts=2026-06-02T11:00:00Z&until_ts=2026-06-02T10:00:00Z", "from_ts=2026-06-02"]) {
      expect(handleEvents(ctx, new URL(`http://local/api/events?vendor=codex&${query}`)).status).toBe(400);
    }
  } finally {
    ctx.sqlite.close();
  }
});
