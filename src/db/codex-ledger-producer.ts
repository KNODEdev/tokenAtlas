import { createHash } from "node:crypto";
import type { Database } from "./sqlite";
import { codexLedgerBandRevision, valueCodexLedgerBand, rebuildCodexLedgerPartitions, rebuildCodexLedgerDay, retimeCodexLedgerDays,
  reactivityCodexLedgerDays, regapCodexLedgerCopies, type LedgerAggregatePartition, type LedgerBaseBand } from "./codex-price-ledger";
import { markCodexConversationsDirty, markCodexDaysDirty, markCodexResponsePartnersDirty, resolveCodexConversation } from "./codex-ledger-canonical";
import { registerCodexCopy, writeCodexCopyEvents, type LedgerCopyAnchor } from "./codex-ledger-copies";
import { beginCodexLedgerFill, codexLedgerFillProgress, codexLedgerFillState, stepCodexLedgerFill, type CodexLedgerFillProgress } from "./codex-ledger-fill";
import type { CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { codexLedgerBaseChanges } from "./codex-ledger-dependencies";
import { CODEX_LEDGER_PROVIDER, CODEX_LEDGER_VERSION, codexCopyWork, codexLedgerQueuedBands, codexLedgerWork, codexLedgerWorkCounts,
  codexLedgerWorkPending, queueCodexLedgerWork, readCodexLedgerState, rulesWork, scopeOf, takeCodexLedgerWork, type RulesWork } from "./codex-ledger-state";

/**
 * The Codex price ledger producer. Its inputs are `events` and the copy registry; its queue
 * (codex-ledger-state.ts) holds changed copies (a publication or a project remap names them), rule
 * scopes (a price from a date), conversations whose copies must be resolved, copies whose activity gaps
 * must be recomputed, days whose sums must be rebuilt and days whose activity sums alone must be re-summed,
 * drained in that order. An empty ledger is filled by codex-ledger-fill.ts first. Every
 * step is one short transaction; the ledger is ready when nothing is left.
 */
const BLOCKED_COPY_REASON = "No verified archive/source binding; preserve accepted facts";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)).digest("hex");
/** Copies and calls one activity-gap step takes at most (the first copy always). */
const SESSION_COPIES = 64, SESSION_CALLS = 5_000;
function transactionRequired(db: Database): void { if (!db.inTransaction) throw new Error("Ledger queue notification requires the producer transaction"); }

export interface LedgerDirtyCopy { home: string; path: string }
/** Source facts and their dirty notification are one commit; untouched providers never enqueue Codex work. */
export function markCodexLedgerCopiesDirty(db: Database, copies: readonly LedgerDirtyCopy[]): void {
  transactionRequired(db);
  const values = new Set<string>();
  for (const copy of copies) {
    if (typeof copy.home !== "string" || !copy.home || typeof copy.path !== "string" || !copy.path) throw new Error("Source copy locator is required");
    values.add(codexCopyWork(copy.home, copy.path));
  }
  // A blocked copy named again is tried again.
  for (const value of values) takeCodexLedgerWork(db, "blocked", value);
  queueCodexLedgerWork(db, "copy", values);
}

export interface LedgerProducerOptions {
  bands: readonly LedgerBaseBand[]; factsRevision: number; rulesRevision: string; policy?: CodexLedgerPolicy;
  /** Where a physical transcript sits in the archive; null when its home has no archive binding (the copy waits). */
  anchorOf(home: string | null, path: string): LedgerCopyAnchor | null;
  batchSize?: number;
  /** Time a batch may take (steps stop once it has passed; the first step always runs). */
  budgetMs?: number;
  policyIsCurrent?(): boolean;
}
const bandKey = (band: LedgerBaseBand) => JSON.stringify([band.id, band.band]);
function basePolicyRevision(bands: readonly LedgerBaseBand[]): string {
  return hash(bands.map(band => [band.id, band.band, codexLedgerBandRevision(band)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
/**
 * Revisions are derived once per band list: the background writer passes the same compiled bands every turn, and
 * every step, even one that finds nothing to do, checks the stored bands against them. Deriving both took most of
 * an idle Codex turn.
 */
const bandRevisions = new WeakMap<readonly LedgerBaseBand[], string>();
function preparedPolicyRevision(bands: readonly LedgerBaseBand[]): string {
  let revision = bandRevisions.get(bands);
  if (revision === undefined) bandRevisions.set(bands, revision = basePolicyRevision(bands));
  return revision;
}
let storedBands: { text: string; revision: string } | null = null;
function storedPolicyRevision(db: Database): string {
  const rows = db.query(`SELECT rates FROM usage_ledger_keys WHERE provider='${CODEX_LEDGER_PROVIDER}'`).all() as { rates: string }[];
  const text = rows.map(row => row.rates).join("\n");
  if (storedBands?.text !== text) storedBands = { text, revision: basePolicyRevision(rows.map(row => JSON.parse(row.rates) as LedgerBaseBand)) };
  return storedBands.revision;
}
function guardRulePolicy(db: Database, options: LedgerProducerOptions, expectedBaseRevision: string): void {
  if (storedPolicyRevision(db) !== expectedBaseRevision || options.policyIsCurrent && options.policyIsCurrent() !== true)
    throw new Error("Prepared Codex rule policy is stale");
}
export interface LedgerProducerProgress {
  progressed: boolean;
  processed: number; resolved: number; repricedApi: number; repricedCredits: number; aggregatePartitions: number;
  pending: number; ready: boolean;
  /** Copies waiting for an archive binding, with the first ones named. */
  blockedTotal: number; blocked: Array<{ home: string; path: string; reason: string }>;
}
/** What the Codex ledger still has to do, for the progress register: a fill from empty, changed source files, then sums and rule work. */
export function codexLedgerBacklog(db: Database): { fill: CodexLedgerFillProgress | null; files: number; aggregates: number } | null {
  const state = readCodexLedgerState(db);
  if (!state) return null;
  const counts = codexLedgerWorkCounts(db);
  return { fill: codexLedgerFillProgress(db), files: counts.copy + counts.blocked,
    aggregates: counts.rules + counts.identity + counts.day + counts.session + counts.activity };
}
export function readCodexLedgerProducerProgress(db: Database): LedgerProducerProgress {
  const counts = codexLedgerWorkCounts(db), state = readCodexLedgerState(db);
  const pending = Object.values(counts).reduce((sum, count) => sum + count, 0) + (codexLedgerFillState(db) ? 1 : 0);
  const blocked = codexLedgerWork(db, "blocked", 20).map(value => {
    const [home, path] = JSON.parse(value) as [string, string];
    return { home, path, reason: BLOCKED_COPY_REASON };
  });
  return { progressed: false, processed: 0, resolved: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0, pending,
    blockedTotal: counts.blocked, blocked, ready: pending === 0 && state?.status === "ready" };
}
/**
 * Fingerprints contain only actual base dependencies, so tier/provenance edits queue no token pricing. The
 * rules are published at once when no rule scope is queued; otherwise when the last one is revalued.
 */
export function enqueueCodexLedgerRuleChanges(db: Database, options: { bands: readonly LedgerBaseBand[]; rulesRevision: string; policy?: CodexLedgerPolicy; policyIsCurrent?(): boolean }): number {
  return db.transaction(() => {
    if (options.policyIsCurrent && options.policyIsCurrent() !== true) throw new Error("Prepared Codex rule policy is stale");
    const next = new Map(options.bands.map(input => {
      const { id, model, basis, validFrom, validUntil, band, threshold, rates, multiplier, evidence } = input;
      return [bandKey(input), { id, model, basis, validFrom, validUntil, band, threshold, rates, multiplier, evidence } as LedgerBaseBand] as const;
    }));
    let count = 0;
    const scopes = codexLedgerBaseChanges(codexLedgerQueuedBands(db), [...next.values()]);
    const published = db.query("SELECT 1 FROM codex_price_ledger_events LIMIT 1").get();
    if (published && scopes.length) {
      // A scope queued again starts over.
      const queued = new Set(scopes.map(scope => rulesWork(scope, -1)));
      for (const value of codexLedgerWork(db, "rules", Number.MAX_SAFE_INTEGER))
        if (queued.has(rulesWork(scopeOf(JSON.parse(value) as RulesWork), -1))) takeCodexLedgerWork(db, "rules", value);
      queueCodexLedgerWork(db, "rules", queued);
      count = queued.size;
    }
    // The bands are rewritten only when they changed: a turn with the same policy writes nothing here.
    const stored = new Map((db.query(`SELECT key,rates FROM usage_ledger_keys WHERE provider='${CODEX_LEDGER_PROVIDER}'`).all() as
      Array<{ key: string; rates: string }>).map(row => [row.key, row.rates]));
    if (stored.size !== next.size || [...next].some(([key, band]) => stored.get(key) !== JSON.stringify(band))) {
      db.query(`DELETE FROM usage_ledger_keys WHERE provider='${CODEX_LEDGER_PROVIDER}'`).run();
      const save = db.query(`INSERT INTO usage_ledger_keys(provider,key,rates) VALUES('${CODEX_LEDGER_PROVIDER}',?,?)`);
      for (const [key, band] of next) save.run(key, JSON.stringify(band));
    }
    if (!codexLedgerWorkPending(db, ["rules"])) publishRules(db, options);
    if (options.policyIsCurrent && options.policyIsCurrent() !== true) throw new Error("Prepared Codex rule policy is stale");
    return count;
  }).immediate();
}
/** The rule revision and policy readers compile the published values with. */
function publishRules(db: Database, options: { rulesRevision: string; policy?: CodexLedgerPolicy }): void {
  db.query(`UPDATE usage_ledger_state SET rules_digest=?1,rules_json=COALESCE(?2,rules_json)
    WHERE provider='${CODEX_LEDGER_PROVIDER}' AND (rules_digest IS NOT ?1 OR ?2 IS NOT NULL AND rules_json IS NOT ?2)`)
    .run(options.rulesRevision, options.policy ? JSON.stringify(options.policy) : null);
}
interface StoredEvent { id: number; dim_id: number; day: string; instant_ms: number | null; admitted: number }
function partitions(event: Pick<StoredEvent, "day" | "dim_id" | "instant_ms" | "admitted">): LedgerAggregatePartition[] {
  if (!event.admitted) return [];
  return [{ day: event.day, dimId: event.dim_id, hour: null }, ...(event.instant_ms === null ? []
    : [{ day: event.day, dimId: event.dim_id, hour: Math.floor(event.instant_ms / 3600000) }])];
}
function reprice(db: Database, bands: readonly LedgerBaseBand[], ids: readonly number[], basis: "api_equivalent_usd" | "chatgpt_credits"): number {
  if (!ids.length) return 0;
  const prefix = basis === "chatgpt_credits" ? "credit" : "api";
  db.query(`UPDATE codex_price_ledger_events SET ${prefix}_band=0,${prefix}_whole=NULL,${prefix}_fraction_hi=NULL,${prefix}_fraction_lo=NULL,
    ${prefix}_reason=COALESCE(common_reason,${basis === "chatgpt_credits" ? "CASE WHEN cache_write>0 THEN 'cache_write_semantics_unknown' ELSE 'missing_rate' END" : "'missing_rate'"})
    WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  let priced = 0;
  const dependencies = db.query(`SELECT d.model,MIN(e.day) from_day,MAX(e.day) until_day FROM codex_price_ledger_events e
    JOIN codex_price_ledger_dims d ON d.id=e.dim_id WHERE e.id IN (${ids.map(() => "?").join(",")}) GROUP BY d.model`).all(...ids) as { model: string | null; from_day: string; until_day: string }[];
  for (const band of bands) if (band.basis === basis && dependencies.some(scope => scope.model === band.model
    && scope.until_day >= band.validFrom && (!band.validUntil || scope.from_day < band.validUntil))) {
    priced += valueCodexLedgerBand(db, band, ids);
  }
  return priced;
}
/** Internal steps report existence only; the public bounded batch reads exact counters once. */
function readStepProgress(db: Database): LedgerProducerProgress {
  const pending = codexLedgerWorkPending(db) || codexLedgerFillState(db) ? 1 : 0;
  return { progressed: false, processed: 0, resolved: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0,
    pending, blockedTotal: 0, blocked: [], ready: pending === 0 && readCodexLedgerState(db)?.status === "ready" };
}
/**
 * Publishes the ledger once nothing is left: ready under this algorithm, at the facts revision and rules of this
 * batch. A step that did work, or a head that differs, moves the revision; an idle check writes nothing.
 */
function finish(db: Database, options: LedgerProducerOptions, expectedBaseRevision: string, worked: boolean): void {
  guardRulePolicy(db, options, expectedBaseRevision);
  if (codexLedgerWorkPending(db) || codexLedgerFillState(db)) return;
  const state = readCodexLedgerState(db);
  if (!state) return;
  const policy = options.policy ? JSON.stringify(options.policy) : null;
  if (!worked && state.status === "ready" && state.version === CODEX_LEDGER_VERSION && state.covered === options.factsRevision
    && state.rules_digest === options.rulesRevision && (policy === null || state.rules_json === policy) && state.activity_published) return;
  // Nothing is queued: every copy's gaps and every day's activity sums are current, so activity is published too.
  db.query(`UPDATE usage_ledger_state SET status='ready',phase='reconcile',bookmark='',version=?,covered=?,rules_digest=?,
    rules_json=COALESCE(?,rules_json),revision=revision+1,published_revision=revision+1,activity_published=1 WHERE provider='${CODEX_LEDGER_PROVIDER}'`)
    .run(CODEX_LEDGER_VERSION, options.factsRevision, options.rulesRevision, policy);
}

/** Each source step retains its short atomic commit and restart cursor. */
function processCodexLedgerStep(db: Database, options: LedgerProducerOptions, expectedBaseRevision: string): LedgerProducerProgress {
  guardRulePolicy(db, options, expectedBaseRevision);
  if (db.inTransaction) throw new Error("Ledger worker owns its short producer transaction");
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("Ledger batch size must be 1..5000");
  // A ledger built while its source was empty (a first import starts the server on an empty database) has
  // no calls but a copy queued for every imported file: it starts over as a fill, which writes them set-based
  // instead of one copy per step.
  if (!codexLedgerFillState(db) && !db.query("SELECT 1 FROM codex_price_ledger_events LIMIT 1").get() && codexLedgerWorkPending(db, ["copy", "blocked"]))
    db.transaction(() => {
      db.exec(`DELETE FROM usage_ledger_state WHERE provider='${CODEX_LEDGER_PROVIDER}';
        DELETE FROM usage_ledger_dirty WHERE provider='${CODEX_LEDGER_PROVIDER}' AND kind IN ('identity','day','session','activity')`);
    }).immediate();
  // An empty ledger is filled first, set-based; only then do single copies and rules run.
  if (beginCodexLedgerFill(db, options.factsRevision, options.rulesRevision)) {
    const handled = stepCodexLedgerFill(db, options);
    return { ...readStepProgress(db), progressed: true, processed: handled };
  }
  // Copies first, then rule scopes, then identities of the conversations they touched, then the sums of the days whose canonical set moved.
  const copy = codexLedgerWork(db, "copy", 1)[0];
  if (copy !== undefined) {
    const [home, path] = JSON.parse(copy) as [string | null, string];
    const anchor = options.anchorOf(home, path);
    return db.transaction(() => {
      if (!takeCodexLedgerWork(db, "copy", copy)) throw new Error("Prepared Codex source dependency is stale");
      if (!anchor) {
        queueCodexLedgerWork(db, "blocked", [copy]);
        return { ...readStepProgress(db), progressed: true };
      }
      // A changed copy: its calls are written again from `events`, valued, and its conversation and days queued.
      const id = registerCodexCopy(db, home, path, anchor);
      const written = writeCodexCopyEvents(db, [id], options.bands);
      // The conversation is resolved again even when no stored value changed: a response id lives only in `events`.
      const conversation = db.query("SELECT conversation FROM codex_price_ledger_copies WHERE id=?").get(id) as { conversation: string | null };
      if (conversation.conversation) markCodexConversationsDirty(db, [conversation.conversation]);
      markCodexResponsePartnersDirty(db, written.removed);
      markCodexDaysDirty(db, written.days);
      if (written.changed) queueCodexLedgerWork(db, "session", [String(id)]);
      // Days with only new response times: their timed sums now, nothing else (a day queued above is rebuilt whole).
      retimeCodexLedgerDays(db, [...written.retimed].filter(day => !written.days.has(day)));
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, processed: Math.max(1, written.changed) };
    }).immediate();
  }
  const rules = codexLedgerWork(db, "rules", 1)[0];
  if (rules !== undefined) {
    const work = JSON.parse(rules) as RulesWork;
    const args: (string | number)[] = [work.model, work.fromDay, work.after];
    const until = work.untilDay ? " AND e.day<?" : "";
    if (work.untilDay) args.push(work.untilDay);
    const context = (work.inputAbove !== null ? " AND e.in_tok>?" : "") + (work.inputUntil !== null ? " AND e.in_tok<=?" : "");
    if (work.inputAbove !== null) args.push(work.inputAbove);
    if (work.inputUntil !== null) args.push(work.inputUntil);
    args.push(batchSize);
    const rows = db.query(`SELECT e.id,e.day,e.dim_id,e.instant_ms,e.admitted FROM codex_price_ledger_events e
      JOIN codex_price_ledger_dims d ON d.id=e.dim_id WHERE d.model=? AND e.day>=? AND e.id>?${until}${context} ORDER BY e.id LIMIT ?`).all(...args) as StoredEvent[];
    return db.transaction(() => {
      if (!takeCodexLedgerWork(db, "rules", rules)) throw new Error("Prepared Codex rule dependency is stale");
      const ids = rows.map(row => row.id), count = reprice(db, options.bands, ids, work.basis);
      const grouped = rebuildCodexLedgerPartitions(db, rows.flatMap(partitions));
      if (rows.length === batchSize) queueCodexLedgerWork(db, "rules", [rulesWork(scopeOf(work), rows.at(-1)!.id)]);
      else if (!codexLedgerWorkPending(db, ["rules"])) publishRules(db, options);
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, processed: rows.length, aggregatePartitions: grouped,
        repricedApi: work.basis === "api_equivalent_usd" ? count : 0, repricedCredits: work.basis === "chatgpt_credits" ? count : 0 };
    }).immediate();
  }
  return db.transaction(() => {
    const conversation = codexLedgerWork(db, "identity", 1)[0];
    if (conversation !== undefined) {
      const resolution = resolveCodexConversation(db, conversation);
      markCodexDaysDirty(db, resolution.days);
      queueCodexLedgerWork(db, "session", [...resolution.copies].map(String));
      takeCodexLedgerWork(db, "identity", conversation);
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, resolved: Math.max(1, resolution.events) };
    }
    // Gaps before day sums, so a rebuilt day sums its calls' current gaps; a copy holds from one call to tens of thousands.
    const queued = codexLedgerWork(db, "session", SESSION_COPIES);
    if (queued.length) {
      const calls = new Map((db.query(`SELECT copy_id id, COUNT(*) n FROM codex_price_ledger_events WHERE copy_id IN (SELECT value FROM json_each(?))
        GROUP BY copy_id`).all(JSON.stringify(queued.map(Number))) as { id: number; n: number }[]).map(row => [String(row.id), row.n]));
      const copies: string[] = [];
      let total = 0;
      for (const copy of queued) {
        const n = calls.get(copy) ?? 0;
        if (copies.length && total + n > SESSION_CALLS) break;
        copies.push(copy); total += n;
      }
      const days = regapCodexLedgerCopies(db, copies.map(Number));
      queueCodexLedgerWork(db, "activity", days);
      for (const copy of copies) takeCodexLedgerWork(db, "session", copy);
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, resolved: Math.max(1, total) };
    }
    const day = codexLedgerWork(db, "day", 1)[0];
    if (day !== undefined) {
      const partitionsBuilt = rebuildCodexLedgerDay(db, day);
      const resolved = Math.max(1, (db.query("SELECT COUNT(*) n FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_day WHERE day=?")
        .get(day) as { n: number }).n);
      takeCodexLedgerWork(db, "day", day);
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, resolved, aggregatePartitions: partitionsBuilt };
    }
    const activity = codexLedgerWork(db, "activity", 1)[0];
    if (activity !== undefined) {
      reactivityCodexLedgerDays(db, [activity]);
      takeCodexLedgerWork(db, "activity", activity);
      finish(db, options, expectedBaseRevision, true);
      return { ...readStepProgress(db), progressed: true, resolved: 1 };
    }
    finish(db, options, expectedBaseRevision, false);
    return readStepProgress(db);
  }).immediate();
}
/** Batch by event count across tiny files; completed source steps remain independently durable. */
export function processCodexLedgerBatch(db: Database, options: LedgerProducerOptions): LedgerProducerProgress {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("Ledger batch size must be 1..5000");
  if (db.inTransaction) throw new Error("Ledger worker owns its short producer transaction");
  const expectedBaseRevision = preparedPolicyRevision(options.bands);
  let processed = 0, resolved = 0, repricedApi = 0, repricedCredits = 0, aggregatePartitions = 0, progressed = false;
  const until = performance.now() + (options.budgetMs ?? Infinity);
  // Empty and blocked steps also have a finite budget, without losing their durable state.
  for (let step = 0; step < 1000 && processed + resolved < batchSize && (step === 0 || performance.now() < until); step++) {
    const result = processCodexLedgerStep(db, { ...options, batchSize: batchSize - processed - resolved }, expectedBaseRevision);
    processed += result.processed; resolved += result.resolved; repricedApi += result.repricedApi; repricedCredits += result.repricedCredits;
    aggregatePartitions += result.aggregatePartitions; progressed ||= result.progressed;
    if (!result.progressed || result.ready) break;
  }
  return { ...readCodexLedgerProducerProgress(db), progressed, processed, resolved, repricedApi, repricedCredits, aggregatePartitions };
}
