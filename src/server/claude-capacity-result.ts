import type { Database } from "bun:sqlite";
import type { ClaudeCodeCapacitySummary } from "../shared/claude-code-capacity";
import { claudeCapacityResult, claudeCapacityResultFromSummary } from "../shared/claude-capacity-result";
import { claudeWeeklyRegisterWindows, type ProbeLimitWindow } from "./probe-limit-windows";
import { comparisonWindow, intervalSums, readingIndexAt, spendThroughReading } from "./window-usage-presentation";
import { readWindowSums } from "./window-usage-read";

/** Resolve historical share-less windows from the same stored meter/model sums as all other cycles. */
export function readClaudeCapacityResult(sqlite: Database, summary: ClaudeCodeCapacitySummary,
  windows?: readonly ProbeLimitWindow[]) {
  if (summary.reason === null || !summary.window_id || !summary.meter_read_at)
    return claudeCapacityResultFromSummary(summary);
  const window = (windows ?? claudeWeeklyRegisterWindows(sqlite, summary.account)).find(row => row.id === summary.window_id);
  if (!window || window.window_minutes !== 10080) return claudeCapacityResultFromSummary(summary);
  const readings = window.readings.filter(reading => Date.parse(reading.ts) <= Date.parse(summary.meter_read_at!));
  if (!readings.length) return claudeCapacityResultFromSummary(summary);
  const sums = readWindowSums(sqlite, "claude", summary.account, window.counter, [window], ["cycle", "readings"]).get(window.id)!;
  const selected = comparisonWindow({ ...window, readings }, sums.cycle);
  const through = selected.end, after = selected.start_basis === "reset" ? null : selected.start;
  const delta = intervalSums(sums, after, through);
  const endIndex = readingIndexAt(sums.readings, Date.parse(through));
  const firstIndex = after ? readingIndexAt(sums.readings, Date.parse(after)) : -1;
  if (!delta || endIndex < 0) return claudeCapacityResultFromSummary(summary);
  const before = new Map((firstIndex < 0 ? [] : spendThroughReading(sums.readings, firstIndex).spend).map(row => [row.model, row]));
  const models = spendThroughReading(sums.readings, endIndex).spend.map(row => {
    const first = before.get(row.model);
    return { ...delta.usage, fast_tokens: 0, unknown_tokens: 0, name: row.model ?? "?", events: row.events - (first?.events ?? 0),
      tokens: row.tokens - (first?.tokens ?? 0), input: row.fresh - (first?.fresh ?? 0), cached: 0, output: 0,
      api_standard: row.standard - (first?.standard ?? 0), unpriced_events: row.standard_unpriced - (first?.standard_unpriced ?? 0) };
  }).filter(row => row.events > 0 || row.tokens > 0);
  const result = claudeCapacityResult({ ...selected, usage: { ...selected.usage, ...delta.usage }, models,
    claude_code_capacity: summary });
  const full = comparisonWindow(window, sums.cycle);
  // Reading totals retain gross tokens; category splits exist only for the prepared paired span.
  if (selected.start !== full.start || selected.end !== full.end) delete result.token_parts;
  return result;
}
