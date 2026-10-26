/**
 * Stored activity in the Codex price ledger (docs/stored-activity-plan-2026-10-07.md, step 4): every call's gap and every
 * day cohort's activity sums equal the oracle (D2 per chain of one copy and its billing, order instant then offset,
 * canonical admitted calls only) and a fill from empty, after appends, corrections, removals, second copies of a
 * conversation and business-credit calls; a fork's replayed parent calls add no activity; the migration's backfill
 * resumes and publishes. Synthetic in-memory databases; no production data is read.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty, processCodexLedgerBatch, type LedgerProducerOptions } from "./codex-ledger-producer";
import type { LedgerCopyAnchor } from "./codex-ledger-copies";
import { readCodexLedgerState } from "./codex-ledger-state";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { ACTIVITY_CUTOFF_MINUTES, activityColumn } from "./usage-ledger";
import { oracleGaps, oracleIntervalUnion, type OracleFact } from "../server/activity-oracle";
import type { ActivityInterval } from "./activity-intervals";
import { loadAccountResolver } from "../server/account-resolver";
import { codexEventOwner } from "../server/codex-event-owner";
import { ActivityPending, codexActivityKey, readCodexOwnedDays } from "../server/ledger-sums";
import fs from "node:fs";
import path from "node:path";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const HOME = "archive";
const anchorOf = (_home: string | null, file: string): LedgerCopyAnchor =>
  ({ archiveId: "archive-id", sourceId: "codex/pc/profile", relativePath: file.replace(/^archive\//, "codex/") });
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
const POLICY: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: [
    { id: "api", model: "m", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "8" }, ...provenance },
    { id: "credits", model: "m", billing_basis: "chatgpt_credits", valid_from: "2026-01-01", multiplier: "1",
      rates: { in_uncached: "25", in_cache_read: "2.5", out_total: "200" }, ...provenance },
  ], tier_rules: [
    { id: "api-standard", model: "m", billing_basis: "api_equivalent_usd", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
    { id: "credit-standard", model: "m", billing_basis: "chatgpt_credits", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance },
  ] };
interface Call { ts: string; input: number; output: number; response?: string | null; business?: boolean }

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createFixture() {
  const db = new Database(":memory:");
  createCodexLedgerSchema(db);
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,cache_write ANY,out_tok ANY,
    reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,
    plan_type TEXT,meter_reset INTEGER,response_id TEXT,UNIQUE(home,path,source_offset)) STRICT;
    CREATE TABLE codex_file_evidence(home TEXT,path TEXT,provider_forked_from_id TEXT,PRIMARY KEY(home,path))`);
  const options = (): LedgerProducerOptions => {
    const compiled = compileCodexLedgerPolicy(POLICY);
    return { bands: compiled.baseBands, policy: POLICY, factsRevision: 0, rulesRevision: sha(JSON.stringify(POLICY)), anchorOf, batchSize: 50 };
  };
  /** Replaces one file's calls (offsets 0, 100, ...), as a publication does, and names the copy changed. */
  const publish = (file: string, calls: Call[], notify = true) => db.transaction(() => {
    db.query("DELETE FROM events WHERE home=? AND path=?").run(HOME, file);
    calls.forEach((call, index) => db.query(`INSERT INTO events VALUES(?,?,?,'m',?,?,2,0,?,1,'valid','missing','default','standard',NULL,?,NULL,NULL,
      'plus',0,?)`).run(HOME, file, index * 100, call.ts, call.input, call.output, call.business ? "business_credits" : "allowance", call.response ?? null));
    if (notify) markCodexLedgerCopiesDirty(db, [{ home: HOME, path: file }]);
  }).immediate();
  const drain = () => {
    for (let step = 0; step < 5000; step++) {
      const result = processCodexLedgerBatch(db, options());
      if (result.ready || !result.progressed) return result;
    }
    throw new Error("Producer did not complete");
  };
  const fill = () => { enqueueCodexLedgerRuleChanges(db, options()); return drain(); };
  return { db, publish, drain, fill, options };
}

type Row = { id: number; copy_id: number; copy: string; source_offset: number; instant_ms: number | null; day: string; copy_state: string; admitted: number;
  gap_ms: number | null; gap_from_ms: number | null; billing_mode: string | null; dim: string };
const rowsOf = (db: Database) => db.query(`SELECT e.id,e.copy_id,c.identity copy,e.source_offset,e.instant_ms,e.day,e.copy_state,e.admitted,
  e.gap_ms,e.gap_from_ms,d.billing_mode,d.key dim FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
  JOIN codex_price_ledger_dims d ON d.id=e.dim_id ORDER BY c.identity,e.source_offset`).all() as Row[];
/** The D2 oracle over the stored calls: a chain is (copy, billing), order (instant, offset). */
function oracleOf(rows: Row[]) {
  const facts = rows.map(row => ({ id: row.id, identity: String(row.source_offset).padStart(20, "0"),
    ts: row.instant_ms === null ? "" : new Date(row.instant_ms).toISOString(), session: String(row.copy_id),
    copy_state: row.admitted && row.instant_ms !== null ? row.copy_state : "outside", eligible: 1, vendor: "openai",
    owner: row.billing_mode === "business_credits" ? "business" : "ordinary" }) satisfies OracleFact & { owner: string });
  const gaps = oracleGaps("codex", facts, fact => fact.owner);
  const days = new Map<string, Record<string, number | null>>();
  for (const row of rows) {
    if (row.copy_state !== "canonical" || !row.admitted) continue;
    const key = `${row.day}|${row.dim}`;
    const sums = days.get(key) ?? Object.fromEntries([...ACTIVITY_CUTOFF_MINUTES.map(m => [activityColumn(m), 0]), ["gap_from_ms", null]]);
    days.set(key, sums);
    const gap = gaps.get(row.id);
    if (!gap || gap.gapMs <= 0) continue;
    for (const minutes of ACTIVITY_CUTOFF_MINUTES) sums[activityColumn(minutes)] = Number(sums[activityColumn(minutes)]) + Math.min(gap.gapMs, minutes * 60_000);
    const from = Date.parse(gap.from);
    if (sums.gap_from_ms === null || from < Number(sums.gap_from_ms)) sums.gap_from_ms = from;
  }
  return { gaps, days };
}
const storedDays = (db: Database) => new Map((db.query(`SELECT a.day||'|'||d.key k, ${ACTIVITY_CUTOFF_MINUTES.map(m => `SUM(a.${activityColumn(m)}) ${activityColumn(m)}`).join(",")},
  MIN(a.gap_from_ms) gap_from_ms FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
  WHERE a.grain='day' AND a.copy_state='canonical' GROUP BY a.day,d.key`).all() as Array<Record<string, number | null> & { k: string }>)
  .map(({ k, ...rest }) => [k, rest]));
function expectMatchesOracle(db: Database): { gaps: number; positive: number } {
  const rows = rowsOf(db), { gaps, days } = oracleOf(rows);
  for (const row of rows) {
    const gap = gaps.get(row.id);
    expect({ copy: row.copy, offset: row.source_offset, gap: row.gap_ms, from: row.gap_from_ms })
      .toEqual({ copy: row.copy, offset: row.source_offset, gap: gap?.gapMs ?? null, from: gap ? Date.parse(gap.from) : null });
  }
  expect(Object.fromEntries(storedDays(db))).toEqual(Object.fromEntries(days));
  const expected = new Map<string, Array<[number, number]>>();
  for (const row of rows) {
    const gap = gaps.get(row.id);
    if (!gap || gap.gapMs <= 0) continue;
    for (const cutoff of ACTIVITY_CUTOFF_MINUTES) {
      const key = JSON.stringify([row.day, row.dim, cutoff]), until = row.instant_ms!;
      const spans = expected.get(key) ?? [];
      spans.push([until - Math.min(gap.gapMs, cutoff * 60000), until]); expected.set(key, spans);
    }
  }
  const actual = db.query(`SELECT a.day,d.key dim,a.cutoff,a.intervals FROM usage_activity_intervals a
    JOIN codex_price_ledger_dims d ON d.id=a.dim_id WHERE a.provider='codex'`).all() as Array<{ day: string; dim: string; cutoff: number; intervals: string }>;
  expect(new Map(actual.map(r => [JSON.stringify([r.day,r.dim,r.cutoff]), JSON.parse(r.intervals)])))
    .toEqual(new Map([...expected].map(([key, spans]) => [key, oracleIntervalUnion(spans)])));
  // Hour cohorts carry no activity; non-canonical cohorts none either.
  expect(db.query(`SELECT COUNT(*) n FROM codex_price_ledger_aggregates WHERE (grain='hour' OR copy_state<>'canonical')
    AND (${ACTIVITY_CUTOFF_MINUTES.map(m => `${activityColumn(m)}<>0`).join(" OR ")} OR gap_from_ms IS NOT NULL)`).get()).toEqual({ n: 0 });
  return { gaps: gaps.size, positive: [...gaps.values()].filter(gap => gap.gapMs > 0).length };
}
const content = (db: Database) => ({ gaps: rowsOf(db).map(row => [row.copy, row.source_offset, row.gap_ms, row.gap_from_ms]),
  days: Object.fromEntries(storedDays(db)) });
/** The same source calls filled from empty in a fresh database. */
function refilled(db: Database) {
  const fresh = createFixture();
  for (const row of db.query("SELECT * FROM events").all() as Array<Record<string, string | number | null>>)
    fresh.db.query(`INSERT INTO events(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  for (const row of db.query("SELECT * FROM codex_file_evidence").all() as Array<Record<string, string | null>>)
    fresh.db.query("INSERT INTO codex_file_evidence VALUES(?,?,?)").run(row.home!, row.path!, row.provider_forked_from_id ?? null);
  expect(fresh.fill().ready).toBe(true);
  return fresh.db;
}

for (const seed of [21, 22, 23, 24]) {
  test(`Codex gaps and day activity equal the oracle and a fill from empty under random edits (seed ${seed})`, () => {
    const f = createFixture(), random = prng(seed);
    try {
      const start = Date.parse("2026-04-01T00:00:00.000Z");
      let responses = 0;
      const randomCall = (): Call => {
        const at = start + Math.floor(random() * 4 * 24 * 12) * 300_000 + (random() < 0.3 ? 0 : Math.floor(random() * 200) * 1000);
        const ts = random() < 0.15 ? new Date(at + 7_200_000).toISOString().replace("Z", "+02:00") : new Date(at).toISOString();
        return { ts, input: 10 + Math.floor(random() * 100), output: 1 + Math.floor(random() * 20), response: random() < 0.5 ? `r${responses++}` : null,
          business: random() < 0.15 };
      };
      const files = new Map<string, Call[]>();
      const names = ["a", "b", "c", "d"].map(name => `archive/sessions/rollout-${name}.jsonl`);
      for (const name of names) files.set(name, Array.from({ length: 6 + Math.floor(random() * 10) }, randomCall));
      for (const [name, calls] of files) f.publish(name, calls, false);
      expect(f.fill().ready).toBe(true);
      expectMatchesOracle(f.db);
      for (let round = 0; round < 6; round++) {
        const name = names[Math.floor(random() * names.length)]!, calls = [...files.get(name)!];
        const action = round % 3;
        if (action === 0) calls.push(...Array.from({ length: 1 + Math.floor(random() * 4) }, randomCall)); // append, at any instant
        // Removed trailing calls (a file read again shorter); offsets of the other calls stay, as in an append-only transcript.
        else if (action === 1 && calls.length > 2) calls.splice(calls.length - 1 - Math.floor(random() * 2));
        else if (calls.length) { const at = Math.floor(random() * calls.length); calls[at] = { ...calls[at]!, ts: randomCall().ts }; } // a corrected instant
        files.set(name, calls);
        f.publish(name, calls);
        // A second physical copy of one conversation (same file name), a prefix or the whole: its calls are duplicates.
        if (round === 1 || round === 4) {
          const original = files.get(names[0]!)!;
          f.publish("archive/backup/rollout-a.jsonl", original.slice(0, round === 1 ? Math.max(1, original.length - 2) : original.length));
        }
        expect(f.drain().ready).toBe(true);
        expect(f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex'").get()).toEqual({ n: 0 });
        expectMatchesOracle(f.db);
      }
      const result = expectMatchesOracle(f.db);
      expect(result.positive).toBeGreaterThan(20);
      expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE copy_state='duplicate'").get()).not.toEqual({ n: 0 });
      expect(f.db.query("SELECT COUNT(DISTINCT d.billing_mode) n FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id").get())
        .toEqual({ n: 2 });
      const fresh = refilled(f.db);
      try { expect(content(fresh)).toEqual(content(f.db)); } finally { fresh.close(); }
    } finally { f.db.close(); }
  }, 120_000);
}

test("hand-checked Codex chain: per copy and billing, cap per cutoff, the pricing day, an appended call dirties only its own and next day", () => {
  const f = createFixture();
  try {
    f.publish("archive/sessions/rollout-x.jsonl", [
      { ts: "2026-04-01T10:00:00Z", input: 10, output: 1 },
      { ts: "2026-04-01T10:20:00Z", input: 11, output: 1 }, // 20 min
      { ts: "2026-04-01T10:21:00Z", input: 12, output: 1, business: true }, // business: its own chain, no predecessor
      { ts: "2026-04-01T10:25:00Z", input: 13, output: 1, business: true }, // 4 min after the business call
      { ts: "2026-04-02T01:30:00+02:00", input: 14, output: 1 }, // 23:30Z on 04-01, priced on 04-02: gap 13 h 10 min
    ], false);
    f.publish("archive/sessions/rollout-y.jsonl", [{ ts: "2026-04-01T10:22:00Z", input: 15, output: 1 }], false);
    expect(f.fill().ready).toBe(true);
    const gaps = () => (f.db.query(`SELECT c.identity copy,e.source_offset,e.gap_ms FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
      ORDER BY c.identity,e.source_offset`).all() as Array<{ gap_ms: number | null }>).map(row => row.gap_ms);
    expect(gaps()).toEqual([null, 1_200_000, null, 240_000, 47_400_000, null]);
    const day = (d: string) => f.db.query(`SELECT SUM(active_5m_ms) m5, SUM(active_15m_ms) m15, SUM(active_60m_ms) m60 FROM codex_price_ledger_aggregates
      WHERE grain='day' AND day=?`).get(d);
    expect(day("2026-04-01")).toEqual({ m5: 300_000 + 240_000, m15: 900_000 + 240_000, m60: 1_200_000 + 240_000 });
    expect(day("2026-04-02")).toEqual({ m5: 300_000, m15: 900_000, m60: 3_600_000 });
    expectMatchesOracle(f.db);
    expect(readCodexLedgerState(f.db)?.activity_published).toBe(1);
    // A late call between the 10:20 and 23:30Z calls (written last in its file) dirties its own day 04-01 and the successor's day 04-02 only.
    const seen = new Map<string, Set<string>>();
    f.publish("archive/sessions/rollout-x.jsonl", [
      { ts: "2026-04-01T10:00:00Z", input: 10, output: 1 }, { ts: "2026-04-01T10:20:00Z", input: 11, output: 1 },
      { ts: "2026-04-01T10:21:00Z", input: 12, output: 1, business: true }, { ts: "2026-04-01T10:25:00Z", input: 13, output: 1, business: true },
      { ts: "2026-04-02T01:30:00+02:00", input: 14, output: 1 }, { ts: "2026-04-01T20:00:00Z", input: 16, output: 1 },
    ]);
    for (let step = 0; step < 100; step++) {
      for (const row of f.db.query("SELECT kind,value FROM usage_ledger_dirty WHERE provider='codex'").all() as Array<{ kind: string; value: string }>)
        (seen.get(row.kind) ?? seen.set(row.kind, new Set()).get(row.kind)!).add(row.value);
      const result = processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
      if (result.ready || !result.progressed) break;
    }
    // The 23:30Z call's gap shrinks to 3 h 30 min (still capped); its day's earliest predecessor moves.
    expect([...(seen.get("day") ?? [])].sort()).toEqual(["2026-04-01"]);
    expect([...(seen.get("activity") ?? [])].sort()).toEqual(["2026-04-01", "2026-04-02"]);
    expectMatchesOracle(f.db);
  } finally { f.db.close(); }
});

test("a fork's replayed parent calls add no activity; its own calls chain among themselves", () => {
  const f = createFixture();
  try {
    const PARENT = "019f51e3-efe2-7a22-aeea-6c78d82fbe97", FORK = "019f51e6-aee1-7f03-b046-1438cbd3d001";
    const parentFile = `archive/sessions/rollout-2026-07-11T15-55-26-${PARENT}.jsonl`, forkFile = `archive/sessions/rollout-2026-07-11T15-58-30-${FORK}.jsonl`;
    const parent: Call[] = [{ ts: "2026-07-11T15:55:34.298Z", input: 18464, output: 278 }, { ts: "2026-07-11T15:55:38.176Z", input: 26540, output: 129 },
      { ts: "2026-07-11T15:55:46.132Z", input: 33546, output: 307 }];
    // The fork replays the parent's calls within a millisecond of its creation, then makes its own.
    const fork: Call[] = [...parent.map((call, index) => ({ ...call, ts: `2026-07-11T15:58:30.54${4 + Math.min(index, 1)}Z` })),
      { ts: "2026-07-11T15:58:37.088Z", input: 18443, output: 254 }, { ts: "2026-07-11T15:58:41.468Z", input: 18777, output: 157 }];
    f.db.query("INSERT INTO codex_file_evidence VALUES(?,?,?)").run(HOME, forkFile, PARENT);
    f.publish(parentFile, parent, false);
    f.publish(forkFile, fork, false);
    expect(f.fill().ready).toBe(true);
    const states = f.db.query(`SELECT e.source_offset,e.copy_state,e.gap_ms FROM codex_price_ledger_events e JOIN codex_price_ledger_copies c ON c.id=e.copy_id
      WHERE c.path=? ORDER BY e.source_offset`).all(forkFile);
    expect(states).toEqual([{ source_offset: 0, copy_state: "duplicate", gap_ms: null }, { source_offset: 100, copy_state: "duplicate", gap_ms: null },
      { source_offset: 200, copy_state: "duplicate", gap_ms: null }, { source_offset: 300, copy_state: "canonical", gap_ms: null },
      { source_offset: 400, copy_state: "canonical", gap_ms: 4380 }]);
    // Parent: 3.878 s + 7.956 s; fork: 4.38 s.
    expect(f.db.query("SELECT SUM(active_5m_ms) n FROM codex_price_ledger_aggregates WHERE grain='day'").get()).toEqual({ n: 3878 + 7956 + 4380 });
    expectMatchesOracle(f.db);
    // The fork arriving before its parent's later call: the parent grows, the fork is resolved again, sums stay exact.
    f.publish(parentFile, [...parent, { ts: "2026-07-11T16:10:00.000Z", input: 41000, output: 90 }]);
    expect(f.drain().ready).toBe(true);
    expectMatchesOracle(f.db);
  } finally { f.db.close(); }
});

test("the migration's backfill keeps the ledger published, resumes after an interrupted step and then publishes activity", () => {
  const f = createFixture(), random = prng(5);
  try {
    for (let file = 0; file < 8; file++) f.publish(`archive/sessions/rollout-${file}.jsonl`, Array.from({ length: 12 }, () => ({
      ts: new Date(Date.parse("2026-04-01T00:00:00Z") + Math.floor(random() * 3 * 24 * 60) * 60_000).toISOString(), input: 10, output: 2,
      business: random() < 0.2 })), false);
    expect(f.fill().ready).toBe(true);
    const reference = content(f.db);
    // The state 0067 leaves: no gaps and no sums, every copy and every day queued, activity unpublished.
    f.db.exec(`UPDATE codex_price_ledger_events SET gap_ms=NULL, gap_from_ms=NULL;
      UPDATE codex_price_ledger_aggregates SET ${ACTIVITY_CUTOFF_MINUTES.map(m => `${activityColumn(m)}=0`).join(",")}, gap_from_ms=NULL;
      UPDATE usage_ledger_state SET activity_published=0 WHERE provider='codex';
      INSERT INTO usage_ledger_dirty SELECT 'codex','session',CAST(id AS TEXT) FROM codex_price_ledger_copies;
      INSERT INTO usage_ledger_dirty SELECT DISTINCT 'codex','activity',day FROM codex_price_ledger_aggregates WHERE grain='day';`);
    const victim = (f.db.query("SELECT id FROM codex_price_ledger_events ORDER BY id LIMIT 1 OFFSET 30").get() as { id: number }).id;
    f.db.exec(`CREATE TEMP TRIGGER interrupt BEFORE UPDATE OF gap_ms ON main.codex_price_ledger_events WHEN NEW.id=${victim}
      BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
    let interrupted = false;
    for (let step = 0; step < 100 && !interrupted; step++) {
      const queued = (f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex'").get() as { n: number }).n;
      try { processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 }); }
      catch (error) {
        expect(String(error)).toContain("interrupted");
        expect((f.db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex'").get() as { n: number }).n).toBe(queued);
        interrupted = true;
      }
      // Calls and amounts stay published while activity is prepared.
      expect(readCodexLedgerState(f.db)).toMatchObject({ status: "ready", activity_published: 0 });
    }
    expect(interrupted).toBe(true);
    f.db.exec("DROP TRIGGER temp.interrupt");
    expect(f.drain().ready).toBe(true);
    expect(readCodexLedgerState(f.db)?.activity_published).toBe(1);
    expect(content(f.db)).toEqual(reference);
    expectMatchesOracle(f.db);
    // Nothing left: another batch writes nothing.
    const changes = (f.db.query("SELECT total_changes() n").get() as { n: number }).n;
    expect(processCodexLedgerBatch(f.db, f.options()).ready).toBe(true);
    expect((f.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(changes);
  } finally { f.db.close(); }
});

test("Codex reads per verified owner (D4) equal the oracle across period boundaries and business pools, every cutoff and range", () => {
  const f = createFixture(), random = prng(77);
  try {
    f.db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    // One source changes hands twice; the first owner gets it back.
    for (const [from, until, account] of [["2000-01-01", "2026-04-02T06:00:00.000Z", "acct-a"], ["2026-04-02T06:00:00.000Z", "2026-04-03T00:00:00.000Z", "acct-b"],
      ["2026-04-03T00:00:00.000Z", null, "acct-a"]] as const) f.db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('codex','codex/pc/profile',?,?,?,'declared',0,'fixture')`).run(from, until, account);
    for (let file = 0; file < 6; file++) f.publish(`archive/sessions/rollout-${file}.jsonl`, Array.from({ length: 25 }, () => {
      // Eight days: the first four around the boundaries, the rest read from the stored sums alone.
      const at = Date.parse("2026-04-01T00:00:00Z") + Math.floor(random() * 8 * 24 * 12) * 300_000 + Math.floor(random() * 200) * 1000;
      return { ts: random() < 0.2 ? new Date(at + 7_200_000).toISOString().replace("Z", "+02:00") : new Date(at).toISOString(), input: 10, output: 2,
        business: random() < 0.25 };
    }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), false);
    expect(f.fill().ready).toBe(true);
    const resolver = loadAccountResolver(f.db);
    const rows = rowsOf(f.db) as Array<Row & { dim_id?: number; source?: string }>;
    const meta = new Map((f.db.query("SELECT e.id, e.dim_id, d.source FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id").all() as
      Array<{ id: number; dim_id: number; source: string }>).map(row => [row.id, row]));
    const owner = (row: Row) => row.instant_ms === null ? null : codexEventOwner(resolver.resolve("codex", meta.get(row.id)!.source, null,
      new Date(row.instant_ms).toISOString()).account, { billing_mode: row.billing_mode });
    const facts = rows.map(row => ({ id: row.id, identity: String(row.source_offset).padStart(20, "0"), day: row.day,
      ts: row.instant_ms === null ? "" : new Date(row.instant_ms).toISOString(), session: String(row.copy_id),
      copy_state: row.admitted && row.instant_ms !== null ? row.copy_state : "outside", eligible: 1, vendor: "openai", owner: owner(row) }));
    const owners = new Set(facts.map(fact => fact.owner));
    expect(owners).toEqual(new Set(["acct-a", "acct-b", "acct-a::business", "acct-b::business"]));
    let compared = 0;
    for (const range of [{ since: "2026-04-02", until: "2026-04-02" }, { since: "2026-04-03" }, { since: "2026-04-06" }, {}] as Array<{ since?: string; until?: string }>)
      for (const minutes of ACTIVITY_CUTOFF_MINUTES) {
        // The oracle keys calls by UTC day; a Codex call counts on its pricing day, so its sums are re-keyed per call.
        const expected = new Map<string, number>();
        const expectedIntervals = new Map<string, ActivityInterval[]>(), intervals = new Map<string, ActivityInterval[]>();
        const gaps = oracleGaps("codex", facts, fact => fact.owner);
        for (const fact of facts) {
          const gap = gaps.get(fact.id);
          if (!gap || gap.gapMs <= 0 || range.since && fact.day < range.since || range.until && fact.day > range.until) continue;
          const key = codexActivityKey(fact.day, meta.get(fact.id)!.dim_id, fact.owner);
          expected.set(key, (expected.get(key) ?? 0) + Math.min(gap.gapMs, minutes * 60_000));
          const until = Date.parse(fact.ts), spans = expectedIntervals.get(key) ?? [];
          spans.push([until - Math.min(gap.gapMs, minutes * 60000), until]); expectedIntervals.set(key, spans);
        }
        const read = readCodexOwnedDays(f.db, resolver, minutes, range, intervals);
        const actual = new Map([...read].filter(([, value]) => value.active_ms > 0).map(([key, value]) => [key, value.active_ms]));
        expect(Object.fromEntries([...actual].sort())).toEqual(Object.fromEntries([...expected].sort()));
        expect(new Map([...intervals].map(([key, spans]) => [key, oracleIntervalUnion(spans)])))
          .toEqual(new Map([...expectedIntervals].map(([key, spans]) => [key, oracleIntervalUnion(spans)])));
        // Calls and tokens of every owner add up to the stored canonical totals of the range.
        const total = [...read.values()].reduce((sum, value) => sum + value.calls, 0);
        expect(total).toBe(rows.filter(row => row.copy_state === "canonical" && row.admitted
          && (!range.since || row.day >= range.since) && (!range.until || row.day <= range.until)).length);
        compared += expected.size;
      }
    expect(compared).toBeGreaterThan(100);
    f.db.exec("UPDATE usage_ledger_state SET activity_published=0 WHERE provider='codex'");
    expect(() => readCodexOwnedDays(f.db, resolver, 15)).toThrow(ActivityPending);
  } finally { f.db.close(); }
});

test("a call without a valid instant on a day of owned calls stays unowned and leaves the owned calls theirs", () => {
  const f = createFixture();
  try {
    f.db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    f.db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
      VALUES('codex','codex/pc/profile','2000-01-01',NULL,'acct-a','declared',0,'fixture')`).run();
    // No period boundary near the day; the unparseable timestamp sorts before the valid ones.
    f.publish("archive/sessions/rollout-0.jsonl", [{ ts: "2026-04-05T00:00:99Z", input: 10, output: 2 },
      { ts: "2026-04-05T10:00:00.000Z", input: 10, output: 2 }, { ts: "2026-04-05T10:05:00.000Z", input: 10, output: 2 },
      { ts: "2026-04-05T10:10:00.000Z", input: 10, output: 2 }], false);
    expect(f.fill().ready).toBe(true);
    expect(f.db.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE instant_ms IS NULL AND admitted=1 AND day='2026-04-05'").get()).toEqual({ n: 1 });
    const read = [...readCodexOwnedDays(f.db, loadAccountResolver(f.db), 15).values()].map(({ owner, calls, active_ms }) => ({ owner, calls, active_ms }))
      .sort((a, b) => String(a.owner).localeCompare(String(b.owner)));
    expect(read).toEqual([{ owner: "acct-a", calls: 3, active_ms: 600_000 }, { owner: codexEventOwner(null, { billing_mode: "allowance" }), calls: 1, active_ms: 0 }]
      .sort((a, b) => String(a.owner).localeCompare(String(b.owner))));
  } finally { f.db.close(); }
});

test("at a period boundary a late Codex call on a dimension not built yet is no predecessor until it is", () => {
  const f = createFixture();
  try {
    f.db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    // The source changes hands at 10:30: acct-a owns 10:00-10:20, acct-b the call at 10:40.
    for (const [from, until, account] of [["2000-01-01", "2026-04-05T10:30:00.000Z", "acct-a"], ["2026-04-05T10:30:00.000Z", null, "acct-b"]] as const)
      f.db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
        VALUES('codex','codex/pc/profile',?,?,?,'declared',0,'fixture')`).run(from, until, account);
    const file = "archive/sessions/rollout-0.jsonl";
    f.publish(file, ["10:00", "10:10", "10:20", "10:40"].map(time => ({ ts: `2026-04-05T${time}:00.000Z`, input: 10, output: 2 })), false);
    expect(f.fill().ready).toBe(true);
    const active = (account: string) => [...readCodexOwnedDays(f.db, loadAccountResolver(f.db), 15).values()]
      .filter(row => row.owner === account).reduce((sum, row) => sum + row.active_ms, 0);
    expect([active("acct-a"), active("acct-b")]).toEqual([1_200_000, 0]);
    // A late 10:05 call of another model (another dimension) appended to the file: 300 + 300 + 600 s once built.
    f.db.transaction(() => {
      f.db.query(`INSERT INTO events VALUES(?,?,400,'m2','2026-04-05T10:05:00.000Z',10,2,0,2,1,'valid','missing','default','standard',NULL,
        'allowance',NULL,NULL,'plus',0,NULL)`).run(HOME, file);
      markCodexLedgerCopiesDirty(f.db, [{ home: HOME, path: file }]);
    }).immediate();
    const seen = [active("acct-a")];
    for (let step = 0; step < 100; step++) {
      const result = processCodexLedgerBatch(f.db, { ...f.options(), batchSize: 1 });
      seen.push(active("acct-a"));
      if (result.ready || !result.progressed) break;
    }
    expect(new Set(seen)).toEqual(new Set([1_200_000]));
    expect(active("acct-b")).toBe(0);
  } finally { f.db.close(); }
});

test("a long copy crossing an ownership boundary is read in linear time (perf guard)", () => {
  const f = createFixture();
  try {
    f.db.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0040_account_periods.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    for (const [from, until, account] of [["2000-01-01", "2026-04-02T09:00:00.000Z", "acct-a"], ["2026-04-02T09:00:00.000Z", null, "acct-b"]] as const)
      f.db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
        VALUES('codex','codex/pc/profile',?,?,?,'declared',0,'fixture')`).run(from, until, account);
    // 64 000 calls a second apart on one day (one copy, day and dimension) that the boundary cuts: read call by call.
    const start = Date.parse("2026-04-02T00:00:00.000Z"), calls = 64_000;
    f.publish("archive/sessions/rollout-0.jsonl", Array.from({ length: calls }, (_, index) => ({ ts: new Date(start + index * 1_000).toISOString(),
      input: 10, output: 2 })), false);
    expect(f.fill().ready).toBe(true);
    const resolver = loadAccountResolver(f.db);
    const started = performance.now();
    const read = readCodexOwnedDays(f.db, resolver, 15);
    const elapsed = performance.now() - started;
    expect([...read.values()].reduce((sum, row) => sum + row.calls, 0)).toBe(calls);
    // Each owner's calls follow one another by 1 s, but the first call after the boundary has no predecessor of its own.
    expect([...read.values()].reduce((sum, row) => sum + row.active_ms, 0)).toBe((calls - 2) * 1_000);
    // Linear work takes a fraction of a second; a scan of the chain per call takes several seconds at this length.
    expect(elapsed).toBeLessThan(1_500);
  } finally { f.db.close(); }
}, 120_000);
