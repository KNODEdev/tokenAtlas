import type { WindowUsage, CONTEXT_USAGE_KEYS } from "../shared/codex-accounting";
import type { WindowModelUsage } from "../shared/window-model-usage";
import type { ModelCapacityWindow } from "../shared/model-capacity";
import type { WindowEvidence } from "../shared/subscription-quality";
import type { MeterExclusion, MeterEvent, WindowAccountingAdapter } from "./subscription-window-comparison";
import type { WindowCreditSums, WindowAtLimit, CreditFundedSums } from "../shared/credit-funded";
import type { TokenVector } from "./plans-catalog";
import type { CalibrationEvent } from "./codex-calibration";
import type { LedgerEvent } from "../db/usage-ledger-events";
import type { RateCard } from "./pricing";
import type { IdentityDeclaration } from "./account-resolver";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { ClaudeGaugeConfig } from "./claude-gauge";
import type { GrokGaugeConfig } from "./grok-gauge-spans";
import type { CyclesConfig } from "./cycles";
import type { DeclaredWindow } from "./claude-declared-windows";

export const WINDOW_USAGE_VERSION = 7;

/** Running totals at a reading: the events of the cycle up to and including its instant. */
export type RunningUsage = Pick<WindowUsage, "events" | "tokens" | "priced_tokens" | "unpriced_events" | "api_standard"
  | "credits_low" | "credits_high"> & { api_normalized: number };

export type ContextRunningUsage = RunningUsage & Pick<WindowUsage, typeof CONTEXT_USAGE_KEYS[number]>;

/**
 * Counted traffic of one model in the units the Claude screens show: calls, all disjoint tokens, fresh
 * tokens (uncached input and output), and the stored Standard and actual-mode API values of the priced
 * calls with the number of calls each variant left unpriced (§8: unpriced is not zero cost).
 */
export interface ModelSpend {
  model: string | null; events: number; tokens: number; fresh: number;
  standard: number; standard_unpriced: number; actual: number; actual_unpriced: number;
}

/** Claude Code product totals of the counted traffic, with the duplicate and conflict coverage of its identities. */
export interface ProductTotals {
  code_events: number; code_tokens: number; code_api_usd: number; code_unpriced_events: number;
  other_product_events: number; unknown_events: number; conflicting_product_events: number;
  duplicate_copies: number; conflicting_usage_identities: number;
}

export type ActivityCurve = Array<{ t: number; amount: number }>;

export interface WindowCycleSums {
  /** Disjoint single-model samples prepared by this same window producer. */
  model_capacity?: ModelCapacityWindow;
  /** Paired with the meter. */
  usage: WindowUsage;
  /** The whole cycle, paired and unpaired. */
  cycle_usage: WindowUsage;
  unpaired_events: number;
  sources: Array<WindowUsage & { name: string }>;
  models: Array<WindowUsage & { name: string }>;
  evidence: Pick<WindowEvidence, "sources" | "excluded_events">;
  /** Events of the cycle the window left out, by reason and model. */
  excluded: Array<{ reason: MeterExclusion; model: string | null; usage: WindowUsage }>;
  /** Claude: the whole cycle's counted traffic per model. */
  spend?: ModelSpend[];
  /** Outside Codex: calls billed from a promotional credit instead of the plan (`CLAUDE_WINDOW_FUNDING_RULE`). */
  credit_funded?: import("../shared/credit-funded").CycleCreditFunded;
}

/** The cycle's traffic of one model: counted (`excluded` null) or left out with its reason. */
export interface WindowModelTraffic extends WindowModelUsage {
  excluded: MeterExclusion | null;
  /** Grok and GLM: the vendor-recorded money of the calls and how many recorded none. */
  reported_usd?: number; reported_missing?: number;
}

export interface WindowRailSums {
  /** Tokens of the counted cycle traffic, its API Standard value where priced, and the unpriced rest. */
  tokens: number; api_standard: number; unpriced_tokens: number;
  unpriced_groups: Array<{ model: string | null; day: string; tokens: number }>;
  /** Cumulative counted tokens at quarter percents of the span, the rail's resolution; empty without traffic. */
  activity: ActivityCurve;
  /** Every call of the cycle by model and admission. */
  by_model: WindowModelTraffic[];
  /** Counted calls by surface (where the provider records one). */
  by_surface: Array<{ surface: string | null; calls: number; tokens: number; fresh: number; api_standard: number }>;
  /** UTC days with counted traffic. */
  days: string[];
  /** Counted tokens per UTC hour start (the same tokens as `tokens`); absent in rows stored before version 7. */
  hours?: Array<[string, number]>;
  /** Counted tokens per archive source (a ledger fact's source, else its home), for the rail's machine split. */
  sources: Array<{ name: string; first: string; tokens: number }>;
  /** Claude: the same for the models of its scoped (Fable) sublimit, with tokens per source. */
  scoped?: { tokens: number; activity: ActivityCurve; sources: Array<{ name: string; first: string; tokens: number }> } | null;
  /** Intervals without counted traffic: the provider's traffic of the span that no account owns. */
  unowned?: { events: number; tokens: number } | null;
  /** Grok and GLM: the vendor-recorded money of the counted calls and how many recorded none. */
  reported?: { usd: number; missing: number };
  /** GLM: distinct sessions of the counted calls; Gemini: distinct conversations. */
  sessions?: number;
  /** Codex: Standard credits of the counted calls (the basis of the window's credit equivalent). */
  credits?: WindowCreditSums;
  /** Codex: the counted sums up to the first reading at the limit, the window's capacity in each unit; null below it. */
  at_limit?: WindowAtLimit | null;
  /** Codex: the calls of the cycle paid from credits (left out of the counted traffic); null without any. */
  credit_funded?: CreditFundedSums | null;
}

/**
 * The Codex rail's unit sums (credits, `at_limit`, `credit_funded`). Stored rows computed under another rule are queued
 * again for Codex only (`enqueueConfigChanges`).
 */
export const CODEX_WINDOW_UNITS_RULE = "codex-window-units-1";

/** The Codex context split; 2 measures the uplift also while the premium is off (a preview needs it). */
export const CODEX_WINDOW_CONTEXT_RULE = "codex-window-context-2";
/** Claude calls billed from a promotional cloud credit leave the plan windows (`funding`); a new rule re-sums Claude windows. */
// 2: the stored cycle also carries the funded calls' summary for the cycle list.
export const CLAUDE_WINDOW_FUNDING_RULE = "claude-window-funding-2";
/** The context split of vendors with long-context tiers outside Codex (Claude Haiku); a new rule re-sums Claude windows. */
export const CLAUDE_WINDOW_CONTEXT_RULE = "claude-window-context-1";

export interface WindowReadingSums {
  ts: string; usage: ContextRunningUsage;
  /** Sources and models first seen after the previous reading. */
  homes: string[]; models: Array<string | null>;
  /** Claude: counted traffic per model after the previous reading, the UTC days first seen in it, and running product totals. */
  spend?: ModelSpend[]; days?: string[]; products?: ProductTotals;
}

/**
 * Counted traffic per model, mode and UTC hour, paired with the meter or not: the token vectors a plan's
 * capacity is estimated from, fine enough to follow a plan period that changes inside a window.
 */
export interface WindowSlice { context_rates?: import("./plan-capacity-contracts").TokenRates; context_classified?: boolean; model: string | null; speed: string; hour: string; paired: boolean; tokens: TokenVector;
  /** Claude: the part of `tokens` from Claude Code (the CLI product), the traffic a vendor Code share divides. */
  code?: TokenVector }

/**
 * The reference-day variant of a window's cycle sums: the same cycle with every call also valued at the rates
 * of `day` (the `reference_*`, `paired_*` and `revaluation_*` fields). `fingerprint` names those effective
 * rates, so a request for another day with the same rates reads this variant.
 */
export interface WindowReferenceVariant { day: string; fingerprint: string; cycle: WindowCycleSums }

export interface WindowSums { cycle: WindowCycleSums; rail: WindowRailSums; readings: WindowReadingSums[]; slices: WindowSlice[];
  /** Stored by the producer for the configured reference day; null until valued. */
  reference?: WindowReferenceVariant | null }

/** What a window keeps of one event beside its adapter usage. */
export interface WindowEventFacts {
  model: string | null; speed: string; surface: string | null; tokens: TokenVector; reasoning: number; api_standard: number | null;
  /** Claude: the stored actual-mode value and the product class. */
  api_actual?: number | null; product?: string | null;
  /** Grok and GLM: the money the vendor itself recorded for the call, null when it recorded none or two values. */
  reported?: number | null;
  /** GLM: the call's session; Gemini: its conversation. Null when the source recorded none. */
  session?: string | null;
  /** Codex: the call's Standard credit price (null: unpriced), and whether the vendor billed it from credits. */
  credits_standard?: number | null;
  credit_funded?: boolean;
}

export interface WindowTraffic<Event extends MeterEvent> {
  adapter: WindowAccountingAdapter<Event>;
  facts(event: Event): WindowEventFacts;
  /** Codex: the rail keeps credits, the sums at the limit and the credit-funded calls. */
  units?: true;
  /** Claude keeps per-model spend, product totals and its scoped sublimit's rail; the Claude screens read them. */
  claude?: ClaudeWindowDetail;
}

export interface ClaudeWindowDetail {
  /** Whether a model belongs to the scoped (Fable) sublimit. */
  scoped(model: string | null): boolean;
  /** The account's identities with a copy in the span: first in-span instant, extra copies, conflict. */
  copies: ReadonlyArray<{ ts: string; duplicates: number; conflict: boolean }>;
  /** A limit window: the provider's traffic of the span that no account owns (plan capacity excludes such a window). */
  unowned?: () => { events: number; tokens: number };
}

/**
 * Where `computeWindowSums` can treat two calls of the window differently by their instant alone: the placement and
 * pairing bounds of the window and of the earlier windows that share its span, its readings (a running sum includes a
 * call at the reading's instant), and the rail's steps over `[start, end)`; calendar hours and days are steps of their
 * own. Calls that differ in none of these, nor in what they are (source, model, admission, price), are one cohort.
 */
export interface WindowCuts { instants: number[]; activity: { start: number; end: number } }

/** The ledgers' canonical events of one account in `[start, end)`, as a window adapter reads them. */
export interface WindowEventReader {
  codex(account: string, start: string, end: string): CalibrationEvent[];
  /**
   * The same calls in exact cohorts for a window with these cuts (`readCodexWindowCohorts`), read in one pass; null
   * when the account's calls cannot be cut that way (the pool no period owns), which reads them one by one.
   */
  codexCohorts?(account: string, start: string, end: string, cuts: WindowCuts): CalibrationEvent[] | null;
  ledger(provider: string, account: string, start: string, end: string): LedgerEvent[];
  /** The producer's: the reference valuation each provider's stored rows carry. */
  reference?: ReferencePlan;
}

/** A reference valuation the producer stores: the day the calls are valued at and its rates' fingerprint. */
export interface ReferenceValuation { day: string; fingerprint: string }

export type ReferencePlan = (provider: string) => ReferenceValuation | null;

/** The ledger reads of the producer: the window events and the traffic no account owns. */
export interface CachedWindowEventReader extends WindowEventReader {
  unowned(provider: string, start: string, end: string): { events: number; tokens: number };
}

export type WindowSumsPart = keyof WindowSums;

export interface StoredModelCapacityWindow {
  window_id: string; start_ts: string; end_ts: string; reset_ts: string; cycle_end_basis: string;
  plan: string | null; plan_mismatch: number; manual: string | null; samples: string | null; pending: number;
}

export interface StoredModelUsageShareWindow {
  context_hour_extra?: Array<[string | null, string, number]>;
  window_id: string; start_ts: string; end_ts: string; plan: string | null; plan_mismatch: number;
  /** JSON [UTC hour as "YYYY-MM-DDTHH", highest percent] of the window's meter readings. */
  meter: string | null;
  by_model: string | null; slices: string | null; stored: number; pending: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Producer                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface WindowUsageProducerOptions {
  rateCards: RateCard;
  subscriptions?: readonly IdentityDeclaration[];
  /** Interval inputs; each defaults to its configuration file. */
  manualCapacity?: (provider: string) => readonly ManualCapacityMeasurement[];
  claudeGauge?: ClaudeGaugeConfig;
  grokGauge?: GrokGaugeConfig;
  cycles?: CyclesConfig;
  /** The clock the reconstructed Claude windows follow. */
  nowMs?: number;
  /** The day the stored reference variant values calls at; today's UTC day by default (the screens' default). */
  referenceDay?: string;
  /** Time a call may use; it always completes at least one window when work exists. */
  budgetMs?: number;
  /** Re-checked before every window; false stops the call (another party asked for the writer). */
  canWrite?: () => boolean;
  /**
   * Whether the caller still holds the writer although another party may be waiting: the windows already
   * computed are written before the call stops, so a long window is not computed again on every turn a sync
   * interrupts. Without it, `canWrite` decides the write too.
   */
  holdsWriter?: () => boolean;
  stats?: WindowUsageProducerStats;
}

export interface WindowUsageProducerStats {
  windows: number; events: number; removed: number;
  /** Ledger events read (a cached day is read once for every window that spans it). */
  read: number;
  /** Longest computation of one window and the longest write transaction, in ms. */
  slowestWindowMs: number; slowestWriteMs: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Intervals                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** A measured span that is not a limit window; see the module comment. */
export type WindowInterval = { provider: string; account: string; counter: string; id: string; start: string; end: string } & (
  | { kind: "manual"; measurement: ManualCapacityMeasurement }
  | { kind: "gauge" }
  | { kind: "declared"; declared: { kind: string; scope: string | null; scope_models: string[]; window: DeclaredWindow } }
  | { kind: "rolling"; minutes: number }
  | { kind: "anchored"; anchor: string; minutes: number });

export const intervalKey = (provider: string, account: string, counter: string, id: string) => JSON.stringify([provider, account, counter, id]);

/** Manual intervals and rolling fallbacks (which end at their newest call) include their end instant. */
export const intervalEndMs = (interval: WindowInterval) => Date.parse(interval.end) + (interval.kind === "manual" || interval.kind === "rolling" ? 1 : 0);

export const intervalOverlaps = (interval: WindowInterval, from: number, until: number | null) =>
  intervalEndMs(interval) > from && (until === null || Date.parse(interval.start) < until);

/** What a row's sums depend on besides the ledgers: an interval whose key changes is recomputed. */
export const intervalSumsKey = (interval: WindowInterval) => JSON.stringify([interval.start, interval.end,
  interval.kind === "manual" ? [interval.measurement.counter, interval.measurement.approximate_time]
    : interval.kind === "declared" ? interval.declared.scope_models : null]);

/** One UTC hour of a Claude window: counted tokens and their actual-mode API value (window chart units). */
export interface ClaudeHourBlock { start_ts: string; end_ts: string; tokens: number; usd: number; usd_partial?: true }
