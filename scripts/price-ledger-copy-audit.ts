import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configFile } from "../src/config/paths";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { Database } from "../src/db/sqlite";
import { codexPricingKey, isAccountingDay, resolveCodexAccountingConfig } from "../src/server/codex-accounting-pricing";
import type { RateCard } from "../src/server/pricing";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";

// P0 evidence only. The explicit frozen copy is read-only; this never opens the live database.
// Usage: bun scripts/price-ledger-copy-audit.ts --copy TMP/rollup-copy.sqlite
const json = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--copy" || !args[1]) {
  throw new Error("Usage: bun scripts/price-ledger-copy-audit.ts --copy <frozen-copy.sqlite>");
}
const frozen = frozenLedgerCopy(args[1]);
const { copy, live, before } = frozen;
const cardPath = configFile("rate-cards.json");
const cardBytes = fs.readFileSync(cardPath);
const config = resolveCodexAccountingConfig(JSON.parse(cardBytes.toString("utf8")) as RateCard);
const workspace = createTemporaryWorkspace("price-ledger-p0", live).directory;
fs.writeFileSync(path.join(workspace, "rate-cards.json"), cardBytes, { flag: "wx" });
const resolvedBytes = json(config) + "\n";
fs.writeFileSync(path.join(workspace, "effective-codex-accounting.json"), resolvedBytes, { flag: "wx" });
const db = new Database(copy, { readonly: true, safeIntegers: true });
const started = performance.now();
try {
  db.exec("PRAGMA query_only=ON");
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  const revisions = (table: string) => tables.has(table) ? db.query(`SELECT * FROM ${table}`).all() : null;
  const tokenColumns = ["in_tok", "cached_in", "cache_write", "out_tok", "reasoning_out"];
  const tokenBounds = tokenColumns.map(column => ({
    column,
    ...db.query(`SELECT COUNT(*) AS events, COUNT(${column}) AS observed,
      MIN(${column}) AS minimum, MAX(${column}) AS maximum,
      SUM(CASE WHEN typeof(${column})='integer' AND ${column}>=0 THEN ${column} ELSE 0 END) AS nonnegative_integer_sum,
      SUM(CASE WHEN ${column} IS NOT NULL AND (typeof(${column})!='integer' OR ${column}<0) THEN 1 ELSE 0 END) AS invalid
      FROM events`).get() as object,
  }));
  const tiers = db.query(`SELECT service_tier,speed,speed_source,COUNT(*) AS events,
    MIN(ts) AS first_ts,MAX(ts) AS last_ts FROM events GROUP BY service_tier,speed,speed_source
    ORDER BY service_tier,speed,speed_source`).all();
  const models = db.query(`SELECT model,COUNT(*) AS events,MIN(ts) AS first_ts,MAX(ts) AS last_ts,
    SUM(CASE WHEN model IS NULL OR model IN ('','?') THEN 1 ELSE 0 END) AS missing_identifier
    FROM events GROUP BY model ORDER BY model`).all();
  type DayModel = { model: string | null; day: string | null; events: bigint };
  const missingRules: object[] = [];
  for (const row of db.query(`SELECT model,substr(ts,1,10) AS day,COUNT(*) AS events
      FROM events GROUP BY model,substr(ts,1,10) ORDER BY model,day`).iterate() as Iterable<DayModel>) {
    if (!isAccountingDay(row.day)) continue;
    const absent = (["chatgpt_credits", "api_equivalent_usd"] as const).flatMap(basis =>
      (["standard", "fast"] as const).filter(speed => !config.rules.some(rule => rule.model === row.model
        && rule.billing_basis === basis && rule.speed === speed && row.day! >= rule.valid_from
        && (!rule.valid_until || row.day! < rule.valid_until))).map(speed => `${basis}:${speed}`));
    if (absent.length) missingRules.push({ ...row, absent });
  }
  const identity = db.query(`SELECT COUNT(*) AS events,
    SUM(source_offset IS NULL) AS missing_offset,SUM(response_id IS NOT NULL) AS with_response_id,
    SUM(turn_id IS NOT NULL) AS with_turn_id,SUM(home IS NULL OR path IS NULL) AS missing_copy,
    SUM(service_tier IS NULL) AS missing_raw_tier FROM events`).get();
  const duplicateOffsets = db.query(`SELECT COUNT(*) AS groups,COALESCE(SUM(n),0) AS events FROM (
    SELECT COUNT(*) AS n FROM events WHERE source_offset IS NOT NULL GROUP BY home,path,source_offset HAVING COUNT(*)>1)`).get();
  const funding = db.query(`SELECT billing_mode,plan_type,COUNT(*) AS events FROM events
    GROUP BY billing_mode,plan_type ORDER BY billing_mode,plan_type`).all();
  const producer = db.query(`SELECT usage_source,producer_version,usage_status,cache_write_status,COUNT(*) AS events
    FROM events GROUP BY usage_source,producer_version,usage_status,cache_write_status
    ORDER BY usage_source,producer_version,usage_status,cache_write_status`).all();
  const eventHash = createHash("sha256");
  const fields = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map(row => row.name);
  // Tagged JSON preserves NULL, TEXT and exact INTEGER transport without retaining usage rows.
  let rows = 0;
  for (const row of db.query(`SELECT rowid,* FROM events ORDER BY rowid`).iterate()) {
    eventHash.update(json(row) + "\n");
    rows++;
  }
  const copyHash = createHash("sha256");
  for await (const chunk of fs.createReadStream(copy)) copyHash.update(chunk);
  frozen.assertUnchanged();
  if (hash(fs.readFileSync(cardPath)) !== hash(cardBytes)) throw new Error("Rate card changed during audit; evidence rejected");
  const scopes = tables.has("usage_price_scopes") ? db.query("SELECT * FROM usage_price_scopes WHERE provider='codex'").all() as { rules_digest: string; status: string; phase: string }[] : [];
  const manifest = {
    schema: 1, phase: "P0 audit; not acceptance", created_at: new Date().toISOString(),
    runtime: { bun: Bun.version, sqlite: db.query("SELECT sqlite_version() AS version").get() },
    database: { path: copy, bytes: before.size, sha256: copyHash.digest("hex"), modified_at: before.mtime.toISOString() },
    facts: { rows, columns: fields, physical_row_sha256: eventHash.digest("hex"),
      note: "Hash includes rowid and physical path; it freezes this input, not the future semantic identity." },
    rules: { source: cardPath, frozen: path.join(workspace, "rate-cards.json"), sha256: hash(cardBytes),
      pricing_key: codexPricingKey(config), count: config.rules.length,
      resolved: { frozen: path.join(workspace, "effective-codex-accounting.json"), sha256: hash(resolvedBytes) } },
    revisions: { sync: revisions("sync_revisions"), vendor: revisions("vendor_sync_revisions"),
      migrations: revisions("__drizzle_migrations"), analysis: revisions("analysis_source_revisions") },
    legacy_scopes: scopes,
    legacy_scope_rules_ready: scopes.length > 0 && scopes.every(scope => scope.status === "ready" && scope.rules_digest === codexPricingKey(config)),
    audit: { token_bounds: tokenBounds, tiers, models, missing_rule_days: missingRules,
      identity, duplicate_offsets: duplicateOffsets, funding, producer },
    source_hashes: ["src/server/codex-accounting-pricing.ts", "src/db/usage-price-totals.ts", "scripts/price-ledger-copy-audit.ts", "scripts/lib/price-ledger-copy.ts"]
      .map(file => ({ file, sha256: hash(fs.readFileSync(path.resolve(import.meta.dir, "..", file))) })),
    duration_ms: Math.round(performance.now() - started),
    limitations: ["Scope status/rules do not prove journal/source coverage", "No archive tier recovery audit",
      "No ledger publication or API comparison", "No generation/restart acceptance"],
  };
  const report = path.join(workspace, "manifest.json");
  fs.writeFileSync(report, json(manifest) + "\n", { flag: "wx" });
  console.log(json({ report, rows, token_bounds: tokenBounds, identity, duplicate_offsets: duplicateOffsets,
    rules_match_legacy: scopes.map(scope => scope.rules_digest === codexPricingKey(config)),
    legacy_scope_rules_ready: manifest.legacy_scope_rules_ready, duration_ms: manifest.duration_ms }));
} finally {
  db.close();
}
