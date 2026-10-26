import type { WindowUsage } from "../shared/codex-accounting";
import type { WindowSums, ReferenceValuation, ReferencePlan } from "./window-usage-contracts";
import type { RateCard } from "./pricing";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { codexLedgerReferenceRevision } from "../db/codex-ledger-reference";
import { subscriptionAccountingAdapter, subscriptionRateSelection } from "./subscription-accounting-adapters";
import { digest } from "./window-usage-meta";

/** What a reference valuation adds to each usage total. */
const REFERENCE_KEYS = ["reference_api_standard", "reference_priced_tokens", "reference_unpriced_events", "paired_historical_api",
  "paired_reference_api", "revaluation_events", "revaluation_tokens"] as const;

function withoutReference(usage: WindowUsage): WindowUsage {
  const copy = { ...usage };
  for (const key of REFERENCE_KEYS) delete copy[key];
  return copy;
}

/** Sums computed with a reference valuation: the ordinary cycle without its fields, and the variant beside it. */
export function withReferenceVariant(sums: WindowSums, variant: ReferenceValuation): WindowSums {
  const cycle = sums.cycle;
  return { ...sums, reference: { ...variant, cycle },
    cycle: { ...cycle, usage: withoutReference(cycle.usage), cycle_usage: withoutReference(cycle.cycle_usage),
      sources: cycle.sources.map(source => withoutReference(source) as typeof source),
      models: cycle.models.map(model => withoutReference(model) as typeof model),
      excluded: cycle.excluded.map(bucket => ({ ...bucket, usage: withoutReference(bucket.usage) })) } };
}

/**
 * The fingerprint of the rates a provider's calls are valued at on `day`: the configured model rates in
 * effect then (Codex: the ledger's API bands in effect then, under its rules). Two days with one fingerprint
 * value every call alike, so a stored variant answers both.
 */
export function referenceFingerprint(rateCards: RateCard, provider: string, day: string, selectedModels?:readonly string[]): string {
  if (provider === "codex") {
    const ledger = codexLedgerReadContext(rateCards);
    const bands=selectedModels===undefined?ledger.policy.baseBands:ledger.policy.baseBands.filter(b=>selectedModels.includes(b.model));
    return digest(["codex", codexLedgerReferenceRevision(bands, day), selectedModels===undefined?ledger.rulesRevision??null:null]);
  }
  const adapter = subscriptionAccountingAdapter(provider);
  const models = selectedModels===undefined?Object.keys(rateCards.vendors?.[adapter.rateVendor]?.models ?? {}).sort():[...selectedModels].sort();
  const quantities = (input: number) => ({ in_uncached: input, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0,
    in_cache_write_unknown: 0, out_total: 0 });
  return digest([adapter.id, adapter.rateVendor, models.map(model => {
    const select = (input: number) => subscriptionRateSelection(rateCards, adapter,
      { model, ts: `${day}T00:00:00.000Z`, speed: "standard", quantities: quantities(input) }, true, day);
    const base = select(0);
    // An untiered model keeps its earlier fingerprint; a tiered one adds its threshold and long rates on that day.
    if (base.contextThreshold === undefined) return [model, base.rate ?? null];
    return [model, { base: base.rate ?? null, above_input_tokens: base.contextThreshold,
      long: select(base.contextThreshold + 1).rate ?? null }];
  })]);
}

/**
 * The producer's reference valuations for `day`: every provider values a call when it is read, from the rate
 * card (Codex: the ledger's API bands in effect on that day, codex-ledger-reference.ts).
 */
/** Reference valuations by rate card object, provider and day; deriving them took about 40 ms of every idle turn. */
const referencePlans = new WeakMap<RateCard, Map<string, ReferenceValuation>>();

export function producerReferencePlan(rateCards: RateCard, day: string): ReferencePlan {
  let plans = referencePlans.get(rateCards);
  if (!plans) referencePlans.set(rateCards, plans = new Map());
  return provider => {
    const key = `${provider}\u0000${day}`;
    let plan = plans.get(key);
    if (!plan) plans.set(key, plan = { day, fingerprint: referenceFingerprint(rateCards, provider, day) });
    return plan;
  };
}
