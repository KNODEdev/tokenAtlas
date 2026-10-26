import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, readCodexLedgerGroups, rebuildCodexLedgerDay, valueCodexLedgerBand,
  type LedgerBaseBand } from "./codex-price-ledger";
import { readCodexLedgerSeries, mergeLedgerAmounts, CODEX_LEDGER_VARIANTS, type LedgerTierPolicy, type LedgerAmount } from "./codex-price-ledger-read";
import { decimal, equal, serializeRational } from "./price-ledger-exact";
import { compileReferenceConfig, referenceCodexEvent, mergeCounters, serializeCounter, type Event, type ReferenceConfig } from "../../scripts/lib/price-ledger-reference";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

const standardApi = { in_uncached: 1.875, in_cache_read: 0.125, out_total: 1.7999999999999998 };
const longApi = { in_uncached: 3.75, in_cache_read: 0.25, out_total: 3.5999999999999996 };
const credits = { in_uncached: 125, in_cache_read: 12.5, out_total: 1250 };
const card: ReferenceConfig = { version: 1, long_context_premium: true, rules: [
  { id: "api", model: "m", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-01-01", rates: standardApi, multiplier: 1,
    long_context: { above_input_tokens: 10, rates: longApi } },
  { id: "api-fast", model: "m", billing_basis: "api_equivalent_usd", speed: "fast", valid_from: "2026-01-01", multiplier: 1,
    rates: { in_uncached: 3.75, in_cache_read: 0.25, out_total: 3.5999999999999996 },
    long_context: { above_input_tokens: 10, rates: { in_uncached: 7.5, in_cache_read: 0.5, out_total: 7.199999999999999 } } },
  { id: "credit", model: "m", billing_basis: "chatgpt_credits", speed: "standard", valid_from: "2026-04-02", rates: credits, multiplier: 1,
    long_context: { above_input_tokens: 10, rates: credits } },
  { id: "credit-fast", model: "m", billing_basis: "chatgpt_credits", speed: "fast", valid_from: "2026-04-02", rates: credits, multiplier: 2.5,
    long_context: { above_input_tokens: 10, rates: credits } },
] };
// The oracle's literal long Fast artifact is not exactly 2× the standard artifact: use a finite
// decimal without that separate legacy edit for this homogeneous-factor fixture.
card.rules[0]!.long_context!.rates = { in_uncached: 3.75, in_cache_read: 0.25, out_total: 3.6 };
card.rules[1]!.long_context!.rates = { in_uncached: 7.5, in_cache_read: 0.5, out_total: 7.2 };
const bands: LedgerBaseBand[] = card.rules.filter(rule => rule.speed === "standard").flatMap(rule => [
  { id: rule.id, model: rule.model, basis: rule.billing_basis, validFrom: rule.valid_from, band: "normal" as const,
    threshold: 10, rates: rule.rates, multiplier: String(rule.multiplier), evidence: JSON.stringify(rule) },
  { id: rule.id, model: rule.model, basis: rule.billing_basis, validFrom: rule.valid_from, band: "long" as const,
    threshold: 10, rates: rule.long_context!.rates, multiplier: String(rule.multiplier), evidence: JSON.stringify(rule) },
]);
const policy: LedgerTierPolicy = { classify: raw => raw === "default" ? "standard" : raw === "priority" ? "fast" : null,
  multiplier: (model, basis, tier, day) => model !== "m" || basis === "chatgpt_credits" && day < "2026-04-02" ? null
    : tier === "standard" ? decimal(1) : tier === "fast" ? decimal(basis === "chatgpt_credits" ? 2.5 : 2) : null };
type Input = Event & { home?: string; path?: string; service_tier?: string | null; offset?: number };
const event = (overrides: Partial<Input> = {}): Input => ({ model: "m", speed: "standard", ts: "2026-04-02T12:00:00Z",
  in_tok: 10, cached_in: 2, cache_write: 0, out_tok: 3, reasoning_out: 1, usage_status: "valid", cache_write_status: "missing",
  service_tier: "default", ...overrides });
function fixture(events: Input[], run: (db: Database, result: ReturnType<typeof fillCodexLedgerFixture>) => void) {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
      cache_write ANY,out_tok ANY,reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,
      subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER) STRICT`);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'allowance',NULL,NULL,'plus',0)");
    events.forEach((e, index) => insert.run(e.home ?? "archive", e.path ?? "archive/sessions/one.jsonl", e.offset ?? index * 100,
      e.model, e.ts, e.in_tok, e.cached_in, e.cache_write, e.out_tok, e.reasoning_out as number ?? null,
      e.usage_status ?? null, e.cache_write_status ?? null, e.service_tier ?? null, e.speed));
    createCodexLedgerSchema(db);
    const result = fillCodexLedgerFixture(db, { bands, factsRevision: 0, rulesRevision: "rules",
      sourceOf: () => "source" });
    run(db, result);
  } finally { db.close(); }
}
const seal = (amount: LedgerAmount) => ({ subtotal: serializeRational(amount.subtotal), pricedSubtotal: serializeRational(amount.pricedSubtotal),
  value: amount.value === null ? null : serializeRational(amount.value), pricedEvents: String(amount.pricedEvents), unpricedEvents: String(amount.unpricedEvents),
  pricedTokens: String(amount.pricedTokens), unpricedTokens: String(amount.unpricedTokens), reasons: Object.fromEntries(Object.entries(amount.reasons)
    .map(([reason, counted]) => [reason, { events: String(counted.events), tokens: String(counted.tokens) }])) });

test("two stored bases reproduce all eleven independent variants, qualities and missing-data cohorts", () => {
  const inputs = [event(), event({ in_tok: 11, speed: "fast", service_tier: "priority" }), event({ speed: "unknown", service_tier: null }),
    event({ speed: "unknown", service_tier: "future-unmapped" }), event({ in_tok: 0, cached_in: 0, out_tok: 0 }),
    event({ ts: "2026-04-01T12:00:00Z" }), event({ ts: "2026-04-02T12:00:00+0230" }),
    event({ ts: "2026-04-02Tinvalid" }), event({ model: "missing-model" }),
    event({ model: "codex-auto-review", in_tok: -1 }), event({ in_tok: 13, cache_write: 2 }),
    event({ usage_status: "incomplete" }), event({ cached_in: 11 }), event({ usage_status: "invalid" }),
    event({ ts: "2026-02-31T00:00:00Z" })];
  const oracle = compileReferenceConfig(card);
  fixture(inputs, (db, built) => {
    expect(built.events).toBe(inputs.length);
    const groups = readCodexLedgerSeries(db, policy, {});
    const requested = ["api_standard", "normalized_usd"] as const;
    const projected = readCodexLedgerSeries(db, policy, { requestedVariants: requested });
    expect(projected).toEqual(groups.map(group => ({ ...group, variants: {
      api_standard: group.variants.api_standard, normalized_usd: group.variants.normalized_usd,
    } })));
    const expected = inputs.map(e => referenceCodexEvent(oracle, e)).filter(e => e !== null);
    for (const variant of CODEX_LEDGER_VARIANTS) {
      const actual = groups.slice(1).reduce((sum, group) => mergeLedgerAmounts(sum, group.variants[variant]), groups[0]!.variants[variant]);
      const reference = expected.slice(1).reduce((sum, contribution) => mergeCounters(sum, contribution.counts[variant]), expected[0]!.counts[variant]);
      expect(seal(actual)).toEqual(serializeCounter(reference));
    }
    expect(groups.reduce((sum, group) => sum + group.calls, 0n)).toBe(BigInt(expected.length));
    expect(groups.reduce((sum, group) => sum + group.quality.invalid_token_events, 0n)).toBe(expected.reduce((sum, e) => sum + e.quality.invalid_token_events, 0n));
    expect((db.query("SELECT COUNT(*) n FROM codex_price_ledger_aggregates WHERE grain='hour'").get() as { n: number }).n).toBeGreaterThan(0);
    const fields = (db.query("PRAGMA table_info(codex_price_ledger_events)").all() as { name: string }[]).map(f => f.name);
    expect(fields.some(field => field.includes("fast_whole") || field === "account")).toBe(false);
  });
});

test("exact instant endpoint policies and partial ranges use stored bases", () => fixture([
  event({ ts: "2026-04-02T00:00:00Z" }), event({ ts: "2026-04-02T01:00:00Z" }), event({ ts: "2026-04-02T02:00:00Z" }),
], db => {
  const from = Date.parse("2026-04-02T00:00:00Z"), to = Date.parse("2026-04-02T02:00:00Z");
  const chart = readCodexLedgerSeries(db, policy, { range: { fromMs: from, toMs: to } });
  const readings = readCodexLedgerSeries(db, policy, { range: { fromMs: from, toMs: to, startInclusive: false, endInclusive: true } });
  expect(chart.reduce((n, g) => n + g.calls, 0n)).toBe(2n);
  expect(readings.reduce((n, g) => n + g.calls, 0n)).toBe(2n);
  expect(chart[0]!.stored.first_ts).toBe("2026-04-02T00:00:00Z");
  expect(readings[0]!.stored.first_ts).toBe("2026-04-02T01:00:00Z");
  expect(readCodexLedgerGroups(db, { fromMs: from + 30 * 60_000, toMs: to - 30 * 60_000 }).reduce((n, g) => n + BigInt(g.calls), 0n)).toBe(1n);
  expect(() => readCodexLedgerGroups(db, { since: "2026-02-31" })).toThrow("Invalid lexical");
}));

test("copies of one conversation are resolved at build time: a prefix counts once in every range, a divergence is an explicit conflict", () => {
  const sessions = { home: "archive/profile", path: "archive/profile/sessions/2026/04/02/rollout-a.jsonl" };
  const archived = { home: "archive/profile", path: "archive/profile/archived_sessions/rollout-a.jsonl" };
  const other = { home: "archive/profile", path: "archive/profile/sessions/2026/04/02/rollout-b.jsonl" };
  const otherArchived = { home: "archive/profile", path: "archive/profile/archived_sessions/rollout-b.jsonl" };
  // rollout-a: the sessions copy is a prefix of the archived copy (same offsets). rollout-b: the copies disagree.
  const at = (copy: typeof sessions, offset: number, ts: string, change: Partial<Input> = {}) => event({ ...copy, ts, offset, ...change });
  fixture([at(sessions, 0, "2026-04-02T00:10:00Z"), at(sessions, 100, "2026-04-02T00:30:00Z"),
    at(archived, 0, "2026-04-02T00:10:00Z"), at(archived, 100, "2026-04-02T00:30:00Z"), at(archived, 200, "2026-04-02T01:30:00Z"),
    at(other, 0, "2026-04-02T02:00:00Z"), at(otherArchived, 0, "2026-04-02T02:00:00Z"), at(otherArchived, 100, "2026-04-02T02:30:00Z", { in_tok: 11 }),
    at(other, 300, "2026-04-02T02:40:00Z", { in_tok: 12 })], db => {
    const start = Date.parse("2026-04-02T00:00:00Z"), hour = 3_600_000;
    const calls = (fromMs: number, toMs: number) => readCodexLedgerSeries(db, policy, { range: { fromMs, toMs } })
      .filter(g => g.stored.copy_state === "canonical").reduce((sum, g) => sum + g.calls, 0n);
    expect(calls(start, start + hour)).toBe(2n); expect(calls(start + hour, start + 2 * hour)).toBe(1n); expect(calls(start, start + 2 * hour)).toBe(3n);
    expect(db.query(`SELECT c.path,e.source_offset,e.copy_state FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
      ORDER BY c.path,e.source_offset`).all()).toEqual([
      { path: archived.path, source_offset: 0, copy_state: "canonical" }, { path: archived.path, source_offset: 100, copy_state: "canonical" },
      { path: archived.path, source_offset: 200, copy_state: "canonical" },
      { path: otherArchived.path, source_offset: 0, copy_state: "canonical" }, { path: otherArchived.path, source_offset: 100, copy_state: "conflict" },
      { path: sessions.path, source_offset: 0, copy_state: "duplicate" }, { path: sessions.path, source_offset: 100, copy_state: "duplicate" },
      { path: other.path, source_offset: 0, copy_state: "duplicate" }, { path: other.path, source_offset: 300, copy_state: "conflict" }]);
    // The divergent group's unmatched calls stay out of the sums: neither double counted nor silently dropped from the facts.
    expect(calls(start + 2 * hour, start + 3 * hour)).toBe(1n);
  });
});

test("a rewritten copy without response ids (records shifted to other offsets) counts once, with no conflict (U3.0 §10.3a)", () => {
  const original = { home: "archive/profile", path: "archive/profile/sessions/2026/04/02/rollout-c.jsonl" };
  const rewritten = { home: "archive/profile", path: "archive/profile/archived_sessions/rollout-c.jsonl" };
  const at = (copy: typeof original, offset: number, ts: string, change: Partial<Input> = {}) => event({ ...copy, ts, offset, ...change });
  // The rewrite inserted a header record, so every usage record moved by 50 bytes.
  fixture([at(original, 0, "2026-04-02T03:00:00Z"), at(original, 100, "2026-04-02T03:10:00Z", { in_tok: 20 }),
    at(rewritten, 50, "2026-04-02T03:00:00Z"), at(rewritten, 150, "2026-04-02T03:10:00Z", { in_tok: 20 })], db => {
    const states = db.query("SELECT copy_state,COUNT(*) n FROM codex_price_ledger_events GROUP BY copy_state ORDER BY copy_state").all();
    expect(states).toEqual([{ copy_state: "canonical", n: 2 }, { copy_state: "duplicate", n: 2 }]);
    const canonical = readCodexLedgerSeries(db, policy, {}).filter(g => g.selected);
    expect(canonical.reduce((sum, g) => sum + g.calls, 0n)).toBe(2n);
    expect(canonical.reduce((sum, g) => sum + g.tokensReported, 0n)).toBe(13n + 23n);
  });
  // The same rewrite with one record changed: exactly that record is a conflict, the rest still counts once.
  fixture([at(original, 0, "2026-04-02T03:00:00Z"), at(original, 100, "2026-04-02T03:10:00Z", { in_tok: 20 }),
    at(rewritten, 50, "2026-04-02T03:00:00Z"), at(rewritten, 150, "2026-04-02T03:10:00Z", { in_tok: 21 })], db => {
    expect(db.query(`SELECT c.path,e.source_offset,e.copy_state FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
      ORDER BY c.path,e.source_offset`).all()).toEqual([
      { path: rewritten.path, source_offset: 50, copy_state: "canonical" }, { path: rewritten.path, source_offset: 150, copy_state: "conflict" },
      { path: original.path, source_offset: 0, copy_state: "duplicate" }, { path: original.path, source_offset: 100, copy_state: "conflict" }]);
    expect(readCodexLedgerSeries(db, policy, {}).filter(g => g.selected).reduce((sum, g) => sum + g.calls, 0n)).toBe(1n);
  });
});

test("sums carry no physical-copy dimension and equal the canonical calls of every day", () => fixture([
  event({ path: "archive/a/sessions/rollout-d.jsonl", ts: "2026-04-02T01:00:00Z" }), event({ path: "archive/a/archived_sessions/rollout-d.jsonl", ts: "2026-04-02T01:00:00Z", offset: 0 }),
  event({ path: "archive/a/sessions/rollout-e.jsonl", ts: "2026-04-03T01:00:00Z" }), event({ path: "archive/a/sessions/rollout-f.jsonl", ts: "2026-04-03T02:00:00Z" }),
], db => {
  const columns = (db.query("PRAGMA table_info(codex_price_ledger_dims)").all() as { name: string }[]).map(column => column.name);
  expect(columns).not.toContain("copy_id");
  // One dimension for all three rollouts of the same source, home and metadata.
  expect(db.query("SELECT COUNT(*) n FROM codex_price_ledger_dims").get()).toEqual({ n: 1 });
  const control = db.query(`SELECT e.day,COUNT(*) calls,SUM(e.reported) reported,SUM(e.api_whole) api_whole,SUM(e.credit_whole) credit_whole
    FROM codex_price_ledger_events e WHERE e.admitted=1 AND e.copy_state='canonical' GROUP BY e.day ORDER BY e.day`).all();
  const sums = db.query(`SELECT day,SUM(calls) calls,SUM(reported) reported,SUM(api_whole_hi*1000000000+api_whole_lo) api_whole,
    SUM(credit_whole_hi*1000000000+credit_whole_lo) credit_whole FROM codex_price_ledger_aggregates
    WHERE grain='day' AND copy_state='canonical' GROUP BY day ORDER BY day`).all();
  expect(sums).toEqual(control);
  expect(control.map(row => (row as { calls: number }).calls)).toEqual([1, 2]);
}));

test("precise open-tier changes reuse both stored bases and preserve zero-credit normalization", () => fixture([
  event({ service_tier: "priority", speed: "fast" }), event({ service_tier: "ultrafast", speed: "unknown" }),
  event({ service_tier: "priority", speed: "fast", in_tok: 0, cached_in: 0, out_tok: 0 }),
], db => {
  const before = db.query("SELECT id,api_whole,api_fraction_hi,api_fraction_lo,credit_whole,credit_fraction_hi,credit_fraction_lo FROM codex_price_ledger_events ORDER BY id").all();
  const updated: LedgerTierPolicy = { classify: raw => raw === "ultrafast" ? "ultrafast" : policy.classify(raw, "2026-04-02"),
    multiplier: (model, basis, tier, day) => tier === "ultrafast" ? decimal(basis === "chatgpt_credits" ? "3.0000001" : "4")
      : tier === "fast" && basis === "chatgpt_credits" ? decimal("2.5000001") : policy.multiplier(model, basis, tier, day) };
  const original = readCodexLedgerSeries(db, policy, {}), changed = readCodexLedgerSeries(db, updated, {});
  expect(original.find(g => g.stored.service_tier === "ultrafast")!.variants.api_actual.unpricedEvents).toBe(1n);
  expect(changed.find(g => g.stored.service_tier === "ultrafast")!.variants.api_actual.pricedEvents).toBe(1n);
  expect(equal(original[0]!.variants.credits_standard.subtotal, changed[0]!.variants.credits_standard.subtotal)).toBe(true);
  expect(db.query("SELECT id,api_whole,api_fraction_hi,api_fraction_lo,credit_whole,credit_fraction_hi,credit_fraction_lo FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
  expect(() => valueCodexLedgerBand(db, bands[0]!)).toThrow("producer transaction");
}));

test("per-file model rows are published with each day and equal a recount of the published calls after changes", () => fixture([
  event(), event({ ts: "2026-04-02T12:30:00Z", path: "archive/sessions/two.jsonl" }), event({ ts: "2026-04-02T13:10:00Z", model: "spark" }),
  event({ ts: "2026-04-03T01:00:00Z" }), event({ ts: "2026-04-03T01:20:00Z", path: "archive/sessions/two.jsonl" }),
  event({ ts: "2026-04-02Tinvalid" }), event({ ts: "2026-04-02T12:00:00+0230" }),
], db => {
  const stored = () => db.query("SELECT hour,dim_id,day,copy_id,first_ms,last_ms FROM codex_price_ledger_file_models ORDER BY 1,2,3,4").all();
  // The definition: published calls (admitted, copy resolved) with an instant, per hour, dimension, pricing day and file.
  const recount = () => db.query(`SELECT CAST(floor(instant_ms/3600000.0) AS INTEGER) hour,dim_id,day,copy_id,MIN(instant_ms) first_ms,MAX(instant_ms) last_ms
    FROM codex_price_ledger_events WHERE admitted=1 AND copy_state<>'pending' AND instant_ms IS NOT NULL GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`).all();
  expect(stored().length).toBeGreaterThan(3);
  expect(stored()).toEqual(recount());
  // A day republished after its calls change (a file's call removed, another's copy back to pending).
  db.transaction(() => {
    db.query("DELETE FROM codex_price_ledger_events WHERE ts='2026-04-02T12:30:00Z'").run();
    db.query("UPDATE codex_price_ledger_events SET copy_state='pending' WHERE ts='2026-04-03T01:00:00Z'").run();
    rebuildCodexLedgerDay(db, "2026-04-02"); rebuildCodexLedgerDay(db, "2026-04-03");
  })();
  expect(stored()).toEqual(recount());
  expect(stored().length).toBeGreaterThan(1);
}));
