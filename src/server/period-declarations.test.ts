import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, recordPeriodReading } from "../db/period-store";
import { applyPeriodDeclarations, parsePeriodDeclarations } from "./period-declarations";

const good = {
  version: 1,
  accounts: [
    { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "acc-kn", from: "2026-01-01", until: "2026-03-29", evidence: "owner-declaration+payments" },
    { provider: "claude", source: "claude/EXAMPLE-MAIN", account: "acc-sm", from: "2026-07-29T09:54:00Z", until: "2026-09-09T15:48:11.251Z", evidence: "config-copies", note: "six dated copies" },
  ],
  plans: [
    { provider: "claude", account: "acc-kn", plan: "max-20x", from: "2026-02-28", until: "2026-03-28", amount_minor: 10181, currency: "EUR", evidence: "payment-confirmation" },
    { provider: "claude", account: "acc-kn", plan: "max-5x", from: "2026-04-08", until: "2026-05-08", evidence: "payment-confirmation" },
  ],
};

test("a declarations file becomes declared rows with day or instant bounds and receipt amounts", () => {
  const parsed = parsePeriodDeclarations(JSON.stringify(good));
  expect(parsed.errors).toEqual([]);
  expect(parsed.accounts.map((p) => [p.provider, p.subject, p.value, p.from, p.until, p.origin, p.evidence])).toEqual([
    ["claude", "claude/EXAMPLE-MAIN", "acc-kn", "2026-01-01", "2026-03-29", "declared", "owner-declaration+payments"],
    ["claude", "claude/EXAMPLE-MAIN", "acc-sm", "2026-07-29T09:54:00Z", "2026-09-09T15:48:11.251Z", "declared", "config-copies"],
  ]);
  expect(parsed.plans.map((p) => [p.subject, p.value, p.amountMinor, p.currency])).toEqual([["acc-kn", "max-20x", 10181, "EUR"], ["acc-kn", "max-5x", null, null]]);
});

test("the reserved \"none\" plan is accepted for any provider, in one spelling and without a payment", () => {
  const row = (provider: string, plan: string, extra: Record<string, unknown> = {}) =>
    ({ provider, account: `acc-${provider}`, plan, from: "2026-06-18", until: "2026-07-01", evidence: "refund", ...extra });
  const parsed = parsePeriodDeclarations(JSON.stringify({ version: 1, plans: [row("claude", "none"), row("codex", "none"), row("grok", "none", { amount_minor: 0 })] }));
  expect(parsed.errors).toEqual([]);
  expect(parsed.plans.map((p) => [p.provider, p.value])).toEqual([["claude", "none"], ["codex", "none"], ["grok", "none"]]);
  expect(parsePeriodDeclarations(JSON.stringify({ version: 1, plans: [row("claude", "None")] })).errors)
    .toEqual(['plans[0]: brak abonamentu zapisuje się dokładnie jako "none"']);
  const paid = parsePeriodDeclarations(JSON.stringify({ version: 1, plans: [row("claude", "none", { amount_minor: 1800, currency: "EUR" })] }));
  expect(paid.errors).toEqual(['plans[0]: okres "none" (brak abonamentu) nie może mieć kwoty płatności']);
  expect(paid.plans).toEqual([]);
});

test("a file with a missing field, a bad date or overlapping rows of one subject declares nothing and says why", () => {
  expect(parsePeriodDeclarations("{").errors[0]).toMatch(/JSON/);
  expect(parsePeriodDeclarations(JSON.stringify({ version: 2 })).errors).toEqual(['oczekiwano obiektu z "version": 1']);
  const missing = parsePeriodDeclarations(JSON.stringify({ version: 1, accounts: [{ provider: "claude", source: "s", from: "2026-01-01" }] }));
  expect(missing.errors).toEqual(["accounts[0]: brak pola evidence"]);
  const badDate = parsePeriodDeclarations(JSON.stringify({ version: 1, plans: [{ provider: "claude", account: "a", plan: "pro", from: "yesterday", evidence: "x" }] }));
  expect(badDate.errors.join()).toMatch(/invalid from 'yesterday'/);
  const overlap = parsePeriodDeclarations(JSON.stringify({ version: 1, accounts: [
    { provider: "claude", source: "claude/PC", account: "a", from: "2026-01-01", until: "2026-03-01", evidence: "x" },
    { provider: "claude", source: "claude/pc", account: "b", from: "2026-02-01", until: null, evidence: "x" },
  ] }));
  expect(overlap.errors.join()).toMatch(/nakładające się okresy/);
  expect(overlap.accounts).toEqual([]);
});

test("applying the file is idempotent, replaces declared rows on change, keeps observed rows and survives a broken edit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "period-declarations-")), file = path.join(dir, "account-periods.json");
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  try {
    recordPeriodReading(db, ACCOUNT_PERIODS, { provider: "claude", subject: "claude/EXAMPLE-MAIN", ts: "2026-09-09T15:48:11.251Z", value: "acc-sm" });
    // No file: nothing declared, nothing to do.
    expect(applyPeriodDeclarations(db, file)).toEqual({ digest: null, changed: false, errors: [] });
    fs.writeFileSync(file, JSON.stringify(good));
    expect(applyPeriodDeclarations(db, file)).toMatchObject({ changed: true, errors: [] });
    expect(applyPeriodDeclarations(db, file)).toMatchObject({ changed: false, errors: [] });
    const rows = () => loadPeriods(db, ACCOUNT_PERIODS).map((p) => [p.origin, p.value, p.from, p.until]);
    expect(rows()).toEqual([
      ["declared", "acc-kn", "2026-01-01", "2026-03-29"],
      ["declared", "acc-sm", "2026-07-29T09:54:00Z", "2026-09-09T15:48:11.251Z"],
      ["observed", "acc-sm", "2026-09-09T15:48:11.251Z", null],
    ]);
    expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.value, p.amountMinor, p.currency])).toEqual([["max-20x", 10181, "EUR"], ["max-5x", null, null]]);
    // A broken edit changes nothing and is reported.
    fs.writeFileSync(file, "{ nope");
    expect(applyPeriodDeclarations(db, file).errors.length).toBe(1);
    expect(rows().length).toBe(3);
    // A corrected date replaces the declared set; the observed row is untouched.
    const edited = structuredClone(good);
    edited.accounts[0]!.until = "2026-03-30";
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(applyPeriodDeclarations(db, file)).toMatchObject({ changed: true });
    expect(rows()[0]).toEqual(["declared", "acc-kn", "2026-01-01", "2026-03-30"]);
    expect(rows()[2]).toEqual(["observed", "acc-sm", "2026-09-09T15:48:11.251Z", null]);
    // Removing the file withdraws the declarations.
    fs.rmSync(file);
    expect(applyPeriodDeclarations(db, file)).toMatchObject({ changed: true });
    expect(rows()).toEqual([["observed", "acc-sm", "2026-09-09T15:48:11.251Z", null]]);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
