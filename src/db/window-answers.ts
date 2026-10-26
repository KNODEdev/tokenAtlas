import { markContextWindowRange } from "./codex-context-details";
import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";
import { markSubscriptionCapacityDirty } from "./subscription-capacity";
import { markClaudeCardRangeDirty } from "./claude-card-metadata";
import { markCapacityCycleResultsDirty } from "./capacity-cycle-results";

/**
 * Stored window answers (the user's "switching windows recomputes everything", 06.10).
 *
 * A window screen (one Codex window's breakdown, an account's window accounting) is the answer of one
 * request over a bounded scope: a provider, an account and a time range. Its answer is computed off the
 * HTTP thread (data-read.ts) and published here by the background writer, then every later request is a
 * read of this row until something inside its scope changes:
 *
 * - every writer that changes an input of window sums already says so through `markWindowUsageDirty`
 *   (ledger days and hours, limit windows, account periods, repricing), and the window-sum producer
 *   publishes its rows; both append a mark (provider, account or `*`, instant range) here in the same
 *   transaction;
 * - an answer records the newest mark its read snapshot contained (`checked`); a later mark that overlaps
 *   its scope makes it stale. A closed window outside every new mark stays current indefinitely, also
 *   across restarts; a change of another provider or another account's window never touches it.
 *
 * A stale answer is still served (with its age) while its successor is computed, so returning to a screen
 * never waits. Marks are folded into the answers' `dirty` flag after `MARK_FOLD_AGE_MS` (longer than any
 * computation may take), so the mark log stays short; an answer computed before the fold boundary is
 * published as dirty.
 */
export const WINDOW_ANSWERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_answers (
  route TEXT NOT NULL, key TEXT NOT NULL, family TEXT NOT NULL,
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  configuration TEXT NOT NULL, checked INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
  built_at INTEGER NOT NULL, expires_at INTEGER, status INTEGER NOT NULL, version TEXT NOT NULL,
  headers TEXT NOT NULL, body BLOB NOT NULL,
  PRIMARY KEY(route, key)
) STRICT;
CREATE INDEX IF NOT EXISTS window_answers_family ON window_answers(route, family, built_at);
CREATE INDEX IF NOT EXISTS window_answers_scope ON window_answers(provider, account);
CREATE TABLE IF NOT EXISTS window_answer_marks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, account TEXT NOT NULL,
  from_ms INTEGER NOT NULL, until_ms INTEGER, created_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS window_answer_state (
  id INTEGER PRIMARY KEY CHECK(id=1), folded INTEGER NOT NULL
) STRICT;`;

/** Every provider or account (`*`). */
export const ANSWER_SCOPE_ALL = "*";
/** Marks older than this are folded into the answers; no computation runs this long (data-read.ts: 600 s). */
export const MARK_FOLD_AGE_MS = 15 * 60_000;
/** Answers not rebuilt for this long are dropped; a screen asks again when it is opened. */
export const ANSWER_RETENTION_MS = 30 * 86_400_000;
const OPEN_END = 8_640_000_000_000_000;

export interface AnswerScope {
  provider: string;
  /** An account, or `*` for an answer over every account of the provider. */
  account: string;
  fromMs: number;
  /** Exclusive end of the instants the answer reads; null: open. */
  untilMs: number | null;
}
export interface WindowAnswer {
  route: string; key: string; family: string; scope: AnswerScope;
  /** Configuration the answer was computed under (rate cards, accounts, projects…). */
  configuration: string;
  /** The newest mark the answer's read snapshot contained. */
  checked: number;
  dirty?: boolean;
  builtAt: number;
  /** When the clock makes the body stale (a window it shows resets or the open window moves on); null: never. */
  expiresAt: number | null;
  status: number;
  /** Version of the stored rows the answer was read from (`X-Data-Version`). */
  version: string;
  headers: Array<[string, string]>;
  /** The JSON body. */
  body: string;
}

const present = new WeakSet<Database>();
export function hasWindowAnswers(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_answer_marks'").get();
  if (found) present.add(db);
  return found;
}
export function ensureWindowAnswersSchema(db: Database): void {
  asSchemaWriter(db, () => db.exec(WINDOW_ANSWERS_SCHEMA_SQL));
}

/**
 * Called by a writer that changed an input of window screens, inside its transaction (see
 * `markWindowUsageDirty`): stored answers whose scope overlaps `[fromMs, untilMs)` become stale.
 */
export function markWindowAnswersDirty(db: Database, change: AnswerScope): void {
  if(change.provider === "codex" || change.provider === "*") markContextWindowRange(db,change.account,change.fromMs,change.untilMs);
  if (change.provider === "claude" || change.provider === "*") markClaudeCardRangeDirty(db,change.account,change.fromMs,change.untilMs);
  markCapacityCycleResultsDirty(db, change.provider, change.account, change.fromMs, change.untilMs);
  markSubscriptionCapacityDirty(db, change.provider, change.account, change.fromMs, change.untilMs);
  if (!hasWindowAnswers(db)) return;
  db.query("INSERT INTO window_answer_marks(provider,account,from_ms,until_ms,created_ms) VALUES(?,?,?,?,?)")
    .run(change.provider.toLowerCase(), change.account === ANSWER_SCOPE_ALL ? change.account : change.account.toLowerCase(),
      Math.floor(change.fromMs), change.untilMs === null || !Number.isFinite(change.untilMs) ? null : Math.ceil(change.untilMs), Date.now());
}

/** A mark no account's answer overlaps (only answers over every account do): ledger rows no account owns. */
export const ANSWER_SCOPE_NONE = "";
/** Where a ledger change happened: an archive source and a session identity (Claude). */
export interface LedgerPlace { source: string | null; identity: string | null }
/**
 * The accounts that own a provider's ledger rows of these places within `[fromMs, untilMs)` (account periods and
 * session identities), or null when that cannot be told.
 */
export type LedgerOwners = (provider: string, places: readonly LedgerPlace[], fromMs: number, untilMs: number) => string[] | null;
const ledgerOwners = new WeakMap<Database, LedgerOwners>();
/** The background writer says, per connection, how ledger changes map to accounts (see `markWindowUsageRangesDirty`). */
export function setLedgerAnswerOwners(db: Database, owners: LedgerOwners | null): void {
  if (owners) ledgerOwners.set(db, owners); else ledgerOwners.delete(db);
}
/** The accounts whose answers a ledger change touches: every account (`*`) when the connection cannot tell. */
export function ledgerAnswerAccounts(db: Database, provider: string, places: readonly LedgerPlace[] | undefined, fromMs: number, untilMs: number): string[] {
  const owners = places && ledgerOwners.get(db)?.(provider, places, fromMs, untilMs);
  return owners ? (owners.length ? owners : [ANSWER_SCOPE_NONE]) : [ANSWER_SCOPE_ALL];
}

/** The newest mark ever written (folded marks included), read in the caller's snapshot. */
export function windowAnswerMarkSeq(db: Database): number {
  if (!hasWindowAnswers(db)) return 0;
  return (db.query("SELECT seq FROM sqlite_sequence WHERE name='window_answer_marks'").get() as { seq: number } | null)?.seq ?? 0;
}

const OVERLAP = `(m.provider=a.provider OR m.provider='*' OR a.provider='*') AND (m.account='*' OR a.account='*' OR m.account=a.account)
  AND m.from_ms < COALESCE(a.until_ms, ${OPEN_END}) AND COALESCE(m.until_ms, ${OPEN_END}) > a.from_ms`;

/** Whether a mark newer than `checked` overlaps the scope. */
export function windowAnswerMarkedSince(db: Database, scope: AnswerScope, checked: number): boolean {
  if (!hasWindowAnswers(db)) return false;
  return !!db.query(`SELECT 1 FROM window_answer_marks m, (SELECT ? provider, ? account, ? from_ms, ? until_ms) a
    WHERE m.seq > ? AND ${OVERLAP} LIMIT 1`).get(scope.provider, scope.account, scope.fromMs, scope.untilMs, checked);
}

interface Row { route: string; key: string; family: string; provider: string; account: string; from_ms: number; until_ms: number | null;
  configuration: string; checked: number; dirty: number; built_at: number; expires_at: number | null; status: number; version: string;
  headers: string; body: Uint8Array }
const answerOf = (row: Row): WindowAnswer => ({
  route: row.route, key: row.key, family: row.family,
  scope: { provider: row.provider, account: row.account, fromMs: row.from_ms, untilMs: row.until_ms },
  configuration: row.configuration, checked: row.checked, dirty: row.dirty === 1, builtAt: row.built_at, expiresAt: row.expires_at,
  status: row.status, version: row.version, headers: JSON.parse(row.headers) as Array<[string, string]>,
  body: new TextDecoder().decode(Bun.gunzipSync(row.body as Uint8Array<ArrayBuffer>)),
});

export function readWindowAnswer(db: Database, route: string, key: string): WindowAnswer | null {
  if (!hasWindowAnswers(db)) return null;
  const row = db.query("SELECT * FROM window_answers WHERE route=? AND key=?").get(route, key) as Row | null;
  return row ? answerOf(row) : null;
}
/** One snapshot query for a bounded group of committed screen answers and their scoped marks. */
export function readWindowAnswerBatch(db: Database, route: string, keys: readonly string[]): Map<string, { answer: WindowAnswer; marked: boolean }> {
  if (keys.length > 12) throw new Error("Too many window answers");
  if (!keys.length || !hasWindowAnswers(db)) return new Map();
  const rows = db.query(`SELECT a.*, EXISTS(SELECT 1 FROM window_answer_marks m WHERE m.seq > a.checked AND ${OVERLAP}) AS marked
    FROM window_answers a WHERE a.route=? AND a.key IN (${keys.map(() => "?").join(",")})`).all(route, ...keys) as Array<Row & { marked: number }>;
  return new Map(rows.map(row => [row.key, { answer: answerOf(row), marked: row.marked === 1 }]));
}
/** An answer without its body: what deciding whether it is still current needs. */
export function readWindowAnswerState(db: Database, route: string, key: string): Omit<WindowAnswer, "body" | "headers"> | null {
  if (!hasWindowAnswers(db)) return null;
  const row = db.query(`SELECT route,key,family,provider,account,from_ms,until_ms,configuration,checked,dirty,built_at,expires_at,status,version
    FROM window_answers WHERE route=? AND key=?`).get(route, key) as Omit<Row, "headers" | "body"> | null;
  return row && { route: row.route, key: row.key, family: row.family,
    scope: { provider: row.provider, account: row.account, fromMs: row.from_ms, untilMs: row.until_ms },
    configuration: row.configuration, checked: row.checked, dirty: row.dirty === 1, builtAt: row.built_at, expiresAt: row.expires_at,
    status: row.status, version: row.version };
}
/** Whether a request family (the same request with a moved end) has a stored answer. */
export function hasFamilyAnswer(db: Database, route: string, family: string): boolean {
  if (!hasWindowAnswers(db)) return false;
  return !!db.query("SELECT 1 FROM window_answers WHERE route=? AND family=? AND status=200 LIMIT 1").get(route, family);
}
/** The newest answer of a request family (the same request with a moved end), for a stale first answer. */
export function readFamilyAnswer(db: Database, route: string, family: string): WindowAnswer | null {
  if (!hasWindowAnswers(db)) return null;
  const row = db.query("SELECT * FROM window_answers WHERE route=? AND family=? AND status=200 ORDER BY built_at DESC LIMIT 1")
    .get(route, family) as Row | null;
  return row ? answerOf(row) : null;
}

/** Current: same configuration, not folded dirty, not expired and no newer overlapping mark. */
export function windowAnswerIsCurrent(db: Database, answer: WindowAnswer, configuration: string, nowMs = Date.now()): boolean {
  return answer.configuration === configuration && !answer.dirty && (answer.expiresAt === null || nowMs < answer.expiresAt)
    && !windowAnswerMarkedSince(db, answer.scope, answer.checked);
}

function foldedSeq(db: Database): number {
  return (db.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0;
}

/**
 * Publishes computed answers (the background writer, in one short transaction). An answer never replaces
 * one computed from a newer snapshot; one older than the fold boundary may have missed a folded mark and
 * is stored dirty.
 */
export function storeWindowAnswers(db: Database, answers: readonly WindowAnswer[]): number {
  if (!answers.length) return 0;
  if (!hasWindowAnswers(db)) ensureWindowAnswersSchema(db);
  let stored = 0;
  // Compressed before the transaction: a large body never holds the writer.
  const bodies = answers.map(answer => Bun.gzipSync(new TextEncoder().encode(answer.body)));
  db.transaction(() => {
    const folded = foldedSeq(db);
    const put = db.query(`INSERT INTO window_answers(route,key,family,provider,account,from_ms,until_ms,configuration,checked,dirty,
        built_at,expires_at,status,version,headers,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(route,key) DO UPDATE SET family=excluded.family,provider=excluded.provider,account=excluded.account,
        from_ms=excluded.from_ms,until_ms=excluded.until_ms,configuration=excluded.configuration,checked=excluded.checked,
        dirty=excluded.dirty,built_at=excluded.built_at,expires_at=excluded.expires_at,status=excluded.status,version=excluded.version,
        headers=excluded.headers,body=excluded.body
      WHERE excluded.checked > window_answers.checked OR excluded.checked = window_answers.checked AND excluded.built_at >= window_answers.built_at`);
    for (const [index, answer] of answers.entries()) {
      const result = put.run(answer.route, answer.key, answer.family, answer.scope.provider, answer.scope.account, answer.scope.fromMs,
        answer.scope.untilMs, answer.configuration, answer.checked, answer.checked < folded ? 1 : 0, answer.builtAt, answer.expiresAt,
        answer.status, answer.version, JSON.stringify(answer.headers), bodies[index]!);
      stored += result.changes;
    }
  }).immediate();
  return stored;
}

/**
 * Folds marks older than `MARK_FOLD_AGE_MS` into the answers they overlap and drops answers past their
 * retention. Bounded per call; returns whether old marks remain.
 */
export function foldWindowAnswerMarks(db: Database, nowMs = Date.now(), limit = 500): boolean {
  if (!hasWindowAnswers(db)) return false;
  const marks = db.query("SELECT seq FROM window_answer_marks WHERE created_ms < ? ORDER BY seq LIMIT ?")
    .all(nowMs - MARK_FOLD_AGE_MS, limit) as Array<{ seq: number }>;
  if (!marks.length) return false;
  const last = marks.at(-1)!.seq;
  db.transaction(() => {
    db.query(`UPDATE window_answers AS a SET dirty=1 WHERE dirty=0 AND EXISTS (SELECT 1 FROM window_answer_marks m
      WHERE m.seq <= ? AND m.seq > a.checked AND ${OVERLAP})`).run(last);
    db.query("DELETE FROM window_answer_marks WHERE seq <= ?").run(last);
    db.query("INSERT INTO window_answer_state(id,folded) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET folded=MAX(folded,excluded.folded)").run(last);
    db.query("DELETE FROM window_answers WHERE built_at < ?").run(nowMs - ANSWER_RETENTION_MS);
  }).immediate();
  return marks.length === limit;
}
