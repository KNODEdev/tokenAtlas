import { expect, test, spyOn } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { CODEX_LEDGER_VARIANTS, deriveCodexLedgerGroup, readCodexLedgerSeries, type LedgerAmount, type LedgerVariant } from "./codex-price-ledger-read";
import { codexLedgerReadContext, readCodexLedgerOwnedSeries, codexLedgerApiTokenAmounts } from "./codex-ledger-adapters";
import { buildAccountResolver } from "../server/account-resolver";
import { apiCodexLedgerRows, apiCodexTokenReader } from "../server/api-codex-ledger";
import type { CodexLedgerPolicy } from "../server/codex-ledger-policy";
import type { DatedPeriod } from "../server/account-periods";
import type { RateCard } from "../server/pricing";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

const day = "2026-09-01", apiOnly = ["api_standard"] as const;
const evidence = { verified_at: day, confidence: "official" as const, sources: ["https://example.test/pricing"] };
const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard", "fast"],
  mappings: [{ id: "default", raw_value: "default", tier: "standard" }, { id: "priority", raw_value: "priority", tier: "fast" }],
  base_rules: ["model", "zero"].flatMap(model => [
    { id: `${model}-api`, model, billing_basis: "api_equivalent_usd" as const, valid_from: "2026-01-01", multiplier: "1", ...evidence,
      rates: { in_uncached: model === "zero" ? "0" : "1.000000000001", in_cache_read: "0.1", in_cache_write: "1.25", out_total: "5" },
      ...(model === "model" ? { long_context: { above_input_tokens: 1000, rates: { in_uncached: "2", in_cache_read: "0.2", in_cache_write: "2.5", out_total: "10" } } } : {}) },
    { id: `${model}-credit`, model, billing_basis: "chatgpt_credits" as const, valid_from: "2026-01-01", multiplier: "1", ...evidence,
      rates: { in_uncached: model === "zero" ? "0" : "100", in_cache_read: "10", out_total: "500" } },
  ]), tier_rules: ["api_equivalent_usd", "chatgpt_credits"].map(basis => ({ id: `${basis}-fast`, model: "model",
    billing_basis: basis as "api_equivalent_usd" | "chatgpt_credits", tier: "fast", multiplier: { numerator: "7", denominator: "3" },
    valid_from: "2026-01-01", ...evidence })) };
type Input = { ts?: string; model?: string | null; input?: number; cached?: number; writes?: number; raw?: string | null;
  home?: string; project?: string; billing?: string; usage?: string };
function fixture(events: Input[], run: (db: Database, context: ReturnType<typeof codexLedgerReadContext>, card: RateCard) => void) {
  const db = new Database(":memory:");
  const card: RateCard = { version: 2, currency: "USD", unit: "per million", vendors: {}, codex_ledger_policy: policy };
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
      cache_write ANY,out_tok ANY,reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,
      subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,project_id ANY) STRICT`);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,0,0,?,'missing',?,'unknown',NULL,?,'chat',NULL,'plus',1,?)");
    events.forEach((event, index) => {
      const home = event.home ?? "/archive/codex/main";
      insert.run(home, `${home}/sessions/shared.jsonl`, index * 100, event.model === undefined ? "model" : event.model,
        event.ts ?? `${day}T12:00:00Z`, event.input ?? 100, event.cached ?? 0, event.writes ?? 0, event.usage ?? "valid",
        event.raw === undefined ? "default" : event.raw, event.billing ?? "subscription", event.project ?? null);
    });
    const context = codexLedgerReadContext(card);
    createCodexLedgerSchema(db);
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, policy: context.policy.policy,
      rulesRevision: context.rulesRevision!, factsRevision: 0, sourceOf: () => "codex/main" });
    run(db, context, card);
  } finally { db.close(true); }
}
const period = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "codex", subject: "codex/main",
  from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });

test("requested variant tuples preserve exact API amounts and every group fact across missing, zero, long and unknown cohorts", () => fixture([
  {}, { input: 2000, cached: 100, writes: 20, raw: "priority" }, { model: "zero" }, { model: null },
  { model: "absent", raw: null }, { raw: "unrecognized" }, { input: -1 }, { usage: "incomplete" },
], (db, context) => {
  const before = db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
  const full = readCodexLedgerSeries(db, context.policy, {});
  const subset = readCodexLedgerSeries(db, context.policy, { requestedVariants: apiOnly });
  expect(subset).toEqual(full.map(group => ({ ...group, variants: { api_standard: group.variants.api_standard } })));
  expect(full.every(group => Object.keys(group.variants).length === CODEX_LEDGER_VARIANTS.length)).toBe(true);
  expect(subset.find(group => group.stored.model === "zero")!.variants.api_standard.pricedEvents).toBe(1n);
  expect(subset.find(group => group.stored.model === null)!.variants.api_standard.value).toBeNull();
  const other = readCodexLedgerSeries(db, context.policy, { requestedVariants: ["api_actual", "credits_fast"] as const });
  expect(other).toEqual(full.map(group => ({ ...group, variants: { api_actual: group.variants.api_actual, credits_fast: group.variants.credits_fast } })));
  const dynamicKeys: readonly LedgerVariant[] = ["api_standard"];
  const dynamic = readCodexLedgerSeries(db, context.policy, { requestedVariants: dynamicKeys });
  if (false) {
    // @ts-expect-error A literal API projection does not claim absent credit variants.
    const absent: LedgerAmount = subset[0]!.variants.credits_standard;
    // @ts-expect-error A dynamic requested array cannot statically guarantee every variant key.
    const optional: LedgerAmount = dynamic[0]!.variants.api_standard;
    void absent; void optional;
  }
  expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(before);
}));

test("API-only projection reads no credit denominator and invokes no tier multiplier", () => fixture([{ input: 2000, raw: "priority" }], (db, context) => {
  const full = readCodexLedgerSeries(db, context.policy, {})[0]!;
  const band = db.query("SELECT CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands WHERE id=?").get(full.stored.api_band) as { denominator: string };
  let multipliers = 0;
  const subset = deriveCodexLedgerGroup(full.stored, new Map([[full.stored.api_band, BigInt(band.denominator)]]),
    { classify: context.policy.classify, multiplier: () => { multipliers++; throw new Error("unused tier calculation"); } }, apiOnly);
  expect(multipliers).toBe(0);
  expect(subset).toEqual({ ...full, variants: { api_standard: full.variants.api_standard } });
  expect(codexLedgerApiTokenAmounts(db, subset, context)).toEqual(codexLedgerApiTokenAmounts(db, full, context));
}));

test("series API-only lookup fetches only API denominators while default and other subsets retain both bases", () => fixture([{}], (db, context) => {
  const queries = spyOn(db, "query");
  try {
    const bandLookups = () => queries.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith("SELECT id,CAST(denominator AS TEXT)"));
    const subset = readCodexLedgerSeries(db, context.policy, { requestedVariants: apiOnly });
    expect(bandLookups()).toEqual(["SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands WHERE basis='api_equivalent_usd'"]);
    queries.mockClear();
    const full = readCodexLedgerSeries(db, context.policy, {});
    expect(bandLookups()).toEqual(["SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands"]);
    queries.mockClear();
    const credit = readCodexLedgerSeries(db, context.policy, { requestedVariants: ["credits_standard"] as const });
    expect(bandLookups()).toEqual(["SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands"]);
    expect(subset[0]!.variants.api_standard).toEqual(full[0]!.variants.api_standard);
    expect(credit[0]!.variants.credits_standard).toEqual(full[0]!.variants.credits_standard);
  } finally { queries.mockRestore(); }
}));

test("API projection shares exact UTC edges, dated owner slices, gaps and funding ownership", () => fixture([
  { ts: "2026-08-31T23:30:00-02:00" }, { ts: `${day}T12:00:00Z` }, { ts: `${day}T13:00:00Z`, raw: "priority" },
  { ts: `${day}T14:00:00Z`, billing: "business_credits" }, { ts: "2026-09-02T04:00:00+02:00" },
], (db, context) => {
  const owner = buildAccountResolver([period("2026-08-01",`${day}T13:00:00Z`,"a"), period(`${day}T13:00:00Z`,`${day}T14:00:00Z`,"b")]);
  for (const range of [{ since: day, until: day }, { since: day, until: day, grain: "hour" as const },
    { fromMs: Date.parse(day), toMs: Date.parse("2026-09-03") }]) {
    const full = readCodexLedgerOwnedSeries(db, range, owner, context);
    const subset = readCodexLedgerOwnedSeries(db, range, owner, context, apiOnly);
    expect(subset).toEqual(full.map(row => ({ ...row, group: { ...row.group, variants: { api_standard: row.group.variants.api_standard } } })));
  }
  const rows = readCodexLedgerOwnedSeries(db, { since: day, until: day }, owner, context, apiOnly);
  expect(rows.map(row => row.account)).toContain("a"); expect(rows.map(row => row.account)).toContain("b");
  expect(rows.map(row => row.account)).toContain("codex-unassigned::business");
}));

test("API projection keeps whole-range copy choice before project admission and supports the token reader", () => fixture([
  { home: "/local/.codex", project: "wanted" }, { project: "other" }, { project: "other", model: "absent" },
], (db, context, card) => {
  const owner = buildAccountResolver([period(day,"2026-09-02","owner")]);
  const full = readCodexLedgerOwnedSeries(db, {}, owner, context);
  const subset = readCodexLedgerOwnedSeries(db, {}, owner, context, apiOnly);
  expect(subset).toEqual(full.map(row => ({ ...row, group: { ...row.group, variants: { api_standard: row.group.variants.api_standard } } })));
  const ctx = { sqlite: db, rateCards: card, homeToSubId: new Map([["/local/.codex", "owner"]]) };
  expect(apiCodexLedgerRows(ctx, {}, new URL("http://local/api/summary?project_id=wanted"), owner)).toEqual([]);
  const projected = subset.find(row => row.group.stored.model === "model" && row.group.selected)!.group;
  expect(apiCodexTokenReader(ctx)(projected)).not.toBeNull();
}));
