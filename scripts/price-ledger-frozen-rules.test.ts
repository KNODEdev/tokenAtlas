import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { frozenLedgerRules, verifyFrozenLedgerReference } from "./lib/price-ledger-frozen-rules";
import { codexPricingKey } from "../src/server/codex-accounting-pricing";

test("frozen rules never inherit the current checkout and verify effective configuration revisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-rules-test-"));
  const original = path.join(root, "card.json"), resolved = path.join(root, "resolved.json");
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const config = { version: 1 as const, rules: [], long_context_premium: false };
  try {
    fs.writeFileSync(original, JSON.stringify({ vendors: {} }));
    fs.writeFileSync(resolved, JSON.stringify(config));
    const rules = { frozen: original, sha256: hash(original), pricing_key: codexPricingKey(config) };
    expect(() => frozenLedgerRules(rules)).toThrow("checkout defaults are not frozen");
    const complete = { ...rules, resolved: { frozen: resolved, sha256: hash(resolved) } };
    expect(frozenLedgerRules(complete)).toEqual(config);
    expect(() => verifyFrozenLedgerReference(complete, { card_sha256: rules.sha256 })).toThrow("does not freeze checkout fallback");
    expect(() => verifyFrozenLedgerReference(complete, { card_sha256: rules.sha256, pricing_key: rules.pricing_key })).not.toThrow();
    expect(() => verifyFrozenLedgerReference(complete, { card_sha256: rules.sha256, pricing_key: "0".repeat(64) })).toThrow("pricing key mismatch");
    expect(() => frozenLedgerRules({ ...complete, pricing_key: "0".repeat(64) })).toThrow("pricing key mismatch");
    fs.writeFileSync(resolved, JSON.stringify({ ...config, long_context_premium: true }));
    expect(() => frozenLedgerRules(complete)).toThrow("hash mismatch");
    fs.writeFileSync(original, JSON.stringify({ codex_accounting: config }));
    expect(frozenLedgerRules({ ...rules, sha256: hash(original) })).toEqual(config);
    const legacy = { ...rules, sha256: hash(original) };
    expect(() => verifyFrozenLedgerReference(legacy, { card_sha256: legacy.sha256 })).not.toThrow();
    expect(() => verifyFrozenLedgerReference({ ...legacy, pricing_key: codexPricingKey({ ...config, long_context_premium: true }) },
      { card_sha256: legacy.sha256 })).toThrow("differ from its original card");
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("ledger-rules-test-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
