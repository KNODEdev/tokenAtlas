import type { CompiledCodexLedgerPolicy } from "../server/codex-ledger-policy";
import type { LedgerReadGroup } from "./codex-price-ledger-read";
import { nanoValuation, subtract, type Rational } from "./price-ledger-exact";
import { contextBand } from "../shared/context-tier";

/** All historical API thresholds, including when the premium is disabled. Cohorts must not cross them. */
export function codexContextThresholds(policy: CompiledCodexLedgerPolicy): number[] {
  return [...new Set(policy.policy.base_rules.flatMap(rule => rule.billing_basis === "api_equivalent_usd" && rule.long_context
    ? [rule.long_context.above_input_tokens] : []))];
}

export interface CodexContextProjection {
  knownTokens: bigint; longTokens: bigint; longCalls: bigint;
  base: Rational | null; extra: Rational | null;
}

/**
 * Producer projection of published facts at the same historical rates, with the context uplift separated.
 * `base + extra` is the value with the premium; the stored total is that while the premium is on, `base` while off.
 */
export function codexLedgerContextProjection(policy: CompiledCodexLedgerPolicy, group: LedgerReadGroup,
  requestInput: unknown): CodexContextProjection {
  const unknown: CodexContextProjection = { knownTokens: 0n, longTokens: 0n, longCalls: 0n, base: null, extra: null };
  const rule = policy.resolveBaseRule(group.stored.model, "api_equivalent_usd", group.stored.day);
  if (!rule || typeof requestInput !== "number" || !Number.isSafeInteger(requestInput) || requestInput < 0
    || group.quality.invalid_token_events > 0n) return unknown;
  const long = contextBand(rule.long_context, requestInput) === "long";
  const tokens = group.windowTokens.input + group.windowTokens.output;
  const counts = { knownTokens: tokens, longTokens: long ? tokens : 0n, longCalls: long ? group.calls : 0n };
  const actual = group.variants.api_standard.value;
  if (actual === null) return { ...unknown, ...counts };
  // Ordinary requests already carry the normal value; do not revalue them.
  if (!long) return { ...counts, base: actual, extra: { n: 0n, d: 1n } };
  const premium = policy.policy.long_context_premium !== false;
  // With the premium on the stored value is the long one and the normal value is derived; with it off the
  // stored value is normal and the uplift is still measured at the long rates, so a view can show it.
  const other = premium ? policy.baseBands.find(band => band.id === rule.id && band.band === "normal")
    : policy.contextBands.find(band => band.id === rule.id);
  if (!other || (other.rates.in_cache_write == null && group.tokens.in_cache_write_unknown! > 0n)) return { ...unknown, ...counts };
  const value = nanoValuation(other.coefficients, {
    in_uncached: group.tokens.in_uncached!, in_cache_read: group.tokens.in_cache_read!,
    in_cache_write: group.tokens.in_cache_write_unknown!, out_total: group.tokens.out_total!,
  });
  return premium ? { ...counts, base: value, extra: subtract(actual, value) } : { ...counts, base: actual, extra: subtract(value, actual) };
}
