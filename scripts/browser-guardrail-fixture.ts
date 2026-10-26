/** Isolated browser guardrail fixture over a caller-owned SQLite backup and config. */
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { initDb } from "../src/db";
import { configFile } from "../src/config/paths";
import { buildEraIndex } from "../src/server/eras";
import { loadPlans } from "../src/server/plans";
import { loadPlansCatalog } from "../src/server/plans-catalog";
import {
  createFetchHandler,
  rebuildSubscriptionMaps,
  type AppContext,
} from "../src/server/api";
import { currentRegistry } from "../src/server/current/registry";
import { publishCurrentBatch } from "../src/server/current/store";

const dbPath = process.env.TOKENATLAS_DB;
const scratchRoot = process.env.TOKENATLAS_GUARDRAIL_SCRATCH;
if (!dbPath || !scratchRoot) {
  throw new Error("TOKENATLAS_DB and TOKENATLAS_GUARDRAIL_SCRATCH are required");
}
const resolvedDb = path.resolve(dbPath);
const resolvedScratch = path.resolve(scratchRoot);
if (!resolvedDb.startsWith(resolvedScratch + path.sep)) {
  throw new Error(`fixture DB must stay inside its scratch root: ${resolvedDb}`);
}

const migrated = initDb(resolvedDb);
applyDrizzleMigrations(drizzle(migrated.sqlite));
migrated.sqlite.close();

const accounts = JSON.parse(fs.readFileSync(configFile("accounts.json"), "utf-8")) as AppContext["accounts"];
const rateCards = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf-8")) as AppContext["rateCards"];
const { sqlite } = initDb(resolvedDb);
const subscriptions = accounts.subscriptions ?? [];
const ctx: AppContext = {
  sqlite,
  dbPath: resolvedDb,
  accounts,
  rateCards,
  plans: loadPlans(),
  plansCatalog: loadPlansCatalog(),
  claudeGauge: {} as AppContext["claudeGauge"],
  grokGauge: {} as AppContext["grokGauge"],
  cycles: {} as AppContext["cycles"],
  rootDir: path.resolve(import.meta.dir, ".."),
  homeToSubId: new Map(),
  subIdToHomes: new Map(),
  homeConflict: null,
  eras: buildEraIndex(subscriptions),
  eraErrors: [],
  probeSourceExists: () => false,
};
rebuildSubscriptionMaps(ctx);
publishCurrentBatch(sqlite, currentRegistry(subscriptions), new Date().toISOString(), 32, accounts);

const fetch = createFetchHandler(ctx);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch,
});
console.log(`GUARDRAIL_FIXTURE_URL=http://127.0.0.1:${server.port}`);

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.stop(true);
  sqlite.close(true);
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
