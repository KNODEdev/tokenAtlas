import { TOKEN_TYPES, resolveDefaultReference } from "./plans-catalog";
import { round4, DAYS_PER_MONTH } from "./capacity-equivalents";
import type { TokenQuantities, Quantity, SampleDiagnostic, LocalCalibration, PlanCapacityAbsentReason, PrimaryEstimate, DerivedPlanMetrics, DefaultReferenceView, TokenRates } from "./plan-capacity-contracts";
import { tokenTotal, emptyTokens, present, absent, presentTokens } from "./plan-capacity-quantities";
import type { PlansCatalog, TokenVector } from "./plans-catalog";
import type { RateCard } from "./pricing";
import { ratesFromCard, valueVector } from "./plan-capacity-pricing";
import { CONSISTENCY_RELATIVE_MAX } from "./plan-capacity-contracts";

export function profileShares(vector: TokenQuantities): TokenQuantities {
  const tot = tokenTotal(vector);
  if (tot == null || tot <= 0) return emptyTokens("zero_tokens");
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) {
    const q = vector[t];
    out[t] = q.absent != null ? q : present(round4(q.value / tot));
  }
  return out;
}

function scaleTokens(vector: TokenQuantities, factor: number): TokenQuantities {
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) {
    const q = vector[t];
    out[t] = q.absent != null ? q : present(round4(q.value * factor));
  }
  return out;
}

function usdPer1m(usdPer1pct: Quantity, vector: TokenQuantities): Quantity {
  if (usdPer1pct.absent != null) return usdPer1pct;
  const tot = tokenTotal(vector);
  if (tot == null) return absent("missing_counter");
  if (tot <= 0) return absent("zero_tokens");
  return present(round4(usdPer1pct.value * (1e6 / tot)));
}

export function emptyLocal(diagnostics: SampleDiagnostic[], extra: string): LocalCalibration {
  return {
    tokens: {
      status: "none",
      reason: "no_accepted_windows",
      vector: emptyTokens("no_accepted_windows"),
      spread: null,
      consistent: false,
    },
    api: {
      status: "none",
      reason: "no_accepted_windows",
      usd_per_1pct: absent("no_accepted_windows"),
      by_type: emptyTokens("no_accepted_windows"),
    },
    samples: {
      accepted: 0,
      rejected: diagnostics.filter((d) => !d.accepted).length,
      independent_windows: 0,
      span_hours: null,
      cadence_hours: null,
      diagnostics,
    },
    explanation: extra,
  };
}

export function emptyPrimary(reason: PlanCapacityAbsentReason): PrimaryEstimate {
  const tokens = emptyTokens(reason);
  return {
    source: "none",
    tokens_per_1pct: tokens,
    api_usd_per_1pct: absent(reason),
    token_profile: tokens,
    provenance: { capacity: "none", price: "none", source: "none" },
  };
}

export function derivedFrom(
  primary: PrimaryEstimate,
  opts: {
    usd_per_month: number | null;
    cadence_hours: number | null;
    current_used_percent?: number | null;
  }
): DerivedPlanMetrics {
  const usd1 = primary.api_usd_per_1pct;
  const util =
    opts.current_used_percent == null || !Number.isFinite(opts.current_used_percent)
      ? absent("current_usage_unknown")
      : present(round4(opts.current_used_percent));
  const head =
    util.absent != null ? util : present(round4(Math.max(0, 100 - util.value)));
  let leverage: Quantity = absent("missing_price");
  if (
    usd1.absent == null &&
    opts.usd_per_month != null &&
    opts.usd_per_month > 0 &&
    opts.cadence_hours != null &&
    opts.cadence_hours > 0
  ) {
    const windowPaid = opts.usd_per_month * (opts.cadence_hours / (DAYS_PER_MONTH * 24));
    leverage = windowPaid > 0 ? present(round4((usd1.value * 100) / windowPaid)) : absent("missing_price");
  }
  return {
    usd_per_1pct: usd1,
    usd_per_1m: usdPer1m(usd1, primary.tokens_per_1pct),
    tokens_at_100pct: scaleTokens(primary.tokens_per_1pct, 100),
    utilisation_pct: util,
    headroom_pct: head,
    leverage,
  };
}

export function referenceView(
  catalog: PlansCatalog,
  provider: string,
  planId: string,
  asOf: string
): DefaultReferenceView {
  const resolved = resolveDefaultReference(catalog, provider, planId, asOf);
  if (resolved.kind === "present") {
    return {
      present: true,
      tokens_per_1pct: resolved.reference.tokens_per_1pct,
      source: resolved.reference.source,
      reason: null,
      version_id: resolved.version_id,
      version_from: resolved.version_from,
    };
  }
  return {
    present: false,
    tokens_per_1pct: null,
    source: null,
    reason: resolved.reason,
    version_id: resolved.version_id,
    version_from: resolved.version_from,
  };
}

export function valueReference(
  ref: DefaultReferenceView,
  card: RateCard,
  groupId: string,
  asOf: string,
  sampleRates: TokenRates | null
): Quantity {
  if (!ref.present || !ref.tokens_per_1pct) return absent("no_reference");
  const rates = sampleRates ?? ratesFromCard(card, groupId, null, asOf, null);
  const vec = presentTokens(ref.tokens_per_1pct);
  return valueVector(vec, rates).usd;
}

export function deviationOf(local: TokenQuantities, ref: TokenVector | null): {
  local_vs_reference: number | null;
  reason: string | null;
} {
  if (!ref) return { local_vs_reference: null, reason: "no_reference" };
  const localTot = tokenTotal(local);
  if (localTot == null) return { local_vs_reference: null, reason: "no_accepted_windows" };
  const refTot = TOKEN_TYPES.reduce((s, t) => s + ref[t], 0);
  if (refTot === 0) return { local_vs_reference: localTot === 0 ? 0 : null, reason: localTot === 0 ? null : "zero_tokens" };
  return { local_vs_reference: round4(Math.abs(localTot - refTot) / Math.abs(refTot)), reason: null };
}

export function explanationOf(local: LocalCalibration): string {
  const s = local.samples;
  const spreadPct = local.tokens.spread == null ? "n/a" : `${(local.tokens.spread * 100).toFixed(1)}%`;
  const span = s.span_hours == null ? "n/a" : `${round4(s.span_hours)}h`;
  const cad = s.cadence_hours == null ? "n/a" : `${s.cadence_hours}h`;
  const pass = local.tokens.consistent ? "pass" : "fail";
  return (
    `accepted=${s.accepted} rejected=${s.rejected} independent=${s.independent_windows} ` +
    `span=${span} cadence=${cad} spread=${spreadPct} (max |x-median|/median, totals and profile; ` +
    `threshold ${CONSISTENCY_RELATIVE_MAX * 100}%) consistency=${pass} ` +
    `tokens=${local.tokens.status}(${local.tokens.reason}) api=${local.api.status}(${local.api.reason})`
  );
}
