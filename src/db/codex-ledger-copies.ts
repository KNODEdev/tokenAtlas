import path from "node:path";
import { rolloutIdentity } from "../shared/codex-rollout-path";
import type { Database } from "./sqlite";
import { canonicalArchivePath, type CanonicalArchiveRoot } from "../config/archive-paths";
import { isAccountingDay } from "../server/codex-accounting-pricing";
import { codexConversationKey } from "./codex-ledger-canonical";
import { dimensionFields, valueCodexLedgerBand, type LedgerBaseBand } from "./codex-price-ledger";

/**
 * The per-call Codex ledger is written from `events`, one physical transcript (copy) at a time
 * or many at once: the same set-based statements serve a changed file and a fill from empty.
 */

/** Where a physical transcript sits in the archive: the copy's identity and conversation follow from it. */
export interface LedgerCopyAnchor { archiveId: string; sourceId: string; relativePath: string }

/** The archive binding and declared source give a physical archive file its location independent of the archive's path. */
export function ledgerCopyAnchorFromArchive(binding: CanonicalArchiveRoot, sourceId: string, physicalFile: string): LedgerCopyAnchor {
  if (binding.schema !== 1) throw new Error("Verified archive root binding is required");
  const logical = canonicalArchivePath(binding, physicalFile);
  const anchor = { archiveId: binding.archiveId, sourceId,
    relativePath: rolloutIdentity(path.relative(binding.originalLogicalRoot, logical).split(path.sep).join("/")) };
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(anchor.archiveId)) throw new Error("Verified archive identity is required");
  if (!sourceId || sourceId.length > 512 || sourceId.trim() !== sourceId || /[\\:\x00-\x1f\x7f]/.test(sourceId)
    || sourceId.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Verified declared source identity is required");
  const relative = anchor.relativePath;
  if (!relative || /[\\\0\r\n:]/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Canonical archive-relative file locator is required");
  }
  return anchor;
}

/** Registers the copy of one physical transcript, or moves an existing one to its current locator; returns its id. */
export function registerCodexCopy(db: Database, home: string | null, file: string, anchor: LedgerCopyAnchor): number {
  anchor = { ...anchor, relativePath: rolloutIdentity(anchor.relativePath) };
  file = rolloutIdentity(file);
  const identity = `${anchor.archiveId}|${anchor.sourceId}|${anchor.relativePath}`;
  return (db.query(`INSERT INTO codex_price_ledger_copies(identity,locator,home,path,source,relative_path,conversation) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(identity) DO UPDATE SET locator=excluded.locator,home=excluded.home,path=excluded.path,source=excluded.source,
      relative_path=excluded.relative_path,conversation=excluded.conversation RETURNING id`)
    .get(identity, JSON.stringify([home, file]), home, file, anchor.sourceId, anchor.relativePath,
      codexConversationKey(anchor.sourceId, anchor.relativePath)) as { id: number }).id;
}

const usable = (field: string) => `(typeof(${field})='integer' AND ${field}>=0 AND ${field}<=9007199254740991)`;
const integer = (field: string) => `CASE WHEN ${usable(field)} THEN ${field} ELSE 0 END`;
const counters = ["in_tok", "cached_in", "cache_write", "out_tok", "reasoning_out"] as const;
// A call's facts as written from `events`; `api_reason`/`credit_reason` start as the reason it has no value yet.
const facts = ["copy_id", "source_offset", "dim_id", "ts", "day", "instant_ms", "admitted", ...counters, "usage_status", "cache_write_status",
  "reported", "uncached", "cached", "writes", "output", "reasoning", "window_input", "window_cached", "window_output", "invalid_tokens",
  "common_reason", "api_reason", "credit_reason"] as const;
const values = ["api_band", "api_whole", "api_fraction_hi", "api_fraction_lo", "credit_band", "credit_whole", "credit_fraction_hi", "credit_fraction_lo"] as const;
// The response time is stored but never compared with the facts: a call whose only change is its time keeps its
// values, resolution and window sums; only its time and its days' timed sums follow (`retimed`).
const stored = [...facts, ...values, "identity", "resp_ms"] as const;

/** What a copy write changed: the calls written or removed and the days their sums depend on. */
export interface CodexCopyWrite { changed: number; days: Set<string>;
  /** Days of calls whose response time alone changed: only their timed sums are stale (`retimeCodexLedgerDays`). */
  retimed: Set<string>;
  /** Response identities (`r:`) of removed calls: their partners in other conversations are decided again without them. */
  removed: Set<string> }

/**
 * Writes the ledger rows of the given copies from their source events, inside the caller's
 * transaction. The calls are prepared and valued in a staging table and reach the ledger once,
 * with their values. Only calls whose stored facts differ from the source are written: an
 * unchanged call keeps its row and resolution, so an append touches only the new calls and their
 * days. An offset no longer in the source is removed. A new call of a conversation with one copy
 * gets its identity at once (response id, else conversation and offset); the others wait for the
 * conversation's resolution (codex-ledger-canonical.ts).
 */
export function writeCodexCopyEvents(db: Database, copyIds: readonly number[], bands: readonly LedgerBaseBand[]): CodexCopyWrite {
  if (!db.inTransaction) throw new Error("Ledger copy publication requires the producer transaction");
  const result: CodexCopyWrite = { changed: 0, days: new Set(), retimed: new Set(), removed: new Set() };
  if (!copyIds.length) return result;
  const ids = JSON.stringify(copyIds);
  const inCopies = "copy_id IN (SELECT value FROM json_each(?))";
  // A fill writes copies with no rows yet: their calls are appended without comparison.
  const fresh = !db.query(`SELECT 1 FROM codex_price_ledger_events WHERE ${inCopies} LIMIT 1`).get(ids);
  const columns = new Set((db.query("PRAGMA table_info(events)").all() as { name: string }[]).map(row => row.name));
  const field = (column: string) => columns.has(column) ? `e."${column}"` : "NULL";
  // The identity is the resolver's once a row exists; a changed response id reaches it through the conversation queue.
  // A basis reason before valuation follows from the compared common reason and cache writes, and values from the facts.
  const compared = facts.filter(column => column !== "copy_id" && column !== "source_offset" && column !== "api_reason" && column !== "credit_reason");
  const differs = (left: string, right: string) =>
    `(${compared.map(column => `${left}.${column}`).join(",")}) IS NOT (${compared.map(column => `${right}.${column}`).join(",")})`;
  const temporary = ["codex_ledger_batch", "codex_ledger_source", "codex_ledger_times", "codex_ledger_incoming"];
  const dropTemporary = () => db.exec(temporary.map(name => `DROP TABLE IF EXISTS temp.${name}`).join(";"));
  dropTemporary();
  try {
    db.exec("CREATE TEMP TABLE codex_ledger_batch(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source TEXT,conversation TEXT,single INTEGER NOT NULL)");
    db.query(`INSERT INTO temp.codex_ledger_batch SELECT c.id,c.home,c.path,c.source,c.conversation,
        (SELECT COUNT(*) FROM codex_price_ledger_copies o WHERE o.conversation=c.conversation)=1
      FROM codex_price_ledger_copies c WHERE c.id IN (SELECT value FROM json_each(?))`).run(ids);
    // The batch's calls are read from `events` once, with what every later statement needs: their facts,
    // their metadata (a column `events` lacks is NULL) and the key of their dimension.
    const read = ["source_offset", "ts", ...counters, "usage_status", "cache_write_status", "response_id", "resp_ms", ...dimensionFields.filter(name => !counters.includes(name as never))];
    db.exec(`CREATE TEMP TABLE codex_ledger_source AS SELECT c.id AS copy_id,c.single AS single,c.conversation AS conversation,
        ${read.map(name => `${field(name)} AS ${name}`).join(",")},json_array(c.source,c.home,${dimensionFields.map(field).join(",")}) AS dim_key
      FROM events e JOIN temp.codex_ledger_batch c ON e.home IS c.home AND e.path=c.path`);
    // Instants as the readers parse them (Date.parse), one per distinct timestamp text.
    db.exec("CREATE TEMP TABLE codex_ledger_times(ts TEXT PRIMARY KEY,admitted INTEGER NOT NULL,valid INTEGER NOT NULL,instant_ms INTEGER) STRICT");
    {
      using insert = db.prepare("INSERT INTO temp.codex_ledger_times VALUES(?,?,?,?)");
      for (const { ts } of db.query("SELECT DISTINCT ts FROM temp.codex_ledger_source").all() as { ts: unknown }[]) {
        if (typeof ts !== "string") throw new Error("Non-text event timestamp cannot be silently coerced");
        const admitted = isAccountingDay(ts.slice(0, 10)), instant = Date.parse(ts);
        insert.run(ts, admitted ? 1 : 0, admitted && Number.isFinite(instant) ? 1 : 0, Number.isFinite(instant) ? instant : null);
      }
    }
    db.exec(`INSERT INTO codex_price_ledger_dims(key,source,home,${dimensionFields.join(",")})
      SELECT DISTINCT s.dim_key,c.source,c.home,${dimensionFields.map(name => `s.${name}`).join(",")}
      FROM temp.codex_ledger_source s JOIN temp.codex_ledger_batch c ON c.id=s.copy_id WHERE true ON CONFLICT(key) DO NOTHING`);
    // The batch's copies drive every join with the ledger (CROSS JOIN keeps them outermost): a write costs its
    // copies' calls, not the size of the ledger. A fill's copies have no calls yet.
    const vanished = fresh ? [] : db.query(`SELECT l.id,l.day,l.identity FROM temp.codex_ledger_batch c CROSS JOIN codex_price_ledger_events l ON l.copy_id=c.id
      WHERE NOT EXISTS(SELECT 1 FROM temp.codex_ledger_source s WHERE s.copy_id=c.id AND s.source_offset=l.source_offset)`).all() as { id: number; day: string; identity: string | null }[];
    if (vanished.length) {
      const gone = vanished.map(row => row.id);
      db.query("DELETE FROM codex_price_ledger_events WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
      for (const row of vanished) { result.days.add(row.day); if (row.identity?.startsWith("r:")) result.removed.add(row.identity); }
      result.changed += vanished.length;
    }
    const validReported = `${usable("s.in_tok")} AND ${usable("s.out_tok")} AND s.in_tok+s.out_tok<=9007199254740991`;
    const invalidTokens = `${["in_tok", "cached_in", "cache_write", "out_tok"].map(key => `NOT ${usable(`s.${key}`)}`).join(" OR ")}
      OR s.cached_in+s.cache_write>s.in_tok OR s.in_tok+s.out_tok>9007199254740991 OR s.usage_status='invalid' OR s.cache_write_status='invalid'`;
    const common = `CASE WHEN s.model='codex-auto-review' THEN 'missing_rate' WHEN ${invalidTokens} THEN 'invalid_tokens'
      WHEN s.usage_status IN ('unknown','incomplete') THEN 'incomplete_usage' WHEN t.valid=0 THEN 'invalid_timestamp' END`;
    const identity = `CASE WHEN s.single THEN CASE WHEN s.response_id IS NOT NULL THEN 'r:'||s.response_id
      ELSE 'o:'||s.conversation||'|'||s.source_offset END END`;
    const window = ["in_tok", "cached_in", "out_tok"].map(key => `CASE WHEN ${["in_tok", "cached_in", "out_tok"].map(k => usable(`s.${k}`)).join(" AND ")}
      AND s.cached_in<=s.in_tok THEN s.${key} ELSE 0 END`);
    const expressions: Record<string, string> = {
      copy_id: "s.copy_id", source_offset: "s.source_offset", dim_id: "d.id", ts: "s.ts", day: "substr(s.ts,1,10)", instant_ms: "t.instant_ms",
      admitted: "t.admitted", ...Object.fromEntries(counters.map(name => [name, `s.${name}`])), usage_status: "s.usage_status",
      cache_write_status: "s.cache_write_status", reported: `CASE WHEN ${validReported} THEN s.in_tok+s.out_tok ELSE 0 END`,
      uncached: `MAX(0,(${integer("s.in_tok")})-(${integer("s.cached_in")})-(${integer("s.cache_write")}))`,
      cached: integer("s.cached_in"), writes: integer("s.cache_write"), output: integer("s.out_tok"), reasoning: integer("s.reasoning_out"),
      window_input: window[0]!, window_cached: window[1]!, window_output: window[2]!,
      invalid_tokens: `CASE WHEN s.usage_status='invalid' OR s.cache_write_status='invalid' OR (${integer("s.in_tok")})<(${integer("s.cached_in")})+(${integer("s.cache_write")})
        OR NOT (${validReported}) THEN 1 ELSE 0 END`,
      common_reason: common, identity, resp_ms: "CASE WHEN typeof(s.resp_ms)='integer' AND s.resp_ms>0 THEN s.resp_ms END" };
    // The common reason is computed once (OFFSET keeps SQLite from substituting it into both basis reasons).
    const staged = stored.filter(name => name !== "api_reason" && name !== "credit_reason" && !(values as readonly string[]).includes(name));
    const outer: Record<string, string> = { api_reason: "COALESCE(common_reason,'missing_rate')",
      credit_reason: "COALESCE(common_reason,CASE WHEN cache_write>0 THEN 'cache_write_semantics_unknown' ELSE 'missing_rate' END)",
      ...Object.fromEntries(values.map(name => [name, name.endsWith("_band") ? "0" : "NULL"])) };
    db.exec(`CREATE TEMP TABLE codex_ledger_incoming AS SELECT ${stored.map(name => `${outer[name] ?? name} AS ${name}`).join(",")}
      FROM (SELECT ${staged.map(name => `${expressions[name]} AS ${name}`).join(",")}
        FROM temp.codex_ledger_source s JOIN codex_price_ledger_dims d ON d.key=s.dim_key JOIN temp.codex_ledger_times t ON t.ts=s.ts LIMIT -1 OFFSET 0)`);
    valueStagedCalls(db, bands);
    if (fresh) {
      result.changed += db.query(`INSERT INTO codex_price_ledger_events(${stored.join(",")}) SELECT ${stored.join(",")} FROM temp.codex_ledger_incoming`).run().changes;
      for (const row of db.query("SELECT DISTINCT day FROM temp.codex_ledger_incoming").all() as { day: string }[]) result.days.add(row.day);
    } else {
      for (const row of db.query(`SELECT DISTINCT l.day FROM temp.codex_ledger_incoming i CROSS JOIN codex_price_ledger_events l
        ON l.copy_id=i.copy_id AND l.source_offset=i.source_offset WHERE ${differs("l", "i")}`).all() as { day: string }[]) result.days.add(row.day);
      const upsert = db.query(`INSERT INTO codex_price_ledger_events(${stored.join(",")}) SELECT ${stored.join(",")} FROM temp.codex_ledger_incoming
        WHERE true ON CONFLICT(copy_id,source_offset) DO UPDATE SET
          ${[...facts, ...values].filter(column => column !== "copy_id" && column !== "source_offset").map(column => `${column}=excluded.${column}`).join(",")},
          identity=COALESCE(excluded.identity,codex_price_ledger_events.identity),resp_ms=excluded.resp_ms
        WHERE ${differs("codex_price_ledger_events", "excluded")} RETURNING id,day`);
      for (const row of upsert.all() as { id: number; day: string }[]) { result.changed++; result.days.add(row.day); }
      // A call whose facts are unchanged and whose time differs: its time only.
      for (const row of db.query(`UPDATE codex_price_ledger_events AS l SET resp_ms=i.resp_ms FROM temp.codex_ledger_incoming i
        WHERE l.copy_id=i.copy_id AND l.source_offset=i.source_offset AND l.resp_ms IS NOT i.resp_ms AND NOT ${differs("l", "i")}
        RETURNING day`).all() as { day: string }[]) { result.changed++; if (!result.days.has(row.day)) result.retimed.add(row.day); }
    }
  } finally { dropTemporary(); }
  return result;
}

/** Values the staged calls, by model: each band values only the calls of its model, on the dates it covers. */
function valueStagedCalls(db: Database, bands: readonly LedgerBaseBand[]): void {
  const byModel = new Map<string | null, { rows: number[]; from: string; until: string }>();
  for (const call of db.query(`SELECT i.rowid row,d.model,i.day FROM temp.codex_ledger_incoming i
    JOIN codex_price_ledger_dims d ON d.id=i.dim_id`).all() as { row: number; model: string | null; day: string }[]) {
    const group = byModel.get(call.model);
    if (!group) byModel.set(call.model, { rows: [call.row], from: call.day, until: call.day });
    else { group.rows.push(call.row); if (call.day < group.from) group.from = call.day; if (call.day > group.until) group.until = call.day; }
  }
  for (const band of bands) {
    const group = byModel.get(band.model);
    if (group && group.until >= band.validFrom && (!band.validUntil || group.from < band.validUntil))
      valueCodexLedgerBand(db, band, group.rows, "temp.codex_ledger_incoming");
  }
}
