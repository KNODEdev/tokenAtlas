import type { Database } from "bun:sqlite";
import { codexLedgerFactsPending } from "./read-freshness";
import { analysisHash } from "./analysis";
import { codexStampDays, type CodexStampDay } from "./codex-stamp-days";
import { CodexLedgerNotReady, codexLedgerBandRevision, requireCodexLedgerReady, codexLedgerHasPendingWork, codexLedgerQuotedDayRange,
  codexLedgerScopeIntersects, metadataColumns, withPlaceProjects, readCodexLedgerPublishedBand, readCodexLedgerCohorts, type LedgerCohortRow, type LedgerCohortSpec, type LedgerRange,
  readCodexLedgerPieceSums, type LedgerStoredGroup } from "./codex-price-ledger";
import { codexLedgerBaseChanges, codexLedgerReferenceFingerprint } from "./codex-ledger-dependencies";
import { CODEX_LEDGER_VARIANTS, deriveCodexLedgerGroups, deriveCodexLedgerGroup, emptyLedgerAmount, LedgerAmountSum,
  mergeLedgerAmounts, type LedgerAmount, type LedgerReadGroup, type LedgerVariant } from "./codex-price-ledger-read";
import { withCodexLedgerStoredSnapshot, readCodexLedgerStoredSnapshot } from "./codex-price-ledger-read";
import { add, decimal, rational, multiply, equal, NANO_UNITS, serializeRational, type Rational } from "./price-ledger-exact";
import { compileCodexLedgerPolicy, type CompiledCodexLedgerPolicy } from "../server/codex-ledger-policy";
import { codexLedgerSettings } from "../server/codex-ledger-settings";
import { codexEventOwner } from "../server/codex-event-owner";
import { isAccountingDay } from "../server/codex-accounting-pricing";
import type { AccountResolver, SourceRange } from "../server/account-resolver";
import { normEraKey } from "../server/eras";
import type { RateCard } from "../server/pricing";
import type { UsagePriceAmount, UsagePriceDimRow, UsagePriceMirror, UsagePriceRange, UsagePriceTotals } from "./usage-price-totals";
import type { CodexRegisterDay, CodexMeterModelRow } from "./usage-price-read-codex";
import { USAGE_PRICE_QUALITY_KEYS, USAGE_PRICE_TOKEN_KEYS } from "./usage-price-measures";
import type { RegisterDayRow } from "./usage-price-read-account";
import { CODEX_CANONICAL_COPY_POLICY } from "./codex-ledger-canonical";
import { CODEX_LEDGER_VERSION, codexLedgerWorkPending, readCodexLedgerState, type CodexLedgerState } from "./codex-ledger-state";
import { projectRulesStamp } from "../projects/rules-now";
import { contextReadScope, originalContextApi } from "./codex-context-read-scope";

export const CODEX_LEDGER_SCOPE = "codex-price-ledger-v1";
export const CODEX_LEDGER_ARITHMETIC = "exact-rational-two-base-ledger-v1";
export interface CodexLedgerReadContext { policy: CompiledCodexLedgerPolicy; rulesRevision?: string; referenceDay?: string }
/**
 * Validating, hashing and compiling the policy costs milliseconds on every window read; the result depends only on the
 * card's ledger policy and accounting rules, so the last one is kept by their text (a worker gets a new copy of the same
 * card with every job). Readers do not change the context.
 */
let lastReadContext: { key: string; context: CodexLedgerReadContext } | null = null;
export function codexLedgerReadContext(card: RateCard): CodexLedgerReadContext {
  const key = JSON.stringify([card.codex_ledger_policy ?? null, card.codex_accounting ?? null]);
  if (lastReadContext?.key !== key) {
    const settings = codexLedgerSettings(card);
    lastReadContext = { key, context: { policy: compileCodexLedgerPolicy(settings.policy), rulesRevision: settings.semantic_revision } };
  }
  return lastReadContext.context;
}
/** The published rules, compiled; a rule change still being applied makes them provisional ("preparing"). */
export function readPublishedCodexLedgerContext(db: Database, range?: LedgerRange): CodexLedgerReadContext {
  requireCodexLedgerReady(db, range);
  const head = readCodexLedgerState(db);
  if (!head?.rules_json) throw new Error("Published Codex ledger has no retained policy snapshot");
  if (codexLedgerWorkPending(db, ["rules"])) throw new CodexLedgerNotReady("Current Codex tier policy requires explicit scoped proof");
  return { policy: compileCodexLedgerPolicy(JSON.parse(head.rules_json)), rulesRevision: head.rules_digest };
}
export interface CodexLedgerReadDependencies { rulesRevision?: string; range?: LedgerRange; policy?: CompiledCodexLedgerPolicy }
export function codexLedgerPendingReason(db: Database, options: CodexLedgerReadDependencies = {}): string | null {
  const head = readCodexLedgerState(db);
  if (!head || head.status !== "ready" || head.version !== CODEX_LEDGER_VERSION) return "usage-price-preparation-required";
  if (codexLedgerWorkPending(db, ["rules"]) && !options.policy) return "usage-price-rules-pending";
  // Facts newer than the published ledger leave its committed sums readable (read-freshness.ts);
  // only a price change pending in the range keeps that range "preparing".
  if (codexLedgerHasPendingWork(db, options.range)) return "usage-price-rules-pending";
  if (options.rulesRevision !== undefined && options.rulesRevision !== head.rules_digest) {
    if (!options.range || !options.policy || !head.rules_json) return "usage-price-rules-pending";
    const previous = compileCodexLedgerPolicy(JSON.parse(head.rules_json));
    const tiersChanged = JSON.stringify([previous.policy.mappings, previous.policy.tier_rules])
      !== JSON.stringify([options.policy.policy.mappings, options.policy.policy.tier_rules]);
    if (codexLedgerBaseChanges(previous.baseBands, options.policy.baseBands)
      .some(scope => codexLedgerScopeIntersects(db, scope, options.range))) return "usage-price-rules-pending";
    if (tiersChanged) {
      let cohorts: TierCohort[];
      try { cohorts = observedTierCohorts(db, options.range); }
      catch (error) { if (error instanceof CodexLedgerNotReady) return "usage-price-preparation-required"; throw error; }
      if (tierSemantics(previous, options.range, cohorts) !== tierSemantics(options.policy, options.range, cohorts)) return "usage-price-rules-pending";
    }
  }
  try { requireCodexLedgerReady(db, options.range); }
  catch (error) { if (error instanceof CodexLedgerNotReady) return "usage-price-preparation-required"; throw error; }
  return null;
}
const contextOf = (db: Database, context?: CodexLedgerReadContext, range?: LedgerRange) => context ?? readPublishedCodexLedgerContext(db, range);
interface TierCohort { day: string; model: string | null; service_tier: string | null }
function preparedStampDays(db: Database, range: LedgerRange): CodexStampDay[] {
  if (range.dependencyBases?.length === 0) return [];
  const days = codexStampDays(db, { ...range, ...codexLedgerQuotedDayRange(range) });
  if (!days) throw new CodexLedgerNotReady("Codex read dependencies await background preparation");
  return days;
}
function observedTierCohorts(db: Database, range: LedgerRange, prepared?: CodexStampDay[]): TierCohort[] {
  if (range.dependencyBases?.length === 0) return [];
  const unique = new Map<string, TierCohort>();
  for (const row of prepared ?? preparedStampDays(db, range)) for (const tier of JSON.parse(row.tiers) as (string | null)[]) {
    const cohort = { day: row.day, model: JSON.parse(row.model) as string | null, service_tier: tier };
    unique.set(JSON.stringify([cohort.day, cohort.model, cohort.service_tier]), cohort);
  }
  const cohorts = [...unique.values()].sort((a, b) => a.day.localeCompare(b.day)
    || String(a.model).localeCompare(String(b.model)) || String(a.service_tier).localeCompare(String(b.service_tier)));
  if (range.fromMs === undefined && range.toMs === undefined && range.instantValidity === undefined) return cohorts;
  return cohorts.filter(cohort => {
    // Interior quoted days are wholly inside the UTC request even with a source offset.
    const start = Date.parse(cohort.day), minimum = start - 86400000, maximum = start + 2 * 86400000;
    if (range.instantValidity === undefined
      && (range.fromMs === undefined || (range.startInclusive === false ? minimum > range.fromMs : minimum >= range.fromMs))
      && (range.toMs === undefined || maximum <= range.toMs)) return true;
    // Padding discovers edge days; actual durable instants prove their membership.
    return codexLedgerScopeIntersects(db, { model: cohort.model, rawTier: cohort.service_tier,
      basis: range.dependencyBases?.[0] ?? "api_equivalent_usd", fromDay: cohort.day,
      untilDay: new Date(start + 86400000).toISOString().slice(0,10), inputAbove: null, inputUntil: null }, range);
  });
}
function cohortTiers(policy: CompiledCodexLedgerPolicy, cohort: TierCohort, basis: "api_equivalent_usd" | "chatgpt_credits"): string[] {
  const mapped = policy.classify(cohort.service_tier, cohort.day);
  // Fast credits are a reported counterfactual even when the observed raw tier is NULL.
  return [...new Set([...(basis === "chatgpt_credits" ? ["fast"] : []), ...(mapped ? [mapped] : [])])].sort();
}
function tierSemantics(policy: CompiledCodexLedgerPolicy, range: LedgerRange, cohorts: readonly TierCohort[]): string {
  return JSON.stringify(cohorts.map(cohort => [cohort.day, cohort.model, cohort.service_tier,
    policy.classify(cohort.service_tier,cohort.day),
    (range.dependencyBases ?? ["api_equivalent_usd", "chatgpt_credits"]).map(basis => [basis,
      cohortTiers(policy,cohort,basis).map(tier => {
        // Standard is validated as one and derives directly from its retained base.
        const factor = tier === "standard" ? rational(1n) : policy.multiplier(cohort.model,basis,tier,cohort.day);
        const rule = tier === "standard" ? null : policy.resolveTierRule(cohort.model,basis,tier,cohort.day);
        return [tier, factor ? [String(factor.n),String(factor.d)] : null, rule?.included_usage ?? null];
      })])]));
}
function admittedPolicyModelBasis(range: LedgerRange, model: string, basis: import("./codex-price-ledger").LedgerBaseBand["basis"]): boolean {
  return (!range.dependencyModels || range.dependencyModels.includes(model))
    && (!range.dependencyBases || range.dependencyBases.includes(basis));
}
/** Guard before every cache hit; revisions outside the requested policy range are independent. */
export function requireCodexLedgerReadReady(db: Database, context: CodexLedgerReadContext, range: LedgerRange = {}): void {
  const reason = codexLedgerPendingReason(db, { ...context, range });
  if (reason) throw new CodexLedgerNotReady(reason);
}
const readStamps = new WeakMap<Database, Map<string, { fence: string; stamp: string }>>();
export function codexLedgerReadStamp(db: Database, context: CodexLedgerReadContext, range: LedgerRange = {}): string {
  const compute = () => {
    // A cached stamp never bypasses current publication/readiness evidence.
    requireCodexLedgerReadReady(db, context, range);
    const head = readCodexLedgerState(db)!;
    const prepared = preparedStampDays(db, range);
    const key = analysisHash([range,context.referenceDay ?? null]);
    // The producer advances its own revision in each partial publication transaction. Unrelated
    // timing/probe/provider writes must not force a scan of every historical aggregate on HTTP.
    const pending = codexLedgerFactsPending(db);
    // Its groups carry their project by the rules at read time (projects/rules-now.ts).
    const rules = range.dependencyProjects === false ? null : projectRulesStamp(db);
    const fence = analysisHash([head.version,prepared,head.rules_digest,context.rulesRevision,context.policy.policy,pending,rules,
      range.fromMs !== undefined || range.toMs !== undefined || range.instantValidity !== undefined ? head.revision : null]);
    let cache = readStamps.get(db);
    if (!cache) { cache = new Map(); readStamps.set(db,cache); }
    const cached = cache.get(key);
    if (cached?.fence === fence) return cached.stamp;
    const stamp = analysisHash([computeCodexLedgerReadStamp(db,context,range,head,prepared),pending ? "pending" : "current",rules]);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key,{fence,stamp});
    return stamp;
  };
  // Both bases, policy proof and pending work belong to one SQLite read snapshot.
  return withCodexLedgerStoredSnapshot(db, compute);
}
function computeCodexLedgerReadStamp(db: Database, context: CodexLedgerReadContext, range: LedgerRange, head: CodexLedgerState, prepared: CodexStampDay[]): string {
  const baseBands = context.policy.baseBands.filter(band => admittedPolicyModelBasis(range, band.model, band.basis));
  // Only published cohorts are dependencies. An unused context/model/rate must not evict a prepared report.
  const bases = (range.dependencyBases ?? ["api_equivalent_usd", "chatgpt_credits"]).map(basis => {
    const rows = prepared.filter(row => row.basis === basis);
    const evidence = [...new Set(rows.flatMap(row => JSON.parse(row.bands) as number[]))].sort((a,b)=>a-b).map(id=>{
      const band = readCodexLedgerPublishedBand(db,id);
      if (!band || band.basis !== basis) throw new Error("Published cohort has no matching immutable base proof");
      return [id,codexLedgerBandRevision(band),band.evidence];
    });
    return [basis,rows.map(row => [row.day,row.model,row.signature]),evidence];
  });
  const cohorts = observedTierCohorts(db,range,prepared);
  const tierEvidence = cohorts.flatMap(cohort => (range.dependencyBases ?? ["api_equivalent_usd", "chatgpt_credits"])
    .flatMap(basis => cohortTiers(context.policy,cohort,basis).map(tier => {
      const rule = context.policy.resolveTierRule(cohort.model,basis,tier,cohort.day);
      // Actual nonstandard tiers publish full declaration dates in applied-rule metadata.
      const actual = tier !== "standard" && tier === context.policy.classify(cohort.service_tier,cohort.day);
      return [cohort.day,cohort.model,basis,tier,rule ? [rule.id,rule.verified_at,rule.sources,rule.confidence,rule.note,rule.source_rule_ids,
        ...(actual ? [[rule.valid_from,rule.valid_until ?? null]] : [])] : null];
    })));
  return analysisHash([head.version, CODEX_LEDGER_ARITHMETIC, bases, tierSemantics(context.policy, range, cohorts), tierEvidence,
    context.referenceDay ? [context.referenceDay, codexLedgerReferenceFingerprint(baseBands, context.referenceDay)] : null]);
}
const countNumber = (value: bigint): number => {
  const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Ledger counter exceeds the compatibility integer domain"); return result;
};
/** Conversion is confined to the existing report boundary; authoritative money remains rational. */
export function ledgerPresentationNumber(value: Rational): number {
  if (value.n === 0n) return 0;
  const sign = value.n < 0n ? "-" : "", n = value.n < 0n ? -value.n : value.n;
  const exponent = n.toString().length - value.d.toString().length;
  const scale = 20 - exponent;
  const digits = scale >= 0 ? n * 10n ** BigInt(scale) / value.d : n / (value.d * 10n ** BigInt(-scale));
  const result = Number(`${sign}${digits}e${-scale}`);
  if (!Number.isFinite(result)) throw new Error("Ledger amount exceeds the presentation number domain");
  return result;
}
const presentationText = (value: Rational): string => serializeRational(value).decimal ?? String(ledgerPresentationNumber(value));
export function ledgerAmountToCompatibility(value: LedgerAmount): UsagePriceAmount {
  return { subtotal: presentationText(value.subtotal), pricedSubtotal: presentationText(value.pricedSubtotal),
    value: value.value === null ? null : presentationText(value.value),
    pricedEvents: String(value.pricedEvents), unpricedEvents: String(value.unpricedEvents),
    pricedTokens: String(value.pricedTokens), unpricedTokens: String(value.unpricedTokens),
    reasons: Object.fromEntries(Object.entries(value.reasons).map(([reason, counter]) => [reason,
      { events: String(counter.events), tokens: String(counter.tokens) }])),
    exact: { subtotal: serializeRational(value.subtotal), pricedSubtotal: serializeRational(value.pricedSubtotal),
      value: value.value === null ? null : serializeRational(value.value) } };
}
export function ledgerAmountFromCompatibility(value: UsagePriceAmount): LedgerAmount {
  const read = (field: "subtotal" | "pricedSubtotal"): Rational => value.exact
    ? rational(BigInt(value.exact[field].numerator), BigInt(value.exact[field].denominator)) : decimal(value[field]);
  const subtotal = read("subtotal"), unpricedEvents = BigInt(value.unpricedEvents);
  return { subtotal, pricedSubtotal: read("pricedSubtotal"), value: unpricedEvents ? null : subtotal,
    pricedEvents: BigInt(value.pricedEvents), unpricedEvents, pricedTokens: BigInt(value.pricedTokens), unpricedTokens: BigInt(value.unpricedTokens),
    reasons: Object.fromEntries(Object.entries(value.reasons).map(([reason, count]) => [reason,
      { events: BigInt(count.events), tokens: BigInt(count.tokens) }])) };
}
export function sumCodexLedgerCompatibilityAmounts(rows: Iterable<UsagePriceAmount | undefined>): UsagePriceAmount {
  let sum = emptyLedgerAmount();
  for (const row of rows) if (row) sum = mergeLedgerAmounts(sum, ledgerAmountFromCompatibility(row));
  return ledgerAmountToCompatibility(sum);
}
function actualCredits(group: LedgerReadGroup<readonly LedgerVariant[]>): LedgerAmount {
  const extra = group.variants.extra_credits, standard = group.variants.credits_standard;
  if (!extra || !standard) throw new Error("Actual credits require both Standard and extra credit amounts");
  if (extra.unpricedEvents) return extra;
  const subtotal = add(standard.subtotal, extra.subtotal);
  return { ...extra, subtotal, pricedSubtotal: subtotal, value: subtotal };
}
function variants(group: LedgerReadGroup<readonly LedgerVariant[]>): Record<string, LedgerAmount> {
  return { ...group.variants, credits_actual: actualCredits(group) };
}
const dimensionKey = (group: Pick<LedgerReadGroup,"stored"|"tier">) => analysisHash([group.stored.source, null, group.stored.model, group.tier ?? "unknown",
  group.stored.subject, group.stored.billing_mode, group.stored.surface, group.stored.nested, null]).slice(0, 16);
const HOUR_MS = 3_600_000;
const periodRange = (range: UsagePriceRange | null | undefined): LedgerRange => {
  if(!range)return {};
  if(!isAccountingDay(range.since)||!isAccountingDay(range.until))throw new Error("Invalid accounting day range");
  return {fromMs:Date.parse(range.since),toMs:Date.parse(range.until)+86400000};
};
/** UTC calendar ranges use aggregates inside the range and stored bases at offset-sensitive edges: the stored rows, not yet valued. */
function periodStored(db:Database,current:CodexLedgerReadContext,range:LedgerRange):LedgerStoredGroup[] {
  requireCodexLedgerReadReady(db, current, range);
  const from=range.fromMs,to=range.toMs,width=86400000;
  if(from===undefined||to===undefined||from%width||to%width||range.startInclusive===false||range.endInclusive
    ||range.since!==undefined||range.until!==undefined||range.instantValidity!==undefined||to<=from)
    return [...readCodexLedgerStoredSnapshot(db,range)];
  const day=(instant:number)=>new Date(instant).toISOString().slice(0,10);
  const last=to-width,parts:LedgerStoredGroup[]=[];
  const append=(part:LedgerRange)=>parts.push(...readCodexLedgerStoredSnapshot(db,{...part,grain:range.grain,
    dependencyBases:range.dependencyBases,dependencyModels:range.dependencyModels,copyPaths:range.copyPaths,sources:range.sources,models:range.models}));
  if(last===from) append({since:day(from-width),until:day(to),fromMs:from,toMs:to});
  else {
    append({since:day(from-width),until:day(from),fromMs:from,toMs:to});
    if(last>from+width) append({since:day(from+width),until:day(last-width)});
    append({since:day(last),until:day(to),fromMs:from,toMs:to});
  }
  return parts;
}
function periodSeries<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS>(db:Database,current:CodexLedgerReadContext,
  range:LedgerRange,requestedVariants?:Requested):LedgerReadGroup<Requested>[] {
  return deriveCodexLedgerGroups(db,current.policy,periodStored(db,current,range),requestedVariants);
}
/** A linear projection of homogeneous stored base sums into their token buckets, with an invariant check. */
export function codexLedgerApiTokenAmounts(db: Database, group: Pick<LedgerReadGroup,"stored"|"tokens"> &
  { variants: Pick<LedgerReadGroup["variants"],"api_standard"> }, _context: CodexLedgerReadContext):
  { in_uncached: Rational; cache_read: Rational; cache_write: Rational; out: Rational } | null {
  if (group.variants.api_standard.value === null) return null;
  const compiled = readCodexLedgerPublishedBand(db, group.stored.api_band);
  if (!compiled) throw new Error("Published token breakdown has no matching exact coefficient band");
  const part = (bucket: "in_uncached" | "in_cache_read" | "in_cache_write" | "out_total", count: bigint): Rational => {
    const coefficient = compiled.coefficients.buckets[bucket];
    if (!coefficient) { if (count) throw new Error("Priced base has no token-bucket coefficient"); return rational(0n); }
    return multiply(rational(coefficient.whole * compiled.coefficients.denominator + coefficient.remainder,
      compiled.coefficients.denominator * NANO_UNITS), rational(count));
  };
  const values = { in_uncached: part("in_uncached", group.tokens.in_uncached!), cache_read: part("in_cache_read", group.tokens.in_cache_read!),
    cache_write: part("in_cache_write", group.tokens.in_cache_write_unknown!), out: part("out_total", group.tokens.out_total!) };
  if (!equal(Object.values(values).reduce(add, rational(0n)), originalContextApi(db, group, group.variants.api_standard.value)!)) throw new Error("Stored base and token-bucket projection disagree");
  return values;
}
export interface OwnedGroup<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS> { group: LedgerReadGroup<Requested>; account: string | null }
/** The dimension metadata a coarse group keeps (`readCodexLedgerOwnedSeries` with `coarse`): what calls are counted and valued by. */
const COARSE_FIELDS = ["day", "source", "home", "model", "service_tier", "speed", "subject", "billing_mode", "surface", "nested",
  "api_band", "credit_band", "api_reason", "credit_reason", "api_zero", "credit_zero", "copy_state"] as const;
const SUMMED_FIELDS = ["calls", "reported", "uncached", "cached", "writes", "output", "reasoning", "window_input", "window_cached", "window_output",
  "invalid_tokens", "api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo", "credit_whole_hi", "credit_whole_lo",
  "credit_fraction_hi", "credit_fraction_lo", "timed_calls", "timed_out", "timed_ms", "timed_long_calls", "timed_long_out", "timed_long_ms"] as const;
/**
 * Stored groups of one owner, hour and coarse key summed before they are valued. Valuation is linear in the stored sums for
 * a fixed pricing day, model, tier, price cohort and copy state (all in the key), so this is the same value as summing the
 * valued groups, at a fraction of the exact arithmetic. Metadata outside the key (project, directory, plan, meter reset) is dropped.
 */
function coarseGroups(db: Database, owned: ReadonlyArray<{ row: LedgerStoredGroup; account: string | null }>): Array<{ row: LedgerStoredGroup; account: string | null }> {
  const members = contextReadScope(db)?.members;
  const merged = new Map<string, { row: LedgerStoredGroup; account: string | null; sums: Array<bigint | null>; members?: LedgerStoredGroup[] }>();
  for (const { row, account } of owned) {
    const key = JSON.stringify([account, row.hour ?? null, ...COARSE_FIELDS.map(field => row[field])]);
    const current = merged.get(key);
    const values = SUMMED_FIELDS.map(field => row[field] === null ? null : BigInt(row[field]!));
    if (!current) {
      merged.set(key, { account, sums: values, ...(members ? { members: [row] } : {}), row: { ...row, dim_id: -1, plan_type: null, meter_reset: null, repo: null, project_id: null,
        project: null, cwd: null } });
      continue;
    }
    current.sums = current.sums.map((sum, index) => sum === null || values[index] === null ? null : sum + values[index]!);
    current.members?.push(row);
    if (row.first_ts < current.row.first_ts) current.row.first_ts = row.first_ts;
    if (row.last_ts > current.row.last_ts) current.row.last_ts = row.last_ts;
  }
  return [...merged.values()].map(({ row, account, sums, members: children }) => {
    if (children) members!.set(row, children);
    SUMMED_FIELDS.forEach((field, index) => { (row as unknown as Record<string, string | null>)[field] = sums[index] === null ? null : String(sums[index]); });
    return { row, account };
  });
}
/**
 * Only account boundary slices consult indexed stored bases; no event repricing or restamping. With `coarse`, the groups of
 * one owner and hour that differ only in metadata the coarse key leaves out are one group (see `coarseGroups`).
 */
/**
 * The instants strictly inside (from, until) where a period of the stored `source` begins or ends: an owned read splits a
 * cohort there, since its calls on either side may belong to different accounts. Plans name sources normalized, so the
 * stored spelling is normalized the same way before matching.
 */
export function codexOwnershipCuts(ranges: readonly SourceRange[], source: string | null, from: number, until: number): number[] {
  if (source === null) return [];
  const key = normEraKey(source);
  return [...new Set(ranges.filter(range => range.source === key).flatMap(range => [range.from, range.until])
    .filter(boundary => Number.isFinite(boundary) && boundary > from && boundary < until))].sort((a, b) => a - b);
}
/** Mixed valid/invalid hour cohorts are split only at their bounded stored bases. */
function validTokenGroups(db: Database, rows: readonly LedgerStoredGroup[], range: LedgerRange): LedgerStoredGroup[] {
  const invalid = (row: LedgerStoredGroup) => row.api_reason === "invalid_tokens" || row.credit_reason === "invalid_tokens" ? BigInt(row.calls) : BigInt(row.invalid_tokens);
  const keys = ["day", "dim_id", "api_band", "credit_band", "api_reason", "credit_reason", "api_zero", "credit_zero", "copy_state"] as const;
  return rows.flatMap(row => {
    const bad = invalid(row);
    if (!bad) return [row];
    if (bad >= BigInt(row.calls)) return [];
    if (row.hour == null) throw new Error("Valid-token projection requires hourly sums");
    const from = Math.max(row.hour * HOUR_MS, range.fromMs ?? -Infinity);
    const until = Math.min((row.hour + 1) * HOUR_MS, range.toMs === undefined ? Infinity : range.toMs + (range.endInclusive ? 1 : 0));
    return readCodexLedgerPieceSums(db, [[from, until]], { where: { sql: "id=?", params: [row.dim_id] } })
      .filter(part => invalid(part) === 0n && keys.every(key => part[key] === row[key])).map(part => ({ ...part, hour: row.hour }));
  });
}

export function readCodexLedgerOwnedSeries<Requested extends readonly LedgerVariant[] = typeof CODEX_LEDGER_VARIANTS>(db: Database, range: LedgerRange, resolver: AccountResolver,
  context?: CodexLedgerReadContext, requestedVariants?:Requested, options: { coarse?: boolean; validTokensOnly?: boolean } = {}): OwnedGroup<Requested>[] {
  const current = contextOf(db, context, range);
  const raw = periodStored(db,current,range);
  const stored = options.validTokensOnly ? validTokenGroups(db, raw, range) : raw;
  const paths = resolver.accounts("codex").flatMap(account => resolver.plan("codex", account).ranges);
  const owned: Array<{ row: LedgerStoredGroup; account: string | null }> = [], slices = new Map<string, readonly LedgerStoredGroup[]>();
  for (const row of stored) {
    const emit = (group: LedgerStoredGroup) => {
      const instant=Date.parse(group.first_ts);
      owned.push({row:group,account:codexEventOwner(Number.isFinite(instant)
        ? resolver.resolve("codex",row.source,null,new Date(instant).toISOString()).account : null,row)});
    };
    // A day group's calls lie within a day of its pricing day (time-zone offsets); an hour group's within its hour.
    const hourly = row.hour !== undefined && row.hour !== null;
    const from = hourly ? row.hour! * HOUR_MS : Date.parse(row.day) - 86_400_000, until = hourly ? from + HOUR_MS : from + 3 * 86_400_000;
    const cuts = codexOwnershipCuts(paths, row.source, from, until);
    if (!cuts.length || !Number.isFinite(Date.parse(row.first_ts)) || !Number.isFinite(Date.parse(row.last_ts))) { emit(row); continue; }
    const boundaries = [from, ...cuts, until];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const lower = Math.max(boundaries[index]!, range.fromMs ?? from), upper = Math.min(boundaries[index + 1]!, range.toMs ?? until);
      if (upper < lower || upper === lower && !range.endInclusive) continue;
      const cacheKey = JSON.stringify([row.day, lower, upper, range.startInclusive, range.endInclusive]);
      let part = slices.get(cacheKey);
      if (!part) { const sliceRange = { ...range, since: row.day, until: row.day,
        fromMs: lower, toMs: upper, startInclusive: lower === range.fromMs ? range.startInclusive : true,
        endInclusive: upper === range.toMs && (upper < boundaries[index + 1]! || index === boundaries.length - 2) ? range.endInclusive : false };
        part = readCodexLedgerStoredSnapshot(db, sliceRange);
        if (options.validTokensOnly) part = validTokenGroups(db, part, sliceRange);
        slices.set(cacheKey, part); }
      for (const group of part) if (group.hour === row.hour && group.dim_id === row.dim_id && group.api_band === row.api_band
        && group.credit_band === row.credit_band && group.api_reason === row.api_reason
        && group.credit_reason === row.credit_reason && group.api_zero === row.api_zero
        && group.credit_zero === row.credit_zero && group.copy_state === row.copy_state) emit(group);
    }
  }
  const valued = options.coarse ? coarseGroups(db, owned) : owned;
  const groups = deriveCodexLedgerGroups(db, current.policy, valued.map(item => item.row), requestedVariants);
  return groups.map((group, index) => ({ group, account: valued[index]!.account }));
}
/** Canonical stored day groups of one owner summed in SQL and valued at the API Standard rate (`readCodexLedgerOwnedDaySums`). */
export interface CodexOwnedDaySum {
  day: string; account: string | null;
  /**
   * Position of its first stored group in the ledger's read order (day, dim_id, then the slice of a cut day): sorted by
   * it, sums appear in the order their first calls appear in `readCodexLedgerOwnedSeries`.
   */
  dim: number; seq: number;
  /** The model unpriced tokens are reported under; null on a sum made of priced groups only. */
  model: string | null;
  calls: bigint; tokens: bigint; unpricedTokens: bigint; unpricedEvents: bigint;
  /** Priced API Standard USD, exact but not reduced (`d` is the band's denominator × 10^9 on a summed group). */
  usd: Rational;
  first_ts: string; last_ts: string;
}
const DAY_MS = 86_400_000;
/** One SQL sum of canonical day groups: a priced one (`band` set) or an unpriced one (`model`, the model it is reported under). */
interface SqlSum { dim: number; billing_mode: string | null; band: number | null; model: string | null; calls: string; tokens: string;
  reported: string; whole_hi: string | null; whole_lo: string | null; fraction_hi: string | null; fraction_lo: string | null;
  first_ts: string; last_ts: string; irregular: number }
const LIMBS = ["api_whole_hi", "api_whole_lo", "api_fraction_hi", "api_fraction_lo"] as const;
const PRICED = "COALESCE(a.api_reason,'')=''";
/**
 * The summed columns of canonical day groups: priced ones (an empty API reason, `deriveCodexLedgerGroup`) by band, unpriced
 * ones by model. `irregular` counts groups the sum cannot value exactly (invalid instants, missing or negative limbs).
 */
const DAY_SUM_COLUMNS = `CASE WHEN ${PRICED} THEN a.api_band END band,CASE WHEN ${PRICED} THEN NULL ELSE d.model END model,d.billing_mode,
  CAST(SUM(a.calls) AS TEXT) calls,CAST(SUM(a.uncached+a.cached+a.writes+a.output) AS TEXT) tokens,CAST(SUM(a.reported) AS TEXT) reported,
  ${LIMBS.map(limb => `CAST(SUM(a.${limb}) AS TEXT) ${limb.slice(4)}`).join(",")},MIN(a.first_ts) first_ts,MAX(a.last_ts) last_ts,
  SUM(julianday(a.first_ts) IS NULL OR julianday(a.last_ts) IS NULL OR a.calls<=0
    OR ${PRICED} AND (${LIMBS.map(limb => `a.${limb} IS NULL OR a.${limb}<0`).join(" OR ")})) irregular`;
const LIMB_RADIX = 1_000_000_000n;
function sqlSumAmounts(row: SqlSum, denominators: ReadonlyMap<number, bigint>): Pick<CodexOwnedDaySum, "usd" | "unpricedTokens" | "unpricedEvents"> {
  if (row.band === null) return { usd: { n: 0n, d: 1n }, unpricedTokens: BigInt(row.reported), unpricedEvents: BigInt(row.calls) };
  const denominator = denominators.get(row.band);
  if (!denominator) throw new Error("Published base has no exact band denominator");
  const whole = BigInt(row.whole_hi!) * LIMB_RADIX + BigInt(row.whole_lo!);
  return { usd: { n: whole * denominator + BigInt(row.fraction_hi!) * LIMB_RADIX + BigInt(row.fraction_lo!), d: denominator * NANO_UNITS },
    unpricedTokens: 0n, unpricedEvents: 0n };
}
/**
 * The owned API Standard sums of whole stored days, for history screens: the canonical day groups of the range summed in SQL
 * by what their owner and their valuation depend on, so the read costs one row per day, source and price band, not one per
 * stored group. Accounts stay a read-time join (periods are never stamped into rows):
 * - the owner of a group is its source's period at its first call (`codexEventOwner`, so the billing mode is a key);
 * - an API Standard amount is linear in the stored limbs for one band denominator (the band is a key of priced groups); an
 *   unpriced group contributes its calls and reported tokens under its model (the model is a key of unpriced groups).
 * Every other day of a source is read per stored group through `readCodexLedgerOwnedSeries`, unchanged, so it stays the one
 * engine that splits calls at period boundaries: a day whose window holds a period boundary of its source
 * (`codexOwnershipCuts`), a day whose first-call instants resolve to two owners, and a day holding a row the SQL sum cannot
 * value exactly (invalid instants or limbs). On the other days every stored group of one source and billing mode has one
 * owner, so a sum placed at its first group (`MIN(dim_id)`) keeps the order owners first appear in.
 */
export function readCodexLedgerOwnedDaySums(db: Database, range: Pick<LedgerRange, "since" | "until" | "dependencyBases">,
  resolver: AccountResolver, context?: CodexLedgerReadContext): CodexOwnedDaySum[] {
  const current = contextOf(db, context, range);
  if (contextReadScope(db)) return readCodexLedgerOwnedSeries(db, range, resolver, current, ["api_standard"] as const)
    .filter(({ group }) => group.selected).map(({ group, account }, seq) => ({ day: group.stored.day, account,
      dim: group.stored.dim_id, seq, model: group.stored.model, calls: group.calls,
      tokens: group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown! + group.tokens.out_total!,
      unpricedTokens: group.variants.api_standard.unpricedTokens, unpricedEvents: group.variants.api_standard.unpricedEvents,
      usd: group.variants.api_standard.pricedSubtotal, first_ts: group.stored.first_ts, last_ts: group.stored.last_ts }));
  return withCodexLedgerStoredSnapshot(db, () => {
    requireCodexLedgerReadReady(db, current, range);
    const terms = ["a.grain='day'", "a.copy_state='canonical'"], params: string[] = [];
    if (range.since !== undefined) { if (!isAccountingDay(range.since)) throw new Error("Invalid lexical day range"); terms.push("a.day>=?"); params.push(range.since); }
    if (range.until !== undefined) { if (!isAccountingDay(range.until)) throw new Error("Invalid lexical day range"); terms.push("a.day<=?"); params.push(range.until); }
    const rows = db.query(`SELECT a.day,d.source,MIN(a.dim_id) dim,MAX(a.first_ts) first_max,
        ${DAY_SUM_COLUMNS}
      FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
      WHERE ${terms.join(" AND ")}
      GROUP BY a.day,d.source,d.billing_mode,band,model`).all(...params) as Array<SqlSum & { day: string; source: string | null; first_max: string }>;
    const denominators = new Map((db.query("SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands WHERE basis='api_equivalent_usd'")
      .all() as { id: number; denominator: string }[]).map(band => [band.id, BigInt(band.denominator)]));
    const paths = resolver.accounts("codex").flatMap(account => resolver.plan("codex", account).ranges);
    const ownerAt = (row: { source: string | null; billing_mode: string | null }, instant: number) =>
      codexEventOwner(resolver.resolve("codex", row.source, null, new Date(instant).toISOString()).account, row);
    const summed: Array<CodexOwnedDaySum & { source: string | null }> = [];
    const detailed = new Map<string, Set<string | null>>();
    const mark = (day: string, source: string | null) => {
      const sources = detailed.get(day) ?? new Set<string | null>(); sources.add(source); detailed.set(day, sources);
    };
    for (const row of rows) {
      const from = Date.parse(row.day) - DAY_MS, first = Date.parse(row.first_ts), latest = Date.parse(row.first_max);
      if (row.irregular || !Number.isFinite(first) || !Number.isFinite(latest) || !Number.isFinite(Date.parse(row.last_ts))
        || codexOwnershipCuts(paths, row.source, from, from + 3 * DAY_MS).length) { mark(row.day, row.source); continue; }
      const account = ownerAt(row, first);
      if (account !== ownerAt(row, latest)) { mark(row.day, row.source); continue; }
      summed.push({ day: row.day, source: row.source, account, dim: row.dim, seq: 0, model: row.model, calls: BigInt(row.calls),
        tokens: BigInt(row.tokens), ...sqlSumAmounts(row, denominators), first_ts: row.first_ts, last_ts: row.last_ts });
    }
    const out: CodexOwnedDaySum[] = summed.filter(row => !detailed.get(row.day)?.has(row.source)).map(({ source: _source, ...row }) => row);
    // The rest are read per stored group, in its order (`seq`); consecutive days are one read (its cut slices read the calls
    // through the time index, so the read is not narrowed by source).
    const days = [...detailed.keys()].sort();
    for (let start = 0; start < days.length;) {
      let end = start;
      while (end + 1 < days.length && Date.parse(days[end + 1]!) - Date.parse(days[end]!) === DAY_MS) end++;
      const groups = readCodexLedgerOwnedSeries(db, { ...range, since: days[start]!, until: days[end]! }, resolver, current, ["api_standard"] as const);
      groups.forEach(({ group, account }, seq) => {
        if (!group.selected || !detailed.get(group.stored.day)?.has(group.stored.source)) return;
        const amount = group.variants.api_standard;
        out.push({ day: group.stored.day, account, dim: group.stored.dim_id, seq, model: group.stored.model,
          calls: group.calls, tokens: group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown! + group.tokens.out_total!,
          unpricedTokens: amount.unpricedTokens, unpricedEvents: amount.unpricedEvents, usd: amount.pricedSubtotal,
          first_ts: group.stored.first_ts, last_ts: group.stored.last_ts });
      });
      start = end + 1;
    }
    return out.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.dim - b.dim || a.seq - b.seq);
  });
}
type Sum = { calls: bigint; reported: bigint; tokens: Record<string, bigint>; quality: Record<string, bigint>;
  variants: Record<string, LedgerAmountSum>; first: string; last: string; window: { input: bigint; cached: bigint; output: bigint } };
function emptySum(): Sum { return { calls: 0n, reported: 0n, tokens: {}, quality: {}, variants: {}, first: "", last: "",
  window: { input: 0n, cached: 0n, output: 0n } }; }
function accumulate(sum: Sum, group: LedgerReadGroup<readonly LedgerVariant[]>, unattributed = false, requestedVariants?: readonly LedgerVariant[]): void {
  sum.calls += group.calls; sum.reported += group.tokensReported;
  if (!sum.first || group.stored.first_ts < sum.first) sum.first = group.stored.first_ts;
  if (group.stored.last_ts > sum.last) sum.last = group.stored.last_ts;
  for (const [key, value] of Object.entries(group.tokens)) sum.tokens[key] = (sum.tokens[key] ?? 0n) + value;
  for (const [key, value] of Object.entries(group.quality)) sum.quality[key] = (sum.quality[key] ?? 0n) + value;
  sum.quality.source_events = (sum.quality.source_events ?? 0n) + group.calls;
  if (unattributed) sum.quality.unattributed_events = (sum.quality.unattributed_events ?? 0n) + group.calls;
  const amounts = requestedVariants ? requestedVariants.map(key => [key, group.variants[key]] as const) : Object.entries(variants(group));
  for (const [key, value] of amounts) {
    if (!value) throw new Error(`Requested ledger variant was not derived: ${key}`);
    (sum.variants[key] ??= new LedgerAmountSum()).add(value);
  }
  for (const key of ["input", "cached", "output"] as const) sum.window[key] += group.windowTokens[key];
}
/**
 * The same variants, each converted on first read: a report reads a few of the dozen per row, and the exact
 * conversion (reduced fractions to text) is most of a register read's cost.
 */
function lazyCompatibleVariants(sum: Sum): Record<string, UsagePriceAmount> {
  const out: Record<string, UsagePriceAmount> = {};
  for (const [key, value] of Object.entries(sum.variants)) Object.defineProperty(out, key, { enumerable: true, configurable: true,
    get() {
      const converted = ledgerAmountToCompatibility(value.total());
      Object.defineProperty(out, key, { value: converted, enumerable: true, writable: true, configurable: true });
      return converted;
    } });
  return out;
}
const compatibleVariants = (sum: Sum): Record<string, UsagePriceAmount> => Object.fromEntries(Object.entries(sum.variants)
  .map(([key, value]) => [key, ledgerAmountToCompatibility(value.total())]));
const textMap = (values: Record<string, bigint>, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, String(values[key] ?? 0n)]));
export function readCodexLedgerCompatibilityDays(db: Database, range: UsagePriceRange,
  resolver: AccountResolver, context?: CodexLedgerReadContext): CodexRegisterDay[] {
  return codexLedgerCompatibilityDays(readCodexLedgerOwnedSeries(db, periodRange(range), resolver, context));
}
/** Owned ledger groups summed per day (and hour, for hour groups), dimension, selection, account and home. */
export function codexLedgerCompatibilityDays(rows: Iterable<OwnedGroup>, requestedVariants?: readonly LedgerVariant[]): CodexRegisterDay[];
export function codexLedgerCompatibilityDays<Requested extends readonly LedgerVariant[]>(rows: Iterable<OwnedGroup<Requested>>,
  requestedVariants: readonly Requested[number][]): CodexRegisterDay[];
export function codexLedgerCompatibilityDays(rows: Iterable<OwnedGroup<readonly LedgerVariant[]>>, requestedVariants?: readonly LedgerVariant[]): CodexRegisterDay[] {
  const sums = new Map<string, { row: OwnedGroup<readonly LedgerVariant[]>; sum: Sum; dim: string }>();
  for (const row of rows) {
    const dim = dimensionKey(row.group), key = JSON.stringify([row.group.stored.day, row.group.stored.hour ?? null, dim, row.group.selected, row.account, row.group.stored.home]);
    const current = sums.get(key) ?? { row, sum: emptySum(), dim };
    accumulate(current.sum, row.group, row.account === null || row.account.startsWith("codex-unassigned"), requestedVariants); sums.set(key, current);
  }
  return [...sums.values()].map(({ row: { group, account }, sum, dim }) => ({
    day: group.stored.day, ...(group.stored.hour == null ? {} : { hour: group.stored.hour }),
    dim, selected: group.selected, account, home: group.stored.home, model: group.stored.model,
    speed: group.tier ?? "unknown", subject: group.stored.subject, billing_mode: group.stored.billing_mode,
    surface: group.stored.surface, nested: group.stored.nested, calls: countNumber(sum.calls), tokensReported: countNumber(sum.reported),
    tokens: Object.fromEntries(USAGE_PRICE_TOKEN_KEYS.map(key => [key, countNumber(sum.tokens[key] ?? 0n)])),
    first_ts: sum.first, last_ts: sum.last, variants: lazyCompatibleVariants(sum), quality: Object.fromEntries([
      "duplicates", "conflicts", "conflicted_identities", "approximate_time_events", "invalid_token_events", "unattributed_events", "unknown_speed_tokens"]
      .map(key => [key, countNumber(sum.quality[key] ?? 0n)])) as CodexRegisterDay["quality"],
  })).sort((a, b) => a.day.localeCompare(b.day) || a.dim.localeCompare(b.dim) || Number(b.selected) - Number(a.selected)
    || (a.account ?? "").localeCompare(b.account ?? ""));
}
/**
 * Spark/main model evidence per physical rollout file (and meter reset), which the copy-free sums do not carry: the
 * ledger's per-file hour rows of the requested instants, over resolved copies of either state (a duplicate copy proves
 * the same file's models). Owners resolve at each row's first and last instant; a file hour spanning an account
 * boundary, or cut by the range, is read per call (one hour of one file).
 */
export function readCodexLedgerCompatibilityMeterModels(db: Database, range: UsagePriceRange, resolver: AccountResolver,
  account?: string, context?: CodexLedgerReadContext): CodexMeterModelRow[] {
  const bounds = periodRange(range), from = bounds.fromMs!, to = bounds.toMs!;
  requireCodexLedgerReadReady(db, contextOf(db, context, bounds), bounds);
  const rows = db.query(`SELECT f.hour,f.dim_id,f.copy_id,f.first_ms,f.last_ms,c.home,c.path,c.source,d.model,d.meter_reset,d.billing_mode
    FROM codex_price_ledger_file_models f JOIN codex_price_ledger_copies c ON c.id=f.copy_id JOIN codex_price_ledger_dims d ON d.id=f.dim_id
    WHERE f.hour>=? AND f.hour<?`).all(Math.floor(from / HOUR_MS), Math.ceil(to / HOUR_MS)) as Array<{ hour: number; dim_id: number;
      copy_id: number; first_ms: number; last_ms: number; home: string | null; path: string | null; source: string | null; model: string | null;
      meter_reset: number | null; billing_mode: string | null }>;
  const ownerAt = (source: string | null, billing: string | null, instant: number) => {
    const owner = codexEventOwner(resolver.resolve("codex", source, null, new Date(instant).toISOString()).account, { billing_mode: billing });
    // Meter-model evidence names the source owner, not a billing pool.
    return owner?.endsWith("::business") ? owner === "codex-unassigned::business" ? "" : owner.slice(0, -"::business".length) : owner ?? "";
  };
  const perCall = db.query(`SELECT instant_ms FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_time
    WHERE instant_ms>=? AND instant_ms<? AND copy_id=? AND dim_id=? AND admitted=1 AND copy_state<>'pending'`);
  const sums = new Map<string, CodexMeterModelRow>();
  for (const row of rows) {
    if (!row.home || !row.path) continue;
    const lower = Math.max(row.hour * HOUR_MS, from), upper = Math.min((row.hour + 1) * HOUR_MS, to);
    const whole = lower === row.hour * HOUR_MS && upper === (row.hour + 1) * HOUR_MS;
    const first = ownerAt(row.source, row.billing_mode, row.first_ms), last = ownerAt(row.source, row.billing_mode, row.last_ms);
    const owners = whole && first === last ? [first] : [...new Set((perCall.all(lower, upper, row.copy_id, row.dim_id) as { instant_ms: number }[])
      .map(call => ownerAt(row.source, row.billing_mode, call.instant_ms)))];
    for (const resolved of owners) {
      if (account !== undefined && resolved !== account.toLowerCase()) continue;
      for (const reset of new Set([-1, row.meter_reset ?? -1])) {
        const key = JSON.stringify([row.home, row.path, reset, resolved]);
        const sum = sums.get(key) ?? { home: row.home, path: row.path, meter_reset: reset, account: resolved, spark: false, main: false };
        sum.spark ||= row.model === "gpt-5.3-codex-spark";
        sum.main ||= !!row.model && row.model !== "?" && row.model !== "gpt-5.3-codex-spark";
        sums.set(key, sum);
      }
    }
  }
  return [...sums.values()];
}
export function readCodexLedgerCompatibilityDimRows(db: Database, context: CodexLedgerReadContext, range?: UsagePriceRange | null,
  mirror: UsagePriceMirror = "all"): UsagePriceDimRow[] {
  void mirror; // Copies are resolved per call when the ledger is built; every range reads the same canonical calls.
  const groups = periodSeries(db,context,periodRange(range));
  const sums = new Map<string, { group: LedgerReadGroup; sum: Sum; dim: string }>();
  for (const group of groups) {
    if (!group.selected) continue;
    const dim = dimensionKey(group), key = JSON.stringify([group.stored.day, dim]);
    const current = sums.get(key) ?? { group, sum: emptySum(), dim }; accumulate(current.sum, group); sums.set(key, current);
  }
  return [...sums.values()].map(({ group, sum, dim }) => ({ source: group.stored.source, identity: null, model: group.stored.model,
    speed: group.tier ?? "unknown", subject: group.stored.subject, billing_mode: group.stored.billing_mode, surface: group.stored.surface,
    nested: group.stored.nested, vendor: null, dim, day: group.stored.day, calls: String(sum.calls),
    tokens: textMap(sum.tokens, USAGE_PRICE_TOKEN_KEYS), tokens_reported: String(sum.reported), first_ts: sum.first,
    first_key: "", last_ts: sum.last, variants: compatibleVariants(sum), quality: textMap(sum.quality, USAGE_PRICE_QUALITY_KEYS) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.dim.localeCompare(b.dim));
}
export function readCodexLedgerRegisterRows(db: Database, resolver: AccountResolver,
  range: UsagePriceRange & { within?: { from: number; until: number }; account?: string },
  context?: CodexLedgerReadContext): RegisterDayRow[] {
  const requested = { ...periodRange(range), ...(range.within ? { fromMs: range.within.from, toMs: range.within.until } : {}) };
  const current = contextOf(db, context, requested);
  const sums = new Map<string, { row: OwnedGroup; sum: Sum; dim: string; copy: string | null }>();
  for (const row of readCodexLedgerOwnedSeries(db, requested, resolver, current)) {
    if (!row.group.selected || range.account !== undefined && row.account?.toLowerCase() !== range.account.toLowerCase()) continue;
    const dim = dimensionKey(row.group), copy = null;
    const key = JSON.stringify([row.group.stored.day, dim, copy, row.account]);
    const existing = sums.get(key) ?? { row, sum: emptySum(), dim, copy };
    accumulate(existing.sum, row.group, row.account === null || row.account.startsWith("codex-unassigned")); sums.set(key, existing);
  }
  return [...sums.values()].map(({ row: { group, account }, sum, dim, copy }) => ({ day: group.stored.day, dim, copy,
    source: group.stored.source, identity: null, model: group.stored.model, speed: group.tier ?? "unknown", subject: group.stored.subject,
    billing_mode: group.stored.billing_mode, surface: group.stored.surface, nested: group.stored.nested, vendor: null,
    calls: countNumber(sum.calls), calls_exact: String(sum.calls), first_ts: sum.first, first_key: "", last_ts: sum.last,
    tokens: JSON.stringify(textMap(sum.tokens, USAGE_PRICE_TOKEN_KEYS)), tokens_reported: String(sum.reported),
    counts: JSON.stringify(compatibleVariants(sum)), quality: JSON.stringify(textMap(sum.quality, USAGE_PRICE_QUALITY_KEYS)), account }));
}
export function readCodexLedgerCompatibilityTotals(db: Database, context: CodexLedgerReadContext | undefined, range?: UsagePriceRange | null,
  mirror: UsagePriceMirror = "all"): UsagePriceTotals {
  const head = readCodexLedgerState(db), reason = codexLedgerPendingReason(db, { ...context, range: periodRange(range) });
  const base = { scope: CODEX_LEDGER_SCOPE, provider: "codex", cursor: head?.covered ?? null,
    provenance: { version: 1, arithmetic: CODEX_LEDGER_ARITHMETIC, rulesDigest: context?.rulesRevision ?? head?.rules_digest ?? "", mirror,
      mirrorPolicy: CODEX_CANONICAL_COPY_POLICY, attribution: null } };
  if (reason) return { ...base, status: "unavailable", reason, calls: "0", tokens: null, tokens_reported: "0",
    first_ts: null, last_ts: null, variants: null, quality: null };
  const rows = readCodexLedgerCompatibilityDimRows(db, contextOf(db, context, periodRange(range)), range, mirror);
  const calls = rows.reduce((sum, row) => sum + BigInt(row.calls), 0n), quantities: Record<string, bigint> = {}, quality: Record<string, bigint> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.tokens)) quantities[key] = (quantities[key] ?? 0n) + BigInt(value);
    for (const [key, value] of Object.entries(row.quality)) quality[key] = (quality[key] ?? 0n) + BigInt(value);
  }
  return { ...base, status: "available", reason: null, calls: String(calls), tokens: textMap(quantities, USAGE_PRICE_TOKEN_KEYS),
    tokens_reported: String(rows.reduce((sum, row) => sum + BigInt(row.tokens_reported), 0n)),
    first_ts: rows.map(row => row.first_ts).sort()[0] ?? null, last_ts: rows.map(row => row.last_ts).sort().at(-1) ?? null,
    variants: Object.fromEntries([...CODEX_LEDGER_VARIANTS, "credits_actual"].map(variant => [variant,
      sumCodexLedgerCompatibilityAmounts(rows.map(row => row.variants[variant]))])), quality: textMap(quality, USAGE_PRICE_QUALITY_KEYS) };
}

/** The cohorts of `readCodexLedgerCohorts` with their published valuation (stored sums under the read's policy). */
export function readCodexLedgerEventCohorts(db: Database, spec: LedgerCohortSpec, context?: CodexLedgerReadContext):
  Array<{ group: LedgerReadGroup; event: LedgerCohortRow }> {
  const range = { fromMs: spec.from, toMs: spec.until };
  const current = contextOf(db, context, range);
  requireCodexLedgerReadReady(db, current, range);
  const bands = db.query("SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands").all() as { id: number; denominator: string }[];
  const denominators = new Map(bands.map(row => [row.id, BigInt(row.denominator)]));
  return readCodexLedgerCohorts(db, spec).map(event => ({ event, group: deriveCodexLedgerGroup(event, denominators, current.policy) }));
}
/**
 * Narrows an event read: calls whose source (`codex_price_ledger_copies.source` as stored) and instant fall in one
 * of `owned` (an account's read plan; a call without an instant is in none), canonical copies only.
 */
export interface CodexEventFilter { owned?: ReadonlyArray<{ sources: readonly string[]; from: number; until: number }>; canonical?: boolean; eventIds?: readonly number[] }
/** Stored per-event bases are exposed only for bounded audit/counter edges; no valuation callback exists. */
export function readCodexLedgerEventGroups(db: Database, from: string, untilExclusive: string,
  context?: CodexLedgerReadContext, filter: CodexEventFilter = {}): { group: LedgerReadGroup; event: Record<string, string | number | null> }[] {
  const { owned, canonical } = filter;
  const ownedParams = owned?.flatMap(range => [...range.sources, range.from, Number.isFinite(range.until) ? range.until : Number.MAX_SAFE_INTEGER]) ?? [];
  const range = from.includes("T") || untilExclusive.includes("T") ? { fromMs: Date.parse(from), toMs: Date.parse(untilExclusive) }
    : { since: from, until: new Date(Date.parse(untilExclusive) - 86400000).toISOString().slice(0, 10) };
  requireCodexLedgerReady(db, range); const current = contextOf(db, context, range);
  requireCodexLedgerReadReady(db, current, range);
  const bands = db.query("SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands").all() as { id: number; denominator: string }[];
  const denominators = new Map(bands.map(row => [row.id, BigInt(row.denominator)]));
  const rows = withPlaceProjects(db, db.query(`SELECT e.*,${metadataColumns()},c.home,c.path,c.source,
    CAST(e.api_whole/1000000000 AS TEXT) api_whole_hi,CAST(e.api_whole%1000000000 AS TEXT) api_whole_lo,
    CAST(e.credit_whole/1000000000 AS TEXT) credit_whole_hi,CAST(e.credit_whole%1000000000 AS TEXT) credit_whole_lo,
    CASE WHEN e.api_reason IS NULL AND e.api_whole=0 AND e.api_fraction_hi=0 AND e.api_fraction_lo=0 THEN 1 ELSE 0 END api_zero,
    CASE WHEN e.credit_reason IS NULL AND e.credit_whole=0 AND e.credit_fraction_hi=0 AND e.credit_fraction_lo=0 THEN 1 ELSE 0 END credit_zero
    FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id JOIN codex_price_ledger_copies c ON c.id=e.copy_id
    WHERE ${from.includes("T") || untilExclusive.includes("T") ? "e.instant_ms>=? AND e.instant_ms<?"
      // A call's day is its timestamp's own date, so whole days are found through the day index.
      : "e.day>=? AND e.day<? AND e.ts>=? AND e.ts<?"}${owned ? ` AND (${owned.map(range =>
        `c.source IN (${range.sources.map(() => "?").join(",") || "NULL"}) AND e.instant_ms>=? AND e.instant_ms<?`).join(" OR ") || "0"})` : ""}${
      canonical ? " AND e.copy_state='canonical'" : ""}${filter.eventIds ? " AND e.id IN (SELECT value FROM json_each(?))" : ""}
    ORDER BY e.ts,e.id`).all(...(from.includes("T") || untilExclusive.includes("T")
      ? [Date.parse(from), Date.parse(untilExclusive)] : [from, untilExclusive, from, untilExclusive]), ...ownedParams,
      ...(filter.eventIds ? [JSON.stringify(filter.eventIds)] : [])) as
      Array<Record<string, string | number | null> & { home: string | null; cwd: string | null; project: string | null; repo: string | null; day: string;
        project_id: string | number | null; subject: string | null }>);
  return rows.map(event => {
    const group = { ...event, calls: "1", first_ts: event.ts, last_ts: event.ts,
      api_reason: event.api_reason ?? "", credit_reason: event.credit_reason ?? "" } as unknown as LedgerStoredGroup;
    for (const key of ["reported", "uncached", "cached", "writes", "output", "reasoning", "window_input", "window_cached", "window_output", "invalid_tokens",
      "api_fraction_hi", "api_fraction_lo", "credit_fraction_hi", "credit_fraction_lo"] as const) {
      (group as unknown as Record<string, unknown>)[key] = event[key] === null ? null : String(event[key]);
    }
    return { event, group: deriveCodexLedgerGroup(group, denominators, current.policy) };
  });
}
