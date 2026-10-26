import type { AppContext } from "./app-context-types";
import { isCodexWindowMinutes } from "../shared/codex-counters";
import { analysisHash, withReadSnapshot } from "../db/analysis";
import { hasCapacityCycleResults, markCapacityCycleResultsDirty, bumpCapacityCycleResultsClock } from "../db/capacity-cycle-results";
import { capacityProviderOf } from "./capacity-cycles";
import { codexCapacityCycles } from "./codex-accounting";
import { subscriptionCapacityCycles } from "./subscription-accounting";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { parseCapacityCounter, type ManualCapacityMeasurement } from "../shared/manual-capacity";
import { readManualCapacity } from "./manual-capacity";
import { capacityRegimesFor } from "./plans";
import { resolveProviderGroup } from "./plans-catalog";
import { CLAUDE_CODE_CAPACITY_ALGORITHM } from "../shared/claude-code-capacity";
import { CLAUDE_CAPACITY_RESULT_VERSION } from "../shared/claude-capacity-result";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import type { CurrentConfig } from "./current/registry";
import type { RateCard } from "./pricing";
import type { PlansConfig } from "./plans";
import type { PlansCatalog } from "./plans-catalog";
import type { Database } from "bun:sqlite";
import type { AccountsV2 } from "../config/accounts-v2";
import { periodEras } from "./subscription-maps";
import { buildEraIndex } from "./eras";
import { loadCycles } from "./cycles";

const RULE = 1, BEGINNING = -8_640_000_000_000_000;
export const CAPACITY_CYCLE_RESULTS_CLOCK = "capacity_cycle_results";
export function capacityCycleProducerContext(sqlite: Database, rateCards: RateCard, config: CurrentConfig,
  plans: PlansConfig, plansCatalog: PlansCatalog): AppContext {
  const accounts = { version: 2, subscriptions: config.subscriptions, sources: config.sources } as AccountsV2;
  return { sqlite, rateCards, accounts, plans, plansCatalog, cycles: loadCycles(), eras: buildEraIndex(periodEras(sqlite, accounts), "instant") } as AppContext;
}
interface Dirty { provider: string; account: string; from_ms: number; until_ms: number | null; sequence: number; phase: string; cursor: string | null }
export interface CapacityCycleResultRow {
  provider: string; account: string; counter: string; window_id: string; start_ts: string; end_ts: string;
  window_minutes: number; dirty: number; body: string | null; preparing: number; error: string | null;
}
export interface CapacityCycleProducerOptions {
  limit?: number; budgetMs?: number; canWrite?: () => boolean;
}
export function capacityCycleSubjects(ctx: AppContext): Map<string, string> {
  const subjects = new Map<string, string>();
  for (const subscription of ctx.accounts.subscriptions ?? []) {
    const provider = capacityProviderOf(subscription.vendor);
    if (provider && !subscription.id.endsWith("::business")) subjects.set(subscription.id.toLowerCase(), provider);
  }
  for (const row of ctx.sqlite.query("SELECT DISTINCT provider,account FROM limit_windows").all() as Array<{ provider: string; account: string }>) {
    const provider = capacityProviderOf(row.provider);
    if (provider && !row.account.endsWith("::business") && !subjects.has(row.account)) subjects.set(row.account, provider);
  }
  return subjects;
}
export function capacityCycleConfiguration(ctx: AppContext, provider: string, account: string, measurements: readonly ManualCapacityMeasurement[]): string {
  const group = resolveProviderGroup(ctx.plansCatalog, provider);
  return JSON.stringify({ context: analysisHash([RULE, provider, capacityRegimesFor(ctx.plans, account), group,
    ctx.cycles?.windows?.filter(window => window.subscription.toLowerCase() === account),
    ...(provider === "claude" ? [CLAUDE_CODE_CAPACITY_ALGORITHM, CLAUDE_CAPACITY_RESULT_VERSION] : [])]),
    manual: measurements.filter(m => m.account === account) });
}
const stateKey = (provider: string, account: string) => JSON.stringify([provider, account]);
export function capacityCycleStateKey(provider: string, account: string): string { return stateKey(provider, account); }
const getState = (ctx: AppContext, key: string) => (ctx.sqlite.query("SELECT value FROM capacity_cycle_result_state WHERE key=?").get(key) as { value: string } | null)?.value;
const putState = (ctx: AppContext, key: string, value: string) => ctx.sqlite.query("INSERT INTO capacity_cycle_result_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(key, value);
function matching(provider: string, counter: string, minutes: number): boolean {
  if (provider === "codex") return isCodexWindowMinutes(minutes) && counter === JSON.stringify(["codex", "codex", minutes]);
  const parts = parseCapacityCounter(counter);
  return !!parts && (parts[2] === 300 || parts[2] === 10080) && subscriptionAccountingAdapter(provider).counterKinds.includes(parts[0]);
}

/** Only the background writer invokes this producer. Its durable queue is fed by common window marks. */
export function advanceCapacityCycleResults(ctx: AppContext, options: CapacityCycleProducerOptions = {}): { processed: number; discovered: number; pending: boolean } | null {
  const db = ctx.sqlite;
  const started = performance.now();
  if (!hasCapacityCycleResults(db)) return null;
  if (options.canWrite && !options.canWrite()) return { processed: 0, discovered: 0, pending: true };
  const manual = new Map<string, readonly ManualCapacityMeasurement[]>();
  const measurements = (provider: string) => {
    if (!manual.has(provider)) manual.set(provider, provider === "codex" ? [] : readManualCapacity(provider).measurements);
    return manual.get(provider)!;
  };
  // Configuration discovery is small and scoped by account. Manual edits queue their old and new intervals only.
  for (const [account, provider] of capacityCycleSubjects(ctx)) {
    const key = stateKey(provider, account), value = capacityCycleConfiguration(ctx, provider, account, measurements(provider));
    const old = getState(ctx, key);
    if (old === value) continue;
    const before = old ? JSON.parse(old) as { context: string; manual: ManualCapacityMeasurement[] } : null;
    const after = JSON.parse(value) as { context: string; manual: ManualCapacityMeasurement[] };
    db.transaction(() => {
      if (!before || before.context !== after.context) markCapacityCycleResultsDirty(db, provider, account, BEGINNING, null, true);
      else {
        const previous = new Map(before.manual.map(m => [m.id, m]));
        const next = new Map(after.manual.map(m => [m.id, m]));
        for (const id of new Set([...previous.keys(), ...next.keys()])) if (JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))) {
          for (const m of [previous.get(id), next.get(id)]) if (m) markCapacityCycleResultsDirty(db, provider, account, Date.parse(m.start), Date.parse(m.end) + 1);
        }
      }
      putState(ctx, key, value);
    }).immediate();
  }
  // Fold a bounded batch of marks before calculating: a burst for one cycle needs one result.
  // Every page and phase stays durable; a new mark resets only its own cursor.
  let discovered = 0;
  while (discovered < 64 && (discovered === 0 || performance.now() - started < (options.budgetMs ?? 250))
    && (!options.canWrite || options.canWrite())) {
    const scope = db.query("SELECT * FROM capacity_cycle_result_dirty ORDER BY from_ms LIMIT 1").get() as Dirty | null;
    if (!scope) break;
    const pageSize = 64 - discovered;
    const after = scope.cursor ? JSON.parse(scope.cursor) as string[] : ["", "", "", "", ""];
    const key = (row: CapacityCycleResultRow) => [row.start_ts, row.provider, row.account, row.counter, row.window_id];
    const common = [scope.provider, scope.provider, scope.account, scope.account, scope.from_ms - 1, scope.until_ms, scope.until_ms === null ? null : scope.until_ms + 1];
    const select = (table: string) => db.query(`SELECT provider,account,counter,window_id,start_ts,end_ts,window_minutes FROM ${table}
      WHERE (?='*' OR provider=?) AND (?='*' OR account=?) AND julianday(end_ts)*86400000-210866760000000 > ?
      AND (? IS NULL OR julianday(start_ts)*86400000-210866760000000 < ?)
      AND (start_ts,provider,account,counter,window_id)>(?,?,?,?,?) ORDER BY start_ts,provider,account,counter,window_id LIMIT ?`)
      .all(...common, ...after, pageSize) as CapacityCycleResultRow[];
    const folded = (row: CapacityCycleResultRow) => !!db.query("SELECT 1 FROM limit_windows WHERE provider=? AND account=? AND counter=? AND EXISTS(SELECT 1 FROM json_each(manual) WHERE json_extract(value,'$.id')=?)")
      .get(row.provider, row.account, row.counter, row.window_id.slice(7));
    let page: CapacityCycleResultRow[];
    if (scope.phase === "manual") {
      const candidates: CapacityCycleResultRow[] = [];
      for (const [account, provider] of capacityCycleSubjects(ctx)) {
        if (provider === "codex" || scope.provider !== "*" && scope.provider !== provider || scope.account !== "*" && scope.account !== account) continue;
        for (const m of measurements(provider)) if (m.account === account && Date.parse(m.end) >= scope.from_ms
          && (scope.until_ms === null || Date.parse(m.start) < scope.until_ms)) candidates.push({ provider, account, counter: m.counter,
          window_id: `manual:${m.id}`, start_ts: m.start, end_ts: m.end, window_minutes: parseCapacityCounter(m.counter)?.[2] ?? 0 } as CapacityCycleResultRow);
      }
      const compare = (a: readonly string[], b: readonly string[]) => { for (let i = 0; i < a.length; i++) { if (a[i]! < b[i]!) return -1; if (a[i]! > b[i]!) return 1; } return 0; };
      page = candidates.filter(row => compare(key(row), after) > 0).sort((a, b) => compare(key(a), key(b))).slice(0, pageSize);
    } else page = select(scope.phase === "windows" ? "limit_windows" : "capacity_cycle_results");
    db.transaction(() => {
      const put = db.query(`INSERT INTO capacity_cycle_results(provider,account,counter,window_id,start_ts,end_ts,window_minutes)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,account,counter,window_id) DO UPDATE SET start_ts=excluded.start_ts,end_ts=excluded.end_ts,window_minutes=excluded.window_minutes,dirty=1`);
      for (const row of page) {
        if (scope.phase === "delete") {
          const exists = row.window_id.startsWith("manual:")
            ? measurements(row.provider).some(m => m.account === row.account && m.counter === row.counter && `manual:${m.id}` === row.window_id) && !folded(row)
            : !!db.query("SELECT 1 FROM limit_windows WHERE provider=? AND account=? AND counter=? AND window_id=?")
              .get(row.provider, row.account, row.counter, row.window_id);
          if (!exists) db.query("DELETE FROM capacity_cycle_results WHERE provider=? AND account=? AND counter=? AND window_id=?")
            .run(row.provider, row.account, row.counter, row.window_id);
        } else if (matching(row.provider, row.counter, row.window_minutes) && (scope.phase !== "manual" || !folded(row)))
          put.run(row.provider, row.account, row.counter, row.window_id, row.start_ts, row.end_ts, row.window_minutes);
      }
      if (page.length === pageSize) db.query("UPDATE capacity_cycle_result_dirty SET cursor=? WHERE provider=? AND account=? AND from_ms=? AND sequence=?")
        .run(JSON.stringify(key(page.at(-1)!)), scope.provider, scope.account, scope.from_ms, scope.sequence);
      else if (scope.phase === "delete") db.query("DELETE FROM capacity_cycle_result_dirty WHERE provider=? AND account=? AND from_ms=? AND sequence=?")
        .run(scope.provider, scope.account, scope.from_ms, scope.sequence);
      else db.query("UPDATE capacity_cycle_result_dirty SET phase=?,cursor=NULL WHERE provider=? AND account=? AND from_ms=? AND sequence=?")
        .run(scope.phase === "windows" ? "manual" : "delete", scope.provider, scope.account, scope.from_ms, scope.sequence);
      bumpCapacityCycleResultsClock(db);
    }).immediate();
    discovered += Math.max(1, page.length);
  }
  let processed = 0;
  const pendingRows = db.query(`SELECT r.provider,r.account,r.counter,r.window_id,r.start_ts,r.end_ts,r.window_minutes
    FROM capacity_cycle_results r WHERE dirty=1
    AND NOT EXISTS(SELECT 1 FROM window_usage_pending p WHERE p.provider=r.provider AND p.account=r.account AND p.counter=r.counter AND p.window_id=r.window_id)
    AND NOT EXISTS(SELECT 1 FROM limit_window_dirty d WHERE d.provider IN (r.provider,'*') AND d.account IN (r.account,'*'))
    AND NOT EXISTS(SELECT 1 FROM window_usage_dirty d WHERE d.provider IN (r.provider,'*') AND d.account IN (r.account,'*') AND d.counter IN (r.counter,'*')
      AND d.from_ms < julianday(r.end_ts)*86400000-210866760000000+1 AND (d.until_ms IS NULL OR d.until_ms > julianday(r.start_ts)*86400000-210866760000000-1))
    ORDER BY end_ts DESC LIMIT ?`).all(options.limit ?? 8) as CapacityCycleResultRow[];
  for (const row of pendingRows) {
    if (processed >= (options.limit ?? 8) || processed > 0 && performance.now() - started >= (options.budgetMs ?? 250)
      || options.canWrite && !options.canWrite()) break;
    const range = { since: row.start_ts.slice(0, 10), until: new Date(Date.parse(row.end_ts) - 1).toISOString().slice(0, 10) };
    let body: string | null = null, error: string | null = null, preparing = 0;
    try {
      body = withReadSnapshot(db, () => {
        const windows = row.provider === "codex"
          ? codexCapacityCycles(db, row.account, row.window_minutes as 300 | 10080 | 43200, range, ctx.plans, ctx.plansCatalog, ctx.eras, row.window_id)
          : subscriptionCapacityCycles({ ...ctx, manualCapacity: [...measurements(row.provider)], declarations: ctx.accounts.subscriptions },
            row.provider, row.account, row.counter, range, row.window_id);
        return windows[0] ? JSON.stringify(windows[0]) : null;
      });
    } catch (cause) {
      if (cause instanceof ProbeAccountIndexUnavailable) preparing = 1;
      else error = cause instanceof Error ? cause.message : String(cause);
    }
    // Pending traffic is retried on its next publication, rather than spinning or recalculating facts.
    if (options.canWrite && !options.canWrite()) break;
    db.transaction(() => {
      db.query("UPDATE capacity_cycle_results SET body=?,error=?,preparing=?,dirty=0 WHERE provider=? AND account=? AND counter=? AND window_id=?")
        .run(body, error, preparing, row.provider, row.account, row.counter, row.window_id);
      bumpCapacityCycleResultsClock(db);
    }).immediate();
    processed++;
  }
  return { processed, discovered, pending: !!db.query("SELECT 1 FROM capacity_cycle_results WHERE dirty=1 LIMIT 1").get()
    || !!db.query("SELECT 1 FROM capacity_cycle_result_dirty LIMIT 1").get() };
}
