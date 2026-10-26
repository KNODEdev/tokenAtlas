import type { Database } from "./sqlite";
import { CODEX_LEDGER_REPLAYS_INDEX_SQL, CodexLedgerNotReady } from "./codex-price-ledger";
import { codexLedgerWorkPending, queueCodexLedgerWork, readCodexLedgerState } from "./codex-ledger-state";
import { markLimitWindowFilesDirty } from "./limit-windows";

/**
 * Build-time duplicate resolution of the Codex ledger (docs/u3.0-codex-ledger-design-2026-10-04.md §2).
 *
 * Every ledger event gets an identity and a copy state. Identity is the provider response id when the
 * source recorded one (`r:`), otherwise the conversation (source + rollout file name) and offset (`o:`).
 * Offsets are a common axis only when every physical copy of one conversation is a prefix of the
 * longest; a divergent group matches calls by fingerprint and occurrence (`f:`) and leaves a call
 * without a partner in another copy as an explicit `conflict`. Agreeing copies keep the least source
 * key as `canonical`, the rest are `duplicate`; disagreeing fingerprints are a `conflict`. Only
 * canonical events enter the sums, so readers never choose copies.
 *
 * The unit of work is one conversation. A response id can appear in another conversation, so its
 * other members are resolved together and their days are reported too.
 *
 * A forked thread (its session header names `forked_from_id`) may open with a replay of its parent's
 * calls: Codex alphas up to 0.149 copied the parent's token counts, without response ids, stamped at
 * the fork time. Those calls are the parent's, already in the ledger under the parent's conversation;
 * they get the identity `c:<parent conversation>|<parent offset>` and are always `duplicate`
 * (docs/verification/codex-fork-copies-2026-10-06.md). A fork's resolution therefore depends on its
 * parent's calls: a changed parent queues its forks too. The replayed records also carry the parent's
 * old rate-limit readings: a reading of a replayed record is not evidence (codexReadingEvidenceSql).
 */
export type CodexCopyState = "pending" | "canonical" | "duplicate" | "conflict";
export type CodexConversationKind = "single" | "identical" | "prefix" | "divergent";

/** Lower-cased source and rollout file name; the archive's directory (sessions/, archived_sessions/) is not part of it. */
export function codexConversationKey(source: string | null, relativePath: string): string {
  const name = relativePath.replaceAll("\\", "/").split("/").at(-1) ?? relativePath;
  return `${(source ?? "").toLowerCase()}|${name.toLowerCase()}`;
}
/** The same key in SQL, for migrations over stored copies. */
export const CODEX_CONVERSATION_KEY_SQL = (source: string, relativePath: string) =>
  `lower(COALESCE(${source},''))||'|'||lower(substr(${relativePath},length(rtrim(${relativePath},replace(${relativePath},'/','')))+1))`;
export const codexSourceKey = (relativePath: string, offset: number | bigint) => `${relativePath}#${String(offset).padStart(20, "0")}`;

/** Accounting fields that change sums or window qualification; presentation metadata stays out (note §2 point 4). */
// The instant, not the timestamp text: one call written with two zone offsets is still one call.
const FINGERPRINT_SQL = `json_array(COALESCE(e.instant_ms,e.ts),d.model,d.speed,d.service_tier,e.in_tok,e.cached_in,e.cache_write,e.out_tok,e.reasoning_out,
  e.usage_status,e.cache_write_status,d.billing_mode,d.meter_reset)`;

interface Member {
  id: number; copy_id: number; source_offset: number; day: string; identity: string | null; copy_state: CodexCopyState;
  admitted: number; fingerprint: string; source_key: string; response_id: string | null; tokens: string; instant_ms: number | null;
}
/** The five counters a replayed call shares with its original (its time, model and settings are the fork's). */
const TOKENS_SQL = "json_array(e.in_tok,e.cached_in,e.cache_write,e.out_tok,e.reasoning_out)";
/** `copies`: the copies whose canonical calls changed, whose activity gaps follow. */
export interface CodexResolution { events: number; changed: number; days: Set<string>; copies: Set<number>; kind: CodexConversationKind }

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) throw new Error("Invalid ledger source schema");
  return `"${value}"`;
}
function members(db: Database, where: string, params: ReadonlyArray<string | number>, source: string): Member[] {
  // Provider response ids live in the source facts; a ledger event whose source row disappeared keeps its resolved identity.
  // A source row at the event's offset is authoritative even without a response id: a rewritten file can move another
  // call to the offset (an adopted Codex re-encoding shifts every offset), and the earlier call's `r:` is not its own.
  // Older source schemas without the column carry no response ids.
  const hasResponse = (db.query(`PRAGMA ${source}.table_info(events)`).all() as { name: string }[]).some(column => column.name === "response_id");
  return db.query(`SELECT e.id,e.copy_id,e.source_offset,e.day,e.identity,e.copy_state,e.admitted,${FINGERPRINT_SQL} fingerprint,
      ${TOKENS_SQL} tokens,e.instant_ms,
      COALESCE(c.relative_path,c.path,'')||'#'||printf('%020d',e.source_offset) source_key,
      CASE WHEN ${hasResponse ? "ev.source_offset IS NOT NULL" : "false"} THEN ${hasResponse ? "ev.response_id" : "NULL"}
        WHEN e.identity LIKE 'r:%' THEN substr(e.identity,3) END response_id
    FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id JOIN codex_price_ledger_dims d ON d.id=e.dim_id
    ${hasResponse ? `LEFT JOIN ${source}.events ev ON ev.home=c.home AND ev.path=c.path AND ev.source_offset=e.source_offset` : ""}
    WHERE ${where} ORDER BY e.copy_id,e.source_offset`).all(...params) as Member[];
}

function hasForkColumn(db: Database, source: string): boolean {
  return (db.query(`PRAGMA ${source}.table_info(codex_file_evidence)`).all() as { name: string }[])
    .some(column => column.name === "provider_forked_from_id");
}
/** The thread id a rollout file name ends with (`…-<id>.jsonl`, or `…_<id>.jsonl` for a child thread). */
const THREAD_OF_CONVERSATION = /[-_]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
interface ParentCall { source_offset: number; tokens: string; instant_ms: number | null }

/**
 * The calls a forked conversation's copies replay from its parent: member id → `c:` identity. A replay is the
 * fork's leading run of calls equal, in order, to a run of the parent's calls (it may start after the parent's
 * last compaction): the same five counters, no response id of its own and written no earlier than the original.
 * The parent is the conversation of the same source whose file name ends with the fork's `forked_from_id`; its
 * longest physical copy is compared. Without the parent's calls nothing is a replay and the fork counts as written.
 */
function replayedCalls(db: Database, conversation: string, byCopy: Map<number, Member[]>, source: string): Map<number, string> {
  const found = new Map<number, string>();
  if (!hasForkColumn(db, source)) return found;
  const forks = db.query(`SELECT c.id,f.provider_forked_from_id parent FROM codex_price_ledger_copies c
    JOIN ${source}.codex_file_evidence f ON f.home=c.home AND f.path=c.path
    WHERE c.conversation=? AND f.provider_forked_from_id IS NOT NULL`).all(conversation) as { id: number; parent: string }[];
  if (!forks.length) return found;
  const prefix = conversation.slice(0, conversation.indexOf("|") + 1);
  const parentCopy = db.query(`SELECT c.id,c.conversation FROM codex_price_ledger_copies c
    WHERE substr(c.conversation,1,length(?1))=?1 AND c.conversation<>?2 AND (substr(c.conversation,-length(?3))=?3 OR substr(c.conversation,-length(?4))=?4)
    ORDER BY (SELECT COUNT(*) FROM codex_price_ledger_events e WHERE e.copy_id=c.id) DESC,c.id LIMIT 1`);
  const parentCalls = db.query(`SELECT e.source_offset,${TOKENS_SQL} tokens,e.instant_ms FROM codex_price_ledger_events e
    WHERE e.copy_id=? ORDER BY e.source_offset`);
  const isReplay = (copy: Member, original: ParentCall) => !copy.response_id && copy.tokens === original.tokens
    && copy.instant_ms !== null && original.instant_ms !== null && copy.instant_ms >= original.instant_ms;
  for (const fork of forks) {
    const list = byCopy.get(fork.id);
    if (!list?.length) continue;
    const thread = fork.parent.toLowerCase();
    const parent = parentCopy.get(prefix, conversation, `-${thread}.jsonl`, `_${thread}.jsonl`) as { id: number; conversation: string } | null;
    if (!parent) continue;
    const calls = parentCalls.all(parent.id) as ParentCall[];
    let length = 0, start = 0;
    for (let at = 0; at < calls.length; at++) {
      let run = 0;
      while (run < list.length && at + run < calls.length && isReplay(list[run]!, calls[at + run]!)) run++;
      if (run > length) { length = run; start = at; }
    }
    for (let index = 0; index < length; index++)
      found.set(list[index]!.id, `c:${parent.conversation}|${calls[start + index]!.source_offset}`);
  }
  return found;
}

/**
 * Resolve one conversation and every other member of its response identities. Writes only changed rows
 * and returns the days whose canonical set changed (the caller rebuilds their sums).
 */
export function resolveCodexConversation(db: Database, conversation: string, sourceSchema = "main"): CodexResolution {
  if (!db.inTransaction) throw new Error("Copy resolution requires the producer transaction");
  const source = identifier(sourceSchema);
  const own = members(db, "c.conversation=?", [conversation], source);
  const byCopy = new Map<number, Member[]>();
  for (const member of own) (byCopy.get(member.copy_id) ?? byCopy.set(member.copy_id, []).get(member.copy_id)!).push(member);
  const sequences = [...byCopy.values()].map(list => list.map(member => `${member.source_offset}|${member.fingerprint}`));
  const longest = sequences.reduce<string[]>((a, b) => (b.length > a.length ? b : a), []);
  const kind: CodexConversationKind = byCopy.size < 2 ? "single"
    : sequences.every(q => q.length === longest.length && q.every((x, i) => x === longest[i])) ? "identical"
    : sequences.every(q => q.every((x, i) => x === longest[i])) ? "prefix" : "divergent";
  const next = new Map<number, string>();
  for (const list of byCopy.values()) {
    const occurrence = new Map<string, number>();
    for (const member of list) {
      if (member.response_id) { next.set(member.id, `r:${member.response_id}`); continue; }
      if (kind !== "divergent") { next.set(member.id, `o:${conversation}|${member.source_offset}`); continue; }
      const n = (occurrence.get(member.fingerprint) ?? 0) + 1;
      occurrence.set(member.fingerprint, n);
      next.set(member.id, `f:${conversation}|${member.fingerprint}|${n}`);
    }
  }
  for (const [id, identity] of replayedCalls(db, conversation, byCopy, source)) next.set(id, identity);
  // Other conversations' events sharing a response identity are decided with these, also those sharing one an own
  // event held until now: a call that left this conversation leaves its partners to be decided without it.
  const responses = [...new Set([...next.values(), ...own.map(member => member.identity ?? "")].filter(identity => identity.startsWith("r:")))];
  const outside: Member[] = [];
  for (let start = 0; start < responses.length; start += 500) {
    const chunk = responses.slice(start, start + 500);
    outside.push(...members(db, `e.identity IN (${chunk.map(() => "?").join(",")}) AND c.conversation IS NOT ?`, [...chunk, conversation], source));
  }
  for (const member of outside) next.set(member.id, member.identity!);
  const groups = new Map<string, Member[]>();
  for (const member of [...own, ...outside]) {
    const identity = next.get(member.id)!;
    (groups.get(identity) ?? groups.set(identity, []).get(identity)!).push(member);
  }
  const state = new Map<number, CodexCopyState>();
  for (const [identity, list] of groups) {
    // A replayed parent call is counted in its parent's conversation, never here.
    if (identity.startsWith("c:")) { for (const member of list) state.set(member.id, "duplicate"); continue; }
    const conflict = new Set(list.map(member => member.fingerprint)).size > 1
      // A divergent group's call must have a partner in every copy, otherwise it is not counted.
      || identity.startsWith("f:") && new Set(list.map(member => member.copy_id)).size < byCopy.size;
    if (conflict) { for (const member of list) state.set(member.id, "conflict"); continue; }
    const least = list.reduce((a, b) => (b.source_key < a.source_key ? b : a));
    for (const member of list) state.set(member.id, member === least ? "canonical" : "duplicate");
  }
  const days = new Set<string>(), copies = new Set<number>();
  let changed = 0;
  const update = db.query("UPDATE codex_price_ledger_events SET identity=?,copy_state=? WHERE id=?");
  const replaysMoved = new Set<number>();
  for (const member of [...own, ...outside]) {
    const identity = next.get(member.id)!, copyState = state.get(member.id)!;
    if (member.identity === identity && member.copy_state === copyState) continue;
    update.run(identity, copyState, member.id);
    changed++;
    if (member.copy_state === "canonical" || copyState === "canonical") {
      copies.add(member.copy_id);
      if (member.admitted) days.add(member.day);
    }
    if (identity.startsWith("c:") !== (member.identity?.startsWith("c:") ?? false)) replaysMoved.add(member.copy_id);
  }
  // Which of the file's readings are evidence moved with its replayed calls: its limit windows are derived again.
  if (replaysMoved.size) markLimitWindowFilesDirty(db, db.query(`SELECT home,path FROM codex_price_ledger_copies
    WHERE id IN (SELECT value FROM json_each(?)) AND home IS NOT NULL AND path IS NOT NULL`)
    .all(JSON.stringify([...replaysMoved])) as { home: string; path: string }[]);
  return { events: own.length + outside.length, changed, days, copies, kind };
}

/**
 * Queue of conversations to resolve and days whose sums need rebuilding; the producer drains both. A conversation
 * comes with the forks of its thread in the same source: which of their calls are replays depends on its calls.
 */
export function markCodexConversationsDirty(db: Database, conversations: Iterable<string>): void {
  const queued = new Set(conversations);
  if (hasForkColumn(db, "main")) {
    const forks = db.query(`SELECT DISTINCT c.conversation FROM codex_file_evidence f
      JOIN codex_price_ledger_copies c ON c.home=f.home AND c.path=f.path
      WHERE f.provider_forked_from_id=?1 AND substr(c.conversation,1,length(?2))=?2 AND c.conversation IS NOT NULL`);
    for (const conversation of [...queued]) {
      const thread = THREAD_OF_CONVERSATION.exec(conversation)?.[1];
      if (!thread) continue;
      for (const fork of forks.all(thread, conversation.slice(0, conversation.indexOf("|") + 1)) as { conversation: string }[])
        queued.add(fork.conversation);
    }
  }
  queueCodexLedgerWork(db, "identity", queued);
}
/** Queues the conversations still holding any of these response identities (`r:`), e.g. those of removed calls. */
export function markCodexResponsePartnersDirty(db: Database, identities: Iterable<string>): void {
  const list = [...identities].filter(identity => identity.startsWith("r:"));
  if (!list.length) return;
  markCodexConversationsDirty(db, (db.query(`SELECT DISTINCT c.conversation FROM codex_price_ledger_events e
    JOIN codex_price_ledger_copies c ON c.id=e.copy_id
    WHERE e.identity IN (SELECT value FROM json_each(?)) AND c.conversation IS NOT NULL`).all(JSON.stringify(list)) as { conversation: string }[])
    .map(row => row.conversation));
}
export function markCodexDaysDirty(db: Database, days: Iterable<string>): void {
  queueCodexLedgerWork(db, "day", days);
}
/** Provenance version of the copy rule readers report: 3 = per-call build-time resolution (2 was the per-range file choice). */
export const CODEX_CANONICAL_COPY_POLICY = 3;
/**
 * SQL predicate for a raw `events` row (alias given): the rows the ledger counts as calls. Readers of raw
 * facts use it instead of choosing copies.
 * - Copies all resolved: false only when the ledger resolved that observation as a duplicate or conflict copy.
 * - Copies being resolved after the ledger was published once: the last published state, only the
 *   observations already resolved as canonical. A new copy counts once it is resolved (read-freshness.ts).
 * - Never resolved (no ledger state yet, or its first fill): the reader is told to wait (CodexLedgerNotReady → "preparing").
 * A database without the ledger schema has no resolution at all; its rows count as they are.
 */
export function codexCanonicalEventSql(db: Database, alias: string): string {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias)) throw new Error("Invalid events alias");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_price_ledger_events'").get()) return "1";
  const state = readCodexLedgerState(db);
  const copyWork = codexLedgerWorkPending(db, ["copy", "blocked"]), unresolved = codexLedgerWorkPending(db, ["identity"]);
  if (!state || state.phase === "backfill" || state.status !== "ready") throw new CodexLedgerNotReady("Codex copies are being resolved");
  // Day sums and repricing do not move copy states; only copy work and unresolved conversations do.
  if (copyWork || unresolved) return `EXISTS(SELECT 1 FROM codex_price_ledger_copies dc JOIN codex_price_ledger_events de ON de.copy_id=dc.id
    AND de.source_offset=${alias}.source_offset WHERE dc.home IS ${alias}.home AND dc.path=${alias}.path AND de.copy_state='canonical')`;
  return `NOT EXISTS(SELECT 1 FROM codex_price_ledger_copies dc JOIN codex_price_ledger_events de ON de.copy_id=dc.id
    AND de.source_offset=${alias}.source_offset WHERE dc.home=${alias}.home AND dc.path=${alias}.path AND de.copy_state IN ('duplicate','conflict'))`;
}

/**
 * SQL predicate for a `ratelimit` row (alias given): the reading is evidence of the account's meter. A forked
 * thread's replay copies the parent's records whole, rate limits included, stamped at the fork time; the parent's
 * own record is the evidence. The replay is the file's leading run of records, so a reading at or before the
 * file's last replayed call is a replay too (also one from a copied record that is not a call). Every reader of
 * meter readings applies this one rule; code that only bounds a range by the first or last reading need not.
 */
export function codexReadingEvidenceSql(db: Database, alias: string): string {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(alias)) throw new Error("Invalid ratelimit alias");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='codex_price_ledger_events_replays'").get()) return "1";
  if (!(db.query("PRAGMA table_info(ratelimit)").all() as { name: string }[]).some(column => column.name === "source_offset")) return "1";
  return `NOT EXISTS(SELECT 1 FROM codex_price_ledger_copies rc JOIN codex_price_ledger_events re INDEXED BY codex_price_ledger_events_replays
    ON re.copy_id=rc.id AND re.source_offset>=${alias}.source_offset AND re.identity LIKE 'c:%'
    WHERE rc.home=${alias}.home AND rc.path=${alias}.path)`;
}
