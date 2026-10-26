import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import path from "path";
import { applyDrizzleMigrations } from "../db/migrate";
import { buildEraIndex, type EraDeclaration } from "./eras";
import { claudeIdentitySubscription } from "../ingest/claude-identity";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareProbeReaderFixture as prepareProbes, probeReaderFixtureSource } from "./probe-reader.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { prepareClaudeCardMetadataFixture } from "./claude-card-metadata.fixture";
import {
  createFetchHandler,
  periodEras,
  handleAccountHistory,
  handleAccounts,
  handleClaudeLimit,
  handleRateCards,
  handleRoster,
  handleWindows,
  type AppContext,
} from "./api";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");
/** The probe projection, then what the maintenance worker publishes after it: ledgers and window sums. */
function prepareProbeReaderFixture(sqlite: Database, ...rest: Parameters<typeof prepareProbes> extends [unknown, ...infer R] ? R : never): void {
  prepareProbes(sqlite, ...rest);
  const rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as never;
  fillUsageLedgerFixture(sqlite, rateCards);
  prepareWindowUsageFixture(sqlite, { rateCards, claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
  prepareClaudeCardMetadataFixture(sqlite, ["claude-seat"]);
}
const databases: Database[] = [];
const claudeAccount = "claude-seat";
const subscriptions = [
  probeReaderFixtureSource("claude", claudeAccount),
  probeReaderFixtureSource("glm", "glm"),
  probeReaderFixtureSource("grok", "grok"),
];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

function testContext(): AppContext {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
  prepareProbeReaderFixture(sqlite, subscriptions);
  return {
    sqlite,
    accounts: splitProbeReaderFixtureConfig(subscriptions),
    homeToSubId: new Map(),
    subIdToHomes: new Map(),
    eras: buildEraIndex(periodEras(sqlite,splitProbeReaderFixtureConfig(subscriptions)), "instant"),
    eraErrors: [],
    claudeGauge: { subscription: claudeAccount, vendor: "claude", plan: "max" },
    grokGauge: { subscription: "grok", store: "grok", plan: "xai", window_hours: 168 },
    rateCards: { vendors: {} },
    cycles: { windows: [] },
    plans: { segments: [] },
    plansCatalog: { provider_groups: [] },
    rootDir: path.resolve(import.meta.dir, "../.."),
  } as unknown as AppContext;
}

function seedGrokEvent(sqlite: Database): void {
  sqlite.run(
    `INSERT INTO grok_events (store, session_id, prompt_id, ts, path)
     VALUES ('grok', 'session', 'prompt', '2026-08-01T10:00:00.000Z', 'fixture.jsonl')`
  );
}

function rosterAccounts(ctx: AppContext): Promise<Array<Record<string, unknown>>> {
  return handleRoster(ctx, new URL("http://localhost/api/roster?window=10080"))
    .then((response) => response.json())
    .then((body) => (body as { accounts: Array<Record<string, unknown>> }).accounts);
}

describe("roster has_gauge compatibility metadata", () => {
  it("keeps a newly reset Claude meter while card metadata and usage sums are pending", async () => {
    const ctx = testContext();
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    const reset = new Date(now + 7 * 24 * 3_600_000 - 120_000).toISOString();
    const sessionReset = new Date(now + 4 * 3_600_000).toISOString();
    const insert = ctx.sqlite.query(`INSERT INTO probe_windows
      (provider,subject,ts,kind,reported_percent_side,used_percent,window_minutes,resets_at,ok)
      VALUES('claude',?,?,?,'used',?,?,?,1)`);
    insert.run(claudeAccount, new Date(now - 180_000).toISOString(), "weekly_all", 97, 10080, new Date(now - 120_000).toISOString());
    insert.run(claudeAccount, new Date(now - 90_000).toISOString(), "weekly_all", 0, 10080, reset);
    insert.run(claudeAccount, at, "weekly_all", 1, 10080, reset);
    insert.run(claudeAccount, at, "session", 7, 300, sessionReset);
    prepareProbeReaderFixture(ctx.sqlite, subscriptions);
    ctx.sqlite.query("DELETE FROM window_usage WHERE provider='claude'").run();
    ctx.sqlite.query("INSERT OR IGNORE INTO claude_card_dirty_ranges(account,from_ms,until_ms) VALUES(?,?,NULL)").run(claudeAccount, now - 120_000);
    const before = ctx.sqlite.query("SELECT total_changes() AS n").get();
    for (let restart = 0; restart < 2; restart++) {
      const row = (await rosterAccounts({ ...ctx })).find(row => row.id === claudeAccount)!;
      expect(row.preparing).toBe(true);
      expect(row.claude).toBeNull();
      expect(row.claude_meters).toMatchObject({ weekly: { percent: 1, reset_at: reset, measured_at: at },
        session: { percent: 7, reset_at: sessionReset, measured_at: at } });
    }
    expect(ctx.sqlite.query("SELECT total_changes() AS n").get()).toEqual(before);
  });
  it("excludes the phantom Claude id under the anthropic alias from account lists", async () => {
    const ctx = testContext();
    ctx.accounts = splitProbeReaderFixtureConfig([
      { id: "claude", vendor: "anthropic", home: "C:/fixtures/legacy" },
      { id: "real-anthropic", vendor: "anthropic", home: "C:/fixtures/real" },
    ]);
    ctx.claudeGauge = { subscription: "claude", plan: "Max", observations: [
      { ts: "2026-08-01T10:00:00.000Z", reset_ts: "2026-08-02T00:00:00.000Z", percent: { all: 31 } },
      { ts: "2026-08-02T10:00:00.000Z", reset_ts: "2026-08-03T00:00:00.000Z", percent: { all: 47 } },
    ] };
    ctx.rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {},
      subscriptions: { claude: { usd_per_month: 200 }, "real-anthropic": { usd_per_month: 30 } } } as AppContext["rateCards"];
    const gaugeBefore = JSON.stringify(ctx.claudeGauge);
    const listed = (await handleAccounts(ctx).json()) as { subscriptions: Array<{ id: string }> };
    const roster = await rosterAccounts(ctx);
    const rates = (await handleRateCards(ctx).json()) as { subscriptions: Array<{ id: string }> };
    for (const ids of [listed.subscriptions, roster, rates.subscriptions])
      expect(ids.some(row => row.id === "claude")).toBe(false);
    expect(listed.subscriptions.some(row => row.id === "real-anthropic")).toBe(true);
    expect(rates.subscriptions.some(row => row.id === "real-anthropic")).toBe(true);
    expect(JSON.stringify(ctx.claudeGauge)).toBe(gaugeBefore);
  });
  it("keeps the legacy provider gauge and price without publishing a phantom Claude account", async () => {
    const ctx = testContext();
    ctx.claudeGauge = { subscription: "claude", plan: "max", observations: [
      { ts: "2026-08-01T10:00:00.000Z", reset_ts: "2026-08-02T00:00:00.000Z", percent: { all: 31 } },
    ] };
    ctx.rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {},
      subscriptions: { claude: { usd_per_month: 200 } } } as AppContext["rateCards"];
    const original = JSON.stringify(ctx.claudeGauge);
    const accounts = (await handleAccounts(ctx).json()) as { subscriptions: Array<{ id: string }> };
    const roster = await rosterAccounts(ctx);
    const rates = (await handleRateCards(ctx).json()) as { subscriptions: Array<{ id: string }> };
    expect(accounts.subscriptions.some(row => row.id === "claude")).toBe(false);
    expect(accounts.subscriptions.some(row => row.id === claudeAccount)).toBe(true);
    expect(roster.some(row => row.id === "claude")).toBe(false);
    expect(rates.subscriptions.some(row => row.id === "claude")).toBe(false);
    expect(JSON.stringify(ctx.claudeGauge)).toBe(original);

    ctx.sqlite.query(`INSERT INTO claude_events(store,call_id,ts,path,in_uncached)
      VALUES('fixture','one','2026-08-01T10:00:00.000Z','C:/fixtures/unknown/one.jsonl',12)`).run();
    fillUsageLedger(ctx.sqlite,"claude",ctx.rateCards,ARCHIVE_LOGICAL_ROOT);
    const history = (await handleAccountHistory(ctx, new URL("http://localhost/api/account-history?group=day")).json()) as {
      accounts: Array<{ id: string; tokens: number }>;
    };
    expect(history.accounts.some(row => row.id === "claude")).toBe(false);
    expect(history.accounts.find(row => row.id === "unassigned")?.tokens).toBe(12);

    const sessionId = claudeIdentitySubscription("session-key");
    ctx.sqlite.query(`INSERT INTO claude_events(store,call_id,ts,path,account_key,subscription_id)
      VALUES('fixture','two','2026-08-01T11:00:00.000Z','C:/fixtures/unknown/two.jsonl',?,?)`)
      .run("session-key", sessionId);
    expect(handleClaudeLimit(ctx, new URL(`http://localhost/api/claude-limit?account=${sessionId}`)).status).toBe(200);
  });
  it("reports persisted provider window readings without advertising a Codex gauge series", async () => {
    const ctx = testContext();
    seedGrokEvent(ctx.sqlite);
    const insert = ctx.sqlite.query(
      `INSERT INTO probe_windows
        (provider, subject, ts, kind, reported_percent_side, used_percent, allowance, used,
         window_minutes, resets_at, ok)
       VALUES (?, ?, ?, ?, 'used', ?, ?, ?, ?, ?, 1)`
    );
    insert.run("claude", claudeAccount, "2026-08-01T10:00:00.000Z", "weekly_all", 31, null, null, 10080, "2026-08-02T00:00:00.000Z");
    insert.run("glm", "glm", "2026-08-01T10:00:00.000Z", "weekly", 25, 1000, 250, 10080, "2026-08-02T00:00:00.000Z");
    insert.run("grok", "grok", "2026-08-01T10:00:00.000Z", "monthly", 18, 100, 18, 43200, "2026-08-02T00:00:00.000Z");
    prepareProbeReaderFixture(ctx.sqlite, subscriptions);

    const accounts = await rosterAccounts(ctx);
    const accountRows = (await handleAccounts(ctx).json()) as {
      subscriptions: Array<{ id: string; has_gauge: boolean }>;
    };
    for (const [provider, id] of [["claude", claudeAccount], ["glm", "glm"], ["grok", "grok"]] as const) {
      const account = accounts.find((row) => row.id === id);
      expect(account?.has_gauge).toBe(true);
      expect((account?.capabilities as { hasGaugeSeries: boolean }).hasGaugeSeries).toBe(false);
      expect(accountRows.subscriptions.filter((row) => row.id === id).every((row) => row.has_gauge)).toBe(true);
      const windows = (await handleWindows(
        ctx,
        new URL(`http://localhost/api/windows?account=${id}`)
      ).then((response) => response.json())) as { windows: unknown[] };
      expect(windows.windows.length).toBeGreaterThan(0);
    }
  });

  it("counts physically proven period ownership independently of the stored subject", async () => {
    const ctx = testContext();
    seedGrokEvent(ctx.sqlite);
    const owners = new Map<number, string>();
    for (const [provider, id] of [["claude", claudeAccount], ["glm", "glm"], ["grok", "grok"]] as const) {
      ctx.sqlite.run(
        `INSERT INTO probe_windows
          (provider, subject, ts, kind, reported_percent_side, used_percent, ok, error)
         VALUES (?, ?, '2026-08-01T09:00:00.000Z', 'error', 'used', NULL, 0, 'probe failed')`,
        [provider, id]
      );
      const source = subscriptions.find(row => row.vendor === provider)!;
      const result = ctx.sqlite.run(
        `INSERT INTO probe_windows
          (provider, subject, ts, kind, reported_percent_side, used_percent, ok, machine, profile, extra)
         VALUES (?, 'stale-subject', '2026-08-01T10:00:00.000Z', 'weekly', 'used', 42, 1, ?, ?, ?)`,
        [provider, source.machine, source.login, JSON.stringify({ home: source.source_home })]
      );
      owners.set(Number(result.lastInsertRowid), id);
    }
    prepareProbeReaderFixture(ctx.sqlite, subscriptions, row => owners.get(row.id) ?? null);

    const accounts = await rosterAccounts(ctx);
    const accountRows = (await handleAccounts(ctx).json()) as {
      subscriptions: Array<{ id: string; has_gauge: boolean }>;
    };
    for (const id of [claudeAccount, "glm", "grok"]) {
      expect(accounts.find((row) => row.id === id)?.has_gauge).toBe(true);
      expect(accountRows.subscriptions.filter((row) => row.id === id).every((row) => row.has_gauge)).toBe(true);
    }
  });

  it("answers from stored rows without report preparation; an unchanged data stamp answers the kept body", async () => {
    const ctx = testContext();
    const fetch = createFetchHandler(ctx);
    const first = await fetch(new Request("http://localhost/api/roster"));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("miss");
    expect(first.headers.get("X-Analysis")).toBeNull();
    const firstBody = await first.text();
    expect((JSON.parse(firstBody) as { accounts: Array<{ id: string; has_gauge: boolean }> }).accounts
      .find((row) => row.id === claudeAccount)?.has_gauge).toBe(false);
    const again = await fetch(new Request("http://localhost/api/roster"));
    expect(again.headers.get("X-Cache")).toBe("hit");
    expect(await again.text()).toBe(firstBody);

    // A new reading is visible at once: the data stamp moves, so the kept body is not answered.
    ctx.sqlite.run(
      `INSERT INTO probe_windows
        (provider, subject, ts, kind, reported_percent_side, used_percent, ok)
       VALUES ('claude', 'claude-seat', '2026-08-01T10:00:00.000Z', 'weekly_all', 'used', 42, 1)`
    );
    prepareProbeReaderFixture(ctx.sqlite, subscriptions);
    const refreshed = await fetch(new Request("http://localhost/api/roster"));
    expect(refreshed.headers.get("X-Cache")).toBe("miss");
    const refreshedBody = (await refreshed.json()) as { accounts: Array<{ id: string; has_gauge: boolean }> };
    expect(refreshedBody.accounts.find((row) => row.id === claudeAccount)?.has_gauge).toBe(true);
  });

});
