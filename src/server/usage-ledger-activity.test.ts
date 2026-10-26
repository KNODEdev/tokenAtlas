/**
 * Stored activity in the usage ledger (docs/stored-activity-plan-2026-10-07.md, steps 2-3): the producer's gaps,
 * mixed-session list and day activity sums equal the oracle (activity-oracle.ts) and a full refill after any
 * sequence of out-of-order inserts, deletions, timestamp corrections, recovered sessions and canonical flips; a late
 * call touches only its own day and its chain successor's day; a restart does nothing; an interrupted regap resumes
 * without duplicates. Synthetic, self-contained databases; no production data is read.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { Database } from "../db/sqlite";
import { ACTIVITY_CUTOFF_MINUTES, activityColumn } from "../db/usage-ledger";
import { createTestDatabase } from "../sync/test-support";
import { oracleActivity, oracleGaps, oracleIntervalUnion, type OracleFact } from "./activity-oracle";
import { RATES } from "./claude-code-capacity.fixture";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import type { RateCard } from "./pricing";
import { readActivityDays } from "./ledger-sums";

const GLM_RATES: RateCard = { ...RATES, vendors: { ...RATES.vendors, zai: { source: "synthetic", models: { "glm-x": { in_uncached: 1,
  in_cache_read: 0.1, in_cache_write_5m: 1, in_cache_write_1h: 1, out_total: 2 } } } } };

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

function setup() {
  const { directory, dbPath } = createTestDatabase();
  let db = new Database(dbPath);
  const open = () => {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    installAnalysisTracking(db);
    installFactDayRevisions(db);
  };
  open();
  return {
    get db() { return db; },
    reopen() { db.close(true); db = new Database(dbPath); open(); return db; },
    teardown() { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
  };
}

interface Call { id?: number; store?: string; call: string; session: string | null; ts: string; account?: string; project?: string | null }
function insertClaude(db: Database, call: Call): number {
  const account = call.account ?? "account-a";
  db.query(`INSERT INTO claude_events (id,store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id)
    VALUES (?,?,?,?,?,?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',1000,100,?)`).run(call.id ?? null, call.store ?? "primary", call.call,
    call.session, `${ARCHIVE_LOGICAL_ROOT}/claude/${account}/${call.session ?? "none"}.jsonl`, call.ts, account, call.project ?? null);
  return Number((db.query("SELECT last_insert_rowid() id").get() as { id: number }).id);
}
const fill = (db: Database, provider = "claude", card: RateCard = RATES) => fillUsageLedger(db, provider, card, ARCHIVE_LOGICAL_ROOT);

type Fact = OracleFact & { id: number; source: string | null; account_key: string | null; home: string; dim_id: number | null; day: string; src_day: string;
  gap_ms: number | null; gap_from: string | null; accounting: number };
const factsOf = (db: Database, provider: string) => db.query(`SELECT row_id id, identity, ts, session, copy_state, eligible, vendor, source,
  account_key, home, dim_id, day, src_day, gap_ms, gap_from, accounting FROM usage_ledger_facts WHERE provider=?`).all(provider) as Fact[];
// The owner of a chain; an OpenCode-other call's is also its home.
const chainOwner = (fact: Fact) => JSON.stringify([fact.source, fact.account_key, ...(fact.eligible ? [] : [fact.home])]);
/** Sessions whose canonical chained calls fall into more than one chain, computed independently of the producer. */
function referenceMixed(provider: string, facts: Fact[]): Set<string> {
  const keys = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (fact.copy_state !== "canonical" || !fact.session) continue;
    const kind = fact.eligible ? "e" : provider === "glm" && !["zai", "z-ai"].includes(fact.vendor) ? "o" : null;
    if (!kind) continue;
    (keys.get(fact.session) ?? keys.set(fact.session, new Set()).get(fact.session)!).add(`${chainOwner(fact)}|${kind}`);
  }
  return new Set([...keys].filter(([, set]) => set.size > 1).map(([session]) => session));
}
type DayActivity = Record<string, number | string | null>;
/** Stored activity per (day, dimension key), the dimension named by its key text so a refill compares. */
function storedActivity(db: Database, provider: string): Map<string, DayActivity> {
  const rows = db.query(`SELECT d.day, m.key, ${ACTIVITY_CUTOFF_MINUTES.map(activityColumn).join(", ")}, d.gap_from_ts, d.src_shift_calls
    FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider=?`).all(provider) as Array<DayActivity & { day: string; key: string }>;
  return new Map(rows.map(({ day, key, ...rest }) => [`${day}|${key}`, rest]));
}

/** The producer's stored gaps, mixed list and day sums against the oracle and an independent count. */
function expectMatchesOracle(db: Database, provider = "claude"): { gaps: number; activeDays: number; mixed: number } {
  const facts = factsOf(db, provider);
  const gaps = oracleGaps(provider, facts, chainOwner);
  for (const fact of facts) {
    const expected = gaps.get(fact.id);
    expect({ id: fact.id, gap: fact.gap_ms, from: fact.gap_from }).toEqual({ id: fact.id, gap: expected?.gapMs ?? null, from: expected?.from ?? null });
  }
  const mixed = referenceMixed(provider, facts);
  const stored = new Set((db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider=?").all(provider) as Array<{ session: string }>)
    .map(row => row.session));
  expect([...stored].sort()).toEqual([...mixed].sort());
  const keyOf = new Map((db.query("SELECT id, key FROM usage_ledger_dims WHERE provider=?").all(provider) as Array<{ id: number; key: string }>)
    .map(row => [row.id, row.key]));
  const expected = new Map<string, DayActivity>();
  const row = (key: string) => expected.get(key) ?? expected.set(key, Object.fromEntries([...ACTIVITY_CUTOFF_MINUTES.map(m => [activityColumn(m), 0]),
    ["gap_from_ts", null], ["src_shift_calls", 0]])).get(key)!;
  const counted = facts.filter(fact => !fact.session || !mixed.has(fact.session));
  const expectedIntervals = new Map<string, Array<[number, number]>>();
  for (const fact of counted) {
    const gap = gaps.get(fact.id);
    if (!gap || gap.gapMs <= 0 || !fact.accounting) continue;
    for (const cutoff of ACTIVITY_CUTOFF_MINUTES) {
      const key = JSON.stringify([fact.day, fact.dim_id, cutoff]), until = Date.parse(fact.ts);
      const spans = expectedIntervals.get(key) ?? [];
      spans.push([until - Math.min(gap.gapMs, cutoff * 60000), until]); expectedIntervals.set(key, spans);
    }
  }
  const intervals = db.query("SELECT day,dim_id,cutoff,intervals FROM usage_activity_intervals WHERE provider=?").all(provider) as
    Array<{ day: string; dim_id: number; cutoff: number; intervals: string }>;
  expect(new Map(intervals.map(r => [JSON.stringify([r.day,r.dim_id,r.cutoff]), JSON.parse(r.intervals)])))
    .toEqual(new Map([...expectedIntervals].map(([key, spans]) => [key, oracleIntervalUnion(spans)])));
  for (const minutes of ACTIVITY_CUTOFF_MINUTES)
    for (const [key, ms] of oracleActivity(provider, counted, { cutoffMinutes: minutes, ownerOf: chainOwner, groupOf: fact => String(fact.dim_id) })) {
      const [day, , dim] = key.split("\u0000");
      row(`${day}|${keyOf.get(Number(dim))}`)[activityColumn(minutes)] = ms;
    }
  for (const fact of facts) {
    if (fact.copy_state !== "canonical") continue;
    const target = row(`${fact.day}|${keyOf.get(fact.dim_id!)}`);
    if (fact.src_day !== fact.day) target.src_shift_calls = Number(target.src_shift_calls) + 1;
    const gap = gaps.get(fact.id);
    if (gap && gap.gapMs > 0 && !(fact.session && mixed.has(fact.session)) && (target.gap_from_ts === null || gap.from < String(target.gap_from_ts)))
      target.gap_from_ts = gap.from;
  }
  const actual = storedActivity(db, provider);
  for (const [key, values] of expected) expect({ key, ...actual.get(key) }).toEqual({ key, ...values });
  // Every other day row carries no activity.
  for (const [key, values] of actual) if (!expected.has(key))
    expect({ key, ...values }).toEqual({ key, ...Object.fromEntries([...ACTIVITY_CUTOFF_MINUTES.map(m => [activityColumn(m), 0]),
      ["gap_from_ts", null], ["src_shift_calls", 0]]) });
  return { gaps: gaps.size, activeDays: [...expected.values()].filter(values => Number(values[activityColumn(60)]) > 0).length, mixed: mixed.size };
}
/** Gaps per fact and activity per day row of a full refill from the same source rows. */
function refill(db: Database, provider = "claude", card: RateCard = RATES) {
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state", "usage_ledger_mixed_sessions"])
    db.query(`DELETE FROM ${table} WHERE provider=?`).run(provider);
  fill(db, provider, card);
}
const gapsByRow = (db: Database, provider = "claude") =>
  (db.query("SELECT row_id, gap_ms, gap_from FROM usage_ledger_facts WHERE provider=? ORDER BY row_id").all(provider));
const dirty = (db: Database, provider = "claude") =>
  db.query("SELECT kind, value FROM usage_ledger_dirty WHERE provider=? ORDER BY kind, value").all(provider) as Array<{ kind: string; value: string }>;

const iso = (ms: number) => new Date(ms).toISOString();
const START = Date.parse("2026-09-10T00:00:00.000Z");

for (const seed of [11, 12, 13, 14]) {
  test(`incremental gaps and day activity equal the oracle and a full refill under random edits (seed ${seed})`, () => {
    const fixture = setup();
    try {
      const random = prng(seed), db = fixture.db;
      const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
      const sessions = ["s1", "s2", "s3", "s4", "s5"];
      let serial = 0;
      const randomTs = () => {
        // Five-minute grid with seconds, so equal instants and both short and capped gaps occur; a few preserved offsets.
        const at = START + Math.floor(random() * 6 * 24 * 12) * 300_000 + (random() < 0.3 ? 0 : Math.floor(random() * 200) * 1000);
        return random() < 0.05 ? iso(at + 7_200_000).replace("Z", "+02:00").replace(/\.\d{3}/, "") : iso(at);
      };
      const add = (overrides: Partial<Call> = {}) => insertClaude(db, { call: `c${serial++}`, session: random() < 0.08 ? null : pick(sessions),
        ts: randomTs(), project: pick(["alpha", "beta", null]), ...overrides });
      // Inserted in id order, at random instants: arrival order is not time order.
      for (let i = 0; i < 90; i++) add();
      fill(db);
      expectMatchesOracle(db);
      let mirrored = 0, conflicts = 0;
      for (let round = 0; round < 6; round++) {
        const ids = () => (db.query("SELECT id FROM claude_events ORDER BY id").all() as Array<{ id: number }>).map(row => row.id);
        // Late calls into existing sessions.
        for (let i = 0; i < 6; i++) add();
        // Deletions.
        for (let i = 0; i < 3; i++) db.query("DELETE FROM claude_events WHERE id=?").run(pick(ids()));
        // Timestamp corrections.
        for (let i = 0; i < 3; i++) db.query("UPDATE claude_events SET ts=? WHERE id=?").run(randomTs(), pick(ids()));
        // A recovered or changed session id.
        db.query("UPDATE claude_events SET session_id=? WHERE id=?").run(pick([...sessions, null]), pick(ids()));
        // A second copy of an existing call carrying another session, sometimes read with a smaller row id (it then becomes canonical).
        // A key like "10003" sorts before most original keys ("57"): that copy becomes canonical.
        const maxId = (db.query("SELECT MAX(id) n FROM claude_events").get() as { n: number }).n;
        const copyId = random() < 0.5 ? null : 10 ** String(maxId).length + round;
        db.query(`INSERT INTO claude_events (id,store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id)
          SELECT ?,?,call_id,?,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id FROM claude_events WHERE id=?`)
          .run(copyId, `mirror-${round}`, pick(sessions), pick(ids()));
        // A copy whose counters disagree: its call becomes a conflict, outside every chain (until the next edit maybe resolves it).
        if (round % 3 === 1) db.query("UPDATE claude_events SET out_total=out_total+1 WHERE id=(SELECT MAX(id) FROM claude_events WHERE store LIKE 'mirror%')").run();
        // A session continued under a second owner (another source): it becomes mixed.
        if (round % 2 === 0) add({ account: "account-b", session: pick(sessions) });
        // The canonical copy of a duplicated call disappears: the other copy, with its session, takes over.
        const duplicated = db.query(`SELECT MIN(f.row_id) id FROM usage_ledger_facts f WHERE f.provider='claude' AND f.copy_state='canonical'
          AND f.copies>1`).get() as { id: number | null };
        if (duplicated.id !== null) db.query("DELETE FROM claude_events WHERE id=?").run(duplicated.id);
        fill(db);
        expect(dirty(db)).toEqual([]);
        expectMatchesOracle(db);
        const seen = db.query(`SELECT SUM(f.copy_state='canonical' AND e.store LIKE 'mirror%') mirrored, SUM(f.copy_state='conflict') conflicts
          FROM usage_ledger_facts f JOIN claude_events e ON e.id=f.row_id WHERE f.provider='claude'`).get() as { mirrored: number; conflicts: number };
        mirrored += seen.mirrored; conflicts += seen.conflicts;
      }
      // Copies from another store did take over as canonical, and some copies came to disagree (conflicts, outside every chain).
      expect(mirrored).toBeGreaterThan(0);
      expect(conflicts).toBeGreaterThan(0);
      const result = expectMatchesOracle(db);
      expect(result.gaps).toBeGreaterThan(40);
      expect(result.mixed).toBeGreaterThan(0);
      const incremental = { gaps: gapsByRow(db), days: storedActivity(db, "claude") };
      refill(db);
      expect(gapsByRow(db)).toEqual(incremental.gaps);
      expect(storedActivity(db, "claude")).toEqual(incremental.days);
    } finally { fixture.teardown(); }
  }, 120_000);
}

test("hand-checked chain: gaps, the cap per cutoff, the canonical flip to a copy with another session, two owners", () => {
  const fixture = setup();
  try {
    const db = fixture.db;
    insertClaude(db, { id: 1, call: "a", session: "s", ts: "2026-09-10T10:00:00.000Z" });
    insertClaude(db, { id: 2, call: "b", session: "s", ts: "2026-09-10T10:20:00.000Z" }); // 20 min
    insertClaude(db, { id: 3, call: "c", session: "s", ts: "2026-09-10T10:20:00.000Z" }); // same instant: 0
    insertClaude(db, { id: 4, call: "d", session: "s", ts: "2026-09-12T09:00:00.000Z" }); // two days later: every cutoff caps it
    insertClaude(db, { id: 5, call: "e", session: null, ts: "2026-09-10T10:25:00.000Z" }); // no session
    insertClaude(db, { id: 6, call: "f", session: "t", ts: "2026-09-10T10:30:00.000Z" });
    insertClaude(db, { id: 7, call: "g", session: "t", ts: "2026-09-10T10:33:00.000Z" }); // 3 min
    fill(db);
    const gap = (id: number) => db.query("SELECT gap_ms, gap_from FROM usage_ledger_facts WHERE provider='claude' AND row_id=?").get(id);
    expect([1, 2, 3, 4, 5, 6, 7].map(gap)).toEqual([
      { gap_ms: null, gap_from: null }, { gap_ms: 1_200_000, gap_from: "2026-09-10T10:00:00.000Z" },
      { gap_ms: 0, gap_from: "2026-09-10T10:20:00.000Z" }, { gap_ms: 168_000_000, gap_from: "2026-09-10T10:20:00.000Z" },
      { gap_ms: null, gap_from: null }, { gap_ms: null, gap_from: null }, { gap_ms: 180_000, gap_from: "2026-09-10T10:30:00.000Z" }]);
    const sums = (day: string) => db.query(`SELECT ${ACTIVITY_CUTOFF_MINUTES.map(m => `SUM(${activityColumn(m)}) m${m}`).join(", ")}, MIN(gap_from_ts) from_ts
      FROM usage_ledger_days WHERE provider='claude' AND day=?`).get(day);
    // 09-10: 20 min capped per cutoff plus 3 min; 09-12: one gap of 46.5 h, capped.
    expect(sums("2026-09-10")).toEqual({ m5: 480_000, m10: 780_000, m15: 1_080_000, m30: 1_380_000, m45: 1_380_000, m60: 1_380_000,
      from_ts: "2026-09-10T10:00:00.000Z" });
    expect(sums("2026-09-12")).toEqual({ m5: 300_000, m10: 600_000, m15: 900_000, m30: 1_800_000, m45: 2_700_000, m60: 3_600_000,
      from_ts: "2026-09-10T10:20:00.000Z" });
    expectMatchesOracle(db);
    // A second copy of b in session t, with a larger key: b stays in s. Then b's own row goes: the copy becomes canonical in t.
    insertClaude(db, { id: 20, store: "mirror", call: "b", session: "t", ts: "2026-09-10T10:20:00.000Z" });
    fill(db);
    expect(gap(2)).toEqual({ gap_ms: 1_200_000, gap_from: "2026-09-10T10:00:00.000Z" });
    db.query("DELETE FROM claude_events WHERE id=2").run();
    fill(db);
    // s: a, c (20 min), d; t: b-copy at 10:20, f (10 min), g.
    expect([1, 3, 4, 20, 6, 7].map(gap)).toEqual([
      { gap_ms: null, gap_from: null }, { gap_ms: 1_200_000, gap_from: "2026-09-10T10:00:00.000Z" },
      { gap_ms: 168_000_000, gap_from: "2026-09-10T10:20:00.000Z" }, { gap_ms: null, gap_from: null },
      { gap_ms: 600_000, gap_from: "2026-09-10T10:20:00.000Z" }, { gap_ms: 180_000, gap_from: "2026-09-10T10:30:00.000Z" }]);
    expectMatchesOracle(db);
    // Session t continued by another owner: t is mixed and its calls leave the stored sums; removing that call restores them.
    const before = sums("2026-09-10") as Record<string, number>;
    insertClaude(db, { id: 30, call: "h", session: "t", ts: "2026-09-10T10:40:00.000Z", account: "account-b" });
    fill(db);
    expect(db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='claude'").all()).toEqual([{ session: "t" }]);
    expect((sums("2026-09-10") as Record<string, number>).m15).toBe(900_000);
    expect(before.m15).toBe(900_000 + 600_000 + 180_000);
    expectMatchesOracle(db);
    db.query("DELETE FROM claude_events WHERE id=30").run();
    fill(db);
    expect(db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='claude'").all()).toEqual([]);
    expect(sums("2026-09-10")).toEqual(before);
    expectMatchesOracle(db);
  } finally { fixture.teardown(); }
}, 60_000);

test("a late call dirties only its own day and its chain successor's day; the successor's day keeps its tokens", () => {
  const fixture = setup();
  try {
    const db = fixture.db;
    insertClaude(db, { call: "p1", session: "s", ts: "2026-09-10T10:00:00.000Z" });
    insertClaude(db, { call: "p2", session: "s", ts: "2026-09-10T10:10:00.000Z" });
    insertClaude(db, { call: "n1", session: "s", ts: "2026-09-12T09:00:00.000Z" });
    insertClaude(db, { call: "n2", session: "s", ts: "2026-09-12T09:04:00.000Z" });
    for (const [index, day] of ["2026-09-09", "2026-09-11", "2026-09-13"].entries()) {
      insertClaude(db, { call: `o${index}a`, session: `o${index}`, ts: `${day}T08:00:00.000Z` });
      insertClaude(db, { call: `o${index}b`, session: `o${index}`, ts: `${day}T08:07:00.000Z` });
    }
    fill(db);
    const rows = () => new Map((db.query(`SELECT d.*, m.key FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id
      WHERE d.provider='claude'`).all() as Array<Record<string, unknown>>).map(row => [`${row.day}|${row.key}`, row]));
    const before = rows();
    // Arrives late: between p2 (09-10) and n1 (09-12), on 09-11.
    insertClaude(db, { call: "late", session: "s", ts: "2026-09-11T12:00:00.000Z" });
    const seen = { day: new Set<string>(), activity: new Set<string>(), session: new Set<string>() };
    for (let turn = 0; turn < 1000; turn++) {
      for (const row of dirty(db)) seen[row.kind as keyof typeof seen]?.add(row.value);
      if (stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT).complete) break;
    }
    expect([...seen.day]).toEqual(["2026-09-11"]);
    expect([...seen.session]).toEqual(["s"]);
    expect([...seen.activity].sort()).toEqual(["2026-09-11", "2026-09-12"]);
    const after = rows();
    for (const [key, row] of after) {
      const day = String(row.day);
      if (day === "2026-09-11") continue;
      const prior = before.get(key)!;
      if (day !== "2026-09-12") { expect(row).toEqual(prior); continue; }
      // The successor's day: only its activity changed (n1's gap is now 21 h from the late call, capped either way, so equal sums).
      const { gap_from_ts: from, ...rest } = row, { gap_from_ts: priorFrom, ...priorRest } = prior;
      expect(rest).toEqual(priorRest);
      expect([priorFrom, from]).toEqual(["2026-09-10T10:10:00.000Z", "2026-09-11T12:00:00.000Z"]);
    }
    expectMatchesOracle(db);
  } finally { fixture.teardown(); }
}, 60_000);

test("a restart with no changes does no work and reprices nothing", () => {
  const fixture = setup();
  try {
    for (let i = 0; i < 40; i++) insertClaude(fixture.db, { call: `c${i}`, session: `s${i % 4}`, ts: iso(START + i * 420_000) });
    fill(fixture.db);
    const state = usageLedgerState(fixture.db, "claude");
    const db = fixture.reopen();
    const changes = () => (db.query("SELECT total_changes() n").get() as { n: number }).n;
    const start = changes();
    expect(stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    expect(changes()).toBe(start);
    expect(usageLedgerState(db, "claude")).toEqual(state);
    expect(dirty(db)).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("the migration's backfill keeps the ledger ready, resumes after an interrupted step without duplicates and then publishes", () => {
  const fixture = setup();
  try {
    let db = fixture.db;
    const random = prng(7);
    for (let i = 0; i < 160; i++) insertClaude(db, { call: `c${i}`, session: `s${Math.floor(random() * 12)}`,
      account: random() < 0.1 ? "account-b" : "account-a", ts: iso(START + Math.floor(random() * 4 * 24 * 60) * 60_000) });
    fill(db);
    const reference = { gaps: gapsByRow(db), days: storedActivity(db, "claude"), mixed: db.query("SELECT * FROM usage_ledger_mixed_sessions").all() };
    expect(reference.mixed.length).toBeGreaterThan(0);
    // The state 0066 leaves: no gaps, no sums, every session and every day row queued, activity unpublished.
    db.exec(`UPDATE usage_ledger_facts SET gap_ms=NULL, gap_from=NULL;
      UPDATE usage_ledger_days SET ${ACTIVITY_CUTOFF_MINUTES.map(m => `${activityColumn(m)}=0`).join(", ")}, gap_from_ts=NULL, src_shift_calls=0;
      DELETE FROM usage_ledger_mixed_sessions;
      UPDATE usage_ledger_state SET activity_published=0;
      INSERT OR IGNORE INTO usage_ledger_dirty SELECT DISTINCT provider,'session',session FROM usage_ledger_facts WHERE session IS NOT NULL;
      INSERT OR IGNORE INTO usage_ledger_dirty SELECT DISTINCT provider,'activity',day FROM usage_ledger_days;`);
    const revision = usageLedgerState(db, "claude")!.revision;
    // A step that fails half-way rolls back as a whole.
    const victim = (db.query("SELECT row_id FROM usage_ledger_facts WHERE provider='claude' AND session='s5' ORDER BY ts LIMIT 1 OFFSET 1").get() as
      { row_id: number }).row_id;
    db.exec(`CREATE TEMP TRIGGER interrupt BEFORE UPDATE OF gap_ms ON main.usage_ledger_facts WHEN NEW.row_id=${victim}
      BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
    let interrupted = false;
    for (let turn = 0; turn < 1000 && !interrupted; turn++) {
      const queued = dirty(db).length;
      try { stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT, 3); }
      catch (error) { expect(String(error)).toContain("interrupted"); expect(dirty(db).length).toBe(queued); interrupted = true; }
      // Token sums stay readable and the ledger stays ready while activity is prepared.
      expect(usageLedgerState(db, "claude")?.status).toBe("ready");
    }
    expect(interrupted).toBe(true);
    // Restart: a new connection, without the trigger and with fresh step sizes.
    db = fixture.reopen();
    expect((db.query("SELECT activity_published p FROM usage_ledger_state WHERE provider='claude'").get() as { p: number }).p).toBe(0);
    fill(db);
    const state = db.query("SELECT status, activity_published, revision, published_revision FROM usage_ledger_state WHERE provider='claude'").get();
    expect(state).toEqual({ status: "ready", activity_published: 1, revision: revision + 1, published_revision: revision + 1 });
    expect(gapsByRow(db)).toEqual(reference.gaps);
    expect(storedActivity(db, "claude")).toEqual(reference.days);
    expect(db.query("SELECT * FROM usage_ledger_mixed_sessions").all()).toEqual(reference.mixed);
    expectMatchesOracle(db);
  } finally { fixture.teardown(); }
}, 120_000);

test("GLM: plan calls and OpenCode-other calls chain separately; a session with both is mixed", () => {
  const fixture = setup();
  try {
    const db = fixture.db;
    const insert = (id: number, session: string, ts: string, provider: string) => db.query(`INSERT INTO oc_events(id,store,message_id,session_id,ts,model,provider,
      in_tok,out_tok) VALUES (?,'oc',?,?,?,'glm-x',?,100,10)`).run(id, `m${id}`, session, ts, provider);
    insert(1, "plan", "2026-09-10T10:00:00.000Z", "zai");
    insert(2, "plan", "2026-09-10T10:06:00.000Z", "zai");
    insert(3, "other", "2026-09-10T11:00:00.000Z", "openrouter");
    insert(4, "other", "2026-09-10T11:02:00.000Z", "openrouter");
    insert(5, "both", "2026-09-10T12:00:00.000Z", "zai");
    insert(6, "both", "2026-09-10T12:01:00.000Z", "openrouter");
    insert(7, "both", "2026-09-10T12:03:00.000Z", "zai");
    fill(db, "glm", GLM_RATES);
    const gap = (id: number) => (db.query("SELECT gap_ms FROM usage_ledger_facts WHERE provider='glm' AND row_id=?").get(id) as { gap_ms: number | null }).gap_ms;
    expect([1, 2, 3, 4, 5, 6, 7].map(gap)).toEqual([null, 360_000, null, 120_000, null, null, 180_000]);
    expect(db.query("SELECT session FROM usage_ledger_mixed_sessions WHERE provider='glm'").all()).toEqual([{ session: "both" }]);
    expect((db.query("SELECT SUM(active_15m_ms) n FROM usage_ledger_days WHERE provider='glm'").get() as { n: number }).n).toBe(480_000);
    expectMatchesOracle(db, "glm");
  } finally { fixture.teardown(); }
}, 60_000);

test("OpenCode-other: two homes with the same session id never chain into each other (the owner is the home)", () => {
  const fixture = setup();
  try {
    const db = fixture.db;
    const insert = (id: number, store: string, ts: string) => db.query(`INSERT INTO oc_events(id,store,message_id,session_id,ts,model,provider,
      in_tok,out_tok) VALUES (?,?,?,'s',?,'or-x','openrouter',100,10)`).run(id, store, `m${id}`, ts);
    insert(1, "oc-home-1", "2026-09-10T10:00:00.000Z");
    insert(2, "oc-home-2", "2026-09-10T10:10:00.000Z");
    insert(3, "oc-home-2", "2026-09-10T10:14:00.000Z");
    fill(db, "glm", GLM_RATES);
    const every = { provider: "glm", account: "*", identityKeys: [], ranges: [], owns: () => true, days: () => [] };
    // Each home's first call has no predecessor; the second home's second call follows its first by 4 minutes.
    const read = readActivityDays(db, "glm", every, 15, {}, "o");
    expect([...read.values()].reduce((sum, ms) => sum + ms, 0)).toBe(240_000);
    const gaps = db.query("SELECT row_id, gap_ms FROM usage_ledger_facts WHERE provider='glm' ORDER BY row_id").all();
    expect(gaps).toEqual([{ row_id: 1, gap_ms: null }, { row_id: 2, gap_ms: null }, { row_id: 3, gap_ms: 240_000 }]);
    // A ledger whose chains bridged the homes (before migration 0071): the migration queues the sessions and the regap repairs them.
    db.exec(`UPDATE usage_ledger_facts SET gap_ms=600000, gap_from='2026-09-10T10:00:00.000Z' WHERE provider='glm' AND row_id=2;
      DELETE FROM usage_ledger_mixed_sessions WHERE provider='glm'`);
    db.exec(fs.readFileSync(new URL("../../drizzle/0071_opencode_chains_by_home.sql", import.meta.url), "utf8"));
    fill(db, "glm", GLM_RATES);
    expect(db.query("SELECT row_id, gap_ms FROM usage_ledger_facts WHERE provider='glm' ORDER BY row_id").all()).toEqual(gaps);
    expectMatchesOracle(db, "glm");
  } finally { fixture.teardown(); }
}, 60_000);
