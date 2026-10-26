import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { legacyCodexLedgerSettings, prepareLegacyCodexLedgerEdit } from "./codex-ledger-legacy-settings";
import { codexLedgerSettings, prepareCodexLedgerEdit, prepareCodexLedgerUndo } from "./codex-ledger-settings";
import { handleCodexPricingSettings } from "./codex-pricing-settings";
import type { RateCard } from "./pricing";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";

const evidence = { verified_at: "2026-09-01", sources: ["https://example.test/prices"], confidence: "official" as const };
function card(): RateCard {
  const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard", "fast", "ultrafast"],
    mappings: [{ id: "raw:default", raw_value: "default", tier: "standard" }, { id: "raw:priority", raw_value: "priority", tier: "fast" },
      { id: "raw:ultra", raw_value: "new-tier", tier: "ultrafast" }],
    base_rules: [{ ...evidence, id: "base", model: "model", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01",
      rates: { in_uncached: "0.123456789012345678", in_cache_read: "0.10", out_total: "4.00", in_cache_write: null }, multiplier: "1.00",
      long_context: { above_input_tokens: 200000, rates: { in_uncached: "0.246913578024691356", in_cache_read: "0.2", out_total: "6", in_cache_write: null } } }],
    tier_rules: ["standard", "fast", "ultrafast"].map((tier, index) => ({ ...evidence, id: `tier:${tier}`, model: "model",
      billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", tier, multiplier: index === 0 ? "1" : index === 1 ? "2.00" : "3.5",
      included_usage: "proportional" })) };
  return { version: 2, currency: "USD", unit: "USD per 1,000,000 tokens", vendors: { openai: { models: {} } }, codex_ledger_policy: policy,
    codex_accounting: { version: 1, rules: [] } } as RateCard;
}
function row(value: RateCard, speed: "standard" | "fast") { return legacyCodexLedgerSettings(value).rules.find(rule => rule.speed === speed)!; }
function edit(value: RateCard, speed: "standard" | "fast", patch: Partial<ReturnType<typeof row>>) {
  const rule = row(value, speed);
  return prepareLegacyCodexLedgerEdit(value, { revision: legacyCodexLedgerSettings(value).revision, replace_id: rule.id, rule: { ...rule, ...patch } });
}
describe("approved Codex price editor bridge", () => {
  test("GET reflects modern policy and Standard metadata/date edits preserve exact text, custom tiers and mappings", () => {
    const before = card(), original = structuredClone(before.codex_ledger_policy!);
    const shown = row(before, "standard");
    expect(shown.rates.in_uncached).toBe(Number(original.base_rules[0]!.rates.in_uncached));
    const result = edit(before, "standard", { valid_from: "2026-02-01", note: "date correction" });
    const after = result.settings.policy;
    expect(after.base_rules[0]!.rates).toEqual(original.base_rules[0]!.rates);
    expect(after.base_rules[0]!.multiplier).toBe("1.00");
    expect(after.base_rules[0]!.long_context).toEqual(original.base_rules[0]!.long_context);
    expect(after.tier_rules).toEqual(original.tier_rules);
    expect(after.mappings).toEqual(original.mappings);
    expect(after.tiers).toEqual(original.tiers);
    expect(result.card.codex_accounting).toEqual(before.codex_accounting);
    expect(after.base_rules[0]!.confidence).toBe("user");
    expect(result.card.codex_ledger_policy!.declaration_history!.original).toEqual(original);
    const undone = prepareCodexLedgerUndo(result.card, { expected_revision: result.settings.revision, origin: "user", undo_token: result.undo_token! });
    expect(undone.settings.policy).toEqual(original);
  });
  test("Standard price edits preserve all tier factors and invalidate only the selected base/model/period", () => {
    const before = card(), standard = row(before, "standard");
    const result = prepareLegacyCodexLedgerEdit(before, { revision: legacyCodexLedgerSettings(before).revision,
      rule: { ...standard, id: "new-period", valid_from: "2026-03-01", valid_until: "2026-04-01",
        rates: { ...standard.rates, out_total: 9 } } });
    expect(result.settings.policy.base_rules.map(rule => [rule.valid_from, rule.valid_until, rule.rates.out_total])).toEqual([
      ["2026-01-01", "2026-03-01", "4.00"], ["2026-04-01", undefined, "4.00"], ["2026-03-01", "2026-04-01", "9"]]);
    expect(result.settings.policy.tier_rules).toEqual(before.codex_ledger_policy!.tier_rules);
    expect(result.effects.base_reprice.every(dep => dep.model === "model" && dep.valid_from === "2026-03-01" && dep.valid_until === "2026-04-01")).toBe(true);
  });
  test("Fast metadata edits preserve original factor and precise original decimals", () => {
    const before = card(), result = edit(before, "fast", { note: "same prices" });
    expect(result.settings.policy.base_rules).toEqual(before.codex_ledger_policy!.base_rules);
    expect(result.settings.policy.tier_rules.find(rule => rule.tier === "fast")!.multiplier).toBe("2.00");
    expect(result.effects).toEqual({ base_reprice: [], derivative_regroup: [], derivative_reread: [] });
    const retry = edit(result.card, "fast", { note: "same prices" });
    expect(retry.changed).toBe(false);
    expect(retry.settings.revision).toBe(result.settings.revision);
  });
  test("dated Standard included-usage edits retain other segments, exact bases and custom factors", () => {
    const before = card(), standard = before.codex_ledger_policy!.tier_rules.find(rule => rule.tier === "standard")!;
    standard.valid_until = "2026-06-01";
    before.codex_ledger_policy!.tier_rules.push({ ...structuredClone(standard), id: "tier:standard:later",
      valid_from: "2026-06-01", valid_until: undefined, included_usage: "unknown" });
    const settings = legacyCodexLedgerSettings(before), selected = settings.rules.find(rule => rule.speed === "standard" && rule.valid_from === "2026-06-01")!;
    expect(selected.included_usage).toBe("unknown");
    const result = prepareLegacyCodexLedgerEdit(before, { revision: settings.revision, replace_id: selected.id,
      rule: { ...selected, included_usage: "unchanged" } });
    for (const rule of result.settings.policy.base_rules) expect(rule.rates).toEqual(before.codex_ledger_policy!.base_rules[0]!.rates);
    expect(result.settings.policy.tier_rules.find(rule => rule.id === "tier:standard")).toEqual(standard);
    expect(result.settings.policy.tier_rules.filter(rule => rule.tier === "ultrafast" || rule.tier === "fast")).toEqual(before.codex_ledger_policy!.tier_rules.filter(rule => rule.tier === "ultrafast" || rule.tier === "fast"));
    expect(result.effects.base_reprice).toEqual([]);
    expect(result.effects.derivative_reread.every(dep => dep.tier === "standard" && dep.valid_from === "2026-06-01")).toBe(true);
  });
  test("Fast rate edits change only the factor and preserve other tiers, bases and mappings", () => {
    const before = card(), shown = row(before, "fast");
    // Changing only the legacy multiplier supplies an exact proportional factor without rounding displayed prices.
    const credits = structuredClone(before);
    credits.codex_ledger_policy!.base_rules[0]!.billing_basis = "chatgpt_credits";
    delete credits.codex_ledger_policy!.base_rules[0]!.rates.in_cache_write;
    delete credits.codex_ledger_policy!.base_rules[0]!.long_context!.rates.in_cache_write;
    for (const rule of credits.codex_ledger_policy!.tier_rules) rule.billing_basis = "chatgpt_credits";
    const result = edit(credits, "fast", { multiplier: 2 });
    expect(result.settings.policy.base_rules).toEqual(credits.codex_ledger_policy!.base_rules);
    expect(result.settings.policy.tier_rules.find(rule => rule.tier === "fast")!.multiplier).toBe("4");
    expect(result.settings.policy.tier_rules.filter(rule => rule.tier !== "fast")).toEqual(credits.codex_ledger_policy!.tier_rules.filter(rule => rule.tier !== "fast"));
    expect(result.settings.policy.mappings).toEqual(credits.codex_ledger_policy!.mappings);
    expect(result.effects.base_reprice).toEqual([]);
    expect(shown.speed).toBe("fast");
  });
  test("Fast removal of one base intersection preserves outside portions of the same tier period", () => {
    const before = card(), base = before.codex_ledger_policy!.base_rules[0]!;
    base.valid_until = "2026-06-01";
    before.codex_ledger_policy!.base_rules.push({ ...structuredClone(base), id: "base:later", valid_from: "2026-06-01", valid_until: undefined });
    const fast = row(before, "fast");
    const result = prepareLegacyCodexLedgerEdit(before, { revision: legacyCodexLedgerSettings(before).revision, remove: fast.id });
    expect(result.settings.policy.tier_rules.find(rule => rule.tier === "fast")).toMatchObject({ valid_from: "2026-06-01" });
    expect(result.settings.policy.base_rules).toEqual(before.codex_ledger_policy!.base_rules);
  });
  test("premium uses the modern declaration history and undo retains later unrelated custom-tier edits", () => {
    const before = card();
    const off = prepareLegacyCodexLedgerEdit(before, { revision: legacyCodexLedgerSettings(before).revision, long_context_premium: false });
    expect(legacyCodexLedgerSettings(off.card).long_context_premium).toBe(false);
    const later = prepareCodexLedgerEdit(off.card, { expected_revision: off.settings.revision, origin: "user", operations: [{ kind: "add_tier", tier: "future" }] });
    const undone = prepareCodexLedgerUndo(later.card, { expected_revision: later.settings.revision, origin: "user", undo_token: off.undo_token! });
    expect(undone.settings.policy.long_context_premium).toBeUndefined();
    expect(undone.settings.policy.tiers).toContain("future");
  });
});
describe("synthetic archived legacy editor HTTP writes", () => {
  test("fresh disk CAS covers modern hidden declarations and legacy changes; nonproportional and uncovered Fast writes are rejected without archival writes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ledger-legacy-")), target = path.join(directory, "rate-cards.json");
    try {
      const original = card(), ctx = { rateCards: original };
      fs.writeFileSync(target, JSON.stringify(original));
      const initial = await (await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing"), target)).json();
      const external = prepareCodexLedgerEdit(original, { expected_revision: codexLedgerSettings(original).revision, origin: "user", operations: [{ kind: "add_tier", tier: "hidden" }] }).card;
      fs.writeFileSync(target, JSON.stringify(external));
      const request = (body: unknown) => new Request("http://local/api/codex-pricing", { method: "POST", body: JSON.stringify(body) });
      const stale = await handleCodexPricingSettings(ctx, request({ revision: initial.revision, long_context_premium: false }), target);
      expect(stale.status).toBe(409);
      const fresh = legacyCodexLedgerSettings(external), diskBefore = fs.readFileSync(target, "utf8"), fast = row(external, "fast");
      const invalid = await handleCodexPricingSettings(ctx, request({ revision: fresh.revision, replace_id: fast.id,
        rule: { ...fast, rates: { ...fast.rates, out_total: 999 } } }), target);
      expect(invalid.status).toBe(400);
      const uncovered = await handleCodexPricingSettings(ctx, request({ revision: fresh.revision, replace_id: fast.id,
        rule: { ...fast, valid_from: "2025-12-01" } }), target);
      expect(uncovered.status).toBe(400);
      expect(fs.readFileSync(target, "utf8")).toBe(diskBefore);
      expect(ctx.rateCards).toEqual(original);
      const legacyChange = structuredClone(external);
      legacyChange.codex_accounting!.long_context_premium = false;
      fs.writeFileSync(target, JSON.stringify(legacyChange));
      expect((await handleCodexPricingSettings(ctx, request({ revision: fresh.revision, long_context_premium: false }), target)).status).toBe(409);
      let effects: unknown;
      const response = await handleCodexPricingSettings(ctx, request({ revision: legacyCodexLedgerSettings(legacyChange).revision, long_context_premium: false }), target, value => { effects = value; });
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.undo_token).toBeString(); expect(saved.ledger_effects).toEqual(effects);
      expect(ctx.rateCards.codex_ledger_policy!.tiers).toContain("hidden");
      expect(fs.readdirSync(directory)).toEqual(["rate-cards.json"]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
