import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareGlobalFixture } from "./global-usage.fixture";
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { buildEraIndex, type EraDeclaration } from "./eras";
import { fillUsageLedger, ledgerDays } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { buildGlobalUsage } from "./global-usage";
import type { GlobalUsageResponse } from "../shared/global-usage";
import type { RateCard } from "./pricing";

/**
 * WP4f: global usage reads its subscription sources from the usage ledger's day rows, including
 * the traffic no declared account owns. The day rows have to give the same answer however the
 * ledger was filled, which the first test proves against a fixture that carries both kinds of
 * traffic and both kinds of exclusion.
 */

const DECLARATIONS: EraDeclaration[] = [
  { id: "sub-a", vendor: "claude", home: "pc", from: "2025-01-01" },
  { id: "sub-a", vendor: "claude", home: "pc2", from: "2025-01-01" },
  { id: "plan-glm", vendor: "glm", home: "oc-main", from: "2025-01-01" },
  { id: "plan-gem", vendor: "gemini", home: "gem-main", from: "2025-01-01" },
];
const RANGE = { since: "2026-09-01", until: "2026-09-05" };
const VENDORS = ["claude", "opencode", "gemini"] as const;
const PROVIDERS = ["claude", "glm", "gemini"] as const;

const card = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  anthropic: { source: "fixture", models: {
    "claude-sonnet-4": { in_uncached: 3, in_cache_read: 0.3, in_cache_write: 3.75,
      in_cache_write_5m: 3.75, in_cache_write_1h: 6, out_total: 15 } } },
  zai: { source: "fixture", models: {
    "glm-4": { in_uncached: 0.6, in_cache_read: 0.11, in_cache_write: 0.6, out_total: 2.2 } } },
  // Only the family key is configured. Google is priced by the recorded model in a provider
  // report and by the configured family in global usage, which is the divergence `api_global`
  // exists for; the same row's Claude-family models are priced under Anthropic there.
  google: { source: "fixture", models: {
    "gemini-2.5": { in_uncached: 1.25, in_cache_read: 0.31, in_cache_write: 1.25, out_total: 10 } } },
} } as unknown as RateCard;

interface ClaudeRow { store: string; call: string; ts: string; model: string; subscription: string | null;
  conflict?: 1; in_uncached?: number; out_total?: number; id?: number }
interface OcRow { store: string; message: string; ts: string; model: string; provider: string;
  in_tok?: number; out_tok?: number }

const CLAUDE_ROWS: ClaudeRow[] = [
  // Declared account, and a second store of the same subscription: one identity, two copies.
  { store: "pc", call: "c1", ts: "2026-09-01T01:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  { store: "pc2", call: "c1", ts: "2026-09-01T01:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  // Copies of one identity that disagree on their usage: neither is accepted.
  { store: "pc", call: "c2", ts: "2026-09-02T02:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  { store: "pc2", call: "c2", ts: "2026-09-02T02:00:00Z", model: "claude-sonnet-4", subscription: "sub-a",
    in_uncached: 999 },
  { store: "pc", call: "c3", ts: "2026-09-03T03:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  // Copies of one identity that disagree *and* fall on different days. The register rejects the
  // identity over the whole history, so a query over either day alone must still call it a
  // conflict rather than an ordinary duplicate.
  { store: "pc", call: "c4", ts: "2026-09-01T18:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  { store: "pc2", call: "c4", ts: "2026-09-04T18:00:00Z", model: "claude-sonnet-4", subscription: "sub-a" },
  // No subscription evidence at all: unassigned traffic, which no fact index ever sees.
  { store: "loose", call: "u1", ts: "2026-09-01T04:00:00Z", model: "claude-sonnet-4", subscription: null },
  { store: "loose", call: "u2", ts: "2026-09-04T05:00:00Z", model: "claude-opus-4", subscription: null },
  // Conflicting subscription evidence: recorded traffic, reported as a conflict, owned by none.
  { store: "pc", call: "u3", ts: "2026-09-02T06:00:00Z", model: "claude-sonnet-4", subscription: "sub-a", conflict: 1 },
  // A subscription nothing has prepared a fact index for; still recorded traffic.
  { store: "spare", call: "u4", ts: "2026-09-03T07:00:00Z", model: "claude-sonnet-4", subscription: "sub-z" },
  // Two groups at one instant, whose row ids order differently as text ("10" < "2") and as
  // numbers (2 < 10). The per-event path scans a rowid table, so its tie is the numeric one.
  { store: "loose", call: "t1", ts: "2026-09-05T20:00:00Z", model: "tie-model-a", subscription: null, id: 2 },
  { store: "loose", call: "t2", ts: "2026-09-05T20:00:00Z", model: "tie-model-z", subscription: null, id: 10 },
];
const OC_ROWS: OcRow[] = [
  { store: "oc-main", message: "g1", ts: "2026-09-01T08:00:00Z", model: "glm-4", provider: "zai-coding-plan" },
  { store: "oc-main", message: "g2", ts: "2026-09-02T09:00:00Z", model: "glm-4.6", provider: "zai-coding-plan" },
  // OpenCode vendors outside the GLM plan: the register's scope covers every provider the
  // table names, not only the one the subscription report is about.
  { store: "oc-main", message: "a1", ts: "2026-09-03T10:00:00Z", model: "claude-sonnet-4", provider: "anthropic" },
  { store: "oc-side", message: "a2", ts: "2026-09-04T11:00:00Z", model: "claude-sonnet-4", provider: "anthropic" },
  { store: "oc-side", message: "x1", ts: "2026-09-05T12:00:00Z", model: "mystery-1", provider: "some-vendor" },
];
interface GeminiRow { store: string; conversation: string; gen: number; ts: string; model: string; basis?: string }
const GEMINI_ROWS: GeminiRow[] = [
  // Declared account. The recorded model only extends the configured family, so the report's
  // valuation and global usage's disagree, and the register has to carry both.
  { store: "gem-main", conversation: "k1", gen: 1, ts: "2026-09-01T14:00:00Z", model: "gemini-2.5-pro" },
  { store: "gem-main", conversation: "k1", gen: 2, ts: "2026-09-02T15:00:00Z", model: "gemini-2.5" },
  // A Claude-family model on a Gemini seat: global usage reports and prices it under Anthropic.
  { store: "gem-main", conversation: "k2", gen: 1, ts: "2026-09-03T16:00:00Z", model: "claude-sonnet-4" },
  // Undeclared store, and an approximate instant, which the response counts separately.
  { store: "gem-loose", conversation: "k3", gen: 1, ts: "2026-09-04T17:00:00Z", model: "gemini-2.5", basis: "file" },
];

function seed(db: Database): void {
  const claude = db.prepare(`INSERT INTO claude_events(id,store,call_id,path,ts,model,speed,subscription_id,
    subscription_conflict,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking)
    VALUES(?,?,?,?,?,?,'standard',?,?,?,200,100,100,0,?,10)`);
  // Explicit ids: two of the rows exist to pin a tie that only their ids decide.
  let nextId = 100;
  for (const row of CLAUDE_ROWS)
    claude.run(row.id ?? nextId++, row.store, row.call, `${ARCHIVE_LOGICAL_ROOT}/claude/${row.store}/${row.call}.jsonl`, row.ts, row.model,
      row.subscription, row.conflict ?? 0, row.in_uncached ?? 1000, row.out_total ?? 500);
  const oc = db.prepare(`INSERT INTO oc_events(store,message_id,session_id,ts,model,provider,
    in_tok,out_tok,reasoning,cache_read,cache_write,cost) VALUES(?,?,'s',?,?,?,?,?,7,50,25,0)`);
  for (const row of OC_ROWS)
    oc.run(row.store, row.message, row.ts, row.model, row.provider, row.in_tok ?? 800, row.out_tok ?? 400);
  const gemini = db.prepare(`INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,model,path,
    fresh_in,cached_in,out_total,out_thinking,out_visible,context_tokens,context_limit,usd)
    VALUES(?,?,?,?,?,?,?,900,300,600,40,560,0,0,0)`);
  for (const row of GEMINI_ROWS)
    gemini.run(row.store, row.conversation, row.gen, row.ts, row.basis ?? "event", row.model,
      `${ARCHIVE_LOGICAL_ROOT}/gemini/${row.store}/${row.conversation}.json`);
}

/** The ledgers in small batches, as the background producer advances them. */
function advance(db: Database): void {
  for (const provider of PROVIDERS) fillUsageLedger(db, provider, card, ARCHIVE_LOGICAL_ROOT, 20);
}

function fixture(withRegister: boolean, file = ":memory:"): Database {
  const db = new Database(file);
  applyDrizzleMigrations(drizzle(db));
  installAnalysisTracking(db);
  seed(db);
  const period=db.query("INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,readings,evidence) VALUES(?,?,?,'2025-01-01T00:00:00Z',NULL,'declared',0,'test')");
  for(const [provider,source,account] of [["claude","pc","sub-a"],["claude","pc2","sub-a"],["claude","spare","sub-z"],["glm","oc-main","plan-glm"],["gemini","gem-main","plan-gem"]])period.run(provider!,`${provider}/${source}`,account!);
  if (withRegister) advance(db);
  return db;
}

const usage = (db: Database, range = RANGE): GlobalUsageResponse => buildGlobalUsage(
  { sqlite: db, rateCards: card, homeToSubId: indexSubscriptionHomes(DECLARATIONS), eras: buildEraIndex(DECLARATIONS) },
  { ...range, vendors: [...VENDORS] });

const dayRows = (db: Database) => Object.fromEntries(PROVIDERS.map(provider => [provider, ledgerDays(db, provider)]));

test("global usage remains equal across batch sizes for declared and unassigned traffic", () => {
  const legacy = fixture(false), registered = fixture(true);
  try {
    prepareGlobalFixture(legacy,card,[],10000);
    const before = usage(legacy);
    // The registered answer has to come from the ledger's day rows, or the equality proves nothing.
    const query = registered.query.bind(registered), seen: string[] = [];
    const spy = spyOn(registered, "query")
      .mockImplementation(((sql: string) => { seen.push(sql); return query(sql); }) as typeof registered.query);
    let after: GlobalUsageResponse;
    try { after = usage(registered); } finally { spy.mockRestore(); }
    expect(seen.some(sql => /FROM (claude_events|oc_events) e\b/i.test(sql))).toBe(false);
    expect(seen.some(sql => /FROM usage_ledger_days\b/i.test(sql))).toBe(true);
    // The fixture has to exercise what this package is about, or the equality proves nothing.
    expect({
      unassigned: before.rows.some(row => row.account === null),
      foreignVendor: before.rows.some(row => row.source === "opencode" && row.provider === "anthropic"),
      unknownVendor: before.rows.some(row => row.provider === "some-vendor"),
      unpreparedAccount: before.rows.some(row => row.account === "sub-z"),
      excluded: before.excluded_duplicates,
      conflicting: before.conflicting_events,
      // `glm-4` is configured, `glm-4.6` only extends it, and global usage prices by the
      // configured family rather than the model, which is why the register keeps its own variant.
      zaiPriced: before.rows.some(row => row.provider === "zai" && row.api_usd.priced_calls > 0),
      // A Gemini seat's Claude-family model is reported and priced under Anthropic here, while
      // the provider report prices the same event under Google: the divergence `api_global` holds.
      geminiUnderAnthropic: before.rows.some(row => row.source === "gemini" && row.provider === "anthropic"),
      approximate: before.approximate_time_events,
      // Two groups at one instant: the per-event scan reads a rowid table, so its order is the
      // numeric one (id 2 before id 10) and not the text one ("10" before "2").
      tie: before.rows.filter(row => row.model?.startsWith("tie-model-")).map(row => row.model),
    }).toEqual({ unassigned: true, foreignVendor: true, unknownVendor: true, unpreparedAccount: true,
      excluded: 3, conflicting: 3, zaiPriced: true, geminiUnderAnthropic: true, approximate: 1,
      tie: ["tie-model-a", "tie-model-z"] });
    // ...and the register reproduces that order, which a text comparison of the same keys would not.
    expect(after.rows.filter(row => row.model?.startsWith("tie-model-")).map(row => row.model))
      .toEqual(["tie-model-a", "tie-model-z"]);
    expect({ rows: after.rows.length, sources: after.sources, excluded: after.excluded_duplicates,
      conflicting: after.conflicting_events, approximate: after.approximate_time_events })
      .toEqual({ rows: before.rows.length, sources: before.sources, excluded: before.excluded_duplicates,
        conflicting: before.conflicting_events, approximate: before.approximate_time_events });
    for (const [index, row] of after.rows.entries()) {
      const expected = before.rows[index]!;
      expect({ index, ...row, api_usd: null }).toEqual({ index, ...expected, api_usd: null });
      expect({ index, priced: row.api_usd.priced_calls, unpriced: row.api_usd.unpriced_calls })
        .toEqual({ index, priced: expected.api_usd.priced_calls, unpriced: expected.api_usd.unpriced_calls });
      // Exact decimal sums round differently from a running double, and no further.
      expect(Math.abs(row.api_usd.subtotal - expected.api_usd.subtotal))
        .toBeLessThanOrEqual(Math.max(1e-9, Math.abs(expected.api_usd.subtotal) * 1e-9));
    }
  } finally { legacy.close(); registered.close(); }
});

test("one event carries both valuations when the report and global usage price it differently", () => {
  const db = fixture(true);
  try {
    const days = [...ledgerDays(db, "gemini").entries()].filter(([key]) => {
      const [day, , , model] = JSON.parse(key) as Array<string | null>;
      return day === "2026-09-01" && model === "gemini-2.5-pro";
    });
    expect(days).toHaveLength(1);
    const [key, row] = days[0]!;
    // A contribution the Gemini report owns, so it carries no vendor dimension.
    expect((JSON.parse(key) as Array<string | null>)[6]).toBeNull();
    // The report prices by the recorded model, which this card does not configure.
    expect(row.variants.api_actual).toMatchObject({ pricedEvents: 0 });
    // Global usage prices by the configured family, which it does.
    expect(row.variants.api_global).toMatchObject({ pricedEvents: 1 });
    expect(Number(row.variants.api_global!.pricedSubtotal)).toBeGreaterThan(0);
    // Unassigned traffic carries the vendor global usage reports it under, and nothing else.
    const unassigned = db.query(`SELECT DISTINCT m.vendor,m.identity FROM usage_ledger_days d
      JOIN usage_ledger_dims m ON m.id=d.dim_id
      WHERE d.provider='glm' AND m.vendor IS NOT NULL ORDER BY m.vendor`).all();
    expect(unassigned).toEqual([{ vendor: "anthropic", identity: null }, { vendor: "some-vendor", identity: null }]);
  } finally { db.close(); }
});

test("a conflicted identity reports the same reason for every range that covers it", () => {
  const db = fixture(true);
  try {
    // `c4` is one identity whose two copies disagree and fall on 09-01 and 09-04. The register
    // rejects it over the whole history by design (range-independent, §2.3 A and D), so each of
    // its copies is excluded *because of the conflict* - on either day, not only the earlier one.
    const earliest = usage(db, { since: "2026-09-01", until: "2026-09-01" });
    const latest = usage(db, { since: "2026-09-04", until: "2026-09-04" });
    for (const [label, report] of [["earliest", earliest], ["latest", latest]] as const)
      expect({ label, conflicting: report.conflicting_events > 0,
        // Its copy on this day must not be reported as a plain duplicate exclusion.
        c4Excluded: report.excluded_duplicates })
        .toEqual({ label, conflicting: true, c4Excluded: label === "earliest" ? 1 : 0 });
    // Neither day reports the rejected identity as traffic.
    for (const report of [earliest, latest])
      expect(report.rows.some(row => row.source === "claude" && row.calls === 0)).toBe(false);
  } finally { db.close(); }
});

test("an unpublished register states its preparation even when the report has no versioned mapping", () => {
  const db = fixture(true);
  try {
    db.query("UPDATE usage_ledger_state SET covered=-1,status='pending',published_revision=0 WHERE provider='claude'").run();
    // No era index, but a declared home mapping: readiness owns the answer, and a scope that
    // exists and is behind must never be answered from the per-event path.
    const withoutEras = () => buildGlobalUsage(
      { sqlite: db, rateCards: card, homeToSubId: indexSubscriptionHomes(DECLARATIONS) },
      { ...RANGE, vendors: ["claude"] });
    expect(withoutEras).toThrow(SubscriptionFactsPending);
  } finally { db.close(); }
});

test("an incremental correction leaves the register a full rebuild would produce", () => {
  const db = fixture(true), reference = fixture(false);
  try {
    const mutate = (target: Database) => {
      // An insert, a correction of recorded facts, and a deletion - on both tracks.
      target.exec(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,subscription_id,
        subscription_conflict,in_uncached,in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking)
        VALUES('loose','u9','loose/u9.jsonl','2026-09-05T13:00:00Z','claude-sonnet-4','standard',NULL,0,4000,0,0,0,0,900,0)`);
      target.exec("UPDATE claude_events SET in_uncached=7777 WHERE store='loose' AND call_id='u1'");
      target.exec("UPDATE oc_events SET out_tok=12345 WHERE store='oc-side' AND message_id='a2'");
      target.exec("DELETE FROM claude_events WHERE store='pc' AND call_id='c3'");
      target.exec("DELETE FROM oc_events WHERE store='oc-main' AND message_id='g2'");
    };
    mutate(db); mutate(reference);
    advance(db); advance(reference);
    expect(dayRows(db)).toEqual(dayRows(reference));
    expect(usage(db).rows).toEqual(usage(reference).rows);
  } finally { db.close(); reference.close(); }
});

test("a restart without source changes revalues nothing and writes no new valuation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp4f-unassigned-"));
  const file = path.join(dir, "atlas.sqlite");
  let db = fixture(true, file);
  try {
    const facts = () => db.query(`SELECT provider,row_id,copy_state,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,glb_usd,glb_nano,glb_femto
      FROM usage_ledger_facts ORDER BY provider,row_id`).all();
    const revisions = () => PROVIDERS.map(provider => usageLedgerState(db, provider)?.revision);
    const valuations = facts(), revision = revisions();
    expect(valuations.length).toBeGreaterThan(0);
    const before = dayRows(db);
    db.close(); db = new Database(file);
    for (const provider of PROVIDERS)
      expect(stepUsageLedger(db, provider, card, ARCHIVE_LOGICAL_ROOT, 50)).toEqual({ complete: true, processed: 0 });
    expect(facts()).toEqual(valuations);
    expect(revisions()).toEqual(revision);
    expect(dayRows(db)).toEqual(before);
  } finally {
    db.close();
    Bun.gc(true);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a subscription register that was never published states its preparation instead of scanning events", () => {
  const db = fixture(true);
  try {
    expect(usage(db).rows.length).toBeGreaterThan(0);
    // A published ledger behind its source answers from its rows; one never published states its preparation.
    db.query("UPDATE usage_ledger_state SET covered=-1,status='pending' WHERE provider='claude'").run();
    expect(usage(db).rows.length).toBeGreaterThan(0);
    db.query("UPDATE usage_ledger_state SET published_revision=0 WHERE provider='claude'").run();
    const query = db.query.bind(db), seen: string[] = [];
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => { seen.push(sql); return query(sql); }) as typeof db.query);
    try { expect(() => usage(db)).toThrow(SubscriptionFactsPending); } finally { spy.mockRestore(); }
    // No per-event pass: the answer is a state, not a slower report.
    expect(seen.some(sql => /FROM claude_events e/i.test(sql))).toBe(false);
    // A database the ledger never ran on states its preparation too.
    const legacy = fixture(false);
    try { expect(() => usage(legacy)).toThrow(SubscriptionFactsPending); } finally { legacy.close(); }
  } finally { db.close(); }
});
