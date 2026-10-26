import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { CONFIG_ROOT } from "../config/paths";
import { createTestDatabase } from "../sync/test-support";
import { buildEraIndex } from "./eras";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { handleSubscriptionAccounting } from "./subscription-accounting";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { WindowUsagePreparing } from "./window-usage";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { AppContext } from "./api";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { fillUsageLedger } from "./usage-ledger.fixture";

const selectedConfig = process.env.TOKENATLAS_CONFIG;
assert(selectedConfig && path.resolve(selectedConfig) === CONFIG_ROOT);
assert(path.resolve(CONFIG_ROOT).startsWith(path.resolve(os.tmpdir()) + path.sep));

const { directory, dbPath } = createTestDatabase();
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode=WAL");
const subscriptions = [{ id: "claude1", vendor: "claude" }];
const config = { subscriptions, sources: [] };
const at = "2026-08-12T12:00:00.000Z";
let settled = false;
for (let step = 0; step < 100; step++) {
  if (!publishCurrentBatch(sqlite, currentRegistry(subscriptions, at), at, 512, config)) { settled = true; break; }
}
assert(settled);
// The maintenance worker publishes limit windows; it reads the measurement file as the server does.
const limitWindows = () => prepareLimitWindowsFixture(sqlite, { manualCapacity: undefined });
limitWindows();
// The background writer's usage-price job: reports only read the ledger.
fillUsageLedger(sqlite, "claude", { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, ARCHIVE_LOGICAL_ROOT);
const ctx = { sqlite, dbPath, accounts: { version: 2, ...config }, homeToSubId: new Map(),
  subIdToHomes: new Map(), eras: buildEraIndex([]), eraErrors: [], homeConflict: null,
  rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, claudeGauge: {}, grokGauge: {},
  cycles: {}, plans: {}, plansCatalog: { provider_groups: [] }, rootDir: directory } as unknown as AppContext;
// ...and the window sums, standalone manual intervals included, once the ledger they read is ready.
const windowSums = () => prepareWindowUsageFixture(sqlite, { rateCards: ctx.rateCards, claudeGauge: {}, cycles: { windows: [] } });
const counter = '["weekly_all","",10080]';
const url = `http://local/api/subscription-accounting?provider=claude&account=claude1&since=2026-08-10&until=2026-08-16&counter=${encodeURIComponent(counter)}`;
// The report is read from stored rows on each request (plan U4.4); a row not yet published is "preparing".
const read = () => {
  try { return handleSubscriptionAccounting({ ...ctx, declarations: subscriptions }, new Request(url)).status; }
  catch (error) { if (error instanceof WindowUsagePreparing || error instanceof SubscriptionFactsPending) return 202; throw error; }
};
// The usage ledger the report reads is filled by its background producer.
fillUsageLedgerFixture(sqlite, ctx.rateCards, ["claude"]);
try {
  assert.equal(read(), 400);
  fs.writeFileSync(path.join(CONFIG_ROOT, "manual-capacity-claude.json"), JSON.stringify({
    revision: "fixture-addition",
    measurements: [{ id: "manual-fixture", account: "claude1", counter,
      start: "2026-08-11T00:00:00.000Z", end: "2026-08-12T00:00:00.000Z",
      start_percent: 10, end_percent: 20, approximate_time: false, note: "fixture",
      updated_at: "2026-08-12T00:00:00.000Z" }],
  }));
  limitWindows();
  // The window exists; its sums are published by the next producer turn.
  assert.equal(read(), 202);
  windowSums();
  assert.equal(read(), 200);
  console.log("PASS");
} finally {
  sqlite.close(true); Bun.gc(true);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
