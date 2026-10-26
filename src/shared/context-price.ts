import type { WindowUsage } from "./codex-accounting";

/** A stored context split expressed in Standard API dollars, never a new valuation. */
export interface ContextPrice {
  base: number;
  extra: number;
  stored: number;
  /** Explicit for request projections; older window splits infer it from their stored total. */
  included?: boolean;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);

/** The register's split is normalized; Standard dollars use the same ratio as Capacity. */
export function storedContextPrice(usage: Pick<WindowUsage, "api_standard" | "priced_tokens"> & Partial<WindowUsage>): ContextPrice | undefined {
  const base = usage.context_api_base, extra = usage.context_api_extra;
  const total = usage.api_normalized ?? usage.api_standard;
  if (base === undefined || extra === undefined || usage.context_priced_tokens !== usage.priced_tokens
    || ![base, extra, total, usage.api_standard].every(Number.isFinite) || base < 0 || extra < 0 || total < 0
    || usage.api_standard < 0 || !near(total, base) && !near(total, base + extra)) return;
  if (total === 0) return base === 0 && extra === 0 && usage.api_standard === 0 ? { base: 0, extra: 0, stored: 0 } : undefined;
  const scale = usage.api_standard / total;
  return { base: base * scale, extra: extra * scale, stored: usage.api_standard };
}

/** Preview off preserves the exact response; already included uplift is never added twice. */
export function previewContextAmount<T extends number | null>(value: T, price: ContextPrice | undefined, on: boolean): T {
  if (on && value !== null && price?.included !== undefined) {
    if (price.included || ![value, price.extra, price.stored].every(Number.isFinite) || price.extra < 0 || price.stored < 0) return value;
    return (price.stored > 0 ? value + value * price.extra / price.stored : value === 0 && price.stored === 0 ? price.extra : value) as T;
  }
  if (!on || value === null || !price || !(price.stored > 0)
    || ![price.base, price.extra, price.stored].every(Number.isFinite) || price.base < 0 || price.extra < 0) return value;
  if (near(price.stored, price.base + price.extra)) return value;
  return (value * ((price.base + price.extra) / price.stored)) as T;
}

export function sumContextPrices(prices: readonly (ContextPrice | undefined)[]): ContextPrice | undefined {
  if (!prices.length || prices.some(price => !price)) return;
  return (prices as ContextPrice[]).reduce((sum, price) => ({ base: sum.base + price.base, extra: sum.extra + price.extra,
    stored: sum.stored + price.stored }), { base: 0, extra: 0, stored: 0 });
}

/** Rounded endpoint amounts may differ by half a cent; stale or differently scoped sums stay unclassified. */
export function matchingContextPrice(price: ContextPrice | undefined, amount: number | null): ContextPrice | undefined {
  return price && amount !== null && Math.abs(price.stored - amount) <= 0.00500001 ? price : undefined;
}
