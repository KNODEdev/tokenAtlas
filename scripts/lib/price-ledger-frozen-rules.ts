import fs from "node:fs";
import { createHash } from "node:crypto";
import { codexPricingKey, validateCodexAccountingConfig, type CodexAccountingConfig } from "../../src/server/codex-accounting-pricing";

interface FrozenRules {
  frozen: string; sha256: string; pricing_key: string;
  resolved?: { frozen: string; sha256: string };
}
/** Never resolve a fallback from the current checkout while replaying frozen evidence. */
export function frozenLedgerRules(rules: FrozenRules): CodexAccountingConfig {
  const checked = (file: string, expected: string): Buffer => {
    const bytes = fs.readFileSync(file);
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("Frozen rules hash mismatch");
    }
    return bytes;
  };
  const card = JSON.parse(checked(rules.frozen, rules.sha256).toString("utf8")) as { codex_accounting?: unknown };
  const config: unknown = rules.resolved
    ? JSON.parse(checked(rules.resolved.frozen, rules.resolved.sha256).toString("utf8")) : card.codex_accounting;
  if (config === undefined) throw new Error("Freeze the resolved Codex rules; checkout defaults are not frozen evidence");
  validateCodexAccountingConfig(config);
  if (codexPricingKey(config) !== rules.pricing_key) throw new Error("Frozen effective pricing key mismatch");
  return config;
}

/** Legacy references without an effective key are valid only when their original card itself pins it. */
export function verifyFrozenLedgerReference(rules: FrozenRules, reference: { card_sha256: string; pricing_key?: string }): void {
  if (reference.card_sha256 !== rules.sha256) throw new Error("Frozen reference card hash mismatch");
  if (reference.pricing_key !== undefined) {
    if (reference.pricing_key !== rules.pricing_key) throw new Error("Frozen reference effective pricing key mismatch");
    return;
  }
  const bytes = fs.readFileSync(rules.frozen);
  if (createHash("sha256").update(bytes).digest("hex") !== rules.sha256) throw new Error("Frozen rules hash mismatch");
  const card = JSON.parse(bytes.toString("utf8")) as { codex_accounting?: unknown };
  if (card.codex_accounting === undefined) throw new Error("Unkeyed reference does not freeze checkout fallback rules");
  validateCodexAccountingConfig(card.codex_accounting);
  if (codexPricingKey(card.codex_accounting) !== rules.pricing_key) throw new Error("Unkeyed reference effective rules differ from its original card");
}
