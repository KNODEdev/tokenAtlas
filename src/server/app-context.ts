import fs from "fs";
import { expandPath, configFile, REPO_ROOT, ARCHIVE_ROOT, MACHINE, atlasIndexSnapshotPool } from "../config/paths";
import type { AccountsConfig, AppContext } from "./app-context-types";
import { restoreSubscriptionHomes, SubscriptionHomeConflictError } from "./capacity-equivalents";
import { buildEraIndex } from "./eras";
import { periodEras, subscriptionMaps } from "./subscription-maps";
import { readStartupAccounts } from "../config/accounts-document";
import { resolveDbPath, initDb } from "../db";
import { assertMigrationHistory } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { recoverInterruptedSyncRuns } from "../sync/store";
import { loadRateCard } from "./rate-cards-file";
import { loadClaudeGauge } from "./claude-limit";
import { loadGrokGauge } from "./grok-limit";
import { loadCycles } from "./cycles";
import { loadPlans } from "./plans";
import { loadPlansCatalog } from "./plans-catalog";
import { loadAccountResolver } from "./account-resolver";
import { publishAtlasSnapshot } from "../db/snapshot-publish";
import { discoverNewestValidAtlasSnapshot } from "../db/snapshot-discovery";
import type { ConfigDomain } from "../sync/contracts";

function loadConfig<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    return {} as T;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
}

export function expandAccountPaths(cfg: AccountsConfig, roots?: { archive?: string }): AccountsConfig {
  return {
    ...cfg,
    sources: cfg.sources.map((source) => ({
      ...source,
      home: expandPath(source.home, roots),
      ...(source.source_home ? { source_home: expandPath(source.source_home, roots) } : {}),
    })),
  };
}

/**
 * The static home→subscription map is the "now" slice of the eras: only entries
 * whose era covers today take part. A closed era's home is free for the next
 * subscription, which is why two entries may share a home as long as their eras
 * do not overlap. Anything that needs another instant asks resolveSubscription.
 */
function emptySubscriptionMaps(): {
  homeToSubId: Map<string, string>;
  subIdToHomes: Map<string, string[]>;
} {
  return { homeToSubId: restoreSubscriptionHomes([], [], []), subIdToHomes: new Map() };
}

function applySubscriptionMaps(
  ctx: AppContext,
  homeToSubId: Map<string, string>,
  subIdToHomes: Map<string, string[]>
): void {
  // The indexed map owns source priorities and identity declarations as well as its entries.
  ctx.homeToSubId = homeToSubId;
  ctx.subIdToHomes = subIdToHomes;
}

function rebuildEras(ctx: AppContext): void {
  ctx.eraErrors = [];
  ctx.eras = buildEraIndex(periodEras(ctx.sqlite, ctx.accounts), "instant");
  if (ctx.eraErrors.length > 0) {
    console.error("[accounts] deklaracja er odrzucona:\n  " + ctx.eraErrors.join("\n  "));
  }
}

export function rebuildSubscriptionMaps(ctx: AppContext): void {
  rebuildEras(ctx);
  try {
    const { homeToSubId, subIdToHomes } = subscriptionMaps(ctx.sqlite, ctx.accounts);
    applySubscriptionMaps(ctx, homeToSubId, subIdToHomes);
    ctx.homeConflict = null;
  } catch (e) {
    if (!(e instanceof SubscriptionHomeConflictError)) throw e;
    ctx.homeConflict = e;
    const empty = emptySubscriptionMaps();
    applySubscriptionMaps(ctx, empty.homeToSubId, empty.subIdToHomes);
    console.error("[accounts] conflicting subscription homes; setup remains reachable:", e.message);
  }
}

export function createAppContext(customDbPath?: string): AppContext {
  const accounts = expandAccountPaths(readStartupAccounts(configFile("accounts.json"), resolveDbPath(customDbPath)));
  const { db, sqlite, dbPath } = initDb(customDbPath);
  try { assertMigrationHistory(db); } catch (error) { sqlite.close(true); throw error; }
  installAnalysisTracking(sqlite);
  installFactDayRevisions(sqlite);
  recoverInterruptedSyncRuns(sqlite);
  const rootDir = REPO_ROOT;
  const rateCards = loadRateCard(configFile("rate-cards.json"));
  const claudeGauge = loadClaudeGauge();
  const grokGauge = loadGrokGauge();
  const cycles = loadCycles();
  const plans = loadPlans();
  const plansCatalog = loadPlansCatalog();
  const eraErrors: string[] = [];
  const eras = buildEraIndex(periodEras(sqlite, accounts), "instant");
  if (eraErrors.length > 0) {
    console.error("[accounts] deklaracja er odrzucona:\n  " + eraErrors.join("\n  "));
  }
  let homeToSubId: Map<string, string>;
  let subIdToHomes: Map<string, string[]>;
  let homeConflict: SubscriptionHomeConflictError | null = null;
  try {
    const maps = subscriptionMaps(sqlite, accounts);
    homeToSubId = maps.homeToSubId;
    subIdToHomes = maps.subIdToHomes;
  } catch (e) {
    if (!(e instanceof SubscriptionHomeConflictError)) throw e;
    homeConflict = e;
    homeToSubId = new Map();
    subIdToHomes = new Map();
    console.error("[accounts] conflicting subscription homes; serving setup so the declaration can be fixed:", e.message);
  }
  return {
    sqlite,
    get resolver() { return loadAccountResolver(this.sqlite, this.accounts.subscriptions); },
    dbPath,
    snapshotPublisher: (mode) =>
      publishAtlasSnapshot({
        dbPath,
        archiveRoot: ARCHIVE_ROOT,
        sourceMachine: MACHINE,
        mode,
      }),
    snapshotDiscovery: () => discoverNewestValidAtlasSnapshot(atlasIndexSnapshotPool(dbPath)),
    rateCards,
    accounts,
    claudeGauge,
    grokGauge,
    cycles,
    plans,
    plansCatalog,
    rootDir,
    homeToSubId,
    subIdToHomes,
    homeConflict,
    eras,
    eraErrors,
  };
}

export function reloadAppContextConfiguration(
  ctx: AppContext,
  changedDomains: readonly ConfigDomain[]
): void {
  if (changedDomains.length === 0) return;
  const accounts = expandAccountPaths(readStartupAccounts(configFile("accounts.json"), ctx.dbPath ?? resolveDbPath()));
  const rateCards = loadRateCard(configFile("rate-cards.json"));
  const eraErrors: string[] = [];
  const eras = buildEraIndex(periodEras(ctx.sqlite, accounts), "instant");
  let homeToSubId = new Map<string, string>();
  let subIdToHomes = new Map<string, string[]>();
  let homeConflict: SubscriptionHomeConflictError | null = null;
  try {
    const maps = subscriptionMaps(ctx.sqlite, accounts);
    homeToSubId = maps.homeToSubId;
    subIdToHomes = maps.subIdToHomes;
  } catch (error) {
    if (!(error instanceof SubscriptionHomeConflictError)) throw error;
    homeConflict = error;
  }
  Object.assign(ctx, {
    rateCards,
    accounts,
    claudeGauge: loadClaudeGauge(),
    grokGauge: loadGrokGauge(),
    cycles: loadCycles(),
    plans: loadPlans(),
    plansCatalog: loadPlansCatalog(),
    homeToSubId,
    subIdToHomes,
    homeConflict,
    eras,
    eraErrors,
  });
}
