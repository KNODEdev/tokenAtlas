import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "../src/db/sqlite";
import { constants } from "bun:sqlite";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { isAccountingDay, longContextPremium } from "../src/server/codex-accounting-pricing";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";
import { frozenLedgerRules, verifyFrozenLedgerReference } from "./lib/price-ledger-frozen-rules";
import { compileNanoRates, nanoValuationSql, readNanoAggregate, type NanoAggregateParts } from "./lib/price-ledger-sql-numbers";
import { add, rational, equal, serializeRational } from "./lib/price-ledger-reference";

// Numeric/storage experiment only: sparse four-slot compatibility rows, not the P1 production schema.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--reference" || !args[1] || !args[3]) {
  throw new Error("Usage: bun scripts/price-ledger-sql-storage-probe.ts --manifest <manifest.json> --reference <reference.json>");
}
const manifest = JSON.parse(fs.readFileSync(args[1], "utf8")), reference = JSON.parse(fs.readFileSync(args[3], "utf8"));
if (manifest.schema !== 1 || reference.schema !== 1 || reference.database_sha256 !== manifest.database.sha256
    || reference.card_sha256 !== manifest.rules.sha256) throw new Error("Frozen reference revisions do not match");
const frozen = frozenLedgerCopy(manifest.database.path), config = frozenLedgerRules(manifest.rules);
verifyFrozenLedgerReference(manifest.rules, reference);
// Compile every band before any candidate exists: unsupported precision cannot leave a ready result.
const bands = config.rules.flatMap(rule => {
  const slot = `${rule.billing_basis === "chatgpt_credits" ? "c" : "a"}${rule.speed === "standard" ? "s" : "f"}`;
  return [{ rule, slot, band: "normal", rates: rule.rates, compiled: compileNanoRates(rule.rates, rule.multiplier) },
    ...(rule.long_context && longContextPremium(config) ? [{ rule, slot, band: "long", rates: rule.long_context.rates,
      compiled: compileNanoRates(rule.long_context.rates, rule.multiplier) }] : [])];
});
const workspace = createTemporaryWorkspace("price-ledger-sql-storage", frozen.live).directory;
// URI mode is required for a genuinely read-only attachment (the coordinator uses these flags).
const candidate = path.join(workspace, "candidate.sqlite"), db = new Database(candidate,
  constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
let exact: Database | undefined;
const clock = performance.now(), timings: Record<string, number> = {};
const time = (name: string, action: () => void) => {
  const start = performance.now(); action(); timings[name] = (timings[name] ?? 0) + performance.now() - start;
};
try {
  db.query("ATTACH DATABASE ? AS original").run(`${pathToFileURL(frozen.copy).href}?mode=ro`);
  // Sorter spills belong to the Settings-selected workspace, not a hardcoded OS temporary path.
  db.exec(`PRAGMA temp_store=FILE; PRAGMA temp_store_directory='${workspace.replaceAll("'", "''")}';
    PRAGMA main.cache_size=-8192; PRAGMA original.cache_size=-8192; PRAGMA main.mmap_size=0; PRAGMA original.mmap_size=0;`);
  // One validation per distinct timestamp; SQLite cannot reproduce the full Date.parse grammar.
  db.exec("CREATE TEMP TABLE valid_timestamps(ts TEXT PRIMARY KEY) STRICT");
  const saveTimestamp = db.query("INSERT INTO valid_timestamps VALUES (?)");
  time("timestamp_validation_ms", () => db.transaction(() => {
    for (const { ts } of db.query("SELECT DISTINCT ts FROM original.events").iterate() as Iterable<{ ts: unknown }>) {
      if (typeof ts === "string" && isAccountingDay(ts.slice(0, 10)) && Number.isFinite(Date.parse(ts))) saveTimestamp.run(ts);
    }
  })());
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE copies(id TEXT PRIMARY KEY,home TEXT NOT NULL,path TEXT NOT NULL,UNIQUE(home,path)) STRICT;
    CREATE TABLE price_rules(id TEXT NOT NULL,band TEXT NOT NULL,slot TEXT NOT NULL,denominator INTEGER NOT NULL,
      evidence TEXT NOT NULL,PRIMARY KEY(id,band)) STRICT;
    CREATE TABLE prices(copy_id TEXT NOT NULL,source_offset INTEGER NOT NULL,slot TEXT NOT NULL,rule_id TEXT NOT NULL,
      band TEXT NOT NULL,ts TEXT NOT NULL,day TEXT NOT NULL,whole INTEGER NOT NULL,fraction_hi INTEGER NOT NULL,fraction_lo INTEGER NOT NULL,
      PRIMARY KEY(copy_id,source_offset,slot)) STRICT;
    CREATE TABLE days(copy_id TEXT NOT NULL,slot TEXT NOT NULL,rule_id TEXT NOT NULL,band TEXT NOT NULL,day TEXT NOT NULL,
      rows INTEGER NOT NULL,whole_hi INTEGER NOT NULL,whole_lo INTEGER NOT NULL,fraction_hi INTEGER NOT NULL,fraction_lo INTEGER NOT NULL,
      PRIMARY KEY(copy_id,slot,rule_id,band,day)) STRICT;`);
  const copies = db.query("SELECT home,path FROM original.events GROUP BY home,path").all() as { home: string; path: string }[];
  const insertCopy = db.query("INSERT INTO copies VALUES (?,?,?)");
  time("copy_registry_ms", () => db.transaction(() => { for (const copy of copies) insertCopy.run(randomUUID(), copy.home, copy.path); })());
  const insertRule = db.query("INSERT INTO price_rules VALUES (?,?,?,?,?)");
  for (const { rule, slot, band, compiled } of bands) insertRule.run(rule.id, band, slot, compiled.denominator, JSON.stringify(rule));
  for (const { rule, slot, band, rates, compiled } of bands) {
    const filters = [`e.model=?`, `substr(e.ts,1,10)>=?`,
      `EXISTS (SELECT 1 FROM valid_timestamps t WHERE t.ts=e.ts)`,
      `(e.usage_status IS NULL OR e.usage_status NOT IN ('invalid','unknown','incomplete'))`,
      `(e.cache_write_status IS NULL OR e.cache_write_status!='invalid')`,
      ...["in_tok", "cached_in", "cache_write", "out_tok"].map(field => `typeof(e.${field})='integer' AND e.${field}>=0 AND e.${field}<=9007199254740991`),
      `e.cached_in+e.cache_write<=e.in_tok`, `e.in_tok+e.out_tok<=9007199254740991`];
    const parameters: (string | number | bigint | null)[] = [rule.model, rule.valid_from];
    if (rule.valid_until) { filters.push("substr(e.ts,1,10)<?"); parameters.push(rule.valid_until); }
    if (rule.model === "codex-auto-review") continue;
    if (rule.billing_basis === "chatgpt_credits" || rates.in_cache_write == null) filters.push("e.cache_write=0");
    if (rule.long_context && longContextPremium(config)) filters.push(`e.in_tok${band === "long" ? ">" : "<="}${rule.long_context.above_input_tokens}`);
    const input = `WITH input AS (SELECT c.id AS copy_id,e.source_offset,e.ts,substr(e.ts,1,10) AS day,
      e.in_tok-e.cached_in-e.cache_write AS in_uncached,e.cached_in AS in_cache_read,e.cache_write AS in_cache_write,e.out_tok AS out_total
      FROM original.events e JOIN copies c ON c.home=e.home AND c.path=e.path WHERE ${filters.join(" AND ")}),
      valued AS (${nanoValuationSql("input", compiled, ["copy_id", "source_offset", "ts", "day"])})
      INSERT INTO prices SELECT copy_id,source_offset,?, ?, ?,ts,day,whole,fraction_hi,fraction_lo FROM valued`;
    time("valuation_write_ms", () => db.transaction(() => db.query(input).run(...parameters, slot, rule.id, band))());
  }
  time("index_ms", () => db.exec("CREATE INDEX prices_time ON prices(slot,ts); CREATE INDEX prices_day ON prices(slot,day,rule_id,band)"));
  time("daily_aggregate_ms", () => db.exec(`INSERT INTO days SELECT copy_id,slot,rule_id,band,day,COUNT(*),
    SUM(whole/1000000000),SUM(whole%1000000000),SUM(fraction_hi),SUM(fraction_lo)
    FROM prices GROUP BY copy_id,slot,rule_id,band,day`));
  // The numeric-flags constructor cannot also take safeIntegers; reads use a dedicated exact connection.
  exact = new Database(candidate, { readonly: true, safeIntegers: true });
  const totals = new Map<string, ReturnType<typeof rational>>(), count = new Map<string, bigint>();
  const grouped = exact.query(`SELECT p.slot,p.rule_id,p.band,r.denominator,COUNT(*) AS rows,0 AS invalid_rows,
    SUM(p.whole/1000000000) AS whole_hi,SUM(p.whole%1000000000) AS whole_lo,SUM(p.fraction_hi) AS fraction_hi,SUM(p.fraction_lo) AS fraction_lo
    FROM prices p JOIN price_rules r ON r.id=p.rule_id AND r.band=p.band GROUP BY p.slot,p.rule_id,p.band`).all() as
      (NanoAggregateParts & { slot: string; denominator: bigint })[];
  for (const group of grouped) {
    totals.set(group.slot, add(totals.get(group.slot) ?? rational(0n), readNanoAggregate(group, group.denominator)));
    count.set(group.slot, (count.get(group.slot) ?? 0n) + group.rows);
  }
  const checks = [["as", "api_standard"], ["cs", "credits_standard"], ["cf", "credits_fast"]].map(([slot, variant]) => {
    const old = reference.full[variant!], stored = old.subtotal;
    return { slot, variant, amount_matches: equal(totals.get(slot!) ?? rational(0n), { n: BigInt(stored.numerator), d: BigInt(stored.denominator) }),
      priced_events_match: (count.get(slot!) ?? 0n) === BigInt(old.pricedEvents) };
  });
  // Compare all day sums for the three independent stored reference slots.
  const daily = exact.query(`SELECT d.slot,d.day,r.denominator,SUM(d.rows) AS rows,0 AS invalid_rows,
    SUM(d.whole_hi) whole_hi,SUM(d.whole_lo) whole_lo,SUM(d.fraction_hi) fraction_hi,SUM(d.fraction_lo) fraction_lo
    FROM days d JOIN price_rules r ON r.id=d.rule_id AND r.band=d.band GROUP BY d.slot,d.day,d.rule_id,d.band`).all() as
      (NanoAggregateParts & { slot: string; day: string; denominator: bigint })[];
  const dayTotals = new Map<string, { amount: ReturnType<typeof rational>; rows: bigint }>();
  for (const group of daily) {
    const key = `${group.slot}:${group.day}`, before = dayTotals.get(key) ?? { amount: rational(0n), rows: 0n };
    dayTotals.set(key, { amount: add(before.amount, readNanoAggregate(group, group.denominator)), rows: before.rows + group.rows });
  }
  let dayMismatches = 0;
  for (const day of reference.days) for (const [slot, variant] of [["as", "api_standard"], ["cs", "credits_standard"], ["cf", "credits_fast"]]) {
    const stored = dayTotals.get(`${slot}:${day.day}`) ?? { amount: rational(0n), rows: 0n }, expected = day.variants[variant!];
    if (stored.rows !== BigInt(expected.pricedEvents) || !equal(stored.amount,
      { n: BigInt(expected.subtotal.numerator), d: BigInt(expected.subtotal.denominator) })) dayMismatches++;
  }
  exact.close(); exact = undefined;
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(frozen.copy)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.database.sha256) throw new Error("Frozen copy hash mismatch");
  frozen.assertUnchanged();
  time("checkpoint_ms", () => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
  const report = path.join(workspace, "report.json");
  const output = { schema: 1, phase: "P0 numeric/storage probe; partial P1a evidence", runtime: { bun: Bun.version,
    sqlite: db.query("SELECT sqlite_version() version").get() }, candidate, source_sha256: manifest.database.sha256,
    card_sha256: manifest.rules.sha256, copies: copies.length, rule_bands: bands.length,
    pricing_key: manifest.rules.pricing_key,
    price_rows: db.query("SELECT COUNT(*) n FROM prices").get(), aggregate_rows: db.query("SELECT COUNT(*) n FROM days").get(),
    amounts: Object.fromEntries([...totals].map(([slot, amount]) => [slot, serializeRational(amount)])), checks,
    checked_days: reference.days.length, day_mismatches: dayMismatches, candidate_bytes: fs.statSync(candidate).size,
    timings, duration_ms: performance.now() - clock,
    limitations: ["Sparse priced four-slot compatibility experiment; not chosen two-base production schema",
      "Unpriced cohorts, copy selection and exact-range reads not yet migrated", "Copy registry IDs seeded once; publisher reconciliation not integrated",
      "No P0/P1a full acceptance or live deployment"] };
  fs.writeFileSync(report, JSON.stringify(output, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ report, checks, day_mismatches: dayMismatches, timings, candidate_bytes: output.candidate_bytes }));
  if (dayMismatches || checks.some(check => !check.amount_matches || !check.priced_events_match)) process.exitCode = 1;
} finally { exact?.close(); db.close(); }
