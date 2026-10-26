import type { Database } from "./sqlite";
import type { CodexLedgerBaseScope } from "./codex-ledger-dependencies";
import type { LedgerBaseBand } from "./codex-price-ledger";

/**
 * The Codex price ledger's state and work queue on the shared ledger machinery (U3.0 note §4): Codex keeps its
 * own fact and sum tables (codex_price_ledger_*), and its producer records where it stands in the `codex` row of
 * `usage_ledger_state` and what is left to do in `usage_ledger_dirty`, as the other providers' producer does.
 *
 * State row: `version` is the ledger algorithm, `status` is `ready` once published (it stays so while new facts
 * are processed: read-freshness.ts), `covered` the Codex facts revision it has reached, `rules_digest` and
 * `rules_json` the rule revision and policy its published values follow, `revision` moves with every publication.
 * During the fill from empty the phase is `backfill` and the bookmark holds the fill phase and cursor.
 *
 * Queue (`usage_ledger_dirty`, provider `codex`): `copy` and `blocked` hold a changed transcript `[home,path]`
 * (blocked: waiting for an archive binding), `rules` a price-rule scope with its resume point, `identity` a
 * conversation whose copies must be resolved, `day` a day whose sums must be rebuilt, `session` a copy (its id) whose
 * activity gaps must be recomputed, `activity` a day whose activity sums alone must be re-summed. The API and credit bands the
 * queued rules follow are the provider's rows in `usage_ledger_keys` (key `[rule id, band]`, rates the band).
 */
export const CODEX_LEDGER_PROVIDER = "codex";
/** The stored algorithm; a ledger written by another one answers "preparing" until it is rebuilt. */
export const CODEX_LEDGER_VERSION = 1;
export type CodexLedgerWorkKind = "copy" | "blocked" | "rules" | "identity" | "day" | "session" | "activity";
export interface CodexLedgerState {
  version: number; phase: "backfill" | "reconcile"; status: "pending" | "ready"; covered: number; bookmark: string;
  rules_digest: string; rules_json: string | null; revision: number;
  /** 1 once every copy's gaps and every day's activity sums have been computed (migration 0067 queues them all). */
  activity_published: number;
}

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function readCodexLedgerState(db: Database): CodexLedgerState | null {
  if (!tableExists(db, "usage_ledger_state")) return null;
  return db.query(`SELECT version,phase,status,covered,bookmark,rules_digest,rules_json,revision,activity_published FROM usage_ledger_state
    WHERE provider='${CODEX_LEDGER_PROVIDER}'`).get() as CodexLedgerState | null;
}
/** Published once under the current algorithm; it stays readable while new work is processed. */
export function codexLedgerPublished(db: Database): boolean {
  const state = readCodexLedgerState(db);
  return state?.status === "ready" && state.version === CODEX_LEDGER_VERSION;
}
/** Whether queued work of these kinds exists (any kind without a list). */
export function codexLedgerWorkPending(db: Database, kinds?: readonly CodexLedgerWorkKind[]): boolean {
  if (!tableExists(db, "usage_ledger_dirty")) return false;
  return !!db.query(`SELECT 1 FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}'
    ${kinds ? `AND kind IN (${kinds.map(kind => `'${kind}'`).join(",")})` : ""} LIMIT 1`).get();
}
/** Queued work by kind (absent kinds are 0). */
export function codexLedgerWorkCounts(db: Database): Record<CodexLedgerWorkKind, number> {
  const counts: Record<CodexLedgerWorkKind, number> = { copy: 0, blocked: 0, rules: 0, identity: 0, day: 0, session: 0, activity: 0 };
  if (!tableExists(db, "usage_ledger_dirty")) return counts;
  for (const row of db.query(`SELECT kind,COUNT(*) n FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}' GROUP BY kind`)
    .all() as Array<{ kind: CodexLedgerWorkKind; n: number }>) counts[row.kind] = row.n;
  return counts;
}
/** The first queued values of a kind, in value order. */
export function codexLedgerWork(db: Database, kind: CodexLedgerWorkKind, limit: number): string[] {
  return (db.query(`SELECT value FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}' AND kind=? ORDER BY value LIMIT ?`)
    .all(kind, limit) as Array<{ value: string }>).map(row => row.value);
}
export function queueCodexLedgerWork(db: Database, kind: CodexLedgerWorkKind, values: Iterable<string>): void {
  const save = db.query(`INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) VALUES('${CODEX_LEDGER_PROVIDER}',?,?)`);
  for (const value of values) save.run(kind, value);
}
/** Removes one queued item; whether it was still there. */
export function takeCodexLedgerWork(db: Database, kind: CodexLedgerWorkKind, value: string): boolean {
  return db.query(`DELETE FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}' AND kind=? AND value=?`).run(kind, value).changes > 0;
}
/** A transcript's queue value. */
export const codexCopyWork = (home: string | null, path: string) => JSON.stringify([home, path]);
/** A queued price-rule scope and the last call id it has revalued. */
export type RulesWork = CodexLedgerBaseScope & { after: number };
export const rulesWork = (scope: CodexLedgerBaseScope, after: number) => JSON.stringify({ model: scope.model, basis: scope.basis,
  fromDay: scope.fromDay, untilDay: scope.untilDay, inputAbove: scope.inputAbove, inputUntil: scope.inputUntil, after });
export const scopeOf = ({ after: _after, ...scope }: RulesWork): CodexLedgerBaseScope => scope;
/** The bands the queued rule work follows (the last enqueued policy). */
export function codexLedgerQueuedBands(db: Database): LedgerBaseBand[] {
  return (db.query(`SELECT rates FROM usage_ledger_keys WHERE provider='${CODEX_LEDGER_PROVIDER}'`).all() as { rates: string }[])
    .map(row => JSON.parse(row.rates) as LedgerBaseBand);
}
/** The rule scopes still queued (their resume points dropped). */
export function codexLedgerQueuedRuleScopes(db: Database): CodexLedgerBaseScope[] {
  return codexLedgerWork(db, "rules", Number.MAX_SAFE_INTEGER).map(value => scopeOf(JSON.parse(value) as RulesWork));
}
