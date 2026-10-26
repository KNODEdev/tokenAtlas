import { codexLedgerFactsPending } from "./read-freshness";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, metadataColumns, requireCodexLedgerReady, readCodexLedgerBucketGroups, withPlaceProjects } from "./codex-price-ledger";
import { overrideProjectRules } from "../projects/resolve";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty, processCodexLedgerBatch,
  readCodexLedgerProducerProgress, type LedgerProducerOptions } from "./codex-ledger-producer";
import { codexLedgerFillState } from "./codex-ledger-fill";
import { codexLedgerQueuedRuleScopes } from "./codex-ledger-state";
import { ledgerCopyAnchorFromArchive, type LedgerCopyAnchor } from "./codex-ledger-copies";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { readCodexLedgerSeries } from "./codex-price-ledger-read";
import { ensureCodexSchema, syncCodex } from "../ingest/codex";
import { bindCanonicalArchiveRoot } from "../config/archive-paths";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const home = "archive", filePath = "archive/sessions/a.jsonl";
const anchorOf = (_home: string | null, file: string): LedgerCopyAnchor =>
  ({ archiveId: "archive-id", sourceId: "codex/pc/profile", relativePath: file.replace(/^archive\//, "codex/") });
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
const policy = (): CodexLedgerPolicy => ({ version: 1, tiers: ["standard", "fast"],
  mappings: [{ id: "default", raw_value: "default", tier: "standard" }, { id: "priority", raw_value: "priority", tier: "fast" }],
  base_rules: [
    { id: "api", model: "m", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "1.875", in_cache_read: "0.125", out_total: "1.7999999999999998" }, ...provenance },
    { id: "credits", model: "m", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "125", in_cache_read: "12.5", out_total: "1250" }, ...provenance },
  ], tier_rules: [
    { id: "api-standard", model: "m", billing_basis: "api_equivalent_usd", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
    { id: "api-fast", model: "m", billing_basis: "api_equivalent_usd", tier: "fast", valid_from: "2026-01-01", multiplier: "2", ...provenance },
    { id: "credit-standard", model: "m", billing_basis: "chatgpt_credits", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
    { id: "credit-fast", model: "m", billing_basis: "chatgpt_credits", tier: "fast", valid_from: "2026-01-01", multiplier: "2.5", ...provenance },
  ] });
interface Input { response: string | null; ts: string; input: number; output: number; tier?: string | null; subject?: string | null; model?: string; cached?: number; usage?: string }
const event = (response: string | null, change: Partial<Input> = {}): Input => ({ response, ts: "2026-04-01T12:00:00Z", input: 10, output: 3, ...change });
function fixture(run: (f: ReturnType<typeof createFixture>) => void) {
  const f = createFixture(); try { run(f); } finally { f.db.close(); }
}
function createFixture(databasePath = ":memory:") {
  const db = new Database(databasePath);
  createCodexLedgerSchema(db);
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,cache_write ANY,out_tok ANY,
    reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,
    response_id TEXT,UNIQUE(home,path,source_offset)) STRICT`);
  let config = policy();
  const options = (): LedgerProducerOptions => {
    const compiled = compileCodexLedgerPolicy(config);
    return { bands: compiled.baseBands, policy: config, factsRevision: 0, rulesRevision: sha(JSON.stringify(config)), anchorOf, batchSize: 2 };
  };
  /** Replaces one file's calls (offsets 0, 100, ...), as a publication does, and names the copy changed. */
  const publish = (inputs: Input[], { file = filePath, notify = true } = {}) => db.transaction(() => {
    db.query("DELETE FROM events WHERE home=? AND path=?").run(home, file);
    inputs.forEach((input, index) => db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,'missing',?,'standard',?,'allowance',NULL,NULL,'plus',0,?)")
      .run(home, file, index * 100, input.model ?? "m", input.ts, input.input, input.cached ?? 2, 0, input.output, 1, input.usage ?? "valid",
        input.tier ?? "default", input.subject ?? null, input.response));
    if (notify) markCodexLedgerCopiesDirty(db, [{ home, path: file }]);
  }).immediate();
  const drain = (changes: Partial<LedgerProducerOptions> = {}) => {
    let processed = 0, repricedApi = 0, repricedCredits = 0, aggregatePartitions = 0;
    for (let step = 0; step < 200; step++) {
      const result = processCodexLedgerBatch(db, { ...options(), ...changes });
      processed += result.processed; repricedApi += result.repricedApi; repricedCredits += result.repricedCredits; aggregatePartitions += result.aggregatePartitions;
      if (result.ready || !result.progressed) return { ...result, processed, repricedApi, repricedCredits, aggregatePartitions };
    }
    throw new Error("Producer did not complete bounded test queue");
  };
  const snapshot = () => db.query(`SELECT id,source_offset,day,dim_id,identity,copy_state,api_band,credit_band,
    CAST(api_whole AS TEXT) api_whole,CAST(api_fraction_hi AS TEXT) api_fraction_hi,CAST(api_fraction_lo AS TEXT) api_fraction_lo,
    CAST(credit_whole AS TEXT) credit_whole,CAST(credit_fraction_hi AS TEXT) credit_fraction_hi,CAST(credit_fraction_lo AS TEXT) credit_fraction_lo
    FROM codex_price_ledger_events ORDER BY id`).all();
  /** The empty ledger is filled from the published calls; nothing is queued per file. */
  const bootstrap = (inputs: Input[]) => {
    publish(inputs, { notify: false });
    enqueueCodexLedgerRuleChanges(db, options()); return drain();
  };
  return { db, publish, options, drain, snapshot, bootstrap, config: () => config, setConfig: (value: CodexLedgerPolicy) => { config = value; } };
}
/** The stored result keyed by source location, independent of row ids: calls, their resolution and values, and the sums. */
function ledgerContent(db: Database) {
  return {
    calls: db.query(`SELECT c.identity copy,e.source_offset,d.key dim,e.day,e.instant_ms,e.identity,e.copy_state,e.reported,e.invalid_tokens,
      e.common_reason,e.api_reason,e.credit_reason,CAST(e.api_whole AS TEXT) api_whole,CAST(e.api_fraction_hi AS TEXT) api_hi,
      CAST(e.api_fraction_lo AS TEXT) api_lo,CAST(e.credit_whole AS TEXT) credit_whole,CAST(e.credit_fraction_lo AS TEXT) credit_lo
      FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id JOIN codex_price_ledger_dims d ON d.id=e.dim_id
      ORDER BY c.identity,e.source_offset`).all(),
    sums: db.query(`SELECT a.grain,a.day,a.hour,d.key dim,a.copy_state,a.api_reason,a.credit_reason,a.calls,a.reported,
      CAST(a.api_whole_lo AS TEXT) api,CAST(a.api_fraction_hi AS TEXT) api_hi,CAST(a.credit_whole_lo AS TEXT) credits
      FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
      ORDER BY a.grain,a.day,a.hour,d.key,a.copy_state,a.api_reason,a.credit_reason`).all(),
  };
}

test("a fill from empty writes in short resumable steps and publishes when every queue is empty", () => fixture(f => {
  f.publish([event("a"), event("b")], { notify: false });
  f.publish([event("c"), event(null, { ts: "2026-04-02T08:00:00Z" })], { file: "archive/sessions/b.jsonl", notify: false });
  f.publish([event("d", { usage: "invalid" })], { file: "archive/sessions/c.jsonl", notify: false });
  enqueueCodexLedgerRuleChanges(f.db, f.options());
  const first = processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
  expect(first.ready).toBe(false); expect(codexLedgerFillState(f.db)?.phase).toBe("events");
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_copies").get()).toEqual({ n: 3 });
  expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')").get()).toEqual({ n: 0 });
  expect(() => requireCodexLedgerReady(f.db)).toThrow();
  expect(f.drain().ready).toBe(true);
  expect(codexLedgerFillState(f.db)).toBeNull();
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE copy_state='canonical'").get()).toEqual({ n: 5 });
  expect(f.db.query("SELECT identity FROM codex_price_ledger_events WHERE source_offset=100 ORDER BY copy_id").all())
    .toEqual([{ identity: "r:b" }, { identity: "o:codex/pc/profile|b.jsonl|100" }]);
  expect(f.db.query("SELECT invalid_tokens,common_reason FROM codex_price_ledger_events WHERE identity='r:d'").get())
    .toEqual({ invalid_tokens: 1, common_reason: "invalid_tokens" });
  expect(f.db.query("SELECT day,SUM(calls) calls FROM codex_price_ledger_aggregates WHERE grain='day' GROUP BY day ORDER BY day").all())
    .toEqual([{ day: "2026-04-01", calls: 4 }, { day: "2026-04-02", calls: 1 }]);
}));

test("a fill equals the same calls published copy by copy, including copies of one conversation", () => {
  const files: Array<[string, Input[]]> = [
    ["archive/sessions/a.jsonl", [event("a"), event("b", { ts: "2026-04-02T01:00:00+02:00" }), event(null, { input: 40, cached: 50 })]],
    // A shorter copy of the same conversation (same file name): its calls are duplicates of the longer copy's.
    ["archive/backup/a.jsonl", [event("a"), event("b", { ts: "2026-04-02T01:00:00+02:00" })]],
    ["archive/sessions/c.jsonl", [event("b", { ts: "2026-04-02T01:00:00+02:00" }), event("e", { tier: "priority", ts: "2026-05-01T00:00:00Z" }),
      event(null, { usage: "incomplete" })]],
  ];
  let filled: ReturnType<typeof ledgerContent> | undefined;
  fixture(f => {
    for (const [file, inputs] of files) f.publish(inputs, { file, notify: false });
    enqueueCodexLedgerRuleChanges(f.db, f.options());
    expect(f.drain({ batchSize: 1 }).ready).toBe(true);
    filled = ledgerContent(f.db);
  });
  fixture(f => {
    f.bootstrap([]);
    for (const [file, inputs] of files) { f.publish(inputs, { file }); expect(f.drain().ready).toBe(true); }
    expect(ledgerContent(f.db)).toEqual(filled!);
  });
  expect(filled!.calls.filter(call => (call as { copy_state: string }).copy_state === "duplicate")).toHaveLength(3);
});

test("a stopped fill resumes after reopening a durable database with the uninterrupted result", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "tokenatlas-ledger-fill-")), databasePath = path.join(folder, "ledger.sqlite");
  const inputs = [event("a"), event("b"), event("c", { ts: "2026-04-03T00:00:00Z" })];
  let expected: ReturnType<typeof ledgerContent> | undefined;
  fixture(f => { f.bootstrap(inputs); expected = ledgerContent(f.db); });
  const f = createFixture(databasePath);
  let reopened: Database | null = null, closed = false;
  try {
    f.publish(inputs, { notify: false }); f.publish(inputs, { file: "archive/sessions/b.jsonl", notify: false });
    enqueueCodexLedgerRuleChanges(f.db, f.options());
    processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 }); processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
    expect(codexLedgerFillState(f.db)).not.toBeNull();
    f.db.close(); closed = true;
    reopened = new Database(databasePath);
    for (let step = 0; step < 100 && !processCodexLedgerBatch(reopened, f.options()).ready; step++);
    expect(readCodexLedgerProducerProgress(reopened).ready).toBe(true);
    const content = ledgerContent(reopened);
    expect(content.calls.filter(call => (call as { copy: string }).copy.endsWith("sessions/a.jsonl"))
      .map(call => ({ ...call as object, copy: undefined }))).toEqual(expected!.calls.map(call => ({ ...call as object, copy: undefined })));
  } finally {
    reopened?.close(); if (!closed) f.db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a prepared worker cannot consume newer rule work with its earlier coefficients", () => fixture(f => {
  f.bootstrap([event("a"), event("b")]);
  const stale = f.options(), before = f.snapshot();
  const changed = structuredClone(f.config());
  changed.base_rules.find(rule => rule.id === "api")!.rates.out_total = "99";
  f.setConfig(changed);
  enqueueCodexLedgerRuleChanges(f.db, f.options());
  expect(() => processCodexLedgerBatch(f.db, stale)).toThrow("policy");
  expect(f.snapshot()).toEqual(before);
  expect(f.drain().ready).toBe(true);
  const repriced = f.snapshot() as { api_whole: string }[];
  expect(repriced[0]!.api_whole).not.toBe((before as { api_whole: string }[])[0]!.api_whole);
}));

test("changed copies are written one per step, each with its own durable checkpoint", () => fixture(f => {
  f.bootstrap([event("a")]);
  f.publish([event("b")], { file: "archive/sessions/b.jsonl" }); f.publish([event("c")], { file: "archive/sessions/c.jsonl" });
  const first = processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
  expect(first.processed).toBe(1); expect(first.ready).toBe(false);
  expect(f.db.query("SELECT kind,value FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked') ORDER BY value").all())
    .toEqual([{ kind: "copy", value: JSON.stringify([home, "archive/sessions/c.jsonl"]) }]);
  expect(f.drain().ready).toBe(true);
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_copies").get()).toEqual({ n: 3 });
  // The next item of a kind is read from the queue's primary key, without sorting.
  const plan = f.db.query("EXPLAIN QUERY PLAN SELECT value FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy' ORDER BY value LIMIT 1")
    .all() as { detail: string }[];
  expect(plan.some(row => row.detail.includes("sqlite_autoindex_usage_ledger_dirty_1"))).toBe(true);
  expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
}));

test("D+30 append writes only the addition and leaves historical rows and sums intact", () => fixture(f => {
  const original = [event("a"), event("b")]; f.bootstrap(original);
  const before = f.snapshot();
  f.db.exec("CREATE TRIGGER protect_history BEFORE DELETE ON codex_price_ledger_aggregates WHEN OLD.day='2026-04-01' BEGIN SELECT RAISE(ABORT,'historical partition touched'); END");
  f.db.exec("CREATE TRIGGER protect_rows BEFORE UPDATE ON codex_price_ledger_events WHEN OLD.day='2026-04-01' BEGIN SELECT RAISE(ABORT,'historical row touched'); END");
  f.publish([...original, event("c", { ts: "2026-05-01T17:15:00Z" })]);
  const result = f.drain(); expect(result.ready).toBe(true);
  expect(result.aggregatePartitions).toBe(2); expect(f.snapshot().slice(0, 2)).toEqual(before);
  expect(f.db.query("SELECT api_reason,credit_reason,api_whole IS NOT NULL valued FROM codex_price_ledger_events WHERE day='2026-05-01'").get())
    .toEqual({ api_reason: null, credit_reason: null, valued: 1 });
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_aggregates WHERE grain='day'").get()).toEqual({ n: 2 });
}));

test("a corrected call keeps its row and identity and updates its old and new day", () => fixture(f => {
  f.bootstrap([event("a"), event("b")]); const before = f.snapshot() as Record<string, unknown>[];
  f.publish([event("a", { ts: "2026-03-01T04:30:00Z", input: 31 }), event("b")]);
  const result = f.drain(); expect(result.ready).toBe(true); expect(result.aggregatePartitions).toBe(4);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[0]!.identity).toBe(before[0]!.identity); expect(after[0]!.id).toBe(before[0]!.id);
  expect(after[0]!.api_whole).not.toBe(before[0]!.api_whole);
  expect(after[1]).toEqual(before[1]);
  expect(f.db.query("SELECT day,SUM(calls) calls FROM codex_price_ledger_aggregates WHERE grain='day' GROUP BY day ORDER BY day").all())
    .toEqual([{ day: "2026-03-01", calls: 1 }, { day: "2026-04-01", calls: 1 }]);
}));

test("a vanished call is removed with its sums; a copy without an archive binding waits and keeps accepted history", () => fixture(f => {
  f.bootstrap([event("a"), event("b", { ts: "2026-04-02T12:00:00Z" })]); const before = f.snapshot();
  f.publish([event("a")]); expect(f.drain().ready).toBe(true);
  expect(f.snapshot()).toEqual(before.slice(0, 1));
  expect(f.db.query("SELECT day FROM codex_price_ledger_aggregates WHERE grain='day'").all()).toEqual([{ day: "2026-04-01" }]);
  f.publish([event("x")], { file: "archive/unbound/x.jsonl" });
  const unbound = { anchorOf: (owner: string | null, file: string) => file.includes("unbound") ? null : anchorOf(owner, file) };
  const blocked = f.drain(unbound);
  expect(blocked.ready).toBe(false); expect(blocked.blockedTotal).toBe(1);
  expect(blocked.blocked).toEqual([{ home, path: "archive/unbound/x.jsonl", reason: expect.stringContaining("archive/source binding") }]);
  expect(f.snapshot()).toEqual(before.slice(0, 1));
  f.db.transaction(() => markCodexLedgerCopiesDirty(f.db, [{ home, path: "archive/unbound/x.jsonl" }])).immediate();
  expect(f.drain().ready).toBe(true);
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_events").get()).toEqual({ n: 2 });
}));

test("metadata corrections keep both values and tier policy edits reprice nothing", () => fixture(f => {
  f.bootstrap([event("a")]); const before = f.snapshot() as Record<string, unknown>[];
  f.publish([event("a", { tier: "priority", subject: "project" })]);
  expect(f.drain().ready).toBe(true);
  const after = f.snapshot() as Record<string, unknown>[];
  for (const key of ["api_whole", "api_fraction_hi", "api_fraction_lo", "credit_whole", "credit_fraction_hi", "credit_fraction_lo"]) expect(after[0]![key]).toEqual(before[0]![key]);
  expect(after[0]!.dim_id).not.toBe(before[0]!.dim_id);
  const config = f.config(); config.tier_rules[3]!.multiplier = "2.50000000000000000000000000001";
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(0);
  const changedTier = f.drain(); expect(changedTier.repricedApi).toBe(0); expect(changedTier.repricedCredits).toBe(0);
  expect(f.snapshot()).toEqual(after);
  const published = f.db.query("SELECT rules_json FROM usage_ledger_state WHERE provider='codex'").get() as { rules_json: string };
  expect(JSON.parse(published.rules_json).tier_rules[3].multiplier).toBe(config.tier_rules[3]!.multiplier);
}));

test("changed base revisions are immutable and touch only affected model/basis/date rows", () => fixture(f => {
  f.bootstrap([event("a"), event("b", { model: "other" })]); const before = f.snapshot() as Record<string, unknown>[];
  const config = f.config(); config.base_rules[0]!.rates.out_total = "1.75";
  enqueueCodexLedgerRuleChanges(f.db, f.options()); const result = f.drain();
  expect(result.repricedApi).toBe(1); expect(result.repricedCredits).toBe(0);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[1]).toEqual(before[1]); expect(after[0]!.credit_band).toBe(before[0]!.credit_band);
  expect(after[0]!.api_band).not.toBe(before[0]!.api_band);
  expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_bands WHERE rule_id='api'").get()).toEqual({ n: 2 });
  config.base_rules[0]!.rates.out_total = "1.750";
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(0); expect(f.drain().repricedApi).toBe(0);
}));

test("splitting a dated API base prices only the changed future interval once", () => fixture(f => {
  f.bootstrap([event("before"), event("after", { ts: "2026-10-01T12:00:00Z" })]);
  const before = f.snapshot() as Record<string, unknown>[];
  const config = structuredClone(f.config()), api = config.base_rules.find(rule => rule.id === "api")!;
  api.valid_until = "2026-10-01";
  config.base_rules.push({ ...structuredClone(api), id: "api-october", valid_from: "2026-10-01", valid_until: undefined,
    rates: { ...api.rates, out_total: "99" } });
  f.setConfig(config);
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(1);
  expect(codexLedgerQueuedRuleScopes(f.db).map(({ fromDay, untilDay, inputAbove, inputUntil }) => ({ fromDay, untilDay, inputAbove, inputUntil })))
    .toEqual([{ fromDay: "2026-10-01", untilDay: null, inputAbove: null, inputUntil: null }]);
  const changed = f.drain(); expect(changed.repricedApi).toBe(1); expect(changed.repricedCredits).toBe(0);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[0]).toEqual(before[0]); expect(after[1]!.api_band).not.toBe(before[1]!.api_band);
}));

test("a price change of one model from a date reprices exactly its events from that date and equals a full rebuild (U3.3)", () => {
  const events = [event("a"), event("b", { ts: "2026-10-01T12:00:00Z" }), event("c", { ts: "2026-10-02T12:00:00Z" }),
    event("d", { ts: "2026-10-02T13:00:00Z", model: "other" })];
  const priced = (f: ReturnType<typeof createFixture>) => f.db.query(`SELECT e.source_offset,CAST(e.api_whole AS TEXT) w,CAST(e.api_fraction_hi AS TEXT) h,
    CAST(e.api_fraction_lo AS TEXT) l,e.api_reason r,CAST(e.credit_whole AS TEXT) cw FROM codex_price_ledger_events e ORDER BY e.source_offset`).all();
  const sums = (f: ReturnType<typeof createFixture>) => f.db.query(`SELECT grain,day,hour,SUM(calls) calls,CAST(SUM(api_whole_hi) AS TEXT) hi,
    CAST(SUM(api_whole_lo) AS TEXT) lo,CAST(SUM(api_fraction_hi) AS TEXT) fh,CAST(SUM(api_fraction_lo) AS TEXT) fl FROM codex_price_ledger_aggregates
    GROUP BY grain,day,hour ORDER BY grain,day,hour`).all();
  const changed = (config: CodexLedgerPolicy) => {
    const next = structuredClone(config), api = next.base_rules.find(rule => rule.id === "api")!;
    api.valid_until = "2026-10-01";
    next.base_rules.push({ ...structuredClone(api), id: "api-october", valid_from: "2026-10-01", valid_until: undefined, rates: { ...api.rates, out_total: "7" } });
    return next;
  };
  let scopedPrices: unknown[] = [], scopedSums: unknown[] = [];
  fixture(f => {
    f.bootstrap(events);
    f.setConfig(changed(f.config()));
    enqueueCodexLedgerRuleChanges(f.db, f.options());
    const result = f.drain();
    // Events of model m on or after 2026-10-01: b and c; d is another model and a is before the date.
    expect(result.repricedApi).toBe(2); expect(result.repricedCredits).toBe(0);
    scopedPrices = priced(f); scopedSums = sums(f);
  });
  fixture(f => {
    f.setConfig(changed(f.config()));
    f.bootstrap(events);
    expect(priced(f)).toEqual(scopedPrices); expect(sums(f)).toEqual(scopedSums);
  });
});

test("equivalent IDs and provenance preserve every base and aggregate byte", () => fixture(f => {
  f.bootstrap([event("a"), event("b", { ts: "2026-10-01T12:00:00Z" })]);
  const before = f.snapshot(), aggregates = f.db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY rowid").all();
  const config = structuredClone(f.config()), api = config.base_rules.find(rule => rule.id === "api")!;
  api.id = "equivalent-id"; api.verified_at = "2026-10-01"; api.rates.in_uncached = "1.8750";
  f.setConfig(config);
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(0);
  const changed = f.drain(); expect(changed.repricedApi).toBe(0); expect(changed.aggregatePartitions).toBe(0);
  expect(f.snapshot()).toEqual(before);
  expect(f.db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY rowid").all()).toEqual(aggregates);
}));

test("a changed context threshold preserves bases outside the crossed token band", () => fixture(f => {
  const config = f.config();
  config.base_rules[0]!.long_context = { above_input_tokens: 10,
    rates: { in_uncached: "3.75", in_cache_read: "0.25", out_total: "3.5999999999999996" } };
  f.bootstrap([event("a", { input: 10 }), event("b", { input: 11 }), event("c", { input: 20 }), event("d", { input: 21 })]);
  const before = f.snapshot() as Record<string, unknown>[];
  config.base_rules[0]!.long_context.above_input_tokens = 20;
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(1);
  expect(codexLedgerQueuedRuleScopes(f.db).map(({ inputAbove, inputUntil }) => ({ inputAbove, inputUntil })))
    .toEqual([{ inputAbove: 10, inputUntil: 20 }]);
  const changed = f.drain(); expect(changed.repricedApi).toBe(2); expect(changed.repricedCredits).toBe(0);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[0]).toEqual(before[0]); expect(after[3]).toEqual(before[3]);
}));

test("a dated rate addition prices known unpriced history at zero without touching older missing history", () => fixture(f => {
  const config = f.config(), original = structuredClone(config.base_rules[0]!);
  config.base_rules = config.base_rules.filter(rule => rule.billing_basis !== "api_equivalent_usd");
  f.bootstrap([event("older"), event("newer", { ts: "2026-10-01T12:00:00Z" })]);
  const before = f.snapshot();
  config.base_rules.push({ ...original, valid_from: "2026-10-01", rates: { in_uncached: "0", in_cache_read: "0", out_total: "0" } });
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(1);
  expect(f.drain().repricedApi).toBe(1); expect(f.snapshot()[0]).toEqual(before[0]);
  expect(f.db.query("SELECT api_reason,api_whole FROM codex_price_ledger_events WHERE id=2").get()).toEqual({ api_reason: null, api_whole: 0 });
  config.base_rules = config.base_rules.filter(rule => rule.billing_basis !== "api_equivalent_usd");
  expect(enqueueCodexLedgerRuleChanges(f.db, f.options())).toBe(1);
  f.drain(); expect(f.snapshot()[0]).toEqual(before[0]);
  expect(f.db.query("SELECT api_reason,api_whole FROM codex_price_ledger_events WHERE id=2").get()).toEqual({ api_reason: "missing_rate", api_whole: null });
}));

test("actual Codex import completing an unaccepted tail keeps the accepted call and writes only the new one", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-producer-tail-")), sourceHome = path.join(directory, "codex");
  const source = path.join(sourceHome, "sessions", "synthetic.jsonl"), db = new Database(":memory:");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const header = line({ type: "session_meta", payload: { id: "session", originator: "codex-tui", thread_source: "user" } })
    + line({ type: "turn_context", payload: { model: "m" } });
  const count = (input: number) => line({ timestamp: "2026-04-01T12:00:00Z", type: "event_msg", payload: {
    type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 2, output_tokens: 3 } } } });
  const complete = header + count(10) + count(20), partial = complete.slice(0, -1), config = policy();
  const binding = bindCanonicalArchiveRoot(null, "synthetic-archive", directory);
  const options: LedgerProducerOptions = { bands: compileCodexLedgerPolicy(config).baseBands, policy: config,
    factsRevision: 0, rulesRevision: sha(JSON.stringify(config)), batchSize: 2,
    anchorOf: (_home, file) => ledgerCopyAnchorFromArchive(binding, "codex/synthetic", file) };
  const drain = () => {
    for (let step = 0; step < 100; step++) { const result = processCodexLedgerBatch(db, options); if (result.ready) return result; }
    throw new Error("Synthetic producer did not finish");
  };
  const saved = () => db.query(`SELECT id,source_offset,identity,copy_state,api_band,credit_band,
    CAST(api_whole AS TEXT) api_whole,CAST(api_fraction_hi AS TEXT) api_fraction_hi,CAST(api_fraction_lo AS TEXT) api_fraction_lo,
    CAST(credit_whole AS TEXT) credit_whole,CAST(credit_fraction_hi AS TEXT) credit_fraction_hi,CAST(credit_fraction_lo AS TEXT) credit_fraction_lo
    FROM codex_price_ledger_events ORDER BY source_offset`).all();
  try {
    ensureCodexSchema(db); createCodexLedgerSchema(db);
    fs.writeFileSync(source, partial);
    await syncCodex(db, { homes: [sourceHome], files: [source] });
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    expect(db.query("SELECT provider_session_id FROM codex_file_evidence").get()).toEqual({ provider_session_id: "session" });
    enqueueCodexLedgerRuleChanges(db, options);
    expect(drain().ready).toBe(true);
    const before = saved();
    db.exec("CREATE TRIGGER protect_accepted BEFORE UPDATE ON codex_price_ledger_events WHEN OLD.id=1 AND (NEW.api_whole IS NOT OLD.api_whole OR NEW.dim_id<>OLD.dim_id) BEGIN SELECT RAISE(ABORT,'accepted call rewritten'); END");
    fs.appendFileSync(source, "\n");
    await syncCodex(db, { homes: [sourceHome], files: [source] });
    db.transaction(() => markCodexLedgerCopiesDirty(db, [{ home: sourceHome, path: source }])).immediate();
    expect(drain().ready).toBe(true);
    expect(saved()).toHaveLength(2); expect(saved()[0]).toEqual(before[0]);
    expect((saved()[1] as { api_whole: string | null }).api_whole).not.toBeNull();
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("sum publication rollback keeps the previous sums readable, leaves the work pending and is retryable", () => fixture(f => {
  f.bootstrap([event("a")]);
  const aggregates = () => f.db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY grain,day,hour").all(), before = aggregates();
  f.publish([event("a", { input: 20 })]);
  f.db.exec("CREATE TRIGGER fail_aggregate BEFORE INSERT ON codex_price_ledger_aggregates BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
  // Changed facts are published first; the day's sums are a later atomic step.
  expect(() => f.drain()).toThrow("injected");
  expect(aggregates()).toEqual(before);
  // The published sums stay readable while the day is pending (golden rules §9).
  expect(() => requireCodexLedgerReady(f.db)).not.toThrow();
  expect(codexLedgerFactsPending(f.db)).toBe(true);
  expect(f.db.query("SELECT kind,value FROM usage_ledger_dirty WHERE provider='codex'").all()).toEqual([{ kind: "day", value: "2026-04-01" }]);
  f.db.exec("DROP TRIGGER fail_aggregate"); expect(f.drain().ready).toBe(true);
  expect(f.db.query("SELECT CAST(uncached AS TEXT) uncached FROM codex_price_ledger_aggregates WHERE grain='day'").all()).toEqual([{ uncached: "18" }]);
}));

test("a copy changed again while its step was prepared is written from its latest facts", () => fixture(f => {
  f.bootstrap([event("a")]); f.publish([event("a", { input: 20 })]);
  let changed = false;
  // The step reads the copy's calls inside its own transaction: a publication before it is never lost or mixed.
  processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1, anchorOf: (owner, file) => {
    if (!changed) { changed = true; f.publish([event("a", { input: 30 })]); } return anchorOf(owner, file);
  } });
  expect(f.db.query("SELECT in_tok FROM codex_price_ledger_events").all()).toEqual([{ in_tok: 30 }]);
  expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'").get()).toEqual({ n: 0 });
  expect(f.drain().ready).toBe(true);
}));

test("fixed minute/hour buckets retain exact edge inclusivity and lexical pricing days", () => fixture(f => {
  f.bootstrap([event("a", { ts: "2026-04-01T00:00:00Z" }), event("b", { ts: "2026-04-01T00:01:00Z" }),
    event("c", { ts: "2026-04-02T01:00:00+02:00" }), event("d", { ts: "2026-04-01Tinvalid" })]);
  const start = Date.parse("2026-04-01T00:00:00Z"), end = start + 60000;
  const buckets = readCodexLedgerBucketGroups(f.db, { fromMs: start, toMs: end }, 60000);
  expect(buckets).toHaveLength(1); expect(buckets[0]!.bucketStartMs).toBe(start);
  expect(buckets[0]!.group.calls).toBe("1");
  const inclusive = readCodexLedgerBucketGroups(f.db, { fromMs: start, toMs: end, startInclusive: false, endInclusive: true }, 60000);
  expect(inclusive).toHaveLength(1); expect(inclusive[0]!.bucketStartMs).toBe(end);
  const hours = readCodexLedgerBucketGroups(f.db, {}, 3600000);
  expect(hours.find(item => item.group.day === "2026-04-02")!.bucketStartMs).toBe(Date.parse("2026-04-01T23:00:00Z"));
  expect(() => readCodexLedgerBucketGroups(f.db, {}, 500)).toThrow();
  const series = readCodexLedgerSeries(f.db, compileCodexLedgerPolicy(f.config()), {});
  expect(series.reduce((sum, row) => sum + row.calls, 0n)).toBe(4n);
  expect(series.some(row => row.variants.api_standard.unpricedEvents === 1n)).toBe(true);
}));

test("long-only rate corrections preserve ordinary event bases", () => fixture(f => {
  const config = f.config();
  config.base_rules[0]!.long_context = { above_input_tokens: 10, rates: { in_uncached: "3.75", in_cache_read: "0.25", out_total: "3.5999999999999996" } };
  f.bootstrap([event("a", { input: 10 }), event("b", { input: 11 })]);
  const before = f.snapshot() as Record<string, unknown>[];
  config.base_rules[0]!.long_context.rates.out_total = "3.5";
  enqueueCodexLedgerRuleChanges(f.db, f.options());
  const result = f.drain(); expect(result.repricedApi).toBe(1); expect(result.repricedCredits).toBe(0);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[0]).toEqual(before[0]); expect(after[1]!.api_band).not.toBe(before[1]!.api_band);
}));

test("project rules are read at read time; a repository attribution changes only metadata, retaining exact bases", () => fixture(f => {
  f.publish([event("a"), event("b")], { notify: false });
  f.db.exec("ALTER TABLE events DROP COLUMN subject; ALTER TABLE events ADD COLUMN project TEXT; ALTER TABLE events ADD COLUMN repo TEXT");
  f.db.exec("UPDATE events SET project='p42' WHERE source_offset=0; UPDATE events SET repo='repo/path' WHERE source_offset>0");
  enqueueCodexLedgerRuleChanges(f.db, f.options()); f.drain();
  const subjects = () => withPlaceProjects(f.db, f.db.query(`SELECT e.source_offset, e.day, d.home, ${metadataColumns()}
    FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id ORDER BY e.source_offset`).all() as Array<{ source_offset: number;
      day: string; home: string; cwd: string | null; project: string | null; repo: string | null; project_id: unknown; subject: string | null }>)
    .map(row => ({ source_offset: row.source_offset, subject: row.subject }));
  overrideProjectRules(f.db, { projects: [{ id: "42", name: "42", matches: [{ project: "p42" }] }] });
  expect(subjects()).toEqual([{ source_offset: 0, subject: "p:42" }, { source_offset: 100, subject: "r:repo/path" }]);
  // Another rule: read at once, nothing written or queued.
  const before = f.snapshot() as Record<string, unknown>[], changes = () => (f.db.query("SELECT total_changes() n").get() as { n: number }).n;
  const written = changes();
  overrideProjectRules(f.db, { projects: [{ id: "43", name: "43", matches: [{ project: "p42" }] }] });
  expect(subjects()).toEqual([{ source_offset: 0, subject: "p:43" }, { source_offset: 100, subject: "r:repo/path" }]);
  expect(changes()).toBe(written); expect(f.drain().processed ?? 0).toBe(0);
  // A repository is part of the place: its change moves the call to another dimension, the amounts stay.
  f.db.transaction(() => { f.db.exec("UPDATE events SET repo='other/path' WHERE source_offset>0"); markCodexLedgerCopiesDirty(f.db, [{ home, path: filePath }]); })();
  expect(f.drain().ready).toBe(true);
  const after = f.snapshot() as Record<string, unknown>[];
  expect(after[1]!.api_whole).toBe(before[1]!.api_whole); expect(after[1]!.credit_whole).toBe(before[1]!.credit_whole);
  expect(after[0]).toEqual(before[0]);
  expect(subjects()).toEqual([{ source_offset: 0, subject: "p:43" }, { source_offset: 100, subject: "r:other/path" }]);
  overrideProjectRules(f.db, null);
}));

test("a ledger built while the source was empty starts over as a set-based fill once every file is queued", () => fixture(f => {
  // The server's first turn finds no calls and publishes an empty ledger; the first import then queues every file.
  f.bootstrap([]);
  expect(f.db.query("SELECT status FROM usage_ledger_state WHERE provider='codex'").get()).toEqual({ status: "ready" });
  f.publish([event("a"), event("b", { ts: "2026-04-02T08:00:00Z" })]);
  f.publish([event("c")], { file: "archive/sessions/b.jsonl" });
  expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'").get()).toEqual({ n: 2 });
  processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
  // The fill writes the files from `events`; their queued copies are not written one by one afterwards.
  expect(codexLedgerFillState(f.db)).not.toBeNull();
  expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'").get()).toEqual({ n: 0 });
  expect(f.drain().ready).toBe(true);
  const filled = ledgerContent(f.db);
  const fresh = createFixture();
  try {
    fresh.publish([event("a"), event("b", { ts: "2026-04-02T08:00:00Z" })], { notify: false });
    fresh.publish([event("c")], { file: "archive/sessions/b.jsonl", notify: false });
    enqueueCodexLedgerRuleChanges(fresh.db, fresh.options()); expect(fresh.drain().ready).toBe(true);
    expect(filled).toEqual(ledgerContent(fresh.db));
  } finally { fresh.db.close(); }
}));

test("a batch ends with its time budget after at least one step", () => fixture(f => {
  f.bootstrap([event("a")]);
  for (const name of ["b", "c", "d"]) f.publish([event(name)], { file: `archive/sessions/${name}.jsonl` });
  const result = processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 500, budgetMs: 0 });
  expect(result.progressed).toBe(true);
  expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy'").get()).toEqual({ n: 2 });
}));

test("a call removed from the middle of a copy leaves the incremental ledger equal to a fill from empty", () => {
  // The call after the removed one moves to its offset; its own source row has no response id. The removed call's
  // response id is also recorded in another conversation, where a stale `r:` identity would make both a conflict.
  const other: [string, Input[]] = ["archive/sessions/o.jsonl", [event("b", { input: 70 })]];
  const before: Array<[string, Input[]]> = [
    ["archive/sessions/a.jsonl", [event("a"), event("b"), event(null), event("d")]],
    ["archive/archived_sessions/a.jsonl", [event("a"), event("b"), event(null), event("d")]],
    ["archive/sessions/s.jsonl", [event("p"), event("q"), event(null)]], other];
  const after: Array<[string, Input[]]> = [
    ["archive/sessions/a.jsonl", [event("a"), event(null), event("d")]],
    ["archive/archived_sessions/a.jsonl", [event("a"), event(null), event("d")]],
    ["archive/sessions/s.jsonl", [event("p"), event(null)]], other];
  let filled: ReturnType<typeof ledgerContent> | undefined;
  fixture(f => {
    for (const [file, inputs] of after) f.publish(inputs, { file, notify: false });
    enqueueCodexLedgerRuleChanges(f.db, f.options());
    expect(f.drain().ready).toBe(true);
    filled = ledgerContent(f.db);
  });
  fixture(f => {
    f.bootstrap([]);
    for (const [file, inputs] of before) { f.publish(inputs, { file }); expect(f.drain().ready).toBe(true); }
    for (const [file, inputs] of after.slice(0, 3)) { f.publish(inputs, { file }); expect(f.drain().ready).toBe(true); }
    expect(ledgerContent(f.db)).toEqual(filled!);
  });
  expect(filled!.calls.filter(call => (call as { copy_state: string }).copy_state === "conflict")).toHaveLength(0);
});

test("a removed call's response partner in another conversation is decided again, as a fill from empty decides it", () => {
  // The removed call was the canonical copy of a response also recorded in o.jsonl (same facts) and in p.jsonl
  // (other facts, a conflict). Without it o.jsonl's call is canonical and p.jsonl's stays a conflict with it.
  const others: Array<[string, Input[]]> = [["archive/sessions/o.jsonl", [event("b"), event("x")]], ["archive/sessions/q.jsonl", [event("c")]],
    ["archive/sessions/p.jsonl", [event("c", { input: 70 })]]];
  const before: Array<[string, Input[]]> = [["archive/sessions/a.jsonl", [event("a"), event("b"), event("c")]], ...others];
  const after: Array<[string, Input[]]> = [["archive/sessions/a.jsonl", [event("a")]], ...others];
  let filled: ReturnType<typeof ledgerContent> | undefined;
  fixture(f => {
    for (const [file, inputs] of after) f.publish(inputs, { file, notify: false });
    enqueueCodexLedgerRuleChanges(f.db, f.options());
    expect(f.drain().ready).toBe(true);
    filled = ledgerContent(f.db);
  });
  fixture(f => {
    f.bootstrap([]);
    for (const [file, inputs] of before) { f.publish(inputs, { file }); expect(f.drain().ready).toBe(true); }
    expect(f.db.query("SELECT copy_state FROM codex_price_ledger_events WHERE identity='r:b' ORDER BY copy_id").all())
      .toEqual([{ copy_state: "canonical" }, { copy_state: "duplicate" }]);
    f.publish(after[0]![1], { file: after[0]![0] }); expect(f.drain().ready).toBe(true);
    expect(ledgerContent(f.db)).toEqual(filled!);
  });
  expect(filled!.calls.map(call => (call as { identity: string; copy_state: string })).filter(call => call.identity !== "r:a" && call.identity !== "r:x")
    .map(call => [call.identity, call.copy_state])).toEqual([["r:b", "canonical"], ["r:c", "conflict"], ["r:c", "conflict"]]);
});
