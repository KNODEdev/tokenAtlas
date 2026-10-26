import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  codexPricingSettings,
  editCodexPricingPeriod,
  handleCodexPricingSettings,
} from "./codex-pricing-settings";
import {
  codexPricingKey,
  priceCodexEvent,
  resolveCodexAccountingConfig,
  type CodexAccountingEvent,
} from "./codex-accounting-pricing";
import type { CodexAccountingRule } from "../shared/codex-accounting";
import type { RateCard } from "./pricing";
import { withContextRates } from "./rate-cards-file";

const TEST_TMP = path.resolve(import.meta.dir, "../../TMP/codex-pricing-settings-test");
const PRODUCTION_CARD = path.resolve(import.meta.dir, "../../rate-cards.json");

function rule(id: string, overrides: Partial<CodexAccountingRule> = {}): CodexAccountingRule {
  return {
    id,
    model: "gpt-6-astra",
    billing_basis: "chatgpt_credits",
    speed: "standard",
    valid_from: "2026-01-01",
    valid_until: "2026-12-31",
    verified_at: "2026-09-11",
    sources: ["https://example.test/codex-pricing"],
    confidence: "official",
    rates: { in_uncached: 100, in_cache_read: 10, out_total: 500 },
    multiplier: 1,
    ...overrides,
  };
}

function card(rules: CodexAccountingRule[] = [rule("base")]): RateCard {
  return {
    version: 2,
    currency: "USD",
    unit: "USD per 1,000,000 tokens",
    vendors: { openai: { models: {} } },
    codex_accounting: { version: 1, rules },
  };
}

function event(ts: string, model = "gpt-6-astra", speed: "standard" | "fast" = "standard"): CodexAccountingEvent {
  return { model, speed, ts, in_tok: 1_000_000, cached_in: 0, cache_write: 0, out_tok: 0 };
}

function priceAt(value: RateCard, ts: string): number | null {
  return priceCodexEvent(resolveCodexAccountingConfig(value), event(ts), "chatgpt_credits").amount;
}

function target(): string {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  return path.join(TEST_TMP, "rate-cards.json");
}

beforeEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

describe("editCodexPricingPeriod", () => {
  test("overlays one dated period and keeps both sides with an exclusive end", () => {
    const previous = rule("target-old", {
      valid_from: "2026-01-01",
      valid_until: "2026-12-31",
      rates: { in_uncached: 100, in_cache_read: 10, out_total: 500 },
    });
    const sameModelFast = rule("same-model-fast", { speed: "fast" });
    const sameModelApi = rule("same-model-api", { billing_basis: "api_equivalent_usd" });
    const otherModel = rule("other-model", { model: "gpt-5.6-luna" });
    const original = card([previous, sameModelFast, sameModelApi, otherModel]);
    const incoming = rule("target-overlay", {
      valid_from: "2026-04-01",
      valid_until: "2026-07-01",
      rates: { in_uncached: 300, in_cache_read: 30, out_total: 900 },
    });

    const edited = editCodexPricingPeriod(original, {
      revision: codexPricingSettings(original).revision,
      rule: incoming,
    });
    const targetRules = edited.codex_accounting!.rules.filter(
      (candidate) => candidate.model === previous.model
        && candidate.billing_basis === previous.billing_basis
        && candidate.speed === previous.speed,
    );
    expect(targetRules).toHaveLength(3);
    expect(targetRules.find((candidate) => candidate.id === "target-old")).toMatchObject({
      valid_from: "2026-01-01",
      valid_until: "2026-04-01",
      rates: previous.rates,
    });
    expect(targetRules.find((candidate) => candidate.id === "target-overlay")).toMatchObject({
      valid_from: "2026-04-01",
      valid_until: "2026-07-01",
      confidence: "user",
      rates: incoming.rates,
    });
    const after = targetRules.find((candidate) => candidate.valid_from === "2026-07-01");
    expect(after).toMatchObject({ valid_until: "2026-12-31", rates: previous.rates });
    expect(after?.id).toMatch(/^target-old:split:/);

    expect(priceAt(edited, "2026-03-31T23:59:59Z")).toBe(100);
    expect(priceAt(edited, "2026-04-01T00:00:00Z")).toBe(300);
    expect(priceAt(edited, "2026-06-30T23:59:59Z")).toBe(300);
    expect(priceAt(edited, "2026-07-01T00:00:00Z")).toBe(100);
    expect(edited.codex_accounting!.rules.find((candidate) => candidate.id === "same-model-fast")).toEqual(sameModelFast);
    expect(edited.codex_accounting!.rules.find((candidate) => candidate.id === "same-model-api")).toEqual(sameModelApi);
    expect(edited.codex_accounting!.rules.find((candidate) => candidate.id === "other-model")).toEqual(otherModel);
    expect(original.codex_accounting!.rules).toEqual([previous, sameModelFast, sameModelApi, otherModel]);
  });

  test("replaces by id and then removes the replacement", () => {
    const original = card([rule("replace-me", { valid_from: "2026-01-01", valid_until: "2026-05-01" })]);
    const replacement = rule("replace-me", {
      valid_from: "2026-02-01",
      valid_until: "2026-03-01",
      rates: { in_uncached: 777, in_cache_read: 77, out_total: 888 },
    });
    const replaced = editCodexPricingPeriod(original, {
      revision: codexPricingSettings(original).revision,
      replace_id: "replace-me",
      rule: replacement,
    });
    expect(replaced.codex_accounting!.rules).toHaveLength(1);
    expect(replaced.codex_accounting!.rules[0]).toMatchObject({
      id: "replace-me",
      valid_from: "2026-02-01",
      valid_until: "2026-03-01",
      confidence: "user",
      rates: replacement.rates,
    });

    const removed = editCodexPricingPeriod(replaced, {
      revision: codexPricingSettings(replaced).revision,
      remove: "replace-me",
    });
    expect(removed.codex_accounting!.rules).toEqual([]);
  });

  test("rejects a stale revision without changing the card", () => {
    const original = card();
    const revision = codexPricingSettings(original).revision;
    const newer = editCodexPricingPeriod(original, {
      revision,
      rule: rule("first-edit", { valid_from: "2027-01-01", valid_until: undefined }),
    });
    const snapshot = JSON.stringify(newer);

    expect(() => editCodexPricingPeriod(newer, {
      revision,
      rule: rule("stale-edit", { valid_from: "2027-02-01", valid_until: undefined }),
    })).toThrow("Cennik");
    expect(JSON.stringify(newer)).toBe(snapshot);
  });

  test("validates dates, provenance, ids and edit shape before returning a card", () => {
    const original = card();
    const revision = codexPricingSettings(original).revision;
    const snapshot = JSON.stringify(original);
    const invalidDate = rule("invalid-date", { valid_from: "2026-05-01", valid_until: "2026-04-01" });
    const invalidSource = rule("invalid-source", { sources: ["http://example.test/not-https"] });

    expect(() => editCodexPricingPeriod(original, { revision, rule: invalidDate })).toThrow("Invalid codex_accounting");
    expect(() => editCodexPricingPeriod(original, { revision, rule: invalidSource })).toThrow("Invalid codex_accounting");
    expect(() => editCodexPricingPeriod(original, { revision, rule: rule("base", { valid_from: "2027-01-01", valid_until: undefined }) })).toThrow("Identyfikator");
    expect(() => editCodexPricingPeriod(original, { revision, replace_id: "base" })).toThrow("Wybierz");
    expect(() => editCodexPricingPeriod(original, { revision, remove: "missing" })).toThrow("Nie znaleziono");
    expect(() => editCodexPricingPeriod(original, {
      revision,
      remove: "base",
      rule: rule("also-present", { valid_from: "2027-01-01", valid_until: undefined }),
    })).toThrow("Wybierz");
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("long-context premium setting", () => {
  const longRule = rule("api-long", { billing_basis: "api_equivalent_usd",
    rates: { in_uncached: 10, in_cache_read: 1, in_cache_write: 12.5, out_total: 50 },
    long_context: { above_input_tokens: 272000, rates: { in_uncached: 20, in_cache_read: 2, in_cache_write: 25, out_total: 75 } } });
  const apiPrice = (value: RateCard) =>
    priceCodexEvent(resolveCodexAccountingConfig(value), event("2026-09-01T12:00:00Z"), "api_equivalent_usd");

  test("off prices at base rates and on restores the original card and pricing key", () => {
    const original = card([longRule]);
    expect(codexPricingSettings(original).long_context_premium).toBe(true);
    expect(apiPrice(original)).toMatchObject({ amount: 20, long_context: true });
    const off = editCodexPricingPeriod(original, { revision: codexPricingSettings(original).revision, long_context_premium: false });
    expect(off.codex_accounting?.long_context_premium).toBe(false);
    expect(codexPricingSettings(off).long_context_premium).toBe(false);
    expect(apiPrice(off)).toMatchObject({ amount: 10, long_context: false });
    expect(codexPricingKey(resolveCodexAccountingConfig(off))).not.toBe(codexPricingKey(resolveCodexAccountingConfig(original)));
    const on = editCodexPricingPeriod(off, { revision: codexPricingSettings(off).revision, long_context_premium: true });
    expect(on).toEqual(original);
    expect(codexPricingKey(resolveCodexAccountingConfig(on))).toBe(codexPricingKey(resolveCodexAccountingConfig(original)));
  });

  test("is a save of its own and must be a boolean", () => {
    const value = card([longRule]);
    const revision = codexPricingSettings(value).revision;
    expect(() => editCodexPricingPeriod(value, { revision, long_context_premium: false, remove: "api-long" })).toThrow();
    expect(() => editCodexPricingPeriod(value, { revision, long_context_premium: "no" as unknown as boolean })).toThrow();
    expect(() => resolveCodexAccountingConfig({ codex_accounting: { version: 1, rules: [], long_context_premium: 0 as unknown as boolean } })).toThrow();
  });
});

describe("handleCodexPricingSettings", () => {
  test("persists to the supplied target, updates context and leaves production config untouched", async () => {
    const file = target();
    const initial = card();
    const ctx: { rateCards: RateCard } = { rateCards: initial };
    const productionBefore = fs.readFileSync(PRODUCTION_CARD, "utf8");

    const get = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing"), file);
    expect(get.status).toBe(200);
    const settings = await get.json() as { revision: string };
    expect(settings.revision).toBe(codexPricingSettings(initial).revision);

    const post = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: settings.revision,
        rule: rule("http-edit", { valid_from: "2027-01-01", valid_until: undefined }),
      }),
    }), file);
    expect(post.status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as RateCard;
    expect(persisted.codex_accounting!.rules.some((candidate) => candidate.id === "http-edit")).toBe(true);
    // The card in memory carries the context tiers of their own file, as a fresh load would.
    expect(ctx.rateCards).toEqual(withContextRates(persisted));
    expect(fs.readFileSync(PRODUCTION_CARD, "utf8")).toBe(productionBefore);
    expect(fs.readdirSync(TEST_TMP).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("rejects a stale browser write against fresh disk settings and preserves disk and context", async () => {
    const file = target();
    const initial = card();
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
    const ctx: { rateCards: RateCard } = { rateCards: initial };
    const get = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing"), file);
    const staleRevision = (await get.json() as { revision: string }).revision;
    const external = editCodexPricingPeriod(initial, {
      revision: staleRevision,
      rule: rule("external-edit", { valid_from: "2027-01-01", valid_until: undefined }),
    });
    fs.writeFileSync(file, JSON.stringify(external, null, 2));
    const diskBefore = fs.readFileSync(file, "utf8");

    const response = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: staleRevision,
        rule: rule("stale-edit", { valid_from: "2027-02-01", valid_until: undefined }),
      }),
    }), file);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain("Cennik");
    expect(fs.readFileSync(file, "utf8")).toBe(diskBefore);
    expect(ctx.rateCards).toEqual(initial);
  });

  test("returns HTTP validation errors without writing the target", async () => {
    const file = target();
    const initial = card();
    const ctx: { rateCards: RateCard } = { rateCards: initial };
    const before = JSON.stringify(initial);

    const malformed = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing", {
      method: "POST",
      body: "not-json",
    }), file);
    expect(malformed.status).toBe(400);
    expect(fs.existsSync(file)).toBe(false);

    const unsupported = await handleCodexPricingSettings(ctx, new Request("http://local/api/codex-pricing", { method: "PUT" }), file);
    expect(unsupported.status).toBe(405);
    expect(JSON.stringify(ctx.rateCards)).toBe(before);
  });
});
