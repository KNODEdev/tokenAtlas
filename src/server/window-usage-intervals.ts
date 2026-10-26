import type { ClaudeGaugeConfig } from "./claude-gauge";
import { usageProviderIds } from "./subscription-accounting-adapters";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import { readManualCapacity } from "./manual-capacity";
import { claudeAccountId, claudeGaugeObservationSpan, claudeGaugeWindowHours, claudeGaugeObservationId } from "./claude-gauge";
import type { WindowUsageProducerOptions, WindowInterval } from "./window-usage-contracts";
import type { Database } from "bun:sqlite";
import type { CyclesConfig } from "./cycles";
import type { AccountResolver } from "./account-resolver";
import { claudeDeclaredWindows } from "./claude-declared-windows";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import { intervalKey, intervalSumsKey } from "./window-usage-contracts";
import { tableExists, digest, metaValue } from "./window-usage-meta";
import type { RateCard } from "./pricing";
import type { GrokGaugeConfig } from "./grok-gauge-spans";
import { grokGaugeAccount, grokGaugeObservations, grokObservationSpan, grokObservationId, grokDeclaredWindowHours, grokRollingMinutes, grokRollingId, grokAnchoredWindow, grokAnchoredId, loadGrokGauge } from "./grok-gauge-spans";
import { accountUsageSpan } from "./account-usage-span";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { latestGeminiState } from "../providers/adapters/gemini";
import { loadCycles } from "./cycles";
import { ACCOUNT_PERIODS_REVISION, PLAN_PERIODS_REVISION, PLAN_PERIODS, loadPeriods } from "../db/period-store";
import { planPeriodIndex } from "./account-periods";
import { markWindowAnswersDirty } from "../db/window-answers";
import { readWindowIntervals } from "./window-usage-read";
import { bumpWindowUsageClocks } from "./window-usage-clock";

/** Whether a part of the interval list was derived from settled inputs (a preparing index keeps published spans). */
interface PartState { settled: boolean }

/** The configuration intervals: every non-Codex manual measurement and the configured Claude account's gauge observations. */
function configuredIntervals(options: WindowUsageProducerOptions, gauge: ClaudeGaugeConfig): WindowInterval[] {
  const out: WindowInterval[] = [];
  for (const provider of usageProviderIds()) {
    // Codex keeps a manual measurement only as a reading inside its meter windows.
    if (provider === "codex") continue;
    let measurements: readonly ManualCapacityMeasurement[] = [];
    try { measurements = options.manualCapacity ? options.manualCapacity(provider) : readManualCapacity(provider).measurements; }
    catch { measurements = []; }
    for (const measurement of measurements) out.push({ kind: "manual", provider, account: measurement.account.toLowerCase(),
      counter: measurement.counter, id: `manual:${measurement.id}`, start: measurement.start, end: measurement.end, measurement });
  }
  const configured = claudeAccountId(gauge.subscription)?.toLowerCase() ?? null;
  if (configured) for (const observation of gauge.observations ?? []) {
    if (!observation?.reset_ts) continue;
    const span = claudeGaugeObservationSpan(observation, claudeGaugeWindowHours(gauge));
    if (span) out.push({ kind: "gauge", provider: "claude", account: configured, counter: "gauge",
      id: claudeGaugeObservationId(observation), start: span.start, end: span.cutoff });
  }
  return out;
}

/**
 * The windows of every Claude account reconstructed from its cadence. An account whose probe index is still
 * preparing keeps its published windows. `nextChangeMs` is when the clock adds the next window: the end of
 * the newest window of each set (a set without a current window is checked again within the hour).
 */
function declaredIntervals(db: Database, gauge: ClaudeGaugeConfig, cycles: CyclesConfig, resolver: AccountResolver, now: number,
  published: readonly WindowInterval[], state: PartState): { intervals: WindowInterval[]; nextChangeMs: number } {
  const out: WindowInterval[] = [];
  const configured = claudeAccountId(gauge.subscription)?.toLowerCase() ?? null;
  let nextChangeMs = Infinity;
  const plans = planPeriodIndex(tableExists(db, "plan_periods") ? loadPeriods(db, PLAN_PERIODS) : []);
  for (const account of resolver.accounts("claude").filter(account => claudeAccountId(account) !== null)) {
    const starts = resolver.plan("claude", account).ranges.map(range => range.from).filter(Number.isFinite);
    let sets: ReturnType<typeof claudeDeclaredWindows>;
    try { sets = claudeDeclaredWindows(db, account, cycles, now, starts.length ? Math.min(...starts) : null, plans); }
    catch (error) {
      if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
      out.push(...published.filter(interval => interval.kind === "declared" && interval.account === account));
      state.settled = false;
      continue;
    }
    // A future plan can become eligible without another reading or configuration change.
    if (!sets.length) nextChangeMs = Math.min(nextChangeMs, now + 3_600_000);
    const models = account === configured ? (gauge.limits?.fable?.models ?? []) : [];
    for (const set of sets) {
      // Reconstructed windows come newest first; the newest reset is when the clock adds the next week.
      const newest = Math.max(...set.windows.map(window => Date.parse(window.resetIso)));
      nextChangeMs = Math.min(nextChangeMs, newest > now ? newest : now + 3_600_000);
      for (const window of set.windows) out.push({ kind: "declared", provider: "claude", account,
        counter: `declared:${set.kind}`, id: `declared:${set.kind}:${window.startIso}:${window.resetIso}`,
        start: window.startIso, end: window.resetIso,
        declared: { kind: set.kind, scope: set.scope, scope_models: set.scope ? [...models] : [], window } });
    }
  }
  return { intervals: out, nextChangeMs };
}

/** One entry per key; a repeated manual id or gauge observation is the same interval. */
const uniqueIntervals = (intervals: readonly WindowInterval[]) =>
  [...new Map(intervals.map(interval => [intervalKey(interval.provider, interval.account, interval.counter, interval.id), interval])).values()];

/** Reading stored rows changes property order, not interval identity or calculation inputs. */
function intervalShape(interval: WindowInterval | undefined): string | null {
  if (!interval) return null;
  const { provider, account, counter, id, kind, start, end, ...spec } = interval;
  return JSON.stringify([provider, account, counter, id, kind, start, end, spec]);
}

/**
 * What the database-derived interval parts are computed from, each one indexed read: account periods (owners and
 * their first periods), the probe readings and their source evidence (Claude cadences, Gemini quota resets), the
 * Grok and Gemini usage ledgers (an account's newest call). A part whose stamp is unchanged is not computed again.
 */
function probeStamp(db: Database): unknown {
  const value = (key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
  return [tableExists(db, "probe_windows") ? (db.query("SELECT MAX(id) id FROM probe_windows").get() as { id: number | null }).id : null,
    tableExists(db, "probe_source_tuples") ? (db.query("SELECT COUNT(*) n FROM probe_source_tuples").get() as { n: number }).n : null,
    tableExists(db, "probe_source_dirty") ? !!db.query("SELECT 1 FROM probe_source_dirty LIMIT 1").get() : null,
    ["probe_sources_published", "current_v2_definitions", "current_v2_declarations", "current_v2_probe_source_corrections"].map(value)];
}

/** The usage ledger's revision of a provider; it moves with every re-aggregated day. */
function ledgerRevision(db: Database, provider: string): unknown {
  if (!tableExists(db, "usage_ledger_state")) return null;
  return db.query("SELECT version,status,rules_digest,revision FROM usage_ledger_state WHERE provider=?").get(provider) ?? null;
}

const rateCardDigests = new WeakMap<RateCard, string>();

/** The interval list of the last synchronization, kept with the stamps of its parts (see `syncIntervals`). */
interface IntervalMemo {
  stamp: string; nextChangeMs: number; map: Map<string, WindowInterval>;
  fallbacks: { stamp: string; intervals: WindowInterval[] } | null;
  declared: { stamp: string; intervals: WindowInterval[]; nextChangeMs: number } | null;
}

const intervalMemos = new WeakMap<Database, IntervalMemo>();

const INTERVALS_STAMP = "window_usage_intervals_stamp";
const DECLARED_INTERVALS_VERSION = 2;

/**
 * Fallback spans of the providers whose gauges need them (see the module comment): Grok's gauge
 * observations from the configuration, and for every Grok and Gemini account rolling spans up to and
 * including its newest call, Grok's anchored period of that call and Gemini's last weekly window from its
 * newest quota reading. The newest call is read from the ledger's stored days only when the inputs changed
 * since the published spans (the ledger revision, the accounts and their periods, the anchor or reading);
 * a ledger or reading index still preparing keeps the published ones.
 */
function fallbackIntervals(db: Database, options: WindowUsageProducerOptions, cfg: GrokGaugeConfig, resolver: AccountResolver,
  published: readonly WindowInterval[], meta: Map<string, string>, state: PartState): WindowInterval[] {
  const out: WindowInterval[] = [];
  const configured = grokGaugeAccount(cfg);
  for (const observation of grokGaugeObservations(cfg)) {
    const span = grokObservationSpan(cfg, observation);
    if (span) out.push({ kind: "gauge", provider: "grok", account: configured, counter: "gauge", id: grokObservationId(observation.ts), ...span });
  }
  const hours = grokDeclaredWindowHours(cfg);
  for (const provider of ["grok", "gemini"] as const) {
    const keep = () => published.filter(interval => interval.provider === provider && (interval.kind === "rolling" || interval.kind === "anchored"));
    const accounts = [...new Set(resolver.accounts(provider).map(account => account.toLowerCase()))].sort();
    const minutes = provider === "grok" ? grokRollingMinutes(cfg) : FALLBACK_MINUTES;
    // Gemini's quota reading gives the reset of its weekly window, not its traffic.
    let weekly: Map<string, string> | null = null;
    if (provider === "gemini") {
      try { weekly = geminiWeeklyResets(db, accounts); }
      catch (error) {
        if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
        out.push(...keep());
        state.settled = false;
        continue;
      }
    }
    const key = `window_usage_${provider}_fallbacks`;
    const inputs = digest([ledgerRevision(db, provider), accounts.map(account => [account, resolver.plan(provider, account).ranges]), minutes,
      provider === "grok" ? [configured, cfg.reset_anchor?.ts ?? null, hours] : [...weekly!]]);
    if (metaValue(db, key) === inputs) { out.push(...keep()); continue; }
    const computed: WindowInterval[] = [];
    try {
      for (const account of accounts) {
        const reset = weekly?.get(account);
        if (reset) {
          const start = new Date(Date.parse(reset) - 10080 * 60_000).toISOString();
          computed.push({ kind: "anchored", provider, account, counter: "anchored", id: `anchored:${start}`, start, end: reset, anchor: reset, minutes: 10080 });
        }
        const span = accountUsageSpan(db, provider, account, resolver, options.rateCards);
        if (!span) continue;
        const newest = Date.parse(span.last_ts), end = new Date(newest).toISOString();
        for (const length of minutes) computed.push({ kind: "rolling", provider, account, counter: `rolling:${length}`,
          id: grokRollingId(length), start: new Date(newest - length * 60_000).toISOString(), end, minutes: length });
        const anchored = provider === "grok" && account === configured ? grokAnchoredWindow(cfg.reset_anchor, hours, newest) : null;
        if (anchored) computed.push({ kind: "anchored", provider, account, counter: "anchored", id: grokAnchoredId(anchored.startIso),
          start: anchored.startIso, end: anchored.endIso, anchor: cfg.reset_anchor!.ts, minutes: Math.round(hours * 60) });
      }
    } catch (error) {
      if (!(error instanceof SubscriptionFactsPending)) throw error;
      out.push(...keep());
      state.settled = false;
      continue;
    }
    meta.set(key, inputs);
    out.push(...computed);
  }
  return out;
}

/** Rolling lengths of the account cards: the week and five hours. */
const FALLBACK_MINUTES = [300, 10080];

/** The reset of each Gemini account's weekly Gemini-family window in its newest quota reading. */
function geminiWeeklyResets(db: Database, accounts: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!accounts.length) return out;
  for (const state of latestGeminiState(db)) {
    const reset = state.windows.find(window => /^gemini/i.test(window.limit_group) && window.kind === "weekly")?.resets_at;
    if (reset && Number.isFinite(Date.parse(reset)) && accounts.includes(state.account.toLowerCase())) out.set(state.account.toLowerCase(), reset);
  }
  return out;
}

/**
 * Publishes the interval list; new and changed intervals become pending, removed ones lose their rows. The list is
 * computed again only when an input changed: the configuration files, the database inputs of each part (`probeStamp`,
 * periods, ledgers) or the clock passing the end of a reconstructed window. An idle turn compares a few stamps.
 */
export function syncIntervals(db: Database, options: WindowUsageProducerOptions, gauge: ClaudeGaugeConfig,
  resolver: AccountResolver): Map<string, WindowInterval> {
  const now = options.nowMs ?? Date.now(), grok = options.grokGauge ?? loadGrokGauge(), cycles = options.cycles ?? loadCycles();
  const configured = configuredIntervals(options, gauge);
  let rates = rateCardDigests.get(options.rateCards);
  if (!rates) rateCardDigests.set(options.rateCards, rates = digest(options.rateCards));
  const periods = metaValue(db, ACCOUNT_PERIODS_REVISION), subscriptions = digest(options.subscriptions ?? []), probes = probeStamp(db);
  const fallbackStamp = digest([grok, ledgerRevision(db, "grok"), ledgerRevision(db, "gemini"), periods, subscriptions, probes, rates]);
  const declaredStamp = digest([DECLARED_INTERVALS_VERSION, cycles, periods, metaValue(db, `${PLAN_PERIODS_REVISION}:claude`), subscriptions, probes,
    claudeAccountId(gauge.subscription), gauge.limits?.fable?.models ?? []]);
  const stamp = digest([fallbackStamp, declaredStamp, configured]);
  const memo = intervalMemos.get(db);
  if (memo?.stamp === stamp && now < memo.nextChangeMs && metaValue(db, INTERVALS_STAMP) === stamp) return memo.map;
  const published = readWindowIntervals(db);
  const meta = new Map<string, string>(), fallbackState: PartState = { settled: true }, declaredState: PartState = { settled: true };
  const fallbacks = memo?.fallbacks?.stamp === fallbackStamp ? memo.fallbacks.intervals
    : fallbackIntervals(db, options, grok, resolver, published, meta, fallbackState);
  const declared = memo?.declared?.stamp === declaredStamp && now < memo.declared.nextChangeMs ? memo.declared
    : { ...declaredIntervals(db, gauge, cycles, resolver, now, published, declaredState), stamp: declaredStamp };
  const desired = uniqueIntervals([...fallbacks, ...configured, ...declared.intervals]);
  const settled = fallbackState.settled && declaredState.settled;
  const keyOf = (interval: WindowInterval) => intervalKey(interval.provider, interval.account, interval.counter, interval.id);
  const map = new Map(desired.map(interval => [keyOf(interval), interval]));
  const before = new Map(published.map(interval => [keyOf(interval), interval]));
  const removed = [...before].filter(([key]) => !map.has(key)).map(([, interval]) => interval);
  const changed = [...map].filter(([key, interval]) => intervalShape(before.get(key)) !== intervalShape(interval));
  // A part that kept published spans (an index still preparing) is computed again next turn.
  intervalMemos.set(db, { stamp: settled ? stamp : "", nextChangeMs: declared.nextChangeMs, map,
    fallbacks: fallbackState.settled ? { stamp: fallbackStamp, intervals: fallbacks } : null,
    declared: declaredState.settled ? declared : null });
  if (!removed.length && !changed.length && !meta.size && (!settled || metaValue(db, INTERVALS_STAMP) === stamp)) return map;
  db.transaction(() => {
    if (settled) db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(INTERVALS_STAMP, stamp);
    // The inputs the published fallbacks were computed from, committed with them.
    for (const [key, value] of meta) db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
    const where = "provider=? AND account=? AND counter=? AND window_id=?";
    for (const interval of removed) {
      const key = [interval.provider, interval.account, interval.counter, interval.id];
      db.query(`DELETE FROM window_usage_intervals WHERE ${where}`).run(...key);
      db.query(`DELETE FROM window_usage WHERE ${where}`).run(...key);
      db.query(`DELETE FROM window_usage_pending WHERE ${where}`).run(...key);
      bumpWindowUsageClocks(db, interval.provider, interval.account);
      markWindowAnswersDirty(db, { provider: interval.provider, account: interval.account,
        fromMs: Date.parse(interval.start), untilMs: Date.parse(interval.end) });
    }
    const store = db.query(`INSERT OR REPLACE INTO window_usage_intervals(provider,account,counter,window_id,kind,start_ts,end_ts,spec)
      VALUES(?,?,?,?,?,?,?,?)`);
    const pending = db.query("INSERT OR IGNORE INTO window_usage_pending(provider,account,counter,window_id) VALUES(?,?,?,?)");
    for (const [key, interval] of changed) {
      const { provider, account, counter, id, kind, start, end, ...spec } = interval;
      store.run(provider, account, counter, id, kind, start, end, JSON.stringify(spec));
      const previous = before.get(key);
      if (!previous || intervalSumsKey(previous) !== intervalSumsKey(interval)) pending.run(provider, account, counter, id);
    }
  }).immediate();
  return map;
}
