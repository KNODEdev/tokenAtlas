import type { Database } from "bun:sqlite";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { advanceWindowUsage, codexWindowTraffic, computeWindowSums, type WindowTraffic, type WindowUsageProducerOptions } from "./window-usage";
import type { MeterEvent, WindowAccountingAdapter } from "./subscription-window-comparison";
import type { CalibrationEvent, CodexProbe } from "./codex-calibration";
import type { CodexAccountingConfig } from "./codex-accounting-pricing";
import { observedPeriods } from "./account-periods";
import { buildProbeLimitWindows } from "./probe-limit-windows";
import { codexVisibleLimitWindows } from "./codex-limit-windows";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";

/**
 * Runs the maintenance worker's window-usage producer on a fixture until idle, as the worker would
 * between a test's writes and its reads. Readers never compute window sums themselves.
 */
export function prepareWindowUsageFixture(db: Database, options: Omit<WindowUsageProducerOptions, "budgetMs">): void {
  for (let turn = 0, idle = 0; turn < 10_000; turn++) {
    const result = advanceWindowUsage(db, { ...options, budgetMs: 1e9 });
    if (!result.pending) return;
    // Idle twice, a ledger is preparing and readers answer "preparing", as in production.
    idle = result.progressed ? 0 : idle + 1;
    if (idle > 1) return;
  }
  throw new Error("Window usage fixture did not settle");
}

/**
 * Comparison windows of pure fixtures, through the canonical definition: the readings segmented into
 * windows (plans observed from the readings, as a fixture has no plan periods), the screens' visible
 * windows, each summed by `computeWindowSums` with every earlier window of its account taking its share.
 */
export function meterWindowsFixture<Event extends MeterEvent>(events: readonly Event[], probes: readonly CodexProbe[],
  traffic: WindowTraffic<Event>, detailCycleId?: string): CodexComparisonWindow[] {
  const minutes = traffic.adapter.windowMinutes, out: CodexComparisonWindow[] = [];
  const subjects = [...new Set(probes.filter(probe => probe.window_minutes === minutes).map(probe => probe.subject))];
  for (const account of subjects) {
    const rows = probes.filter(probe => probe.subject === account && probe.window_minutes === minutes);
    const periods = observedPeriods(rows.filter(row => row.plan).map(row => ({ provider: "codex", subject: account, ts: row.ts, value: row.plan! })));
    const register = buildProbeLimitWindows({ provider: "codex", account, counter: JSON.stringify(["codex", "codex", minutes]), periods,
      readings: rows.filter(row => row.resets_at).map(row => ({ ts: row.ts, used_percent: row.used_percent, resets_at: row.resets_at!,
        window_minutes: minutes, source: row.kind === "session" ? "session" as const : "probe" as const })) });
    const visible = new Set(codexVisibleLimitWindows(register).map(window => window.id));
    register.forEach((window, index) => {
      if (visible.has(window.id)) out.push(computeWindowSums(window, register.slice(0, index), events, traffic, window.id === detailCycleId).comparison);
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** A generic adapter's traffic for `meterWindowsFixture`: the facts a test without prices needs. */
export const fixtureTraffic = <Event extends MeterEvent>(adapter: WindowAccountingAdapter<Event>): WindowTraffic<Event> => ({ adapter,
  facts: event => ({ model: event.model, speed: "unknown", surface: null, reasoning: 0, api_standard: null,
    tokens: { in_uncached: 0, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 0 } }) });

/** Codex comparison windows of published fixture events and readings. */
export function codexWindowsFixture(config: CodexAccountingConfig, events: readonly CalibrationEvent[], probes: readonly CodexProbe[],
  minutes: 300 | 10080 | 43200 = 10080, referenceDay?: string, detailCycleId?: string): CodexComparisonWindow[] {
  return meterWindowsFixture(events, probes, codexWindowTraffic(config, minutes, referenceDay), detailCycleId);
}
