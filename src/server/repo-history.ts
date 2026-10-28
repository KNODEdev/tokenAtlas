import type { ContextPreviewResponse } from "../shared/context-preview";
import { Database } from "../db/sqlite";
import { withContextPreview, contextPreviewReader } from "./codex-context-preview";
import { captureContextReadAsync, inContextRead, runContextRead } from "../db/codex-context-read-scope";
import fs from "fs";
import { loadProjects } from "../projects/remap";
import { currentProjectRules, placeProject, projectRulesStamp } from "../projects/rules-now";
import { deriveRepo } from "../projects/repo";
import { codexLedgerDayBounds, CodexLedgerNotReady } from "../db/codex-price-ledger";
import { codexLedgerPublished } from "../db/codex-ledger-state";
import { activityDayKey, codexSumsPresent, ledgerDayBounds, readActivityDays, readCodexOwnedDays, readCodexPlaces, readOtherProviderDays,
  requireUsageLedgerSums } from "./ledger-sums";
import {
  allocateCents,
  allocatePaidAcrossSubjects,
  round2,
  type RateCard,
} from "./pricing";
import { storedHistoryUsage, STORED_HISTORY_CONTRACT, type HistoryRow, type HistoryUnpriced, type HistoryUsage } from "./stored-history-usage";
import { CLAUDE_CONFLICT_RULE, claudeSourceDayBounds, type ClaudeConflictingIdentities, type ClaudeProjectEvidence } from "./claude-project-usage";
import type { EraIndex } from "./eras";
import {
  subscriptionDeclarations,
  restoreSubscriptionHomes,
  codexPhysicalSourceHomes,
  resolveCodexSubId,
} from "./capacity-equivalents";
import { providerSourceDayBounds, type ProjectFactProvider, type ProviderProjectConflict, type ProviderProjectEvidence } from "./provider-project-usage";
import { configFile, ARCHIVE_LOGICAL_ROOT, expandPath } from "../config/paths";
import { readAccountsV2 } from "../config/accounts-document";
import { loadAccountResolver, type AccountReadPlan, type AccountResolver } from "./account-resolver";
import { codexLedgerReadContext, codexLedgerPendingReason, readCodexLedgerOwnedSeries,
  ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { add, rational, type Rational } from "../db/price-ledger-exact";
import { archiveFolderOf } from "./event-source";
import type { IdentityDeclaration } from "./account-resolver";
import { planPricingInputs, subscriptionPlanPricing } from "./project-cost-plan-pricing";
import { loadPlansCatalog, type PlansCatalog } from "./plans-catalog";
import { loadRateCard } from "./rate-cards-file";
import { sourceMachineResolver } from "./account-periods-view";
import { activityByDay, intervalSeconds, readProjectActivity } from "./project-active-time";
import { allocatePlanPeriods, readPlanPeriodsUsage, sumPlanPeriodRows, type PeriodUsageRow } from "./project-cost-periods";
import { codexPlanAllocationEligible } from "./project-cost-codex";
export type Granularity = "day" | "week" | "month";
export type Breakdown = "none" | "vendor" | "model" | "account";
/**
 * Bumped when this view's own composition changes; the Claude part carries its own rules.
 * 3: bucket and total amounts are rounded once from the original amounts, Claude active
 * seconds keep their fractions until presentation, and a verified account with canonical
 * calls stays in by_sub even when its own subtotal is zero.
 * 4: conflicting-copy exclusions are published in `claude.conflicts` and make the range's
 * completeness flags conservative.
 * 7: every vendor's tokens, calls and active time come from stored rows (stored-history-usage.ts, ledger-sums.ts); active
 * time follows rule D2 for every vendor and keeps exact seconds, and Codex is split by verified account (D4).
 * 8: billed_usd splits the same bill as the project cost (account plan periods x Plans catalog, rate-card price
 * only for uncovered days) with the same withholding rule, so the buckets add up to the subject's cost share.
 * 9: buckets and totals carry `active_by_machine`, the same active seconds split by the computer of their ledger source.
 * 10: active time unions prepared intervals per computer across agents/providers; session_seconds retains the additive measure.
 * 11: allocate each dated plan's bill before distributing its cents over calendar buckets.
 */
export const REPO_HISTORY_ALGORITHM = 11;
/**
 * The whole contract a cached repo-history or subject list depends on. An outer data-view
 * cache must pin this, so a changed Claude fact, activity, conflict or valuation rule can
 * never leave a persisted history or selector looking current.
 */
export const REPO_HISTORY_CONTRACT =
  [REPO_HISTORY_ALGORITHM, CLAUDE_CONFLICT_RULE, ...STORED_HISTORY_CONTRACT] as const;
/** The vendor order of the view; Grok and GLM follow from the provider histories. */
const SOURCES = [{ vendor: "claude" }, { vendor: "codex" }, { vendor: "opencode" }] as const;
/**
 * Calendar buckets of a canonical UTC day: the day, its month, or its Monday-based week.
 * Claude days come from the shared fact index, which resolves a preserved timestamp offset
 * to its UTC instant, so its buckets are UTC days and not the stored local date.
 */
function bucketOfDay(day: string, g: Granularity): string {
  if (g === "month") return day.slice(0, 7);
  if (g !== "week") return day;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return day;
  // Monday-based weeks, exactly like date(ts,'weekday 0','-6 days').
  const back = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - back * 86_400_000).toISOString().slice(0, 10);
}
export interface RepoBucket {
  bucket: string;
  tokens: number;
  calls: number;
  /** May be fractional: Claude sub-second gaps are summed here and rounded only for display. */
  active_seconds: number;
  /** `active_seconds` by computer (`UNKNOWN_MACHINE` when the source names none); the parts add up to it. */
  active_by_machine: Record<string, number>;
  /** Additive agent-session time: parallel sessions add up, unlike the per-computer union in `active_seconds`. */
  session_seconds: number;
  api_usd: number;
  /**
   * False when counted traffic of this bucket has no known price, so api_usd is a subtotal,
   * and false for EVERY bucket of a range that holds conflicting-copy exclusions. The second
   * rule is deliberately conservative: a conflicted call has no certain timestamp, so no
   * bucket may be declared complete just because the excluded copies were dated elsewhere.
   * Derived from the Claude valuations; the other vendors still report no price coverage here.
   */
  api_complete: boolean;
  billed_usd: number | null;
  billed_complete: boolean;
  by_sub: Record<string, { api_usd: number; billed_usd: number | null }>;
  split?: Record<string, { tokens: number; calls: number; active_seconds: number }>;
}
/** Claude traffic the selected subject cannot claim, kept visible instead of silently dropped. */
export interface RepoHistoryClaudeCoverage {
  accounts: string[];
  /** Models whose actual-mode price is unknown, with the account that owns them. */
  unpriced: HistoryUnpriced[];
  /** Rows no verified account owns; range-wide evidence, never attached to this subject. */
  evidence: ClaudeProjectEvidence[];
  /**
   * Canonical calls excluded because their copies contradict each other: one entry per
   * verified ACCOUNT, counting distinct identities once for the whole selected range. It is
   * account-and-range evidence, not traffic of the selected subject: the copies may disagree
   * about the timestamp and the project, so these calls are in no bucket, no token, call,
   * activity or money total here. Present only when such calls exist.
   */
  conflicts?: ClaudeConflictingIdentities[];
}
export interface RepoHistory extends ContextPreviewResponse<RepoHistory> {
  subject: { kind: "project" | "repo"; id: string };
  repo: string | null;
  granularity: Granularity;
  by: Breakdown;
  idle_gap_minutes: number;
  since: string | null;
  until: string | null;
  vendor_coverage: Array<{ vendor: string; first: string | null; last: string | null }>;
  totals: {
    tokens: number;
    calls: number;
    active_seconds: number;
    active_by_machine: Record<string, number>;
    session_seconds: number;
    api_usd: number;
    api_complete: boolean;
    billed_usd: number | null;
    billed_complete: boolean;
    by_sub: Record<string, { api_usd: number; billed_usd: number | null }>;
  };
  points: RepoBucket[];
  /** Diagnostic; present when the range holds Claude traffic. Not part of any subject total. */
  claude?: RepoHistoryClaudeCoverage;
  /** Canonical Grok/GLM diagnostics; evidence and conflicts are never subject totals. */
  providers?: Array<{
    provider: ProjectFactProvider;
    accounts: string[];
    unpriced: HistoryUnpriced[];
    evidence: ProviderProjectEvidence[];
    conflicts?: ProviderProjectConflict[];
  }>;
  notes: string[];
}
export class UnsafeRepoHistorySum extends Error {}
function safeHistoryCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new UnsafeRepoHistorySum(`Unsafe repo-history ${what}`);
  return value;
}
function safeHistoryAmount(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) throw new UnsafeRepoHistorySum(`Unsafe repo-history ${what}`);
  return value;
}
function aggregateBilled(values: Iterable<number | null>): {
  billed_usd: number | null;
  billed_complete: boolean;
} {
  let complete = true;
  let seenNumeric = false;
  let sum = 0;
  let seen = false;
  for (const v of values) {
    seen = true;
    if (v == null) {
      complete = false;
      continue;
    }
    seenNumeric = true;
    sum += v;
  }
  if (!seen) return { billed_usd: 0, billed_complete: true };
  return { billed_usd: seenNumeric ? round2(sum) : null, billed_complete: complete };
}
/** Codex or other-provider OpenCode calls of one day, owner key, model and place, with their tokens and active time. */
interface HistoryCallRow {
  day: string; account: string | null; model: string | null; source: string | null;
  repo: string | null; group: string | null; project_id: string | null; tokens: number; calls: number; active_seconds: number;
}
/**
 * Codex from its price ledger's stored day cohorts (a session is its copy): calls, tokens and active time per pricing day,
 * dimension and owner, the owner being the verified account (D4) - or its business-credit pool - as for its money.
 */
function codexHistoryRows(sqlite: Database, resolver: AccountResolver, range: { since?: string; until?: string },
  idleGapMinutes: number): HistoryCallRow[] {
  if (!codexSumsPresent(sqlite)) return [];
  if (!codexLedgerPublished(sqlite)) throw new CodexLedgerNotReady("Codex price ledger is not published");
  const repoConfig = loadProjects().repo;
  const dims = readCodexPlaces(sqlite), rules = currentProjectRules(sqlite);
  return [...readCodexOwnedDays(sqlite, resolver, idleGapMinutes, range).values()].map(row => {
    const dim = dims.get(row.dim)!;
    return { day: row.day, account: resolveCodexSubId(row.owner), model: dim.model, source: dim.source, repo: dim.repo, group: deriveRepo(dim.cwd, repoConfig).group,
      project_id: placeProject(rules, "codex", dim, row.day), tokens: row.tokens, calls: row.calls, active_seconds: row.active_ms / 1000 };
  });
}
/** Every call of a source, whatever account periods say: OpenCode's other providers are not accounted by any plan. */
const OWN_EVERY_CALL = (provider: string): AccountReadPlan =>
  ({ provider, account: "*", identityKeys: [], ranges: [], owns: () => true, days: () => [] });
/**
 * OpenCode's providers outside the GLM plan from the usage ledger's stored day rows: calls, tokens (visible output: the
 * output total includes reasoning) and active time per day and dimension, the account being the OpenCode home.
 */
function otherHistoryRows(sqlite: Database, range: { since?: string; until?: string }, idleGapMinutes: number): HistoryCallRow[] {
  if (!requireUsageLedgerSums(sqlite, "glm")) return [];
  const activity = readActivityDays(sqlite, "glm", OWN_EVERY_CALL("glm"), idleGapMinutes, range, "o");
  return readOtherProviderDays(sqlite, [...GLM_RATE_VENDORS], range)
    .filter(row => row.calls > 0)
    .map(row => ({ day: row.day, account: row.home || null, model: row.model, source: row.source, repo: row.repo, group: row.repo_group,
      project_id: row.subject?.startsWith("p:") ? row.subject.slice(2) : null, tokens: row.tokens, calls: row.calls,
      active_seconds: (activity.get(activityDayKey(row.day, row.dim_id)) ?? 0) / 1000 }));
}
const GLM_RATE_VENDORS = new Set(["zai", "z-ai"]);
/** The selected subject: a project, a repository without a project, or any repository. */
function callSelected(call: Pick<HistoryCallRow, "repo" | "project_id">, opts: SubjectSelection): boolean {
  if (opts.projectId) return call.project_id === String(opts.projectId);
  if (opts.repo) return call.repo === opts.repo && call.project_id === null;
  return call.repo !== null;
}
/** Ledger calls folded into the bucket and key rows of the view. */
function ledgerBucketRows(vendor: string, calls: readonly HistoryCallRow[], opts: BucketOpts) {
  const merged = new Map<string, BucketRow>();
  for (const call of calls) {
    if (!callSelected(call, opts)) continue;
    const bucket = bucketOfDay(call.day, opts.granularity);
    const key = opts.by === "vendor" ? vendor : opts.by === "model" ? `${vendor}/${call.model ?? "?"}`
      : opts.by === "account" ? call.account ?? "?" : "";
    const id = `${bucket}\0${key}`;
    const current = merged.get(id) ?? { bucket, key, tokens: 0, calls: 0, active_seconds: 0, active_by_machine: {} };
    current.tokens = safeHistoryCount(current.tokens + call.tokens, `${vendor} token sum`);
    current.calls = safeHistoryCount(current.calls + call.calls, `${vendor} call sum`);
    current.active_seconds += call.active_seconds;
    addMachineSeconds(current.active_by_machine, opts.machineOf(call.source), call.active_seconds);
    merged.set(id, current);
  }
  return [...merged.values()];
}
type SubjectSelection = { repo: string | null; projectId?: string | null };
type BucketOpts = SubjectSelection & { granularity: Granularity; by: Breakdown; machineOf: (source: string | null) => string | null };
type BucketRow = { bucket: string; key: string; tokens: number; calls: number; active_seconds: number; active_by_machine: Record<string, number> };
/** The `active_by_machine` key of active time whose source names no computer. */
export const UNKNOWN_MACHINE = "?";
function addMachineSeconds(target: Record<string, number>, machine: string | null, seconds: number) {
  if (!seconds) return;
  const key = machine ?? UNKNOWN_MACHINE;
  target[key] = safeHistoryAmount((target[key] ?? 0) + seconds, "computer activity sum");
}
/** The fact-index equivalent of the raw subject filter: project first, then repo-without-project. */
function claudeRowSelected(row: HistoryRow, opts: SubjectSelection): boolean {
  if (opts.projectId) return row.subject === `p:${opts.projectId}`;
  if (opts.repo) return row.subject === `r:${opts.repo}`;
  // No subject selected: the same reach as `repo IS NOT NULL` had on the raw table.
  return row.repo !== null;
}
/** Prepared Claude day sums, folded into the same bucket/key rows the other vendors produce. */
function claudeBucketRows(usage: HistoryUsage, opts: BucketOpts) {
  const merged = new Map<string, BucketRow>();
  for (const row of usage.rows) {
    if (!claudeRowSelected(row, opts)) continue;
    const bucket = bucketOfDay(row.day, opts.granularity);
    const key = opts.by === "vendor" ? "claude"
      : opts.by === "model" ? `claude/${row.model ?? "?"}`
      : opts.by === "account" ? row.account : "";
    const id = `${bucket}\0${key}`;
    const current = merged.get(id) ?? { bucket, key, tokens: 0, calls: 0, active_seconds: 0, active_by_machine: {} };
    current.tokens = safeHistoryCount(current.tokens + row.tokens, "Claude bucket token sum");
    current.calls = safeHistoryCount(current.calls + row.calls, "Claude bucket call sum");
    current.active_seconds = safeHistoryAmount(current.active_seconds + row.active_seconds,
      "Claude bucket activity sum");
    addMachineSeconds(current.active_by_machine, opts.machineOf(row.source), row.active_seconds);
    merged.set(id, current);
  }
  return [...merged.values()];
}
function providerRowSelected(row: HistoryRow, opts: SubjectSelection): boolean {
  if (opts.projectId) return row.subject === `p:${opts.projectId}`;
  if (opts.repo) return row.subject === `r:${opts.repo}`;
  return row.repo !== null;
}
function providerBucketRows(usage: HistoryUsage, opts: BucketOpts) {
  const merged = new Map<string, BucketRow>();
  for (const row of usage.rows) {
    if (!providerRowSelected(row, opts)) continue;
    const bucket = bucketOfDay(row.day, opts.granularity);
    const key = opts.by === "vendor" ? usage.provider
      : opts.by === "model" ? `${usage.provider}/${row.model ?? "?"}`
      : opts.by === "account" ? row.account : "";
    const id = `${bucket}\0${key}`;
    const current = merged.get(id) ?? { bucket, key, tokens: 0, calls: 0, active_seconds: 0, active_by_machine: {} };
    current.tokens = safeHistoryCount(current.tokens + row.tokens, "provider bucket token sum");
    current.calls = safeHistoryCount(current.calls + row.calls, "provider bucket call sum");
    current.active_seconds = safeHistoryAmount(current.active_seconds + row.active_seconds,
      "provider bucket activity sum");
    addMachineSeconds(current.active_by_machine, opts.machineOf(row.source), row.active_seconds);
    merged.set(id, current);
  }
  return [...merged.values()];
}
function vendorCoverage(sqlite: Database, g: Granularity) {
  const raw = SOURCES.map((s) => {
    if (s.vendor === "claude") {
      const span = claudeSourceDayBounds(sqlite);
      return { vendor: s.vendor, first: span.first && bucketOfDay(span.first, g), last: span.last && bucketOfDay(span.last, g) };
    }
    const span = s.vendor === "codex" ? codexSumsPresent(sqlite) ? codexLedgerDayBounds(sqlite) : { first: null, last: null }
      : ledgerDayBounds(sqlite, "opencode", "other");
    return { vendor: s.vendor, first: span.first && bucketOfDay(span.first, g), last: span.last && bucketOfDay(span.last, g) };
  });
  const canonical = (["grok", "glm"] as const).map((provider) => {
    const span = providerSourceDayBounds(sqlite, provider);
    return { vendor: provider, first: span.first && bucketOfDay(span.first, g),
      last: span.last && bucketOfDay(span.last, g) };
  });
  return [...raw, ...canonical];
}
export type RepoHistoryOpts = {
  contextPreview?: boolean;
  repo: string | null;
  projectId?: string | null;
  granularity: Granularity;
  by: Breakdown;
  idleGapMinutes: number;
  since?: string;
  until?: string;
  rateCards?: RateCard;
  /** Prices the account plan periods; the project cost reads the same catalog. */
  plansCatalog?: PlansCatalog;
  homeToSubId?: Map<string, string>;
  declarations?: readonly IdentityDeclaration[];
  /** Account mapping version; must match the one the Claude fact producer prepared with. */
  eras?: EraIndex;
  /** The computer of a ledger source; defaults to the `accounts.json` declarations (`sourceMachineResolver`). */
  machineOf?: (source: string | null) => string | null;
};
export class HistoryAbortedError extends Error {
  constructor() {
    super("repo-history aborted");
    this.name = "HistoryAbortedError";
  }
}
export type HistoryCancel = {
  signal?: AbortSignal;
  onCheckpoint?: (phase: string) => void;
};
/** One report invocation owns these inputs; neither context nor any later request can change their meaning. */
interface RepoHistoryInputs {
  providers?: Map<"claude" | ProjectFactProvider, HistoryUsage>;
  codex?: HistoryCallRow[];
  other?: HistoryCallRow[];
  activity?: ReturnType<typeof readProjectActivity>;
}
function finishRepoHistory(gen: Generator<string, RepoHistory>): RepoHistory {
  while (true) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}
export function buildRepoHistory(sqlite: Database, opts: RepoHistoryOpts): RepoHistory {
  if (!opts.contextPreview) return finishRepoHistory(repoHistorySteps(sqlite, opts));
  const inputs: RepoHistoryInputs = {};
  return withContextPreview(sqlite, () => finishRepoHistory(repoHistorySteps(sqlite, opts, inputs)), opts.contextPreview);
}
export async function buildRepoHistoryCancellable(
  sqlite: Database,
  opts: RepoHistoryOpts,
  cancel?: HistoryCancel,
): Promise<RepoHistory> {
  if (!opts.contextPreview || inContextRead(sqlite)) return readRepoHistoryCancellable(sqlite, opts, cancel);
  const fence = () => JSON.stringify([(sqlite.query("PRAGMA data_version").get() as {data_version:number}).data_version,
    (sqlite.query("SELECT total_changes() n").get() as {n:number}).n, projectRulesStamp(sqlite)]);
  const before = fence(), reader = contextPreviewReader(sqlite), inputs: RepoHistoryInputs = {};
  const base = reader.status.ready
    ? await captureContextReadAsync(reader.scope, () => readRepoHistoryCancellable(sqlite, opts, cancel, inputs))
    : await readRepoHistoryCancellable(sqlite, opts, cancel, inputs);
  if (!reader.status.ready) return { ...base, context_preview_status: reader.status } as RepoHistory;
  const preview = await runContextRead(reader.scope, () => readRepoHistoryCancellable(sqlite, opts, cancel, inputs));
  const after = contextPreviewReader(sqlite).status;
  if (!after.ready || after.revision !== reader.status.revision || before !== fence())
    return { ...base, context_preview_status: { ...reader.status, ready: false } } as RepoHistory;
  return { ...base, context_preview: preview, context_preview_status: reader.status } as RepoHistory;
}
async function readRepoHistoryCancellable(sqlite: Database, opts: RepoHistoryOpts, cancel?: HistoryCancel, inputs: RepoHistoryInputs = {}): Promise<RepoHistory> {
  if (cancel?.signal?.aborted) throw new HistoryAbortedError();
  const gen = repoHistorySteps(sqlite, opts, inputs);
  while (true) {
    const step = gen.next();
    if (step.done) return step.value;
    cancel?.onCheckpoint?.(step.value);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (cancel?.signal?.aborted) throw new HistoryAbortedError();
  }
}
/** The configured dated rates; the Claude valuations are registered against exactly these. */
function configuredRateCards(): RateCard {
  try {
    return loadRateCard(configFile("rate-cards.json"));
  } catch {
    return { version: 1, currency: "USD", unit: "per 1M", vendors: {} };
  }
}
function* repoHistorySteps(sqlite: Database, opts: RepoHistoryOpts, inputs: RepoHistoryInputs = {}): Generator<string, RepoHistory> {
  const rateCards = opts.rateCards ?? configuredRateCards();
  const homeToSubId: Map<string, string> =
    opts.homeToSubId ??
    (() => {
      const config = readAccountsV2(configFile("accounts.json"));
      const resolver = loadAccountResolver(sqlite, config.subscriptions);
      const sources = config.sources.map(source => ({...source, home: expandPath(source.home),
        ...(source.source_home ? {source_home: expandPath(source.source_home)} : {})}));
      const now = new Date().toISOString();
      const entries: Array<[string,string]> = [];
      for (const source of sources.filter(source => source.vendor === "codex")) {
        const folder = archiveFolderOf(source.home, ARCHIVE_LOGICAL_ROOT)?.key;
        const account = folder ? resolver.resolve("codex", folder, null, now).account : null;
        if (account) for (const home of [source.home, source.source_home]) if (home) entries.push([home.toLowerCase(),account]);
      }
      return restoreSubscriptionHomes(entries,codexPhysicalSourceHomes(sources),sources);
    })();
  const hasCodex = codexSumsPresent(sqlite);
  const ledger = hasCodex ? codexLedgerReadContext(rateCards) : undefined;
  const nativeRange={since:opts.since,until:opts.until,dependencyBases:['api_equivalent_usd'] as const};
  if (ledger) { const pending=codexLedgerPendingReason(sqlite,{...ledger,range:nativeRange}); if(pending) throw new SubscriptionFactsPending(`Codex history is awaiting background preparation (${pending})`,"codex"); }
  const resolver = loadAccountResolver(sqlite, opts.declarations);
  const range = { since: opts.since, until: opts.until };
  // One shared Claude result for this range: the tokens, activity and money below are the
  // same stored sums, so the selector, the buckets and the totals cannot disagree.
  const providerCache = inputs.providers ??= new Map<"claude" | ProjectFactProvider, HistoryUsage>();
  const claude = () => providerUsage("claude");
  const providerUsage = (provider: "claude" | ProjectFactProvider) => {
    const hit = providerCache.get(provider);
    if (hit) return hit;
    const value = storedHistoryUsage(sqlite, provider, rateCards, { ...range, idleGapMinutes: opts.idleGapMinutes, resolver });
    providerCache.set(provider, value);
    return value;
  };
  /** Buckets where the selected subject holds traffic with no known actual-mode price. */
  const apiIncomplete = new Set<string>();
  /** Bucket -> verified accounts with calls of the selected subject here, whatever they were priced at. */
  const claimed = new Map<string, Set<string>>();
  /**
   * Accounts whose fee cannot be split by api_usd: canonical traffic (Claude, Grok, GLM) partly unpriced or
   * excluded as conflicting copies. The same rule as the project cost, which these shares must add up to.
   */
  const unallocatable = new Set<string>();
  const merged = new Map<string, RepoBucket>();
  const totals = {
    tokens: 0,
    calls: 0,
    active_seconds: 0,
    active_by_machine: {} as Record<string, number>,
    session_seconds: 0,
    api_usd: 0,
    api_complete: true,
    billed_usd: 0 as number | null,
    billed_complete: true,
    by_sub: {} as Record<string, { api_usd: number; billed_usd: number | null }>,
  };
  const bucketOpts: BucketOpts = { ...opts, machineOf: opts.machineOf ?? sourceMachineResolver() };
  const addMachines = (target: Record<string, number>, parts: Record<string, number>) => {
    for (const [machine, seconds] of Object.entries(parts)) addMachineSeconds(target, machine, seconds);
  };
  for (const src of SOURCES) {
    const rows = src.vendor === "claude"
      ? claudeBucketRows(claude(), bucketOpts)
      : src.vendor === "codex" ? ledgerBucketRows("codex", inputs.codex ??= codexHistoryRows(sqlite, resolver, range, opts.idleGapMinutes), bucketOpts)
      : ledgerBucketRows("opencode", inputs.other ??= otherHistoryRows(sqlite, range, opts.idleGapMinutes), bucketOpts);
    // Seconds keep their fractions (stored milliseconds) all the way into the response: four calls a third of a second
    // apart, split over four models, are one second of work, not four rounded zeroes.
    const seconds = (value: number) => value || 0;
    for (const r of rows) {
      let b = merged.get(r.bucket);
      if (!b) {
        b = {
          bucket: r.bucket,
          tokens: 0,
          calls: 0,
          active_seconds: 0,
          active_by_machine: {},
          session_seconds: 0,
          api_usd: 0,
          api_complete: true,
          billed_usd: 0,
          billed_complete: true,
          by_sub: {},
        };
        if (opts.by !== "none") b.split = {};
        merged.set(r.bucket, b);
      }
      b.tokens = safeHistoryCount(b.tokens + (r.tokens || 0), `${src.vendor} bucket token sum`);
      b.calls = safeHistoryCount(b.calls + (r.calls || 0), `${src.vendor} bucket call sum`);
      b.active_seconds = safeHistoryAmount(b.active_seconds + seconds(r.active_seconds),
        `${src.vendor} bucket activity sum`);
      addMachines(b.active_by_machine, r.active_by_machine);
      addMachines(totals.active_by_machine, r.active_by_machine);
      if (opts.by !== "none" && b.split) {
        const cur = b.split[r.key] ?? { tokens: 0, calls: 0, active_seconds: 0 };
        cur.tokens = safeHistoryCount(cur.tokens + (r.tokens || 0), `${src.vendor} split token sum`);
        cur.calls = safeHistoryCount(cur.calls + (r.calls || 0), `${src.vendor} split call sum`);
        cur.active_seconds = safeHistoryAmount(cur.active_seconds + seconds(r.active_seconds),
          `${src.vendor} split activity sum`);
        b.split[r.key] = cur;
      }
      totals.tokens = safeHistoryCount(totals.tokens + (r.tokens || 0), "combined token total");
      totals.calls = safeHistoryCount(totals.calls + (r.calls || 0), "combined call total");
      totals.active_seconds = safeHistoryAmount(totals.active_seconds + seconds(r.active_seconds),
        "combined activity total");
    }
    yield `sources:${src.vendor}`;
  }
  for (const provider of ["grok", "glm"] as const) {
    for (const r of providerBucketRows(providerUsage(provider), bucketOpts)) {
      let b = merged.get(r.bucket);
      if (!b) {
        b = { bucket: r.bucket, tokens: 0, calls: 0, active_seconds: 0, active_by_machine: {}, session_seconds: 0, api_usd: 0,
          api_complete: true, billed_usd: 0, billed_complete: true, by_sub: {} };
        if (opts.by !== "none") b.split = {};
        merged.set(r.bucket, b);
      }
      b.tokens = safeHistoryCount(b.tokens + r.tokens, `${provider} bucket token sum`);
      b.calls = safeHistoryCount(b.calls + r.calls, `${provider} bucket call sum`);
      b.active_seconds = safeHistoryAmount(b.active_seconds + r.active_seconds,
        `${provider} bucket activity sum`);
      addMachines(b.active_by_machine, r.active_by_machine);
      addMachines(totals.active_by_machine, r.active_by_machine);
      if (opts.by !== "none" && b.split) {
        const current = b.split[r.key] ?? { tokens: 0, calls: 0, active_seconds: 0 };
        current.tokens = safeHistoryCount(current.tokens + r.tokens, `${provider} split token sum`);
        current.calls = safeHistoryCount(current.calls + r.calls, `${provider} split call sum`);
        current.active_seconds = safeHistoryAmount(current.active_seconds + r.active_seconds,
          `${provider} split activity sum`);
        b.split[r.key] = current;
      }
      totals.tokens = safeHistoryCount(totals.tokens + r.tokens, "combined provider token total");
      totals.calls = safeHistoryCount(totals.calls + r.calls, "combined provider call total");
      totals.active_seconds = safeHistoryAmount(totals.active_seconds + r.active_seconds,
        "combined provider activity total");
    }
    yield `sources:${provider}`;
  }
  const subBucketProjApi = new Map<string, Map<string, number>>();
  const globalPeriodRows = new Map<string, PeriodUsageRow[]>();
  const globalSubSpan = new Map<string, { first: string; last: string }>();
  /** Account -> the provider its plan periods are filed under. */
  const subVendor = new Map<string, string>();
  const noteAccountDay = (vendor: string, subId: string, day: string) => {
    if (!subVendor.has(subId)) subVendor.set(subId, vendor);
    const cur = globalSubSpan.get(subId) ?? { first: day, last: day };
    if (day < cur.first) cur.first = day;
    if (day > cur.last) cur.last = day;
    globalSubSpan.set(subId, cur);
  };
  const addPeriodRow = (subId: string, row: PeriodUsageRow) => {
    const rows = globalPeriodRows.get(subId) ?? [];
    rows.push(row); globalPeriodRows.set(subId, rows);
  };
  const addProjApi = (bucket: string, subId: string, usd: number) => {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const m = subBucketProjApi.get(bucket) ?? new Map<string, number>();
    m.set(subId, (m.get(subId) ?? 0) + usd);
    subBucketProjApi.set(bucket, m);
  };
  if (ledger) {
    // This fold consumes Standard API only; credit and actual-mode variants have no reader here.
    const all = readCodexLedgerOwnedSeries(sqlite, nativeRange, resolver, ledger, ["api_standard"] as const);
    const sums = new Map<string, { bucket: string; day: string; subId: string; subject: string | null; amount: Rational; selected: boolean }>();
    for (const { group, account } of all) {
      // Duplicate copies were resolved when the ledger was built.
      if (!group.selected) continue;
      const row = group.stored, bucket = bucketOfDay(row.day, opts.granularity), subId = resolveCodexSubId(account);
      const selected = opts.projectId ? String(row.project_id ?? "") === String(opts.projectId)
        : opts.repo ? row.repo === opts.repo && (row.project_id === null || String(row.project_id) === "")
        : row.repo !== null;
      const key = JSON.stringify([bucket, row.day, subId, row.subject, selected]);
      const sum = sums.get(key) ?? { bucket, day: row.day, subId, subject: row.subject, selected, amount: rational(0n) };
      sum.amount = add(sum.amount, group.variants.api_standard.pricedSubtotal); sums.set(key, sum);
      // Use the same allocation population as project cost, preserving unknown weights and zero calls.
      if (codexPlanAllocationEligible(row.model)) {
        const value = group.variants.api_standard.value;
        addPeriodRow(subId, { subject: row.subject ?? "", day: row.day,
          calls: value === null ? 0 : Number(group.calls), tokens: value === null ? 0 : Number(group.tokensReported),
          amount: value ?? rational(0n), incomplete: value === null });
      }
      if (selected && group.variants.api_standard.unpricedEvents > 0n) apiIncomplete.add(bucket);
      // Calls priced at nothing still keep the account in this bucket's by_sub, so an unknown fee reads null, not 0.
      if (selected && group.calls > 0n) {
        const accounts = claimed.get(bucket) ?? new Set<string>();
        accounts.add(subId);
        claimed.set(bucket, accounts);
      }
    }
    for (const sum of sums.values()) {
      const usd = ledgerPresentationNumber(sum.amount);
      noteAccountDay("codex", sum.subId, sum.day);
      if (sum.selected) addProjApi(sum.bucket, sum.subId, usd);
    }
  }
  yield "dollars:codex";
  // Claude money is the registered, actual-mode valuation of the canonical facts, filed under
  // the verified subscription that owns the call. Copies are counted once, no row is filed
  // under a literal 'claude' bucket, and nothing here prices a raw event again.
  for (const row of claude().rows) {
    const bucket = bucketOfDay(row.day, opts.granularity);
    noteAccountDay("claude", row.account, row.day);
    addPeriodRow(row.account, { subject: row.subject ?? "", day: row.day, calls: row.calls, tokens: row.tokens,
      amount: String(row.api_usd), incomplete: row.unpriced_calls > 0 });
    if (!claudeRowSelected(row, opts)) continue;
    addProjApi(bucket, row.account, row.api_usd);
    // A verified account that made canonical calls here stays in by_sub even when its whole
    // subtotal is zero: an absent price is not a complete zero, and neither is an empty call.
    if (row.calls > 0) {
      const accounts = claimed.get(bucket) ?? new Set<string>();
      accounts.add(row.account);
      claimed.set(bucket, accounts);
    }
    // Counted traffic without a known price leaves this bucket's api_usd a subtotal.
    if (row.unpriced_calls > 0) apiIncomplete.add(bucket);
  }
  for (const item of claude().unpriced) unallocatable.add(item.account);
  // Calls excluded because their copies contradict each other are missing from this account's
  // api_usd weights entirely, so its fee cannot be split by them either. The fee stays
  // published; nothing here invents tokens, a price or an owning project for them.
  for (const item of claude().conflicts) unallocatable.add(item.account);
  yield "dollars:claude";
  for (const provider of ["grok", "glm"] as const) {
    const usage = providerUsage(provider);
    for (const row of usage.rows) {
      const bucket = bucketOfDay(row.day, opts.granularity);
      noteAccountDay(provider, row.account, row.day);
      addPeriodRow(row.account, { subject: row.subject ?? "", day: row.day, calls: row.calls, tokens: row.tokens,
        amount: String(row.api_usd), incomplete: row.unpriced_calls > 0 });
      if (!providerRowSelected(row, opts)) continue;
      addProjApi(bucket, row.account, row.api_usd);
      if (row.calls > 0) {
        const accounts = claimed.get(bucket) ?? new Set<string>();
        accounts.add(row.account);
        claimed.set(bucket, accounts);
      }
      if (row.unpriced_calls > 0) apiIncomplete.add(bucket);
    }
    for (const item of usage.unpriced) unallocatable.add(item.account);
    for (const item of usage.conflicts) unallocatable.add(item.account);
  }
  yield "dollars:providers";
  const totalBySub = new Map<string, { api_usd: number; billed_usd: number | null }>();
  const incompleteBilledBuckets = new Set<string>();
  let billedComplete = true;
  const bucketList = Array.from(merged.keys()).sort();
  const subIds = new Set<string>();
  for (const m of subBucketProjApi.values()) {
    for (const id of m.keys()) subIds.add(id);
  }
  for (const accounts of claimed.values()) {
    for (const id of accounts) subIds.add(id);
  }
  // The bill each account splits is the project cost's: its plan periods priced by the Plans catalog over the
  // days the account was used in the range, the rate-card price only for days no plan period covers.
  // The same index as the project cost, so a billing cycle inferred after a declared end is priced here too.
  const pricing = planPricingInputs(sqlite, opts.plansCatalog ?? loadPlansCatalog());
  for (const subId of subIds) {
    const span = globalSubSpan.get(subId) ?? null;
    const vendor = subVendor.get(subId) ?? subId;
    const { stretches } = subscriptionPlanPricing(sqlite, rateCards, pricing, { id: subId, vendor }, span, resolver);
    const present = bucketList.filter((bucket) =>
      (subBucketProjApi.get(bucket)?.get(subId) ?? 0) > 0 || claimed.get(bucket)?.has(subId));
    if (present.length === 0) continue;
    const apis = present.map((bucket) => subBucketProjApi.get(bucket)?.get(subId) ?? 0);
    const focusKey = opts.projectId ? `p:${opts.projectId}` : opts.repo ? `r:${opts.repo}` : null;
    const apiAlloc = allocateCents(apis);
    const rows = globalPeriodRows.get(subId) ?? [];
    const usage = stretches.length === 1 ? [sumPlanPeriodRows(rows)]
      : readPlanPeriodsUsage(sqlite, rateCards, resolver, { id: subId, vendor }, stretches, rows);
    if (stretches.length === 1 && unallocatable.has(subId)) usage[0]!.incomplete = true;
    const subjects = [...new Set([...usage.flatMap(period => [...period.groups.keys()]), "", ...(focusKey ? [focusKey] : [])])];
    const dated = allocatePlanPeriods(stretches, subjects, (_, index) => usage[index]!);
    const selected = subjects.filter(subject => focusKey ? subject === focusKey : subject !== "");
    const periodBills = stretches.map((_, index) => aggregateBilled(selected.map(subject => dated.get(subject)![index]!.billed_usd)));
    const bucketBills = new Map(present.map(bucket => [bucket, [] as Array<number | null>]));
    // Conserve each dated project's cents before placing them in calendar buckets.
    // Unknown periods retain their own completeness instead of erasing known subtotals.
    for (let index = 0; index < stretches.length; index++) {
      const piece = stretches[index]!, bill = periodBills[index]!;
      const weights = new Map<string, number>();
      if (stretches.length === 1) for (const bucket of present) weights.set(bucket, subBucketProjApi.get(bucket)?.get(subId) ?? 0);
      else for (const row of usage[index]!.rows ?? []) {
        if (!selected.includes(row.subject)) continue;
        const bucket = bucketOfDay(row.day, opts.granularity);
        const amount = typeof row.amount === "string" ? Number(row.amount) : ledgerPresentationNumber(row.amount);
        weights.set(bucket, (weights.get(bucket) ?? 0) + amount);
      }
      const allocated = bill.billed_usd === null ? new Map<string, number>()
        : allocatePaidAcrossSubjects(weights, bill.billed_usd);
      const first = bucketOfDay(new Date(piece.fromMs).toISOString().slice(0, 10), opts.granularity);
      const last = bucketOfDay(new Date(piece.untilMs - 1).toISOString().slice(0, 10), opts.granularity);
      for (const bucket of present) {
        if (!weights.has(bucket) && (bucket < first || bucket > last)) continue;
        bucketBills.get(bucket)!.push(bill.billed_usd === null ? null : allocated.get(bucket) ?? 0);
        if (!bill.billed_complete) incompleteBilledBuckets.add(bucket);
      }
    }
    let totApi = 0;
    for (let i = 0; i < present.length; i++) {
      const bucket = present[i]!;
      const b = merged.get(bucket);
      if (!b) continue;
      const api = apiAlloc[i] ?? 0;
      const amounts = bucketBills.get(bucket)!;
      const billed = amounts.length ? aggregateBilled(amounts).billed_usd : stretches.length ? 0 : null;
      if (!b.by_sub) b.by_sub = {};
      b.by_sub[subId] = { api_usd: api, billed_usd: billed };
      totApi += api;
    }
    const totalBill = aggregateBilled(periodBills.map(bill => bill.billed_usd));
    billedComplete &&= stretches.length > 0 && periodBills.every(bill => bill.billed_complete);
    totalBySub.set(subId, {
      api_usd: round2(totApi),
      billed_usd: stretches.length ? totalBill.billed_usd : null,
    });
  }
  // The displayed amount of a bucket is the rounded sum of the original amounts, not the sum
  // of the per-account cents: two accounts at 0.0054 each are a cent together, not two.
  // by_sub keeps its own cent allocation, which stays exact per account across its buckets.
  // Conflicting-copy exclusions are account-wide and range-wide, and their timestamps are
  // exactly what the copies disagree about. Rather than guess a bucket - or pretend the
  // selected project did not own the excluded call - the whole selected range reports
  // incomplete API value while any such evidence exists.
  const providerUnknown = (["grok", "glm"] as const).some((provider) => {
    const usage = providerUsage(provider);
    return usage.conflicts.length > 0 || usage.evidence.length > 0;
  });
  const conflicted = claude().conflicts.length > 0 || providerUnknown;
  let exactTotalApi = 0;
  for (const b of merged.values()) {
    if (!b.by_sub) b.by_sub = {};
    let bucketApi = 0;
    for (const usd of subBucketProjApi.get(b.bucket)?.values() ?? []) bucketApi += usd;
    exactTotalApi += bucketApi;
    b.api_usd = round2(bucketApi);
    b.api_complete = !conflicted && !apiIncomplete.has(b.bucket);
    const billedAgg = aggregateBilled(Object.values(b.by_sub).map((v) => v.billed_usd));
    b.billed_usd = billedAgg.billed_usd;
    b.billed_complete = billedAgg.billed_complete && !incompleteBilledBuckets.has(b.bucket);
  }
  totals.api_usd = round2(exactTotalApi);
  totals.api_complete = !conflicted && apiIncomplete.size === 0;
  const totalsBilled = aggregateBilled(Array.from(totalBySub.values()).map((v) => v.billed_usd));
  totals.billed_usd = totalsBilled.billed_usd;
  totals.billed_complete = totalsBilled.billed_complete && billedComplete;
  totals.by_sub = Object.fromEntries(totalBySub.entries());
  // Wall time is a union across all sessions/providers on each computer, independent of the money cohorts.
  const activity = (inputs.activity ??= readProjectActivity(sqlite, resolver, rateCards, opts.idleGapMinutes, range))
    .filter(row => opts.projectId ? row.subject === `p:${opts.projectId}` : opts.repo ? row.subject === `r:${opts.repo}` : row.repo !== null);
  // The additive session sums gathered above stay as session_seconds before the union replaces active_seconds.
  totals.session_seconds = totals.active_seconds;
  totals.active_seconds = 0;
  totals.active_by_machine = {};
  for (const bucket of merged.values()) {
    bucket.session_seconds = bucket.active_seconds;
    bucket.active_seconds = 0; bucket.active_by_machine = {};
    for (const part of Object.values(bucket.split ?? {})) part.active_seconds = 0;
  }
  const addActivity = (rows: typeof activity, split?: string) => {
    for (const [day, machines] of activityByDay(rows, bucketOpts.machineOf)) {
      const key = bucketOfDay(day, opts.granularity);
      const bucket = merged.get(key) ?? { bucket: key, tokens: 0, calls: 0, active_seconds: 0, active_by_machine: {},
        session_seconds: 0, api_usd: 0, api_complete: !conflicted, billed_usd: 0, billed_complete: true, by_sub: {} } as RepoBucket;
      merged.set(key, bucket);
      const seconds = [...machines.values()].reduce((sum, spans) => sum + intervalSeconds(spans), 0);
      if (split !== undefined) {
        bucket.split ??= {};
        const part = bucket.split[split] ?? { tokens: 0, calls: 0, active_seconds: 0 };
        part.active_seconds += seconds; bucket.split[split] = part;
      } else {
        bucket.active_seconds += seconds; totals.active_seconds += seconds;
        for (const [machine, spans] of machines) {
          addMachineSeconds(bucket.active_by_machine, machine, intervalSeconds(spans));
          addMachineSeconds(totals.active_by_machine, machine, intervalSeconds(spans));
        }
      }
    }
  };
  addActivity(activity);
  if (opts.by !== "none") {
    const splits = new Map<string, typeof activity>();
    for (const row of activity) {
      const key = opts.by === "vendor" ? row.vendor : opts.by === "model" ? `${row.vendor}/${row.model ?? "?"}` : row.account ?? "?";
      const rows = splits.get(key) ?? []; rows.push(row); splits.set(key, rows);
    }
    for (const [key, rows] of splits) addActivity(rows, key);
  }
  const points = Array.from(merged.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const notes = [
    "active_seconds is ESTIMATED: idle-capped session intervals merged across sessions and providers per computer, split at UTC midnight. Parallel computers add up; parallel agents on one computer count once. Unknown computers share the '?' group.",
    "session_seconds is the additive agent-session time (sum of idle-capped gaps per session); parallel sessions add up, so it can exceed active_seconds.",
    "The repo ranking by active time holds at 5/15/30/60-minute cutoffs for the top four repos and starts swapping at rank five - show the cutoff, do not hide it.",
    "Weekly and monthly buckets are calendar buckets (Monday-based weeks, calendar months). They are not reset-anchored windows.",
    "billed_usd in each calendar bucket is the project's allocated share of that subscription's plan cost (account plan periods priced by the Plans catalog, the rate-card price only for uncovered days, prorated), the same share /api/project-cost publishes; it is not invoice or payment evidence. null means the bill or its split is unknown, never zero.",
    "gemini is not represented: gemini_events records a workspace name, not a working directory, so it carries no repo.",
    "A bucket missing for a vendor before its first_ts in vendor_coverage means NO DATA, not zero usage.",
    "claude buckets are canonical UTC days: its tokens, calls, activity and money come from the shared, account-scoped fact index and its registered valuations, per verified subscription, not per store.",
    "claude active_seconds bridges two calls only inside one verified account and one session id; a call whose source recorded no session bridges nothing.",
  ];
  const claudeCoverage = claude();
  if (claudeCoverage.unpriced.length > 0) {
    notes.push(
      `claude traffic without a known actual-mode price: ${claudeCoverage.unpriced
        .map((item) => `${item.account}/${item.model} (${item.reason}, ${item.tokens} tok., ${item.calls} calls)`)
        .join(", ")}. Where this traffic belongs to the selected subject, its tokens and calls are counted and api_usd is a subtotal (api_complete=false). Those accounts' fees are not split (billed_usd=null).`
    );
  }
  if (claudeCoverage.evidence.length > 0) {
    notes.push(
      `claude rows without a verified account: ${claudeCoverage.evidence
        .map((item) => `${item.reason} (${item.tokens} tok., ${item.calls} calls)`)
        .join(", ")}. They are range-wide source evidence and are NOT counted in this subject's tokens, calls, activity or money.`
    );
  }
  if (claudeCoverage.conflicts.length > 0) {
    notes.push(
      `claude calls excluded because their copies contradict each other: ${claudeCoverage.conflicts
        .map((item) => `${item.account} (${item.identities} identities)`)
        .join(", ")}. This counts distinct calls of the whole ACCOUNT over the whole selected range, once each - it is not traffic of the selected subject, and it is not a number of counted calls. Their tokens, timestamps, subjects and prices are UNKNOWN, so they are in no bucket and in no total here; because their timestamps are what the copies disagree about, every bucket of this range reports api_complete=false and those accounts' fees are not split (billed_usd=null).`
    );
  }
  const providerDiagnostics = (["grok", "glm"] as const).map((provider) => providerUsage(provider));
  for (const usage of providerDiagnostics) {
    if (usage.unpriced.length > 0) notes.push(
      `${usage.provider} traffic without a configured API price: ${usage.unpriced
        .map((item) => `${item.account}/${item.model} (${item.reason}, ${item.tokens} tok., ${item.calls} calls)`)
        .join(", ")}. Reported vendor money is separate evidence and is never substituted for api_usd; affected account fees are not split.`);
    if (usage.evidence.length > 0) notes.push(
      `${usage.provider} rows without a canonical account: ${usage.evidence
        .map((item) => `${item.reason} (${item.tokens} tok., ${item.calls} calls)`)
        .join(", ")}. They are range-wide evidence and are not assigned to this subject.`);
    if (usage.conflicts.length > 0) notes.push(
      `${usage.provider} calls excluded because canonical copies conflict: ${usage.conflicts
        .map((item) => `${item.account} (${item.identities} identities)`)
        .join(", ")}. Tokens, timestamps, subjects and prices are unknown; every bucket is incomplete and affected fees are not split.`);
  }
  return {
    subject: opts.projectId
      ? { kind: "project", id: opts.projectId }
      : { kind: "repo", id: opts.repo! },
    repo: opts.repo,
    granularity: opts.granularity,
    by: opts.by,
    idle_gap_minutes: opts.idleGapMinutes,
    since: opts.since ?? null,
    until: opts.until ?? null,
    vendor_coverage: vendorCoverage(sqlite, opts.granularity),
    totals,
    points,
    // An account whose every identity was excluded has no accepted row, no bucket and no
    // subtotal; its exclusions must still be published, so they open this diagnostic too.
    ...(claudeCoverage.accounts.length || claudeCoverage.unpriced.length || claudeCoverage.evidence.length
      || claudeCoverage.conflicts.length
      ? { claude: { accounts: claudeCoverage.accounts, unpriced: claudeCoverage.unpriced,
          evidence: claudeCoverage.evidence as ClaudeProjectEvidence[],
          ...(claudeCoverage.conflicts.length ? { conflicts: claudeCoverage.conflicts as ClaudeConflictingIdentities[] } : {}) } }
      : {}),
    ...(providerDiagnostics.some((usage) => usage.accounts.length || usage.unpriced.length
      || usage.evidence.length || usage.conflicts.length)
      ? { providers: providerDiagnostics.map((usage) => ({ provider: usage.provider as ProjectFactProvider,
          accounts: usage.accounts, unpriced: usage.unpriced, evidence: usage.evidence as ProviderProjectEvidence[],
          ...(usage.conflicts.length ? { conflicts: usage.conflicts as ProviderProjectConflict[] } : {}) })) }
      : {}),
    notes,
  };
}
export interface SubjectRow {
  kind: "project" | "repo";
  id: string;
  name: string;
  group: string | null;
  tokens: number;
  calls: number;
  /** May be fractional, and equals the history totals of the same subject and range. */
  active_seconds: number;
  /** Additive agent-session time, retained separately from the per-computer wall time. */
  session_seconds: number;
  repos: string[];
}
/**
 * The selector reads the same prepared Claude sums as the history, so a project can never be
 * listed with tokens, calls or active time that its own history does not show.
 */
export function listSubjects(
  sqlite: Database,
  idleGapMinutes: number,
  range?: { since?: string; until?: string },
  options?: { eras?: EraIndex; rateCards?: RateCard; declarations?:readonly IdentityDeclaration[]; homeToSubId?: Map<string, string>;
    machineOf?: (source: string | null) => string | null }
): SubjectRow[] {
  const acc = new Map<string, SubjectRow>();
  const resolver = loadAccountResolver(sqlite, options?.declarations);
  const displayName = new Map<string, string>();
  try {
    for (const proj of loadProjects().projects) {
      if (proj.id && proj.name) displayName.set(proj.id, proj.name);
    }
  } catch {
  }
  const absorb = (r: { subject: string; repo: string | null; grp: string | null;
    tokens: number; calls: number; active_seconds: number }) => {
    const kind = r.subject.startsWith("p:") ? "project" : "repo";
    const id = r.subject.slice(2);
    const cur =
      acc.get(r.subject) ??
      ({
        kind,
        id,
        name: (kind === "project" ? displayName.get(id) : null) ?? id,
        group: r.grp,
        tokens: 0,
        calls: 0,
        active_seconds: 0,
        session_seconds: 0,
        repos: [],
      } as SubjectRow);
    cur.tokens = safeHistoryCount(cur.tokens + (r.tokens || 0), "subject selector token sum");
    cur.calls = safeHistoryCount(cur.calls + (r.calls || 0), "subject selector call sum");
    // Exact seconds, so selector and history agree.
    cur.active_seconds = safeHistoryAmount(cur.active_seconds + (r.active_seconds || 0), "subject selector activity sum");
    if (!cur.group) cur.group = r.grp;
    if (kind === "project" && r.repo && !cur.repos.includes(r.repo)) cur.repos.push(r.repo);
    acc.set(r.subject, cur);
  };
  const cards = options?.rateCards ?? configuredRateCards();
  // Codex and other-provider OpenCode from their ledgers; a call counts for its project, else its repository.
  const subjectRows = (vendor: "codex" | "opencode") => {
    const rows = new Map<string, { subject: string; repo: string | null; grp: string | null; tokens: number; calls: number; active_seconds: number }>();
    for (const call of vendor === "codex" ? codexHistoryRows(sqlite, resolver, range ?? {}, idleGapMinutes) : otherHistoryRows(sqlite, range ?? {}, idleGapMinutes)) {
      if (call.repo === null && call.project_id === null) continue;
      const subject = call.project_id !== null ? `p:${call.project_id}` : `r:${call.repo}`;
      const key = `${subject}\0${call.repo ?? ""}\0${call.group ?? ""}`;
      const current = rows.get(key) ?? { subject, repo: call.repo, grp: call.group, tokens: 0, calls: 0, active_seconds: 0 };
      current.tokens = safeHistoryCount(current.tokens + call.tokens, `selector ${vendor} token sum`);
      current.calls = safeHistoryCount(current.calls + call.calls, `selector ${vendor} call sum`);
      current.active_seconds += call.active_seconds;
      rows.set(key, current);
    }
    return [...rows.values()];
  };
  for (const row of subjectRows("codex")) absorb(row);
  for (const row of subjectRows("opencode")) absorb(row);
  for (const provider of ["claude", "grok", "glm"] as const)
    for (const r of canonicalSubjectRows(storedHistoryUsage(sqlite, provider, cards, { since: range?.since, until: range?.until, idleGapMinutes, resolver }).rows))
      absorb(r);
  const activity = readProjectActivity(sqlite, resolver, cards, idleGapMinutes, range ?? {});
  const bySubject = new Map<string, typeof activity>();
  for (const row of activity) if (row.subject) {
    if (!acc.has(row.subject)) absorb({ subject: row.subject, repo: row.repo, grp: null, tokens: 0, calls: 0, active_seconds: 0 });
    const rows = bySubject.get(row.subject) ?? []; rows.push(row); bySubject.set(row.subject, rows);
  }
  const machineOf = options?.machineOf ?? sourceMachineResolver();
  for (const [subject, row] of acc) {
    row.session_seconds = row.active_seconds;
    row.active_seconds = [...activityByDay(bySubject.get(subject) ?? [], machineOf).values()]
      .reduce((sum, machines) => sum + [...machines.values()].reduce((n, spans) => n + intervalSeconds(spans), 0), 0);
    row.repos.sort();
  }
  return Array.from(acc.values()).sort((a, b) => b.tokens - a.tokens);
}
/** Prepared Claude day sums, folded into the same subject rows the raw sources produce. */
function canonicalSubjectRows(rows: Array<Pick<HistoryRow, "subject" | "repo" | "repo_group" |
  "tokens" | "calls" | "active_seconds">>) {
  const merged = new Map<string, { subject: string; repo: string | null; grp: string | null;
    tokens: number; calls: number; active_seconds: number }>();
  for (const row of rows) {
    const subject = row.subject;
    if (!subject) continue;
    const key = `${subject}\0${row.repo ?? ""}\0${row.repo_group ?? ""}`;
    const current = merged.get(key)
      ?? { subject, repo: row.repo, grp: row.repo_group, tokens: 0, calls: 0, active_seconds: 0 };
    current.tokens = safeHistoryCount(current.tokens + row.tokens, "canonical subject token sum");
    current.calls = safeHistoryCount(current.calls + row.calls, "canonical subject call sum");
    current.active_seconds = safeHistoryAmount(current.active_seconds + row.active_seconds,
      "canonical subject activity sum");
    merged.set(key, current);
  }
  return [...merged.values()];
}
