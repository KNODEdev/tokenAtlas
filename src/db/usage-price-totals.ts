import { analysisHash } from "./analysis";
import { codexPricingKey, resolveCodexAccountingConfig } from "../server/codex-accounting-pricing";
import { codexHomeSource } from "../server/event-source";
import type { SourceDeclaration } from "../server/archive-source";
import type { RateCard } from "../server/pricing";
import { VENDOR_CONTEXT_PREMIUM_RULE, vendorContextPremium, vendorHasContextTier } from "../server/vendor-context-premium";
import { providerModelRateRules, subscriptionAccountingAdapter, UNKNOWN_MODE_RATE_RULE,
  type SubscriptionAccountingAdapter } from "../server/subscription-accounting-adapters";

/**
 * The shared read contract of priced usage: the amount, dimension and day shapes every report
 * reads, whichever producer filled them. Codex is valued by its price ledger
 * (`codex-price-ledger.ts`), Claude, Gemini, Grok and GLM by the usage ledger (`usage-ledger.ts`);
 * both publish these shapes through their read adapters. The provider-scoped register that
 * produced them before (WP4b, `usage_price_*`) was removed with migration 0047.
 */
export const USAGE_PRICE_TOTALS_VERSION = 8;

export type UsagePriceMirror = "all" | "range";
export interface UsagePriceRange { since: string; until: string }
export interface UsagePriceDimension {
  /** Archive folder of the contribution (`claude/example-main`); null outside the archive. */
  source: string | null;
  /** Identity the session itself recorded (Claude `account_key`); null when none. */
  identity: string | null;
  model: string | null;
  speed: string | null; subject: string | null; billing_mode: string | null; surface: string | null;
  /** Raw `events.nested`; with `model` it decides global usage's internal-review branch. */
  nested: string | null;
  /**
   * The global-usage rate vendor of a contribution the provider's own accounting track does not
   * own, and NULL for every contribution that track does own: it carries the vendor global usage
   * prices unassigned traffic under, and keeps such traffic out of every account-scoped report.
   */
  vendor: string | null;
}
export interface UsagePriceDimRow extends UsagePriceDimension {
  dim: string; day: string; calls: string;
  /** Disjoint buckets. `reasoning_out` is nested inside `out_total` and is not one of them. */
  tokens: Record<string, string>;
  /** The measure the reports count: Codex `in_tok + out_tok`, zero when either is unusable. */
  tokens_reported: string;
  first_ts: string;
  /** Ordering key of the earliest contribution. */
  first_key: string;
  last_ts: string;
  variants: Record<string, UsagePriceAmount>;
  quality: Record<string, string>;
}
export interface UsagePriceTotals {
  status: "available" | "unavailable";
  reason: string | null;
  scope: string;
  provider: string;
  cursor: number | null;
  provenance: { version: number; arithmetic: string; rulesDigest: string; mirror: UsagePriceMirror;
    mirrorPolicy: number; attribution: string | null };
  calls: string;
  tokens: Record<string, string> | null;
  tokens_reported: string;
  first_ts: string | null;
  last_ts: string | null;
  variants: Record<string, UsagePriceAmount> | null;
  quality: Record<string, string> | null;
}
export interface UsagePriceBatch {
  complete: boolean; processed: number; reason?: string;
  /** The producer answers readers, but some of its aggregates are still being summed in the background. */
  building?: boolean;
}

/**
 * The arithmetic subscription amounts are published under; readers compare it as provenance. The
 * usage ledger values every event exactly in nano- plus femto-dollars and sums integers.
 */
export const PRICE_TOTAL_ARITHMETIC = "exact-femto-usage-ledger-v1";
/** `AmountCoverage.reasons` counts events *and* tokens per reason; both stay additive. */
type Reason = { events: string; tokens: string };
/**
 * `subtotal` is every computable bucket cost, including an event left unpriced because one
 * nonzero bucket has no rate. `pricedSubtotal` is the report's `AmountCoverage.priced_subtotal`:
 * the sum over fully priced events only. The two differ exactly on partially rated events.
 */
type Amount = { subtotal: string; pricedEvents: string; unpricedEvents: string;
  pricedSubtotal: string; pricedTokens: string; unpricedTokens: string; reasons: Record<string, Reason> };
export type UsagePriceAmount = Amount & { value: string | null; exact?: {
  subtotal: { numerator: string; denominator: string; decimal: string | null };
  pricedSubtotal: { numerator: string; denominator: string; decimal: string | null };
  value: { numerator: string; denominator: string; decimal: string | null } | null;
} };

/** The stored key of a Codex physical copy, for a reader that holds the source's home and path. */
export const usagePriceCopyKey = (home: string | null, path: string | null): string =>
  analysisHash(["copy", JSON.stringify([home, path])]).slice(0, 16);

/** The Codex mirror source-home stamp: which local homes copy which archive folder. */
export function usagePriceSourcesStamp(homes: readonly string[], declarations: readonly SourceDeclaration[] = [], archiveRoot = ""): string {
  const norm = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const mappings = [...new Set(declarations.filter(d => d.source_home && /^(codex|openai)$/i.test(d.vendor ?? "codex"))
    .map(d => norm(d.source_home!)))].sort().map(home => [home, codexHomeSource(home, declarations, archiveRoot)]);
  // Retain the priority set so a mapping-only edit need not reselect unrelated mirrors.
  return JSON.stringify([[...new Set(homes.map(norm))].sort(), mappings, norm(archiveRoot)]);
}

/** The rate vendors a provider's valuations read (`valuationVendors`); `all` is every configured vendor. */
function subscriptionRegisterVendors(card: RateCard, adapter: SubscriptionAccountingAdapter): readonly string[] {
  const vendors = adapter.valuationVendors ?? [adapter.rateVendor];
  return vendors === "all" ? [...new Set([...Object.keys(card.vendors), "unknown"])].sort() : vendors;
}
const rulesDigests = new WeakMap<RateCard, Map<string, string>>();
/**
 * Everything of a card a provider's valuations depend on. A change marks the provider's ledger for
 * revaluation; readers report "rules pending" until it is done. Memoised per card.
 */
export function subscriptionRulesDigest(card: RateCard, provider: string): string {
  const adapter = subscriptionAccountingAdapter(provider);
  let cached = rulesDigests.get(card);
  if (!cached) { cached = new Map(); rulesDigests.set(card, cached); }
  const known = cached.get(adapter.id);
  if (known !== undefined) return known;
  const digest = analysisHash([card.version, card.currency, card.unit,
    subscriptionRegisterVendors(card, adapter).map(vendor => card.vendors[vendor] ?? null),
    adapter.speed, ...providerModelRateRules(adapter),
    // Only a provider that records a mode has a mode rule or unknown-mode calls; the others keep their digest.
    ...(adapter.speed ? [UNKNOWN_MODE_RATE_RULE] : []),
    ...(adapter.speedNormalization ? [adapter.speedNormalization.rule] : []),
    // OpenCode rows that name OpenAI are priced by the Codex accounting rules, as global usage
    // prices them, so this provider depends on those rules as well as on the card's vendors.
    adapter.valuationVendors === "all" ? codexPricingKey(resolveCodexAccountingConfig(card)) : null,
    // The premium's default is code, not card: name it so a provider with tiered models revalues when it changes.
    ...subscriptionRegisterVendors(card, adapter).filter(vendor => vendorHasContextTier(card, vendor))
      .map(vendor => [VENDOR_CONTEXT_PREMIUM_RULE, vendor, vendorContextPremium(card, vendor)])]);
  cached.set(adapter.id, digest);
  return digest;
}
