import type { CompiledCodexLedgerPolicy } from "../server/codex-ledger-policy";
import { contextBand } from "../shared/context-tier";
import { nanoValuation, subtract, type Rational } from "./price-ledger-exact";

export interface ContextRequest {
  model: string | null; day: string; input: unknown; invalid: boolean; reason: string | null;
  tokens: { in_uncached: bigint; in_cache_read: bigint; in_cache_write: bigint; out_total: bigint };
}
/** The same disjoint buckets and strict per-request threshold as codexLedgerContextProjection. */
export function codexContextRequestValues(policy: CompiledCodexLedgerPolicy, request: ContextRequest): {
  base: Rational | null; extra: Rational | null; reason: string | null; long: boolean;
} {
  const rule = policy.resolveBaseRule(request.model, "api_equivalent_usd", request.day);
  const missing = (reason: string, long = false) => ({ base: null, extra: null, reason, long });
  if (request.reason) return missing(request.reason);
  if (request.invalid || typeof request.input !== "number" || !Number.isSafeInteger(request.input) || request.input < 0)
    return missing("invalid_tokens");
  if (!rule) return missing("missing_rate");
  const long = contextBand(rule.long_context, request.input) === "long";
  const normal = policy.baseBands.find(band => band.id === rule.id && band.band === "normal")!;
  const premium = long ? policy.contextBands.find(band => band.id === rule.id)! : normal;
  if (request.tokens.in_cache_write > 0n && (normal.rates.in_cache_write == null || premium.rates.in_cache_write == null))
    return missing("missing_cache_write_rate", long);
  const base = nanoValuation(normal.coefficients, request.tokens);
  return { base, extra: long ? subtract(nanoValuation(premium.coefficients, request.tokens), base) : { n: 0n, d: 1n }, reason: null, long };
}
