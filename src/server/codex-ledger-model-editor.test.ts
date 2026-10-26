import { expect, test } from "bun:test";
import { prepareCodexLedgerModelEdit, codexLedgerModelSpeed } from "./codex-ledger-model-editor";
import { codexLedgerSettings } from "./codex-ledger-settings";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "./codex-ledger-policy";
import type { RateCard } from "./pricing";

const evidence = { verified_at: "2026-01-01", sources: ["https://example.test/pricing"], confidence: "official" as const };
function card(): RateCard {
  const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard", "fast", "ultrafast"],
    mappings: [{ id: "default", raw_value: "default", tier: "standard" }, { id: "priority", raw_value: "priority", tier: "fast" }],
    base_rules: ["api_equivalent_usd", "chatgpt_credits"].map((basis, index) => ({
      id: `base${index}`, model: "model", billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits",
      valid_from: "2026-01-01", valid_until: "2027-01-01", multiplier: "1", ...evidence,
      rates: { in_uncached: "1.7999999999999998", in_cache_read: "0.1", out_total: "5" },
      long_context: { above_input_tokens: 100, rates: { in_uncached: "3.5999999999999996", in_cache_read: "0.2", out_total: "10" } },
    })), tier_rules: ["api_equivalent_usd", "chatgpt_credits"].map((basis, index) => ({
      id: `factor${index}`, model: "model", billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits", tier: "fast",
      valid_from: "2026-01-01", valid_until: "2027-01-01", multiplier: { numerator: "4", denominator: "3" }, ...evidence,
    })) };
  return { version: 2, currency: "USD", unit: "per million", vendors: {}, codex_ledger_policy: policy };
}
const edit = (c: RateCard, rates: Record<string, number | null>) => prepareCodexLedgerModelEdit(c, "model", { rates, day: "2026-10-01" });
test("model rate control changes only dated API base and preserves proportional long context and open tiers", () => {
  const c = card(), changed = edit(c, { out_total: 7 }), policy = changed.settings.policy;
  const compiled = compileCodexLedgerPolicy(policy);
  expect(compiled.resolveBaseRule("model", "api_equivalent_usd", "2026-09-30")!.rates.out_total).toBe("5");
  expect(compiled.resolveBaseRule("model", "api_equivalent_usd", "2026-10-01")!.rates.out_total).toBe("7");
  expect(compiled.resolveBaseRule("model", "api_equivalent_usd", "2026-10-01")!.long_context!.rates.out_total).toBe("14");
  expect(compiled.resolveBaseRule("model", "chatgpt_credits", "2026-10-01")!.rates.out_total).toBe("5");
  expect(policy.tier_rules).toEqual(codexLedgerSettings(c).policy.tier_rules);
  expect(policy.mappings).toEqual(codexLedgerSettings(c).policy.mappings);
  expect(policy.tiers).toContain("ultrafast");
  expect(changed.effects.base_reprice.every(scope => scope.billing_basis === "api_equivalent_usd" && scope.valid_from === "2026-10-01")).toBe(true);
});
test("unchanged numeric controls preserve exact source spelling, factors, identifiers and semantic revision", () => {
  const c = card(), before = codexLedgerSettings(c), speed = codexLedgerModelSpeed(c, "model", "2026-10-01");
  const result = prepareCodexLedgerModelEdit(c, "model", { day: "2026-10-01", rates: { in_uncached: 1.7999999999999998 },
    speed: { valid_from: "2026-10-01", credit_multiplier: speed.credit_multiplier!, api_multiplier: speed.api_multiplier! } });
  expect(result.changed).toBe(false);
  expect(result.settings.semantic_revision).toBe(before.semantic_revision);
  expect(result.settings.policy).toEqual(before.policy);
});
test("unknown price removes only the requested interval, while confirmed zero is priced", () => {
  const disabled = edit(card(), { out_total: null });
  const compiled = compileCodexLedgerPolicy(disabled.settings.policy);
  expect(compiled.resolveBaseRule("model", "api_equivalent_usd", "2026-10-01")).toBeNull();
  expect(compiled.resolveBaseRule("model", "chatgpt_credits", "2026-10-01")).not.toBeNull();
  const zero = compileCodexLedgerPolicy(edit(card(), { out_total: 0 }).settings.policy);
  expect(zero.resolveBaseRule("model", "api_equivalent_usd", "2026-10-01")!.rates.out_total).toBe("0");
});
test("partial edit retains the exact untouched buckets sent by numeric controls", () => {
  const c = card();
  const base = codexLedgerSettings(c).policy.base_rules[0]!;
  base.rates.in_uncached = "1.234567890123456789";
  base.long_context!.rates.in_uncached = "2.469135780246913578";
  c.codex_ledger_policy = { ...codexLedgerSettings(c).policy, base_rules: [base, codexLedgerSettings(c).policy.base_rules[1]!] };
  const result = edit(c, { in_uncached: Number(base.rates.in_uncached), in_cache_read: 0.1, out_total: 7 });
  const changed = compileCodexLedgerPolicy(result.settings.policy).resolveBaseRule("model", "api_equivalent_usd", "2026-10-01")!;
  expect(changed.rates.in_uncached).toBe("1.234567890123456789");
  expect(changed.long_context!.rates.in_uncached).toBe("2.469135780246913578");
});
test("a declared model with missing prices accepts a complete dated API rate with vendor evidence", () => {
  const c = card();
  c.vendors.openai = { source: "https://openai.com/api/pricing/", models: { "known-unpriced": { in_uncached: null, in_cache_read: null, out_total: null } } };
  const result = prepareCodexLedgerModelEdit(c, "known-unpriced", { rates: { in_uncached: 2, in_cache_read: 0.2, out_total: 7 }, day: "2026-10-01" });
  const p = compileCodexLedgerPolicy(result.settings.policy);
  expect(p.resolveBaseRule("known-unpriced", "api_equivalent_usd", "2026-09-30")).toBeNull();
  expect(p.resolveBaseRule("known-unpriced", "api_equivalent_usd", "2026-10-01")).toMatchObject({ confidence: "user", sources: ["https://openai.com/api/pricing/"], rates: { in_uncached: "2", out_total: "7" } });
  expect(p.resolveBaseRule("known-unpriced", "chatgpt_credits", "2026-10-01")).toBeNull();
  expect(() => prepareCodexLedgerModelEdit(c, "", { rates: { out_total: 1 }, day: "2026-10-01" })).toThrow();
});
test("speed control edits both funding bases through exact multipliers without rewriting their rates", () => {
  const c = card();
  const p = codexLedgerSettings(c).policy;
  for (const rule of p.tier_rules) { rule.included_usage = "unchanged"; rule.source_rule_ids = ["official-original"]; rule.note = "Keep original attribution"; rule.sources = ["https://example.test/priority"]; }
  c.codex_ledger_policy = p;
  const result = prepareCodexLedgerModelEdit(c, "model", { day: "2026-10-01",
    speed: { valid_from: "2026-10-01", credit_multiplier: 2, api_multiplier: 3 } });
  const compiled = compileCodexLedgerPolicy(result.settings.policy);
  expect(result.settings.policy.base_rules).toEqual(codexLedgerSettings(c).policy.base_rules);
  expect(compiled.multiplier("model", "chatgpt_credits", "fast", "2026-10-01")).toEqual({ n: 2n, d: 1n });
  expect(compiled.multiplier("model", "api_equivalent_usd", "fast", "2026-10-01")).toEqual({ n: 3n, d: 1n });
  expect(compiled.multiplier("model", "api_equivalent_usd", "fast", "2026-09-30")).toEqual({ n: 4n, d: 3n });
  expect(result.effects.base_reprice).toEqual([]);
  const rule = compiled.resolveTierRule("model", "chatgpt_credits", "fast", "2026-10-01")!;
  expect(rule.included_usage).toBe("unchanged");
  expect(rule.source_rule_ids).toEqual(["official-original"]);
  expect(rule.note).toBe("Keep original attribution");
  expect(rule.sources).toEqual(["https://example.test/priority"]);
});
