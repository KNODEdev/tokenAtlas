import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";

export type ModelMode = "standard" | "fast" | "unknown";

/** One model over the selected dates: its tokens split by recorded mode, calls and Standard API value. */
export interface ModelUsageRow {
  /** null: the source recorded no model name. */
  model: string | null;
  tokens: number;
  calls: number;
  modes: Record<ModelMode, number>;
  /** Standard API value of the priced part; null when no part of the model has a rate. */
  apiUsd: number | null;
  /** Some calls have no Standard rate, so `apiUsd` is a known lower bound. */
  apiPartial: boolean;
  /** Codex Speed credits above Standard; null when none were priced. */
  extraCredits: number | null;
  /** Some Speed calls have no credit rate, so `extraCredits` is a known lower bound. */
  extraPartial: boolean;
}

export interface ModelUsageSummary {
  rows: ModelUsageRow[];
  tokens: number;
  calls: number;
  modes: Record<ModelMode, number>;
  apiUsd: number | null;
  apiPartial: boolean;
}

interface Part {
  model: string | null;
  mode: ModelMode;
  tokens: number;
  calls: number;
  api: number | null;
  unpriced: boolean;
  extra: number | null;
  extraUnpriced: boolean;
}

const modeOf = (speed: string | null | undefined): ModelMode => speed === "fast" ? "fast" : speed === "standard" ? "standard" : "unknown";
const emptyModes = (): Record<ModelMode, number> => ({ standard: 0, fast: 0, unknown: 0 });

function summarize(parts: Part[]): ModelUsageSummary {
  const byModel = new Map<string | null, ModelUsageRow>();
  for (const part of parts) {
    const row = byModel.get(part.model) ?? { model: part.model, tokens: 0, calls: 0, modes: emptyModes(), apiUsd: null, apiPartial: false, extraCredits: null, extraPartial: false };
    row.tokens += part.tokens;
    row.calls += part.calls;
    row.modes[part.mode] += part.tokens;
    if (part.api != null) row.apiUsd = (row.apiUsd ?? 0) + part.api;
    row.apiPartial ||= part.unpriced;
    if (part.extra != null) row.extraCredits = (row.extraCredits ?? 0) + part.extra;
    row.extraPartial ||= part.extraUnpriced;
    byModel.set(part.model, row);
  }
  // Largest first; traffic without a model name is a caveat, so it closes the list whatever its size.
  const rows = [...byModel.values()].sort((a, b) => Number(a.model == null) - Number(b.model == null) || b.tokens - a.tokens);
  const modes = emptyModes();
  for (const row of rows) for (const mode of Object.keys(modes) as ModelMode[]) modes[mode] += row.modes[mode];
  const priced = rows.filter(row => row.apiUsd != null);
  return {
    rows,
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    modes,
    apiUsd: priced.length ? priced.reduce((sum, row) => sum + row.apiUsd!, 0) : null,
    apiPartial: rows.some(row => row.apiPartial),
  };
}

/** Codex: the accounting report's day × model × mode × source rows. */
export function codexModelUsage(breakdown: CodexAccountingReport["breakdown"]): ModelUsageSummary {
  return summarize(breakdown.map(row => {
    const api = row.normalization.standard_api_usd;
    const extra = row.normalization.extra_credits;
    return {
      model: row.model,
      mode: modeOf(row.speed),
      tokens: row.tokens,
      calls: row.events,
      api: api.priced_events > 0 ? api.priced_subtotal : null,
      unpriced: api.unpriced_events > 0,
      extra: extra.priced_events > 0 ? extra.priced_subtotal : null,
      extraUnpriced: extra.unpriced_events > 0,
    };
  }));
}

/** Other providers: the model detail rows; a row without a Standard value is unpriced as a whole. */
export function detailModelUsage(details: SubscriptionModelDetail[]): ModelUsageSummary {
  return summarize(details.map(row => {
    const api = typeof row.api_standard === "number" && Number.isFinite(row.api_standard) ? row.api_standard : null;
    return {
      model: row.model || null,
      mode: modeOf(row.speed),
      tokens: row.tokens,
      calls: row.calls,
      api,
      unpriced: api == null && row.tokens > 0,
      extra: null,
      extraUnpriced: false,
    };
  }));
}
