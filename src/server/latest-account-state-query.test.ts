import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { latestAccountState, type AppContext } from "./api";
import { LATEST_ACCOUNT_STATE_SQL } from "./latest-account-state-query.fixture";
import {
  FROZEN_ATTRIBUTED_PROBE_SQL,
  REFERENCE_ACCOUNT_STATE_SQL,
  overviewOracleGuard,
  sameRows,
} from "../../scripts/lib/overview-reference";

const databases: Database[] = [];
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  applyDrizzleMigrations(drizzle(db));
  // This frozen pre-W9 SQL oracle runs only against its historical column shape.
  db.exec("ALTER TABLE probe_windows ADD COLUMN era_unattributed INTEGER NOT NULL DEFAULT 0");
  return db;
}
afterEach(() => {
  Bun.gc(true);
  for (const db of databases.splice(0)) {
    (db as Database & { clearQueryCache(): void }).clearQueryCache();
    db.close(true);
  }
});
function add(db: Database, subject: string, ts: string, options: {
  provider?: string; kind?: string; group?: string | null; machine?: string | null;
  ok?: number | null; unattributed?: number | null; percent?: number | null; error?: string | null;
} = {}) {
  db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,scope,reported_percent_side,
    used_percent,ok,era_unattributed,machine,window_minutes,resets_at,error)
    VALUES (?,?,?,?,?,'subscription','used',?,?,?,?,300,'2026-09-06T18:00:00.000Z',?)`)
    .run(options.provider ?? 'codex', subject, ts, options.kind ?? 'primary', options.group === undefined ? 'codex' : options.group,
      options.percent === undefined ? 42 : options.percent, options.ok ?? null, options.unattributed ?? 0,
      options.machine === undefined ? 'PC-A' : options.machine, options.error ?? null);
}
function verify(db: Database) {
  const before = (db.query('SELECT total_changes() AS n').get() as { n: number }).n;
  const reference = db.query(REFERENCE_ACCOUNT_STATE_SQL).all() as Array<Record<string, unknown>>;
  const candidate = db.query(LATEST_ACCOUNT_STATE_SQL).all() as typeof reference;
  expect(sameRows(reference, candidate)).toBe(true);
  const keys = (rows: typeof reference) => rows.map(r => [r.account, r.limit_id, r.slot]);
  expect(keys(candidate)).toEqual(keys(reference));
  expect((db.query('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
  return candidate;
}

test('empty data and unavailable legacy schema preserve empty API results', () => {
  const db = fixture(); expect(verify(db)).toEqual([]);
  db.exec('DROP TABLE probe_windows');
  expect(latestAccountState({ sqlite: db } as AppContext)).toEqual([]);
});
test('historical subject SQL retains its lexical success and exact case behavior', () => {
  const db = fixture();
  add(db, 'codex1', '2026-09-06T10:00:00Z', { machine: 'PC-A' });
  add(db, 'codex1', '2026-09-06T11:00:00Z', { machine: 'PC-B', percent: 51 });
  add(db, 'codex1', '2026-09-06T12:00:00Z', { ok: 0, kind: 'error' });
  add(db, 'CODEX1', '2026-09-06T09:00:00Z');
  add(db, 'codex1', '2026-09-06T14:00:00Z', { provider: 'claude' });
  const rows = verify(db); expect(rows.length).toBe(2);
  expect(rows.find(r => r.account === 'codex1')).toMatchObject({ machine: 'PC-B', used_percent: 51 });
  // The frozen subject SQL is historical evidence; v2 source ownership is tested in current/v2.test.ts.
  expect(latestAccountState({ sqlite: db } as AppContext)).toEqual([]);
});
test('all slots at the latest timestamp remain, including the original outer ok predicate behavior', () => {
  const db = fixture(), ts = '2026-09-06T10:00:00Z';
  add(db, 'a', ts, { group: 'codex', kind: 'primary' });
  add(db, 'a', ts, { group: 'codex', kind: 'secondary', ok: 0, percent: null });
  add(db, 'a', ts, { group: 'fable', kind: 'primary', error: 'legacy-error-field' });
  add(db, 'a', ts, { group: 'spark', kind: 'primary' });
  add(db, 'a', ts, { kind: 'error', group: '-' });
  const rows = verify(db); expect(rows.length).toBe(4);
  expect(rows.some(r => r.slot === 'secondary' && r.used_percent === null)).toBe(true);
});
test('historical subject SQL omits failed observations', () => {
  const db = fixture();
  add(db, 'errors', '2026-09-06T10:00:00Z', { kind: 'error' });
  add(db, 'failed', '2026-09-06T10:00:00Z', { ok: 0 });
  expect(verify(db)).toEqual([]);
});
test('lexical MAX timestamp semantics and duplicate NULL-group rows are not silently changed', () => {
  const db = fixture();
  add(db, 'a', '2026-09-06T10:00:00+02:00');
  add(db, 'a', '2026-09-06T09:00:00Z');
  add(db, 'b', '2026-09-06T10:00:00Z', { group: null, machine: null });
  add(db, 'b', '2026-09-06T10:00:00Z', { group: null, machine: 'PC-B' });
  const rows = verify(db); expect(rows.length).toBe(3);
  expect(rows.find(r => r.account === 'a')?.ts).toBe('2026-09-06T10:00:00+02:00');
});
test('late inserts, updates, restamps and deletes are visible without a projection or cache refresh', () => {
  const db = fixture();
  add(db, 'a', '2026-09-06T10:00:00Z');
  add(db, 'a', '2026-09-06T09:00:00Z'); verify(db);
  db.exec("UPDATE probe_windows SET kind='error' WHERE ts='2026-09-06T10:00:00Z'");
  expect(verify(db)[0]?.ts).toBe('2026-09-06T09:00:00Z');
  db.exec("UPDATE probe_windows SET subject='b' WHERE kind<>'error'");
  expect(verify(db)[0]?.account).toBe('b');
  db.exec('DELETE FROM probe_windows'); expect(verify(db)).toEqual([]);
});
test('deterministic mixed-provider corpus agrees before and after ANALYZE', () => {
  const db = fixture(); let seed = 20260906;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  db.transaction(() => {
    for (let n = 0; n < 700; n++) {
      const value = random();
      add(db, `${value % 2 ? 'SUB' : 'sub'}-${value % 17}`, new Date(1788680000000 + n * 1000).toISOString(), {
        provider: value % 5 ? 'codex' : 'claude', kind: value % 7 ? 'primary' : 'error',
        group: value % 3 ? 'codex' : null, machine: value % 2 ? 'PC-B' : null,
        ok: value % 11 ? null : 0, percent: value % 101,
      });
    }
  })();
  verify(db); db.exec('ANALYZE'); verify(db);
});
test('correctness does not depend on the recommended index being present', () => {
  const db = fixture(); add(db, 'a', '2026-09-06T10:00:00Z');
  db.exec('DROP INDEX probe_windows_provider_subject_ts_idx'); verify(db);
});

test('historical SQL oracle detects mutations to its frozen baseline independently', () => {
  expect(overviewOracleGuard()).toMatchObject({
    status: 'pass', attributed_predicate_matches: true, reference_sql_matches: true,
  });
  expect(overviewOracleGuard({ attributedProbeSql: `${FROZEN_ATTRIBUTED_PROBE_SQL} AND 1 = 1` }))
    .toMatchObject({ status: 'blocked', attributed_predicate_matches: false, reference_sql_matches: true });
  expect(overviewOracleGuard({ referenceSql: REFERENCE_ACCOUNT_STATE_SQL.replace("kind <> 'error'", "kind = 'primary'") }))
    .toMatchObject({ status: 'blocked', attributed_predicate_matches: true, reference_sql_matches: false });
});
