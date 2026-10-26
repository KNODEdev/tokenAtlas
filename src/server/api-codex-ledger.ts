import type { Database } from "bun:sqlite";
import type { RateCard } from "./pricing";
import { loadAccountResolver, type AccountResolver } from "./account-resolver";
import { codexSourceHomes } from "./capacity-equivalents";
import { codexLedgerReadContext, codexLedgerPendingReason, readCodexLedgerOwnedSeries, readCodexLedgerOwnedDaySums,
  ledgerPresentationNumber, codexLedgerApiTokenAmounts } from "../db/codex-ledger-adapters";
import { add, rational, decimal, multiply, serializeRational, NANO_UNITS, type Rational } from "../db/price-ledger-exact";
import { metadataColumns, readCodexLedgerPublishedBands, withPlaceProjects, type LedgerRange } from "../db/codex-price-ledger";
import { deriveCodexLedgerGroup, type LedgerAmount, type LedgerReadGroup } from "../db/codex-price-ledger-read";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { codexSumsPresent } from "./ledger-sums";
import { contextReadScope, projectContextGroup } from "../db/codex-context-read-scope";
import { codexEventContextReader } from "./codex-context-read";
import type { ContextPrice } from "../shared/context-price";

type Context = { sqlite: Database; rateCards: RateCard; homeToSubId: Map<string, string> };
export const CODEX_API_USD_PRESENTATION_VERSION = "codex-api-usd-cents-v1";
export function apiHasCodexHistory(ctx: Context): boolean {
  return codexSumsPresent(ctx.sqlite);
}
export function apiCodexLedgerIsPending(ctx: Context, range?: LedgerRange): boolean {
  if (!apiHasCodexHistory(ctx)) return false;
  const context = codexLedgerReadContext(ctx.rateCards);
  return codexLedgerPendingReason(ctx.sqlite, { ...context, range }) !== null;
}
export function apiCodexLedgerContext(ctx: Context, range?: LedgerRange) {
  const context = codexLedgerReadContext(ctx.rateCards);
  const reason = codexLedgerPendingReason(ctx.sqlite, { ...context, range });
  if (reason) throw new SubscriptionFactsPending(`Codex prices are awaiting background preparation (${reason})`, "codex");
  return context;
}
export function apiCodexLedgerRows(ctx: Context, range: LedgerRange = {}, url?: URL, resolver?: AccountResolver) {
  if (!apiHasCodexHistory(ctx)) return [];
  const dependencies: LedgerRange = { ...range, dependencyBases: range.dependencyBases ?? ["api_equivalent_usd"] };
  const context = apiCodexLedgerContext(ctx, dependencies);
  const project = url?.searchParams.get("project_id");
  return readCodexLedgerOwnedSeries(ctx.sqlite, dependencies, resolver ?? loadAccountResolver(ctx.sqlite), context, ["api_standard"] as const)
    .filter(({ group }) => group.selected && (!project || (project === "unassigned"
      ? group.stored.project_id === null : String(group.stored.project_id) === project)))
    .map(({ group, account }) => ({ group, account, home: group.stored.home,
      model: group.stored.model, day: group.stored.day, calls: Number(group.calls),
      in_tok: Number(group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown!),
      cached_in: Number(group.tokens.in_cache_read!), cache_write: Number(group.tokens.in_cache_write_unknown!),
      out_tok: Number(group.tokens.out_total!), reasoning_out: Number(group.tokens.reasoning_out!),
      usd: group.variants.api_standard.pricedSubtotal,
      unpriced: Number(group.variants.api_standard.unpricedTokens) }));
}
/** Owned API Standard sums of whole days for history screens (`readCodexLedgerOwnedDaySums`): canonical calls only. */
export function apiCodexOwnedDaySums(ctx: Context, range: { since?: string; until?: string }, resolver?: AccountResolver) {
  if (!apiHasCodexHistory(ctx)) return [];
  const dependencies: LedgerRange = { ...range, dependencyBases: ["api_equivalent_usd"] };
  return readCodexLedgerOwnedDaySums(ctx.sqlite, dependencies, resolver ?? loadAccountResolver(ctx.sqlite), apiCodexLedgerContext(ctx, dependencies));
}
export function apiCodexBucket(db: Database, day: string, group: string, weekMode: "number" | "monday" = "number"): string {
  if (group === "day") return day;
  if (group === "month") return day.slice(0, 7);
  return (db.query(weekMode === "number" ? "SELECT strftime('%Y-W%W', ?) b" : "SELECT date(?, 'weekday 0', '-6 days') b")
    .get(day) as { b: string }).b;
}
/** Round once to the nearest cent; exact ties go away from zero. */
export function roundApiCodexUsd(value: Rational): number {
  const amount = rational(value.n, value.d), magnitude = amount.n < 0n ? -amount.n : amount.n;
  const cents = (magnitude * 200n + amount.d) / (amount.d * 2n);
  const rounded = rational(amount.n < 0n ? -cents : cents, 100n);
  const result = Number(serializeRational(rounded).decimal!);
  if (!Number.isFinite(result)) throw new Error("Ledger amount exceeds the presentation number domain");
  return result === 0 ? 0 : result;
}
export function roundApiCodexUsdWithLegacy(value: Rational, legacy: number): number {
  return roundApiCodexUsd(add(value, decimal(legacy)));
}
type MoneyTarget = { usd: number | null; priced_usd?: number };
/** A running exact sum: numerators are added per denominator and the fractions reduced once, when read. */
export class ExactParts {
  private parts = new Map<bigint, bigint>();
  add(value: Rational): void { this.parts.set(value.d, (this.parts.get(value.d) ?? 0n) + value.n); }
  total(): Rational {
    let sum = rational(0n);
    for (const [d, n] of this.parts) sum = add(sum, rational(n, d));
    return sum;
  }
}

/** Retain exact native money and the legacy contribution until final report rounding. */
export class ApiCodexMoney {
  private amounts = new Map<object, Rational>();
  private legacy = new Map<object, Rational>();
  get hasAmounts(): boolean { return this.amounts.size > 0; }
  add(target: MoneyTarget, value: Rational): void {
    if (!this.amounts.has(target)) this.legacy.set(target, decimal(target.usd ?? target.priced_usd ?? 0));
    this.amounts.set(target, add(this.amounts.get(target) ?? rational(0n), value));
  }
  /** Account history merges other providers after native contributions are collected. */
  addLegacy(target: MoneyTarget, value: number): void {
    if (this.amounts.has(target)) this.legacy.set(target, add(this.legacy.get(target)!, decimal(value)));
  }
  exact(target: MoneyTarget): Rational | undefined {
    const value = this.amounts.get(target);
    return value === undefined ? undefined : add(value, this.legacy.get(target)!);
  }
  rounded(target: MoneyTarget): number | undefined {
    const value = this.exact(target);
    return value === undefined ? undefined : roundApiCodexUsd(value);
  }
  finish(): void {
    for (const [key, value] of this.amounts) {
      const target = key as MoneyTarget, amount = ledgerPresentationNumber(value);
      if (target.usd === null) target.priced_usd = (target.priced_usd ?? 0) + amount;
      else target.usd += amount;
    }
  }
}
export function apiCodexTokenReader(ctx: Context, range?: LedgerRange) {
  const context = apiCodexLedgerContext(ctx, { ...range, dependencyBases: range?.dependencyBases ?? ["api_equivalent_usd"] });
  const bands = readCodexLedgerPublishedBands(ctx.sqlite);
  return (group: LedgerReadGroup<readonly ["api_standard"]>) => {
    const parts = codexLedgerApiTokenAmounts(ctx.sqlite, group, context);
    if (!parts) return null;
    const coefficients = bands.get(group.stored.api_band)?.coefficients;
    if (!coefficients?.buckets.in_uncached) throw new Error("Published input-price projection has no coefficient");
    const coefficient = coefficients.buckets.in_uncached;
    return { ...parts, hypothetical: multiply(rational(coefficient.whole * coefficients.denominator + coefficient.remainder,
      coefficients.denominator * NANO_UNITS), rational(group.tokens.in_cache_read!)) };
  };
}

/** A bounded audit page resolves accepted physical observations; no source-token valuation occurs. */
export function apiCodexAuditReader(ctx: Context, range: LedgerRange = {}, contextPreview = false): (home:string,path:string,offset:number) => LedgerAmount & { context_price?: ContextPrice; ledger_event_id?: number } {
  const ledger = apiCodexLedgerContext(ctx, { ...range, dependencyBases: range.dependencyBases ?? ["api_equivalent_usd"] });
  const bands = ctx.sqlite.query("SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands").all() as {id:number;denominator:string}[];
  const denominators = new Map(bands.map(band=>[band.id,BigInt(band.denominator)]));
  const readContextPrice = contextPreview ? codexEventContextReader(ctx.sqlite) : undefined;
  const statement = ctx.sqlite.query(`SELECT e.*,${metadataColumns()},
    c.home,c.path,c.source,CAST(e.api_whole/1000000000 AS TEXT) api_whole_hi,CAST(e.api_whole%1000000000 AS TEXT) api_whole_lo,
    CAST(e.credit_whole/1000000000 AS TEXT) credit_whole_hi,CAST(e.credit_whole%1000000000 AS TEXT) credit_whole_lo,
    CASE WHEN e.api_reason IS NULL AND e.api_whole=0 AND e.api_fraction_hi=0 AND e.api_fraction_lo=0 THEN 1 ELSE 0 END api_zero,
    CASE WHEN e.credit_reason IS NULL AND e.credit_whole=0 AND e.credit_fraction_hi=0 AND e.credit_fraction_lo=0 THEN 1 ELSE 0 END credit_zero
    FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id JOIN codex_price_ledger_copies c ON c.id=e.copy_id
    WHERE c.home IS ? AND c.path IS ? AND e.source_offset=?`);
  return (home,path,offset) => {
    const row = statement.get(home,path,offset) as (Record<string,unknown> & { home: unknown; cwd: unknown; project: unknown; repo: unknown;
      day: unknown; project_id: unknown; subject: unknown }) | null;
    if (!row) throw new SubscriptionFactsPending("Codex audit prices are awaiting background preparation", "codex");
    const stored: Record<string, unknown> = withPlaceProjects(ctx.sqlite, [row])[0]!;
    const amounts = { ...stored,calls:"1",first_ts:stored.ts,last_ts:stored.ts,api_reason:stored.api_reason ?? "",credit_reason:stored.credit_reason ?? "" };
    for (const key of ["reported","uncached","cached","writes","output","reasoning","window_input","window_cached","window_output","invalid_tokens",
      "api_fraction_hi","api_fraction_lo","credit_fraction_hi","credit_fraction_lo"]) (amounts as Record<string,unknown>)[key] = stored[key] == null ? null : String(stored[key]);
    const group = deriveCodexLedgerGroup(amounts as unknown as import("../db/codex-price-ledger").LedgerStoredGroup, denominators,ledger.policy);
    contextReadScope(ctx.sqlite)?.eventIds.set(group.stored, Number(stored.id));
    const value = projectContextGroup(ctx.sqlite, group, ledger.policy).variants.api_standard;
    const price = group.selected ? readContextPrice?.(Number(stored.id)) : undefined;
    return { ...value, ...(contextPreview ? { ledger_event_id: Number(stored.id) } : {}), ...(price ? { context_price: price } : {}) };
  };
}
