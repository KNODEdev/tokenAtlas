import type { Database } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT, CONFIG_ROOT, LOGIN } from "../../config/paths";
import type { CurrentPeriodDelta } from "../../db/period-store";
import { ensureProbeSourcesSchema, markProbeSourcesPublished, probeSourcesPublished } from "../../db/probe-sources";
import { loadAccountResolver } from "../account-resolver";
import { normEraKey, normEraVendor } from "../eras";
import { sourceOfProbeTuple, type ProbeSourceOptions } from "../probe-source";
import { probeEvidenceReader, type IndexedProbeRow } from "../probe-source-reader";
import { readProbeSourceCorrections, type ProbeSourceCorrection } from "../probe-source-corrections";
import { probeAccountingTime, probeClaudeObservationTime } from "./probe-accounting-time";
import { ownerOfStoredEvidence, probeReadContext, readOwnedProbePage, readProbeEvidence, selectOwnedProbes,
  type ProbeReadContext, type StoredProbeEvidence } from "./probe-account-reader";
import type { CurrentIdentity, CurrentProbeError } from "../../web/lib/current-contract";
import type { SourceDeclaration } from "../archive-source";
import { currentConfigFingerprint, currentVendor, registryFingerprint } from "./registry";
import type { StoredLimit, StoredSubject } from "./store";
import { ALL_ACCOUNTS, LIMIT_WINDOW_ALL, LIMIT_WINDOW_OWNERSHIP_MS, markLimitWindowsDirty } from "../../db/limit-windows";
import { usageProviderIds } from "../subscription-accounting-adapters";
import { queueCreditEvidence } from "../window-end-causes";
import { markCapacityCycleResultsDirty } from "../../db/capacity-cycle-results";
import { markClaudeCardProbeDirty } from "../../db/claude-card-metadata";
import { markWindowAnswersDirty } from "../../db/window-answers";

/**
 * The current projection (cards of `/api/bootstrap` and `/current`): per account, the newest
 * qualifying reading of every counter. Two steps, each in bounded writer transactions:
 *
 * 1. Evidence: readings queued in `probe_source_dirty` (new, corrected, deleted, newly linked) get
 *    their physical evidence written once to `probe_sources`. The old and new evidence name the
 *    accounts a reading left and joined; a joined account folds it into its card, a left account
 *    re-seeks only what its card showed from that reading (`repairCard`).
 * 2. Cards: an account is folded from its readings as the account periods give them
 *    (`readOwnedProbePage`). A period change folds the gaining account over the moved interval and
 *    repairs the losing one only where its card showed a reading from it; a declaration or
 *    correction change refolds the accounts whose sources changed. Changes affecting several
 *    accounts publish together (a cohort).
 */
const PREFIX = "current_v2_";
const STAGE = "\u0001stage:";
const MAX_KEYS = 128;
const KEY_FORMAT = "probe-sources-1";
// What a card fold reads of a reading (the large `extra` stays behind).
const FOLD_COLUMNS = `p.id,p.provider,p.ts,p.kind,p.limit_group,p.scope,p.window_minutes,p.machine,p.plan,p.ok,p.error,
  p.used_percent,p.remaining_percent,p.used,p.remaining,p.allowance,p.resets_at,p.rate_limit_reached`;
export interface CurrentPhysicalConfig { archiveRoot: string; defaultLogin: string; configRoot?: string }
const DEFAULT_PHYSICAL: CurrentPhysicalConfig = { archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN };
type Probe = IndexedProbeRow & { id: number; provider: string; subject: string; ts: string; kind: string; limit_group: string | null;
  scope: string | null; window_minutes: number | null; machine: string | null; extra: string | null; plan: string | null; ok: number | null;
  error: string | null; used_percent: number | null; remaining_percent: number | null; used: number | null;
  remaining: number | null; allowance: number | null; resets_at: string | null; rate_limit_reached: number | null };
type Winner = { id: number; time: number; signature: string; conflicting: boolean; limit: StoredLimit };
type ErrorSample = { id: number; time: number; value: CurrentProbeError };
type Cursor = { at: number; id: number };
/** One reading by its collection instant (`probe_sources.at`), id and recorded time. */
export type CardMark = { id: number; at: number; ts: string };
/**
 * Every reading of the account, future and failed ones included: the first and last recorded times. Cycles
 * are the stored limit windows (`probe-limit-windows.ts` `cycleStarts`), not resets of readings.
 */
export type CardActivity = { first: CardMark | null; last: CardMark | null };
/** Per computer (`JSON.stringify(machine)`): the span of its readings and its newest success and failure. */
export type CardMachine = { lo: number; hi: number; ok: CardMark | null; err: (CardMark & { error: string | null }) | null };
export type CardHealth = { success: (CardMark & { machine: string | null }) | null; machines: Record<string, CardMachine> };
/** A card in preparation: a full fold paging by `cursor`, or a published card with readings folded in (`done`). */
type Stage = { cursor: Cursor | null; done: boolean; keys: Record<string, true>; winners: Record<string, Winner>;
  error: ErrorSample | null; next: number | null; future: boolean; scanned: number; activity: CardActivity; health: CardHealth };
type Published = StoredSubject & { __keys: Record<string, true>; __winners: Record<string, Winner>;
  __error: ErrorSample | null; __next: number | null; __activity?: CardActivity; __health?: CardHealth };
/** Cards of an older format lack activity and health; they are folded again once. */
const CARD_FORMAT = "health-3";

const integer = (value: string | null) => Number(value ?? 0) || 0;
const finite = (value: number | null) => value != null && Number.isFinite(value) ? value : null;
const iso = (value: string | null) => {
  const time = value == null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const definitions = (declarations: readonly SourceDeclaration[], physical: CurrentPhysicalConfig) =>
  JSON.stringify([physical.archiveRoot, physical.defaultLogin, declarations
  .map(({ vendor, machine, home, source_home }) => [currentVendor(vendor), machine ?? "", home ?? "", source_home ?? ""])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
function meta(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE key=?").get(PREFIX + key) as { value: string } | null)?.value ?? null;
}
function put(db: Database, key: string, value: string | number): void {
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(PREFIX + key, String(value));
}
function count(db: Database, key: string, amount: number): void { put(db, key, integer(meta(db, key)) + amount); }
const member = (provider: string, account: string) => `${provider}\u0000${account}`;
const split = (value: string) => value.split("\u0000") as [string, string];

/** The account's limit windows read this reading from its earliest instant; queue their update. */
function queueLimitWindows(db: Database, provider: string, account: string, from: number): void {
  if (!Number.isFinite(from)) return;
  markLimitWindowsDirty(db, provider, account, from);
  // An identity-verified Codex reading brackets transcript readings of every Codex account for 24 h.
  if (provider === "codex") markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, from - LIMIT_WINDOW_OWNERSHIP_MS);
}
/** The earliest of a reading's collection, accounting and observation instants: where its limit windows start reading it. */
const earliestInstant = (evidence: StoredProbeEvidence) =>
  Math.min(...[evidence.at, evidence.accounting_at, evidence.observation_at].filter((time): time is number => time !== null));
/** Usage-share corrections may leave the meter and traffic sums unchanged. Their cycle projection still changes. */
function queueCapacityReading(db: Database, provider: string, account: string, evidence: StoredProbeEvidence): void {
  const instants = [evidence.at, evidence.accounting_at, evidence.observation_at].filter((time): time is number => time !== null && Number.isFinite(time));
  if (instants.length) {
    const fromMs=Math.min(...instants),untilMs=Math.max(...instants)+1;
    if(provider === "claude")markWindowAnswersDirty(db,{provider,account,fromMs,untilMs});
    else markCapacityCycleResultsDirty(db, provider, account, fromMs, untilMs);
  }
}

function stageOf(db: Database, provider: string, account: string): Stage | null {
  const saved = db.query("SELECT data FROM current_probe_subjects WHERE provider=? AND subject=?")
    .get(provider, STAGE + account) as { data: string } | null;
  return saved ? JSON.parse(saved.data) as Stage : null;
}
/** The published card as a finished stage that readings can be folded into. */
function publishedStage(db: Database, provider: string, account: string): Stage | null {
  const saved = db.query("SELECT data FROM current_probe_subjects WHERE provider=? AND subject=?")
    .get(provider, account) as { data: string } | null;
  if (!saved) return null;
  const published = JSON.parse(saved.data) as Published;
  const empty = emptyStage();
  return { ...empty, done: true, keys: { ...published.__keys }, winners: { ...published.__winners },
    error: published.__error, next: published.__next, future: published.clock_warning,
    activity: published.__activity ?? empty.activity, health: published.__health ?? empty.health };
}
function saveStage(db: Database, provider: string, account: string, stage: Stage, now: string): void {
  db.query("INSERT OR IGNORE INTO current_projection_dirty(provider,subject) VALUES(?,?)").run(provider, account);
  db.query(`INSERT INTO current_probe_subjects(provider,subject,data,generated_at,next_refresh_at) VALUES(?,?,?,?,NULL)
    ON CONFLICT(provider,subject) DO UPDATE SET data=excluded.data,generated_at=excluded.generated_at`)
    .run(provider, STAGE + account, JSON.stringify(stage), now);
}
const isDirty = (db: Database, provider: string, account: string) =>
  db.query("SELECT 1 FROM current_projection_dirty WHERE provider=? AND subject=?").get(provider, account) != null;
/** Queues a full fold of the account from its readings, dropping any card in preparation. */
function refold(db: Database, provider: string, account: string | null): void {
  if (!account) return;
  const lower = account.toLowerCase();
  db.query("INSERT OR IGNORE INTO current_projection_dirty(provider,subject) VALUES(?,?)").run(provider, lower);
  db.query("DELETE FROM current_probe_subjects WHERE provider=? AND subject=?").run(provider, STAGE + lower);
}

const FAILED = "(p.kind='error' OR (p.ok IS NOT NULL AND p.ok<>1) OR p.error IS NOT NULL)";
const GROUP = "p.kind=? AND COALESCE(p.limit_group,'')=? AND COALESCE(p.scope,'')=? AND COALESCE(p.window_minutes,-1)=?";
/**
 * The card no longer holds readings of `[from, until)` (or reading `id`): every counter whose winner,
 * the latest error and the next refresh that came from there are sought again among the account's
 * remaining readings, newest first, by index. Returns whether the card changed.
 */
function repairCard(db: Database, context: ProbeReadContext, provider: string, account: string, card: Stage,
  from: number, until: number, now: string, id?: number): boolean {
  const nowMs = Date.parse(now), inside = (time: number | null) => time !== null && time >= from && time < until;
  const select = (where: string, params: Array<string | number>, order: "asc" | "desc", bounds: { from?: number; until?: number }, limit: number) =>
    selectOwnedProbes(db, context, provider, account, { ...bounds, where, params, order, limit, columns: FOLD_COLUMNS });
  // All readings at the newest qualifying instant up to now: ties decide a counter's conflict.
  const newest = (where: string, params: Array<string | number>) => {
    for (let limit = 8; ; limit *= 4) {
      const rows = select(where, params, "desc", { until: nowMs + 1 }, limit);
      if (rows.length < limit || rows.at(-1)!.at !== rows[0]!.at) return rows.filter(item => item.at === rows[0]!.at);
    }
  };
  let changed = false;
  for (const [key, winner] of Object.entries(card.winners)) {
    if (winner.id !== id && !inside(winner.time)) continue;
    changed = true;
    delete card.winners[key];
    const [, , kind, group, scope, window] = JSON.parse(key) as [string, string, string, string, string, number];
    const params = [kind, group, scope, window];
    for (const { row } of newest(`${GROUP} AND NOT ${FAILED}`, params)) fold(card, row as Probe, account, nowMs);
    if (!card.winners[key] && !select(GROUP, params, "asc", {}, 1).length) delete card.keys[key];
  }
  if (card.error && (card.error.id === id || inside(card.error.time))) {
    changed = true;
    card.error = null;
    for (const { row } of newest(FAILED, [])) fold(card, row as Probe, account, nowMs);
  }
  if (until > nowMs && (card.next !== null || card.future)) {
    changed = true;
    card.next = null; card.future = false;
    // The nearest reading after now sets the refresh; any beyond the tolerance sets the clock warning.
    for (const bound of [nowMs + 1, nowMs + 300_001])
      for (const { row } of select("1", [], "asc", { from: bound }, 1)) fold(card, row as Probe, account, nowMs);
  }
  if (changed) count(db, "repairs", 1);
  if (repairHistory(db, context, provider, account, card, from, until, id)) { count(db, "history_repairs", 1); changed = true; }
  return changed;
}
/** The account no longer owns a reading collected at `at`: repair only what its card showed from it. */
function leave(db: Database, context: ProbeReadContext, provider: string, account: string, id: number, at: number | null, now: string,
  joined?: Joined): void {
  joined?.flush(provider, account);
  const staged = stageOf(db, provider, account);
  // A fold in progress may already hold the reading.
  if (staged && !staged.done) { refold(db, provider, account); return; }
  const card = staged ?? publishedStage(db, provider, account);
  if (!card) return;
  if (at === null || historyRepairTooWide(card, at, at + 1)) { refold(db, provider, account); return; }
  if (repairCard(db, context, provider, account, card, at, at + 1, now, id)) saveStage(db, provider, account, card, now);
}
/**
 * Cards that new readings joined within one writer transaction, saved once at its end: a card with a
 * long history is parsed and written once per batch, not once per reading.
 */
class Joined {
  private readonly cards = new Map<string, Stage>();
  constructor(private readonly db: Database, private readonly now: string) {}
  get(provider: string, account: string): Stage | undefined { return this.cards.get(member(provider, account)); }
  set(provider: string, account: string, stage: Stage): void { this.cards.set(member(provider, account), stage); }
  flush(provider?: string, account?: string): void {
    for (const [key, stage] of [...this.cards]) {
      if (provider !== undefined && key !== member(provider, account!)) continue;
      saveStage(this.db, ...split(key), stage, this.now);
      this.cards.delete(key);
    }
  }
}
/** The account owns a new reading: fold it into its card in preparation, or into its published card. */
function join(db: Database, provider: string, account: string, row: Probe, now: string, joined?: Joined): void {
  let stage = joined?.get(provider, account) ?? stageOf(db, provider, account);
  if (!stage) {
    // A queued full fold reads the reading itself.
    if (isDirty(db, provider, account)) return;
    stage = publishedStage(db, provider, account);
    if (!stage) { refold(db, provider, account); return; }
  }
  fold(stage, row, account, Date.parse(now));
  if (joined) joined.set(provider, account, stage);
  else saveStage(db, provider, account, stage, now);
  count(db, "fast_inserts", 1);
}

/**
 * Writes the evidence of queued readings. Until every reading has evidence, readers answer
 * "preparing" and no card is folded; the first complete write publishes the evidence and folds every
 * account. Afterwards each written reading moves between the accounts its old and new evidence name.
 */
function writeProbeSources(db: Database, context: ProbeReadContext, budget: number, now: string): boolean {
  const ids = db.query("SELECT probe_id,changed FROM probe_source_dirty ORDER BY probe_id LIMIT ?").all(budget) as Array<{ probe_id: number; changed: number }>;
  const published = probeSourcesPublished(db);
  if (!ids.length) {
    if (published) return false;
    markProbeSourcesPublished(db);
    markAllCurrentAccountsDirty(db, []);
    for (const provider of usageProviderIds()) markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, LIMIT_WINDOW_ALL);
    return true;
  }
  const evidenceOf = probeEvidenceReader(db);
  const select = db.query("SELECT * FROM probe_windows WHERE id=?");
  const remove = db.query("DELETE FROM probe_sources WHERE probe_id=?");
  const insert = db.query(`INSERT INTO probe_sources(probe_id,ord,provider,machine,home,login,basis,tuples,at,accounting_at,
    observation_at,subject,bare,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const done = db.query("DELETE FROM probe_source_dirty WHERE probe_id=?");
  const tuple = db.query("INSERT OR IGNORE INTO probe_source_tuples(provider,machine,home,login) VALUES(?,?,?,?)");
  let revision = integer(meta(db, "source_revision"));
  const joined = new Joined(db, now);
  // Instants of Codex readings whose reset credits may have changed, for the end causes (queued once per batch, below).
  const credits: number[] = [];
  for (const { probe_id: id, changed } of ids) {
    const old = readProbeEvidence(db, id);
    const row = select.get(id) as Probe | null;
    const fresh: StoredProbeEvidence[] = [];
    let tupleCount = 0;
    if (row) {
      const proof = evidenceOf(row), provider = normEraVendor(row.provider), parsed = Date.parse(row.ts);
      const at = Number.isFinite(parsed) ? parsed : null, bare = row.machine === null ? 1 : 0;
      const instant = (value: string | null) => { const ms = value === null || at === null ? NaN : Date.parse(value); return Number.isFinite(ms) ? ms : null; };
      const accounting = instant(probeAccountingTime(row)), observation = instant(probeClaudeObservationTime(row));
      tupleCount = proof.tuples.length;
      for (const physical of proof.tuples.length ? proof.tuples : [null])
        fresh.push({ provider, machine: physical?.machine ?? null, home: physical?.home ?? null, login: physical?.login ?? null,
          basis: proof.basis, at, accounting_at: accounting, observation_at: observation, subject: row.subject, bare });
    }
    done.run(id);
    // A link touched without changing the reading or what it proves (a repeated backfill) changes nothing.
    if (!changed && JSON.stringify(old) === JSON.stringify(fresh)) continue;
    remove.run(id);
    if (fresh.length) revision++;
    fresh.forEach((evidence, ord) => {
      insert.run(id, ord, evidence.provider, evidence.machine, evidence.home, evidence.login, evidence.basis,
        tupleCount,
        evidence.at, evidence.accounting_at, evidence.observation_at, evidence.subject, evidence.bare, revision);
      if (evidence.machine !== null && (evidence.basis === "projection" || evidence.basis === "matched"))
        tuple.run(evidence.provider, evidence.machine, evidence.home, evidence.login);
    });
    if (!published) continue;
    const oldOwner = ownerOfStoredEvidence(context, old), newOwner = ownerOfStoredEvidence(context, fresh);
    // A Codex reading's reset credits are evidence for its owner's window ends within 2 h (window-end-causes.ts). Any update
    // or deletion of a reading already written (its old credits are not kept: it may have cleared them), and a new reading
    // with credits, queue that work directly; such a change may move no limit window and is no input of window answers.
    const updated = old.length > 0, carries = !!row && (row as unknown as { reset_credits: number | null }).reset_credits !== null;
    if (updated && old[0]!.provider === "codex" && old[0]!.at !== null) credits.push(old[0]!.at);
    if ((updated || carries) && row && normEraVendor(row.provider) === "codex" && fresh[0]?.at != null) credits.push(fresh[0]!.at);
    if (oldOwner) {
      const provider = old[0]!.provider;
      leave(db, context, provider, oldOwner, id, old[0]!.at, now, joined);
      queueLimitWindows(db, provider, oldOwner, earliestInstant(old[0]!));
      queueCapacityReading(db, provider, oldOwner, old[0]!);
      if (provider === "claude") markClaudeCardProbeDirty(db,oldOwner,id);
    }
    if (row && newOwner) {
      const provider = normEraVendor(row.provider);
      join(db, provider, newOwner, row, now, joined);
      queueLimitWindows(db, provider, newOwner, earliestInstant(fresh[0]!));
      queueCapacityReading(db, provider, newOwner, fresh[0]!);
      if (provider === "claude") markClaudeCardProbeDirty(db,newOwner,id);
    }
  }
  joined.flush();
  if (published && credits.length) queueCreditEvidence(db, credits);
  put(db, "source_revision", revision);
  count(db, "source_rows", ids.length);
  return true;
}

/** Queues every account for a full fold: the registry's, the published cards' and every account of the periods. */
export function markAllCurrentAccountsDirty(db: Database, registry: readonly CurrentIdentity[]): void {
  const accounts = new Set<string>();
  const add = (provider: string, account: string) => { if (account) accounts.add(member(provider, account.toLowerCase())); };
  for (const row of registry) add(row.vendor, row.id);
  for (const row of db.query("SELECT provider,subject FROM current_probe_subjects WHERE subject NOT LIKE ?")
    .all(STAGE + "%") as Array<{ provider: string; subject: string }>) add(row.provider, row.subject);
  const resolver = loadAccountResolver(db);
  const evidenced = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='probe_source_tuples'").get()
    ? (db.query("SELECT DISTINCT provider FROM probe_source_tuples").all() as Array<{ provider: string }>).map(row => row.provider) : [];
  for (const provider of new Set([...registry.map(row => row.vendor), ...evidenced]))
    for (const account of resolver.accounts(provider)) add(provider, account);
  for (const account of accounts) refold(db, ...split(account));
}
function addCohort(db: Database, members: Iterable<string>): void {
  const cohort = new Set(JSON.parse(meta(db, "cohort") ?? "[]") as string[]);
  for (const item of members) cohort.add(item);
  put(db, "cohort", JSON.stringify([...cohort].sort()));
}

/**
 * Source declarations or owner corrections changed: the accounts whose sources change for some
 * reading refold and publish together, and their limit windows follow from the changed range.
 */
function sourcesChanged(db: Database, before: ProbeSourceOptions, after: ProbeSourceOptions): void {
  const changed = new Map<string, Set<string>>();
  const mark = (provider: string, ...sources: Array<string | null>) => {
    const set = changed.get(provider) ?? new Set<string>();
    for (const source of sources) if (source) set.add(normEraKey(source));
    changed.set(provider, set);
  };
  for (const tuple of db.query("SELECT provider,machine,home,login FROM probe_source_tuples")
    .all() as Array<{ provider: string; machine: string; home: string; login: string }>) {
    const old = sourceOfProbeTuple(tuple.provider, tuple, before), next = sourceOfProbeTuple(tuple.provider, tuple, after);
    if ((old && normEraKey(old)) !== (next && normEraKey(next))) mark(tuple.provider, old, next);
  }
  const keys = (options: ProbeSourceOptions) => new Set((options.corrections ?? []).map(item => JSON.stringify(item)));
  const oldCorrections = keys(before), newCorrections = keys(after);
  for (const item of [...before.corrections ?? [], ...after.corrections ?? []]) {
    const key = JSON.stringify(item);
    if (oldCorrections.has(key) !== newCorrections.has(key)) mark(normEraVendor(item.provider), item.source);
  }
  const resolver = loadAccountResolver(db), affected: string[] = [];
  for (const [provider, sources] of changed) for (const account of resolver.accounts(provider)) {
    const ranges = resolver.plan(provider, account).ranges.filter(range => sources.has(range.source));
    if (!ranges.length) continue;
    affected.push(member(provider, account));
    refold(db, provider, account);
    // The readings that change owner can carry accounting instants before their collection.
    const from = Math.min(...ranges.map(range => range.from));
    const earliest = (db.query(`SELECT MIN(MIN(at, COALESCE(accounting_at, at), COALESCE(observation_at, at))) AS t
      FROM probe_sources WHERE provider=? AND at>=?`).get(provider, Number.isFinite(from) ? from : -Number.MAX_SAFE_INTEGER) as { t: number | null }).t;
    queueLimitWindows(db, provider, account, Math.min(from, earliest ?? Infinity));
  }
  addCohort(db, affected);
}

function periodDeltas(db: Database): CurrentPeriodDelta[] {
  return JSON.parse(meta(db, "period_deltas") ?? "[]") as CurrentPeriodDelta[];
}
function periodMembers(deltas: readonly CurrentPeriodDelta[]): Set<string> {
  return new Set(deltas.flatMap(delta => [delta.oldAccount, delta.newAccount]
    .filter((account): account is string => account !== null).map(account => member(delta.provider, account))));
}
/**
 * An account period changed owner over `[from, until)` of a source (queued by the period store).
 * The gaining account folds its readings of that interval into its card; the losing account
 * repairs only what its card showed from the interval. Both publish together.
 */
function processPeriodDeltas(db: Database, context: ProbeReadContext, now: string, budget: number): boolean {
  const deltas = periodDeltas(db);
  const delta = deltas.find(item => !item.done);
  if (!delta) return false;
  const until = delta.until ?? Infinity;
  if (delta.cursor === null) {
    if (delta.oldAccount) {
      const staged = stageOf(db, delta.provider, delta.oldAccount);
      const card = staged ?? publishedStage(db, delta.provider, delta.oldAccount);
      if (staged?.done === false || (card && historyRepairTooWide(card, delta.from, until))) refold(db, delta.provider, delta.oldAccount);
      else if (card) {
        repairCard(db, context, delta.provider, delta.oldAccount, card, delta.from, until, now);
        saveStage(db, delta.provider, delta.oldAccount, card, now);
      }
    }
    delta.cursor = "";
  }
  const account = delta.newAccount;
  const stage = !account ? null : stageOf(db, delta.provider, account)
    ?? (isDirty(db, delta.provider, account) ? null : publishedStage(db, delta.provider, account));
  if (!account || !stage) {
    // No card to extend: no gaining account, a queued full fold, or no card yet (folded whole).
    if (account && !isDirty(db, delta.provider, account)) refold(db, delta.provider, account);
    delta.done = true;
  } else {
    const after = delta.cursor ? JSON.parse(delta.cursor) as Cursor : null;
    const page = readOwnedProbePage(db, context, delta.provider, account, { after, from: delta.from, until }, budget, FOLD_COLUMNS);
    for (const { row, at } of page) {
      fold(stage, row as Probe, account, Date.parse(now));
      delta.cursor = JSON.stringify({ at, id: row.id });
    }
    if (page.length < budget) delta.done = true;
    saveStage(db, delta.provider, account, stage, now);
    count(db, "period_rows", page.length);
  }
  put(db, "period_deltas", JSON.stringify(deltas));
  return true;
}

/** One page of the next account's full fold. */
function nextStage(db: Database, context: ProbeReadContext, now: string, budget: number): boolean {
  const pending = db.query("SELECT provider,subject FROM current_projection_dirty ORDER BY provider,subject")
    .all() as Array<{ provider: string; subject: string }>;
  for (const { provider, subject } of pending) {
    const saved = stageOf(db, provider, subject);
    if (saved?.done) continue;
    const stage = saved ?? emptyStage(), scanned = stage.scanned;
    const page = readOwnedProbePage(db, context, provider, subject, { after: stage.cursor }, budget, FOLD_COLUMNS);
    for (const { row, at } of page) {
      fold(stage, row as Probe, subject, Date.parse(now));
      stage.cursor = { at, id: row.id };
    }
    stage.done = page.length < budget;
    saveStage(db, provider, subject, stage, now);
    count(db, "fold_rows", stage.scanned - scanned);
    return true;
  }
  return false;
}

function fold(stage: Stage, row: Probe, account: string, now: number): void {
  const at = Date.parse(row.ts);
  if (!Number.isFinite(at)) return;
  stage.scanned++;
  note(stage, row, at);
  const group = row.limit_group ?? "", scope = row.scope ?? "", window = row.window_minutes ?? -1;
  const key = JSON.stringify([normEraVendor(row.provider), account, row.kind, group, scope, window]);
  stage.keys[key] = true;
  if (at > now) stage.next = stage.next === null ? at : Math.min(stage.next, at);
  if (at > now + 300_000) stage.future = true;
  if (at > now) return;
  if (row.kind === "error" || (row.ok !== null && row.ok !== 1) || row.error !== null) {
    if (!stage.error || at > stage.error.time || (at === stage.error.time && row.id > stage.error.id))
      stage.error = { id: row.id, time: at, value: { measured_at: new Date(at).toISOString(), machine: row.machine, code: "probe-failed" } };
    return;
  }
  const usedPercent = finite(row.used_percent), remainingPercent = finite(row.remaining_percent);
  const signature = JSON.stringify([usedPercent, remainingPercent, row.used, row.allowance, row.remaining,
    row.rate_limit_reached, iso(row.resets_at)]);
  const limit: StoredLimit = {
    key, kind: row.kind, group: group || null, scope: scope || null, window_minutes: window < 0 ? null : window,
    plan: row.plan, measured_at: new Date(at).toISOString(), machine: row.machine,
    used_percent: usedPercent ?? (remainingPercent === null ? null : 100 - remainingPercent),
    remaining_percent: remainingPercent ?? (usedPercent === null ? null : 100 - usedPercent),
    used: finite(row.used), remaining: finite(row.remaining), allowance: finite(row.allowance), resets_at: iso(row.resets_at),
    rate_limit_reached: row.rate_limit_reached === null ? null : row.rate_limit_reached === 1,
    basis: "measured", conflicting: false,
  };
  const old = stage.winners[key];
  if (!old || at > old.time) stage.winners[key] = { id: row.id, time: at, signature, conflicting: false, limit };
  // The same reading folded twice (a period move over a card that holds it) changes nothing.
  else if (at === old.time && row.id !== old.id) {
    if (signature !== old.signature) old.conflicting = true;
    if (row.id > old.id) { old.id = row.id; old.limit = limit; }
  }
}
// The predicates of the account readers (`probe-account-reader.ts`), so cards answer what they answered.
const QUALIFIED = "(p.kind<>'error' AND (p.ok IS NULL OR p.ok=1))";
const MACHINE_FAILED = "(p.kind='error' OR p.ok=0)";
const qualified = (row: Probe) => row.kind !== "error" && (row.ok === null || row.ok === 1);
const newer = (mark: { at: number; id: number } | null, at: number, id: number) => !mark || at > mark.at || (at === mark.at && id > mark.id);
/** Activity and health of every reading, whatever its time or outcome. */
function note(stage: Stage, row: Probe, at: number): void {
  const mark: CardMark = { id: row.id, at, ts: row.ts }, { activity, health } = stage;
  if (!activity.first || row.ts < activity.first.ts) activity.first = mark;
  if (!activity.last || row.ts > activity.last.ts) activity.last = mark;
  const key = JSON.stringify(row.machine ?? null);
  const machine = health.machines[key] ??= { lo: at, hi: at, ok: null, err: null };
  machine.lo = Math.min(machine.lo, at); machine.hi = Math.max(machine.hi, at);
  if (qualified(row)) {
    if (newer(machine.ok, at, row.id)) machine.ok = mark;
    if (newer(health.success, at, row.id)) health.success = { ...mark, machine: row.machine };
  }
  if ((row.kind === "error" || row.ok === 0) && newer(machine.err, at, row.id)) machine.err = { ...mark, error: row.error };
}
/** Spans of computers that a removal of `[from, until)` touches. */
const touched = (spans: Iterable<[number, number]>, from: number, until: number) =>
  [...spans].filter(([lo, hi]) => lo < until && hi >= from).length;
/** Beyond this many touched spans a removal folds the account again instead of seeking each one. */
const MAX_HISTORY_SEEKS = 64;
function historyRepairTooWide(card: Stage, from: number, until: number): boolean {
  return touched(Object.values(card.health.machines).map(machine => [machine.lo, machine.hi] as [number, number]), from, until) > MAX_HISTORY_SEEKS;
}
/**
 * The card no longer holds readings of `[from, until)` (or reading `id`): activity and health that came
 * from there are sought again among the account's remaining readings by index, each within the span it
 * can still lie in. Returns whether anything changed.
 */
function repairHistory(db: Database, context: ProbeReadContext, provider: string, account: string, card: Stage,
  from: number, until: number, id?: number): boolean {
  const inside = (mark: CardMark | null) => mark !== null && (mark.id === id || (mark.at >= from && mark.at < until));
  const span = (lo: number, hi: number) => lo < until && hi >= from;
  const seek = (where: string, params: Array<string | number | null>, order: "asc" | "desc", bounds: { from?: number; until?: number }) => {
    const found = selectOwnedProbes(db, context, provider, account, { ...bounds, where, params, order, limit: 1, columns: FOLD_COLUMNS })[0];
    return found ? { row: found.row as Probe, mark: { id: found.row.id, at: found.at, ts: found.row.ts } as CardMark } : null;
  };
  const { activity, health } = card;
  let changed = false;
  if (inside(activity.first) || inside(activity.last)) {
    changed = true;
    activity.first = seek("1", [], "asc", {})?.mark ?? null;
    activity.last = seek("1", [], "desc", {})?.mark ?? null;
  }
  for (const [key, machine] of Object.entries(health.machines)) {
    const name = JSON.parse(key) as string | null;
    if (span(machine.lo, machine.hi)) {
      changed = true;
      const first = seek("p.machine IS ?", [name], "asc", { from: machine.lo, until: machine.hi + 1 });
      const last = first && seek("p.machine IS ?", [name], "desc", { from: machine.lo, until: machine.hi + 1 });
      if (!first || !last) { delete health.machines[key]; continue; }
      machine.lo = first.mark.at; machine.hi = last.mark.at;
    }
    if (inside(machine.ok)) {
      changed = true;
      machine.ok = seek(`${QUALIFIED} AND p.machine IS ?`, [name], "desc", { until: machine.ok!.at + 1 })?.mark ?? null;
    }
    if (inside(machine.err)) {
      changed = true;
      const found = seek(`${MACHINE_FAILED} AND p.machine IS ?`, [name], "desc", { until: machine.err!.at + 1 });
      machine.err = found && { ...found.mark, error: found.row.error };
    }
  }
  if (inside(health.success)) {
    changed = true;
    const found = seek(QUALIFIED, [], "desc", { until: health.success!.at + 1 });
    health.success = found && { ...found.mark, machine: found.row.machine };
  }
  return changed;
}
function emptyStage(): Stage {
  return { cursor: null, done: false, keys: {}, winners: {}, error: null, next: null, future: false, scanned: 0,
    activity: { first: null, last: null }, health: { success: null, machines: {} } };
}
function finished(stage: Stage): Published {
  const ordered = Object.keys(stage.keys).sort();
  const limits = ordered.slice(0, MAX_KEYS).flatMap(key => {
    const candidate = stage.winners[key];
    if (!candidate) return [];
    return candidate.conflicting ? { ...candidate.limit, conflicting: true, used_percent: null, remaining_percent: null,
      used: null, remaining: null, rate_limit_reached: null } : candidate.limit;
  }).sort((a, b) => b.measured_at.localeCompare(a.measured_at) || a.key.localeCompare(b.key));
  const newest = limits[0]?.measured_at ? Date.parse(limits[0].measured_at) : -Infinity;
  return { limits, latest_error: stage.error && stage.error.time >= newest ? stage.error.value : null,
    clock_warning: stage.future, limits_truncated: ordered.length > MAX_KEYS,
    next_refresh_at: stage.next === null ? null : new Date(stage.next).toISOString(),
    __keys: stage.keys, __winners: stage.winners, __error: stage.error, __next: stage.next,
    __activity: stage.activity, __health: stage.health };
}
function publish(db: Database, registry: CurrentIdentity[], fingerprint: string, now: string): boolean {
  if (!probeSourcesPublished(db)) return false;
  const dirtyRows = db.query("SELECT provider,subject FROM current_projection_dirty ORDER BY provider,subject")
    .all() as Array<{ provider: string; subject: string }>;
  const deltas = periodDeltas(db);
  const cohort = new Set([...JSON.parse(meta(db, "cohort") ?? "[]") as string[], ...periodMembers(deltas)]);
  const state = db.query("SELECT generated_at,config_fingerprint,probe_revision,published_probe_revision FROM current_projection_state WHERE id=1")
    .get() as { generated_at: string | null; config_fingerprint: string; probe_revision: number; published_probe_revision: number };
  let ready = dirtyRows.filter(row => stageOf(db, row.provider, row.subject)?.done === true);
  const readyMembers = new Set(ready.map(row => member(row.provider, row.subject)));
  const dirtyMembers = new Set(dirtyRows.map(row => member(row.provider, row.subject)));
  // A cohort swaps at once: every period move applied and every member's card ready.
  const cohortReady = deltas.every(delta => delta.done) && [...cohort].every(item => !dirtyMembers.has(item) || readyMembers.has(item));
  if (!cohortReady) ready = ready.filter(row => !cohort.has(member(row.provider, row.subject)));
  if (!state.generated_at && ready.length !== dirtyRows.length) return false;
  if (!dirtyRows.length && !cohort.size && state.generated_at && state.config_fingerprint === fingerprint) {
    if (state.probe_revision !== state.published_probe_revision)
      db.query("UPDATE current_projection_state SET published_probe_revision=probe_revision WHERE id=1").run();
    return false;
  }
  if (!ready.length && dirtyRows.length) return false;
  let changedAccounts = 0;
  for (const row of ready) {
    const value = finished(stageOf(db, row.provider, row.subject)!);
    const data = JSON.stringify(value);
    const previous = db.query("SELECT data FROM current_probe_subjects WHERE provider=? AND subject=?")
      .get(row.provider, row.subject) as { data: string } | null;
    if (previous?.data !== data) {
      db.query(`INSERT INTO current_probe_subjects(provider,subject,data,generated_at,next_refresh_at) VALUES(?,?,?,?,?)
        ON CONFLICT(provider,subject) DO UPDATE SET data=excluded.data,generated_at=excluded.generated_at,next_refresh_at=excluded.next_refresh_at`)
        .run(row.provider, row.subject, data, now, value.next_refresh_at);
      changedAccounts++;
    }
    db.query("DELETE FROM current_probe_subjects WHERE provider=? AND subject=?").run(row.provider, STAGE + row.subject);
    db.query("DELETE FROM current_projection_dirty WHERE provider=? AND subject=?").run(row.provider, row.subject);
  }
  if (cohort.size && cohortReady) { put(db, "cohort", "[]"); put(db, "period_deltas", "[]"); }
  const remaining = (db.query("SELECT count(*) AS n FROM current_projection_dirty").get() as { n: number }).n;
  const registryHash = registryFingerprint(registry), registryChanged = meta(db, "registry_fingerprint") !== registryHash;
  if (registryChanged) {
    db.exec("DELETE FROM subscription_current");
    const insert = db.query("INSERT INTO subscription_current(id,data) VALUES(?,?)");
    for (const row of registry) insert.run(row.id, JSON.stringify(row));
    put(db, "registry_fingerprint", registryHash);
  }
  if (!changedAccounts && !registryChanged && (remaining || state.config_fingerprint === fingerprint)) {
    if (!remaining) db.query("UPDATE current_projection_state SET published_probe_revision=probe_revision WHERE id=1").run();
    return ready.length > 0;
  }
  db.query(`UPDATE current_projection_state SET generation=generation+1,config_fingerprint=?,generated_at=?,
    published_probe_revision=CASE WHEN ?=0 THEN probe_revision ELSE published_probe_revision END,error_code=NULL WHERE id=1`)
    .run(remaining ? state.config_fingerprint : fingerprint, now, remaining);
  return true;
}

/** Starts the projection over: cards are folded again; the readings' evidence does not depend on it and stays. */
function reset(db: Database, registry: CurrentIdentity[], declarations: readonly SourceDeclaration[],
  physical: CurrentPhysicalConfig, corrections: readonly ProbeSourceCorrection[]): void {
  for (const name of ["probe_current_after_insert", "probe_current_after_update", "probe_current_after_delete"])
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`CREATE TRIGGER probe_current_after_insert AFTER INSERT ON probe_windows BEGIN
    UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;
    CREATE TRIGGER probe_current_after_update AFTER UPDATE ON probe_windows BEGIN
    UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;
    CREATE TRIGGER probe_current_after_delete AFTER DELETE ON probe_windows BEGIN
    UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;`);
  db.exec("DELETE FROM current_probe_subjects; DELETE FROM current_projection_dirty");
  // The evidence revision counter outlives a reset: stamps derived from it must keep moving forward.
  db.query("DELETE FROM meta WHERE key LIKE ? AND key<>?").run(`${PREFIX}%`, `${PREFIX}source_revision`);
  // Ownership may have changed for every reading: every account's limit windows are recomputed.
  for (const provider of usageProviderIds()) markLimitWindowsDirty(db, provider, ALL_ACCOUNTS, LIMIT_WINDOW_ALL);
  put(db, "definitions", definitions(declarations, physical));
  put(db, "declarations", JSON.stringify(declarations));
  put(db, "probe_source_corrections", JSON.stringify(corrections));
  put(db, "key_format", KEY_FORMAT);
  put(db, "card_format", CARD_FORMAT);
  markAllCurrentAccountsDirty(db, registry);
  db.query(`UPDATE current_projection_state SET schema_version=2, generated_at=NULL, config_fingerprint='',
    published_probe_revision=0, error_code=NULL WHERE id=1`).run();
}

/** One bounded writer transaction: evidence, then period moves, then a page of a full fold, then publication. */
export function publishCurrentV2(db: Database, registry: CurrentIdentity[], supplied: readonly SourceDeclaration[] | undefined,
  now: string, batchSize: number, physical: CurrentPhysicalConfig = DEFAULT_PHYSICAL): boolean {
  const budget = Math.max(1, Math.min(10_000, batchSize));
  const corrections = readProbeSourceCorrections(physical.configRoot ?? CONFIG_ROOT);
  return db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    ensureProbeSourcesSchema(db);
    const stored = meta(db, "definitions");
    const storedDeclarations = JSON.parse(meta(db, "declarations") ?? "[]") as SourceDeclaration[];
    const declarations = supplied ?? storedDeclarations;
    const version = (db.query("SELECT schema_version FROM current_projection_state WHERE id=1").get() as { schema_version: number }).schema_version;
    const location = stored ? JSON.parse(stored) as [string, string, unknown] : null;
    if (version !== 2 || meta(db, "key_format") !== KEY_FORMAT || !location
      || location[0] !== physical.archiveRoot || location[1] !== physical.defaultLogin) {
      reset(db, registry, declarations, physical, corrections);
    } else {
      const storedCorrections = JSON.parse(meta(db, "probe_source_corrections") ?? "[]") as ProbeSourceCorrection[];
      if (stored !== definitions(declarations, physical) || JSON.stringify(storedCorrections) !== JSON.stringify(corrections)) {
        const options = (rows: readonly SourceDeclaration[], fixes: readonly ProbeSourceCorrection[]): ProbeSourceOptions =>
          ({ declarations: rows, archiveRoot: physical.archiveRoot, defaultLogin: physical.defaultLogin, corrections: fixes });
        sourcesChanged(db, options(storedDeclarations, storedCorrections), options(declarations, corrections));
        put(db, "definitions", definitions(declarations, physical));
        put(db, "declarations", JSON.stringify(declarations));
        put(db, "probe_source_corrections", JSON.stringify(corrections));
      }
    }
    // Cards of an older format fold again in the background; the readings' evidence and limit windows stay.
    if (meta(db, "card_format") !== CARD_FORMAT) {
      markAllCurrentAccountsDirty(db, registry);
      for (const row of db.query("SELECT provider,subject FROM current_projection_dirty").all() as Array<{ provider: string; subject: string }>)
        refold(db, row.provider, row.subject);
      put(db, "card_format", CARD_FORMAT);
    }
    const context = probeReadContext(db);
    const fingerprint = currentConfigFingerprint(registry, declarations, physical);
    const state = db.query("SELECT config_fingerprint FROM current_projection_state WHERE id=1").get() as { config_fingerprint: string };
    if (state.config_fingerprint !== fingerprint && meta(db, "pending_fingerprint") !== fingerprint) {
      const previous = new Map((db.query("SELECT id,data FROM subscription_current").all() as Array<{ id: string; data: string }>)
        .map(row => [row.id, JSON.parse(row.data) as CurrentIdentity]));
      for (const row of registry)
        if (previous.get(row.id)?.vendor !== row.vendor) refold(db, row.vendor, row.id);
      put(db, "pending_fingerprint", fingerprint);
    }
    db.query(`INSERT OR IGNORE INTO current_projection_dirty(provider,subject)
      SELECT provider,subject FROM current_probe_subjects WHERE subject NOT LIKE ?
      AND next_refresh_at IS NOT NULL AND next_refresh_at<=?`).run(STAGE + "%", now);
    // New readings join their cards and publish in the same pass; the first fill writes evidence alone.
    const wrote = writeProbeSources(db, context, budget, now);
    if (!probeSourcesPublished(db)) return wrote;
    const moved = processPeriodDeltas(db, context, now, budget);
    const folded = nextStage(db, context, now, budget);
    const published = publish(db, registry, fingerprint, now);
    return wrote || moved || folded || published;
  }).immediate();
}
