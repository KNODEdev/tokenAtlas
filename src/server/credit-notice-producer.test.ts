import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { acknowledgeCreditNotices, CREDIT_NOTICE_SCHEMA_SQL, ensureCreditNoticeSchema, readOpenCreditNotices } from "../db/credit-notices";
import type { NoticePool } from "../shared/credit-notices";
import { advanceCreditNotices } from "./credit-notice-producer";
import { decodeNoticePools } from "./credit-notice-pools";
import { handleCreditNotices } from "./credit-notices-api";

afterEach(() => setSystemTime());

const DAY = 86_400_000;
const at = (day: number) => new Date(Date.UTC(2026, 9, 1) + day * DAY).toISOString();
const grant = (used: number, expires = at(30)): NoticePool => ({ key: "claude:iguana_necktie", kind: "grant", unit: "usd",
  granted: 250, used, remaining: 250 - used, remaining_text: null, unlimited: false, granted_at: null, expires_at: expires, items: null });

/** The real decoder is shared/credit-pools `decodeCreditPools`; the fixture stores pools ready-made. */
const decode = (_provider: string, extra: Record<string, unknown>) =>
  typeof extra.pools === "string" ? JSON.parse(extra.pools) as NoticePool[] : null;

function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE probe_windows (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, extra TEXT);
    CREATE TABLE current_probe_subjects (provider TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL,
      generated_at TEXT, next_refresh_at TEXT, PRIMARY KEY(provider, subject));`);
  ensureCreditNoticeSchema(db);
  return db;
}
let nextId = 1;
/** One probe round: a weekly reading with pools (or none) and a five-hour one without, published as the card. */
function publish(db: Database, day: number, pools: NoticePool[] | null, account = "claude-max-1") {
  const weekly = nextId++, hourly = nextId++;
  db.query("INSERT INTO probe_windows(id,ts,extra) VALUES(?,?,?)").run(weekly, at(day), JSON.stringify(pools ? { pools: JSON.stringify(pools) } : {}));
  db.query("INSERT INTO probe_windows(id,ts,extra) VALUES(?,?,?)").run(hourly, at(day), JSON.stringify({ severity: "normal" }));
  const data = JSON.stringify({ limits: [], __winners: { weekly: { id: weekly }, hourly: { id: hourly } } });
  db.query(`INSERT INTO current_probe_subjects(provider,subject,data,generated_at) VALUES('claude',?,?,?)
    ON CONFLICT(provider,subject) DO UPDATE SET data=excluded.data,generated_at=excluded.generated_at`).run(account, data, at(day));
}
const open = (db: Database, day: number) => readOpenCreditNotices(db, Date.parse(at(day))).map(row => `${row.kind}:${row.amount}`);
const advance = (db: Database, day: number) => advanceCreditNotices(db, { decode, now: () => Date.parse(at(day)) });

test("notices follow the published card: baseline, receipt, rolling spend, acknowledgement and no rework", () => {
  const db = database();
  publish(db, 1, []);
  expect(advance(db, 1)).toMatchObject({ accounts: 1, notices: 0 });
  publish(db, 2, [grant(0)]);
  advance(db, 2);
  expect(open(db, 2)).toEqual(["received:250"]);
  publish(db, 3, [grant(20)]);
  advance(db, 3);
  publish(db, 4, [grant(50)]);
  advance(db, 4);
  expect(open(db, 4)).toEqual(["spent:50", "received:250"]);
  // An unchanged card is no work; the same reading folded again writes nothing.
  expect(advance(db, 4)).toMatchObject({ accounts: 0, notices: 0 });
  db.query("UPDATE current_probe_subjects SET generated_at=?").run(at(4.5));
  expect(advance(db, 4.5)).toMatchObject({ accounts: 1, notices: 0 });
  acknowledgeCreditNotices(db, readOpenCreditNotices(db, Date.parse(at(4))).map(row => row.id), at(4));
  publish(db, 5, [grant(60)]);
  advance(db, 5);
  expect(open(db, 5)).toEqual(["spent:10"]);
  expect((db.query("SELECT count(*) AS n FROM credit_notices").get() as { n: number }).n).toBe(2);
});

test("a database built from the archive starts from the newest reading without replaying receipts", () => {
  const db = database();
  publish(db, 10, [grant(120)]);
  advance(db, 10);
  expect(open(db, 10)).toEqual([]);
  const state = db.query("SELECT baseline_at, baseline_used FROM credit_pool_state").get();
  expect(state).toEqual({ baseline_at: at(10), baseline_used: 120 });
});

test("expiry warnings are raised from the stored state and resolved when the grant is used up", () => {
  const db = database();
  publish(db, 10, [grant(0)]);
  advance(db, 10);
  publish(db, 20, [grant(50)]);
  advance(db, 20);
  // $5 a day leaves $150 of $250 at expiry on day 30.
  const warning = readOpenCreditNotices(db, Date.parse(at(20))).find(row => row.kind === "expiring");
  expect(warning).toMatchObject({ kind: "expiring", detail: { stage: "14d", remaining: 200 } });
  expect(warning!.amount).toBeCloseTo(150, 6);
  publish(db, 21, [grant(250)]);
  advance(db, 21);
  // The unacknowledged spend keeps adding up: $50, then $200.
  expect(open(db, 21)).toEqual(["spent:250"]);
  expect((db.query("SELECT resolved_at FROM credit_notices WHERE kind='expiring'").get() as { resolved_at: string }).resolved_at).toBe(at(21));
});

test("an expired grant with money left is reported as lost, once", () => {
  const db = database();
  publish(db, 10, [grant(0)]);
  advance(db, 10);
  publish(db, 29, [grant(200)]);
  advance(db, 29);
  publish(db, 31, []);
  advance(db, 31);
  publish(db, 32, []);
  advance(db, 32);
  expect(readOpenCreditNotices(db, Date.parse(at(32))).filter(row => row.kind === "expired_unused").map(row => row.amount)).toEqual([50]);
  expect(readOpenCreditNotices(db, Date.parse(at(32))).some(row => row.kind === "expiring")).toBe(false);
});

test("readings that state no pools and a refold onto an older reading write no notices", () => {
  const db = database();
  publish(db, 1, null);
  expect(advance(db, 1)).toMatchObject({ accounts: 1, notices: 0 });
  expect(db.query("SELECT reading_id FROM credit_pool_cursor").get()).toEqual({ reading_id: null });
  publish(db, 5, [grant(10)]);
  advance(db, 5);
  // A period correction publishes an older reading of another grant: the state is re-based silently.
  const older = nextId++;
  db.query("INSERT INTO probe_windows(id,ts,extra) VALUES(?,?,?)").run(older, at(3), JSON.stringify({ pools: JSON.stringify([grant(0, at(60))]) }));
  db.query("UPDATE current_probe_subjects SET data=?, generated_at=?").run(JSON.stringify({ __winners: { weekly: { id: older } } }), at(6));
  expect(advance(db, 6)).toMatchObject({ accounts: 1, notices: 0 });
  expect((db.query("SELECT identity FROM credit_pool_state").get() as { identity: string }).identity).toBe(`claude:iguana_necktie@${at(60)}`);
});

test("the migration creates the schema the register declares", () => {
  const migration = fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0074_credit_notices.sql"), "utf8");
  const normalize = (sql: string) => sql.split(/\r?\n/).filter(line => !line.trim().startsWith("--")).join("\n")
    .replace(/--> statement-breakpoint/g, "").replace(/\s+/g, " ").trim();
  expect(normalize(migration)).toBe(normalize(CREDIT_NOTICE_SCHEMA_SQL));
});

test("the API lists open notices under the subscription's name and marks them read", async () => {
  setSystemTime(new Date(at(2)));
  const db = database();
  db.exec("CREATE TABLE subscription_current (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  db.query("INSERT INTO subscription_current(id,data) VALUES(?,?)").run("claude-max-1", JSON.stringify({ label: "Claude Max" }));
  publish(db, 1, []);
  advance(db, 1);
  publish(db, 2, [grant(0)]);
  advance(db, 2);
  const listed = await (await handleCreditNotices(db, new Request("http://local/api/credit-notices"))).json() as
    { notices: Array<{ id: number; label: string; kind: string }> };
  expect(listed.notices.map(row => [row.label, row.kind])).toEqual([["Claude Max", "received"]]);
  const bad = await handleCreditNotices(db, new Request("http://local/api/credit-notices", { method: "POST", body: JSON.stringify({ ids: ["x"] }) }));
  expect(bad.status).toBe(400);
  const read = await handleCreditNotices(db, new Request("http://local/api/credit-notices",
    { method: "POST", body: JSON.stringify({ ids: listed.notices.map(row => row.id) }) }));
  expect(await read.json()).toEqual({ acknowledged: 1 });
  // Acknowledged rows stay stored; only the open list is empty.
  expect(readOpenCreditNotices(db, Date.now())).toEqual([]);
});

test("until pools are decoded the job only keeps its cursors and writes no notices", () => {
  const db = database();
  publish(db, 1, [grant(0)]);
  expect(advanceCreditNotices(db, { decode: () => null, now: () => Date.parse(at(1)) })).toMatchObject({ accounts: 1, notices: 0 });
  expect((db.query("SELECT count(*) AS n FROM credit_pool_state").get() as { n: number }).n).toBe(0);
});

test("the production decoder turns stored Claude raw meters into notices", () => {
  const db = database();
  const raw = (used: number | null) => ({ severity: "normal", "claude.raw.five_hour.utilization": 12,
    ...(used == null ? {} : { "claude.raw.iguana_necktie.limit_dollars": 250, "claude.raw.iguana_necktie.used_dollars": used,
      "claude.raw.iguana_necktie.resets_at": at(40) }) });
  const round = (day: number, extra: Record<string, unknown>) => {
    const weekly = nextId++, hourly = nextId++;
    db.query("INSERT INTO probe_windows(id,ts,extra) VALUES(?,?,?)").run(weekly, at(day), JSON.stringify(extra));
    db.query("INSERT INTO probe_windows(id,ts,extra) VALUES(?,?,?)").run(hourly, at(day), JSON.stringify({ severity: "normal" }));
    const data = JSON.stringify({ limits: [], __winners: { weekly: { id: weekly }, hourly: { id: hourly } } });
    db.query(`INSERT INTO current_probe_subjects(provider,subject,data,generated_at) VALUES('claude','claude-max-2',?,?)
      ON CONFLICT(provider,subject) DO UPDATE SET data=excluded.data,generated_at=excluded.generated_at`).run(data, at(day));
    advanceCreditNotices(db, { decode: decodeNoticePools, now: () => Date.parse(at(day)) });
  };
  round(1, raw(null));
  expect(open(db, 1)).toEqual([]);
  round(2, raw(0));
  expect(open(db, 2)).toEqual(["received:250"]);
  round(3, raw(20));
  expect(open(db, 3)).toEqual(["spent:20", "received:250"]);
});
