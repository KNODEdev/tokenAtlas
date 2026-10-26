import { Database } from "../db/sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  createAppContext,
  handleEraTimelines,
  handleProjects,
  reloadAppContextConfiguration,
} from "../server/api";
import { SyncCoordinator } from "./coordinator";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { applyPeriodDeclarations, PERIOD_DECLARATIONS_FILE } from "../server/period-declarations";
import { startSyncWatcher } from "./watch";
import { prepareUsageRegisters } from "../server/usage-register.fixture";
import { currentRegistry } from "../server/current/registry";
import { publishCurrentBatch } from "../server/current/store";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const configRoot = process.env.TOKENATLAS_CONFIG;
if (!configRoot) throw new Error("TOKENATLAS_CONFIG is required");

// The sessions live in one archive folder; its account periods, not accounts.json, name their account.
const claudeFolder = `${ARCHIVE_LOGICAL_ROOT.replace(/\\/g, "/")}/claude/fixture`;
const created = createTestDatabase();
const seed = new Database(created.dbPath);
seed.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS files (
    home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER,
    PRIMARY KEY (home, path)
  );
  CREATE TABLE IF NOT EXISTS events (
    home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT, model TEXT, effort TEXT,
    project TEXT, in_tok INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0,
    cache_write INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, reasoning_out INTEGER DEFAULT 0,
    cwd TEXT, project_id TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events(home, ts);
  CREATE INDEX IF NOT EXISTS events_path ON events(home, path);
  CREATE TABLE IF NOT EXISTS ratelimit (
    home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL,
    resets_at INTEGER, plan_type TEXT, limit_id TEXT, limit_name TEXT
  );
  CREATE INDEX IF NOT EXISTS rl_ts ON ratelimit(home, limit_id, window_minutes, ts);
  CREATE INDEX IF NOT EXISTS rl_path ON ratelimit(home, path);
`);
seed.query(
  `INSERT INTO claude_events (store, call_id, ts, path, cwd)
   VALUES ('live', 'seed', '2026-08-31T10:00:00.000Z', ?, 'C:/work/alpha')`
).run(`${claudeFolder}/seed.jsonl`);
seed.query("UPDATE sync_revisions SET data_revision = 1 WHERE id = 1").run();
seed.close();

let claudeSource = "claude-v1";
let injectClaudeDelta = false;
const coordinator = new SyncCoordinator({ archiveInputs: () => undefined,
  dbPath: created.dbPath,
  rootDir: process.cwd(),
  adapters: adaptersWith({
    claude: async ({ stageDbPath }) => {
      if (!injectClaudeDelta) return successfulNoop();
      injectClaudeDelta = false;
      const sqlite = new Database(stageDbPath);
      try {
        sqlite.query(
          `INSERT INTO claude_events (store, call_id, ts, path, cwd)
           VALUES ('live', 'delta', '2026-09-01T10:00:00.000Z', ?, 'C:/work/alpha')`
        ).run(`${claudeFolder}/delta.jsonl`);
        sqlite.query(
          `INSERT INTO claude_files (store, path, size, mtime, calls, ingested_at)
           VALUES ('live', 'delta.jsonl', 10, 2, 1, '2026-09-01T10:00:01.000Z')`
        ).run();
      } finally {
        sqlite.close();
      }
      return {
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 1,
        dirtyRange: { from: "2026-09-01T10:00:00.000Z", to: "2026-09-01T10:00:00.000Z" },
        diagnostics: {},
        validationErrors: [],
      };
    },
  }),
  mirror: noMirror,
  sourceFingerprint: (vendor) => (vendor === "claude" ? claudeSource : `${vendor}-v1`),
});
const ctx = createAppContext(created.dbPath);
// The usage ledger is the derived state a configuration edit must leave alone: its revision moves only with re-aggregated days.
const ledgerRevision = () => (ctx.sqlite.query("SELECT revision FROM usage_ledger_state WHERE provider='claude'").get() as { revision: number } | null)?.revision ?? 0;
let runs = 0;
let latest = null as Awaited<ReturnType<typeof runIncremental>> | null;

async function runIncremental() {
  const result = await coordinator.enter({
    trigger: "auto",
    scope: { kind: "all" },
    mode: runs === 0 ? "full" : "incremental",
  }).completion;
  reloadAppContextConfiguration(ctx, result.changedConfigDomains ?? []);
  runs++;
  latest = result;
  return result;
}

async function waitForRuns(wanted: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (runs >= wanted) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for watcher run ${wanted}; observed ${runs}`);
}

async function servedProjectCalls(projectId: string): Promise<number> {
  // Project sums come from the ledgers, which the maintenance worker keeps prepared.
  prepareUsageRegisters(ctx.sqlite, ctx.rateCards, ctx.accounts.subscriptions ?? [], ctx.homeToSubId);
  const body = (await handleProjects(ctx).json()) as {
    projects: Array<{ id: string; calls: number }>;
  };
  return body.projects.find((project) => project.id === projectId)?.calls ?? 0;
}

async function servedEraCalls(subscriptionId: string): Promise<number> {
  // The era timeline reads Claude and Codex usage from the shared price register, which the
  // maintenance worker keeps prepared.
  prepareUsageRegisters(ctx.sqlite, ctx.rateCards, ctx.accounts.subscriptions ?? [], ctx.homeToSubId);
  const body = (await handleEraTimelines(ctx).json()) as {
    subscriptions: Array<{
      subscription_id: string;
      segments: Array<{ stats: { calls: number } }>;
    }>;
  };
  return body.subscriptions
    .find((subscription) => subscription.subscription_id === subscriptionId)
    ?.segments.reduce((calls, segment) => calls + segment.stats.calls, 0) ?? 0;
}
function settleCurrentProjection(): void {
  const now = new Date().toISOString();
  const registry = currentRegistry(ctx.accounts.subscriptions, now);
  for (let step = 0; publishCurrentBatch(ctx.sqlite, registry, now, 32, ctx.accounts); step++) {
    if (step > 1_000) throw new Error("Watcher fixture current projection did not settle");
  }
}

const watcher = startSyncWatcher({
  roots: [{ path: configRoot, label: "shared configuration" }],
  dbPath: created.dbPath,
  runIncremental: async () => {
    await runIncremental();
  },
  debounceMs: 10,
  reconciliationMs: 0,
});

try {
  watcher.reconcile();
  await waitForRuns(1);
  const initialCalls = await servedProjectCalls("alpha");

  fs.writeFileSync(
    path.join(configRoot, "projects.json"),
    JSON.stringify({ projects: [{ id: "beta", name: "Beta", matches: [{ cwd: "C:/work/alpha" }] }] })
  );
  await waitForRuns(2);
  const configOnly = latest!;
  const configOnlyCalls = await servedProjectCalls("beta");
  const configOnlyDerived = ledgerRevision();

  claudeSource = "claude-v2";
  injectClaudeDelta = true;
  fs.writeFileSync(
    path.join(configRoot, "projects.json"),
    JSON.stringify({ projects: [{ id: "gamma", name: "Gamma", matches: [{ cwd: "C:/work/alpha" }] }] })
  );
  await waitForRuns(3);
  const configPlusData = latest!;
  const configPlusDataCalls = await servedProjectCalls("gamma");
  const configPlusDataDerived = ledgerRevision();

  fs.writeFileSync(
    path.join(configRoot, "accounts.json"),
    JSON.stringify({ version: 2, subscriptions: [{ id: "claude-new", vendor: "claude" }],
      sources: [{ vendor: "claude", home: claudeFolder }] })
  );
  await waitForRuns(4);
  const accountsOnly = latest!;
  settleCurrentProjection();
  // An era edit stamps nothing on Claude rows and rebuilds no derived facts (stage 4, W4).
  const accountsOnlyServedCalls = await servedEraCalls("claude-new");
  const accountsOnlyRawCalls = (ctx.sqlite
    .query("SELECT COUNT(*) AS calls FROM claude_events WHERE subscription_id = 'claude-new'")
    .get() as { calls: number }).calls;
  const accountsOnlyDerived = ledgerRevision();
  // A declared period of the folder is what gives its sessions to claude-new; the server applies the
  // file on its own tick, which this stands in for. The next read serves them without a rebuild.
  const declarations = path.join(configRoot, PERIOD_DECLARATIONS_FILE);
  fs.writeFileSync(declarations, JSON.stringify({ version: 1, accounts: [
    { provider: "claude", source: "claude/fixture", account: "claude-new", from: "2026-08-01", evidence: "fixture" },
  ] }));
  applyPeriodDeclarations(ctx.sqlite, declarations);
  settleCurrentProjection();
  const declaredServedCalls = await servedEraCalls("claude-new");
  const declaredDerived = ledgerRevision();

  console.log(JSON.stringify({
    initialCalls,
    configOnlyCalls,
    configOnlyDomains: configOnly.changedConfigDomains,
    configOnlyVendors: configOnly.vendors.length,
    configOnlyDerived,
    configOnlyConfigRevision: configOnly.afterRevisions.config,
    configPlusDataCalls,
    configPlusDataDomains: configPlusData.changedConfigDomains,
    configPlusDataChanged: configPlusData.vendors.filter((vendor) => vendor.dataChanged).map((vendor) => vendor.vendor),
    configPlusDataDerived,
    configPlusDataConfigRevision: configPlusData.afterRevisions.config,
    accountsOnlyDomains: accountsOnly.changedConfigDomains,
    accountsOnlyVendors: accountsOnly.vendors.length,
    accountsOnlyServedCalls,
    accountsOnlyRawCalls,
    accountsOnlyDerived,
    accountsOnlyConfigRevision: accountsOnly.afterRevisions.config,
    declaredServedCalls,
    declaredDerived,
  }));
} finally {
  watcher.close();
  coordinator.close();
  ctx.sqlite.close();
}
