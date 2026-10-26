import { expect, test } from "bun:test";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { TIMED_SUMS } from "../db/usage-ledger";
import { Database as Connection, type Database } from "../db/sqlite";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import { loadAccountResolver } from "./account-resolver";
import { readModelSpeed } from "./model-speed";

const timed = TIMED_SUMS.join(",");
// Keyed by the dimension's key: a rebuild may number the dimensions differently.
const sums = (db: Database) => ({
  days: db.query(`SELECT x.day,m.key dim,x.calls,${TIMED_SUMS.map(c => `x.${c}`).join(",")} FROM usage_ledger_days x
    JOIN usage_ledger_dims m ON m.id=x.dim_id WHERE x.provider='claude' ORDER BY x.day,m.key`).all(),
  hours: db.query(`SELECT x.day,x.hour,m.key dim,x.calls,${TIMED_SUMS.map(c => `x.${c}`).join(",")} FROM usage_ledger_hours x
    JOIN usage_ledger_dims m ON m.id=x.dim_id WHERE x.provider='claude' ORDER BY x.day,x.hour,m.key`).all(),
});
/** Everything a response time must not touch: the facts with their valuations, the untimed sums and the window marks. */
const untimed = (db: Database) => ({
  facts: db.query(`SELECT row_id,identity,fingerprint,copy_state,dim_id,std_key,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,
    glb_usd,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all(),
  days: db.query(`SELECT * FROM usage_ledger_days WHERE provider='claude' ORDER BY day,dim_id`).all()
    .map(row => Object.fromEntries(Object.entries(row as object).filter(([key]) => !key.startsWith("timed_")))),
  dims: db.query("SELECT * FROM usage_ledger_dims WHERE provider='claude' ORDER BY id").all(),
  marks: db.query("SELECT COUNT(*) n FROM window_answer_marks").get(),
  dirty: db.query("SELECT * FROM window_usage_dirty ORDER BY provider,account,counter,from_ms").all(),
});
/** A full rebuild of the same, frozen facts: the reference the incremental timed sums must equal. */
function refilled(db: Database, rates: Parameters<typeof fillUsageLedger>[2]) {
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state"])
    db.query(`DELETE FROM ${table} WHERE provider='claude'`).run();
  fillUsageLedger(db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
  return sums(db);
}
/** Sums recomputed from the canonical facts directly (speed = out * 1000 / ms of these, never a mean of ratios). */
function factReference(db: Database) {
  return db.query(`SELECT day, dim_id,
      SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN 1 ELSE 0 END) timed_calls, SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN q_out ELSE 0 END) timed_out,
      SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN resp_ms ELSE 0 END) timed_ms,
      SUM(CASE WHEN resp_ms>0 AND usage_valid=1 AND q_out>=256 THEN 1 ELSE 0 END) timed_long_calls,
      SUM(CASE WHEN resp_ms>0 AND usage_valid=1 AND q_out>=256 THEN q_out ELSE 0 END) timed_long_out,
      SUM(CASE WHEN resp_ms>0 AND usage_valid=1 AND q_out>=256 THEN resp_ms ELSE 0 END) timed_long_ms
    FROM usage_ledger_facts WHERE provider='claude' AND copy_state='canonical' AND accounting=1 GROUP BY day, dim_id ORDER BY day, dim_id`).all();
}
const daysTimed = (db: Database) => db.query(`SELECT day,dim_id,${timed} FROM usage_ledger_days WHERE provider='claude' ORDER BY day,dim_id`).all();

test("response times reach the facts and timed sums without repricing, and equal a full rebuild", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    expect(usageLedgerState(db, "claude")?.status).toBe("ready");
    // A ledger built before parser 6: no call is timed.
    expect(daysTimed(db).every(row => TIMED_SUMS.every(column => (row as Record<string, number>)[column] === 0))).toBe(true);
    const before = untimed(db);
    // What the timing backfill writes: times only, in place (every copy, the duplicates' differently).
    db.exec(`UPDATE claude_events SET resp_ms = 400 + (id * 7919) % 30000;
      UPDATE claude_events SET resp_ms = NULL WHERE id % 5 = 0`);
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "claude")).toMatchObject({ phase: "reconcile", status: "pending" });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(untimed(db)).toEqual(before);
    const incremental = sums(db);
    expect(incremental.days.some(row => (row as { timed_calls: number }).timed_calls > 0)).toBe(true);
    expect(daysTimed(db)).toEqual(factReference(db));
    // A restart without changes reads the stored sums: nothing is left to reconcile.
    expect(stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT)).toMatchObject({ complete: true, processed: 0 });
    expect(refilled(db, fixture.rates)).toEqual(incremental);
  } finally { fixture.teardown(); }
}, 60_000);

test("a new call, an identical retry, a correction and a retraction keep the timed sums equal to a full rebuild", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    db.exec("UPDATE claude_events SET resp_ms = 1000 + id * 13");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const insert = () => db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,
        in_uncached,out_total,resp_ms) VALUES ('fixture-primary','timed-new','s',?,'2026-09-18T08:00:00.000Z','claude-sonnet-fixture','standard',?,
        'cli','2.1.0',1000,600,2000) ON CONFLICT(store,call_id) DO UPDATE SET resp_ms=excluded.resp_ms`)
      .run(`${ARCHIVE_LOGICAL_ROOT}/claude/${ACCOUNTS.a}/timed-new.jsonl`, ACCOUNTS.a);
    insert();
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const added = sums(db), revision = usageLedgerState(db, "claude")!.revision;
    expect(daysTimed(db)).toEqual(factReference(db));
    // The identical retry changes no row: nothing to reconcile, the sums and the ledger revision stay.
    insert();
    expect(stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT)).toMatchObject({ complete: true });
    expect(sums(db)).toEqual(added);
    expect(usageLedgerState(db, "claude")!.revision).toBe(revision);
    // A corrected entry (tokens and time) and a retracted one: these re-sum their days, window marks included.
    const marks = untimed(db).marks;
    db.exec(`UPDATE claude_events SET out_total = out_total + 300, resp_ms = resp_ms + 500 WHERE call_id = 'timed-new';
      DELETE FROM claude_events WHERE id = (SELECT MIN(id) FROM claude_events WHERE resp_ms IS NOT NULL AND call_id <> 'timed-new')`);
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const corrected = sums(db);
    expect(corrected).not.toEqual(added);
    expect(untimed(db).marks).not.toEqual(marks);
    expect(daysTimed(db)).toEqual(factReference(db));
    expect(refilled(db, fixture.rates)).toEqual(corrected);
  } finally { fixture.teardown(); }
}, 60_000);

test("model speed reads the owned hours: ratio of sums per model, coverage of timed calls", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    db.exec("UPDATE claude_events SET resp_ms = 2000 WHERE id % 2 = 0");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const plan = loadAccountResolver(db).plan("claude", ACCOUNTS.a);
    const days = readModelSpeed(db, "claude", plan, { grain: "day" });
    const hours = readModelSpeed(db, "claude", plan, { grain: "hour" });
    expect(days.length).toBe(1);
    const [model] = days;
    expect(model!.model).toBe("claude-sonnet-fixture");
    expect(model!.total.timed_calls).toBeGreaterThan(0);
    expect(model!.total.timed_calls).toBeLessThan(model!.total.calls);
    expect(model!.total.speed).toBe(model!.total.timed_out * 1000 / model!.total.timed_ms);
    expect(model!.total.coverage).toBe(model!.total.timed_calls / model!.total.calls);
    // The hour grain re-buckets the same owned hours: equal totals.
    expect(hours[0]!.total).toEqual(model!.total);
    for (const point of model!.points) expect(point.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const point of hours[0]!.points) expect(point.at).toMatch(/T\d{2}:00:00\.000Z$/);
    // Another account's calls are not this account's.
    const other = readModelSpeed(db, "claude", loadAccountResolver(db).plan("claude", ACCOUNTS.b), { grain: "day" });
    expect(other[0]?.total.calls ?? 0).not.toBe(model!.total.calls);
  } finally { fixture.teardown(); }
}, 60_000);

test("a restart in the middle of a paged reconciliation of time-only and content changes ends as a full rebuild", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  let reopened: Connection | null = null;
  try {
    const db = fixture.db;
    db.exec("UPDATE claude_events SET resp_ms = 1000 + id * 13");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    // On the busiest day: some rows change only their time, others their tokens too.
    const day = (db.query("SELECT substr(ts,1,10) day FROM claude_events GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1").get() as { day: string }).day;
    db.query("UPDATE claude_events SET resp_ms = resp_ms + 7 WHERE substr(ts,1,10)=? AND id % 2 = 0").run(day);
    db.query("UPDATE claude_events SET out_total = out_total + 11, resp_ms = resp_ms + 3 WHERE substr(ts,1,10)=? AND id % 2 = 1").run(day);
    // Two pages of two rows, then the process stops: the page position and the time-only days are in the bookmark.
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 2);
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 2);
    expect(String((db.query("SELECT bookmark FROM usage_ledger_state WHERE provider='claude'").get() as { bookmark: string }).bookmark))
      .toContain('"after"');
    reopened = new Connection(fixture.dbPath);
    fillUsageLedger(reopened, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const resumed = sums(reopened);
    expect(daysTimed(reopened)).toEqual(factReference(reopened));
    expect(refilled(reopened, fixture.rates)).toEqual(resumed);
  } finally { reopened?.close(); fixture.teardown(); }
}, 60_000);
