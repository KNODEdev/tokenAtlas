import {advanceFinalContext} from "./codex-context-final-producer";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/sqlite";
import { advanceAllUsagePrices } from "./subscription-preparation";
import { codexPhysicalSourceHomes } from "./capacity-equivalents";
import { CONFIG_ROOT, ARCHIVE_LOGICAL_ROOT, ARCHIVE_ROOT, LOGIN } from "../config/paths";
import { accountPeriodFeedBehind, advanceAccountPeriods } from "./account-period-feed";
import { applyPeriodDeclarations, PERIOD_DECLARATIONS_FILE } from "./period-declarations";
import { currentRegistry, type CurrentConfig } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { advanceRebuildReadiness, analysisRebuildStatus, runAnalysisRebuild } from "./analysis-rebuild";
import { ledgerSumsCurrent } from "./ledger-sums";
import type { RateCard } from "./pricing";
import { advanceLimitWindows } from "./limit-window-producer";
import { advanceCreditNotices } from "./credit-notice-producer";
import { decodeNoticePools } from "./credit-notice-pools";
import { BacklogProgress, ProgressRegistry } from "../sync/progress";
import { reportBackgroundProgress } from "./background-progress";
import { advanceWindowUsage } from "./window-usage-producer";
import { advanceArchiveVerification } from "../sync/archive-verification";
import { archiveCopyRoots } from "../sync/mirror";
import { flushGaugeJournal, pendingGaugeJournalLines, type JournalDeliveryResult, type JournalDeliveryTarget } from "../providers/core/journal";
import type { GaugeJournalDeliveryReport } from "../providers/core/journal-runtime";
import { foldWindowAnswerMarks, setLedgerAnswerOwners, storeWindowAnswers, type WindowAnswer } from "../db/window-answers";
import { ledgerOwnersOf } from "./ledger-answer-owners";
import { advanceBillingCycles } from "./billing-cycle-producer";
import { advanceFxRates } from "./fx-rates";
import { loadPlansCatalog, type PlansCatalog } from "./plans-catalog";
import { advanceWindowPointValues } from "./window-point-values";
import { advanceWindowEndCauses } from "./window-end-causes";
import { loadPlans, type PlansConfig } from "./plans";
import { advanceSubscriptionRates } from "./subscription-rate";
import {advanceSubscriptionHours} from './subscription-hours';
import {advanceProjectPlanFacts} from './project-plan-producer';
import { advanceCapacityCycleResults, capacityCycleProducerContext } from "./capacity-cycle-producer";
import { advanceClaudeCardMetadata } from "./claude-card-metadata";
import { ledgerProviderOf } from "./subscription-accounting-adapters";
import { advanceCodexContextPrices } from "./codex-context-producer";
import { advanceCodexContextDetails } from "./codex-context-model-producer";

/**
 * The background writer's job queue (U2.1). Outside a sync run, every multi-row write to the
 * database is one of these jobs, run in this order by the one background worker: the current
 * projection first (readings must reach the screen within a second) and the credit notices that follow its
 * cards, then the analysis rebuild,
 * the price ledgers, account periods, limit windows, window sums, the rebuild's readiness, delivery of
 * the gauge journal and the slow archive verification (files only).
 *
 * A job does a bounded share of its work per turn and stops at `canWrite()` turning false (the
 * write lease is wanted elsewhere, U2.2); its queue stays durable in the database, so a later
 * turn resumes it. Each job reports its backlog to the progress register under its own scope.
 */
export interface BackgroundTurn {
  db: Database;
  config: CurrentConfig;
  rates: RateCard | null;
  /** Gauge journal delivery target of this server, or null when the journal is off. */
  journal: JournalDeliveryTarget | null;
  /** Time a backlog may use of one turn; 0 is one pass over the jobs. */
  turnMs: number;
  /** False once this worker must stop writing (checked between batches). */
  canWrite(): boolean;
  /**
   * Whether this worker still holds the writer, also while another party waits for it: a job writes what it
   * already computed before it stops (without it, `canWrite`).
   */
  holdsWriter?(): boolean;
  progress: ProgressRegistry;
  backlog: BacklogProgress;
  /** Window answers computed off the HTTP thread (data-read.ts) for this turn to publish. */
  answers?: readonly WindowAnswer[];
}
export interface AccountPeriodsOutcome { changed: boolean; pending: boolean; declarationErrors?: string[]; declarationsDigest?: string | null }
export interface BackgroundTurnResult {
  /** Some job left executable work that the next turn should start soon. */
  catchUpNeeded: boolean;
  accountPeriods?: AccountPeriodsOutcome;
  journal?: GaugeJournalDeliveryReport;
  /** Jobs that failed this turn, by scope; the others ran. */
  errors: Record<string, string>;
  /** Whether the limit-window and window-sum producers left work this turn (undefined: they did not run). */
  registersPending?: { limitWindows?: boolean; windowSums?: boolean };
  /** The turn published the window answers it was given (otherwise they go back to the queue). */
  answersStored?: boolean;
}
interface BackgroundJob {
  scope: string;
  /** Writes nothing to the database (runs whatever the write lease says). */
  readOnly?: boolean;
  /** Not a table a source rebuild owns: runs while one is in progress. */
  independentOfRebuild?: boolean;
  /** Runs a bounded share; true when executable work is left for the next turn. */
  run(turn: BackgroundTurn, result: BackgroundTurnResult): boolean;
}

let periodsLastRun = -Infinity, periodsPending = false, periodsChanged = false;
let catalogRead = -Infinity, catalog: PlansCatalog | null = null;
/** The plans catalog the billing cycles are priced from, read again at most once a minute. */
function billingCatalog(): PlansCatalog {
  if (!catalog || Date.now() - catalogRead >= 60_000) { catalog = loadPlansCatalog(); catalogRead = Date.now(); }
  return catalog;
}
let plansRead = -Infinity, plans: PlansConfig | null = null;
/** The capacity regimes (plans.json) the window point values follow, read again at most once a minute. */
function capacityPlans(): PlansConfig {
  if (!plans || Date.now() - plansRead >= 60_000) { plans = loadPlans(); plansRead = Date.now(); }
  return plans;
}
let declarationsDigest: string | null | undefined;
let declarationErrors: string[] = [];
let registryFingerprint = "", registry: ReturnType<typeof currentRegistry> = [];

function hasTables(db: Database, names: readonly string[]): boolean {
  return (db.query(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => "?").join(",")})`)
    .get(...names) as { n: number }).n === names.length;
}

const JOBS: readonly BackgroundJob[] = [
  { scope: "current-projection", independentOfRebuild: true, run(turn) {
    if (!hasTables(turn.db, ["current_projection_state"])) return false;
    const next = currentRegistry(turn.config.subscriptions);
    const fingerprint = JSON.stringify(next);
    if (fingerprint !== registryFingerprint) { registry = next; registryFingerprint = fingerprint; }
    const pending = publishCurrentBatch(turn.db, registry, undefined, 1000, turn.config,
      { archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN });
    // Readings whose evidence is still to be written come first; then the accounts whose cards are folded.
    const evidence = hasTables(turn.db, ["probe_source_dirty"])
      ? (turn.db.query("SELECT count(*) AS n FROM probe_source_dirty").get() as { n: number }).n : 0;
    if (evidence) turn.backlog.report("current-projection", "evidence", "recording where limit readings were taken", "readings", evidence);
    else turn.backlog.report("current-projection", "subjects", "updating current limits", "accounts",
      (turn.db.query("SELECT count(*) AS n FROM current_projection_dirty").get() as { n: number }).n);
    return pending;
  } },
  // Credit notices compare the pools of the cards published above with the stored ones.
  { scope: "credit-notices", independentOfRebuild: true, run(turn) {
    return advanceCreditNotices(turn.db, { decode: decodeNoticePools, canWrite: turn.canWrite }).pending;
  } },
  { scope: "analysis-rebuild", run(turn) { runAnalysisRebuild(turn.db, turn.config); return false; } },
  { scope: "usage-prices", run(turn) {
    if (!turn.rates) return false;
    // The same homes and source homes the report readers use; a different set changes the scope's source stamp.
    const prices = advanceAllUsagePrices(turn.db, turn.rates, turn.config.sources, codexPhysicalSourceHomes(turn.config.sources),
      { limit: 500, steps: 4, turnMs: turn.turnMs, canWrite: turn.canWrite });
    return !!(prices.codex?.progressed && prices.codex.executablePending || prices.othersPending);
  } },
  { scope: "codex-context-prices", run(turn) {
    const context = advanceCodexContextPrices(turn.db, { canWrite: turn.canWrite });
    if (!context) return false;
    turn.backlog.report("codex-context-prices", "events", "preparing context price measures", "items", context.pending ? 1 : 0);
    return context.pending;
  } },
  { scope: "codex-context-details", run(turn) {
    if(!turn.rates)return false;
    return advanceCodexContextDetails(turn.db,turn.rates,{canWrite:turn.canWrite,subscriptions:turn.config.subscriptions}).pending;
  } },
  { scope:"codex-context-final",run(turn){
    if(!turn.rates)return false;
    return advanceFinalContext(turn.db,{rates:turn.rates,catalog:loadPlansCatalog(),config:turn.config,canWrite:turn.canWrite}).pending;
  } },
  { scope: "account-periods", run(turn, result) {
    const periods = advancePeriods(turn);
    if (periods) result.accountPeriods = periods;
    return !!periods?.pending;
  } },
  // Limit windows follow the readings and periods published above.
  { scope: "limit-windows", run(turn, result) {
    const windows = advanceLimitWindows(turn.db, { sources: turn.config.sources, subscriptions: turn.config.subscriptions,
      budgetMs: Math.min(1000, turn.turnMs), canWrite: turn.canWrite });
    if (windows) (result.registersPending ??= {}).limitWindows = windows.pending;
    return !!(windows?.progressed && windows.pending);
  } },
  // Window sums follow the windows and the ledgers above; without rate cards there is no ledger to read.
  { scope: "window-usage", run(turn, result) {
    if (!turn.rates) return false;
    const sums = advanceWindowUsage(turn.db, { rateCards: turn.rates, subscriptions: turn.config.subscriptions,
      budgetMs: Math.min(1000, turn.turnMs), canWrite: turn.canWrite, ...(turn.holdsWriter ? { holdsWriter: turn.holdsWriter } : {}) });
    (result.registersPending ??= {}).windowSums = sums.pending;
    return !!(sums.progressed && sums.pending);
  } },
  { scope: "claude-card-metadata", run(turn) {
    if (!turn.canWrite() || !hasTables(turn.db,["claude_card_state","limit_windows","window_usage"])) return false;
    const result = advanceClaudeCardMetadata(turn.db,{canWrite:turn.canWrite,
      accounts:(turn.config.subscriptions ?? []).filter(row => ledgerProviderOf(row.vendor ?? "codex")?.id === "claude").map(row => row.id)});
    turn.backlog.report("claude-card-metadata","windows","preparing Claude card metadata","items",result.pending ? 1 : 0);
    return !!result.account && result.pending;
  } },
  { scope: "capacity-cycle-results", run(turn) {
    if (!turn.rates || !hasTables(turn.db, ["capacity_cycle_results", "limit_windows", "window_usage"])) return false;
    const result = advanceCapacityCycleResults(capacityCycleProducerContext(turn.db, turn.rates, turn.config, capacityPlans(), billingCatalog()),
      { budgetMs: Math.min(250, turn.turnMs || 250), canWrite: turn.canWrite });
    if (!result) return false;
    turn.backlog.report("capacity-cycle-results", "windows", "preparing capacity cycles", "items", result.pending ? 1 : 0);
    return (result.processed > 0 || result.discovered > 0) && result.pending;
  } },
  // The value of one point of each window follows the windows and their sums (docs/reset-capacity-plan-2026-10-11.md step 1).
  { scope: "window-point-values", run(turn) {
    const values = advanceWindowPointValues(turn.db, { plans: capacityPlans(), catalog: billingCatalog(),
      budgetMs: Math.min(500, turn.turnMs || 500), canWrite: turn.canWrite });
    if (!values) return false;
    turn.backlog.report("window-point-values", "windows", "valuing limit window points", "items", values.backlog);
    return values.progressed && values.pending;
  } },
  // The cause of each window's end follows the windows and the reset-credit readings (reset-capacity plan step 2).
  { scope: "subscription-capacities", run(turn) {
    if (!turn.rates) return false;
    const result = advanceSubscriptionRates(turn.db, { rates:turn.rates,catalog:billingCatalog(),config:turn.config,canWrite:turn.canWrite });
    if (!result) return false;
    turn.backlog.report("subscription-capacities","windows","preparing subscription capacity","items",result.pending ? 1 : 0);
    return result.pending && result.processed > 0;
  } },
  { scope: "window-end-causes", run(turn) {
    const causes = advanceWindowEndCauses(turn.db, { budgetMs: Math.min(500, turn.turnMs || 500), canWrite: turn.canWrite });
    if (!causes) return false;
    turn.backlog.report("window-end-causes", "windows", "classifying limit window ends", "items", causes.backlog);
    return causes.progressed && causes.pending;
  } },
  {scope:"subscription-hours",run(turn){
    if(!turn.rates)return false;
    const result=advanceSubscriptionHours(turn.db,{rates:turn.rates,catalog:billingCatalog(),config:turn.config,canWrite:turn.canWrite});
    if(!result)return false;
    turn.backlog.report('subscription-hours','windows','preparing active agent time','items',result.pending?1:0);
    return result.processed>0&&result.pending;
  }},
  // Billing cycles follow the plan periods, windows, window sums, point values and end causes above (docs/billing-cycles-design-2026-10-08.md §5).
  {scope:'project-plan-facts',run(turn){
    if(!turn.rates)return false;
    const result=advanceProjectPlanFacts(turn.db,{rates:turn.rates,catalog:billingCatalog(),config:turn.config,canWrite:turn.canWrite});
    if(!result)return false;
    turn.backlog.report('project-plan-facts','days','preparing project plan equivalents','items',result.pending?1:0);
    return result.processed>0&&result.pending;
  }},
  // NBP rates of payments in other currencies: fetched between turns, stored here, before the cycles that convert them.
  { scope: "fx-rates", run(turn) {
    const fx = advanceFxRates(turn.db, { canWrite: turn.canWrite });
    if (!fx) return false;
    turn.backlog.report("fx-rates", "fetch", "fetching exchange rates", "items", fx.waiting);
    return fx.stored > 0;
  } },
  { scope: "billing-cycles", run(turn) {
    const cycles = advanceBillingCycles(turn.db, { catalog: billingCatalog(), budgetMs: Math.min(500, turn.turnMs || 500), canWrite: turn.canWrite });
    if (!cycles) return false;
    const pending = (turn.db.query("SELECT count(*) AS n FROM billing_cycle_dirty").get() as { n: number }).n;
    turn.backlog.report("billing-cycles", "cycles", "updating billing cycles", "accounts", pending);
    return cycles.progressed && cycles.pending;
  } },
  // A rebuild's last phase ends when the derived registers above have caught up with its facts.
  { scope: "rebuild-readiness", run(turn, result) {
    const pending = result.registersPending;
    if (pending?.limitWindows === undefined || pending.windowSums === undefined) return false;
    advanceRebuildReadiness(turn.db, { prices: ledgerSumsCurrent(turn.db), limitWindows: !pending.limitWindows, windowSums: !pending.windowSums },
      { subscriptions: turn.config.subscriptions, sources: turn.config.sources, rateCards: turn.rates ?? undefined,
        sourceHomes: codexPhysicalSourceHomes(turn.config.sources) });
    return false;
  } },
  // Window answers (db/window-answers.ts): publish the computed ones, fold old marks into the stored ones.
  { scope: "window-answers", independentOfRebuild: true, run(turn, result) {
    if (turn.answers?.length) storeWindowAnswers(turn.db, turn.answers);
    result.answersStored = true;
    return foldWindowAnswerMarks(turn.db);
  } },
  { scope: "gauge-journal", independentOfRebuild: true, run(turn, result) {
    if (!turn.journal || !hasTables(turn.db, ["gauge_journal_outbox"])) return false;
    result.journal = deliverGaugeJournal(turn.db, turn.journal, turn.canWrite);
    turn.backlog.report("gauge-journal", "deliver", "delivering limit readings to the archive", "readings", result.journal.pending ?? 0);
    return result.journal.error === null && !!result.journal.pending;
  } },
  { scope: "archive-verification", readOnly: true, independentOfRebuild: true, run(turn) {
    if (!ARCHIVE_ROOT || !fs.existsSync(path.join(ARCHIVE_ROOT, ".archive-inventory", "identity.json"))) return false;
    const verified = advanceArchiveVerification({ archiveRoot: ARCHIVE_ROOT, roots: archiveCopyRoots, budgetMs: Math.min(250, turn.turnMs || 250) });
    for (const copy of verified.differing) console.warn(`[tokenAtlas archive] copy differs from its original; the next copy pass compares them: ${copy}`);
    if (verified.total) turn.progress.report("archive-verification", "verify", "verifying archive copies", "files", verified.done, verified.total);
    else turn.progress.end("archive-verification");
    return false;
  } },
];

function advancePeriods(turn: BackgroundTurn): AccountPeriodsOutcome | undefined {
  const { db, config } = turn;
  // The declarations file is read again once a minute; new readings are fed on the next turn, so a
  // probe round never waits a minute as queued work in the progress register and the activity panel.
  if (!periodsPending && Date.now() - periodsLastRun < 60_000 && !accountPeriodFeedBehind(db)) return undefined;
  // Partial schemas used by maintenance callers have no period feed to advance.
  if (!hasTables(db, ["probe_windows", "account_periods", "plan_periods"])) return undefined;
  const declared = applyPeriodDeclarations(db, path.join(CONFIG_ROOT, PERIOD_DECLARATIONS_FILE));
  periodsChanged ||= declared.changed || declared.digest !== declarationsDigest;
  declarationsDigest = declared.digest;
  declarationErrors = declared.errors;
  const started = performance.now();
  do {
    if (!turn.canWrite()) break;
    const fed = advanceAccountPeriods(db, { declarations: config.sources, subscriptions: config.subscriptions,
      archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN });
    periodsChanged ||= fed.rows > 0 || fed.rebuilt.length > 0;
    periodsPending = !fed.done;
  } while (periodsPending && performance.now() - started < Math.min(500, turn.turnMs));
  periodsLastRun = Date.now();
  const outcome = { changed: periodsChanged, pending: periodsPending, declarationErrors, declarationsDigest };
  // Keep changes across a backlog whose final turn may feed zero rows.
  if (!periodsPending) periodsChanged = false;
  return outcome;
}

/**
 * Delivers committed gauge journal entries to the archive in bounded batches. A missing archive
 * is an error class, not a failure: the entries stay queued and a later turn delivers them.
 * Delivered lines are acknowledged durably (the outbox row goes only after the archive append).
 */
export function deliverGaugeJournal(db: Database, target: JournalDeliveryTarget, canWrite: () => boolean = () => true): GaugeJournalDeliveryReport {
  // An empty outbox touches nothing: a delivery takes an archive writer lease (a file written and removed in
  // the archive), which every idle turn did once a second.
  if (!db.query("SELECT 1 FROM gauge_journal_outbox LIMIT 1").get()) return { delivered: 0, error: null, pending: 0 };
  db.exec("PRAGMA synchronous=FULL");
  let delivered = 0, outcome: JournalDeliveryResult = { delivered: 0, error: null };
  try {
    for (let batch = 0; batch < 8 && canWrite(); batch++) {
      outcome = flushGaugeJournal(db, target);
      delivered += outcome.delivered;
      if (outcome.error !== null || outcome.delivered === 0) break;
    }
  } finally { db.exec("PRAGMA synchronous=NORMAL"); }
  return { ...outcome, delivered, pending: pendingGaugeJournalLines(db) };
}

/**
 * One turn over the queue. A source rebuild in progress owns the derived tables: only the jobs
 * independent of it run. A job that fails is reported and the others still run.
 */
export function runBackgroundTurn(turn: BackgroundTurn): BackgroundTurnResult {
  const result: BackgroundTurnResult = { catchUpNeeded: false, errors: {} };
  // A ledger change marks the stored window answers of the accounts that own it, not every account's.
  setLedgerAnswerOwners(turn.db, ledgerOwnersOf(turn.db, turn.config.subscriptions));
  const rebuild = analysisRebuildStatus(turn.db);
  const sourcesRebuilding = rebuild?.phase === "sources" && (rebuild.state === "queued" || rebuild.state === "running");
  for (const job of JOBS) {
    if (sourcesRebuilding && !job.independentOfRebuild || !job.readOnly && !turn.canWrite()) continue;
    try { result.catchUpNeeded = job.run(turn, result) || result.catchUpNeeded; }
    catch (error) { result.errors[job.scope] = error instanceof Error ? error.message : String(error); }
  }
  // What the producers still have queued, for the progress register; never fails the turn.
  try { reportBackgroundProgress(turn.db, turn.progress, turn.backlog); } catch { /* Progress is advisory. */ }
  result.catchUpNeeded &&= turn.canWrite();
  return result;
}
