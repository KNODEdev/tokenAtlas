import fs from "node:fs";
import { configFile } from "../config/paths";
import type { ModelRateAny, RateCard } from "./pricing";
import contextCatalog from "../../config/context-rates.json";
import { validContextThreshold } from "../shared/context-tier";

export interface RateCardsRead { rates: RateCard | null; changed: boolean }

type CatalogEntry = ModelRateAny & { long_context?: ModelRateAny["long_context"] | null };
const CONTEXT_RATES = (contextCatalog as unknown as { vendors: Record<string, Record<string, CatalogEntry>> }).vendors;
for (const [vendor, models] of Object.entries(CONTEXT_RATES)) for (const [model, entry] of Object.entries(models))
  if (entry.long_context && !validContextThreshold(entry.long_context.above_input_tokens))
    throw new Error(`config/context-rates.json: ${vendor}/${model} has an invalid above_input_tokens`);

/**
 * Merges the context-tier catalog into a card, for any vendor and model. The catalog lives apart from
 * rate-cards.json because a process whose code ignores tiers would price every tiered call at its base
 * rates; only code that reads this module sees it. Fields of the card's own entry win, and its
 * `"long_context": null` removes the tier.
 */
export function withContextRates(card: RateCard): RateCard {
  const vendors: RateCard["vendors"] = { ...card.vendors };
  for (const [vendor, catalog] of Object.entries(CONTEXT_RATES)) {
    const models: Record<string, ModelRateAny> = { ...(vendors[vendor]?.models ?? {}) };
    for (const [model, entry] of Object.entries(catalog)) {
      const merged: CatalogEntry = { ...entry, ...(models[model] as CatalogEntry | undefined) };
      if (merged.long_context === null) delete merged.long_context;
      models[model] = merged as ModelRateAny;
    }
    vendors[vendor] = { ...(vendors[vendor] ?? {}), models };
  }
  return { ...card, vendors };
}

export function loadRateCard(file: string): RateCard {
  return withContextRates(JSON.parse(fs.readFileSync(file, "utf8")) as RateCard);
}

/**
 * Reads rate-cards.json again only when the file (path, mtime, size) changed. An unchanged file gives the
 * same object every time, so what a caller keys by it stays put. A file that does not parse (an external
 * editor caught mid-write, a broken edit) throws and is read again on the next call; the app's own writers
 * replace the file atomically.
 */
export function rateCardsFileReader(file: () => string = () => configFile("rate-cards.json")): () => RateCardsRead {
  let last: { stamp: string; rates: RateCard | null } | null = null;
  return () => {
    const path = file();
    const stat = fs.statSync(path, { throwIfNoEntry: false });
    const stamp = stat ? `${path}:${stat.mtimeMs}:${stat.size}` : "";
    if (last?.stamp === stamp) return { rates: last.rates, changed: false };
    const parsed = stat ? JSON.parse(fs.readFileSync(path, "utf8")) as RateCard : null;
    const changed = last !== null;
    last = { stamp, rates: parsed?.vendors ? withContextRates(parsed) : null };
    return { rates: last.rates, changed };
  };
}
