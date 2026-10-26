import type { WindowUsageProducerStats, WindowSums, WindowUsageProducerOptions } from "./window-usage-contracts";
import type { LimitWindowRow } from "../db/limit-windows";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { limitWindowFromRow } from "../db/limit-windows";
import type { Database } from "bun:sqlite";
import { dropWindowEndEstimate } from "../db/window-end-estimates";
import { markWindowAnswersDirty } from "../db/window-answers";
import { WINDOW_USAGE_BEGINNING, ensureWindowUsageSchema, WINDOW_USAGE_ALL } from "../db/window-usage";
import { bumpWindowUsageClocks } from "./window-usage-clock";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import type { RateCard } from "./pricing";
import { codexLedgerPendingReason, codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { usageLedgerProviderOf } from "../db/usage-ledger-read";
import { registerFreshness } from "../db/read-freshness";
import type { ReadRegister } from "../db/read-freshness";
import { WindowEventDays, cachedWindowEventReader, windowEventReader } from "./window-usage-events";
import { loadClaudeGauge } from "./claude-gauge";
import { loadAccountResolver } from "./account-resolver";
import { advanceWindowEndEstimates } from "./window-end-estimate";
import { tableExists, digest } from "./window-usage-meta";
import { enqueueConfigChanges, referenceVariantsChanged, enqueueReferenceVariants, applyDirty } from "./window-usage-invalidation";
import { producerReferencePlan } from "./window-usage-reference";
import { syncIntervals } from "./window-usage-intervals";
import { claudeDetailReader, intervalSumsFromLedgers, windowSumsFromLedgers, unownedTraffic } from "./window-usage-ledger-sums";
import { intervalKey } from "./window-usage-contracts";
import { readWindowIntervals } from "./window-usage-read";

export const emptyWindowUsageStats = (): WindowUsageProducerStats => ({ windows: 0, events: 0, removed: 0, read: 0, slowestWindowMs: 0, slowestWriteMs: 0 });

/** The windows before `seq` of the same account and counter whose cycles overlap the window's, from the register's rows. */
function earlierOverlapping(rows: readonly LimitWindowRow[], window: ProbeLimitWindow, seq: number): ProbeLimitWindow[] {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  return rows.filter(row => row.seq < seq && Date.parse(row.end_ts) > start && Date.parse(row.start_ts) < end)
    .sort((a, b) => a.seq - b.seq).map(limitWindowFromRow);
}

/** Writes a row inside the caller's transaction; an unchanged row is left alone, so readers' caches stay valid. */
function storeRow(db: Database, key: readonly [string, string, string, string], start: string, end: string, sums: WindowSums): void {
  const values = [start, end, JSON.stringify(sums.cycle), JSON.stringify(sums.rail), JSON.stringify(sums.readings), JSON.stringify(sums.slices),
    sums.reference ? JSON.stringify(sums.reference) : null];
  const stored = db.query("SELECT start_ts,end_ts,cycle,rail,readings,slices,reference FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?")
    .get(...key) as Record<string, string | null> | null;
  if (stored && ["start_ts", "end_ts", "cycle", "rail", "readings", "slices", "reference"].every((column, index) => stored[column] === values[index])) return;
  db.query(`INSERT OR REPLACE INTO window_usage(provider,account,counter,window_id,start_ts,end_ts,cycle,rail,readings,slices,reference)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(...key, ...values);
  // The window's end estimate reads its bounds, cycle and running sums (window-end-estimate.ts).
  if (!stored || ([[0, "start_ts"], [1, "end_ts"], [2, "cycle"], [4, "readings"]] as const).some(([index, column]) => stored[column] !== values[index]))
    dropWindowEndEstimate(db, ...key);
  bumpWindowUsageClocks(db, key[0], key[1]);
  // Window screens that show these sums follow their publication, over the window's own instants.
  const range = [stored?.start_ts, stored?.end_ts, start, end].flatMap(ts => ts ? [Date.parse(ts)] : []).filter(Number.isFinite);
  markWindowAnswersDirty(db, { provider: key[0], account: key[1], fromMs: range.length ? Math.min(...range) : WINDOW_USAGE_BEGINNING,
    untilMs: range.length ? Math.max(...range) : null });
}

const LEDGER_PENDING = (error: unknown) => error instanceof SubscriptionFactsPending || error instanceof CodexLedgerNotReady;

/**
 * The provider's ledger is published and has taken in its newest facts, with no price change pending:
 * window sums read now stay valid. A provider without a ledger of window sums waits on nothing.
 */
function ledgerSettled(db: Database, provider: string, rateCards: RateCard): boolean {
  if (provider === "codex") {
    if (codexLedgerPendingReason(db, { rulesRevision: codexLedgerReadContext(rateCards).rulesRevision })) return false;
  } else if (!usageLedgerProviderOf(provider)) return true;
  const state = registerFreshness(db, (provider === "codex" ? "codex" : usageLedgerProviderOf(provider)) as ReadRegister);
  return state.published && !state.pending;
}

/** Loaded ledger days of a connection, kept across turns (see `WindowEventDays`). */
const eventDays = new WeakMap<Database, WindowEventDays>();

/** A write transaction holds at most this much computed work, or this many windows. */
const WRITE_EVERY_MS = 250, WRITE_BATCH = 200;

type PendingWrite = { key: readonly [string, string, string, string] }
  & ({ start: string; end: string; sums: WindowSums } | { remove: true });

/**
 * One maintenance turn of the window-usage producer. Returns whether queued work remains. Windows are
 * computed outside a transaction, reading the ledgers through whole cached days, and written several
 * at a time in short transactions; the worker is the only writer of these tables.
 */
export function advanceWindowUsage(db: Database, options: WindowUsageProducerOptions): { progressed: boolean; pending: boolean } {
  if (!tableExists(db, "limit_windows")) return { progressed: false, pending: false };
  if (options.canWrite && !options.canWrite()) return { progressed: false, pending: true };
  if (!tableExists(db, "window_usage") || !tableExists(db, "window_usage_intervals")) ensureWindowUsageSchema(db);
  const stats = options.stats ?? emptyWindowUsageStats();
  const started = performance.now(), budget = options.budgetMs ?? 1000;
  const gauge = options.claudeGauge ?? loadClaudeGauge();
  enqueueConfigChanges(db, options, gauge);
  const reference = producerReferencePlan(options.rateCards, options.referenceDay ?? new Date(options.nowMs ?? Date.now()).toISOString().slice(0, 10));
  if ((!options.canWrite || options.canWrite()) && referenceVariantsChanged(db, reference))
    db.transaction(() => enqueueReferenceVariants(db, reference)).immediate();
  const resolver = loadAccountResolver(db, options.subscriptions ?? []);
  const intervals = syncIntervals(db, options, gauge, resolver);
  // Loaded days stay valid until a writer reports a change of the provider's events, owners or periods:
  // every such entry names no counter (window changes name theirs), and is seen here before it is applied.
  // Codex calls carry their valuation at the reference day, so that day is part of what they depend on.
  const fingerprint = digest([options.rateCards, options.subscriptions ?? [], reference("codex")?.day ?? null]);
  let days = eventDays.get(db);
  if (!days || days.fingerprint !== fingerprint) eventDays.set(db, days = new WindowEventDays(fingerprint));
  for (const { provider } of db.query("SELECT DISTINCT provider FROM window_usage_dirty WHERE counter=?").all(WINDOW_USAGE_ALL) as
    Array<{ provider: string }>) days.drop(provider);
  applyDirty(db, intervals);
  const reader = cachedWindowEventReader(db, options.rateCards, resolver, days, reference), loadedBefore = days.loaded;
  const detail = claudeDetailReader(db, options.rateCards, resolver, gauge, (start, end) => reader.unowned("claude", start, end));
  // A provider whose ledger has not taken in its newest facts waits: sums computed now would be computed
  // again (or stored empty) once it has, and the ledger queues every changed span when it publishes.
  const blocked = new Set<string>();
  for (const { provider } of db.query("SELECT DISTINCT provider FROM window_usage_pending").all() as Array<{ provider: string }>)
    if (!ledgerSettled(db, provider, options.rateCards)) blocked.add(provider);
  // What screens wait for first: windows still open, then windows without a stored row, then the newest.
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const queue = db.query(`SELECT p.provider,p.account,p.counter,p.window_id,w.seq FROM window_usage_pending p
    LEFT JOIN limit_windows w ON w.provider=p.provider AND w.account=p.account AND w.counter=p.counter AND w.window_id=p.window_id
    LEFT JOIN window_usage_intervals i ON i.provider=p.provider AND i.account=p.account AND i.counter=p.counter AND i.window_id=p.window_id
    LEFT JOIN window_usage u ON u.provider=p.provider AND u.account=p.account AND u.counter=p.counter AND u.window_id=p.window_id
    ORDER BY COALESCE(w.end_ts,i.end_ts,'') > ? DESC, u.window_id IS NULL DESC, COALESCE(w.start_ts,i.start_ts,'') DESC`).all(nowIso) as
    Array<{ provider: string; account: string; counter: string; window_id: string; seq: number | null }>;
  const registers = new Map<string, { rows: LimitWindowRow[]; bySeq: Map<number, LimitWindowRow> }>();
  const registerOf = (provider: string, account: string, counter: string) => {
    const name = JSON.stringify([provider, account, counter]);
    let register = registers.get(name);
    if (!register) {
      const rows = db.query("SELECT * FROM limit_windows WHERE provider=? AND account=? AND counter=? ORDER BY seq")
        .all(provider, account, counter) as LimitWindowRow[];
      registers.set(name, register = { rows, bySeq: new Map(rows.map(row => [row.seq, row])) });
    }
    return register;
  };
  let progressed = false, stopped = false, computed = 0;
  let batch: PendingWrite[] = [], batchStarted = performance.now();
  const flush = () => {
    if (!batch.length) return;
    if (options.holdsWriter ? !options.holdsWriter() : options.canWrite && !options.canWrite()) { batch = []; stopped = true; return; }
    const written = performance.now();
    const done = db.query("DELETE FROM window_usage_pending WHERE provider=? AND account=? AND counter=? AND window_id=?");
    db.transaction(() => {
      for (const write of batch) {
        if ("remove" in write) {
          db.query("DELETE FROM window_usage WHERE provider=? AND account=? AND counter=? AND window_id=?").run(...write.key);
          dropWindowEndEstimate(db, ...write.key);
          bumpWindowUsageClocks(db, write.key[0], write.key[1]);
          markWindowAnswersDirty(db, { provider: write.key[0], account: write.key[1], fromMs: WINDOW_USAGE_BEGINNING, untilMs: null });
          stats.removed++;
        } else { storeRow(db, write.key, write.start, write.end, write.sums); stats.windows++; }
        done.run(...write.key);
      }
    }).immediate();
    stats.slowestWriteMs = Math.max(stats.slowestWriteMs, performance.now() - written);
    progressed = true; batch = []; batchStarted = performance.now();
  };
  for (const next of queue) {
    if (computed && performance.now() - started >= budget) break;
    if (batch.length >= WRITE_BATCH || performance.now() - batchStarted >= WRITE_EVERY_MS) flush();
    if (stopped || options.canWrite && !options.canWrite()) break;
    if (blocked.has(next.provider)) continue;
    const key = [next.provider, next.account, next.counter, next.window_id] as const;
    const interval = next.seq === null ? intervals.get(intervalKey(...key)) : undefined;
    if (next.seq === null && !interval) { batch.push({ key, remove: true }); computed++; continue; }
    const computeStarted = performance.now();
    try {
      if (interval) {
        const sums = intervalSumsFromLedgers(reader, options.rateCards, interval, { claude: detail(interval.provider, interval.account, interval.start, interval.end),
          unowned: (start, end) => reader.unowned(interval.provider, start, end) }).sums;
        stats.events += sums.cycle.cycle_usage.events;
        batch.push({ key, start: interval.start, end: interval.end, sums });
      } else {
        const register = registerOf(next.provider, next.account, next.counter);
        const window = limitWindowFromRow(register.bySeq.get(next.seq!)!);
        const sums = windowSumsFromLedgers(reader, options.rateCards, next.provider, window, earlierOverlapping(register.rows, window, next.seq!),
          { claude: detail(next.provider, window.account, window.start, window.end, true) }).sums;
        stats.events += sums.cycle.cycle_usage.events + sums.cycle.excluded.reduce((sum, bucket) => sum + bucket.usage.events, 0);
        batch.push({ key, start: window.start, end: window.end, sums });
      }
    } catch (error) {
      if (!LEDGER_PENDING(error)) throw error;
      blocked.add(next.provider);
      continue;
    }
    stats.slowestWindowMs = Math.max(stats.slowestWindowMs, performance.now() - computeStarted);
    computed++;
  }
  flush();
  stats.read += days.loaded - loadedBefore;
  // End estimates of closed windows, from the rows stored so far (stored rows only, no ledger read).
  const estimates = stopped ? { progressed: false, pending: true } : advanceWindowEndEstimates(db, {
    budgetMs: Math.max(50, budget - (performance.now() - started)), canWrite: options.canWrite,
    changed: (provider, account, fromMs, untilMs) => {
      bumpWindowUsageClocks(db, provider, account);
      markWindowAnswersDirty(db, { provider, account, fromMs, untilMs });
    } });
  const pending = !!db.query("SELECT 1 FROM window_usage_pending LIMIT 1").get() || !!db.query("SELECT 1 FROM window_usage_dirty LIMIT 1").get()
    || estimates.pending;
  return { progressed: progressed || estimates.progressed, pending };
}

/** Progress for the import/sync progress module: windows and intervals whose sums are current, of all of them. */
export function windowUsageProgress(db: Database): { done: number; total: number } {
  if (!tableExists(db, "limit_windows") || !tableExists(db, "window_usage")) return { done: 0, total: 0 };
  const intervals = tableExists(db, "window_usage_intervals")
    ? "UNION ALL SELECT provider,account,counter,window_id FROM window_usage_intervals" : "";
  const row = db.query(`WITH spans AS (SELECT provider,account,counter,window_id FROM limit_windows ${intervals})
    SELECT COUNT(*) total, SUM(CASE WHEN u.window_id IS NOT NULL AND p.window_id IS NULL THEN 1 ELSE 0 END) done
    FROM spans w
    LEFT JOIN window_usage u ON u.provider=w.provider AND u.account=w.account AND u.counter=w.counter AND u.window_id=w.window_id
    LEFT JOIN window_usage_pending p ON p.provider=w.provider AND p.account=w.account AND p.counter=w.counter AND p.window_id=w.window_id`)
    .get() as { total: number; done: number | null };
  return { done: row.done ?? 0, total: row.total };
}

/**
 * The reference: every stored window and every published interval computed from the ledgers at once.
 * Tests compare the table with it.
 */
export function computeWindowUsageFull(db: Database, options: Pick<WindowUsageProducerOptions, "rateCards" | "subscriptions" | "claudeGauge">): Map<string, WindowSums> {
  const resolver = loadAccountResolver(db, options.subscriptions ?? []);
  const reader = windowEventReader(db, options.rateCards, resolver);
  const detail = claudeDetailReader(db, options.rateCards, resolver, options.claudeGauge ?? loadClaudeGauge());
  const out = new Map<string, WindowSums>();
  const rows = db.query("SELECT * FROM limit_windows ORDER BY provider,account,counter,seq").all() as LimitWindowRow[];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, earlier = rows.slice(0, index).filter(other => other.provider === row.provider
      && other.account === row.account && other.counter === row.counter);
    const sums = windowSumsFromLedgers(reader, options.rateCards, row.provider, limitWindowFromRow(row), earlier.map(limitWindowFromRow),
      { claude: detail(row.provider, row.account, row.start_ts, row.end_ts, true) }).sums;
    out.set(JSON.stringify([row.provider, row.account, row.counter, row.window_id]), sums);
  }
  for (const interval of readWindowIntervals(db)) out.set(JSON.stringify([interval.provider, interval.account, interval.counter, interval.id]),
    intervalSumsFromLedgers(reader, options.rateCards, interval, { claude: detail(interval.provider, interval.account, interval.start, interval.end),
      unowned: (start, end) => unownedTraffic(db, options.rateCards, resolver, interval.provider, start, end) }).sums);
  return out;
}

export { storeRow as publishWindowUsageRow };
