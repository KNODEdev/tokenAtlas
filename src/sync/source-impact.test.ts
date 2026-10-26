import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import { beginSourceImpactObservation } from "./source-impact";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

test("source-record impact distinguishes additions, corrections, deletions and a semantic no-op", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claude_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store TEXT NOT NULL,
    call_id TEXT NOT NULL,
    path TEXT NOT NULL,
    ts TEXT NOT NULL,
    in_uncached INTEGER NOT NULL,
    UNIQUE(store,call_id)
  ); CREATE INDEX claude_events_source ON claude_events(store,path)`);
  db.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
    ('pc','keep','selected.jsonl','2026-09-01T00:00:00Z',1),
    ('pc','correct','selected.jsonl','2026-09-01T00:01:00Z',9007199254740992),
    ('pc','delete','selected.jsonl','2026-09-01T00:02:00Z',3),
    ('pc','unrelated','other.jsonl','2026-09-01T00:03:00Z',4)`);
  const scope = { identityColumns: ["store", "path"], identities: [{ store: "pc", path: "selected.jsonl" }] };
  const observation = beginSourceImpactObservation(db, "claude", scope);
  try {
    db.exec(`UPDATE claude_events SET in_uncached=9007199254740993 WHERE call_id='correct';
      DELETE FROM claude_events WHERE call_id='delete';
      INSERT INTO claude_events(store,call_id,path,ts,in_uncached)
        VALUES('pc','add','selected.jsonl','2026-09-01T00:04:00Z',5)`);
    const impact = observation.finish();
    expect(impact).toMatchObject({
      basis: "source-record-semantic-diff-v1",
      scope: "published-source-identities",
      sourceFactsChanged: { status: "available", value: "3", reason: null },
      sourceCorrections: { status: "available", value: "1", reason: null },
      sourceDeletions: { status: "available", value: "1", reason: null },
      canonicalFacts: { status: "unavailable", value: null },
      duplicates: { status: "unavailable", value: null },
    });
    expect(impact.evidence).toEqual([expect.objectContaining({
      provider: "claude",
      table: "claude_events",
      keyColumns: ["store", "call_id"],
      beforeRecords: "3",
      afterRecords: "3",
      additions: "1",
      corrections: "1",
      deletions: "1",
    })]);
  } finally {
    observation.dispose();
  }

  const retry = beginSourceImpactObservation(db, "claude", scope);
  try {
    expect(retry.finish()).toMatchObject({
      sourceFactsChanged: { status: "available", value: "0" },
      sourceCorrections: { status: "available", value: "0" },
      sourceDeletions: { status: "available", value: "0" },
    });
  } finally {
    retry.dispose();
    db.close();
  }
});

test("Codex source impact stays unknown when an affected record has no trustworthy source offset", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT);
    CREATE TABLE ratelimit(home TEXT,path TEXT,source_offset INTEGER,source_slot TEXT,ts TEXT);
    CREATE INDEX events_source ON events(home,path);
    CREATE INDEX ratelimit_source ON ratelimit(home,path);
    INSERT INTO events VALUES('home','rollout.jsonl',NULL,'2026-09-01T00:00:00Z')`);
  const observation = beginSourceImpactObservation(db, "codex", {
    identityColumns: ["home", "path"],
    identities: [{ home: "home", path: "rollout.jsonl" }],
  });
  try {
    db.run("UPDATE events SET ts='2026-09-01T00:01:00Z'");
    const impact = observation.finish();
    expect(impact.sourceFactsChanged).toMatchObject({ status: "unavailable", value: null });
    expect(impact.evidence.find(item => item.table === "events")).toMatchObject({
      status: "unavailable",
      reason: "null-trustworthy-record-key",
    });
  } finally {
    observation.dispose();
    db.close();
  }
});

test("scoped source impact uses every affected-file identity key and reports an unbounded plan without scanning", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claude_events(store TEXT,call_id TEXT,path TEXT,ts TEXT,UNIQUE(store,call_id));
    CREATE INDEX claude_events_source ON claude_events(store,path);
    INSERT INTO claude_events VALUES('pc','selected','selected.jsonl','2026-09-01T00:00:00Z')`);
  const add = db.prepare("INSERT INTO claude_events VALUES('pc',?,?,?)");
  try {
    for (let index = 0; index < 1000; index++) {
      add.run(`unrelated-${index}`, `unrelated-${index}.jsonl`, "2026-09-01T00:00:00Z");
    }
  } finally { add.finalize(); }
  const scope = { identityColumns: ["store", "path"], identities: [{ store: "pc", path: "selected.jsonl" }] };
  const bounded = beginSourceImpactObservation(db, "claude", scope);
  try {
    expect(bounded.finish().evidence[0]?.beforeRecords).toBe("1");
  } finally { bounded.dispose(); }
  db.exec("DROP INDEX claude_events_source");
  const unsupported = beginSourceImpactObservation(db, "claude", scope);
  try {
    expect(unsupported.finish()).toMatchObject({
      sourceFactsChanged: { status: "unavailable", value: null },
      evidence: [{ status: "unavailable", reason: "unbounded-source-scan:claude_events" }],
    });
  } finally { unsupported.dispose(); }
  const automatic = beginSourceImpactObservation(db, "claude", {
    identityColumns: ["store", "path"],
    identities: Array.from({ length: 1_000 }, (_, index) => ({ store: "pc", path: `unrelated-${index}.jsonl` })),
  });
  try {
    expect(automatic.finish()).toMatchObject({
      sourceFactsChanged: { status: "unavailable", value: null },
      evidence: [{ status: "unavailable", reason: "unbounded-source-scan:claude_events" }],
    });
  } finally { automatic.dispose(); }
  expect(db.query("SELECT count(*) n FROM sqlite_temp_master WHERE name LIKE 'source_impact_%'").get()).toEqual({ n: 0 });
  db.close();
});

test("source impact refuses row and payload volumes beyond its in-memory evidence budget", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE claude_events(store TEXT,call_id TEXT,path TEXT,payload BLOB,UNIQUE(store,call_id));
    CREATE INDEX claude_events_source ON claude_events(store,path);
    INSERT INTO claude_events VALUES('pc','large','large.jsonl',zeroblob(2000000))`);
  const bytes = beginSourceImpactObservation(db, "claude", { identityColumns: ["store", "path"] });
  try {
    expect(bytes.finish().evidence[0]).toMatchObject({
      status: "unavailable",
      reason: "source-impact-capture-byte-limit:8388608",
      beforeRecords: null,
    });
  } finally { bytes.dispose(); }
  db.exec(`DELETE FROM claude_events;
    WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<=25000)
    INSERT INTO claude_events(store,call_id,path,payload)
      SELECT 'pc','call-'||n,'path-'||n,NULL FROM rows`);
  const rows = beginSourceImpactObservation(db, "claude", { identityColumns: ["store", "path"] });
  try {
    expect(rows.finish().evidence[0]).toMatchObject({
      status: "unavailable",
      reason: "source-impact-capture-row-limit:25000",
      beforeRecords: null,
    });
  } finally {
    rows.dispose();
    expect(db.query("SELECT count(*) n FROM sqlite_temp_master WHERE name LIKE 'source_impact_%'").get()).toEqual({ n: 0 });
    db.close();
  }
});

test("a provider without a trustworthy table contract emits one unavailable evidence row", () => {
  const db = new Database(":memory:");
  const observation = beginSourceImpactObservation(db, "gauges", { identityColumns: [] });
  try {
    const impact = observation.finish();
    expect(impact.sourceFactsChanged.status).toBe("unavailable");
    expect(impact.evidence).toHaveLength(1);
    expect(impact.evidence[0]?.reason).toBe("provider-has-no-trustworthy-source-record-key-contract");
  } finally {
    observation.dispose();
    db.close();
  }
});

test("coordinator persists atomic source impact and publishes no false metric after rollback", async () => {
  const { directory, dbPath } = createTestDatabase();
  const live = new Database(dbPath);
  live.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
    ('pc','keep','keep.jsonl','2026-09-01T00:00:00Z',1),
    ('pc','correct','correct.jsonl','2026-09-01T00:01:00Z',2),
    ('pc','delete','delete.jsonl','2026-09-01T00:02:00Z',3)`);
  const adapter = async (context: { stageDbPath: string }) => {
    const stage = new Database(context.stageDbPath);
    try {
      stage.exec(`DELETE FROM claude_events;
        INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
        ('pc','keep','keep.jsonl','2026-09-01T00:00:00Z',1),
        ('pc','correct','correct.jsonl','2026-09-01T00:01:00Z',20),
        ('pc','add','add.jsonl','2026-09-01T00:03:00Z',4);
        INSERT INTO claude_files(store,path,size,mtime,calls,ingested_at) VALUES('pc','delete.jsonl',0,1,0,'2026-09-01T00:03:00Z')`);
    } finally {
      stage.close();
    }
    return { ...successfulNoop(), processedInputs: 3, writtenRows: 3,
      dirtyRange: { from: "2026-09-01T00:00:00Z", to: "2026-09-01T00:03:00Z" } };
  };
  const make = (fail: boolean) => new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: process.cwd(),
    adapters: adaptersWith({ claude: adapter }),
    mirror: noMirror,
    configFingerprint: () => "source-impact-config",
    sourceFingerprint: () => "source-impact-source",
    prepareStage: () => {},
    refreshDerived: () => {},
    afterPublishBeforeRevision: fail ? () => { throw new Error("synthetic interruption"); } : undefined,
  });
  let failing: SyncCoordinator | undefined;
  let succeeding: SyncCoordinator | undefined;
  try {
    failing = make(true);
    const failed = await failing.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" }).completion;
    failing.close(); failing = undefined;
    expect(failed.status).toBe("failure");
    expect(failed.vendors[0]?.sourceImpact?.sourceFactsChanged).toEqual({
      status: "unavailable",
      value: null,
      reason: "source-publication-failed-or-rolled-back",
    });
    expect(live.query("SELECT call_id,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual([
      { call_id: "correct", in_uncached: 2 },
      { call_id: "delete", in_uncached: 3 },
      { call_id: "keep", in_uncached: 1 },
    ]);
    const persistedFailure = JSON.parse((live.query("SELECT result_json FROM sync_runs ORDER BY started_at DESC LIMIT 1").get() as { result_json: string }).result_json);
    expect(persistedFailure.vendors[0].sourceImpact.sourceFactsChanged.status).toBe("unavailable");

    succeeding = make(false);
    const success = await succeeding.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" }).completion;
    succeeding.close(); succeeding = undefined;
    expect({ status: success.status, error: success.error, vendorError: success.vendors[0]?.error }).toEqual({
      status: "success", error: null, vendorError: null,
    });
    expect(success.vendors[0]?.sourceImpact).toMatchObject({
      sourceFactsChanged: { status: "available", value: "3" },
      sourceCorrections: { status: "available", value: "1" },
      sourceDeletions: { status: "available", value: "1" },
    });
    const persistedSuccess = JSON.parse((live.query("SELECT result_json FROM sync_runs ORDER BY started_at DESC LIMIT 1").get() as { result_json: string }).result_json);
    expect(persistedSuccess.vendors[0].sourceImpact.sourceFactsChanged.value).toBe("3");
  } finally {
    failing?.close();
    succeeding?.close();
    live.close(true);
    try { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error; }
  }
});

test("incremental source impact reads only changed identities and follows a Claude call moved between paths", async () => {
  const { directory, dbPath } = createTestDatabase();
  const live = new Database(dbPath);
  live.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
    ('pc','same','same.jsonl','2026-09-01T00:00:00Z',1),
    ('pc','move','old.jsonl','2026-09-01T00:01:00Z',2)`);
  const instance = new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: process.cwd(),
    adapters: adaptersWith({ claude: async (context) => {
      const stage = new Database(context.stageDbPath);
      try {
        stage.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES
          ('pc','same','same.jsonl','2026-09-01T00:00:00Z',1),
          ('pc','move','new.jsonl','2026-09-01T00:01:00Z',2)`);
      } finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 2, writtenRows: 2,
        dirtyRange: { from: "2026-09-01T00:00:00Z", to: "2026-09-01T00:01:00Z" } };
    } }),
    mirror: noMirror,
    configFingerprint: () => "source-impact-config",
    sourceFingerprint: () => "source-impact-moved-call",
    prepareStage: () => {},
    refreshDerived: () => {},
  });
  try {
    const result = await instance.enter({
      trigger: "manual",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
      reparse: {},
    }).completion;
    expect(result.status).toBe("success");
    expect(result.vendors[0]?.diagnostics).toMatchObject({ deltaIdentities: 2, changedIdentities: 1 });
    expect(result.vendors[0]?.sourceImpact).toMatchObject({
      sourceFactsChanged: { status: "available", value: "1" },
      sourceCorrections: { status: "available", value: "1" },
      sourceDeletions: { status: "available", value: "0" },
      evidence: [{ beforeRecords: "1", afterRecords: "1", additions: "0", corrections: "1", deletions: "0" }],
    });
    expect(live.query("SELECT path FROM claude_events WHERE store='pc' AND call_id='move'").get()).toEqual({ path: "new.jsonl" });
  } finally {
    instance.close();
    live.close(true);
    try { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error; }
  }
});
