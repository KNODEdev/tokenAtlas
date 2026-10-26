import type { LedgerBaseBand } from "./codex-price-ledger";
import { compileNanoRates, nanoValuation, type NanoRates, type Rational } from "./price-ledger-exact";
import { isAccountingDay } from "../server/codex-accounting-pricing";
import { codexLedgerReferenceFingerprint } from "./codex-ledger-dependencies";
import { inContextBand } from "../shared/context-tier";

/**
 * The reference-day valuation of Codex calls (U3.0 note §5): the API Standard price a call would have at the
 * API bands in effect on another day. It is linear in the call's token buckets within one model and context
 * band, so it is computed where calls are read, from their stored buckets and the bands, instead of being
 * stored per call and day: nothing to queue, prepare or invalidate when a call or a rate changes.
 */
export interface CodexLedgerReferenceValue { amount: Rational | null; reason: string | null; ruleId: string | null; longContext: boolean }
/** What a call contributes, as `codex_price_ledger_events` stores it (the buckets are the ledger's own). */
export interface CodexReferenceCall {
  model: string | null; in_tok: unknown; uncached: number; cached: number; writes: number; output: number; common_reason: string | null;
}
interface CompiledBand { band: LedgerBaseBand; rates: NanoRates }

/** The effective coefficients of a reference day; two days with the same revision value every call alike. */
export function codexLedgerReferenceRevision(bands: readonly LedgerBaseBand[], day: string): string {
  return codexLedgerReferenceFingerprint(activeBands(bands, day), day);
}
function activeBands(bands: readonly LedgerBaseBand[], day: string): LedgerBaseBand[] {
  return bands.filter(band => band.basis === "api_equivalent_usd" && band.validFrom <= day && (!band.validUntil || day < band.validUntil));
}
const inBand = (band: LedgerBaseBand, input: unknown) => inContextBand(band.band, band.threshold, input);

/**
 * The valuation of calls at `day`'s API bands. A call with a common reason (invalid tokens, incomplete usage,
 * an unpriced model) keeps it; a call no band covers is `missing_rate`; a band without a cache-write rate
 * leaves a call that wrote cache `missing_cache_write_rate`.
 */
export function codexReferenceValuation(bands: readonly LedgerBaseBand[], day: string): (call: CodexReferenceCall) => CodexLedgerReferenceValue {
  if (!isAccountingDay(day)) throw new Error("Invalid reference accounting day");
  const byModel = new Map<string, CompiledBand[]>();
  for (const band of activeBands(bands, day)) byModel.set(band.model, [...(byModel.get(band.model) ?? []),
    { band, rates: compileNanoRates(band.rates, band.multiplier) }]);
  return call => {
    let value: CodexLedgerReferenceValue = { amount: null, reason: call.common_reason ?? "missing_rate", ruleId: null, longContext: false };
    if (call.common_reason !== null || call.model === null) return value;
    for (const { band, rates } of byModel.get(call.model) ?? []) {
      if (!inBand(band, call.in_tok)) continue;
      if (band.rates.in_cache_write == null && call.writes > 0) { value = { ...value, amount: null, reason: "missing_cache_write_rate" }; continue; }
      value = { reason: null, ruleId: band.id, longContext: band.band === "long", amount: nanoValuation(rates, {
        in_uncached: BigInt(call.uncached), in_cache_read: BigInt(call.cached), in_cache_write: BigInt(call.writes), out_total: BigInt(call.output) }) };
    }
    return value;
  };
}
