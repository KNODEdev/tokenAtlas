import { installAnalysisTracking } from "../db/analysis";
import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { cacheKey, ResponseCache } from "./cache";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

describe("semantic response cache keys", () => {
  test("endpoints retain every query parameter in their cache identity", () => {
    expect(cacheKey(new URL("http://test/api/summary?nonce=one"))).not.toBe(
      cacheKey(new URL("http://test/api/summary?nonce=two"))
    );
  });
});

describe("ResponseCache sync publication", () => {
  test("keeps the last terminal stamp until derived publication completes", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE sync_revisions (
        id INTEGER PRIMARY KEY, data_revision INTEGER NOT NULL, config_revision INTEGER NOT NULL
      );
      INSERT INTO sync_revisions VALUES (1, 4, 2);
      CREATE TABLE usage_ledger_state (
        provider TEXT PRIMARY KEY, version INTEGER, covered INTEGER, status TEXT, rules_digest TEXT, revision INTEGER
      );
      INSERT INTO usage_ledger_state VALUES ('claude', 1, 4, 'ready', 'rules', 8);
      CREATE TABLE sync_runs (status TEXT NOT NULL);
    `);
    const cache = new ResponseCache();
    const terminal = cache.stamp(sqlite);

    sqlite.exec(`
      INSERT INTO sync_runs VALUES ('running');
      UPDATE sync_revisions SET data_revision = 5;
      UPDATE usage_ledger_state SET status = 'pending';
    `);
    expect(cache.stamp(sqlite)).toBe(terminal);

    sqlite.exec(`
      DELETE FROM sync_runs;
      UPDATE usage_ledger_state SET covered = 5, revision = 9, status = 'ready';
    `);
    expect(cache.stamp(sqlite)).not.toBe(terminal);
    sqlite.close();
  });
});

test("explicit invalidation changes the generation even while the terminal database revision is frozen", () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec("CREATE TABLE sync_runs (status TEXT NOT NULL)");
    const cache = new ResponseCache();
    const before = cache.stamp(sqlite);
    sqlite.exec("INSERT INTO sync_runs VALUES ('running')");
    expect(cache.stamp(sqlite)).toBe(before);
    cache.invalidate();
    expect(cache.stamp(sqlite)).not.toBe(before);
    expect(cache.syncInProgress(sqlite)).toBe(true);
  } finally { sqlite.close(); }
});

test("probe revisions invalidate only reading-aware stamps; event revisions invalidate every response stamp", () => {
  const sqlite = new Database(":memory:");
  try {
    createAnalysisSourceRevisions(sqlite);
    const cache = new ResponseCache();
    const stamp = cache.stamp(sqlite);
    const readingStamp = cache.stamp(sqlite, true);
    sqlite.exec("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('probe_windows','*',1)");
    expect(cache.stamp(sqlite)).toBe(stamp);
    expect(cache.stamp(sqlite, true)).not.toBe(readingStamp);
    sqlite.exec("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('events','*',1)");
    expect(cache.stamp(sqlite)).not.toBe(stamp);
  } finally { sqlite.close(); }
});

test("window-sum publications move only the stamps of routes that read window sums", () => {
  const sqlite = new Database(":memory:");
  try {
    createAnalysisSourceRevisions(sqlite);
    const cache = new ResponseCache();
    const reader = cache.stamp(sqlite), other = cache.stamp(sqlite, false, false), clock = cache.clockStamp(sqlite, 0, false);
    sqlite.exec(`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('window-usage','*',1),
      ('window-usage:claude:claude-a','*',1)`);
    expect(cache.stamp(sqlite)).not.toBe(reader);
    expect(cache.stamp(sqlite, false, false)).toBe(other);
    expect(cache.clockStamp(sqlite, 0, false)).toBe(clock);
    sqlite.exec("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('claude_events','*',1)");
    expect(cache.stamp(sqlite, false, false)).not.toBe(other);
  } finally { sqlite.close(); }
});

test("responses are served from memory until their sources or configuration change; readings change only clock stamps", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,ts TEXT); CREATE TABLE probe_windows(ts TEXT,used_percent REAL)");
  createAnalysisSourceRevisions(sqlite);
  installAnalysisTracking(sqlite);
  let config = 1;
  const cache = new ResponseCache(()=>config),key="/api/summary?since=2025-01-01";
  try {
    const stamp = cache.stamp(sqlite), before=sqlite.query("SELECT total_changes() n").get();
    cache.set(key,stamp,'{"calls":0}');
    expect(sqlite.query("SELECT total_changes() n").get()).toEqual(before);
    expect(cache.get(key,cache.stamp(sqlite))).toBe('{"calls":0}');
    // Nothing outlives the process: another cache starts empty.
    const other = new ResponseCache(()=>config);
    expect(other.get(key,other.stamp(sqlite))).toBeNull();
    const live = cache.clockStamp(sqlite,0);
    cache.invalidateReadings();
    expect(cache.stamp(sqlite)).toBe(stamp);
    sqlite.exec("INSERT INTO probe_windows VALUES('2026-09-15',50)");
    expect(cache.stamp(sqlite)).toBe(stamp);
    expect(cache.clockStamp(sqlite,0)).not.toBe(live);
    sqlite.exec("INSERT INTO events VALUES(1,'2025-01-01T10:00:00Z')");
    expect(cache.get(key,cache.stamp(sqlite))).toBeNull();
    const changed = cache.stamp(sqlite);config=2;
    expect(cache.stamp(sqlite)).not.toBe(changed);
  } finally {sqlite.close();}
});

test("warm memory hits do not rescan cached payloads to enforce the byte budget",()=>{
  const cache=new ResponseCache();
  cache.set("one","current","x".repeat(1024*1024));
  const bytes=spyOn(Buffer,"byteLength");
  try {
    for(let i=0;i<50;i++)expect(cache.get("one","current")?.length).toBe(1024*1024);
    expect(bytes).not.toHaveBeenCalled();
  }finally{bytes.mockRestore();}
});

test("stale memory reads release their replies instead of growing the cache",()=>{
  const cache=new ResponseCache();
  for(let i=0;i<300;i++) {
    const key=`/api/summary?scope=${i}`;
    cache.set(key,"0:old","stale");
    expect(cache.get(key,"0:new")).toBeNull();
  }
  expect(cache.stats().entries).toBe(0);
});
