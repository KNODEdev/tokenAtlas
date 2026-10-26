import { createHash, randomUUID } from "node:crypto";
import { decimal, divide, equal, multiply, NANO_BUCKETS, rational, serializeRational, type Rational } from "../db/price-ledger-exact";
import type { CodexAccountingRule, CodexTokenRates } from "../shared/codex-accounting";
import type { CodexPricingEdit, CodexPricingSettings } from "../shared/codex-pricing-settings";
import type { RateCard } from "./pricing";
import { validateCodexAccountingConfig } from "./codex-accounting-pricing";
import { ledgerTierMultiplier, type LedgerBaseRule, type LedgerRates, type LedgerTierRule } from "./codex-ledger-policy";
import { codexLedgerSettings, prepareCodexLedgerPolicyChange, type PreparedCodexLedgerChange } from "./codex-ledger-settings";

interface Period { valid_from: string; valid_until?: string }
interface Row { rule: CodexAccountingRule; base: LedgerBaseRule; tier?: LedgerTierRule }
const end = (p: Period) => p.valid_until ?? "9999-12-31";
const overlaps = (a: Period, b: Period) => a.valid_from < end(b) && b.valid_from < end(a);
const sameSubject = (a: LedgerBaseRule | LedgerTierRule, b: CodexAccountingRule) => a.model === b.model && a.billing_basis === b.billing_basis;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function displayNumber(value: Rational): number {
  const exact = serializeRational(value).decimal;
  const n = value.n.toString(), d = value.d.toString();
  const result = exact !== null ? Number(exact)
    : Number(n.slice(0, 16)) / Number(d.slice(0, 16)) * 10 ** (Math.max(0, n.length - 16) - Math.max(0, d.length - 16));
  if (!Number.isFinite(result)) throw new Error("Cena nie mieści się w istniejącym edytorze.");
  return result;
}
function displayedRates(rates: LedgerRates, factor: Rational): CodexTokenRates {
  return Object.fromEntries(NANO_BUCKETS.filter(key => key !== "in_cache_write" || rates[key] !== undefined)
    .map(key => [key, rates[key] == null ? null : displayNumber(multiply(decimal(rates[key]!), factor))])) as unknown as CodexTokenRates;
}
function rows(card: RateCard): Row[] {
  const policy = codexLedgerSettings(card).policy, result: Row[] = [];
  for (const base of policy.base_rules) {
    const add = (tier?: LedgerTierRule, period: Period = base) => {
      const start = tier && tier.valid_from > period.valid_from ? tier.valid_from : period.valid_from;
      const until = tier && end(tier) < end(period) ? tier.valid_until : period.valid_until;
      const factor = tier ? ledgerTierMultiplier(tier.multiplier) : rational(1n);
      const evidence = tier ?? base;
      const id = `ledger:${tier ? "fast" : "standard"}:${digest([base.id, tier?.id, start, until])}`;
      const standardEvidence = policy.tier_rules.find(rule => rule.tier === "standard" && sameSubject(rule, base as unknown as CodexAccountingRule)
        && rule.valid_from <= start && end(rule) >= (until ?? "9999-12-31"));
      result.push({ base, tier, rule: { id, model: base.model, billing_basis: base.billing_basis,
        speed: tier ? "fast" : "standard", valid_from: start, ...(until ? { valid_until: until } : {}),
        verified_at: evidence.verified_at, sources: [...evidence.sources], confidence: evidence.confidence,
        ...(evidence.note !== undefined ? { note: evidence.note } : {}),
        ...((tier ?? standardEvidence)?.included_usage ? { included_usage: (tier ?? standardEvidence)!.included_usage } : {}),
        rates: displayedRates(base.rates, factor), multiplier: displayNumber(decimal(base.multiplier)),
        ...(base.long_context ? { long_context: { above_input_tokens: base.long_context.above_input_tokens,
          rates: displayedRates(base.long_context.rates, factor) } } : {}) } });
    };
    const standard = policy.tier_rules.filter(rule => rule.tier === "standard" && sameSubject(rule, base as unknown as CodexAccountingRule) && overlaps(base, rule));
    const cuts = [...new Set([base.valid_from, end(base), ...standard.flatMap(rule => [rule.valid_from, end(rule)])
      .filter(day => day > base.valid_from && day < end(base))])].sort();
    for (let index = 0; index < cuts.length - 1; index++) add(undefined, { valid_from: cuts[index]!,
      ...(cuts[index + 1] !== "9999-12-31" ? { valid_until: cuts[index + 1] } : {}) });
    for (const tier of policy.tier_rules) if (tier.tier === "fast" && sameSubject(tier, base as unknown as CodexAccountingRule) && overlaps(base, tier)) add(tier);
  }
  return result;
}
/** Numeric values exist only at the approved editor boundary; the revision includes hidden declarations. */
export function legacyCodexLedgerSettings(card: RateCard): CodexPricingSettings {
  const settings = codexLedgerSettings(card);
  return { revision: digest([settings.revision, card.codex_accounting]), rules: rows(card).map(row => row.rule),
    long_context_premium: settings.policy.long_context_premium !== false };
}
function subtractPeriod<T extends Period & { id: string }>(rule: T, cut: Period): T[] {
  if (!overlaps(rule, cut)) return [rule];
  const pieces: T[] = [];
  if (rule.valid_from < cut.valid_from) pieces.push({ ...rule, valid_until: cut.valid_from });
  if (cut.valid_until && end(rule) > cut.valid_until) pieces.push({ ...rule,
    id: pieces.length ? `${rule.id}:split:${randomUUID()}` : rule.id, valid_from: cut.valid_until });
  return pieces;
}
function exactRates(input: CodexTokenRates, previous?: { displayed: CodexTokenRates; exact: LedgerRates }): LedgerRates {
  return Object.fromEntries(NANO_BUCKETS.filter(key => key !== "in_cache_write" || input[key] !== undefined)
    .map(key => [key, previous && input[key] === previous.displayed[key] ? previous.exact[key]
      : input[key] == null ? input[key] : String(input[key])])) as unknown as LedgerRates;
}
function provenance(rule: CodexAccountingRule, previous?: LedgerBaseRule | LedgerTierRule) {
  return { verified_at: rule.verified_at, sources: [...rule.sources], confidence: "user" as const,
    ...(rule.note !== undefined ? { note: rule.note } : {}),
    ...(previous?.source_rule_ids ? { source_rule_ids: [...previous.source_rule_ids] } : {}) };
}
function validateIncoming(rule: CodexAccountingRule) {
  validateCodexAccountingConfig({ version: 1, rules: [rule] });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(rule.model) || rule.id.length > 512 || rule.sources.length > 20
    || rule.sources.some(source => { try { const url = new URL(source); return url.protocol !== "https:" || !url.hostname || !!url.username || !!url.password || source.length > 4000; } catch { return true; } })) {
    throw new Error("Nieprawidłowe źródło HTTPS lub identyfikator okresu.");
  }
}
/** Patch a fresh modern policy, never replace it with the old card's independent rate table. */
export function prepareLegacyCodexLedgerEdit(card: RateCard, edit: CodexPricingEdit): PreparedCodexLedgerChange {
  const current = legacyCodexLedgerSettings(card);
  if (edit.revision !== current.revision) throw new Error("Cennik zmienił się. Odśwież dane przed zapisem.");
  const settings = codexLedgerSettings(card), policy = structuredClone(settings.policy);
  if (edit.long_context_premium !== undefined) {
    if (typeof edit.long_context_premium !== "boolean" || edit.rule || edit.remove || edit.replace_id) throw new Error("Zmiana dopłaty za długi kontekst jest osobnym zapisem.");
    if (edit.long_context_premium) delete policy.long_context_premium;
    else policy.long_context_premium = false;
  } else {
    if (Boolean(edit.remove) === Boolean(edit.rule)) throw new Error("Wybierz jeden okres do zapisu lub usunięcia.");
    if (edit.replace_id && !edit.rule) throw new Error("Brak zastępującego okresu.");
    const projection = rows(card), selectedId = edit.remove ?? edit.replace_id;
    const selected = selectedId ? projection.find(row => row.rule.id === selectedId) : undefined;
    if (selectedId && !selected) throw new Error("Nie znaleziono okresu.");
    if (edit.rule) {
      validateIncoming(edit.rule);
      if (projection.some(row => row.rule.id === edit.rule!.id && row !== selected)) throw new Error("Identyfikator okresu jest już używany.");
    }
    if (selected) {
      if (selected.tier) policy.tier_rules = policy.tier_rules.flatMap(rule => rule.id === selected.tier!.id ? subtractPeriod(rule, selected.rule) : [rule]);
      else policy.base_rules = policy.base_rules.flatMap(rule => rule.id === selected.base.id ? subtractPeriod(rule, selected.rule) : [rule]);
    }
    const incoming = edit.rule;
    if (incoming?.speed === "standard") {
      const previous = selected && !selected.tier ? selected : undefined;
      const baseId = previous && !policy.base_rules.some(rule => rule.id === previous.base.id) ? previous.base.id : `base:user:${randomUUID()}`;
      const base: LedgerBaseRule = { id: baseId, model: incoming.model,
        billing_basis: incoming.billing_basis, valid_from: incoming.valid_from, ...(incoming.valid_until ? { valid_until: incoming.valid_until } : {}),
        rates: exactRates(incoming.rates, previous && { displayed: previous.rule.rates, exact: previous.base.rates }),
        multiplier: previous && incoming.multiplier === previous.rule.multiplier ? previous.base.multiplier : String(incoming.multiplier),
        ...provenance(incoming, previous?.base), ...(incoming.long_context ? { long_context: {
          above_input_tokens: incoming.long_context.above_input_tokens,
          rates: exactRates(incoming.long_context.rates, previous?.rule.long_context && previous.base.long_context
            ? { displayed: previous.rule.long_context.rates, exact: previous.base.long_context.rates } : undefined) } } : {}) };
      policy.base_rules = policy.base_rules.flatMap(rule => sameSubject(rule, incoming) ? subtractPeriod(rule, incoming) : [rule]);
      policy.base_rules.push(base);
      if (!policy.tiers.includes("standard")) policy.tiers.push("standard");
      if (incoming.included_usage !== undefined) policy.tier_rules = policy.tier_rules.flatMap(rule => {
        if (rule.tier !== "standard" || !sameSubject(rule, incoming) || !overlaps(rule, incoming)
          || rule.included_usage === incoming.included_usage) return [rule];
        const from = rule.valid_from > incoming.valid_from ? rule.valid_from : incoming.valid_from;
        const until = end(rule) < end(incoming) ? rule.valid_until : incoming.valid_until;
        return [...subtractPeriod(rule, incoming), { ...rule, id: `tier:standard:user:${randomUUID()}`, valid_from: from,
          valid_until: until, ...provenance(incoming, rule), included_usage: incoming.included_usage }];
      });
      // Existing Standard/Fast/custom factors are retained. Fill only uncovered Standard declarations.
      let gaps: Period[] = [incoming];
      for (const rule of policy.tier_rules.filter(rule => rule.tier === "standard" && sameSubject(rule, incoming))) gaps = gaps.flatMap(gap => subtractPeriod({ ...gap, id: "gap" }, rule));
      for (const gap of gaps) policy.tier_rules.push({ id: `tier:standard:user:${randomUUID()}`, model: incoming.model,
        billing_basis: incoming.billing_basis, tier: "standard", valid_from: gap.valid_from,
        ...(gap.valid_until ? { valid_until: gap.valid_until } : {}), multiplier: "1", ...provenance(incoming),
        ...(incoming.included_usage ? { included_usage: incoming.included_usage } : {}) });
    } else if (incoming) {
      const bases = policy.base_rules.filter(base => sameSubject(base, incoming) && overlaps(base, incoming)).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
      let cursor: string | undefined = incoming.valid_from;
      for (const base of bases) {
        const from = base.valid_from > incoming.valid_from ? base.valid_from : incoming.valid_from;
        const until = end(base) < end(incoming) ? base.valid_until : incoming.valid_until;
        if (cursor !== from) throw new Error("Fast wymaga potwierdzonej ceny Standard w całym okresie.");
        if (!!incoming.long_context !== !!base.long_context || incoming.long_context?.above_input_tokens !== base.long_context?.above_input_tokens) throw new Error("Fast musi być proporcjonalny do Standard, także dla długiego kontekstu.");
        let factor: Rational | undefined;
        const bands = [{ incoming: incoming.rates, base: base.rates, previous: selected?.rule.rates, previousBase: selected?.base.rates },
          ...(incoming.long_context && base.long_context ? [{ incoming: incoming.long_context.rates, base: base.long_context.rates,
            previous: selected?.rule.long_context?.rates, previousBase: selected?.base.long_context?.rates }] : [])];
        for (const band of bands) for (const key of NANO_BUCKETS) {
          const a = band.base[key], b = band.incoming[key];
          if (a == null || b == null) { if (a != null || b != null) throw new Error("Fast i Standard wymagają tych samych potwierdzonych stawek."); continue; }
          const original = selected?.tier && b === band.previous?.[key] && band.previousBase?.[key] != null
            ? multiply(decimal(band.previousBase[key]!), ledgerTierMultiplier(selected.tier.multiplier)) : decimal(b);
          const incomingMultiplier = selected && incoming.multiplier === selected.rule.multiplier ? decimal(selected.base.multiplier) : decimal(incoming.multiplier);
          const standard = multiply(decimal(a), decimal(base.multiplier)), fast = multiply(original, incomingMultiplier);
          if (standard.n === 0n) { if (fast.n !== 0n) throw new Error("Fast musi być proporcjonalny do Standard."); continue; }
          const ratio = divide(fast, standard);
          if (factor && !equal(factor, ratio)) throw new Error("Fast musi być proporcjonalny do Standard.");
          factor ??= ratio;
        }
        factor ??= selected?.tier ? ledgerTierMultiplier(selected.tier.multiplier) : rational(1n);
        if (factor.n <= 0n) throw new Error("Fast wymaga dodatniego mnożnika.");
        const serialized = serializeRational(factor), previous = selected?.tier;
        const multiplier = previous && equal(ledgerTierMultiplier(previous.multiplier), factor) ? previous.multiplier
          : serialized.decimal ?? { numerator: serialized.numerator, denominator: serialized.denominator };
        const period: Period = { valid_from: from, ...(until ? { valid_until: until } : {}) };
        policy.tier_rules = policy.tier_rules.flatMap(rule => rule.tier === "fast" && sameSubject(rule, incoming) ? subtractPeriod(rule, period) : [rule]);
        if (!policy.tiers.includes("fast")) policy.tiers.push("fast");
        const id = previous && !policy.tier_rules.some(rule => rule.id === previous.id) ? previous.id : `tier:fast:user:${randomUUID()}`;
        policy.tier_rules.push({ ...period, id, model: incoming.model,
          billing_basis: incoming.billing_basis, tier: "fast", multiplier, ...provenance(incoming, previous),
          ...(incoming.included_usage ? { included_usage: incoming.included_usage } : {}) });
        cursor = until;
      }
      if (!bases.length || cursor !== incoming.valid_until) throw new Error("Fast wymaga potwierdzonej ceny Standard w całym okresie.");
    }
  }
  return prepareCodexLedgerPolicyChange(card, policy, { expected_revision: settings.revision, origin: "user",
    note: edit.rule?.note ?? "Existing Codex pricing editor" });
}
