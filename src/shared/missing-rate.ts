/**
 * Models used in traffic that the rate card does not price (reason `missing_rate`). Their tokens are not
 * zero cost: an API-equivalent amount that leaves them out is incomplete, and the user is asked to enter
 * the price in Settings. No price is estimated for them.
 */

/** Unpriced tokens of one model inside a window or cycle. */
export interface UnpricedModel { model: string; tokens: number }

/** A model seen in traffic without a price in its vendor's rate card; known-unpriced models are not listed. */
export interface MissingRateModel extends UnpricedModel {
  observed_provider: string; rate_vendor: string;
  /** The first UTC day with such a call: where a new price period would start. */
  first_day?: string;
}
/** A model of a vendor that has no rate card at all: it cannot be priced in Settings, so it raises no alert. */
export interface UnpriceableModel extends UnpricedModel { observed_provider: string; rate_vendor: null; first_day?: string }

/**
 * `/api/missing-rates` (and `/api/health.unpriced`): every missing-rate model with its unpriced tokens over the
 * whole history. `tokens` and `models` are what the alert, the cards and the Settings check report.
 */
export interface MissingRateSummary { tokens: number; models: MissingRateModel[]; unpriceable?: UnpriceableModel[] }

export interface UnpricedRateItem { model: string; observed_provider: string; rate_vendor: string | null; tokens: number; first_day?: string }

/**
 * The missing-rate summary of the unpriced items. `notMissing` names models that are not missing a price:
 * declared intentionally unpriced, marked free, or of a provider whose amounts are its own reported money.
 * An unidentified model ("?") is left out; a vendor without any rate card goes to `unpriceable`.
 */
export function missingRateSummary(items: readonly UnpricedRateItem[],
  notMissing: (vendor: string, model: string) => boolean): MissingRateSummary {
  const byModel = new Map<string, UnpricedRateItem>();
  for (const item of items) {
    if (item.tokens <= 0 || !item.model || item.model === "?") continue;
    if (notMissing(item.rate_vendor ?? item.observed_provider, item.model)) continue;
    const key = `${item.rate_vendor ?? item.observed_provider}::${item.model}`;
    const row = byModel.get(key) ?? { model: item.model, observed_provider: item.observed_provider, rate_vendor: item.rate_vendor, tokens: 0 };
    row.tokens += item.tokens;
    if (item.first_day && (!row.first_day || item.first_day < row.first_day)) row.first_day = item.first_day;
    byModel.set(key, row);
  }
  const order = (a: UnpricedModel, b: UnpricedModel) => b.tokens - a.tokens || a.model.localeCompare(b.model);
  const all = [...byModel.values()].sort(order);
  const models = all.filter((row): row is MissingRateModel => row.rate_vendor !== null);
  const unpriceable = all.filter((row): row is UnpriceableModel => row.rate_vendor === null);
  return { tokens: models.reduce((sum, row) => sum + row.tokens, 0), models, ...(unpriceable.length ? { unpriceable } : {}) };
}

/**
 * The unpriced tokens of a window that belong to missing-rate models. A window's other unpriced tokens
 * (unknown mode, invalid usage, known-unpriced models) keep their existing treatment.
 */
export function missingRateIn(unpriced: readonly UnpricedModel[] | Readonly<Record<string, number>> | null | undefined,
  summary: MissingRateSummary | null | undefined): { tokens: number; models: UnpricedModel[] } {
  if (!unpriced || !summary?.models.length) return { tokens: 0, models: [] };
  const missing = new Set(summary.models.map(row => row.model));
  const rows = Array.isArray(unpriced) ? unpriced as readonly UnpricedModel[]
    : Object.entries(unpriced).map(([model, tokens]) => ({ model, tokens }));
  const byModel = new Map<string, number>();
  for (const row of rows) if (row.tokens > 0 && missing.has(row.model)) byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.tokens);
  const models = [...byModel].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return { tokens: models.reduce((sum, row) => sum + row.tokens, 0), models };
}
