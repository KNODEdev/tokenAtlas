import type { RateCard } from "./pricing";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { prepareCodexPricing, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import type { WindowEventReader, ClaudeWindowDetail, WindowSums, WindowInterval, WindowTraffic } from "./window-usage-contracts";
import { windowCuts, computeWindowSums, summarizeSpan, placeEvents } from "./window-usage-compute";
import { codexWindowTraffic, subscriptionWindowTraffic } from "./window-usage-traffic";
import { withReferenceVariant } from "./window-usage-reference";
import { emptyWindowUsage, compareManualMeterInterval } from "./subscription-window-comparison";
import { emptyWindowEvidence } from "./subscription-evidence";
import type { LedgerEvent } from "../db/usage-ledger-events";
import { intervalEndMs } from "./window-usage-contracts";
import type { Database } from "bun:sqlite";
import type { AccountResolver } from "./account-resolver";
import { usageLedgerProviderOf } from "../db/usage-ledger-read";
import { usageLedgerEventsFor } from "../db/usage-ledger-events";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import type { ClaudeGaugeConfig } from "./claude-gauge";
import { claudeScopeModels } from "./window-usage-values";

/** The sums of one stored window from the ledgers; also the bounded detail read of a single window. */
export function windowSumsFromLedgers(reader: WindowEventReader, rateCards: RateCard, provider: string, window: ProbeLimitWindow,
  earlier: readonly ProbeLimitWindow[], options: { timeline?: boolean; referenceDay?: string; claude?: ClaudeWindowDetail } = {}) {
  const variant = options.referenceDay === undefined ? reader.reference?.(provider) ?? null : null;
  const referenceDay = options.referenceDay ?? variant?.day;
  let result: { comparison: CodexComparisonWindow; sums: WindowSums };
  if (provider === "codex") {
    const config = prepareCodexPricing(resolveCodexAccountingConfig(rateCards));
    // The time axis of a cycle shows calls one by one; sums are read in cohorts where the reader can cut them.
    const events = (!options.timeline ? reader.codexCohorts?.(window.account, window.start, window.end, windowCuts(window, earlier)) : null)
      ?? reader.codex(window.account, window.start, window.end);
    result = computeWindowSums(window, earlier, events, codexWindowTraffic(config, window.window_minutes, referenceDay), options.timeline);
  } else result = computeWindowSums(window, earlier, reader.ledger(provider, window.account, window.start, window.end),
    subscriptionWindowTraffic(provider, window.counter, rateCards, referenceDay, { claude: options.claude }), options.timeline);
  return variant ? { ...result, sums: withReferenceVariant(result.sums, variant) } : result;
}

/** A `[start, end)` span that pairs everything it holds: a gauge observation or a reconstructed window. */
function spanShell(interval: WindowInterval, minutes: number): CodexComparisonWindow {
  return { id: interval.id, account: interval.account, plan: null, window_minutes: minutes,
    start: interval.start, end: interval.end, reset: interval.end, cycle_start: interval.start, cycle_end: interval.end,
    cycle_end_basis: "uncertain", start_percent: 0, end_percent: 0, observed_pp: 0, probes: 0, max_gap_hours: 0,
    start_basis: "reset", first_probe: { ts: interval.start, percent: 0 }, usage: emptyWindowUsage(), cycle_usage: emptyWindowUsage(),
    sources: [], models: [], meter_sources: [], unpaired_events: 0, evidence: emptyWindowEvidence() };
}

const CLAUDE_WEEK_COUNTER = JSON.stringify(["weekly_all", "", 10080]);

/**
 * The sums of one interval from the ledgers; also the bounded detail read of one manual measurement
 * (`detailCycle`) and the valuation at a reference day. A manual measurement is `(start, end]` under its
 * own counter; a gauge observation and a reconstructed window are `[start, end)` of all the account's
 * traffic, a scoped reconstructed window only of its scope models; a Grok fallback is all the account's
 * traffic of its span (a rolling one up to and including its newest call).
 */
export function intervalSumsFromLedgers(reader: WindowEventReader, rateCards: RateCard, interval: WindowInterval,
  options: { referenceDay?: string; detailCycle?: string; claude?: ClaudeWindowDetail;
    unowned?: (start: string, end: string) => { events: number; tokens: number } } = {}): { comparison: CodexComparisonWindow; sums: WindowSums } {
  const start = Date.parse(interval.start), end = intervalEndMs(interval);
  const variant = options.referenceDay === undefined ? reader.reference?.(interval.provider) ?? null : null;
  if (variant) options = { ...options, referenceDay: variant.day };
  let events = reader.ledger(interval.provider, interval.account, interval.start, new Date(end).toISOString());
  let traffic: WindowTraffic<LedgerEvent>, shell: CodexComparisonWindow;
  if (interval.kind === "manual") {
    traffic = subscriptionWindowTraffic(interval.provider, interval.counter, rateCards, options.referenceDay,
      { approximateTime: interval.measurement.approximate_time, claude: options.claude });
    shell = compareManualMeterInterval(interval.measurement, [], traffic.adapter, options.detailCycle);
  } else {
    traffic = subscriptionWindowTraffic(interval.provider, CLAUDE_WEEK_COUNTER, rateCards, options.referenceDay,
      { claude: options.claude, allModels: interval.provider !== "claude" });
    // A rolling fallback holds its newest call: its shell ends just after it.
    shell = spanShell({ ...interval, end: new Date(end).toISOString() }, Math.round((end - start) / 60_000));
    if (interval.kind === "declared" && interval.declared.scope) {
      const models = new Set(interval.declared.scope_models);
      events = events.filter(event => event.model !== null && models.has(event.model));
    }
  }
  const sums = summarizeSpan(shell, placeEvents(shell, [shell], events, traffic), traffic, start, end, []);
  if (interval.kind === "declared" && sums.cycle.cycle_usage.events === 0 && options.unowned)
    sums.rail.unowned = options.unowned(interval.start, interval.end);
  return { comparison: shell, sums: variant ? withReferenceVariant(sums, variant) : sums };
}

/** The provider's traffic of a span that no account owns: eligible canonical events without an owner. */
export function unownedTraffic(db: Database, rateCards: RateCard, resolver: AccountResolver, provider: string, start: string, end: string) {
  if (!usageLedgerProviderOf(provider)) return { events: 0, tokens: 0 };
  let events = 0, tokens = 0;
  for (const event of usageLedgerEventsFor(db, provider, rateCards, null).load(start, end)) {
    if (resolver.resolve(provider, event.source, event.account_key, event.ts).account !== null) continue;
    events++; tokens += TOKEN_BUCKETS.reduce((sum, bucket) => sum + event.quantities[bucket], 0);
  }
  return { events, tokens };
}

/**
 * The Claude detail of a span: the scoped models of the rail, the identity coverage of the account and, for
 * a limit window, the traffic no account owns (computed once per span: a weekly window and its scoped
 * sublimit share it). The producer counts the unowned traffic through its cached days (`unownedOf`).
 */
export function claudeDetailReader(db: Database, rateCards: RateCard, resolver: AccountResolver, gauge: ClaudeGaugeConfig,
  unownedOf: (start: string, end: string) => { events: number; tokens: number } = (start, end) => unownedTraffic(db, rateCards, resolver, "claude", start, end)) {
  const scope = new Set(claudeScopeModels(gauge));
  const unowned = new Map<string, { events: number; tokens: number }>();
  return (provider: string, account: string, start: string, end: string, limitWindow = false): ClaudeWindowDetail | undefined =>
    provider !== "claude" ? undefined : {
      scoped: model => model !== null && scope.has(model.toLowerCase()),
      copies: usageLedgerEventsFor(db, "claude", rateCards, resolver.plan("claude", account.toLowerCase())).identityCopies(start, end),
      ...(limitWindow ? { unowned: () => {
        const key = `${start}|${end}`;
        if (!unowned.has(key)) unowned.set(key, unownedOf(start, end));
        return unowned.get(key)!;
      } } : {}),
    };
}
