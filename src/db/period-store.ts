import type { Database } from "bun:sqlite";
import { normEraKey, normEraVendor } from "../server/eras";
import { closedAfter, effectiveDatedPeriods, periodInstant, periodSubjectKey, planPeriodsShape, validatePeriods, type DatedPeriod, type PeriodReading } from "../server/account-periods";
import { markLimitWindowsDirty } from "./limit-windows";
import { markWindowUsageDirty } from "./window-usage";
import { BILLING_BEGINNING, markBillingPeriodsChanged } from "./billing-cycles";

/** The two period tables of migration 0040 share one shape; only the subject and value columns differ. */
export interface PeriodTable { table: "account_periods" | "plan_periods"; subject: "source" | "account"; value: "account" | "plan" }
export const ACCOUNT_PERIODS: PeriodTable = { table: "account_periods", subject: "source", value: "account" };
export const PLAN_PERIODS: PeriodTable = { table: "plan_periods", subject: "account", value: "plan" };

export const ACCOUNT_PERIODS_REVISION = "account_periods_revision";
export const PLAN_PERIODS_REVISION = "plan_periods_revision";
export interface CurrentPeriodDelta { provider: string; source: string; from: number; until: number | null;
  oldAccount: string | null; newAccount: string | null; cursor: string | null; done?: boolean }

/** Invalidate only intervals whose effective owner changed, including uncovered observed owners. */
function accountPeriodsChanged(sqlite: Database, before: readonly DatedPeriod[], after: readonly DatedPeriod[]): void {
  const shape = (rows: readonly DatedPeriod[]) => rows.map(p => JSON.stringify([
    periodSubjectKey(p.provider, p.subject), p.origin, periodInstant(p.from, "from"),
    p.until === null ? null : periodInstant(p.until, "until"), p.value.toLowerCase(),
  ])).sort();
  if (JSON.stringify(shape(before)) === JSON.stringify(shape(after))) return;
  sqlite.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  sqlite.query(`INSERT INTO meta(key,value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(value, '0') AS INTEGER) + 1`).run(ACCOUNT_PERIODS_REVISION);
  const currentV2 = (sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_projection_state'").get() != null)
    && (sqlite.query("SELECT schema_version FROM current_projection_state WHERE id=1").get() as { schema_version: number } | null)?.schema_version === 2;
  let currentChanged = false;
  const deltas: CurrentPeriodDelta[] = [];
  before = effectiveDatedPeriods(before);
  after = effectiveDatedPeriods(after);
  const keys = new Set([...before, ...after].map(p => periodSubjectKey(p.provider, p.subject)));
  for (const key of keys) {
    const oldRows = before.filter(p => periodSubjectKey(p.provider, p.subject) === key);
    const newRows = after.filter(p => periodSubjectKey(p.provider, p.subject) === key);
    const all = [...oldRows, ...newRows];
    const boundaries = [...new Set(all.flatMap(p => [periodInstant(p.from, "from"), p.until === null ? Infinity : periodInstant(p.until, "until")]))].sort((a,b) => a-b);
    const owner = (rows: readonly DatedPeriod[], at: number) => {
      const contains = (p: DatedPeriod) => periodInstant(p.from, "from") <= at && (p.until === null || at < periodInstant(p.until, "until"));
      return (rows.find(p => p.origin === "declared" && contains(p)) ?? rows.find(contains))?.value.toLowerCase() ?? null;
    };
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i]!, until = boundaries[i+1]!;
      const oldOwner = owner(oldRows, from), newOwner = owner(newRows, from);
      if (oldOwner === newOwner) continue;
      const accounts = [...new Set([oldOwner, newOwner].filter((a): a is string => a !== null))];
      // Readings in this interval now belong to the other account: both registers resume from its start.
      for (const account of accounts) markLimitWindowsDirty(sqlite, normEraVendor(all[0]!.provider), account, from);
      // Traffic of this interval changes owner: the sums of both accounts' windows over it, no repricing.
      for (const account of accounts) markWindowUsageDirty(sqlite, { provider: normEraVendor(all[0]!.provider), account, fromMs: from, untilMs: until });
      // The current projection moves the interval's readings between the two cards (`current/v2.ts`).
      if (currentV2) {
        deltas.push({ provider: normEraVendor(all[0]!.provider), source: normEraKey(all[0]!.subject), from,
          until: until === Infinity ? null : until, oldAccount: oldOwner, newAccount: newOwner, cursor: null });
        currentChanged = true;
      }
    }
  }
  if (currentChanged) {
    const key = "current_v2_period_deltas";
    const previous = (sqlite.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value;
    const pending = previous ? JSON.parse(previous) as CurrentPeriodDelta[] : [];
    pending.push(...deltas);
    // A second edit can overlap unfinished work; replay the small changed intervals from their start.
    for (const delta of pending) { delta.cursor = null; delta.done = false; }
    sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(pending));
    sqlite.query("UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1").run();
  }
}

/**
 * What an account's billing cycles read of its plan rows (docs/billing-cycles-design-2026-10-08.md §5): every row as
 * stored (observed rows are continuation evidence beyond a declared end), with its payment, anchor and cycle length.
 * A reading that only moves `last_seen` is not here; the producer re-derives the cycles for that on its own.
 */
const billingShape = (p: DatedPeriod) => JSON.stringify([p.origin, periodInstant(p.from, "from"), p.until === null ? null : periodInstant(p.until, "until"),
  p.value, p.amountMinor ?? null, p.currency ?? null, p.anchor ?? null, p.cycleMonths ?? null]);

/** Plan edits re-resolve measured windows and wake reconstruction; readings and valuations stay intact. */
function planPeriodsChanged(sqlite: Database, before: readonly DatedPeriod[], after: readonly DatedPeriod[]): void {
  const subjects = new Set([...before, ...after].map(p => JSON.stringify([normEraVendor(p.provider), p.subject.toLowerCase()])));
  const changedProviders = new Set<string>();
  for (const subject of subjects) {
    const [provider, account] = JSON.parse(subject) as [string, string];
    if (JSON.stringify(planPeriodsShape(before, provider, account)) !== JSON.stringify(planPeriodsShape(after, provider, account))) {
      markLimitWindowsDirty(sqlite, provider, account, 0, "resolve");
      changedProviders.add(provider);
    }
    // Billing cycles of this account only, from the earliest row that differs (an anchor moves the run's later cycles).
    const key = periodSubjectKey(provider, account);
    const rows = (list: readonly DatedPeriod[]) => list.filter(p => periodSubjectKey(p.provider, p.subject) === key);
    const was = new Set(rows(before).map(billingShape)), is = new Set(rows(after).map(billingShape));
    const changed = [...rows(before).filter(p => !is.has(billingShape(p))), ...rows(after).filter(p => !was.has(billingShape(p)))];
    if (!changed.length) continue;
    const from = Math.min(...changed.flatMap(p => [periodInstant(p.from, "from"), ...(p.anchor ? [periodInstant(p.anchor, "anchor")] : [])]));
    markBillingPeriodsChanged(sqlite, provider, account, Number.isFinite(from) ? from : BILLING_BEGINNING);
  }
  if (changedProviders.size) sqlite.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  for (const provider of changedProviders) sqlite.query(`INSERT INTO meta(key,value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(COALESCE(value, '0') AS INTEGER)+1`).run(`${PLAN_PERIODS_REVISION}:${provider}`);
}

function periodsChanged(sqlite: Database, t: PeriodTable, before: readonly DatedPeriod[]): void {
  if (t === ACCOUNT_PERIODS) accountPeriodsChanged(sqlite, before, loadPeriods(sqlite, t));
  else planPeriodsChanged(sqlite, before, loadPeriods(sqlite, t));
}

interface PeriodRow {
  id: number; provider: string; subject: string; from_ts: string; until_ts: string | null; value: string;
  origin: DatedPeriod["origin"]; first_seen: string | null; last_seen: string | null; readings: number; evidence: string;
  amount_minor: number | null; currency: string | null; anchor_ts: string | null; cycle_months: number | null;
}
const cycleColumns = new WeakSet<Database>();
/** Whether plan_periods has the billing columns of migration 0073 (partial test schemas create it from 0040 only). */
function hasCycleColumns(sqlite: Database): boolean {
  if (cycleColumns.has(sqlite)) return true;
  const found = (sqlite.query("SELECT name FROM pragma_table_info('plan_periods')").all() as Array<{ name: string }>).some(c => c.name === "anchor_ts");
  // Only a positive answer is kept: a migration can add the columns to an open connection.
  if (found) cycleColumns.add(sqlite);
  return found;
}
// Only plan rows carry an amount and a billing anchor; the account table reads them as nulls so both map to one shape.
const columns = (sqlite: Database, t: PeriodTable) =>
  `id, provider, ${t.subject} AS subject, from_ts, until_ts, ${t.value} AS value, origin, first_seen, last_seen, readings, evidence,
   ${t === PLAN_PERIODS ? "amount_minor, currency" : "NULL AS amount_minor, NULL AS currency"},
   ${t === PLAN_PERIODS && hasCycleColumns(sqlite) ? "anchor_ts, cycle_months" : "NULL AS anchor_ts, NULL AS cycle_months"}`;
const toPeriod = (t: PeriodTable, row: PeriodRow): DatedPeriod => ({
  provider: row.provider, subject: row.subject, from: row.from_ts, until: row.until_ts, value: row.value, origin: row.origin,
  firstSeen: row.first_seen, lastSeen: row.last_seen, readings: row.readings, evidence: row.evidence,
  ...(t === PLAN_PERIODS ? { amountMinor: row.amount_minor, currency: row.currency } : {}),
  // Kept off rows without them, so every older row keeps exactly its former shape.
  ...(t === PLAN_PERIODS && (row.anchor_ts !== null || row.cycle_months !== null) ? { anchor: row.anchor_ts, cycleMonths: row.cycle_months } : {}),
});

/** A stored period together with its row id, which an editor needs to name one row. */
export type IdentifiedPeriod = DatedPeriod & { id: number };

export function loadPeriodRows(sqlite: Database, t: PeriodTable): IdentifiedPeriod[] {
  return (sqlite.query(`SELECT ${columns(sqlite, t)} FROM ${t.table} ORDER BY provider, subject, from_ts`).all() as PeriodRow[])
    .map((row) => ({ id: row.id, ...toPeriod(t, row) }));
}

export function loadPeriods(sqlite: Database, t: PeriodTable): DatedPeriod[] {
  return loadPeriodRows(sqlite, t).map(({ id: _id, ...period }) => period);
}

/** The stored columns of a period and their values, in one order for INSERT and UPDATE. */
function periodColumns(sqlite: Database, t: PeriodTable, p: DatedPeriod): { names: string[]; values: Array<string | number | null> } {
  const cycles = t === PLAN_PERIODS && hasCycleColumns(sqlite);
  const names = ["provider", t.subject, "from_ts", "until_ts", t.value, "origin", "first_seen", "last_seen", "readings", "evidence",
    ...(t === PLAN_PERIODS ? ["amount_minor", "currency", ...(cycles ? ["anchor_ts", "cycle_months"] : [])] : [])];
  const values = [normEraVendor(p.provider), p.subject, p.from, p.until, p.value, p.origin, p.firstSeen, p.lastSeen, p.readings, p.evidence,
    ...(t === PLAN_PERIODS ? [p.amountMinor ?? null, p.currency ?? null, ...(cycles ? [p.anchor ?? null, p.cycleMonths ?? null] : [])] : [])];
  return { names, values };
}

function insertPeriod(sqlite: Database, t: PeriodTable, p: DatedPeriod): void {
  const { names, values } = periodColumns(sqlite, t, p);
  sqlite.query(`INSERT INTO ${t.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
}

function updatePeriod(sqlite: Database, t: PeriodTable, id: number, p: DatedPeriod): void {
  const { names, values } = periodColumns(sqlite, t, p);
  sqlite.query(`UPDATE ${t.table} SET ${names.map((name) => `${name} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
}

export type ReadingOutcome = "extended" | "opened" | "switched" | "out-of-order";

/**
 * The cost of one profile reading: one row looked up, one row updated. The same value moves
 * `last_seen`; another value closes the running period just after its last reading and opens the next,
 * so the unobserved time between them stays a gap.
 *
 * A reading older than the period's last one (a journal from the other PC arriving late) is
 * not applied here: it can split or reorder periods, which `replaceObservedPeriods` rebuilds
 * from the subject's readings. The caller gets `out-of-order` and decides.
 */
export function recordPeriodReading(sqlite: Database, t: PeriodTable, reading: PeriodReading, evidence = "profile-reading"): ReadingOutcome {
  const provider = normEraVendor(reading.provider), at = periodInstant(reading.ts, "reading time");
  return sqlite.transaction((): ReadingOutcome => {
    const latest = sqlite.query(`SELECT ${columns(sqlite, t)} FROM ${t.table}
      WHERE provider = ? AND ${t.subject} = ? COLLATE NOCASE AND origin = 'observed' ORDER BY from_ts DESC LIMIT 1`)
      .get(provider, reading.subject) as PeriodRow | null;
    const open = (): void => insertPeriod(sqlite, t, {
      provider, subject: reading.subject, from: reading.ts, until: null, value: reading.value, origin: "observed",
      firstSeen: reading.ts, lastSeen: reading.ts, readings: 1, evidence,
    });
    if (!latest) {
      const before = loadPeriods(sqlite, t);
      open();
      periodsChanged(sqlite, t, before);
      return "opened";
    }
    if (at < periodInstant(latest.last_seen ?? latest.from_ts, "last reading")) return "out-of-order";
    if (latest.value === reading.value && latest.until_ts === null) {
      // One probe cycle writes several rows with one timestamp; they are one reading.
      if (latest.last_seen === reading.ts) return "extended";
      sqlite.query(`UPDATE ${t.table} SET last_seen = ?, readings = readings + 1 WHERE id = ?`).run(reading.ts, latest.id);
      return "extended";
    }
    const switched = latest.until_ts === null;
    const before = loadPeriods(sqlite, t);
    if (switched) sqlite.query(`UPDATE ${t.table} SET until_ts = ? WHERE id = ?`).run(closedAfter(latest.last_seen ?? latest.from_ts), latest.id);
    open();
    periodsChanged(sqlite, t, before);
    return switched ? "switched" : "opened";
  }).immediate();
}

/**
 * Makes the table's declared rows equal to the declarations file. The file is the source of these
 * rows, so the whole set is compared and, only when it differs, brought in line row by row: a row
 * keyed by its subject and start keeps its id (editors name rows by id), changed rows are updated,
 * missing ones deleted, new ones inserted. Observed rows stay. Returns whether anything changed.
 */
export function replaceDeclaredPeriods(sqlite: Database, t: PeriodTable, periods: readonly DatedPeriod[]): boolean {
  if (periods.some((p) => p.origin !== "declared")) throw new Error("replaceDeclaredPeriods: rows of another origin");
  const errors = validatePeriods(periods);
  if (errors.length) throw new Error(errors.join("\n"));
  const shape = (p: DatedPeriod) => [normEraVendor(p.provider), p.subject, p.from, p.until, p.value, p.evidence,
    t === PLAN_PERIODS ? p.amountMinor ?? null : null, t === PLAN_PERIODS ? p.currency ?? null : null,
    t === PLAN_PERIODS ? p.anchor ?? null : null, t === PLAN_PERIODS ? p.cycleMonths ?? null : null];
  const order = (a: DatedPeriod, b: DatedPeriod) => periodSubjectKey(a.provider, a.subject).localeCompare(periodSubjectKey(b.provider, b.subject)) || a.from.localeCompare(b.from);
  const current = loadPeriods(sqlite, t).filter((p) => p.origin === "declared").sort(order).map(shape);
  const next = [...periods].sort(order).map(shape);
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  const keyOf = (p: DatedPeriod) => JSON.stringify([normEraVendor(p.provider), p.subject, p.from]);
  sqlite.transaction(() => {
    const before = loadPeriods(sqlite, t);
    const stored = new Map(loadPeriodRows(sqlite, t).filter((p) => p.origin === "declared").map((p) => [keyOf(p), p]));
    const wanted = new Map(periods.map((p) => [keyOf(p), p]));
    // Deletes first: a removed row may hold the start a new row of the same subject takes.
    for (const [key, row] of stored) if (!wanted.has(key)) sqlite.query(`DELETE FROM ${t.table} WHERE id = ?`).run(row.id);
    for (const [key, period] of wanted) {
      const row = stored.get(key);
      if (!row) insertPeriod(sqlite, t, period);
      else if (JSON.stringify(shape(row)) !== JSON.stringify(shape(period))) updatePeriod(sqlite, t, row.id, period);
    }
    periodsChanged(sqlite, t, before);
  }).immediate();
  return true;
}

/**
 * Moves the start of a subject's earliest observed row, e.g. back to the source's first call when it
 * only ever showed one account; `first_seen` keeps the first reading. One row updated, and the moved
 * interval invalidated for its account like any period change.
 */
export function moveObservedStart(sqlite: Database, t: PeriodTable, provider: string, subject: string, from: string): void {
  const at = periodInstant(from, "from"), key = periodSubjectKey(provider, subject);
  sqlite.transaction(() => {
    const before = loadPeriods(sqlite, t);
    const row = loadPeriodRows(sqlite, t).filter(p => p.origin === "observed" && periodSubjectKey(p.provider, p.subject) === key)
      .sort((a, b) => periodInstant(a.from, "from") - periodInstant(b.from, "from"))[0];
    if (!row || periodInstant(row.from, "from") === at) return;
    if (row.until !== null && periodInstant(row.until, "until") <= at) throw new Error(`moveObservedStart: ${from} is not before ${row.until}`);
    sqlite.query(`UPDATE ${t.table} SET from_ts = ? WHERE id = ?`).run(from, row.id);
    periodsChanged(sqlite, t, before);
  }).immediate();
}

/** Replaces one subject's observed rows, e.g. rebuilt by `observedPeriods` from all of its readings. Declared rows stay. */
export function replaceObservedPeriods(sqlite: Database, t: PeriodTable, provider: string, subject: string, periods: readonly DatedPeriod[]): void {
  const key = periodSubjectKey(provider, subject);
  if (periods.some((p) => p.origin !== "observed" || periodSubjectKey(p.provider, p.subject) !== key)) {
    throw new Error("replaceObservedPeriods: rows of another subject or origin");
  }
  const errors = validatePeriods(periods);
  if (errors.length) throw new Error(errors.join("\n"));
  sqlite.transaction(() => {
    const before = loadPeriods(sqlite, t);
    sqlite.query(`DELETE FROM ${t.table} WHERE provider = ? AND ${t.subject} = ? COLLATE NOCASE AND origin = 'observed'`).run(normEraVendor(provider), subject);
    for (const period of periods) insertPeriod(sqlite, t, period);
    periodsChanged(sqlite, t, before);
  }).immediate();
}
