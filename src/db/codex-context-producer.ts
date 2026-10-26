import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "./sqlite";
import { readCodexLedgerPublishedBand } from "./codex-price-ledger";
import { codexContextRequestValues } from "./codex-context-values";
import { add, rational, readNanoParts, type Rational } from "./price-ledger-exact";
import type { CompiledCodexLedgerPolicy, LedgerBaseRule } from "../server/codex-ledger-policy";
import { codexLedgerWorkPending } from "./codex-ledger-state";

export const CODEX_CONTEXT_VERSION = 1;
export interface ContextState {
  version: number; cursor: number; filled: number; source_revision: number; covered_revision: number;
  rules_json: string; generation: number; revision: number;
}
export function readCodexContextState(db: Database): ContextState | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='codex_context_state'").get()) return null;
  return db.query("SELECT * FROM codex_context_state WHERE singleton=1").get() as ContextState | null;
}
export function codexContextPending(db: Database, state = readCodexContextState(db)): boolean {
  if (!state) return true;
  const published = db.query("SELECT rules_json FROM usage_ledger_state WHERE provider='codex'").get() as { rules_json: string | null } | null;
  return state.version !== CODEX_CONTEXT_VERSION || !state.filled || state.source_revision !== state.covered_revision ||
    codexLedgerWorkPending(db, ["rules"]) ||
    !published?.rules_json || state.rules_json !== contextPolicyRulesJson(JSON.parse(published.rules_json)) ||
    !!db.query("SELECT 1 FROM codex_context_work LIMIT 1").get() || !!db.query("SELECT 1 FROM codex_context_dirty LIMIT 1").get();
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rulesOf = (policy: CompiledCodexLedgerPolicy) => policy.policy.base_rules
  .filter(rule => rule.billing_basis === "api_equivalent_usd").slice().sort((a, b) => a.id.localeCompare(b.id));
export function contextPolicyRulesJson(policy: import("../server/codex-ledger-policy").CodexLedgerPolicy): string {
  return JSON.stringify(policy.base_rules.filter(rule => rule.billing_basis === "api_equivalent_usd").slice().sort((a, b) => a.id.localeCompare(b.id)));
}
// Dates select a rule; its value/provenance revision does not change when an adjacent interval is edited.
export function contextRuleRevision(rule: LedgerBaseRule | null): string {
  if (!rule) return "missing_rate";
  const { valid_from: _from, valid_until: _until, ...value } = rule;
  return hash(value);
}
interface RuleScope { model: string; from_day: string; until_day: string; cursor: number }
function changedScopes(before: LedgerBaseRule[], after: LedgerBaseRule[]): RuleScope[] {
  const scopes: RuleScope[] = [];
  for (const model of new Set([...before, ...after].map(rule => rule.model))) {
    const left = before.filter(rule => rule.model === model), right = after.filter(rule => rule.model === model);
    const cuts = [...new Set([...left, ...right].flatMap(rule => [rule.valid_from, ...(rule.valid_until ? [rule.valid_until] : [])]))].sort();
    const revision = (rules: LedgerBaseRule[], day: string) => contextRuleRevision(rules.find(rule =>
      rule.valid_from <= day && (!rule.valid_until || day < rule.valid_until)) ?? null);
    for (let i = 0; i < cuts.length; i++) if (revision(left, cuts[i]!) !== revision(right, cuts[i]!))
      scopes.push({ model, from_day: cuts[i]!, until_day: cuts[i + 1] ?? "9999-12-32", cursor: -1 });
  }
  return scopes;
}

export interface ContextEvent {
  event_id: number; dim_id: number; day: string; hour: number | null; cohort: string;
  source_revision: string; rule_revision: string; included: number; reason: string | null;
  base_n: string | null; base_d: string | null; extra_n: string | null; extra_d: string | null;
  stored_n: string | null; stored_d: string | null; tokens: string; long_tokens: string;
}
export interface ContextAggregate extends Omit<ContextEvent, "event_id" | "source_revision"> {
  key: string; grain: "day" | "hour"; hour: number; calls: number;
  base_n: string; base_d: string; extra_n: string; extra_d: string; stored_n: string; stored_d: string;
}
interface SourceEvent {
  id: number; dim_id: number; day: string; instant_ms: number | null; admitted: number; copy_state: string;
  model: string | null; service_tier: string | null; in_tok: unknown; common_reason: string | null;
  invalid_tokens: number; reported: string; uncached: number; cached: number; writes: number; output: number;
  api_band: number; credit_band: number; api_reason: string | null; credit_reason: string | null;
  api_whole: string | null; api_fraction_hi: string | null; api_fraction_lo: string | null;
  credit_zero: number;
}
const sourceSql = `SELECT e.id,e.dim_id,e.day,e.instant_ms,e.admitted,e.copy_state,d.model,d.service_tier,
  e.in_tok,e.common_reason,e.invalid_tokens,CAST(e.reported AS TEXT) reported,e.uncached,e.cached,e.writes,e.output,
  e.api_band,e.credit_band,e.api_reason,e.credit_reason,CAST(e.api_whole AS TEXT) api_whole,
  CAST(e.api_fraction_hi AS TEXT) api_fraction_hi,CAST(e.api_fraction_lo AS TEXT) api_fraction_lo,
  CASE WHEN e.credit_reason IS NULL AND e.credit_whole=0 AND e.credit_fraction_hi=0 AND e.credit_fraction_lo=0 THEN 1 ELSE 0 END credit_zero
  FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id`;
const columns = ["event_id", "dim_id", "day", "hour", "cohort", "source_revision", "rule_revision", "included", "reason",
  "base_n", "base_d", "extra_n", "extra_d", "stored_n", "stored_d", "tokens", "long_tokens"] as const;
const aggregateColumns = ["key", "grain", "day", "hour", "dim_id", "cohort", "rule_revision", "included", "reason", "calls",
  "tokens", "long_tokens", "base_n", "base_d", "extra_n", "extra_d", "stored_n", "stored_d"] as const;
const parts = (value: Rational | null) => value === null ? [null, null] as const : [String(value.n), String(value.d)] as const;
export function contextAmount(row: Pick<ContextEvent, "base_n" | "base_d" | "extra_n" | "extra_d" | "stored_n" | "stored_d">,
  basis: "base" | "extra" | "stored"): Rational | null {
  const n = row[`${basis}_n`], d = row[`${basis}_d`];
  return n === null || d === null ? null : rational(BigInt(n), BigInt(d));
}
function project(db: Database, policy: CompiledCodexLedgerPolicy, event: SourceEvent,
  bands: Map<number, ReturnType<typeof readCodexLedgerPublishedBand>>): ContextEvent | null {
  if (event.copy_state !== "canonical" || !event.admitted) return null;
  let band = bands.get(event.api_band);
  if (band === undefined) { band = readCodexLedgerPublishedBand(db, event.api_band); bands.set(event.api_band, band); }
  const stored = !event.api_reason && band && event.api_whole !== null && event.api_fraction_hi !== null && event.api_fraction_lo !== null
    ? readNanoParts({ whole: BigInt(event.api_whole), fraction_hi: BigInt(event.api_fraction_hi), fraction_lo: BigInt(event.api_fraction_lo) }, band.coefficients.denominator) : null;
  const values = codexContextRequestValues(policy, { model: event.model, day: event.day, input: event.in_tok,
    invalid: event.invalid_tokens > 0, reason: event.common_reason,
    tokens: { in_uncached: BigInt(event.uncached), in_cache_read: BigInt(event.cached), in_cache_write: BigInt(event.writes), out_total: BigInt(event.output) } });
  const [base_n, base_d] = parts(values.base), [extra_n, extra_d] = parts(values.extra), [stored_n, stored_d] = parts(stored);
  return { event_id: event.id, dim_id: event.dim_id, day: event.day,
    hour: event.instant_ms === null ? null : Math.floor(event.instant_ms / 3_600_000),
    cohort: JSON.stringify([event.api_band, event.credit_band, event.api_reason ?? "", event.credit_reason ?? "",
      stored?.n === 0n ? 1 : 0, event.credit_zero, event.copy_state]),
    source_revision: hash(event), rule_revision: contextRuleRevision(policy.resolveBaseRule(event.model, "api_equivalent_usd", event.day)),
    included: band?.band === "long" ? 1 : 0, reason: values.reason ?? (stored === null ? `stored_${event.api_reason ?? "missing_rate"}` : null),
    base_n, base_d, extra_n, extra_d, stored_n, stored_d, tokens: String(event.reported),
    long_tokens: values.long ? String(event.reported) : "0" };
}
function contributions(event: ContextEvent): ContextAggregate[] {
  return (["day", ...(event.hour === null ? [] : ["hour"])] as ("day" | "hour")[]).map(grain => {
    const hour = grain === "day" ? -1 : event.hour!;
    const key = JSON.stringify([grain, event.day, hour, event.dim_id, event.cohort, event.rule_revision, event.included, event.reason]);
    const { event_id: _id, source_revision: _revision, ...rest } = event;
    return { ...rest, key, grain, hour, calls: 1,
      base_n: event.base_n ?? "0", base_d: event.base_d ?? "1", extra_n: event.extra_n ?? "0", extra_d: event.extra_d ?? "1",
      stored_n: event.stored_n ?? "0", stored_d: event.stored_d ?? "1" };
  });
}
function accumulate(target: ContextAggregate, input: ContextAggregate, sign: number): void {
  target.calls += sign * input.calls;
  target.tokens = String(BigInt(target.tokens) + BigInt(sign) * BigInt(input.tokens));
  target.long_tokens = String(BigInt(target.long_tokens) + BigInt(sign) * BigInt(input.long_tokens));
  for (const basis of ["base", "extra", "stored"] as const) {
    const value = contextAmount(input, basis)!;
    const next = add(contextAmount(target, basis)!, { n: BigInt(sign) * value.n, d: value.d });
    target[`${basis}_n`] = String(next.n); target[`${basis}_d`] = String(next.d);
  }
}
function zero(input: ContextAggregate): ContextAggregate {
  return { ...input, calls: 0, tokens: "0", long_tokens: "0", base_n: "0", base_d: "1",
    extra_n: "0", extra_d: "1", stored_n: "0", stored_d: "1" };
}
export interface ContextBatchOptions {
  policy: CompiledCodexLedgerPolicy; limit?: number; canWrite?(): boolean;
  /** Recheck the policy's owner before committing computations done outside the write transaction. */
  policyIsCurrent?(): boolean;
}
export interface ContextBatchResult { processed: number; eventsWritten: number; aggregatesWritten: number; pending: boolean }

/** Background-writer only. Every checkpoint and old/new contribution is committed atomically. */
export function processCodexContextBatch(db: Database, options: ContextBatchOptions): ContextBatchResult {
  if (db.inTransaction) throw new Error("Context producer owns its bounded transaction");
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Context batch size must be 1..5000");
  const result: ContextBatchResult = { processed: 0, eventsWritten: 0, aggregatesWritten: 0, pending: true };
  const canWrite = options.canWrite ?? (() => true);
  if (!canWrite()) return result;
  let state = readCodexContextState(db);
  if (!state) return { ...result, pending: false };
  if (state.version !== CODEX_CONTEXT_VERSION) throw new Error("Unsupported context projection version");
  const rules = rulesOf(options.policy), rulesJson = JSON.stringify(rules);
  const guardPolicy = () => { if (options.policyIsCurrent && !options.policyIsCurrent()) throw new Error("Prepared context policy is stale"); };
  if (state.rules_json !== rulesJson) {
    const expected = state;
    const scopes = changedScopes(JSON.parse(state.rules_json) as LedgerBaseRule[], rules);
    db.transaction(() => {
      guardPolicy();
      if (readCodexContextState(db)!.generation !== expected.generation) throw new Error("Prepared context generation is stale");
      // Unfinished scopes must revisit their partial work under the new rule snapshot.
      db.query("UPDATE codex_context_work SET cursor=-1 WHERE cursor<>-1").run();
      const save = db.query("INSERT OR IGNORE INTO codex_context_work(model,from_day,until_day) VALUES(?,?,?)");
      if (expected.filled) for (const scope of scopes) save.run(scope.model, scope.from_day, scope.until_day);
      db.query("UPDATE codex_context_state SET rules_json=?,generation=generation+1 WHERE singleton=1").run(rulesJson);
    }).immediate();
    state = readCodexContextState(db)!;
  }
  guardPolicy();
  const scope = state.filled ? db.query("SELECT * FROM codex_context_work ORDER BY model,from_day LIMIT 1").get() as RuleScope | null : null;
  const dirty = state.filled && !scope ? (db.query("SELECT event_id FROM codex_context_dirty ORDER BY event_id LIMIT ?").all(limit) as { event_id: number }[]).map(row => row.event_id) : [];
  const ids = !state.filled
    ? (db.query("SELECT id FROM codex_price_ledger_events WHERE id>? ORDER BY id LIMIT ?").all(state.cursor, limit) as { id: number }[]).map(row => row.id)
    : scope ? (db.query(`SELECT e.id FROM codex_price_ledger_dims d CROSS JOIN codex_price_ledger_events e INDEXED BY codex_price_ledger_events_dim
        ON e.dim_id=d.id WHERE d.model=? AND e.day>=? AND e.day<? AND e.id>? ORDER BY e.id LIMIT ?`)
      .all(scope.model, scope.from_day, scope.until_day, scope.cursor, limit) as { id: number }[]).map(row => row.id) : dirty;
  // A read snapshot makes source rows and the fencing counter agree even with an independent writer.
  const snapshot = db.transaction(() => {
    const fence = readCodexContextState(db)!;
    const jsonIds = JSON.stringify(ids);
    return { fence, rows: ids.length ? db.query(`${sourceSql} WHERE e.id IN (SELECT value FROM json_each(?))`).all(jsonIds) as SourceEvent[] : [],
      old: ids.length ? db.query("SELECT * FROM codex_context_events WHERE event_id IN (SELECT value FROM json_each(?))").all(jsonIds) as ContextEvent[] : [] };
  }).deferred();
  if (snapshot.fence.generation !== state.generation) throw new Error("Prepared context generation is stale");
  const bands = new Map<number, ReturnType<typeof readCodexLedgerPublishedBand>>();
  const next = new Map(snapshot.rows.map(row => [row.id, project(db, options.policy, row, bands)]));
  const old = new Map(snapshot.old.map(row => [row.event_id, row]));
  const changes = ids.filter(id => JSON.stringify(columns.map(key => old.get(id)?.[key] ?? null)) !==
    JSON.stringify(columns.map(key => next.get(id)?.[key] ?? null)));
  const deltas = new Map<string, ContextAggregate>();
  for (const id of changes) for (const [event, sign] of [[old.get(id), -1], [next.get(id), 1]] as const) if (event)
    for (const input of contributions(event)) {
      let target = deltas.get(input.key);
      if (!target) deltas.set(input.key, target = zero(input));
      accumulate(target, input, sign);
    }
  if (!canWrite()) return result;
  const expected = state;
  db.transaction(() => {
    guardPolicy();
    const current = readCodexContextState(db)!;
    if (current.generation !== snapshot.fence.generation || current.source_revision !== snapshot.fence.source_revision ||
      current.cursor !== expected.cursor || current.revision !== expected.revision) throw new Error("Prepared context source is stale");
    if (scope) {
      const queued = db.query("SELECT cursor FROM codex_context_work WHERE model=? AND from_day=? AND until_day=?")
        .get(scope.model, scope.from_day, scope.until_day) as { cursor: number } | null;
      if (queued?.cursor !== scope.cursor) throw new Error("Prepared context rule scope is stale");
    }
    const save = db.query(`INSERT OR REPLACE INTO codex_context_events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
    for (const id of changes) {
      const value = next.get(id);
      result.eventsWritten += value ? save.run(...columns.map(key => value[key])).changes
        : db.query("DELETE FROM codex_context_events WHERE event_id=?").run(id).changes;
    }
    const saveAggregate = db.query(`INSERT OR REPLACE INTO codex_context_aggregates(${aggregateColumns.join(",")})
      VALUES(${aggregateColumns.map(() => "?").join(",")})`);
    for (const delta of deltas.values()) {
      if (!delta.calls && delta.tokens === "0" && delta.long_tokens === "0" &&
        ["base", "extra", "stored"].every(basis => delta[`${basis}_n` as "base_n"] === "0")) continue;
      const stored = db.query("SELECT * FROM codex_context_aggregates WHERE key=?").get(delta.key) as ContextAggregate | null;
      const value = stored ?? zero(delta); accumulate(value, delta, 1);
      if (value.calls < 0) throw new Error("Context contribution underflow");
      result.aggregatesWritten += value.calls ? saveAggregate.run(...aggregateColumns.map(key => value[key]) as SQLQueryBindings[]).changes
        : db.query("DELETE FROM codex_context_aggregates WHERE key=?").run(value.key).changes;
    }
    if (ids.length) db.query("DELETE FROM codex_context_dirty WHERE event_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
    if (!expected.filled) db.query("UPDATE codex_context_state SET cursor=?,filled=? WHERE singleton=1")
      .run(ids.at(-1) ?? expected.cursor, ids.length < limit ? 1 : 0);
    else if (scope) {
      if (ids.length < limit) db.query("DELETE FROM codex_context_work WHERE model=? AND from_day=? AND until_day=?").run(scope.model, scope.from_day, scope.until_day);
      else db.query("UPDATE codex_context_work SET cursor=? WHERE model=? AND from_day=? AND until_day=?").run(ids.at(-1)!, scope.model, scope.from_day, scope.until_day);
    }
    const pending = !readCodexContextState(db)!.filled || !!db.query("SELECT 1 FROM codex_context_work LIMIT 1").get() ||
      !!db.query("SELECT 1 FROM codex_context_dirty LIMIT 1").get();
    if (changes.length || !pending && current.covered_revision !== current.source_revision)
      db.query("UPDATE codex_context_state SET revision=revision+1,covered_revision=CASE WHEN ? THEN covered_revision ELSE source_revision END WHERE singleton=1").run(pending ? 1 : 0);
    result.pending = pending;
  }).immediate();
  result.processed = ids.length;
  return result;
}
