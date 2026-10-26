import { randomUUID } from "node:crypto";
import type { RateCard } from "./pricing";
import { isAccountingDay, type CodexSpeedEdit } from "./codex-accounting-pricing";
import { compileCodexLedgerPolicy, type LedgerBaseRule, type LedgerRates, type LedgerTierRule } from "./codex-ledger-policy";
import { codexLedgerSettings, prepareCodexLedgerPolicyChange } from "./codex-ledger-settings";
import { legacyCodexLedgerSettings } from "./codex-ledger-legacy-settings";
import { decimal, multiply, divide, serializeRational } from "../db/price-ledger-exact";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";

const buckets = ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const;
const active = (rule: { valid_from: string; valid_until?: string }, day: string) => rule.valid_from <= day && (!rule.valid_until || day < rule.valid_until);
const exactProduct = (value: string, ratio: ReturnType<typeof decimal>) => {
  const result = serializeRational(multiply(decimal(value), ratio));
  if (result.decimal === null) throw new Error("Zmiana wymaga dokładnej stawki długiego kontekstu w edytorze okresów.");
  return result.decimal;
};

/** Existing model controls edit the authoritative dated policy; the legacy projection remains compatible. */
export function prepareCodexLedgerModelEdit(card: RateCard, model: string, input: {
  rates?: Record<string, number | null>; speed?: CodexSpeedEdit; day: string;
}) {
  if (!isAccountingDay(input.day) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) throw new Error("Nieprawidłowy model lub data cennika.");
  if (input.rates && Object.keys(input.rates).some(key => !(buckets as readonly string[]).includes(key))) throw new Error("Nieznany składnik stawki Codex.");
  const settings = codexLedgerSettings(card), policy = structuredClone(settings.policy);
  const existing = policy.base_rules.find(rule => rule.model === model && rule.billing_basis === "api_equivalent_usd" && active(rule, input.day));
  const changedRates = input.rates && buckets.some(key => key in input.rates!
    && (input.rates![key] === null ? existing?.rates[key] != null : Number(existing?.rates[key]) !== input.rates![key]));
  if (input.rates && changedRates) {
    const base = policy.base_rules.find(rule => rule.model === model && rule.billing_basis === "api_equivalent_usd" && active(rule, input.day));
    const template = base ?? policy.base_rules.find(rule => rule.model === model && rule.billing_basis === "api_equivalent_usd")
      ?? policy.base_rules.find(rule => rule.model === model)
      ?? (card.vendors.openai?.source ? { sources: [card.vendors.openai.source] } : undefined);
    if (!template) throw new Error("Dodaj model ze źródłem i okresem w edytorze okresów cennika.");
    const until = base?.valid_until ?? policy.base_rules.filter(rule => rule.model === model && rule.billing_basis === "api_equivalent_usd" && rule.valid_from > input.day)
      .map(rule => rule.valid_from).sort()[0];
    let disabled = false;
    const rates: Partial<LedgerRates> = structuredClone(base?.rates ?? {}), long = base?.long_context && structuredClone(base.long_context);
    for (const key of buckets) {
      if (!(key in input.rates)) continue;
      const value = input.rates[key];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000)) throw new Error("Nieprawidłowa stawka modelu.");
      if (base && (value === null ? base.rates[key] == null : Number(base.rates[key]) === value)) continue;
      if (value === null && key !== "in_cache_write") { disabled = true; continue; }
      const previous = base?.rates[key];
      const ratio = long && previous != null && decimal(previous).n !== 0n
        ? divide(decimal(long.rates[key] ?? previous), decimal(previous)) : decimal("1");
      if (key === "in_cache_write") {
        rates[key] = value === null ? null : String(value);
        if (long) long.rates[key] = value === null ? null : exactProduct(String(value), ratio);
      } else {
        rates[key] = String(value);
        if (long) long.rates[key] = exactProduct(String(value), ratio);
      }
    }
    policy.base_rules = policy.base_rules.flatMap(rule => rule !== base ? [rule]
      : rule.valid_from < input.day ? [{ ...rule, valid_until: input.day }] : []);
    if (!disabled) {
      if (rates.in_uncached == null || rates.in_cache_read == null || rates.out_total == null) throw new Error("Podaj komplet stawek Standard dla nowego modelu.");
      policy.base_rules.push({ id: `model-edit:${randomUUID()}`, model, billing_basis: "api_equivalent_usd",
        valid_from: input.day, ...(until ? { valid_until: until } : {}), rates: rates as LedgerBaseRule["rates"],
        multiplier: base?.multiplier ?? "1", sources: [...template.sources], confidence: "user", verified_at: input.day,
        ...(base?.source_rule_ids ? { source_rule_ids: [...base.source_rule_ids] } : {}),
        ...(base?.note !== undefined ? { note: base.note } : {}),
        ...(long ? { long_context: long } : {}) });
    }
  }
  if (input.speed) {
    const speed = input.speed;
    if (!isAccountingDay(speed.valid_from) || ![speed.credit_multiplier, ...(speed.api_multiplier === undefined ? [] : [speed.api_multiplier])]
      .every(value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100)) throw new Error("Speed: wymagane mnożniki > 0 i ≤ 100 oraz data YYYY-MM-DD");
    const compiled = compileCodexLedgerPolicy(policy);
    for (const basis of ["chatgpt_credits", "api_equivalent_usd"] as const) {
      if (basis === "api_equivalent_usd" && speed.api_multiplier === undefined) continue;
      const base = compiled.resolveBaseRule(model, basis, speed.valid_from);
      if (!base) throw new Error(`Speed: brak stawki Standard ${basis} dla ${model} na ${speed.valid_from}`);
      const current = policy.tier_rules.find(rule => rule.model === model && rule.billing_basis === basis && rule.tier === "fast" && active(rule, speed.valid_from));
      const nextStart = policy.tier_rules.filter(rule => rule.model === model && rule.billing_basis === basis && rule.tier === "fast" && rule.valid_from > speed.valid_from)
        .map(rule => rule.valid_from).sort()[0];
      const until = [base.valid_until, current?.valid_until, nextStart].filter((value): value is string => !!value).sort()[0];
      const number = basis === "chatgpt_credits" ? speed.credit_multiplier : speed.api_multiplier!;
      const previous = compiled.multiplier(model, basis, "fast", speed.valid_from);
      if (current && previous && ledgerPresentationNumber(previous) === number) continue;
      const exact = previous && ledgerPresentationNumber(previous) === number ? serializeRational(previous) : serializeRational(decimal(String(number)));
      const evidence = current ?? base;
      const rule: LedgerTierRule = { id: `model-speed:${randomUUID()}`, model, billing_basis: basis, tier: "fast",
        valid_from: speed.valid_from, ...(until ? { valid_until: until } : {}),
        multiplier: exact.decimal ?? { numerator: exact.numerator, denominator: exact.denominator }, sources: [...evidence.sources], confidence: "user", verified_at: input.day,
        ...(evidence.source_rule_ids ? { source_rule_ids: [...evidence.source_rule_ids] } : {}),
        ...(evidence.note !== undefined ? { note: evidence.note } : {}),
        ...(current?.included_usage ? { included_usage: current.included_usage } : {}) };
      policy.tier_rules = policy.tier_rules.flatMap(existing => {
        if (existing.model !== model || existing.billing_basis !== basis || existing.tier !== "fast"
          || existing.valid_from >= (until ?? "9999-12-31") || speed.valid_from >= (existing.valid_until ?? "9999-12-31")) return [existing];
        const pieces: LedgerTierRule[] = [];
        if (existing.valid_from < speed.valid_from) pieces.push({ ...existing, valid_until: speed.valid_from });
        if (until && (!existing.valid_until || until < existing.valid_until)) pieces.push({ ...existing, id: `model-speed:retained:${randomUUID()}`, valid_from: until });
        return pieces;
      });
      policy.tier_rules.push(rule);
    }
  }
  const result = prepareCodexLedgerPolicyChange(card, policy, { expected_revision: settings.revision, origin: "user", note: "Model pricing declaration" });
  compileCodexLedgerPolicy(result.settings.policy);
  const projection = legacyCodexLedgerSettings(result.card);
  result.card.codex_accounting = { version: 1, rules: projection.rules, long_context_premium: projection.long_context_premium };
  return result;
}

export function codexLedgerModelSpeed(card: RateCard, model: string, day: string) {
  const settings = codexLedgerSettings(card), compiled = compileCodexLedgerPolicy(settings.policy);
  const factor = (basis: "chatgpt_credits" | "api_equivalent_usd") => compiled.multiplier(model, basis, "fast", day);
  const credit = factor("chatgpt_credits"), api = factor("api_equivalent_usd"), rule = compiled.resolveTierRule(model, "chatgpt_credits", "fast", day);
  return { credit_multiplier: credit ? ledgerPresentationNumber(credit) : null, api_multiplier: api ? ledgerPresentationNumber(api) : null,
    editable: !!compiled.resolveBaseRule(model, "chatgpt_credits", day), api_editable: !!compiled.resolveBaseRule(model, "api_equivalent_usd", day),
    valid_from: rule?.valid_from ?? null, confidence: rule?.confidence ?? null,
    rules: legacyCodexLedgerSettings(card).rules.filter(rule => rule.model === model) };
}
