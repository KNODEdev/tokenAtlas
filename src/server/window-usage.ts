/**
 * Window usage (plan U1.2): the one owner of the sums of a limit window.
 *
 * Contract. For every window of `limit_windows` the analysis maintenance worker stores one
 * `window_usage` row, computed from the ledgers (Codex price ledger, `usage_ledger_*`) by
 * `computeWindowSums`, the canonical definition (docs/u1.0-window-definition-2026-10-04.md §3):
 *
 * - the cycle is `[start, end)` of the stored window, never clipped to a request range;
 * - within an account and counter the first chronological window owns traffic that overlapping
 *   cycles share; manual intervals inside a window are its readings;
 * - the provider adapter admits traffic (Codex: no Spark, reserve tier or credit funding; a weekly
 *   event pairs only with its own reset; others: the counter's own traffic with a precise instant);
 *   every left-out event stays in an explicit excluded bucket with its reason and usage;
 * - the paired part runs from the confirmed reset (or first reading) to the last reading that counts
 *   (a manual end or the first 100%); the rest of the cycle is unpaired;
 * - amounts are the ledgers' stored prices: the jointly priced window_* cohort and API Standard.
 *   The reference-day variant (plan U1.4) is stored for the configured reference day, today's UTC day by
 *   default (the day the screens compare prices at), under a fingerprint of that day's effective rates; it
 *   is recomputed when the rates change. A request for a day with other rates values its windows itself:
 *   the one named bounded exception, a read of each requested window's own calls (see `referenceFingerprint`).
 *
 * Work is ordered by writers through `window_usage_dirty` (see `markWindowUsageDirty`): new or
 * corrected ledger events and repricing (the ledger producers), changed windows (the limit-window
 * producer), changed account periods (the period store). Readers never compute: a window without a
 * row is "preparing" (`WindowUsagePreparing`); a row being recomputed stays readable.
 *
 * Intervals (plan U1.4). Three measured spans that are not limit windows get rows of the same shape,
 * keyed by their own id: standalone manual measurements (`manual:<id>`, `(start, end]`, independent of
 * the meter windows), Claude gauge observations from claude-gauge.json (`gauge:…`, `[start, cutoff)`)
 * and Claude windows reconstructed from the cadence for weeks without meter readings (`declared:…`,
 * `[start, reset)`). The producer publishes the interval list (`meta` key `window_usage_intervals`)
 * from its configuration inputs; readers take the list from there, so they never see an interval the
 * producer does not maintain. A declared window is never a measurement: its row keeps the traffic no
 * account owns (`rail.unowned`) so a reader can tell missing ownership from real zero usage.
 *
 * Grok and Gemini (plan U1.4, `grok-gauge-spans.ts`): the observations of grok-gauge.json (`gauge:…`,
 * `[start, ts)`), and fallbacks for the account cards: rolling spans up to and including the account's newest
 * call (`rolling:<minutes>`), Grok's anchored period holding that call when a reset anchor is declared, and
 * Gemini's weekly window ending at the reset of its newest quota reading (`anchored:…`). A fallback holds all
 * the account's calls by their recorded instant (Gemini records conversation times only). Fallbacks are
 * recomputed when the provider's ledger revision, its accounts, the anchor or the reading change; their
 * provenance is the kind, and readers never present them as measured.
 */

export { WINDOW_USAGE_VERSION, CODEX_WINDOW_UNITS_RULE, CODEX_WINDOW_CONTEXT_RULE } from "./window-usage-contracts";
export type { RunningUsage, ModelSpend, ProductTotals, ActivityCurve, WindowCycleSums, WindowModelTraffic, WindowRailSums, WindowReadingSums, WindowSlice, WindowReferenceVariant, WindowSums, WindowEventFacts, WindowTraffic, ClaudeWindowDetail, WindowCuts, WindowEventReader, ReferenceValuation, ReferencePlan, CachedWindowEventReader, WindowSumsPart, StoredModelCapacityWindow, StoredModelUsageShareWindow, WindowUsageProducerOptions, WindowUsageProducerStats, WindowInterval, ClaudeHourBlock } from "./window-usage-contracts";
export { computeWindowSums, windowCuts, emptyProductTotals } from "./window-usage-compute";
export { unpricedModels, comparisonWindow, intervalSums, totalSpend, readingIndexAt, tokensByLocalDay, claudeHourBlocks, spendThroughReading } from "./window-usage-presentation";
export { codexWindowTraffic, subscriptionWindowTraffic } from "./window-usage-traffic";
export { windowEventReader, WindowEventDays, cachedWindowEventReader } from "./window-usage-events";
export { windowSumsFromLedgers, intervalSumsFromLedgers } from "./window-usage-ledger-sums";
export { referenceFingerprint } from "./window-usage-reference";
export { WindowUsagePreparing, readModelCapacityWindows, readModelUsageShareWindows, readWindowSums, readWindowIntervals, readSpanSums } from "./window-usage-read";
export { emptyWindowUsageStats, advanceWindowUsage, windowUsageProgress, computeWindowUsageFull } from "./window-usage-producer";
export { WINDOW_USAGE_CLOCK, windowUsageDependency } from "./window-usage-clock";
