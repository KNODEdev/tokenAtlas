import type { RateCard } from "./pricing";
import type { TokenRates, ObservationSlice, TokenQuantities, Quantity } from "./plan-capacity-contracts";
import type { TokenVector, TokenType } from "./plans-catalog";
import { TOKEN_TYPES } from "./plans-catalog";
import { round4 } from "./capacity-equivalents";
import { absent, present, sumPresent, emptyTokens, normalizeVector } from "./plan-capacity-quantities";

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function ratesFromCard(
  card: RateCard,
  providerGroupId: string,
  model: string | null,
  day: string,
  speed: string | null
): TokenRates | null {
  const group = providerGroupId.toLowerCase();
  const vendor = group === "anthropic" ? "anthropic" : group === "openai" ? "openai" : group;
  const models = card.vendors[vendor]?.models;
  const raw = models?.[model || ""];
  if (!raw) return null;
  let block: Record<string, unknown> = raw as Record<string, unknown>;
  if (group === "anthropic" && speed === "fast" && raw.fast && typeof raw.fast === "object") {
    block = raw.fast as Record<string, unknown>;
  } else if (raw.until && day.slice(0, 10) > raw.until && raw.after && typeof raw.after === "object") {
    block = raw.after as Record<string, unknown>;
  }
  // Slices sum many calls, and a context tier is chosen per call: one rate cannot value them.
  if (raw.long_context || block.long_context) return null;
  const uncached = finiteOrNull(block.in_uncached);
  if (uncached == null) return null;
  const write = finiteOrNull(block.in_cache_write);
  const write5 = finiteOrNull(block.in_cache_write_5m);
  const write1 = finiteOrNull(block.in_cache_write_1h);
  return {
    in_uncached: uncached,
    in_cache_read: finiteOrNull(block.in_cache_read),
    in_cache_write_5m: write5 ?? (group === "anthropic" ? null : write),
    in_cache_write_1h: write1 ?? (group === "anthropic" ? null : write),
    out_total: finiteOrNull(block.out_total),
  };
}

export function resolveRates(
  obs: { rates?: TokenRates },
  card: RateCard,
  groupId: string,
  day: string,
  slices: ObservationSlice[] | undefined,
  tokens: Partial<TokenVector>
): { rates: TokenRates | null; bySlice: Array<{ rates: TokenRates; tokens: Partial<TokenVector> }> } {
  if (slices && slices.length > 0) {
    const bySlice: Array<{ rates: TokenRates; tokens: Partial<TokenVector> }> = [];
    for (const slice of slices) {
      // A slice with no tokens costs nothing at any rate (e.g. Claude's `<synthetic>` turns), so a
      // model missing from the card must not make the whole window unpriced.
      if (TOKEN_TYPES.every((t) => !slice.tokens[t])) continue;
      const r =
        slice.rates ?? obs.rates ??
        ratesFromCard(card, groupId, slice.model, slice.day || day, slice.speed);
      if (!r) return { rates: null, bySlice: [] };
      bySlice.push({ rates: r, tokens: slice.tokens });
    }
    return { rates: bySlice[0]?.rates ?? null, bySlice };
  }
  const rates = obs.rates ?? ratesFromCard(card, groupId, null, day, null);
  return { rates, bySlice: rates ? [{ rates, tokens }] : [] };
}

export function valueVector(tokens: TokenQuantities, rates: TokenRates | null): { usd: Quantity; byType: TokenQuantities } {
  const byType = {} as TokenQuantities;
  if (!rates) {
    for (const t of TOKEN_TYPES) {
      byType[t] = tokens[t].absent != null ? tokens[t] : absent("missing_rate");
    }
    return { usd: absent("missing_rate"), byType };
  }
  for (const t of TOKEN_TYPES) {
    const tok = tokens[t];
    if (tok.absent != null) {
      byType[t] = tok;
      continue;
    }
    const rate = rates[t];
    if (rate == null || !Number.isFinite(rate)) {
      byType[t] = absent("missing_rate");
      continue;
    }
    byType[t] = present(round4((tok.value / 1e6) * rate));
  }
  return { usd: sumPresent(byType), byType };
}

export function valueFromSlices(
  spanPercent: number,
  bySlice: Array<{ rates: TokenRates; tokens: Partial<TokenVector> }>
): { usd: Quantity; byType: TokenQuantities } {
  if (bySlice.length === 0) return { usd: absent("missing_rate"), byType: emptyTokens("missing_rate") };
  const acc = emptyTokens("missing_counter");
  const rateMissing: Partial<Record<TokenType, boolean>> = {};
  const seen: Partial<Record<TokenType, boolean>> = {};
  for (const slice of bySlice) {
    const vec = normalizeVector(slice.tokens, spanPercent);
    for (const t of TOKEN_TYPES) {
      const tok = vec[t];
      if (tok.absent != null) continue;
      const rate = slice.rates[t];
      if (rate == null || !Number.isFinite(rate)) {
        rateMissing[t] = true;
        continue;
      }
      const prev = acc[t];
      acc[t] = present(round4((prev.absent == null ? prev.value : 0) + (tok.value / 1e6) * rate));
      seen[t] = true;
    }
  }
  for (const t of TOKEN_TYPES) {
    if (rateMissing[t]) acc[t] = absent("missing_rate");
    else if (!seen[t]) acc[t] = absent("missing_counter");
  }
  return { usd: sumPresent(acc), byType: acc };
}
