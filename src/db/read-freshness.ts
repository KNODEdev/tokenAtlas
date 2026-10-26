import type { Database } from "./sqlite";
import { codexLedgerPublished, codexLedgerWorkPending, readCodexLedgerState } from "./codex-ledger-state";
import { factTableRevision } from "./fact-day-revisions";
import { subscriptionAccountingAdapter, subscriptionAccountingAdapters, usageLedgerProviderIds } from "../server/subscription-accounting-adapters";
import { probeSourcesPending, probeSourcesPublished } from "./probe-sources";

/**
 * Freshness of the registers screens read (golden rules §9). Once a register has been published,
 * its committed rows stay readable while the background producers work: a reader answers from
 * them and the response says which registers have newer data in processing, up to which
 * revision the answer is consistent. Only a register that was never built answers "preparing".
 */
export const FRESHNESS_HEADER = "X-Data-Freshness";
/** `codex`, a shared-ledger provider's id, `window-usage` or `probe-sources`. */
export type ReadRegister = string;
/** The usage sums registers (everything but the readings' evidence), in header order. */
export const usageRegisters = (): ReadRegister[] => ["codex", ...usageLedgerProviderIds(), "window-usage"];
const readRegisters = (): ReadRegister[] => [...usageRegisters(), "probe-sources", "capacity_cycle_results"];
export interface RegisterFreshness { register: ReadRegister; published: boolean; pending: boolean; revision: string | null }

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * Codex facts newer than the published ledger: copies to (re)write, conversations or days to
 * resolve, or a sync whose facts revision the ledger has not reached. Price-rule work is not
 * here: a price change re-values its own scope, which answers "preparing" until it is done.
 */
export function codexLedgerFactsPending(db: Database): boolean {
  if (codexLedgerWorkPending(db, ["copy", "blocked", "identity", "day"])) return true;
  const head = readCodexLedgerState(db);
  if (!head || !tableExists(db, "vendor_sync_revisions")) return false;
  const facts = (db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as { revision: number } | null)?.revision ?? 0;
  return head.covered !== facts;
}

function usageLedgerFreshness(db: Database, provider: string): RegisterFreshness {
  const register = provider as ReadRegister;
  if (!tableExists(db, "usage_ledger_state")) return { register, published: false, pending: false, revision: null };
  const state = db.query("SELECT status,covered,published_revision FROM usage_ledger_state WHERE provider=?").get(provider) as
    { status: string; covered: number; published_revision: number } | null;
  if (!state || !state.published_revision) return { register, published: false, pending: false, revision: null };
  // Behind its source until every changed source day is reconciled (fact-day-revisions.ts).
  const table = subscriptionAccountingAdapter(provider).table;
  return { register, published: true, pending: state.status !== "ready" || state.covered !== factTableRevision(db, table),
    revision: String(state.published_revision) };
}

/** The freshness of one register, from its own state; cheap enough for every response. */
export function registerFreshness(db: Database, register: ReadRegister): RegisterFreshness {
  if (register === "capacity_cycle_results") {
    const present = tableExists(db, register);
    const pending = present && (!!db.query("SELECT 1 FROM capacity_cycle_result_dirty LIMIT 1").get()
      || !!db.query("SELECT 1 FROM capacity_cycle_results WHERE dirty=1 OR preparing=1 LIMIT 1").get());
    const clock = tableExists(db, "analysis_source_revisions")
      ? db.query("SELECT revision FROM analysis_source_revisions WHERE source='capacity_cycle_results' AND bucket='*'").get() as { revision: number } | null : null;
    return { register, published: present && clock !== null, pending, revision: clock ? String(clock.revision) : null };
  }
  if (register === "codex") {
    const published = codexLedgerPublished(db);
    return { register, published, pending: published && codexLedgerFactsPending(db), revision: published ? String(readCodexLedgerState(db)!.covered) : null };
  }
  if (register === "probe-sources") {
    // Limit readings by account: evidence of new or corrected readings still to be written.
    const published = probeSourcesPublished(db);
    const revision = published ? (db.query("SELECT value FROM meta WHERE key='current_v2_source_revision'").get() as { value: string } | null)?.value ?? null : null;
    return { register, published, pending: published && probeSourcesPending(db), revision };
  }
  if (register === "window-usage") {
    const present = tableExists(db, "window_usage");
    const pending = present && tableExists(db, "window_usage_dirty") && !!db.query("SELECT 1 FROM window_usage_dirty LIMIT 1").get();
    return { register, published: present, pending, revision: null };
  }
  return usageLedgerFreshness(db, register);
}

/**
 * The header value for the registers a response read: `current`, or `pending;` followed by each
 * register with newer data in processing and the revision its published rows are consistent with.
 */
export function freshnessHeader(db: Database, registers: readonly ReadRegister[]): string {
  const pending = registers.map(register => registerFreshness(db, register)).filter(state => state.published && state.pending);
  return pending.length ? `pending; ${pending.map(state => state.revision === null ? state.register : `${state.register}=${state.revision}`).join(", ")}` : "current";
}

/** The register a fact source a view declares belongs to: a provider's fact table or ledger clock is its ledger. */
function sourceRegister(source: string): ReadRegister | undefined {
  if (source === "events") return "codex";
  if (source === "probe_windows") return "probe-sources";
  if (source.startsWith("window-usage")) return "window-usage";
  if (source === "capacity_cycle_results") return source;
  return subscriptionAccountingAdapters().find(adapter => source === adapter.table || source === `usage-ledger:${adapter.id}`)?.id;
}
/** The registers a view reads, from the fact sources it declares. */
export function registersOfSources(sources: readonly string[]): ReadRegister[] {
  const registers = new Set(sources.map(sourceRegister).filter((register): register is ReadRegister => register !== undefined));
  return readRegisters().filter(register => registers.has(register));
}
