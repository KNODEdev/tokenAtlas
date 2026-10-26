import type { Database } from "bun:sqlite";
import { ProbeAccountIndexUnavailable } from "../server/current/probe-account-unavailable";
import type { ProbeLimitWindow } from "../server/probe-limit-windows";
import { asSchemaWriter } from "./schema-writer";

/** Kept identical to drizzle/0050_limit_windows.sql; tests compare them. */
export const LIMIT_WINDOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS limit_windows (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, seq INTEGER NOT NULL,
  window_id TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, reset_ts TEXT NOT NULL,
  cycle_end_basis TEXT NOT NULL, window_minutes INTEGER NOT NULL,
  plan TEXT, plan_detail TEXT, plan_mismatch INTEGER NOT NULL,
  readings TEXT NOT NULL, manual TEXT, start_drop TEXT, end_drop TEXT,
  seen_reset INTEGER NOT NULL, last_input TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, seq)
) STRICT;
CREATE TABLE IF NOT EXISTS limit_window_inputs (
  provider TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL, counter TEXT NOT NULL,
  ts TEXT NOT NULL, grp TEXT NOT NULL, ord INTEGER NOT NULL, used_percent REAL NOT NULL, resets_at TEXT NOT NULL,
  window_minutes INTEGER NOT NULL, source TEXT NOT NULL, limit_hit TEXT, anchor INTEGER NOT NULL,
  home TEXT, path TEXT,
  PRIMARY KEY(provider, account, scope, counter, ts, grp, ord)
) STRICT;
CREATE INDEX IF NOT EXISTS limit_window_inputs_anchor ON limit_window_inputs(provider, account, scope, anchor);
CREATE INDEX IF NOT EXISTS limit_window_inputs_file ON limit_window_inputs(home, path) WHERE home IS NOT NULL;
CREATE TABLE IF NOT EXISTS limit_window_state (
  provider TEXT NOT NULL, account TEXT NOT NULL, scope TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('filling','ready')),
  lead_max INTEGER, lead_min INTEGER, inputs_from INTEGER, changed_from INTEGER, resolve INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider, account, scope)
) STRICT;
CREATE TABLE IF NOT EXISTS limit_window_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('inputs','resolve','file')),
  from_ms INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account, kind)
) STRICT;`;

export function ensureLimitWindowSchema(db: Database): void {
  asSchemaWriter(db, () => {
    db.exec(LIMIT_WINDOW_SCHEMA_SQL);
    if (!(db.query("PRAGMA table_info(limit_window_inputs)").all() as Array<{ name: string }>).some(column => column.name === "source_plan"))
      db.exec("ALTER TABLE limit_window_inputs ADD COLUMN source_plan TEXT");
    if (!(db.query("PRAGMA table_info(limit_windows)").all() as Array<{ name: string }>).some(column => column.name === "activity"))
      db.exec("ALTER TABLE limit_windows ADD COLUMN activity TEXT");
  });
}

/** Earlier than any reading: an entry from here recomputes the whole register. */
export const LIMIT_WINDOW_ALL = -8_640_000_000_000_000;
/** Every account of a provider. */
export const ALL_ACCOUNTS = "*";
/** An identity-verified Codex reading can decide the owner of transcript readings this far on either side. */
export const LIMIT_WINDOW_OWNERSHIP_MS = 24 * 3_600_000 + 5 * 60_000;

const present = new WeakSet<Database>();
function hasDirtyQueue(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='limit_window_dirty'").get();
  if (found) present.add(db);
  return found;
}

/**
 * Called by the writer that changed a limit-window input, inside its own transaction: the windows of
 * `account` (or every account, `*`) depending on readings from `fromMs` on must be recomputed. Databases
 * without the limit-window schema (partial test schemas) have nothing to invalidate.
 */
export function markLimitWindowsDirty(db: Database, provider: string, account: string, fromMs: number,
  kind: "inputs" | "resolve" = "inputs"): void {
  if (!Number.isFinite(fromMs) || !hasDirtyQueue(db)) return;
  db.query(`INSERT INTO limit_window_dirty(provider,account,kind,from_ms) VALUES(?,?,?,?)
    ON CONFLICT(provider,account,kind) DO UPDATE SET from_ms=MIN(from_ms,excluded.from_ms),sequence=sequence+1`)
    .run(provider.toLowerCase(), account === ALL_ACCOUNTS ? account : account.toLowerCase(), kind, Math.max(LIMIT_WINDOW_ALL, Math.floor(fromMs)));
}

/** A Codex transcript whose readings or models changed; the producer resolves its accounts and first reading. */
export function markLimitWindowFilesDirty(db: Database, files: ReadonlyArray<{ home: string; path: string }>): void {
  if (!files.length || !hasDirtyQueue(db)) return;
  const save = db.query(`INSERT INTO limit_window_dirty(provider,account,kind,from_ms) VALUES('codex',?,'file',0)
    ON CONFLICT(provider,account,kind) DO UPDATE SET sequence=sequence+1`);
  for (const key of new Set(files.map(file => JSON.stringify([file.home, file.path])))) save.run(key);
}

/** The stored register of an account and counter is not prepared yet. Screens answer "preparing". */
export class LimitWindowsPreparing extends ProbeAccountIndexUnavailable {
  constructor() { super(); this.message = "Limit windows are preparing"; }
}

export interface LimitWindowRow {
  activity?: string | null;
  provider: string; account: string; counter: string; seq: number; window_id: string;
  start_ts: string; end_ts: string; reset_ts: string; cycle_end_basis: string; window_minutes: number;
  plan: string | null; plan_detail: string | null; plan_mismatch: number; readings: string; manual: string | null;
  start_drop: string | null; end_drop: string | null; seen_reset: number; last_input: string;
}

/** A stored row as the window object the segmentation defines, with the same field order. */
export function limitWindowFromRow(row: LimitWindowRow): ProbeLimitWindow {
  const manual = row.manual === null ? null : JSON.parse(row.manual) as NonNullable<ProbeLimitWindow["manual_measurements"]>;
  return { id: row.window_id, account: row.account, counter: row.counter, start: row.start_ts, end: row.end_ts,
    reset: row.reset_ts, cycle_end_basis: row.cycle_end_basis as ProbeLimitWindow["cycle_end_basis"],
    window_minutes: row.window_minutes, readings: JSON.parse(row.readings) as ProbeLimitWindow["readings"],
    startDrop: row.start_drop === null ? null : JSON.parse(row.start_drop) as ProbeLimitWindow["startDrop"],
    endDrop: row.end_drop === null ? null : JSON.parse(row.end_drop) as ProbeLimitWindow["endDrop"],
    plan: row.plan, plan_detail: row.plan_detail === null ? null : JSON.parse(row.plan_detail) as ProbeLimitWindow["plan_detail"],
    declared_plan_meter_mismatch: row.plan_mismatch === 1,
    ...(row.activity ? { activity: JSON.parse(row.activity) as ProbeLimitWindow["activity"] } : {}),
    ...(manual ? { manual_measurement: manual[0]!, manual_measurements: manual } : {}) };
}

/** Codex keeps one producer scope per counter; every other provider one scope per account. */
export const limitWindowScope = (provider: string, counter: string) => provider === "codex" ? counter : "*";

function scopeReady(db: Database, provider: string, account: string, scope: string): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='limit_window_state'").get()) return false;
  const state = db.query("SELECT status FROM limit_window_state WHERE provider=? AND account=? AND scope=?")
    .get(provider, account, scope) as { status: string } | null;
  if (state) return state.status === "ready";
  // An account the producer has never had to prepare (no period names it) has no windows, unless a
  // writer has just queued it (a new period names it) and the producer has not run yet.
  const discovered = db.query("SELECT status FROM limit_window_state WHERE provider=? AND account='' AND scope=''")
    .get(provider) as { status: string } | null;
  if (discovered?.status !== "ready") return false;
  return !db.query("SELECT 1 FROM limit_window_dirty WHERE provider=? AND account=? AND kind='inputs'").get(provider, account);
}
/** The same readiness contract as the window readers, without reading or decoding any cycles. */
export function limitWindowsReady(db: Database, provider: string, account: string, counter: string): boolean {
  const vendor = provider.toLowerCase();
  return scopeReady(db, vendor, account.toLowerCase(), limitWindowScope(vendor, counter));
}

/**
 * The stored windows of one account and counter, in segmentation order. Never computes: a register that
 * has not been prepared yet raises LimitWindowsPreparing; one that is being updated returns its last
 * complete version.
 */
export function readLimitWindows(db: Database, provider: string, account: string, counter: string): ProbeLimitWindow[] {
  const vendor = provider.toLowerCase(), id = account.toLowerCase();
  if (!scopeReady(db, vendor, id, limitWindowScope(vendor, counter))) throw new LimitWindowsPreparing();
  return (db.query(`SELECT * FROM limit_windows WHERE provider=? AND account=? AND counter=? ORDER BY seq`)
    .all(vendor, id, counter) as LimitWindowRow[]).map(limitWindowFromRow);
}

/** Stored windows of every counter of an account whose counter identity satisfies `wanted`. */
export function readLimitWindowsWhere(db: Database, provider: string, account: string,
  wanted: (counter: string) => boolean, ids?: readonly string[]): ProbeLimitWindow[] {
  const vendor = provider.toLowerCase(), id = account.toLowerCase();
  if (!scopeReady(db, vendor, id, limitWindowScope(vendor, ""))) throw new LimitWindowsPreparing();
  return (db.query(`SELECT * FROM limit_windows WHERE provider=? AND account=?${ids ? " AND window_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY counter, seq`)
    .all(vendor, id, ...(ids ? [JSON.stringify(ids)] : [])) as LimitWindowRow[]).filter(row => wanted(row.counter)).map(limitWindowFromRow);
}

/** Window identities and bounds without decoding historical meter readings. */
export function readLimitWindowHeaders(db: Database, provider: string, account: string):
  Array<{ id: string; counter: string; start: string; end: string; reset: string; activity?: ProbeLimitWindow["activity"] }> {
  const vendor = provider.toLowerCase(), id = account.toLowerCase();
  if (!scopeReady(db, vendor, id, limitWindowScope(vendor, ""))) throw new LimitWindowsPreparing();
  const rows = db.query(`SELECT window_id AS id,counter,start_ts AS start,end_ts AS end,reset_ts AS reset,activity
    FROM limit_windows WHERE provider=? AND account=? ORDER BY counter,seq`).all(vendor, id) as
    Array<{ id: string; counter: string; start: string; end: string; reset: string; activity: string | null }>;
  return rows.map(({ activity, ...row }) => ({ ...row, ...(activity ? { activity: JSON.parse(activity) as ProbeLimitWindow["activity"] } : {}) }));
}

/**
 * The counter and start of every stored window of one account (one counter for Codex, whose scopes are its
 * counters), without their readings. Raises LimitWindowsPreparing like the window readers.
 */
export function readLimitWindowStarts(db: Database, provider: string, account: string, counter?: string): Array<{ counter: string; start: string }> {
  const vendor = provider.toLowerCase(), id = account.toLowerCase();
  if (!scopeReady(db, vendor, id, limitWindowScope(vendor, counter ?? ""))) throw new LimitWindowsPreparing();
  return db.query(`SELECT counter, start_ts AS start FROM limit_windows WHERE provider=? AND account=?${counter === undefined ? "" : " AND counter=?"}
    ORDER BY counter, seq`).all(...[vendor, id, ...(counter === undefined ? [] : [counter])]) as Array<{ counter: string; start: string }>;
}

/** Changes whenever a stored register of the account is republished; old sum memos key on it until U1.3. */
export function limitWindowRevision(db: Database, provider: string, account: string): number {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='limit_window_state'").get()) return 0;
  return (db.query("SELECT COALESCE(SUM(revision),0) AS revision FROM limit_window_state WHERE provider=? AND account=?")
    .get(provider.toLowerCase(), account.toLowerCase()) as { revision: number }).revision;
}
