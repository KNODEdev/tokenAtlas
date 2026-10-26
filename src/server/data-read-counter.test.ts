import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../db/probe-facts";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { createTestDatabase } from "../sync/test-support";
import { buildEraIndex } from "./eras";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { readPreparedProbeAccountRange } from "./current/probe-account-reader";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { AppContext } from "./api";
import { handleSubscriptionAccounting } from "./subscription-accounting";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";

test("an unavailable selected counter answers 400 until a reading of it is stored", async () => {
  const { directory, dbPath } = createTestDatabase();
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode=WAL");
  const source = `claude/fixture-machine-fixture`;
  const home = `${ARCHIVE_LOGICAL_ROOT}/${source}`;
  const sourceHome = `${directory}/claude-profile`;
  const subscriptions = [{ id: "claude1", vendor: "claude" }];
  const sources = [{ vendor: "claude", machine: "fixture-machine", login: "fixture", home, source_home: sourceHome }];
  const config = { subscriptions, sources };
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [{ provider: "claude", subject: source, value: "claude1",
    from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
    readings: 0, evidence: "fixture" }]);
  const settleProjection = () => {
    const at = "2026-08-12T12:00:00.000Z";
    for (let step = 0; step < 100; step++)
      if (!publishCurrentBatch(sqlite, currentRegistry(subscriptions, at), at, 512, config)) {
        // The maintenance worker publishes limit windows after the projection.
        prepareLimitWindowsFixture(sqlite, { sources: sources as never, subscriptions });
        // ...and the window sums after the windows.
        prepareWindowUsageFixture(sqlite, { rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, subscriptions,
          claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
        return;
      }
    throw new Error("Current projection did not settle");
  };
  settleProjection();
  // The usage ledger the report reads is filled by its background producer.
  fillUsageLedgerFixture(sqlite, { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, ["claude"]);
  const ctx = { sqlite, dbPath, accounts: { version: 2, ...config }, homeToSubId: new Map(),
    subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
    rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, claudeGauge: {}, grokGauge: {},
    cycles: {}, plans: {}, plansCatalog: { provider_groups: [] }, rootDir: directory } as unknown as AppContext;
  const selected = '["weekly_all","",10080]';
  const base = "http://local/api/subscription-accounting?provider=claude&account=claude1&since=2026-08-10&until=2026-08-16";
  const invalid = `${base}&counter=${encodeURIComponent(selected)}`;
  // The report is read from stored rows on each request (plan U4.4): the answer follows the rows at once.
  const read = (url: string) => handleSubscriptionAccounting({ ...ctx, declarations: subscriptions }, new Request(url));
  try {
    const rejected = read(invalid);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "Selected counter is unavailable in this period" });
    // A Codex source revision does not change a Claude counter's answer.
    sqlite.query("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES('events','*',1) ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1").run();
    expect(read(invalid).status).toBe(400);
    expect(read(base).status).toBe(200);

    sqlite.query(`INSERT INTO probe_windows(provider,subject,ts,kind,used_percent,reported_percent_side,
      resets_at,window_minutes,machine,ok) VALUES('claude','fixture',?,'weekly_all',20,'used',?,10080,'fixture-machine',1)`)
      .run("2026-08-12T12:00:00.000Z", "2026-08-17T00:00:00.000Z");
    const row = sqlite.query("SELECT * FROM probe_windows LIMIT 1").get() as Record<string, unknown>;
    const fact = createProbeCollection([{ ...row, raw_subject: null, login: "fixture", source_home: sourceHome }])[0]!;
    sqlite.transaction(() => { acceptProbeFact(sqlite, fact); mapProbeLegacy(sqlite, fact, Number(row.id), "fixture-linked"); }).immediate();
    settleProjection();
    expect(readPreparedProbeAccountRange(sqlite, "claude", "claude1", "2026-08-10", "2026-08-17", 20_000, "accounting")?.rows).toHaveLength(1);
    expect(read(invalid).status).toBe(200);
  } finally {
    sqlite.close(true); Bun.gc(true);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
