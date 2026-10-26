import type { Database } from "../db/sqlite";
import { missingRateSummary, type UnpricedRateItem, type MissingRateSummary } from "../shared/missing-rate";
import { readMissingRateTokens } from "./ledger-sums";
import { isKnownUnpriced, isMarkedFree, normalizeRateVendor, type RateCard } from "./pricing";
import { ledgerProviderOf } from "./subscription-accounting-adapters";

/** The rate card each shared-ledger provider prices against when its call names no other vendor. */
const PROVIDER_RATE_VENDOR: Readonly<Record<string, string>> = { claude: "anthropic", gemini: "google", grok: "xai", glm: "zai" };

/**
 * Models whose calls the ledgers stored as unpriced for a missing rate (reason `missing_rate`), with their
 * tokens over the whole history, read from the stored valuations; nothing is priced here. The one rule of what
 * is not a missing price: models declared intentionally unpriced, models marked free, and every model of a
 * provider whose amounts are its own reported money (adapter `cardMoney`). The alert, the cards, the Settings
 * table and the data-sources check all read this.
 */
export function readMissingRates(db: Database, card: RateCard): MissingRateSummary {
  // One count per vendor and model: the Standard valuation the API-eq amounts show, else the largest variant.
  const models = new Map<string, UnpricedRateItem & { standard: boolean }>();
  for (const row of readMissingRateTokens(db)) {
    if (row.ledger === "usage" && ledgerProviderOf(row.provider)?.cardMoney === "reported") continue;
    const observed = normalizeRateVendor(row.vendor ?? PROVIDER_RATE_VENDOR[row.provider] ?? row.provider) ?? row.provider;
    const key = `${observed}::${row.model}`, standard = row.variant === "api_standard";
    const current = models.get(key);
    if (current && (current.standard || (!standard && current.tokens >= row.tokens))) continue;
    // A vendor without its own rate card cannot be priced in Settings.
    models.set(key, { model: row.model, observed_provider: observed, rate_vendor: card.vendors?.[observed] ? observed : null,
      tokens: row.tokens, first_day: row.first_day, standard });
  }
  return missingRateSummary([...models.values()].map(({ standard: _standard, ...item }) => item),
    (vendor, model) => isKnownUnpriced(card, vendor, model) || isMarkedFree(card, vendor, model));
}
