import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexLedgerSettings } from "./codex-ledger-settings";
import { handleCodexLedgerSettings } from "./codex-ledger-settings-http";
import type { RateCard } from "./pricing";

test("Settings preview, revision conflict, archived save and undo share one policy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-settings-http-"));
  const target = path.join(directory, "rate-cards.json");
  const ctx: { rateCards: RateCard } = { rateCards: { version: 2, currency: "USD", unit: "USD per 1,000,000 tokens",
    vendors: {}, codex_accounting: { version: 1, rules: [] } } };
  const post = (body: unknown) => handleCodexLedgerSettings(ctx, new Request("http://local/api/codex-ledger-settings",
    { method: "POST", body: JSON.stringify(body) }), target);
  try {
    const revision = codexLedgerSettings(ctx.rateCards).revision;
    const edit = { expected_revision: revision, origin: "user", operations: [{ kind: "add_tier", tier: "ultrafast" }] };
    expect((await post({ ...edit, preview: true })).status).toBe(200);
    expect(fs.existsSync(target)).toBe(false);
    expect(codexLedgerSettings(ctx.rateCards).revision).toBe(revision);
    const saved = await post(edit);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.policy.tiers).toContain("ultrafast");
    const persisted = fs.readFileSync(target, "utf8");
    expect(JSON.parse(persisted).codex_ledger_policy.declaration_history.original.tiers).not.toContain("ultrafast");
    expect((await post(edit)).status).toBe(409);
    expect(fs.readFileSync(target, "utf8")).toBe(persisted);
    const undone = await post({ expected_revision: body.revision, undo_token: body.undo_token, origin: "user" });
    expect(undone.status).toBe(200);
    expect((await undone.json()).policy.tiers).not.toContain("ultrafast");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("invalid JSON, methods and exact representation are rejected before persistence", async () => {
  const ctx: { rateCards: RateCard } = { rateCards: { version: 2, currency: "USD", unit: "USD per 1,000,000 tokens",
    vendors: {}, codex_accounting: { version: 1, rules: [] } } };
  const target = path.resolve("TMP/ledger-settings-http-never-written.json");
  expect((await handleCodexLedgerSettings(ctx, new Request("http://local", { method: "PUT" }), target)).status).toBe(405);
  expect((await handleCodexLedgerSettings(ctx, new Request("http://local", { method: "POST", body: "{" }), target)).status).toBe(400);
  expect((await handleCodexLedgerSettings(ctx, new Request("http://local", { method: "POST", body: JSON.stringify({
    expected_revision: codexLedgerSettings(ctx.rateCards).revision, origin: "user", operations: [{ kind: "upsert_base_rule", rule: {
      id: "oversized", model: "model", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01",
      rates: { in_uncached: "100000000000000000000000000000000000000000000000000", in_cache_read: "0", out_total: "0" },
      multiplier: "1", verified_at: "2026-10-01", confidence: "user", sources: [] } }] }) }), target)).status).toBe(400);
  expect(fs.existsSync(target)).toBe(false);
});
