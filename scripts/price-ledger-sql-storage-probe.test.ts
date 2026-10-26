import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Database } from "../src/db/sqlite";
import { constants } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import { compileReferenceConfig, referenceCodexEvent, mergeCounters, serializeCounter } from "./lib/price-ledger-reference";
import { codexPricingKey, type CodexAccountingConfig } from "../src/server/codex-accounting-pricing";

test("storage CLI writes only a candidate, preserves an immutable source and compares daily exact reference", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-storage-test-"));
  const source = path.join(root, "source.sqlite"), card = path.join(root, "card.json");
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const config: CodexAccountingConfig = { version: 1, rules: (["cs", "cf", "as", "af"] as const).map((id, index) => ({
    id, model: "synthetic", billing_basis: index < 2 ? "chatgpt_credits" : "api_equivalent_usd",
    speed: index % 2 ? "fast" : "standard", valid_from: "2026-04-02", multiplier: id === "cf" ? 2 : 1,
    rates: { in_uncached: index < 2 ? 1 : 2, in_cache_read: index < 2 ? 0.5 : 1, out_total: index < 2 ? 2 : 4 },
    verified_at: "2026-09-30", sources: ["https://example.org/synthetic"], confidence: "user",
  })) };
  fs.writeFileSync(card, JSON.stringify({ vendors: {}, codex_accounting: config }));
  const events = [10, 11, 12].map((in_tok, index) => ({ model: "synthetic", speed: null,
    ts: index === 2 ? "9999-12-31T12:00:00Z" : "2026-09-29T12:00:00+0230",
    in_tok, cached_in: 2, cache_write: 0, out_tok: 3, usage_status: "valid", cache_write_status: "missing" }));
  const db = new Database(source);
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok INTEGER,
      cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,usage_status TEXT,cache_write_status TEXT) STRICT`);
    events.forEach((event, index) => db.query("INSERT INTO events VALUES ('source','rollout',?,?,?,?,?,?,?,?,?)")
      .run(index * 100, event.model, event.ts, event.in_tok, event.cached_in, event.cache_write, event.out_tok, event.usage_status, event.cache_write_status));
  } finally { db.close(); }
  const configCompiled = compileReferenceConfig(config), contributions = events.map(event => referenceCodexEvent(configCompiled, event)!);
  const combine = (input: typeof contributions) => Object.fromEntries(Object.keys(input[0]!.counts).map(variant => [variant,
    serializeCounter(input.slice(1).reduce((sum, contribution) => mergeCounters(sum,
      contribution.counts[variant as keyof typeof contributions[0]["counts"]]), input[0]!.counts[variant as keyof typeof contributions[0]["counts"]]))]));
  const variants = combine(contributions);
  const sourceHash = digest(source), cardHash = digest(card);
  const attachment = new Database(":memory:", constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
  try {
    attachment.query("ATTACH DATABASE ? AS original").run(`${pathToFileURL(source).href}?mode=ro`);
    expect(() => attachment.exec("DELETE FROM original.events")).toThrow("readonly");
    expect(digest(source)).toBe(sourceHash);
  } finally { attachment.close(); }
  const manifest = path.join(root, "manifest.json"), reference = path.join(root, "reference.json");
  const pricingKey = codexPricingKey(config);
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, database: { path: source, sha256: sourceHash }, rules: { frozen: card, sha256: cardHash, pricing_key: pricingKey } }));
  fs.writeFileSync(reference, JSON.stringify({ schema: 1, database_sha256: sourceHash, card_sha256: cardHash,
    full: variants, days: [{ day: "2026-09-29", variants: combine(contributions.slice(0, 2)) },
      { day: "9999-12-31", variants: combine(contributions.slice(2)) }] }));
  try {
    const processResult = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "price-ledger-sql-storage-probe.ts"),
      "--manifest", manifest, "--reference", reference], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_TEMP_DIR: path.join(root, "scratch"),
        TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_CONFIG: path.join(root, "config") } });
    if (processResult.exitCode) throw new Error(processResult.stderr.toString());
    expect(processResult.exitCode).toBe(0);
    const output = JSON.parse(processResult.stdout.toString()), report = JSON.parse(fs.readFileSync(output.report, "utf8"));
    expect(output.day_mismatches).toBe(0);
    expect(output.checks.every((check: { amount_matches: boolean; priced_events_match: boolean }) => check.amount_matches && check.priced_events_match)).toBe(true);
    expect(report.price_rows.n).toBe(12);
    expect(digest(source)).toBe(sourceHash);
    const stored = new Database(report.candidate, { readonly: true, safeIntegers: true });
    try {
      expect((stored.query("SELECT COUNT(*) n FROM copies").get() as { n: bigint }).n).toBe(1n);
      expect((stored.query("SELECT COUNT(*) n FROM prices WHERE typeof(whole)!='integer' OR typeof(fraction_hi)!='integer' OR typeof(fraction_lo)!='integer'").get() as { n: bigint }).n).toBe(0n);
    } finally { stored.close(); }
    for (const alternate of [
      { ...config, rules: config.rules.filter(rule => rule.id !== "cf") },
      { ...config, rules: config.rules.map(rule => ({ ...rule, rates: { in_uncached: 0, in_cache_read: 0, out_total: 0 } })) },
    ]) {
      fs.writeFileSync(card, JSON.stringify({ vendors: {}, codex_accounting: alternate }));
      const alternateOracle = compileReferenceConfig(alternate);
      const alternateContributions = events.map(event => referenceCodexEvent(alternateOracle, event)!);
      fs.writeFileSync(manifest, JSON.stringify({ schema: 1, database: { path: source, sha256: sourceHash },
        rules: { frozen: card, sha256: digest(card), pricing_key: codexPricingKey(alternate) } }));
      fs.writeFileSync(reference, JSON.stringify({ schema: 1, database_sha256: sourceHash, card_sha256: digest(card),
        full: combine(alternateContributions), days: [{ day: "2026-09-29", variants: combine(alternateContributions.slice(0, 2)) },
          { day: "9999-12-31", variants: combine(alternateContributions.slice(2)) }] }));
      const alternateResult = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "price-ledger-sql-storage-probe.ts"),
        "--manifest", manifest, "--reference", reference], { stdout: "pipe", stderr: "pipe",
        env: { ...process.env, TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_TEMP_DIR: path.join(root, "scratch"),
          TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_CONFIG: path.join(root, "config") } });
      if (alternateResult.exitCode) throw new Error(alternateResult.stderr.toString());
      expect(alternateResult.exitCode).toBe(0);
      const alternateOutput = JSON.parse(alternateResult.stdout.toString());
      expect(alternateOutput.checks.every((check: { amount_matches: boolean; priced_events_match: boolean }) => check.amount_matches && check.priced_events_match)).toBe(true);
      expect(alternateOutput.day_mismatches).toBe(0);
      const alternateReport = JSON.parse(fs.readFileSync(alternateOutput.report, "utf8"));
      expect(alternateReport.price_rows.n).toBe(alternate.rules.length * 3);
    }
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error("Unexpected fixture cleanup root");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
