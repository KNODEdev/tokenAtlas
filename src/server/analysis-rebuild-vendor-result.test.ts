import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { installAnalysisTracking } from "../db/analysis";
import { pendingVendorResult, type SyncRunResult, type SyncScope, type VendorId } from "../sync/contracts";
import { createTestDatabase } from "../sync/test-support";
import { advanceAnalysisRebuildSources, type AppContext } from "./api";
import {
  analysisRebuildStatus,
  queueAnalysisRebuild,
  recordAnalysisRebuildSources,
} from "./analysis-rebuild";

const directories: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function sourceResult(
  generation: number,
  scope: SyncScope,
  vendors: readonly VendorId[],
  runId: string
): SyncRunResult {
  const startedAt = "2026-09-17T11:00:00.000Z";
  const finishedAt = "2026-09-17T11:00:01.000Z";
  const revisions = {data:0,config:0,vendors:{codex:0,claude:0,opencode:0,grok:0,gemini:0,gauges:0}};
  return {
    runId,
    trigger: "manual",
    scope,
    mode: "incremental",
    startedAt,
    finishedAt,
    status: "success",
    beforeRevisions: revisions,
    afterRevisions: revisions,
    aggregateWorkRequested: false,
    changedConfigDomains: [],
    rebuildGeneration: generation,
    vendors: vendors.map((vendor) => ({
      ...pendingVendorResult(vendor),
      status: "success",
      startedAt,
      finishedAt,
      error: null,
    })),
    error: null,
  } as SyncRunResult;
}

test("account collect-archive keeps existing meters and still dispatches transcript collection", async () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  const sqlite = new Database(fixture.dbPath);
  const accounts = [{vendor:"claude" as const,account:"historical-a"}];
  const subscriptions = [{id:"historical-a",vendor:"claude" as const}];
  let readings = 0, collections = 0;
  try {
    installAnalysisTracking(sqlite);
    
    const job = queueAnalysisRebuild(sqlite,{scope:"all",mode:"collect-archive",accounts},new Date("2026-09-17T12:00:00Z"),true,subscriptions);
    const ctx = {
      sqlite,dbPath:fixture.dbPath,rootDir:process.cwd(),accounts:{subscriptions},
      refreshLiveReadings:async()=>{readings++;},
      syncRunner:async(_root,_file,request)=>{
        collections++;
        expect(request.collection).toBe("collect-archive");
        expect(request.scope).toEqual({kind:"accounts",accounts});
        expect(request.rebuildGeneration).toBe(job.generation);
        const result = sourceResult(job.generation,request.scope,["claude"],"account-collection");
        result.vendors[0]!.diagnostics.reparse={selectedDays:[]};
        return result;
      },
    } as AppContext;
    await advanceAnalysisRebuildSources(ctx);
    expect(readings).toBe(0);
    expect(collections).toBe(1);
    expect(analysisRebuildStatus(sqlite)).toMatchObject({
      generation:job.generation,state:"queued",phase:"summaries",accountDays:[],accounts,
    });
  } finally {sqlite.close(true);}
});

test("account rebuild requires the exact account result and durable selected-day evidence", () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  let sqlite = new Database(fixture.dbPath);
  const accounts = [{vendor:"claude" as const,account:"a"}];
  try {
    installAnalysisTracking(sqlite);
    
    const job = queueAnalysisRebuild(sqlite,{scope:"all",accounts},new Date("2026-09-17T12:00:00Z"),true,
      [{id:"a",vendor:"claude"}]);
    const initial = analysisRebuildStatus(sqlite);
    for (const scope of [
      {kind:"accounts" as const,accounts:[{vendor:"claude" as const,account:"b"}]},
      {kind:"vendors" as const,vendors:["claude" as const]},
    ]) {
      const invalid = sourceResult(job.generation,scope,["claude"],"wrong-account");
      expect(()=>recordAnalysisRebuildSources(sqlite,job.generation,invalid,[],0)).toThrow("selected accounts exactly");
      expect(analysisRebuildStatus(sqlite)).toEqual(initial);
    }
    const valid = sourceResult(job.generation,{kind:"accounts",accounts},["claude"],"exact-account");
    expect(()=>recordAnalysisRebuildSources(sqlite,job.generation,valid,[],0)).toThrow("exact account summary day evidence");
    expect(analysisRebuildStatus(sqlite)).toEqual(initial);
    valid.vendors[0]!.diagnostics.reparse = {selectedDays:["2026-09-01","2026-09-03"]};
    expect(recordAnalysisRebuildSources(sqlite,job.generation,valid,[],0)).toBe(true);
    sqlite.close(true);
    sqlite = new Database(fixture.dbPath);
    expect(analysisRebuildStatus(sqlite)).toMatchObject({
      generation:job.generation,accounts,vendors:["claude"],
      accountDays:[{vendor:"claude",day:"2026-09-01"},{vendor:"claude",day:"2026-09-03"}],
    });
  } finally { sqlite.close(true); }
});

test("account archived meters persist their own report days without widening usage summary days", async () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  let sqlite = new Database(fixture.dbPath);
  const accounts = [{vendor:"claude" as const,account:"a"}];
  const subscriptions = [{id:"a",vendor:"claude" as const},{id:"b",vendor:"claude" as const}];
  try {
    installAnalysisTracking(sqlite);
    
    const job = queueAnalysisRebuild(sqlite,{scope:"custom",from:"2026-09-01",until:"2026-09-03",accounts,meters:"archive"},
      new Date("2026-09-17T12:00:00Z"),true,subscriptions);
    expect(job.report?.requested).toMatchObject({meters:"archive",accountScope:"usage-with-archived-counters"});
    const scope = {kind:"accounts" as const,accounts,meters:"archive" as const};
    const valid = sourceResult(job.generation,scope,["claude","gauges"],"account-archived-meters");
    valid.vendors[0]!.diagnostics.reparse={selectedDays:["2026-09-01"]};
    const initial = analysisRebuildStatus(sqlite);
    for (const meterDays of [undefined,[{vendor:"claude",account:"b",day:"2026-09-03"}],
      [{vendor:"claude",account:"a",day:"2026-08-31"}],[{vendor:"claude",account:"a",day:"2026-09-31"}]]) {
      valid.vendors[1]!.diagnostics.reparse={accountScope:"usage-with-archived-counters",meterDays};
      expect(()=>recordAnalysisRebuildSources(sqlite,job.generation,valid,[],0)).toThrow();
      expect(analysisRebuildStatus(sqlite)).toEqual(initial);
    }
    valid.vendors[1]!.diagnostics.reparse={accountScope:"usage-with-archived-counters",
      meterDays:[{vendor:"claude",account:"a",day:"2026-09-03"}]};
    const ctx = {sqlite,dbPath:fixture.dbPath,rootDir:process.cwd(),accounts:{subscriptions},
      refreshLiveReadings:async()=>{throw Error("Archived meter recovery must not poll live accounts");},
      syncRunner:async(_root: string,_file: string,request: Parameters<NonNullable<AppContext["syncRunner"]>>[2])=>{expect(request.scope).toEqual(scope);return valid;},
    } as unknown as AppContext;
    await advanceAnalysisRebuildSources(ctx);
    sqlite.close(true);
    sqlite = new Database(fixture.dbPath);
    const restored = analysisRebuildStatus(sqlite)!;
    expect(restored).toMatchObject({meters:"archive",phase:"summaries",state:"queued",
      accountDays:[{vendor:"claude",day:"2026-09-01"}],
      accountMeterDays:[{vendor:"claude",account:"a",day:"2026-09-03"}]});
  } finally {sqlite.close(true);}
});

test("selected rebuild accepts only the exact successful vendor result for its generation", () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  const sqlite = new Database(fixture.dbPath);
  try {
    installAnalysisTracking(sqlite);
    
    const job = queueAnalysisRebuild(sqlite, {scope:"all",vendors:["claude","gemini"]},
      new Date("2026-09-17T12:00:00.000Z"), true);
    const initial = analysisRebuildStatus(sqlite);
    expect(initial).toMatchObject({
      generation:job.generation,state:"queued",phase:"sources",vendors:["claude","gemini"],
    });

    const stale = sourceResult(job.generation - 1,
      {kind:"vendors",vendors:["claude","gemini"]}, ["claude","gemini"], "stale");
    expect(recordAnalysisRebuildSources(sqlite, job.generation, stale, [], 0)).toBe(false);
    expect(analysisRebuildStatus(sqlite)).toEqual(initial);

    const invalid = [
      sourceResult(job.generation, {kind:"all"}, ["claude","gemini"], "wrong-scope"),
      sourceResult(job.generation, {kind:"vendors",vendors:["claude","gemini"]}, ["claude"], "missing-vendor"),
      sourceResult(job.generation, {kind:"vendors",vendors:["claude","gemini"]},
        ["claude","gemini","grok"], "extra-vendor"),
    ];
    for (const result of invalid) {
      expect(() => recordAnalysisRebuildSources(sqlite, job.generation, result, [], 0))
        .toThrow("selected vendors exactly");
      expect(analysisRebuildStatus(sqlite)).toEqual(initial);
      expect(analysisRebuildStatus(sqlite)).toMatchObject({state:"queued",phase:"sources"});
    }

    const valid = sourceResult(job.generation,
      {kind:"vendors",vendors:["claude","gemini"]}, ["claude","gemini"], "exact-scope");
    expect(recordAnalysisRebuildSources(sqlite, job.generation, valid, [], 0)).toBe(true);
    const recorded = analysisRebuildStatus(sqlite);
    expect(recorded).toMatchObject({
      generation:job.generation,state:"queued",phase:"sources",vendors:["claude","gemini"],
    });
    expect(recorded?.report).not.toEqual(initial?.report);
  } finally {
    sqlite.close(true);
  }
});
