import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexLedgerSettings, readCodexLedgerPolicy, prepareCodexLedgerEdit, prepareCodexLedgerUndo,
  saveCodexLedgerEdit, saveCodexLedgerUndo, CodexLedgerRevisionConflict,
  type CodexLedgerOperation } from "./codex-ledger-settings";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy, type LedgerBaseRule, type LedgerTierRule } from "./codex-ledger-policy";
import type { RateCard } from "./pricing";

const source = { verified_at: "2026-09-01", sources: ["https://example.test/prices"], confidence: "official" as const };
const base = (id = "base", overrides: Partial<LedgerBaseRule> = {}): LedgerBaseRule => ({
  id, model: "test-model", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", valid_until: "2027-01-01",
  rates: { in_uncached: "1.7999999999999998", in_cache_read: "0.1", out_total: "5" }, multiplier: "1", ...source, ...overrides,
});
const factor = (id = "factor", overrides: Partial<LedgerTierRule> = {}): LedgerTierRule => ({
  id, model: "test-model", billing_basis: "chatgpt_credits", tier: "fast", valid_from: "2026-01-01",
  valid_until: "2027-01-01", multiplier: "1", ...source, ...overrides,
});
const policy = (): CodexLedgerPolicy => ({ version: 1, base_rules: [base()], tiers: ["standard", "fast"],
  tier_rules: [factor()], mappings: [{ id: "default", raw_value: "default", tier: "standard" }] });
const card = (p = policy()): RateCard => ({ version: 2, currency: "USD", unit: "per million", vendors: {}, codex_ledger_policy: p });
const edit = (c: RateCard, operations: CodexLedgerOperation[]) => prepareCodexLedgerEdit(c,
  { expected_revision: codexLedgerSettings(c).revision, operations, origin: "user", note: "Evidence-backed correction" },
  { now: "2026-10-01T12:00:00.000Z" });
const undo = (c: RateCard, token: string) => prepareCodexLedgerUndo(c,
  { expected_revision: codexLedgerSettings(c).revision, undo_token: token, origin: "user" });
const temporary: string[] = [];
const target = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-ledger-settings-"));
  temporary.push(directory); return path.join(directory, "rate-cards.json");
};
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("Codex ledger declarations", () => {
  test("explicit legacy transition preserves decimal spelling, evidence and raw mapping semantics", () => {
    const original: RateCard = { version: 2, currency: "USD", unit: "per million", vendors: {}, codex_accounting: { version: 1,
      rules: [{ ...source, id: "legacy", model: "test-model", billing_basis: "chatgpt_credits", speed: "standard",
        valid_from: "2026-01-01", multiplier: 1, rates: { in_uncached: 1.7999999999999998, in_cache_read: 0.1, out_total: 5 } }] } };
    const snapshot = structuredClone(original), p = readCodexLedgerPolicy(original);
    expect(original).toEqual(snapshot); expect(original.codex_ledger_policy).toBeUndefined();
    expect(p.base_rules[0]!.rates.in_uncached).toBe("1.7999999999999998");
    expect(p.base_rules[0]!.source_rule_ids).toEqual(["legacy"]);
    const compiled = compileCodexLedgerPolicy(p);
    expect(compiled.resolveTier("default", "2026-10-01")).toBe("standard");
    expect(compiled.resolveTier("priority", "2026-10-01")).toBe("fast");
    expect(compiled.resolveTier(null, "2026-10-01")).toBe("standard");
    expect(compiled.resolveTier("future", "2026-10-01")).toBeNull();
  });

  test("open ultrafast is a declaration with an exact rational and zero base repricing", () => {
    const result = edit(card(), [{ kind: "add_tier", tier: "ultrafast" },
      { kind: "upsert_mapping", mapping: { id: "ultra-raw", raw_value: "hyper", tier: "ultrafast", valid_from: "2026-10-01" } },
      { kind: "upsert_tier_rule", rule: factor("ultra-factor", { tier: "ultrafast", multiplier: { numerator: "7", denominator: "3" },
        valid_from: "2026-10-01", valid_until: undefined }) }]);
    const compiled = compileCodexLedgerPolicy(result.settings.policy);
    expect(compiled.multiplier("test-model", "chatgpt_credits", "ultrafast", "2026-10-01")).toEqual({ n: 7n, d: 3n });
    expect(compiled.resolveTier("hyper", "2026-09-30")).toBeNull();
    expect(compiled.resolveTier("hyper", "2026-10-01")).toBe("ultrafast");
    expect(compiled.resolveTier(null, "2026-10-01")).toBe("standard");
    expect(result.effects.base_reprice).toEqual([]);
    expect(result.effects.derivative_regroup).toEqual([{ side: "after", raw_value: "hyper", tier: "ultrafast",
      valid_from: "2026-10-01", include_unpriced: true }]);
    expect(result.effects.derivative_reread[0]).toMatchObject({ model: "test-model", tier: "ultrafast", include_unpriced: true });
    expect(result.card.codex_ledger_policy!.declaration_history!.edits[0]).toMatchObject({ origin: "user", updated_at: "2026-10-01T12:00:00.000Z" });
  });

  test("NULL raw tier, overlapping periods and invalid provenance fail atomically", () => {
    const original = card(), snapshot = structuredClone(original);
    for (const operations of [
      [{ kind: "upsert_mapping", mapping: { id: "null", raw_value: null, tier: "standard" } }],
      [{ kind: "upsert_base_rule", rule: base("overlap") }],
      [{ kind: "upsert_tier_rule", rule: factor("overlap") }],
      [{ kind: "upsert_base_rule", rule: base("base", { sources: [] }) }],
      [{ kind: "upsert_base_rule", rule: base("base", { sources: ["https://username:password@example.test"] }) }],
      [{ kind: "upsert_base_rule", rule: base("base", { valid_from: "2026-02-30" }) }],
      [{ kind: "remove_tier", tier: "standard" }],
    ] as unknown as CodexLedgerOperation[][]) expect(() => edit(original, operations)).toThrow();
    expect(original).toEqual(snapshot);
  });
  test("operation kind and payload cannot be mixed to turn an upsert into removal", () => {
    const initial = card(), snapshot = structuredClone(initial);
    for (const operation of [
      { kind: "upsert_base_rule", id: "base", rule: base("base", { note: "correction" }) },
      { kind: "remove_base_rule", id: "base", rule: base() },
      { kind: "upsert_mapping", id: "default", mapping: { id: "default", raw_value: "default", tier: "standard" } },
      { kind: "upsert_base_rule", mapping: { id: "default", raw_value: "default", tier: "standard" } },
      { kind: "remove_base_rule", id: 1 },
      { kind: "set_long_context_premium", enabled: "false" },
    ]) expect(() => edit(initial, [operation as unknown as CodexLedgerOperation])).toThrow("operation");
    expect(initial).toEqual(snapshot);
  });

  test("model and date correction selects both old and new missing-price cohorts", () => {
    const result = edit(card(), [{ kind: "upsert_base_rule", rule: base("base", { model: "new-model",
      valid_from: "2026-10-01", valid_until: undefined }) }]);
    expect(result.effects.base_reprice).toEqual([
      { side: "before", model: "test-model", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", valid_until: "2027-01-01", include_unpriced: true },
      { side: "after", model: "new-model", billing_basis: "chatgpt_credits", valid_from: "2026-10-01", include_unpriced: true },
    ]);
    const compiled = compileCodexLedgerPolicy(result.settings.policy);
    expect(compiled.resolveBaseRule(null, "chatgpt_credits", "2026-10-01")).toBeNull();
  });

  test("mapping corrections retain old/new scopes and do not reprice bases", () => {
    const result = edit(card(), [{ kind: "upsert_mapping", mapping: { id: "default", raw_value: "priority", tier: "fast", valid_from: "2026-08-01" } }]);
    expect(result.effects.base_reprice).toEqual([]);
    expect(result.effects.derivative_regroup).toEqual([
      { side: "before", raw_value: "default", tier: "standard", include_unpriced: true },
      { side: "after", raw_value: "priority", tier: "fast", valid_from: "2026-08-01", include_unpriced: true },
    ]);
  });

  test("overlay preserves both sides and undo restores the overwritten evidence and IDs", () => {
    const original = card();
    const result = edit(original, [{ kind: "overlay_base_rule", rule: base("correction", {
      valid_from: "2026-04-01", valid_until: "2026-07-01", rates: { in_uncached: "0", in_cache_read: "0", out_total: "0" } }) }]);
    const compiled = compileCodexLedgerPolicy(result.settings.policy);
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-03-31")!.rates.in_uncached).toBe("1.7999999999999998");
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-04-01")!.rates.in_uncached).toBe("0");
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-07-01")!.rates.in_uncached).toBe("1.7999999999999998");
    expect(result.settings.policy.base_rules).toHaveLength(3);
    expect(result.effects.base_reprice).toHaveLength(2);
    expect(result.effects.base_reprice.every(scope => scope.valid_from === "2026-04-01" && scope.valid_until === "2026-07-01")).toBe(true);
    const restored = undo(result.card, result.undo_token!);
    expect(restored.settings.policy).toEqual(policy());
    expect(restored.settings.revision).not.toBe(codexLedgerSettings(original).revision);
    expect(restored.card.codex_ledger_policy!.declaration_history!.original).toEqual(policy());
    expect(restored.card.codex_ledger_policy!.declaration_history!.edits[0]!.before.base_rules[0]!.confidence).toBe("official");
  });

  test("same-ID overlay also preserves both outside periods", () => {
    const result = edit(card(), [{ kind: "overlay_base_rule", replace_id: "base", rule: base("base", { valid_from: "2026-04-01", valid_until: "2026-07-01" }) }]);
    expect(result.settings.policy.base_rules).toHaveLength(3);
    expect(undo(result.card, result.undo_token!).settings.policy).toEqual(policy());
  });

  test("undo keeps later unrelated rules and rejects a later edit of the same rule", () => {
    const first = edit(card(), [{ kind: "upsert_base_rule", rule: base("base", { rates: { in_uncached: "2", in_cache_read: "0.1", out_total: "5" } }) }]);
    const second = edit(first.card, [{ kind: "upsert_base_rule", rule: base("other", { model: "other-model" }) }]);
    const restored = undo(second.card, first.undo_token!);
    expect(restored.settings.policy.base_rules.find(rule => rule.id === "base")).toEqual(base());
    expect(restored.settings.policy.base_rules.find(rule => rule.id === "other")!.model).toBe("other-model");
    const conflicting = edit(first.card, [{ kind: "upsert_base_rule", rule: base("base", { rates: { in_uncached: "3", in_cache_read: "0.1", out_total: "5" } }) }]);
    expect(() => undo(conflicting.card, first.undo_token!)).toThrow("conflicts");
  });
  test("undo restores an earlier temporal portion while preserving a later disjoint overlay of the same subject", () => {
    const april = edit(card(), [{ kind: "overlay_base_rule", rule: base("april", { valid_from: "2026-04-01", valid_until: "2026-06-01",
      rates: { in_uncached: "2", in_cache_read: "0.1", out_total: "5" } }) }]);
    const augustRule = base("august", { valid_from: "2026-08-01", valid_until: "2026-10-01",
      rates: { in_uncached: "3", in_cache_read: "0.1", out_total: "5" } });
    const august = edit(april.card, [{ kind: "overlay_base_rule", rule: augustRule }]);
    const restored = undo(august.card, april.undo_token!);
    const compiled = compileCodexLedgerPolicy(restored.settings.policy);
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-04-15")!.rates).toEqual(base().rates);
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-08-15")!.rates).toEqual(augustRule.rates);
    expect(compiled.resolveBaseRule("test-model", "chatgpt_credits", "2026-08-15")!.id).toBe("august");
    expect(restored.effects.base_reprice.every(scope => scope.valid_from === "2026-04-01" && scope.valid_until === "2026-06-01")).toBe(true);
    expect(undo(restored.card, august.undo_token!).settings.semantic_revision).toBe(codexLedgerSettings(card()).semantic_revision);
    const overlapping = edit(april.card, [{ kind: "overlay_base_rule", rule: base("overlap", { valid_from: "2026-05-01", valid_until: "2026-07-01",
      rates: { in_uncached: "4", in_cache_read: "0.1", out_total: "5" } }) }]);
    expect(() => undo(overlapping.card, april.undo_token!)).toThrow("conflicts");
  });
  test("temporal undo also preserves disjoint tier and raw-mapping corrections", () => {
    const april = edit(card(), [
      { kind: "overlay_mapping", mapping: { id: "april-map", raw_value: "default", tier: "fast", valid_from: "2026-04-01", valid_until: "2026-06-01" } },
      { kind: "overlay_tier_rule", rule: factor("april-factor", { valid_from: "2026-04-01", valid_until: "2026-06-01", multiplier: "2" }) },
    ]);
    const august = edit(april.card, [
      { kind: "overlay_mapping", mapping: { id: "august-map", raw_value: "default", tier: "fast", valid_from: "2026-08-01", valid_until: "2026-10-01" } },
      { kind: "overlay_tier_rule", rule: factor("august-factor", { valid_from: "2026-08-01", valid_until: "2026-10-01", multiplier: "3" }) },
    ]);
    const restored = undo(august.card, april.undo_token!), compiled = compileCodexLedgerPolicy(restored.settings.policy);
    expect(compiled.resolveTier("default", "2026-04-15")).toBe("standard");
    expect(compiled.resolveTier("default", "2026-08-15")).toBe("fast");
    expect(compiled.multiplier("test-model", "chatgpt_credits", "fast", "2026-04-15")).toEqual({ n: 1n, d: 1n });
    expect(compiled.multiplier("test-model", "chatgpt_credits", "fast", "2026-08-15")).toEqual({ n: 3n, d: 1n });
    expect(restored.settings.policy.mappings.find(rule => rule.id === "august-map")).toBeDefined();
    expect(restored.settings.policy.tier_rules.find(rule => rule.id === "august-factor")).toBeDefined();
  });

  test("precise factors are accepted without base invalidation and nonpositive factors are rejected", () => {
    for (const value of ["2.50000000000000000001", { numerator: "5", denominator: "7" }]) {
      const result = edit(card(), [{ kind: "upsert_tier_rule", rule: factor("factor", { multiplier: value }) }]);
      expect(result.settings.policy.tier_rules[0]!.multiplier).toEqual(value);
      expect(result.effects.base_reprice).toEqual([]);
      expect(result.effects.derivative_reread).toHaveLength(2);
    }
    expect(() => edit(card(), [{ kind: "upsert_tier_rule", rule: factor("factor", { multiplier: "0" }) }])).toThrow();
  });

  test("tier date correction rereads only vacated/new dates", () => {
    const result = edit(card(), [{ kind: "upsert_tier_rule", rule: factor("factor", { valid_from: "2026-02-01", valid_until: "2027-02-01" }) }]);
    expect(result.effects.base_reprice).toEqual([]);
    expect(result.effects.derivative_reread).toEqual([
      { side: "before", model: "test-model", billing_basis: "chatgpt_credits", tier: "fast", valid_from: "2026-01-01", valid_until: "2026-02-01", include_unpriced: true },
      { side: "after", model: "test-model", billing_basis: "chatgpt_credits", tier: "fast", valid_from: "2027-01-01", valid_until: "2027-02-01", include_unpriced: true },
    ]);
  });

  test("dated raw mapping overlay keeps provider mappings on both sides and is reversible", () => {
    const result = edit(card(), [{ kind: "overlay_mapping", mapping: { id: "mapping-correction", raw_value: "default", tier: "fast",
      valid_from: "2026-04-01", valid_until: "2026-07-01" } }]);
    const compiled = compileCodexLedgerPolicy(result.settings.policy);
    expect(compiled.resolveTier("default", "2026-03-31")).toBe("standard");
    expect(compiled.resolveTier("default", "2026-04-01")).toBe("fast");
    expect(compiled.resolveTier("default", "2026-07-01")).toBe("standard");
    expect(result.effects.derivative_regroup).toHaveLength(2);
    expect(result.effects.derivative_regroup.every(scope => scope.valid_from === "2026-04-01" && scope.valid_until === "2026-07-01")).toBe(true);
    expect(undo(result.card, result.undo_token!).settings.policy).toEqual(policy());
  });

  test("undo a tier addition retains later unrelated tier identities", () => {
    const first = edit(card(), [{ kind: "add_tier", tier: "ultrafast" }]);
    const second = edit(first.card, [{ kind: "add_tier", tier: "slow" }]);
    expect(undo(second.card, first.undo_token!).settings.policy.tiers).toEqual(["standard", "fast", "slow"]);
  });

  test("corrupted declaration snapshots fail before reading or writing", () => {
    const result = edit(card(), [{ kind: "add_tier", tier: "ultrafast" }]);
    result.card.codex_ledger_policy!.declaration_history!.edits[0]!.before.base_rules[0]!.rates.in_uncached = "4";
    expect(() => codexLedgerSettings(result.card)).toThrow("inconsistent");
  });

  test("metadata updates cause no data work; identical retry adds no revision/history", () => {
    const initial = card(), amended = edit(initial, [{ kind: "upsert_base_rule", rule: base("base", { note: "Exact source retained" }) }]);
    expect(amended.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(amended.settings.semantic_revision).toBe(codexLedgerSettings(initial).semantic_revision);
    const repeated = edit(amended.card, [{ kind: "upsert_base_rule", rule: amended.settings.policy.base_rules[0]! }]);
    expect(repeated.changed).toBe(false); expect(repeated.settings.revision).toBe(amended.settings.revision);
    expect(repeated.undo_token).toBeUndefined();
    expect(edit(initial, [{ kind: "upsert_base_rule", rule: base() }]).changed).toBe(false);
  });
  test("equivalent exact rate and multiplier spellings preserve semantic revision and trigger no data work", () => {
    const p = policy(); p.base_rules[0]!.rates.in_uncached = "1";
    p.tier_rules[0]!.multiplier = { numerator: "2", denominator: "4" };
    const initial = card(p);
    const changed = edit(initial, [
      { kind: "upsert_base_rule", rule: { ...p.base_rules[0]!, rates: { ...p.base_rules[0]!.rates, in_uncached: "1.0", in_cache_read: "0.10" }, multiplier: "1.00" } },
      { kind: "upsert_tier_rule", rule: { ...p.tier_rules[0]!, multiplier: { numerator: "1", denominator: "2" } } },
    ]);
    expect(changed.changed).toBe(true);
    expect(changed.settings.revision).not.toBe(codexLedgerSettings(initial).revision);
    expect(changed.settings.semantic_revision).toBe(codexLedgerSettings(initial).semantic_revision);
    expect(changed.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(changed.settings.policy.base_rules[0]!.rates.in_uncached).toBe("1.0");
    expect(changed.settings.policy.tier_rules[0]!.multiplier).toEqual({ numerator: "1", denominator: "2" });
    const decimal = edit(changed.card, [{ kind: "upsert_tier_rule", rule: { ...changed.settings.policy.tier_rules[0]!, multiplier: "0.500" } }]);
    expect(decimal.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(decimal.settings.semantic_revision).toBe(changed.settings.semantic_revision);
  });
  test("long-only correction selects above-threshold history and inactive premiums trigger no work", () => {
    const p = policy(); p.base_rules[0]!.long_context = { above_input_tokens: 100,
      rates: { in_uncached: "3", in_cache_read: "0.2", out_total: "6" } };
    const rule = { ...p.base_rules[0]!, long_context: { above_input_tokens: 100,
      rates: { in_uncached: "4", in_cache_read: "0.2", out_total: "6" } } };
    const changed = edit(card(p), [{ kind: "upsert_base_rule", rule }]);
    expect(changed.effects.base_reprice).toHaveLength(2);
    expect(changed.effects.base_reprice.every(scope => scope.input_above_tokens === 100)).toBe(true);
    expect(changed.effects.derivative_reread).toEqual(changed.effects.base_reprice);
    const inactive = card({ ...p, long_context_premium: false });
    const inactiveEdit = edit(inactive, [{ kind: "upsert_base_rule", rule }]);
    expect(inactiveEdit.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(inactiveEdit.settings.semantic_revision).toBe(codexLedgerSettings(inactive).semantic_revision);
  });
  test("ordinary-only and threshold corrections invalidate only the affected input intervals", () => {
    const p = policy(); p.base_rules[0]!.long_context = { above_input_tokens: 100,
      rates: { in_uncached: "3", in_cache_read: "0.2", out_total: "6" } };
    const ordinary = edit(card(p), [{ kind: "upsert_base_rule", rule: { ...p.base_rules[0]!,
      rates: { ...p.base_rules[0]!.rates, in_uncached: "2" } } }]);
    expect(ordinary.effects.base_reprice).toHaveLength(2);
    expect(ordinary.effects.base_reprice.every(scope => scope.input_at_most_tokens === 100 && scope.input_above_tokens === undefined)).toBe(true);
    const threshold = edit(card(p), [{ kind: "upsert_base_rule", rule: { ...p.base_rules[0]!,
      long_context: { ...p.base_rules[0]!.long_context!, above_input_tokens: 200 } } }]);
    expect(threshold.effects.base_reprice).toHaveLength(2);
    expect(threshold.effects.base_reprice.every(scope => scope.input_above_tokens === 100 && scope.input_at_most_tokens === 200)).toBe(true);
    const disabled = card({ ...p, long_context_premium: false });
    const inactiveThreshold = edit(disabled, [{ kind: "upsert_base_rule", rule: { ...p.base_rules[0]!,
      long_context: { ...p.base_rules[0]!.long_context!, above_input_tokens: 200 } } }]);
    expect(inactiveThreshold.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(inactiveThreshold.settings.semantic_revision).toBe(codexLedgerSettings(disabled).semantic_revision);
  });
  test("an equivalent dated overlay preserves semantic revision despite declaration splits and original spelling", () => {
    const initial = card();
    const changed = edit(initial, [{ kind: "overlay_base_rule", rule: base("equivalent", { valid_from: "2026-04-01", valid_until: "2026-06-01",
      rates: { ...base().rates, in_cache_read: "0.100" }, multiplier: "1.0" }) }]);
    expect(changed.settings.policy.base_rules).toHaveLength(3);
    expect(changed.settings.policy.base_rules.find(rule => rule.id === "equivalent")!.rates.in_cache_read).toBe("0.100");
    expect(changed.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    expect(changed.settings.semantic_revision).toBe(codexLedgerSettings(initial).semantic_revision);
  });

  test("premium changes select only long-context dependent models and threshold", () => {
    const initial = policy(); initial.base_rules.push(base("long", { model: "long-model", long_context: {
      above_input_tokens: 100, rates: { in_uncached: "3", in_cache_read: "0.2", out_total: "6" } } }));
    const result = edit(card(initial), [{ kind: "set_long_context_premium", enabled: false }]);
    expect(result.effects.base_reprice).toHaveLength(2);
    expect(result.effects.base_reprice.every(scope => scope.model === "long-model" && scope.input_above_tokens === 100)).toBe(true);
  });

  test("bounded snapshots keep initial provider evidence and reject expired undo tokens", () => {
    let c = card(), firstToken = "";
    for (let i = 0; i < 35; i++) {
      const result = edit(c, [{ kind: "upsert_tier_rule", rule: factor("factor", { multiplier: String(i + 2) }) }]);
      firstToken ||= result.undo_token!; c = result.card;
    }
    expect(c.codex_ledger_policy!.declaration_history!.edits).toHaveLength(32);
    expect(c.codex_ledger_policy!.declaration_history!.original).toEqual(policy());
    expect(() => undo(c, firstToken)).toThrow("outside");
  });
});

describe("synthetic archived rate-card persistence", () => {
  test("fresh disk CAS preserves other vendor settings and undo survives reload", () => {
    const file = target(), initial = card();
    initial.vendors.anthropic = { models: { synthetic: { in_uncached: 4, in_cache_read: 1, in_cache_write_5m: 5, in_cache_write_1h: 6, out_total: 9 } } };
    fs.writeFileSync(file, JSON.stringify(initial));
    const ctx = { rateCards: initial };
    const result = saveCodexLedgerEdit(ctx, { expected_revision: codexLedgerSettings(initial).revision, origin: "user",
      operations: [{ kind: "upsert_tier_rule", rule: factor("factor", { multiplier: "2.5" }) }] }, file);
    expect(result.card.vendors).toEqual(initial.vendors);
    const reloaded = JSON.parse(fs.readFileSync(file, "utf8")) as RateCard;
    expect(codexLedgerSettings(reloaded).revision).toBe(result.settings.revision);
    const restored = saveCodexLedgerUndo({ rateCards: initial }, { expected_revision: result.settings.revision,
      undo_token: result.undo_token!, origin: "user" }, file);
    expect(restored.settings.policy).toEqual(policy());
    expect(fs.readdirSync(path.dirname(file))).toEqual(["rate-cards.json"]);
  });

  test("stale and invalid saves preserve the full file and context", () => {
    const file = target(), initial = card(), newer = edit(initial, [{ kind: "add_tier", tier: "ultrafast" }]).card;
    fs.writeFileSync(file, JSON.stringify(newer));
    const bytes = fs.readFileSync(file, "utf8"), ctx = { rateCards: initial };
    expect(() => saveCodexLedgerEdit(ctx, { expected_revision: codexLedgerSettings(initial).revision, origin: "user",
      operations: [{ kind: "add_tier", tier: "another" }] }, file)).toThrow(CodexLedgerRevisionConflict);
    expect(() => saveCodexLedgerEdit(ctx, { expected_revision: codexLedgerSettings(newer).revision, origin: "user",
      operations: [{ kind: "upsert_base_rule", rule: base("bad-overlap") }] }, file)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(bytes); expect(ctx.rateCards).toBe(initial);
  });
});
