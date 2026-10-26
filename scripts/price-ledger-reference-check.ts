import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../src/db/sqlite";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { longContextPremium, prepareCodexPricing, valueCodexEvent } from "../src/server/codex-accounting-pricing";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";
import { frozenLedgerRules } from "./lib/price-ledger-frozen-rules";
import { VARIANTS, compileReferenceConfig, referenceCodexEvent, mergeCounters, serializeCounter,
  serializeRational, rational, decimal, subtract, auditBandProportionality, type Rational, type Counter,
  type Event, type Variant } from "./lib/price-ledger-reference";

// P0 oracle check, not a producer: read the frozen copy/card, write evidence in selected scratch.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) throw new Error("Usage: bun scripts/price-ledger-reference-check.ts --manifest <copy-audit-manifest.json>");
const manifest = JSON.parse(fs.readFileSync(args[1], "utf8"));
if (manifest.schema !== 1 || !manifest.database?.sha256 || !manifest.rules?.sha256) throw new Error("Invalid frozen manifest");
const frozen = frozenLedgerCopy(manifest.database.path);
const config = frozenLedgerRules(manifest.rules);
const oracle = compileReferenceConfig(config, longContextPremium(config));
const legacy = prepareCodexPricing(config);
const db = new Database(frozen.copy, { readonly: true, safeIntegers: true });
const started = performance.now(), int64Max = (1n << 63n) - 1n;
const zero = (): Counter => ({ subtotal: rational(0n), pricedSubtotal: rational(0n), value: rational(0n),
  pricedEvents: 0n, unpricedEvents: 0n, pricedTokens: 0n, unpricedTokens: 0n, reasons: {} });
const full = Object.fromEntries(VARIANTS.map(variant => [variant, zero()])) as Record<Variant, Counter>;
const days = new Map<string, Record<Variant, Counter>>();
type Bound = { maximum: bigint; nonintegral: number; overflow: number };
const units = [9, 12].map(places => ({ places, scale: 10n ** BigInt(places),
  variants: Object.fromEntries(VARIANTS.map(variant => [variant, { maximum: 0n, nonintegral: 0, overflow: 0 }])) as Record<Variant, Bound> }));
const maxima = Array.from({ length: 4 }, () => rational(0n));
const mismatchKinds: Record<string, number> = Object.create(null);
const nonintegralRules = new Map<string, number>();
let rows = 0, admitted = 0, priceChecks = 0, unequalAmounts = 0;
try {
  const physicalHash = createHash("sha256");
  for (const raw of db.query("SELECT rowid,* FROM events ORDER BY rowid").iterate() as Iterable<Record<string, unknown>>) {
    physicalHash.update(JSON.stringify(raw, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n");
    rows++;
    const event = { ...raw } as unknown as Event;
    for (const field of ["in_tok", "cached_in", "cache_write", "out_tok", "reasoning_out"] as const) {
      if (typeof raw[field] === "bigint") event[field] = Number(raw[field]);
    }
    const exact = referenceCodexEvent(oracle, event);
    if (!exact) continue;
    admitted++;
    const previous = valueCodexEvent(legacy, event);
    exact.prices.forEach((price, index) => {
      const old = previous[index]!;
      const mismatch = price.reason !== old.reason || price.rule_id !== old.rule_id || price.long_context !== old.long_context
        || (price.amount === null) !== (old.amount === null);
      if (mismatch) {
        const key = JSON.stringify([event.model, index, price.reason, old.reason]);
        mismatchKinds[key] = (mismatchKinds[key] ?? 0) + 1;
      }
      priceChecks++;
      if (price.amount !== null && old.amount !== null) {
        const delta = subtract(price.amount, decimal(old.amount));
        if (delta.n) unequalAmounts++;
        const absolute = rational(delta.n < 0n ? -delta.n : delta.n, delta.d);
        if (absolute.n * maxima[index]!.d > maxima[index]!.n * absolute.d) maxima[index] = absolute;
        for (const scale of units) if (price.amount.n * scale.scale % price.amount.d !== 0n) {
          const key = `${scale.places}:${price.rule_id}`;
          nonintegralRules.set(key, (nonintegralRules.get(key) ?? 0) + 1);
        }
      }
    });
    let daily = days.get(exact.day);
    if (!daily) { daily = Object.fromEntries(VARIANTS.map(variant => [variant, zero()])) as Record<Variant, Counter>; days.set(exact.day, daily); }
    for (const variant of VARIANTS) {
      full[variant] = mergeCounters(full[variant], exact.counts[variant]);
      daily[variant] = mergeCounters(daily[variant], exact.counts[variant]);
      const amount = exact.counts[variant].value;
      if (amount === null) continue;
      for (const scale of units) {
        const bound = scale.variants[variant], numerator = amount.n * scale.scale;
        if (numerator % amount.d !== 0n) { bound.nonintegral++; continue; }
        const value = numerator / amount.d, absolute = value < 0n ? -value : value;
        if (absolute > bound.maximum) bound.maximum = absolute;
        if (value > int64Max || value < -int64Max - 1n) bound.overflow++;
      }
    }
  }
  if (rows !== manifest.facts.rows || physicalHash.digest("hex") !== manifest.facts.physical_row_sha256) throw new Error("Frozen event hash mismatch");
  const fileHash = createHash("sha256");
  for await (const chunk of fs.createReadStream(frozen.copy)) fileHash.update(chunk);
  if (fileHash.digest("hex") !== manifest.database.sha256) throw new Error("Frozen database hash mismatch");
  frozen.assertUnchanged();
  const proportionality = [];
  for (const standard of config.rules.filter(rule => rule.speed === "standard")) {
    for (const fast of config.rules.filter(rule => rule.model === standard.model && rule.billing_basis === standard.billing_basis
      && rule.speed === "fast" && rule.valid_from < (standard.valid_until ?? "9999-12-31")
      && standard.valid_from < (rule.valid_until ?? "9999-12-31"))) {
      proportionality.push({ standard: standard.id, fast: fast.id,
        matching_context: standard.long_context?.above_input_tokens === fast.long_context?.above_input_tokens,
        normal: auditBandProportionality(standard.rates, fast.rates, standard.multiplier, fast.multiplier),
        long: standard.long_context && fast.long_context
          ? auditBandProportionality(standard.long_context.rates, fast.long_context.rates, standard.multiplier, fast.multiplier) : null });
    }
  }
  const workspace = createTemporaryWorkspace("price-ledger-reference", frozen.live).directory;
  const report = path.join(workspace, "reference.json");
  const output = { schema: 1, status: Object.keys(mismatchKinds).length ? "metadata-mismatch" : "price-metadata-compatible",
    manifest: path.resolve(args[1]), database_sha256: manifest.database.sha256, card_sha256: manifest.rules.sha256,
    pricing_key: manifest.rules.pricing_key,
    rows, admitted, excluded_invalid_lexical_days: rows - admitted, price_checks: priceChecks, unequal_float_amounts: unequalAmounts,
    mismatch_kinds: mismatchKinds, maximum_absolute_float_deltas: maxima.map(serializeRational),
    full: Object.fromEntries(VARIANTS.map(variant => [variant, serializeCounter(full[variant])])),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, counters]) => ({ day,
      variants: Object.fromEntries(VARIANTS.map(variant => [variant, serializeCounter(counters[variant])])) })),
    numeric: units.map(scale => ({ places: scale.places, variants: scale.variants,
      full_sums: Object.fromEntries(VARIANTS.map(variant => {
        const amount = full[variant].subtotal, numerator = amount.n * scale.scale;
        return [variant, { integral: numerator % amount.d === 0n,
          fits_int64: numerator % amount.d === 0n && numerator / amount.d <= int64Max && numerator / amount.d >= -int64Max - 1n }];
      })) })), nonintegral_base_rules: Object.fromEntries(nonintegralRules), proportionality,
    duration_ms: Math.round(performance.now() - started),
    limitations: ["All physical copies; report copy selection not yet applied", "Four legacy price slots checked; eleven aggregate variants are oracle output",
      "Old register pending: no complete old daily-register comparison", "Not a SQL ledger write/index/commit or P1a/API acceptance"] };
  fs.writeFileSync(report, JSON.stringify(output, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ report, status: output.status, rows, admitted, price_checks: priceChecks,
    mismatches: Object.values(mismatchKinds).reduce((sum, n) => sum + n, 0), unequal_float_amounts: unequalAmounts, duration_ms: output.duration_ms }));
  if (Object.keys(mismatchKinds).length) process.exitCode = 1;
} finally { db.close(); }
