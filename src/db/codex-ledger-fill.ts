import type { Database } from "./sqlite";
import { regapCodexLedgerCopies, type LedgerBaseBand } from "./codex-price-ledger";
import { registerCodexCopy, writeCodexCopyEvents, type LedgerCopyAnchor } from "./codex-ledger-copies";
import { BATCH_MS } from "./batches";
import { CODEX_LEDGER_PROVIDER, CODEX_LEDGER_VERSION, codexCopyWork, queueCodexLedgerWork, readCodexLedgerState } from "./codex-ledger-state";

/**
 * Fill of an empty Codex ledger from `events` (a first import or a ledger the schema cleared).
 * Every call is written set-based, many copies per transaction, valued before it reaches the
 * ledger; the few conversations with several copies and the day sums then drain through the
 * producer's ordinary queue. The ledger keeps its indexes: building one over a whole history is a
 * single statement of several seconds, and no step may hold the writer that long. Phases, kept
 * with their cursor in the ledger state's backfill bookmark so a stopped worker resumes where it was:
 *
 * - `copies`: every physical transcript with calls gets its copy (or a blocked queue item when it
 *   has no archive binding), in (home, path) order;
 * - `events`: copies in id order, their calls written and valued;
 * - `canonical`: in id order, a call whose identity no other call has is canonical; the rest
 *   queue their conversation, and every day with calls queues its sums;
 * - `gaps`: copies in id order, their canonical calls' activity gaps set-based (window LAG); the
 *   queued day sums then include them. Conversations resolved later queue their copies again.
 *
 * Each step is one transaction sized to stay near BATCH_MS (growing at most twofold, so a run of
 * larger files cannot overshoot far); the caller decides how many steps fit its turn.
 */
export type CodexLedgerFillPhase = "copies" | "events" | "canonical" | "gaps";
export interface CodexLedgerFillOptions {
  bands: readonly LedgerBaseBand[];
  anchorOf(home: string | null, path: string): LedgerCopyAnchor | null;
}
interface FillState { phase: CodexLedgerFillPhase; cursor: string | null }
/** How far a fill is: its phase and what it has done of what it knows (null while unknown). */
export interface CodexLedgerFillProgress { phase: CodexLedgerFillPhase; done: number; total: number | null }

export function codexLedgerFillState(db: Database): FillState | null {
  const state = readCodexLedgerState(db);
  return state?.phase === "backfill" ? JSON.parse(state.bookmark) as FillState : null;
}

/**
 * Files registered (their number is known only at the end), files valued of all, calls resolved
 * up to the highest call id. A few indexed reads; for the progress register.
 */
export function codexLedgerFillProgress(db: Database): CodexLedgerFillProgress | null {
  const state = codexLedgerFillState(db);
  if (!state) return null;
  const count = (sql: string, ...params: number[]) => (db.query(sql).get(...params) as { n: number | null }).n ?? 0;
  switch (state.phase) {
    case "copies": return { phase: "copies", done: count("SELECT COUNT(*) n FROM codex_price_ledger_copies"), total: null };
    case "events": return { phase: "events", done: count("SELECT COUNT(*) n FROM codex_price_ledger_copies WHERE id<=?", Number(state.cursor)),
      total: count("SELECT COUNT(*) n FROM codex_price_ledger_copies") };
    case "canonical": return { phase: "canonical", done: Number(state.cursor), total: count("SELECT MAX(id) n FROM codex_price_ledger_events") };
    case "gaps": return { phase: "gaps", done: count("SELECT COUNT(*) n FROM codex_price_ledger_copies WHERE id<=?", Number(state.cursor)),
      total: count("SELECT COUNT(*) n FROM codex_price_ledger_copies") };
  }
}

/** Starts a fill when the ledger has no state yet; true when one is running. */
export function beginCodexLedgerFill(db: Database, factsRevision: number, rulesRevision: string): boolean {
  if (codexLedgerFillState(db)) return true;
  if (readCodexLedgerState(db)) return false;
  db.transaction(() => {
    db.query(`INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest)
      VALUES('${CODEX_LEDGER_PROVIDER}',?,'backfill','pending',?,?,?)`)
      .run(CODEX_LEDGER_VERSION, factsRevision, JSON.stringify({ phase: "copies", cursor: null } satisfies FillState), rulesRevision);
    if (db.query("SELECT 1 FROM codex_price_ledger_events LIMIT 1").get()) throw new Error("A Codex ledger fill requires an empty ledger");
    // The fill writes every file whose calls are in `events` now; their queued copies would rewrite them one by
    // one. A file published after this point is queued again, and blocked files are found again by the fill.
    db.exec(`DELETE FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}' AND kind IN ('copy','blocked')`);
  }).immediate();
  return true;
}

/** The next fill phase and cursor; null ends the fill (the producer publishes once its queue is drained). */
const save = (db: Database, phase: CodexLedgerFillPhase | null, cursor: string | null) =>
  db.query(`UPDATE usage_ledger_state SET phase=?,bookmark=? WHERE provider='${CODEX_LEDGER_PROVIDER}'`)
    .run(phase ? "backfill" : "reconcile", phase ? JSON.stringify({ phase, cursor } satisfies FillState) : "");

/** At most this many files are considered for one step of the `events` phase. */
const EVENTS_STEP_FILES = 256;
/** Sizes of the next step per phase, adapted to stay near BATCH_MS; kept per worker, not durable. */
const sizes = new WeakMap<Database, Map<CodexLedgerFillPhase, number>>();
/** `work` takes up to `size` units and returns how many it took; the next size follows that pace. */
function sized(db: Database, phase: CodexLedgerFillPhase, initial: number, work: (size: number) => number): void {
  const known = sizes.get(db) ?? new Map<CodexLedgerFillPhase, number>();
  sizes.set(db, known);
  const size = known.get(phase) ?? initial;
  const started = performance.now();
  const done = Math.max(1, work(size));
  const elapsed = performance.now() - started;
  known.set(phase, Math.max(1, Math.min(Math.max(size, done) * 2, Math.floor(done * BATCH_MS / Math.max(elapsed, 1)))));
}

/** One fill step in its own transaction; returns what it handled (files or calls), 0 once the fill has ended. */
export function stepCodexLedgerFill(db: Database, options: CodexLedgerFillOptions): number {
  const state = codexLedgerFillState(db);
  if (!state) return 0;
  let handled = 0;
  switch (state.phase) {
    case "copies": sized(db, "copies", 256, size => db.transaction(() => {
      // Files in (home, path) order; a home-less fixture file comes first, in path order.
      const after = state.cursor ? JSON.parse(state.cursor) as [string | null, string] : null;
      const files = (after === null || after[0] === null ? db.query(`SELECT DISTINCT home,path FROM events WHERE home IS NULL AND path IS NOT NULL
          ${after ? "AND path>?" : ""} ORDER BY path LIMIT ?`).all(...(after ? [after[1]] : []), size) : []) as { home: string | null; path: string }[];
      // A row-value bound keeps each step a range of the (home, path, offset) index.
      if (files.length < size) files.push(...db.query(`SELECT DISTINCT home,path FROM events WHERE home IS NOT NULL AND path IS NOT NULL
        ${after?.[0] != null ? "AND (home,path)>(?,?)" : ""} ORDER BY home,path LIMIT ?`)
        .all(...(after?.[0] != null ? [after[0], after[1]] : []), size - files.length) as { home: string; path: string }[]);
      for (const file of files) {
        const anchor = options.anchorOf(file.home, file.path);
        if (anchor) registerCodexCopy(db, file.home, file.path, anchor);
        else queueCodexLedgerWork(db, "blocked", [codexCopyWork(file.home, file.path)]);
      }
      handled = files.length;
      if (files.length < size) save(db, "events", "0");
      else save(db, "copies", JSON.stringify([files.at(-1)!.home, files.at(-1)!.path]));
      return files.length;
    }).immediate()); break;
    // A file holds from one call to tens of thousands: a step takes files up to a number of calls.
    case "events": sized(db, "events", 2000, size => db.transaction(() => {
      const candidates = db.query(`SELECT c.id, (SELECT COUNT(*) FROM events e WHERE e.home IS c.home AND e.path=c.path) calls
        FROM codex_price_ledger_copies c WHERE c.id>? ORDER BY c.id LIMIT ?`).all(Number(state.cursor), EVENTS_STEP_FILES) as { id: number; calls: number }[];
      const ids: number[] = [];
      let calls = 0;
      for (const candidate of candidates) {
        if (ids.length && calls + candidate.calls > size) break;
        ids.push(candidate.id); calls += candidate.calls;
      }
      handled = writeCodexCopyEvents(db, ids, options.bands).changed;
      if (ids.length === candidates.length && candidates.length < EVENTS_STEP_FILES) save(db, "canonical", "0");
      else save(db, "events", String(ids.at(-1)!));
      return calls;
    }).immediate()); break;
    case "canonical": sized(db, "canonical", 4096, size => db.transaction(() => {
      const from = Number(state.cursor);
      const last = (db.query("SELECT MAX(id) id FROM (SELECT id FROM codex_price_ledger_events WHERE id>? ORDER BY id LIMIT ?)").get(from, size) as { id: number | null }).id;
      if (last === null) { save(db, "gaps", "0"); return 0; }
      // A fork's calls may replay its parent's: its conversation is resolved like one with several copies.
      const forked = (db.query("PRAGMA table_info(codex_file_evidence)").all() as { name: string }[]).some(column => column.name === "provider_forked_from_id")
        ? `AND e.copy_id NOT IN (SELECT c.id FROM codex_price_ledger_copies c JOIN codex_file_evidence f ON f.home=c.home AND f.path=c.path
          WHERE f.provider_forked_from_id IS NOT NULL)` : "";
      db.query(`UPDATE codex_price_ledger_events AS e SET copy_state='canonical' WHERE e.id>? AND e.id<=? AND e.copy_state='pending'
        AND e.identity IS NOT NULL AND NOT EXISTS(SELECT 1 FROM codex_price_ledger_events o WHERE o.identity=e.identity AND o.id<>e.id) ${forked}`).run(from, last);
      db.query(`INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT '${CODEX_LEDGER_PROVIDER}','identity',c.conversation
        FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
        WHERE e.id>? AND e.id<=? AND e.copy_state='pending' AND c.conversation IS NOT NULL`).run(from, last);
      db.query(`INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT '${CODEX_LEDGER_PROVIDER}','day',day FROM codex_price_ledger_events
        WHERE id>? AND id<=? AND admitted=1`).run(from, last);
      handled = last - from;
      save(db, "canonical", String(last));
      return handled;
    }).immediate()); break;
    case "gaps": sized(db, "gaps", 20_000, size => db.transaction(() => {
      const candidates = db.query(`SELECT c.id, (SELECT COUNT(*) FROM codex_price_ledger_events e WHERE e.copy_id=c.id) calls
        FROM codex_price_ledger_copies c WHERE c.id>? ORDER BY c.id LIMIT ?`).all(Number(state.cursor), EVENTS_STEP_FILES) as { id: number; calls: number }[];
      const ids: number[] = [];
      let calls = 0;
      for (const candidate of candidates) {
        if (ids.length && calls + candidate.calls > size) break;
        ids.push(candidate.id); calls += candidate.calls;
      }
      regapCodexLedgerCopies(db, ids);
      handled = Math.max(ids.length, 1);
      if (ids.length === candidates.length && candidates.length < EVENTS_STEP_FILES) save(db, null, null);
      else save(db, "gaps", String(ids.at(-1)!));
      return calls;
    }).immediate()); break;
  }
  return handled;
}
