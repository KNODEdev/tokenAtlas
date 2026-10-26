import type { Quantity, PlanCapacityAbsentReason, TokenQuantities } from "./plan-capacity-contracts";
import { TOKEN_TYPES } from "./plans-catalog";
import type { TokenVector } from "./plans-catalog";
import { round4 } from "./capacity-equivalents";

export function present(value: number): Quantity {
  return { value, absent: null };
}

export function absent(reason: PlanCapacityAbsentReason): Quantity {
  return { value: null, absent: reason };
}

export function emptyTokens(reason: PlanCapacityAbsentReason): TokenQuantities {
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) out[t] = absent(reason);
  return out;
}

export function presentTokens(vector: TokenVector): TokenQuantities {
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) out[t] = present(round4(vector[t]));
  return out;
}

export function tokenTotal(vector: TokenQuantities): number | null {
  let sum = 0;
  let any = false;
  for (const t of TOKEN_TYPES) {
    const q = vector[t];
    if (q.absent != null) continue;
    sum += q.value;
    any = true;
  }
  return any ? sum : null;
}

export function sumPartial(list: Partial<TokenVector>[]): Partial<TokenVector> {
  const out: Partial<TokenVector> = {};
  for (const tokens of list) {
    for (const t of TOKEN_TYPES) {
      const n = tokens[t];
      if (n == null || !Number.isFinite(n)) continue;
      out[t] = (out[t] ?? 0) + n;
    }
  }
  return out;
}

export function scalePartial(tokens: Partial<TokenVector>, factor: number): Partial<TokenVector> {
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [key, value == null ? value : value * factor]),
  ) as Partial<TokenVector>;
}

export function normalizeVector(tokens: Partial<TokenVector>, spanPercent: number): TokenQuantities {
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) {
    const raw = tokens[t];
    if (raw == null || !Number.isFinite(raw)) {
      out[t] = absent("missing_counter");
      continue;
    }
    if (!(spanPercent > 0)) {
      out[t] = absent("missing_counter");
      continue;
    }
    out[t] = present(round4(raw / spanPercent));
  }
  return out;
}

export function allFivePresent(vector: TokenQuantities): boolean {
  return TOKEN_TYPES.every((t) => vector[t].absent == null);
}

export function sumPresent(byType: TokenQuantities): Quantity {
  if (!allFivePresent(byType)) {
    const rateMissing = TOKEN_TYPES.some((t) => byType[t].absent === "missing_rate");
    return absent(rateMissing ? "missing_rate" : "missing_counter");
  }
  let sum = 0;
  for (const t of TOKEN_TYPES) {
    const q = byType[t];
    if (q.absent == null) sum += q.value;
  }
  return present(round4(sum));
}
