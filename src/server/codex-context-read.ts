import type { LedgerRange, LedgerStoredGroup } from "../db/codex-price-ledger";
import type { LedgerReadGroup, LedgerTierPolicy, LedgerVariant } from "../db/codex-price-ledger-read";
import type { ContextReadScope } from "../db/codex-context-read-scope";
import type { ContextPreviewStatus } from "../shared/context-preview";
import type { Database, SQLQueryBindings } from "../db/sqlite";
import { codexContextPending, contextAmount, readCodexContextState, type ContextAggregate } from "../db/codex-context-producer";
import { metadataColumns, withPlaceProjects, type LedgerDimFilter } from "../db/codex-price-ledger";
import { add, equal, multiply, rational, type Rational } from "../db/price-ledger-exact";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "./codex-ledger-policy";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { isAccountingDay } from "./codex-accounting-pricing";
import type { ContextPrice } from "../shared/context-price";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";

export interface ContextScope extends LedgerDimFilter {
  grain?: "day" | "hour";
  /** Pricing days [fromDay, untilDay); optional UTC hours [fromHour, untilHour). */
  fromDay?: string; untilDay?: string; fromHour?: number; untilHour?: number;
  models?: readonly (string | null)[]; projectIds?: readonly (string | number)[];
}
export interface ContextScopeSum {
  ready: boolean; revision: number; calls: number; missingCalls: number; unknownModeCalls: number;
  tokens: bigint; longTokens: bigint; reasons: Record<string, number>;
  base: Rational | null; extra: Rational | null; stored: Rational | null;
  subtotal: { base: Rational; extra: Rational; stored: Rational }; includedCalls: number;
}
/** One prepared lookup per audit-page row; physical duplicate/conflict identities have no projection. */
export function codexEventContextReader(db: Database): (eventId: number) => ContextPrice | undefined {
  const state = readCodexContextState(db);
  if (!state || codexContextPending(db, state)) return () => undefined;
  const query = db.query("SELECT * FROM codex_context_events WHERE event_id=?");
  return eventId => {
    const row = query.get(eventId) as import("../db/codex-context-producer").ContextEvent | null;
    if (!row || row.reason) return;
    const base = contextAmount(row, "base"), extra = contextAmount(row, "extra"), stored = contextAmount(row, "stored");
    if (!base || !extra || !stored) return;
    return { base: ledgerPresentationNumber(base), extra: ledgerPresentationNumber(extra), stored: ledgerPresentationNumber(stored), included: !!row.included };
  };
}
/** Aggregate-only read: no scheduling, event scan, valuation, or schema installation. */
export function readCodexContextPrices(db: Database, scope: ContextScope = {}): ContextScopeSum {
  return db.transaction(() => {
    const state = readCodexContextState(db);
    const sum: ContextScopeSum = { ready: !!state && !codexContextPending(db, state), revision: state?.revision ?? 0,
      calls: 0, missingCalls: 0, unknownModeCalls: 0, tokens: 0n, longTokens: 0n, includedCalls: 0, reasons: {},
      base: null, extra: null, stored: null, subtotal: { base: rational(0n), extra: rational(0n), stored: rational(0n) } };
    if (!state) return sum;
    const publishedPolicy = readCodexLedgerState(db)?.rules_json;
    const policy = publishedPolicy ? compileCodexLedgerPolicy(JSON.parse(publishedPolicy) as CodexLedgerPolicy) : null;
    const grain = scope.grain ?? "day";
    if (grain !== "day" && grain !== "hour") throw new Error("Invalid context grain");
    for (const day of [scope.fromDay, scope.untilDay]) if (day !== undefined && !isAccountingDay(day)) throw new Error("Invalid context day bound");
    if ((scope.fromHour !== undefined || scope.untilHour !== undefined) && grain !== "hour") throw new Error("Hour bounds require hour aggregates");
    for (const hour of [scope.fromHour, scope.untilHour]) if (hour !== undefined && !Number.isSafeInteger(hour)) throw new Error("Invalid context hour bound");
    const terms = ["a.grain=?"], params: SQLQueryBindings[] = [grain];
    for (const [value, term] of [[scope.fromDay, "a.day>=?"], [scope.untilDay, "a.day<?"],
      [scope.fromHour, "a.hour>=?"], [scope.untilHour, "a.hour<?"]] as const) if (value !== undefined) { terms.push(term); params.push(value); }
    for (const [values, field] of [[scope.homes, "d.home"], [scope.sources, "d.source"], [scope.models, "d.model"]] as const) {
      if (values !== undefined) { terms.push(`${field} IN (SELECT value FROM json_each(?))${values.some(value => value === null) ? ` OR ${field} IS NULL` : ""}`); params.push(JSON.stringify(values)); }
    }
    if (scope.where) { terms.push(scope.where.sql); params.push(...scope.where.params); }
    const metadata = scope.projectIds ? `d.home,d.source,${metadataColumns()}` : "d.service_tier";
    const raw = db.query(`SELECT a.*,${metadata} FROM codex_context_aggregates a
      JOIN codex_price_ledger_dims d ON d.id=a.dim_id WHERE ${terms.map(term => `(${term})`).join(" AND ")}`).all(...params) as
      (ContextAggregate & { home: string | null; source: string | null; cwd: string | null; project: string | null; repo: string | null;
        project_id: string | number | null; subject: string | null; service_tier: string | null })[];
    const rows = scope.projectIds ? withPlaceProjects(db, raw) : raw;
    for (const row of rows) {
      if (scope.projectIds && !scope.projectIds.includes(row.project_id!)) continue;
      sum.calls += row.calls; sum.tokens += BigInt(row.tokens); sum.longTokens += BigInt(row.long_tokens);
      if (!policy?.classify(row.service_tier, row.day)) sum.unknownModeCalls += row.calls;
      if (row.included) sum.includedCalls += row.calls;
      if (row.reason) { sum.missingCalls += row.calls; sum.reasons[row.reason] = (sum.reasons[row.reason] ?? 0) + row.calls; }
      for (const basis of ["base", "extra", "stored"] as const) sum.subtotal[basis] = add(sum.subtotal[basis], contextAmount(row, basis)!);
    }
    if (sum.missingCalls === 0 && sum.ready) Object.assign(sum, sum.subtotal);
    return sum;
  }).deferred();
}

type Sum = { calls: bigint; missing: boolean; base: Rational; extra: Rational; stored: Rational; uplift: Rational };
const empty = (): Sum => ({ calls: 0n, missing: false, base: rational(0n), extra: rational(0n), stored: rational(0n), uplift: rational(0n) });
const cohort = (row: LedgerStoredGroup) => JSON.stringify([row.api_band, row.credit_band, row.api_reason || "", row.credit_reason || "", row.api_zero, row.credit_zero, row.copy_state]);
const key = (row: { dim_id: number; cohort: string }) => `${row.dim_id}:${row.cohort}`;
const HOUR = 3_600_000;

/** Saved day/hour cohorts, with indexed saved event measures only in cut hours. No token valuation. */
export function contextPreviewReader(db: Database) {
  const state = readCodexContextState(db);
  const status: ContextPreviewStatus = { ready: !!state && !codexContextPending(db, state), revision: state?.revision ?? 0, missing_groups: 0 };
  const cache = new Map<string, Map<string, Sum>>();
  const ranges = new WeakMap<LedgerStoredGroup, LedgerRange>();
  const eventIds = new WeakMap<LedgerStoredGroup, number>();
  const members = new WeakMap<LedgerStoredGroup, readonly LedgerStoredGroup[]>();
  const load = (row: LedgerStoredGroup): Sum | undefined => {
    const children = members.get(row);
    if (children) {
      const total = empty();
      for (const child of children) {
        const part = load(child);
        if (!part) return;
        total.calls += part.calls; total.missing ||= part.missing;
        for (const basis of ["base", "extra", "stored", "uplift"] as const) total[basis] = add(total[basis], part[basis]);
      }
      return total;
    }
    const range = ranges.get(row) ?? {};
    const from = range.fromMs === undefined ? undefined : range.fromMs + (range.startInclusive === false ? 1 : 0);
    const until = range.toMs === undefined ? undefined : range.toMs + (range.endInclusive ? 1 : 0);
    const hourly = row.hour !== undefined && row.hour !== null;
    const eventId = eventIds.get(row);
    const cacheKey = JSON.stringify([row.day, hourly ? row.hour : null, from, until, range.copyPaths, range.instantValidity, eventId]);
    let sums = cache.get(cacheKey);
    if (!sums) {
      sums = new Map(); cache.set(cacheKey, sums);
      const absorb = (rows: Array<Pick<ContextAggregate, "dim_id" | "cohort" | "calls" | "reason" | "included" | "base_n" | "base_d" | "extra_n" | "extra_d" | "stored_n" | "stored_d">>) => {
        for (const item of rows) {
          const sum = sums!.get(key(item)) ?? empty();
          sum.calls += BigInt(item.calls); sum.missing ||= !!item.reason;
          for (const basis of ["base", "extra", "stored"] as const) {
            const value = contextAmount(item, basis);
            if (value === null) sum.missing = true; else sum[basis] = add(sum[basis], value);
          }
          if (!item.included && !item.reason) sum.uplift = add(sum.uplift, contextAmount(item, "extra")!);
          sums!.set(key(item), sum);
        }
      };
      if (eventId !== undefined) {
        absorb(db.query("SELECT *,1 calls FROM codex_context_events WHERE event_id=?").all(eventId) as ContextAggregate[]);
      } else if (from === undefined && until === undefined && !range.copyPaths && !range.instantValidity) {
        absorb(db.query(`SELECT * FROM codex_context_aggregates WHERE grain=? AND day=?${hourly ? " AND hour=?" : ""}`)
          .all(...[hourly ? "hour" : "day", row.day, ...(hourly ? [row.hour!] : [])]) as ContextAggregate[]);
      } else {
        const lower = hourly ? Math.max(from ?? -Infinity, row.hour! * HOUR) : from;
        const upper = hourly ? Math.min(until ?? Infinity, (row.hour! + 1) * HOUR) : until;
        const first = lower === undefined ? undefined : Math.ceil(lower / HOUR);
        const last = upper === undefined ? undefined : Math.floor(upper / HOUR);
        if (!range.copyPaths && range.instantValidity !== "invalid" && (first === undefined || last === undefined || first < last)) {
          const terms = ["grain='hour'", "day=?"], params: SQLQueryBindings[] = [row.day];
          if (first !== undefined) { terms.push("hour>=?"); params.push(first); }
          if (last !== undefined) { terms.push("hour<?"); params.push(last); }
          absorb(db.query(`SELECT * FROM codex_context_aggregates WHERE ${terms.join(" AND ")}`).all(...params) as ContextAggregate[]);
          const edges: Array<[number | undefined, number | undefined]> = [];
          if (lower !== undefined && lower < first! * HOUR) edges.push([lower, Math.min(upper ?? Infinity, first! * HOUR)]);
          if (upper !== undefined && last! * HOUR < upper && (lower === undefined || last! >= first!)) edges.push([Math.max(lower ?? -Infinity, last! * HOUR), upper]);
          for (const [a, b] of edges) readEvents(a, b);
        } else readEvents(lower, upper);
        function readEvents(a: number | undefined, b: number | undefined) {
          const terms = ["p.day=?"], params: SQLQueryBindings[] = [row.day];
          if (a !== undefined) { terms.push("e.instant_ms>=?"); params.push(a); }
          if (b !== undefined) { terms.push("e.instant_ms<?"); params.push(b); }
          if (range.instantValidity) terms.push(`e.instant_ms IS ${range.instantValidity === "valid" ? "NOT " : ""}NULL`);
          if (range.copyPaths) { terms.push("e.copy_id IN (SELECT id FROM codex_price_ledger_copies WHERE path IN (SELECT value FROM json_each(?)))"); params.push(JSON.stringify(range.copyPaths)); }
          // Keep the bounded time seek outermost; a day-first join would probe the time index once per request of the day.
          absorb(db.query(`SELECT p.*,1 calls FROM codex_price_ledger_events e INDEXED BY codex_price_ledger_events_time
            CROSS JOIN codex_context_events p ON p.event_id=e.id WHERE ${terms.join(" AND ")}`).all(...params) as ContextAggregate[]);
        }
      }
    }
    return sums.get(key({ dim_id: row.dim_id, cohort: cohort(row) }));
  };
  const scope: ContextReadScope = { db, ranges, eventIds, members, originals: new WeakMap(), derived: new Map(), capturedGroups: 0,
    policies: new WeakMap(), nextPolicy: 0, apply(group, policy) {
    if (!group.selected || group.stored.api_reason || !Object.keys(group.variants).some(variant => apiVariants.has(variant as LedgerVariant))) return;
    const sum = load(group.stored);
    // An unknown uplift never turns a previously unknown price into zero, or changes a priced subtotal's population.
    if (!sum || sum.missing || sum.calls !== group.calls) { status.missing_groups++; return; }
    const delta = sum.uplift;
    const standard = group.variants.api_standard;
    if (standard?.value && !equal(standard.value, sum.stored)) { status.missing_groups++; return; }
    for (const variant of apiVariants) {
      const amount = group.variants[variant];
      if (!amount || amount.value === null) continue;
      const factor = factorFor(variant, group, policy);
      if (factor === null) continue;
      const value = add(amount.value, multiply(delta, factor));
      group.variants[variant] = { ...amount, value, subtotal: value, pricedSubtotal: value };
    }
  } };
  return { status, scope };
}
const apiVariants = new Set<LedgerVariant>(["api_standard", "api_standard_credited", "api_actual", "normalized_usd", "window_api", "window_normalized"]);
function factorFor(variant: LedgerVariant, group: LedgerReadGroup<readonly LedgerVariant[]>, policy: LedgerTierPolicy): Rational | null {
  const row = group.stored;
  if (variant === "api_actual") {
    const tier = group.tier ?? (row.service_tier == null ? "standard" : null);
    return tier === "standard" ? rational(1n) : tier ? policy.multiplier(row.model, "api_equivalent_usd", tier, row.day) : null;
  }
  if (variant === "normalized_usd" || variant === "window_normalized" && row.day >= "2026-04-02") {
    return row.credit_zero || group.tier === "standard" || variant === "window_normalized" && !group.tier ? rational(1n)
      : group.tier ? policy.multiplier(row.model, "chatgpt_credits", group.tier, row.day) : null;
  }
  return rational(1n);
}
