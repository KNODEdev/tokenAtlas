import { compileNanoRates, decimal, divide, equal, multiply, rational, serializeRational,
  NANO_BUCKETS, type NanoRateInput, type NanoRates, type Rational } from "../db/price-ledger-exact";
import type { LedgerBaseBand } from "../db/codex-price-ledger";
import type { CodexAccountingConfig, CodexAccountingRule, CodexBillingBasis } from "./codex-accounting-pricing";
import { validContextThreshold } from "../shared/context-tier";

export type LedgerBillingBasis = CodexBillingBasis;
export interface LedgerProvenance {
  verified_at: string; sources: string[]; confidence: "official" | "user";
  note?: string; source_rule_ids?: string[];
}
export interface LedgerRates {
  in_uncached: string; in_cache_read: string; out_total: string; in_cache_write?: string | null;
}
export interface LedgerBaseRule extends LedgerProvenance {
  id: string; model: string; billing_basis: LedgerBillingBasis;
  valid_from: string; valid_until?: string; rates: LedgerRates; multiplier: string;
  long_context?: { above_input_tokens: number; rates: LedgerRates };
}
export interface LedgerRationalInput { numerator: string; denominator: string }
export interface LedgerTierRule extends LedgerProvenance {
  id: string; model: string; billing_basis: LedgerBillingBasis; tier: string;
  valid_from: string; valid_until?: string; multiplier: string | LedgerRationalInput;
  included_usage?: "proportional" | "unchanged" | "unknown";
}
export interface LedgerTierMapping {
  id: string; raw_value: string; tier: string; valid_from?: string; valid_until?: string;
}
export interface CodexLedgerPolicy {
  version: 1; base_rules: LedgerBaseRule[]; tiers: string[];
  mappings: LedgerTierMapping[]; tier_rules: LedgerTierRule[];
  long_context_premium?: boolean; notes?: string[];
}
export interface CompiledLedgerBaseBand extends LedgerBaseBand { coefficients: NanoRates }
export interface CompiledCodexLedgerPolicy {
  readonly policy: CodexLedgerPolicy;
  readonly baseBands: readonly CompiledLedgerBaseBand[];
  /** Long-context bands of every rule that has them, also while the premium is off, to measure the uplift. */
  readonly contextBands: readonly CompiledLedgerBaseBand[];
  resolveBaseRule(model: string | null, basis: LedgerBillingBasis, day: string): LedgerBaseRule | null;
  resolveTier(raw: string | null, day: string): string | null;
  resolveTierRule(model: string | null, basis: LedgerBillingBasis, tier: string, day: string): LedgerTierRule | null;
  classify(raw: string | null, day: string): string | null;
  multiplier(model: string | null, basis: LedgerBillingBasis, tier: string, day: string): Rational | null;
}
const fail = (message: string): never => { throw new Error(`Invalid Codex ledger policy: ${message}`); };
const dayValid = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
interface Period { valid_from?: string; valid_until?: string }
const contains = (rule: Period, day: string) => (!rule.valid_from || day >= rule.valid_from)
  && (!rule.valid_until || day < rule.valid_until);
const overlaps = (a: Period, b: Period) => (!a.valid_from || !b.valid_until || a.valid_from < b.valid_until)
  && (!b.valid_from || !a.valid_until || b.valid_from < a.valid_until);
function dates(rule: Period, requiredStart: boolean): void {
  if ((requiredStart || rule.valid_from !== undefined) && !dayValid(rule.valid_from)
    || rule.valid_until !== undefined && (!dayValid(rule.valid_until) || !!rule.valid_from && rule.valid_until <= rule.valid_from)) {
    fail("invalid dates; valid_until is exclusive");
  }
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function provenance(rule: LedgerProvenance): void {
  if (!dayValid(rule.verified_at) || !Array.isArray(rule.sources) || !rule.sources.length
    || !rule.sources.every(source => typeof source === "string" && /^https:\/\//.test(source))
    || !["official", "user"].includes(rule.confidence)
    || rule.note !== undefined && (typeof rule.note !== "string" || rule.note.length > 2000)
    || rule.source_rule_ids !== undefined && (!Array.isArray(rule.source_rule_ids) || !rule.source_rule_ids.every(nonempty))) {
    fail("missing or invalid provenance");
  }
}
function rateValidation(input: LedgerRates): void {
  if (!input || typeof input !== "object") fail("missing rates");
  for (const key of NANO_BUCKETS) {
    const value = input[key];
    if (key === "in_cache_write" && value == null) continue;
    if (typeof value !== "string" || decimal(value).n < 0n) fail(`invalid decimal text rate: ${key}`);
  }
}
export function ledgerTierMultiplier(input: string | LedgerRationalInput): Rational {
  if (typeof input === "string") return decimal(input);
  if (!input || typeof input !== "object" || ![input.numerator, input.denominator].every(value =>
    typeof value === "string" && value.length <= 2048 && /^[+-]?\d+$/.test(value))) fail("invalid exact tier multiplier");
  if (BigInt(input.denominator) <= 0n) fail("tier multiplier denominator must be positive");
  return rational(BigInt(input.numerator), BigInt(input.denominator));
}
export function validateCodexLedgerPolicy(value: unknown): asserts value is CodexLedgerPolicy {
  if (!value || typeof value !== "object") fail("expected an object");
  const policy = value as CodexLedgerPolicy;
  if (policy.version !== 1 || ![policy.base_rules, policy.tiers, policy.mappings, policy.tier_rules].every(Array.isArray)) {
    fail("expected version 1 and rule arrays");
  }
  if (policy.long_context_premium !== undefined && typeof policy.long_context_premium !== "boolean") fail("invalid premium flag");
  if (policy.notes !== undefined && (!Array.isArray(policy.notes) || !policy.notes.every(note => typeof note === "string"))) fail("invalid notes");
  const tiers = new Set(policy.tiers);
  if (tiers.size !== policy.tiers.length || !policy.tiers.every(nonempty)) fail("duplicate or invalid tier identity");
  const ids = new Set<string>();
  const identity = (rule: { id: string }) => {
    if (!rule || !nonempty(rule.id) || ids.has(rule.id)) fail("duplicate or invalid rule identity");
    ids.add(rule.id);
  };
  const pricedIdentity = (rule: LedgerBaseRule | LedgerTierRule) => {
    identity(rule);
    if (!nonempty(rule.model) || !["chatgpt_credits", "api_equivalent_usd"].includes(rule.billing_basis)) fail("invalid model or basis");
    dates(rule, true); provenance(rule);
  };
  const baseIndex = new Map<string, LedgerBaseRule[]>(), tierIndex = new Map<string, LedgerTierRule[]>();
  const insert = <T extends Period>(index: Map<string, T[]>, key: string, rule: T) => {
    const existing = index.get(key) ?? [];
    if (existing.some(other => overlaps(rule, other))) fail("overlapping dated rules");
    existing.push(rule); index.set(key, existing);
  };
  for (const rule of policy.base_rules) {
    pricedIdentity(rule); rateValidation(rule.rates);
    if (typeof rule.multiplier !== "string" || decimal(rule.multiplier).n <= 0n) fail("invalid base multiplier");
    if (rule.billing_basis === "api_equivalent_usd" && !equal(decimal(rule.multiplier), rational(1n))) fail("API base multiplier must be one");
    if (rule.long_context !== undefined) {
      if (!rule.long_context || !validContextThreshold(rule.long_context.above_input_tokens)) fail("invalid long-context threshold");
      rateValidation(rule.long_context.rates);
    }
    if (rule.billing_basis === "chatgpt_credits" && (rule.rates.in_cache_write != null || rule.long_context?.rates.in_cache_write != null)) fail("credit cache-write rate is not established");
    compileNanoRates(rule.rates, rule.multiplier);
    if (rule.long_context) compileNanoRates(rule.long_context.rates, rule.multiplier);
    insert(baseIndex, JSON.stringify([rule.model, rule.billing_basis]), rule);
  }
  for (const rule of policy.tier_rules) {
    pricedIdentity(rule);
    const factor = ledgerTierMultiplier(rule.multiplier);
    if (!tiers.has(rule.tier) || factor.n <= 0n) fail("unknown tier or nonpositive multiplier");
    if (rule.tier === "standard" && !equal(factor, rational(1n))) fail("Standard tier multiplier must be one");
    if (rule.included_usage !== undefined && !["proportional", "unchanged", "unknown"].includes(rule.included_usage)) fail("invalid included usage");
    insert(tierIndex, JSON.stringify([rule.model, rule.billing_basis, rule.tier]), rule);
  }
  const mappingIndex = new Map<string, LedgerTierMapping[]>();
  for (const mapping of policy.mappings) {
    identity(mapping); dates(mapping, false);
    if (typeof mapping.raw_value !== "string" || !tiers.has(mapping.tier)) fail("invalid raw tier mapping");
    insert(mappingIndex, mapping.raw_value, mapping);
  }
}

/** Snapshot rule inputs so later editor mutations cannot stale the compiled indexes. */
export function compileCodexLedgerPolicy(input: CodexLedgerPolicy): CompiledCodexLedgerPolicy {
  validateCodexLedgerPolicy(input);
  const policy = structuredClone(input);
  const bases = new Map<string, LedgerBaseRule[]>(), tiers = new Map<string, LedgerTierRule[]>();
  const mappings = new Map<string, LedgerTierMapping[]>(), factors = new Map<string, Rational>();
  const append = <T>(index: Map<string, T[]>, key: string, value: T) => index.set(key, [...(index.get(key) ?? []), value]);
  const baseBands: CompiledLedgerBaseBand[] = [], contextBands: CompiledLedgerBaseBand[] = [];
  for (const rule of policy.base_rules) {
    append(bases, JSON.stringify([rule.model, rule.billing_basis]), rule);
    const evidence = JSON.stringify(rule);
    const band = (rates: NanoRateInput, kind: "normal" | "long", threshold?: number): CompiledLedgerBaseBand => ({
      id: rule.id, model: rule.model, basis: rule.billing_basis, validFrom: rule.valid_from, validUntil: rule.valid_until,
      band: kind, threshold, rates, multiplier: rule.multiplier, evidence, coefficients: compileNanoRates(rates, rule.multiplier),
    });
    baseBands.push(band(rule.rates, "normal", policy.long_context_premium !== false ? rule.long_context?.above_input_tokens : undefined));
    if (rule.long_context) {
      const long = band(rule.long_context.rates, "long", rule.long_context.above_input_tokens);
      contextBands.push(long);
      if (policy.long_context_premium !== false) baseBands.push(long);
    }
  }
  for (const rule of policy.tier_rules) {
    append(tiers, JSON.stringify([rule.model, rule.billing_basis, rule.tier]), rule);
    factors.set(rule.id, ledgerTierMultiplier(rule.multiplier));
  }
  for (const mapping of policy.mappings) append(mappings, mapping.raw_value, mapping);
  const resolveBaseRule = (model: string | null, basis: LedgerBillingBasis, day: string) => dayValid(day)
    ? bases.get(JSON.stringify([model, basis]))?.find(rule => contains(rule, day)) ?? null : null;
  const resolveTierRule = (model: string | null, basis: LedgerBillingBasis, tier: string, day: string) => dayValid(day)
    ? tiers.get(JSON.stringify([model, basis, tier]))?.find(rule => contains(rule, day)) ?? null : null;
  const resolveTier = (raw: string | null, day: string) => raw !== null && dayValid(day)
    ? mappings.get(raw)?.find(rule => contains(rule, day))?.tier ?? null : null;
  return { policy, baseBands, contextBands, resolveBaseRule, resolveTier, resolveTierRule, classify: resolveTier,
    multiplier(model, basis, tier, day) {
      const rule = resolveTierRule(model, basis, tier, day);
      return rule ? factors.get(rule.id)! : null;
    } };
}
export const resolveBaseRule = (policy: CompiledCodexLedgerPolicy, model: string | null, basis: LedgerBillingBasis, day: string) =>
  policy.resolveBaseRule(model, basis, day);
export const resolveTier = (policy: CompiledCodexLedgerPolicy, raw: string | null, day: string) => policy.resolveTier(raw, day);
export const resolveTierRule = (policy: CompiledCodexLedgerPolicy, model: string | null, basis: LedgerBillingBasis, tier: string, day: string) =>
  policy.resolveTierRule(model, basis, tier, day);

export class CodexLedgerRepresentabilityError extends Error {
  constructor(message: string) { super(message); this.name = "CodexLedgerRepresentabilityError"; }
}
const cannotRepresent = (message: string): never => { throw new CodexLedgerRepresentabilityError(message); };
function legacyRates(input: CodexAccountingRule["rates"]): LedgerRates {
  const result = {} as LedgerRates;
  if (!input || typeof input !== "object") cannotRepresent("Legacy rates are missing");
  for (const key of NANO_BUCKETS) {
    const value = input[key];
    if (key === "in_cache_write" && value == null) {
      if (value === null) result[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) cannotRepresent(`Invalid legacy rate: ${key}`);
    result[key] = String(value);
  }
  return result;
}
function legacyProvenance(rule: CodexAccountingRule): LedgerProvenance {
  return { verified_at: rule.verified_at, sources: [...rule.sources], confidence: rule.confidence,
    ...(rule.note !== undefined ? { note: rule.note } : {}), source_rule_ids: [rule.id] };
}
function effectiveRatio(base: CodexAccountingRule, fast: CodexAccountingRule): Rational {
  if (!!base.long_context !== !!fast.long_context || base.long_context?.above_input_tokens !== fast.long_context?.above_input_tokens) {
    cannotRepresent(`${fast.id}: long-context classification differs from ${base.id}`);
  }
  let common: Rational | null = null;
  const bands = [[base.rates, fast.rates], ...(base.long_context && fast.long_context
    ? [[base.long_context.rates, fast.long_context.rates]] : [])];
  for (const [left, right] of bands) for (const key of NANO_BUCKETS) {
    const a = left![key], b = right![key];
    if (a == null || b == null) {
      if (a != null || b != null) cannotRepresent(`${fast.id}: ${key} missing on one side`);
      continue;
    }
    const standard = multiply(decimal(a), decimal(base.multiplier)), tier = multiply(decimal(b), decimal(fast.multiplier));
    if (standard.n === 0n) {
      if (tier.n !== 0n) cannotRepresent(`${fast.id}: zero base with positive tier ${key}`);
      continue;
    }
    const ratio = divide(tier, standard);
    if (common !== null && !equal(common, ratio)) cannotRepresent(`${fast.id}: non-proportional exact rates/context`);
    common ??= ratio;
  }
  return common ?? rational(1n);
}
/** Pure legacy adapter; artifacts and missing coverage are preserved, never repaired here. */
export function convertLegacyCodexLedgerPolicy(legacy: CodexAccountingConfig): CodexLedgerPolicy {
  if (!legacy || legacy.version !== 1 || !Array.isArray(legacy.rules)) cannotRepresent("Invalid legacy config");
  const policy: CodexLedgerPolicy = { version: 1, base_rules: [], tiers: ["standard", "fast"],
    mappings: [{ id: "raw:default", raw_value: "default", tier: "standard" },
      { id: "raw:priority", raw_value: "priority", tier: "fast" }], tier_rules: [],
    long_context_premium: legacy.long_context_premium ?? true, ...(legacy.notes ? { notes: [...legacy.notes] } : {}) };
  const ids = new Set<string>();
  for (const rule of legacy.rules) {
    if (!rule || !nonempty(rule.id) || ids.has(rule.id) || !["standard", "fast"].includes(rule.speed)
      || typeof rule.multiplier !== "number" || !Number.isFinite(rule.multiplier) || rule.multiplier <= 0
      || rule.billing_basis === "api_equivalent_usd" && rule.multiplier !== 1) cannotRepresent("Invalid legacy rule identity/multiplier");
    ids.add(rule.id); dates(rule, true); provenance(rule); legacyRates(rule.rates);
    if (rule.long_context) legacyRates(rule.long_context.rates);
    if (rule.speed === "standard") {
      policy.base_rules.push({ id: rule.id, model: rule.model, billing_basis: rule.billing_basis,
        valid_from: rule.valid_from, ...(rule.valid_until !== undefined ? { valid_until: rule.valid_until } : {}),
        rates: legacyRates(rule.rates), multiplier: String(rule.multiplier), ...legacyProvenance(rule),
        ...(rule.long_context ? { long_context: { above_input_tokens: rule.long_context.above_input_tokens, rates: legacyRates(rule.long_context.rates) } } : {}) });
      policy.tier_rules.push({ id: `tier:standard:${JSON.stringify(rule.id)}`, model: rule.model, billing_basis: rule.billing_basis,
        tier: "standard", valid_from: rule.valid_from, ...(rule.valid_until !== undefined ? { valid_until: rule.valid_until } : {}),
        multiplier: "1", ...legacyProvenance(rule), ...(rule.included_usage ? { included_usage: rule.included_usage } : {}) });
    }
  }
  for (const fast of legacy.rules.filter(rule => rule.speed === "fast")) {
    const bases = legacy.rules.filter(base => base.speed === "standard" && base.model === fast.model
      && base.billing_basis === fast.billing_basis && overlaps(base, fast)).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    let coveredUntil: string | undefined = fast.valid_from;
    for (const base of bases) {
      const start = base.valid_from > fast.valid_from ? base.valid_from : fast.valid_from;
      const end = base.valid_until === undefined ? fast.valid_until : fast.valid_until === undefined ? base.valid_until
        : base.valid_until < fast.valid_until ? base.valid_until : fast.valid_until;
      if (coveredUntil === undefined || start !== coveredUntil) cannotRepresent(`${fast.id}: Fast coverage has no unique Standard base`);
      const ratio = serializeRational(effectiveRatio(base, fast));
      if (ratio.numerator === "0") cannotRepresent(`${fast.id}: zero tier factor is not supported; use a confirmed zero base rate`);
      policy.tier_rules.push({ id: `tier:fast:${JSON.stringify([fast.id, base.id, start])}`, model: fast.model,
        billing_basis: fast.billing_basis, tier: "fast", valid_from: start, ...(end !== undefined ? { valid_until: end } : {}),
        multiplier: ratio.decimal ?? { numerator: ratio.numerator, denominator: ratio.denominator },
        ...legacyProvenance(fast), source_rule_ids: [base.id, fast.id], ...(fast.included_usage ? { included_usage: fast.included_usage } : {}) });
      coveredUntil = end;
    }
    if (!bases.length || coveredUntil !== fast.valid_until) cannotRepresent(`${fast.id}: Fast period without Standard coverage`);
  }
  validateCodexLedgerPolicy(policy);
  return policy;
}
