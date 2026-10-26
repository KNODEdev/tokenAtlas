/**
 * One shared Claude Code usage-share estimate: types, the local provenance rule and
 * the arithmetic. No database access, so every consumer and every test uses exactly
 * these equations (plan section 3.2.1).
 *
 * The provider reports a product share of *its own* weekly meter. It does not
 * promise that the share is a share of raw tokens, so every number produced here
 * is a conditional token equivalent under Claude Code traffic characteristics, not
 * a measured account total. Estimates never enter source token facts.
 */

/** Named, versioned local classification rule. Bump when the recognised evidence changes. */
export const CLAUDE_CODE_PRODUCT_RULE = "claude-code-local-traffic@3";
/**
 * Report algorithm version; bump to invalidate prepared estimates without touching facts.
 * 12: retain contradictory shares through later silent readings even without a usable traffic sample.
 */
export const CLAUDE_CODE_CAPACITY_ALGORITHM = 12;

/**
 * The vendor lowered the weekly meter inside one window without moving the window: a plan change
 * resets it to zero (Max 5x → Max 20x, 24.09.2026: 88% → 0%) or rescales it to the new cap
 * (Pro → Max 5x, 12.09.2026: 21% → 2%). The server still reports the old window start, so usage
 * from that start no longer matches the percent; readings from `first_after` on are one counter.
 */
export interface ClaudeCounterReset {
  /** The weekly window's reset, as the server reports it. */
  reset_at: string;
  /** The drop happened between these two readings; usage between them belongs to neither side. */
  last_before: { at: string; percent: number };
  first_after: { at: string; percent: number };
}

/**
 * A meter of the account's usage payload that has no limit window of its own: a codenamed slot
 * (`iguana_necktie`, `nimbus_quill`) or a dollar allowance. `key` is the vendor's field name,
 * since the meaning of codenamed slots is not published.
 */
export interface ClaudeAccountMeter {
  key: string;
  utilization_percent: number | null;
  resets_at: string | null;
  limit_dollars: number | null;
  used_dollars: number | null;
  remaining_dollars: number | null;
}
/** Every account meter of one reading, plus paid usage beyond the plan (`extra_usage`, `spend`). */
export interface ClaudeAccountMeters {
  read_at: string;
  meters: ClaudeAccountMeter[];
  extra_usage: { enabled: boolean; user_disabled: boolean | null; spent_minor: number | null; currency: string | null; exponent: number | null } | null;
}

/**
 * Local provenance of one usage event.
 * - `code_cli` (stored name kept from rule @2): Claude Code traffic. Every call of the Claude subscription's own table
 *   (`claude_events`) counts, whatever launched it: the CLI, Claude Code in the desktop app, the Agent SDKs, or Claude Code
 *   run as an MCP server from another agent; every such row carries a Claude Code version. User decision 09.10.2026: in
 *   the weeks of 27.09–08.10 the provider's share was 100% Code while local traffic came almost only from `claude-desktop`
 *   and `sdk-cli`. Claude models used through Antigravity are Gemini rows and stay on Gemini's own Claude bar.
 * - `other_product`: reserved for verified product evidence; no local source establishes it.
 * - `unknown`: no longer produced; facts stored under rule @2 carry it until migration 0072 retags them.
 * - `conflict`: copies of the same event carry incompatible explicit evidence.
 */
export type ClaudeCodeProductClass = "code_cli" | "other_product" | "unknown" | "conflict";

export function classifyClaudeCodeEvent(): ClaudeCodeProductClass {
  return "code_cli";
}

/** Deterministic merge over the copies of one event identity; independent of source order. */
export function mergeClaudeCodeProduct(classes: Iterable<ClaudeCodeProductClass>): ClaudeCodeProductClass {
  let code = false, other = false, seen = false;
  for (const value of classes) {
    seen = true;
    if (value === "code_cli") code = true;
    else if (value === "other_product") other = true;
    else if (value === "conflict") { code = true; other = true; }
  }
  if (!seen) return "unknown";
  if (code && other) return "conflict";
  if (code) return "code_cli";
  if (other) return "other_product";
  return "unknown";
}

export const CLAUDE_CODE_UNAVAILABLE_REASONS = [
  "no_observation", "share_absent", "share_invalid", "share_zero",
  "utilization_absent", "utilization_nonpositive", "utilization_saturated",
  "window_mismatch", "account_mismatch", "observation_conflict",
  "no_code_tokens", "delta_nonpositive", "delta_ineffective",
  "unsafe_total", "unpriced", "facts_pending", "context_absent",
  /** An account total needs a window that starts at the reset; an interval cannot give one. */
  "not_cumulative",
] as const;
export type ClaudeCodeUnavailableReason = (typeof CLAUDE_CODE_UNAVAILABLE_REASONS)[number];

/** A number that is only meaningful together with the assumption that produced it. */
export type ClaudeCodeEstimate =
  | { value: number; absent: null; relation?: "≥" }
  | { value: null; absent: ClaudeCodeUnavailableReason; relation?: never };

export const available = (value: number): ClaudeCodeEstimate => ({ value, absent: null });
export const unavailable = (absent: ClaudeCodeUnavailableReason): ClaudeCodeEstimate => ({ value: null, absent });

/**
 * Percent inputs stay percents until the final division so the two reported figures
 * are divided once, instead of accumulating the error of two 1/100 conversions.
 */
function validShare(percent: number | null | undefined): ClaudeCodeUnavailableReason | null {
  if (percent == null) return "share_absent";
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "share_invalid";
  if (percent === 0) return "share_zero";
  return null;
}
function validUtilization(percent: number | null | undefined): ClaudeCodeUnavailableReason | null {
  if (percent == null) return "utilization_absent";
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "utilization_nonpositive";
  if (percent <= 0) return "utilization_nonpositive";
  // The caller bounds traffic at the first 100% reading, as the shared window contract requires.
  return null;
}
const safeResult = (value: number): ClaudeCodeEstimate =>
  Number.isFinite(value) && value >= 0 ? available(value) : unavailable("unsafe_total");

/**
 * Cumulative snapshot from the window start: with Code quantity `T`, share `s` and
 * weekly utilization `u` (both as percents of the same provider meter),
 * conditional account total is `T / s` and conditional weekly capacity is `T / (s * u)`.
 * No monthly multiplier is applied anywhere.
 */
export function cumulativeClaudeCodeEstimate(input: {
  quantity: number | null;
  sharePercent: number | null;
  utilizationPercent: number | null;
}): { account_total: ClaudeCodeEstimate; weekly_capacity: ClaudeCodeEstimate } {
  const shareIssue = validShare(input.sharePercent);
  const utilizationIssue = validUtilization(input.utilizationPercent);
  if (input.quantity == null) return { account_total: unavailable("unpriced"), weekly_capacity: unavailable("unpriced") };
  if (!Number.isFinite(input.quantity) || input.quantity < 0) return { account_total: unavailable("unsafe_total"), weekly_capacity: unavailable("unsafe_total") };
  const total = shareIssue ? unavailable(shareIssue) : safeResult(input.quantity * 100 / input.sharePercent!);
  const capacity = shareIssue ? unavailable(shareIssue) : utilizationIssue ? unavailable(utilizationIssue)
    : safeResult(input.quantity * 10_000 / (input.sharePercent! * input.utilizationPercent!));
  return { account_total: total, weekly_capacity: capacity };
}

/**
 * Smallest `Δ(u·s)` this pair may be trusted with. Both percents arrive already
 * rounded by the provider by an unknown rule, so the product carries at least
 * `s·δu + u·δs` of rounding play. Requiring a multiple of that keeps a barely moving
 * meter from turning into a huge capacity. This is a refusal threshold, not a
 * confidence interval: the vendor's rounding rule is not documented.
 */
export const CLAUDE_CODE_DELTA_GUARD_FACTOR = 4;
export function percentResolution(...percents: number[]): number {
  // Use the coarsest observation of this factor, including scientific notation.
  return Math.max(...percents.map(percent => {
    const [mantissa, exponent = "0"] = String(percent).toLowerCase().split("e");
    const decimals = mantissa!.split(".")[1]?.length ?? 0;
    return Math.min(1, 10 ** (Number(exponent) - decimals));
  }));
}
export function claudeCodeDeltaFloor(first: { sharePercent: number; utilizationPercent: number },
  second: { sharePercent: number; utilizationPercent: number }): number {
  const halfShare = percentResolution(first.sharePercent, second.sharePercent) / 2;
  const halfUtilization = percentResolution(first.utilizationPercent, second.utilizationPercent) / 2;
  const share = Math.max(first.sharePercent, second.sharePercent);
  const utilization = Math.max(first.utilizationPercent, second.utilizationPercent);
  return CLAUDE_CODE_DELTA_GUARD_FACTOR * (share * halfUtilization + utilization * halfShare);
}

/**
 * Two compatible observations of the same account, counter and window:
 * capacity is `ΔT / Δ(u·s)`. Never `Δs`, and never a final `s` applied to an
 * arbitrary interval. A zero reading is not required.
 */
export function intervalClaudeCodeCapacity(input: {
  quantity: number | null;
  first: { sharePercent: number | null; utilizationPercent: number | null };
  second: { sharePercent: number | null; utilizationPercent: number | null };
}): { weekly_capacity: ClaudeCodeEstimate; delta_product_percent: number | null; delta_floor_percent: number | null } {
  const empty = { delta_product_percent: null, delta_floor_percent: null };
  if (input.first.utilizationPercent === 100) return { weekly_capacity: unavailable("utilization_saturated"), ...empty };
  for (const side of [input.first, input.second]) {
    const shareIssue = validShare(side.sharePercent);
    if (shareIssue) return { weekly_capacity: unavailable(shareIssue), ...empty };
    // The first 100% reading can close the interval; subsequent flat readings are excluded by the caller.
    const utilizationIssue = validUtilization(side.utilizationPercent);
    if (utilizationIssue) return { weekly_capacity: unavailable(utilizationIssue), ...empty };
  }
  if (input.quantity == null) return { weekly_capacity: unavailable("unpriced"), ...empty };
  if (!Number.isFinite(input.quantity)) return { weekly_capacity: unavailable("unsafe_total"), ...empty };
  const first = { sharePercent: input.first.sharePercent!, utilizationPercent: input.first.utilizationPercent! };
  const second = { sharePercent: input.second.sharePercent!, utilizationPercent: input.second.utilizationPercent! };
  const delta = second.utilizationPercent * second.sharePercent - first.utilizationPercent * first.sharePercent;
  const floor = claudeCodeDeltaFloor(first, second);
  if (delta <= 0) return { weekly_capacity: unavailable("delta_nonpositive"), delta_product_percent: delta, delta_floor_percent: floor };
  if (delta < floor) return { weekly_capacity: unavailable("delta_ineffective"), delta_product_percent: delta, delta_floor_percent: floor };
  if (input.quantity <= 0) return { weekly_capacity: unavailable("delta_nonpositive"), delta_product_percent: delta, delta_floor_percent: floor };
  return { weekly_capacity: safeResult(input.quantity * 10_000 / delta), delta_product_percent: delta, delta_floor_percent: floor };
}

/** Every observed Code quantity the estimator can divide, kept separate per unit. */
export interface ClaudeCodeObservedUsage {
  code_tokens: number;
  code_events: number;
  /** Standard-mode API equivalent of the Code traffic; null when any part is unpriced. */
  code_api_usd: number | null;
  /** Known-price subtotal when part of this exact interval is unpriced; never a complete amount. */
  code_api_priced_subtotal?: number;
  /** All recognised traffic for the account in the same window, unchanged and separate. */
  account_tokens: number;
  account_events: number;
}

export interface ClaudeCodeCoverage {
  product_rule: string;
  code_events: number;
  other_product_events: number;
  unknown_events: number;
  conflicting_product_events: number;
  duplicate_copies: number;
  conflicting_usage_identities: number;
  /** Never "complete": other machines are not proven to have reported. */
  cross_machine: "unconfirmed";
  /** Source completeness is not established merely by summing from the window start. */
  complete_from_window_start: boolean;
  assumptions: string[];
}

/**
 * The compact shape every downstream report field carries: the numbers are never
 * separated from the assumption, coverage and source interval that produced them.
 */
export interface ClaudeCodeCapacitySummary {
  algorithm: number;
  /** Stable account/counter/segment identity from the shared probe limit register. */
  window_id: string | null;
  api_value_basis: "standard";
  rule: string;
  account: string;
  basis: "cumulative" | "interval" | null;
  source_from: string | null;
  source_through: string | null;
  /** The selected sample's meter movement, separate from the whole cycle's latest percentage. */
  sample_meter?: { start_percent: number; end_percent: number; observed_pp: number } | null;
  as_of: string | null;
  /** Meter instant is retained even when its reading carries no product-share payload. */
  meter_read_at?: string | null;
  reset_at: string | null;
  window_started_at: string | null;
  share_percent: number | null;
  utilization_percent: number | null;
  conditional: true;
  reason: ClaudeCodeUnavailableReason | null;
  weekly_capacity_tokens: ClaudeCodeEstimate;
  weekly_capacity_api_usd: ClaudeCodeEstimate;
  account_total_tokens: ClaudeCodeEstimate;
  account_total_api_usd: ClaudeCodeEstimate;
  observed_code_tokens: number | null;
  observed_code_api_usd: number | null;
  observed_models?: import("./claude-capacity-result").ClaudeCapacityModelUsage[];
  observed_code_api_usd_subtotal?: number;
  /** The account's own split of the same reading's used bar; null before the vendor sent it. */
  product_rows?: ClaudeProductRow[] | null;
  coverage: ClaudeCodeCoverage;
  /** Latest meter drop inside the window of this reading; the estimate is measured from it. */
  counter_reset?: ClaudeCounterReset | null;
}

/** One surface row of the vendor's weekly breakdown (`seven_day_breakdown`). */
export interface ClaudeProductRow {
  key: string;
  percent: number;
  display_name: string | null;
}
export interface ClaudeAccountSplitRow extends ClaudeProductRow {
  /** Claude Code is measured in the local index; every other surface is an estimate. */
  measured: boolean;
  api_usd: number | null;
  tokens: number | null;
}
export interface ClaudeAccountSplit {
  as_of: string | null;
  share_percent: number;
  rows: ClaudeAccountSplitRow[];
  /** Estimated whole-account usage of the window so far; null when the Code side is unpriced. */
  account_api_usd: number | null;
  account_tokens: number | null;
}

/**
 * The whole account and its surfaces from one cumulative reading: account = Code / share, and
 * each other surface = account × its percent. The Code row stays the measured amount, never the
 * product of two rounded percents. Interval estimates describe no whole-window total, so they
 * produce no split.
 */
export function claudeAccountSplit(summary: ClaudeCodeCapacitySummary | null | undefined): ClaudeAccountSplit | null {
  if (!summary || summary.basis !== "cumulative" || !summary.product_rows?.length || summary.share_percent == null) return null;
  const accountUsd = summary.account_total_api_usd.value;
  const accountTokens = summary.account_total_tokens.value;
  const rows = summary.product_rows.map((row): ClaudeAccountSplitRow => {
    const measured = row.key === CLAUDE_CODE_PRODUCT_KEY;
    return {
      ...row,
      measured,
      api_usd: measured ? summary.observed_code_api_usd : accountUsd == null ? null : accountUsd * row.percent / 100,
      tokens: measured ? summary.observed_code_tokens : accountTokens == null ? null : accountTokens * row.percent / 100,
    };
  });
  return { as_of: summary.as_of, share_percent: summary.share_percent, rows, account_api_usd: accountUsd, account_tokens: accountTokens };
}
/** One weekly window of one account with its whole-account split (`/api/claude-account-splits`). */
export interface ClaudeAccountSplitWindow {
  account: string;
  window_started_at: string;
  reset_at: string;
  split: ClaudeAccountSplit;
}
export interface ClaudeAccountSplitsResponse {
  since: string;
  until: string;
  /** Subscription facts were still being prepared; the list is empty rather than partial. */
  pending: boolean;
  windows: ClaudeAccountSplitWindow[];
}

/**
 * Several windows of one account as one split: amounts add up, and each surface's percent is its
 * share of the summed account (dollars when every window is priced, tokens otherwise). A surface
 * missing from a window contributes nothing there; an unpriced window makes the dollar sum unknown.
 */
export function sumClaudeAccountSplits(splits: readonly ClaudeAccountSplit[]): ClaudeAccountSplit | null {
  if (!splits.length) return null;
  const add = (a: number | null, b: number | null) => (a == null || b == null ? null : a + b);
  const byKey = new Map<string, ClaudeAccountSplitRow>();
  let accountUsd: number | null = 0, accountTokens: number | null = 0;
  for (const split of splits) {
    accountUsd = add(accountUsd, split.account_api_usd);
    accountTokens = add(accountTokens, split.account_tokens);
    for (const row of split.rows) {
      const seen = byKey.get(row.key);
      byKey.set(row.key, seen
        ? { ...seen, display_name: seen.display_name ?? row.display_name, api_usd: add(seen.api_usd, row.api_usd), tokens: add(seen.tokens, row.tokens) }
        : { ...row });
    }
  }
  const rows = [...byKey.values()].map((row) => ({
    ...row,
    percent: accountUsd != null && accountUsd > 0 && row.api_usd != null ? row.api_usd / accountUsd * 100
      : accountTokens != null && accountTokens > 0 && row.tokens != null ? row.tokens / accountTokens * 100 : row.percent,
  }));
  const asOf = splits.map((split) => split.as_of).filter((value): value is string => value != null).sort().at(-1) ?? null;
  return { as_of: asOf, share_percent: rows.find((row) => row.measured)?.percent ?? 0, rows, account_api_usd: accountUsd, account_tokens: accountTokens };
}
/** Vendor key of the Claude Code surface in `seven_day_breakdown`. */
export const CLAUDE_CODE_PRODUCT_KEY = "claude_code";
/**
 * Readings from before the vendor sent its surface rows still carry the Code share, so the rest of
 * the account is known as one amount without a split. It is our key, never a vendor surface.
 */
export const OUTSIDE_CODE_PRODUCT_KEY = "outside_code_unsplit";
export function shareOnlyProductRows(sharePercent: number): ClaudeProductRow[] {
  return [
    { key: CLAUDE_CODE_PRODUCT_KEY, percent: sharePercent, display_name: "Claude Code" },
    { key: OUTSIDE_CODE_PRODUCT_KEY, percent: 100 - sharePercent, display_name: null },
  ];
}

/**
 * No reading of this weekly window carried the Code share: the vendor first sent it in the week of 13.09.2026, so
 * earlier windows have only the meter. Their capacity is local traffic ÷ meter increase, taking local traffic as the
 * whole meter: every local Claude call counts as Code, and every week with a share showed 99–100% Code (user decision
 * 11.10.2026). Only a summary of this very window qualifies; any other missing reason keeps the window without one.
 */
export function claudeShareNeverReported(window: { id: string; account: string; window_minutes?: number | null;
  claude_code_capacity?: ClaudeCodeCapacitySummary | null }): boolean {
  const summary = window.claude_code_capacity;
  return !!summary && summary.reason === "share_absent" && summary.window_id === window.id
    && (window.window_minutes ?? 10080) === 10080
    && typeof summary.account === "string" && summary.account.trim().toLowerCase() === window.account.trim().toLowerCase();
}

export const CLAUDE_CODE_ASSUMPTIONS = [
  "The provider's product share is treated as a share of token-equivalent usage; the API does not confirm that it is a share of raw tokens.",
  "Model mix, cache mix, mode and the provider's internal billing unit can change the relation between share and tokens.",
  "Every locally recorded Claude call counts as Claude Code, whatever launched it (CLI, desktop app, Agent SDKs, MCP).",
  "Coverage of Claude Code sources across all machines is unconfirmed.",
] as const;
