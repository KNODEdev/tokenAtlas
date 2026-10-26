/**
 * Context-dependent pricing shared by every provider and model. A rate block may carry a
 * `long_context` tier: its rates apply to a request whose prompt input is strictly above
 * `above_input_tokens`. A model may have a tier or not; one without stays on its single rates.
 *
 * Prompt input is the whole request input including cache reads and writes, never output, and it
 * is judged per request: aggregated tokens cannot choose a band. How a provider counts it differs
 * (Codex reports input with cache included, the shared ledger stores disjoint buckets), so callers
 * pass the number and this module only decides.
 */
export interface ContextTier<R> {
  above_input_tokens: number;
  rates: R;
}

/** `unknown`: the model is tiered but the request's prompt size is absent or not a valid count. */
export type ContextBand = "base" | "long" | "unknown";

export function validContextThreshold(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** The band of one request, or null when the tier is absent (the model has one set of rates). */
export function contextBand(tier: Pick<ContextTier<unknown>, "above_input_tokens"> | null | undefined,
  promptInput: number | null | undefined): ContextBand | null {
  if (!tier) return null;
  if (promptInput == null || !Number.isSafeInteger(promptInput) || promptInput < 0) return "unknown";
  return promptInput > tier.above_input_tokens ? "long" : "base";
}

/** Whether a request of `promptInput` belongs to a compiled band (`long` strictly above, `normal` at or below). */
export function inContextBand(band: "normal" | "long", threshold: number | undefined, promptInput: unknown): boolean {
  if (threshold === undefined) return true;
  if (typeof promptInput !== "number") return false;
  return band === "long" ? promptInput > threshold : promptInput <= threshold;
}

/** Prompt input of disjoint buckets; null when any part is not a non-negative safe integer. */
export function disjointPromptInput(parts: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0;
  for (const part of parts) {
    if (part == null || !Number.isSafeInteger(part) || part < 0) return null;
    sum += part;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * The rates of one request from the selected block (base, dated `after` or `fast`). The block's own
 * tier decides; when only the model's base block is tiered, the variant's rates are known for the
 * base band only, so a long or unknown request stays unpriced instead of borrowing other rates.
 */
export function selectContextRates<R>(block: R | undefined, ownTier: ContextTier<R> | null | undefined,
  modelTier: Pick<ContextTier<unknown>, "above_input_tokens"> | null | undefined, promptInput: number | null | undefined):
  { rates: R | undefined; band: ContextBand | null; threshold: number | undefined } {
  const tier = ownTier ?? modelTier;
  const band = contextBand(tier, promptInput);
  const threshold = tier?.above_input_tokens;
  if (band === null || band === "base") return { rates: block, band, threshold };
  if (band === "long" && ownTier) return { rates: ownTier.rates, band, threshold };
  return { rates: undefined, band, threshold };
}
