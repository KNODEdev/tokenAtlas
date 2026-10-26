import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { afterEach, expect, test } from 'bun:test';
import { removeTestFixture } from '../test-cleanup';
import { Database } from '../db/sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { installAnalysisTracking } from '../db/analysis';
import { createCodexSchema, createTestDatabase } from '../sync/test-support';
import type { SyncRunResult, SyncScope } from '../sync/contracts';
import {
  advanceRebuildReadiness,
  analysisRebuildStatus,
  queueAnalysisRebuild,
  recordAnalysisRebuildSources,
  runAnalysisRebuild,
  updateAnalysisRebuild,
} from './analysis-rebuild';
import type { AppContext } from './api';
import { ledgerSumsCurrent } from './ledger-sums';
import { buildSubscriptionAccountingReport } from './subscription-accounting';
import { codexSourceHomes } from './capacity-equivalents';
import { buildEraIndex, type EraDeclaration } from './eras';
import {ACCOUNT_PERIODS,replaceDeclaredPeriods} from '../db/period-store';
import type {RateCard} from './pricing';
import {prepareProbeReaderFixture} from './probe-reader.fixture';
import {prepareUsageRegisters} from './usage-register.fixture';
import {fillUsageLedger} from './usage-ledger.fixture';

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0))
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const BASELINE_GENERATION = 920_000;
const REQUESTED_AT = new Date('2026-09-17T10:00:00.000Z');
const ACCOUNT_SCOPE: SyncScope = {
  kind: 'accounts',
  accounts: [{ vendor: 'claude', account: 'claude-selected' }],
};
const A_RAW_SENTINEL = 44_407;
const RATE_CARDS: RateCard = { version: 1, currency: 'USD', unit: 'per 1M', vendors: {} };
/** The usage ledger's stored per-event valuations: one fact per source row, three variants each. */
const LEDGER_VALUATIONS = `SELECT provider,row_id,identity,copy_state,std_key,std_reason,std_usd,std_nano,std_femto,
  act_key,act_reason,act_usd,act_nano,act_femto,glb_key,glb_reason,glb_usd,glb_nano,glb_femto FROM usage_ledger_facts ORDER BY provider,row_id`;

type Fixture = ReturnType<typeof fixture>;

function initializeEngineSchema(dbPath: string): void {
  createCodexSchema(dbPath);
}

function writeConfigFiles(directory: string, archiveRoot: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const claudeHome = path.join(archiveRoot, 'claude', 'PC-user');
  for (const name of ['accounts.json', 'projects.json', 'rate-cards.json']) {
    const file = path.join(directory, name);
    let value: unknown = {};
    if (name === 'accounts.json') value = splitProbeReaderFixtureConfig([
        {
          id: 'claude-selected',
          vendor: 'claude',
          home: claudeHome,
          until: '2026-09-02',
        },
        {
          id: 'claude-unselected',
          vendor: 'claude',
          home: claudeHome,
          from: '2026-09-02',
        },
      ]);
    if (name === 'projects.json') value = { projects: [] };
    if (name === 'rate-cards.json') value = { vendors: {} };
    fs.writeFileSync(file, JSON.stringify(value));
  }
}

function fixture() {
  const created = createTestDatabase();
  temporary.push(created.directory);
  initializeEngineSchema(created.dbPath);
  const archiveRoot = path.join(created.directory, 'archive');
  const configRoot = path.join(created.directory, 'config');
  const localState = path.join(created.directory, 'local-state');
  const claudeFile = path.join(archiveRoot, 'claude', 'PC-user', 'project', 'session.jsonl');
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, [
    {
      type: 'assistant',
      sessionId: 'selected-a-session',
      timestamp: '2026-09-01T12:00:00.000Z',
      message: {
        id: 'selected-a-message',
        model: 'claude-account-fixture',
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    },
    {
      type: 'assistant',
      sessionId: 'unselected-b-session',
      timestamp: '2026-09-02T12:00:00.000Z',
      message: {
        id: 'unselected-b-message',
        model: 'claude-account-fixture',
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  writeConfigFiles(configRoot, archiveRoot);
  return { ...created, archiveRoot, configRoot, localState, claudeFile };
}

function subscriptions(f: Fixture): EraDeclaration[] {
  const home = path.join(f.archiveRoot, 'claude', 'PC-user');
  return [
    { id: 'claude-selected', vendor: 'claude', home, until: '2026-09-02' },
    { id: 'claude-unselected', vendor: 'claude', home, from: '2026-09-02' },
  ];
}

/** The eras as declared account periods of the archive folder, which is what attributes the sessions. */
function declareEraPeriods(sqlite: Database, f: Fixture): void {
  replaceDeclaredPeriods(sqlite,ACCOUNT_PERIODS,subscriptions(f).map(sub=>({provider:'claude',subject:'claude/pc-user',
    from:sub.from??'2020-01-01',until:sub.until??null,value:sub.id,origin:'declared' as const,
    firstSeen:null,lastSeen:null,readings:0,evidence:'synthetic archive declaration'})));
}

function context(sqlite: Database, f: Fixture): AppContext {
  const declared = subscriptions(f);
  const home = path.join(f.archiveRoot, 'claude', 'PC-user');
  declareEraPeriods(sqlite, f);
  const ctx = {
    sqlite,
    dbPath: f.dbPath,
    accounts: splitProbeReaderFixtureConfig(declared),
    homeToSubId: new Map([[home, 'claude-unselected']]),
    subIdToHomes: new Map([
      ['claude-selected', [home]],
      ['claude-unselected', [home]],
    ]),
    eras: buildEraIndex(declared),
    eraErrors: [],
    homeConflict: null,
    rateCards: RATE_CARDS,
    claudeGauge: {},
    grokGauge: {},
    cycles: {},
    plans: {},
    plansCatalog: { provider_groups: [] },
    rootDir: process.cwd(),
    attribution: null,
  } as AppContext;
  return ctx;
}

/** The report worker consumes prepared registers and probe keys; their producers run independently. */
function prepareReportInputs(ctx: AppContext, f: Fixture): void {
  // The sync child imports this fixture archive under its own root, so the usage ledger reads the
  // rows' sources against that root, as the background producer does against the app's.
  fillUsageLedger(ctx.sqlite, 'claude', ctx.rateCards, f.archiveRoot, 500);
  prepareUsageRegisters(ctx.sqlite, ctx.rateCards, ctx.accounts.subscriptions ?? [], ctx.homeToSubId);
  // The archive root is per-test and intentionally differs from the app's global logical root.
  // Settle the empty source registry without inventing physical profile mappings for its rows.
  prepareProbeReaderFixture(ctx.sqlite, []);
}

/** The maintenance worker's turn after the producers above: the reports phase ends once the registers are current. */
function finishReports(ctx: AppContext, f: Fixture): void {
  for (let attempt = 0; attempt < 100 && analysisRebuildStatus(ctx.sqlite)?.state === 'running'; attempt++) {
    prepareReportInputs(ctx, f);
    advanceRebuildReadiness(ctx.sqlite, { prices: ledgerSumsCurrent(ctx.sqlite), limitWindows: true, windowSums: true },
      { subscriptions: ctx.accounts.subscriptions ?? [], sources: ctx.accounts.sources ?? [], eras: ctx.eras, rateCards: ctx.rateCards,
        sourceHomes: codexSourceHomes(ctx.homeToSubId) });
  }
}

function isolatedEnvironment(f: Fixture): Record<string, string> {
  const inherited = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const;
  const env: Record<string, string> = {};
  for (const name of inherited) if (process.env[name]) env[name] = process.env[name]!;
  const absent = path.join(f.directory, 'absent-user-home');
  return {
    ...env,
    TOKENATLAS_ARCHIVE: f.archiveRoot,
    TOKENATLAS_CONFIG: f.configRoot,
    // The fixture's configuration is complete; never fall back to the repository's files.
    TOKENATLAS_FROZEN_CONFIG: '1',
    TOKENATLAS_LOCAL_STATE: f.localState,
    TOKENATLAS_DB: f.dbPath,
    TOKENATLAS_MACHINE: 'account-fixture',
    TOKENATLAS_LOGIN: 'fixture',
    USERPROFILE: absent,
    HOME: absent,
    OneDrive: path.join(f.directory, 'absent-onedrive'),
  };
}

/** The production source-phase runner, or a copy of it that edits the database right before publication. */
async function runRebuildChild(
  f: Fixture,
  request: Record<string, unknown>,
  options: { injectConcurrentCorrection?: boolean } = {},
): Promise<{ exit: number; stdout: string; stderr: string; result?: SyncRunResult }> {
  let runner=path.join(import.meta.dir, '../sync/runner.ts');
  if(options.injectConcurrentCorrection) {
    runner=path.join(f.directory,'concurrent-runner.ts');
    fs.writeFileSync(runner, `
      import {Database} from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
      const input=JSON.parse(process.argv[2]);
      const {SyncCoordinator}=await import(${JSON.stringify(path.join(import.meta.dir,'../sync/coordinator.ts'))});
      const coordinator=new SyncCoordinator({dbPath:input.dbPath,rootDir:input.rootDir,beforeIncrementalPublish(){
        const concurrent=new Database(input.dbPath);
        try {concurrent.exec("UPDATE claude_events SET in_uncached=12345 WHERE ts>='2026-09-02'");}
        finally {concurrent.close();}
      }});
      try {console.log('TOKENATLAS_SYNC_RESULT:'+JSON.stringify(await coordinator.enter(input.request).completion));}
      finally {coordinator.close();}
    `);
  }
  const child = Bun.spawn({
    cmd: [process.execPath, runner, JSON.stringify({
      dbPath: f.dbPath,
      rootDir: process.cwd(),
      request,
    })],
    cwd: process.cwd(),
    env: isolatedEnvironment(f),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const watchdog = setTimeout(() => child.kill(), 60_000);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(watchdog));
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('TOKENATLAS_SYNC_RESULT:'));
  return {
    exit,
    stdout,
    stderr,
    ...(line ? { result: JSON.parse(line.slice('TOKENATLAS_SYNC_RESULT:'.length)) as SyncRunResult } : {}),
  };
}

async function successfulRebuildChild(
  f: Fixture,
  request: Record<string, unknown>,
): Promise<SyncRunResult> {
  const outcome = await runRebuildChild(f, request);
  expect(outcome.exit, outcome.stderr || outcome.stdout).toBe(0);
  expect(outcome.result).toBeDefined();
  expect(outcome.result!.status).toBe('success');
  return outcome.result!;
}

async function acknowledgeBaseline(f: Fixture): Promise<void> {
  const request = {
    trigger: 'manual',
    scope: { kind: 'all' },
    mode: 'incremental',
    reparse: {},
    rebuildGeneration: BASELINE_GENERATION,
    collection: 'archive',
  } as const;
  const result = await successfulRebuildChild(f, request);
  expect(result.rebuildGeneration).toBe(BASELINE_GENERATION);
  expect(result.scope).toEqual({ kind: 'all' });
  // The server applies the declared periods on its own tick; the fixture stands in for it.
  const db = new Database(f.dbPath);
  try { declareEraPeriods(db, f); } finally { db.close(); }
}

function quoteIdentifier(value: string): string {
  return `\u0022${value.replaceAll('\u0022', '\u0022\u0022')}\u0022`;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
    .map(column => column.name);
}

function orderedRows(db: Database, table: string): unknown[] {
  const names = columns(db, table);
  if (!names.length) return [];
  return db.query(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${names.map(quoteIdentifier).join(',')}`).all();
}

function matchingTableState(db: Database, pattern: RegExp, excluded: string[] = []): Record<string, unknown[]> {
  const tables = (db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => pattern.test(name) && !excluded.includes(name));
  return Object.fromEntries(tables.map(table => [table, orderedRows(db, table)]));
}

function sourceMetadataState(db: Database): Record<string, unknown[]> {
  return matchingTableState(db, /(bookmark|claude.*(?:file|source|state)|source.*(?:file|state))/i, [
    'claude_events',
    'sync_runs',
  ]);
}

function gaugeState(db: Database): Record<string, unknown[]> {
  return matchingTableState(db, /(gauge|ratelimit|current_)/i, ['current_projection_dirty']);
}

/** The rows each era's declared account period covers (the sessions record no identity). */
const ERA_ROWS: Record<string, string> = { 'claude-selected': "ts<'2026-09-02'", 'claude-unselected': "ts>='2026-09-02'" };

function claudeIdentity(db: Database, account: string): Record<string, unknown>[] {
  const names = columns(db, 'claude_events');
  const selected = ['account_key', 'in_uncached', ...names.filter(name => /identity|conflict/i.test(name))];
  return db.query(`SELECT ${[...new Set(selected)].map(quoteIdentifier).join(',')}
    FROM claude_events WHERE ${ERA_ROWS[account]} ORDER BY rowid`).all() as Record<string, unknown>[];
}

function expectConflictZero(rows: Record<string, unknown>[]): void {
  const conflicts = rows.flatMap(row => Object.entries(row)
    .filter(([name]) => /conflict/i.test(name))
    .map(([, value]) => value));
  expect(conflicts.length).toBeGreaterThan(0);
  expect(conflicts.every(value => value === 0 || value === false)).toBe(true);
}

function accountRequest(generation: number) {
  return {
    trigger: 'manual',
    scope: ACCOUNT_SCOPE,
    mode: 'incremental',
    reparse: {},
    rebuildGeneration: generation,
    collection: 'archive',
  } as const;
}

function expectUnavailableLegacyAggregateAudit(report: unknown): void {
  const text = JSON.stringify(report).toLowerCase();
  expect(text).toContain('unavailable');
  expect(text).toContain('ledger-sums-carry-no-account');
}

test('an account rebuild repairs only the selected historical Claude era and resumes idempotently', async () => {
  const f = fixture();
  await acknowledgeBaseline(f);
  let db = new Database(f.dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    installAnalysisTracking(db);

    const selectedBefore = claudeIdentity(db, 'claude-selected');
    const unselectedBefore = claudeIdentity(db, 'claude-unselected');
    expect(selectedBefore).toHaveLength(1);
    expect(unselectedBefore).toHaveLength(1);
    expect(selectedBefore[0]!.in_uncached).toBe(7);
    expect(unselectedBefore[0]!.in_uncached).toBe(11);
    expectConflictZero(selectedBefore);
    expectConflictZero(unselectedBefore);

    expect(() => queueAnalysisRebuild(db, {
      scope: 'all',
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
    }, REQUESTED_AT)).toThrow(/source verification/i);

    db.query(`UPDATE claude_events SET in_uncached=? WHERE ${ERA_ROWS['claude-selected']}`)
      .run(A_RAW_SENTINEL);

    // Establish the test DB's empty current-probe projection before taking the unchanged-source snapshot.
    prepareProbeReaderFixture(db, []);
    const gaugesBefore = gaugeState(db);
    const queued = queueAnalysisRebuild(db, {
      scope: 'all',
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
    }, REQUESTED_AT, true);
    expect(queued).toMatchObject({
      scope: 'all',
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
      vendors: ['claude'],
      state: 'queued',
      phase: 'sources',
    });
    expect(queued.report?.requested).toMatchObject({ accountScope: 'usage-with-existing-meters' });
    expectUnavailableLegacyAggregateAudit(queued.report);

    updateAnalysisRebuild(db, queued.generation, {state:'running'});
    const request = accountRequest(queued.generation);
    const first = await successfulRebuildChild(f, request);
    expect(first.scope).toEqual(ACCOUNT_SCOPE);
    expect(first.vendors.map(vendor => vendor.vendor)).toEqual(['claude']);
    expect(first.vendors[0]!.status).toBe('success');
    expect((first.vendors[0]!.diagnostics.reparse as { selectedDays?: string[] }).selectedDays)
      .toEqual(['2026-09-01']);
    expect(claudeIdentity(db, 'claude-selected')[0]!.in_uncached).toBe(7);
    expect(claudeIdentity(db, 'claude-unselected')).toEqual(unselectedBefore);

    const persisted = db.query('SELECT scope,vendor,result_json FROM sync_runs WHERE run_id=?')
      .get(first.runId) as { scope: string; vendor: string; result_json: string };
    expect(persisted.scope).toBe('accounts');
    expect(JSON.parse(persisted.vendor)).toEqual([{vendor:'claude',account:'claude-selected'}]);
    expect(JSON.parse(persisted.result_json).scope).toEqual(ACCOUNT_SCOPE);

    const metadataAfterFirst = sourceMetadataState(db);
    const identityAfterFirst = {
      selected: claudeIdentity(db, 'claude-selected'),
      unselected: claudeIdentity(db, 'claude-unselected'),
    };
    // Re-running the same generation (a restart) changes neither facts nor reading positions.
    const second = await successfulRebuildChild(f, request);
    expect(second.scope).toEqual(ACCOUNT_SCOPE);
    expect(sourceMetadataState(db)).toEqual(metadataAfterFirst);
    expect({
      selected: claudeIdentity(db, 'claude-selected'),
      unselected: claudeIdentity(db, 'claude-unselected'),
    }).toEqual(identityAfterFirst);

    expect(recordAnalysisRebuildSources(db, queued.generation, first, [], 0)).toBe(true);
    expect(analysisRebuildStatus(db)?.accountDays).toEqual([
      { vendor: 'claude', day: '2026-09-01' },
    ]);
    updateAnalysisRebuild(db, queued.generation, { phase: 'summaries', state: 'queued' });
    expect(runAnalysisRebuild(db, splitProbeReaderFixtureConfig(subscriptions(f)))).toBe(true);

    expect(claudeIdentity(db, 'claude-unselected')).toEqual(unselectedBefore);
    expect(gaugeState(db)).toEqual(gaugesBefore);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      vendors: ['claude'],
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
      state: 'running',
      phase: 'reports',
    });

    const ctx = context(db, f);
    finishReports(ctx, f);
    expect(analysisRebuildStatus(db)?.state).toBe('complete');
    // Resume a job whose shared register was never published: it waits for the register, then completes.
    const cached=db.query(LEDGER_VALUATIONS).all();
    db.exec("UPDATE usage_ledger_state SET status='pending',published_revision=0 WHERE provider='claude'");
    updateAnalysisRebuild(db,queued.generation,{state:'running',phase:'reports',completed:0});
    expect(advanceRebuildReadiness(db,{prices:ledgerSumsCurrent(db),limitWindows:true,windowSums:true})).toBe(false);
    finishReports(ctx, f);
    expect(analysisRebuildStatus(db)?.state).toBe('complete');
    expect(db.query(LEDGER_VALUATIONS).all()).toEqual(cached);

    const ready = analysisRebuildStatus(db);
    expect(ready).toMatchObject({
      generation: queued.generation,
      vendors: ['claude'],
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
      state: 'complete',
      phase: 'reports',
      error: null,
    });
    expect(ready!.completed).toBe(ready!.total);
    expect(ready!.report!.accountTotals!.after!.accounts).toMatchObject([
      {vendor:'claude',account:'claude-selected',status:'available',calls:'1',buckets:{in_uncached:'7'},quality:{complete:true}},
    ]);
    expect(ready!.report!.accountTotals!.before.accounts[0]!.status).toBe('unavailable');
    expect(ready!.report!.accountTotals!.delta![0]!.status).toBe('unavailable');
    // The real worker publishes the durable price register even when every rate is missing.
    // Missing prices remain unknown rather than becoming a zero monetary total.
    expect(ready!.report!.accountPrices!.after!.accounts).toMatchObject([
      {vendor:'claude',account:'claude-selected',status:'available',totals:{
        // The shared register counts a reason's events and its tokens; the pre-register
        // boundary could only count events.
        standard:{value:null,subtotal:'0',pricedEvents:'0',unpricedEvents:'1',
          reasons:{missing_rate:{events:'1',tokens:'7'}}},
        actual:{value:null,subtotal:'0',pricedEvents:'0',unpricedEvents:'1'},quality:{complete:false},
      }},
    ]);
    expect(ready!.report!.accountPrices!.before.accounts[0]!.status).toBe('unavailable');
    expect(ready!.report!.accountPrices!.delta![0]!.standard.status).toBe('unavailable');
    expect(db.query("SELECT COUNT(*) n FROM usage_ledger_state WHERE provider='claude' AND status='ready'").get()).toEqual({n:1});

    // The usage ledger values each source event once, independent of account: both accounts' events.
    const valuations = db.query(LEDGER_VALUATIONS).all();
    expect(valuations).toHaveLength(2);
    expect(claudeIdentity(db, 'claude-unselected')).toEqual(unselectedBefore);
    expect(sourceMetadataState(db)).toEqual(metadataAfterFirst);
    expect(gaugeState(db)).toEqual(gaugesBefore);

    const reopened = new Database(f.dbPath);
    try {
      const persistedReady = analysisRebuildStatus(reopened);
      expect(persistedReady).toEqual(ready);
      expect(persistedReady!.report).toEqual(ready!.report);
      expect(persistedReady!.completed).toBe(persistedReady!.total);
      expect(claudeIdentity(reopened, 'claude-unselected')).toEqual(unselectedBefore);
      expect(sourceMetadataState(reopened)).toEqual(metadataAfterFirst);
      expect(gaugeState(reopened)).toEqual(gaugesBefore);
      // After restart the account's report is read from the stored rows; nothing is valued again.
      const reopenedCtx = context(reopened, f);
      expect(buildSubscriptionAccountingReport({ ...reopenedCtx, declarations: reopenedCtx.accounts.subscriptions }, 'claude',
        { since: '2026-08-01', until: '2026-09-30', account: 'claude-selected' })).toMatchObject({tokens:7,events:1,provider:{id:'claude'}});
      expect(reopened.query(LEDGER_VALUATIONS).all()).toEqual(valuations);
    } finally {
      reopened.close(true);
    }
  } finally {
    db.close(true);
    Bun.gc(true);
  }
}, 60_000);

test('a concurrent correction to B after reconciliation refuses publication of stale account facts', async () => {
  const f=fixture();
  await acknowledgeBaseline(f);
  const db=new Database(f.dbPath);
  try {
    db.query(`UPDATE claude_events SET in_uncached=? WHERE ${ERA_ROWS['claude-selected']}`).run(A_RAW_SENTINEL);
    const queued=queueAnalysisRebuild(db,{scope:'all',accounts:[{vendor:'claude',account:'claude-selected'}]},REQUESTED_AT,true);
    updateAnalysisRebuild(db,queued.generation,{state:'running'});
    const bookmarks=sourceMetadataState(db);
    const outcome=await runRebuildChild(f,accountRequest(queued.generation),{injectConcurrentCorrection:true});
    expect(outcome.result?.status).toBe('failure');
    expect(JSON.stringify(outcome.result)).toContain('Accepted source facts changed after comparison; retry publication');
    expect(claudeIdentity(db,'claude-selected')[0]!.in_uncached).toBe(A_RAW_SENTINEL);
    expect(claudeIdentity(db,'claude-unselected')[0]!.in_uncached).toBe(12345);
    expect(sourceMetadataState(db)).toEqual(bookmarks);
  } finally {db.close(true);}
}, 60_000);

test('an unknown account is rejected before changing the generation, while a declared empty account is valid', () => {
  const f=createTestDatabase();
  temporary.push(f.directory);
  const db=new Database(f.dbPath);
  try {
    installAnalysisTracking(db);
    const before=analysisRebuildStatus(db);
    expect(()=>queueAnalysisRebuild(db,{scope:'all',accounts:[{vendor:'claude',account:'typo'}]},REQUESTED_AT,true))
      .toThrow('Unknown historical rebuild account');
    expect(analysisRebuildStatus(db)).toEqual(before);
    const result=queueAnalysisRebuild(db,{scope:'all',accounts:[{vendor:'claude',account:'empty'}]},REQUESTED_AT,true,
      [{id:'empty',vendor:'claude'}]);
    expect(result.accounts).toEqual([{vendor:'claude',account:'empty'}]);
  } finally {db.close(true);}
});

test('a verified empty account prepares durable zero prices before the real report worker completes',async()=>{
  const f=fixture();await acknowledgeBaseline(f);
  const db=new Database(f.dbPath);
  try {
    const ctx=context(db,f);
    const declared=[...(ctx.accounts.subscriptions??[]),{id:'empty',vendor:'claude',home:path.join(f.archiveRoot,'claude','empty')}];
    ctx.accounts.subscriptions=declared;ctx.eras=buildEraIndex(declared);
    ctx.subIdToHomes.set('empty',[path.join(f.archiveRoot,'claude','empty')]);
    const queued=queueAnalysisRebuild(db,{scope:'all',accounts:[{vendor:'claude',account:'empty'}]},REQUESTED_AT,true,declared,ctx.eras,ctx.rateCards);
    // This fixture starts at the report boundary with source-verified empty affected days.
    updateAnalysisRebuild(db,queued.generation,{state:'running',phase:'reports',accountDays:[]});
    finishReports(ctx, f);
    const ready=analysisRebuildStatus(db)!;
    expect(ready.state).toBe('complete');expect(ready.total).toBeGreaterThan(0);
    expect(ready.report!.accountTotals!.after!.accounts[0]).toMatchObject({status:'available',calls:'0',quality:{complete:true}});
    expect(ready.report!.accountPrices!.after!.accounts[0]).toMatchObject({status:'available',totals:{standard:{value:'0',pricedEvents:'0',unpricedEvents:'0'},actual:{value:'0'},quality:{complete:true}}});
    expect(ready.report!.accountPrices!.before.accounts[0]!.status).toBe('unavailable');
  }finally{db.close(true);}
},60_000);

test('an account source publication refuses a same-file selected and unselected hybrid before changing active facts or bookmarks', async () => {
  const f = fixture();
  await acknowledgeBaseline(f);
  const db = new Database(f.dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    installAnalysisTracking(db);
    db.query(`UPDATE claude_events SET in_uncached=? WHERE ${ERA_ROWS['claude-selected']}`)
      .run(A_RAW_SENTINEL + 1);
    db.query(`UPDATE claude_events SET in_uncached=? WHERE ${ERA_ROWS['claude-unselected']}`)
      .run(A_RAW_SENTINEL + 2);

    const queued = queueAnalysisRebuild(db, {
      scope: 'all',
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
    }, REQUESTED_AT, true);
    updateAnalysisRebuild(db, queued.generation, {state:'running'});
    const activeFactsBefore = orderedRows(db, 'claude_events');
    const bookmarksBefore = sourceMetadataState(db);
    const gaugesBefore = gaugeState(db);

    const outcome = await runRebuildChild(f, accountRequest(queued.generation));
    expect(outcome.exit !== 0 || outcome.result?.status !== 'success').toBe(true);
    expect(`${outcome.stderr}\n${outcome.stdout}\n${JSON.stringify(outcome.result)}`)
      .toMatch(/hybrid|selected.*unselected|account.*scope|outside.*scope/i);
    expect(orderedRows(db, 'claude_events')).toEqual(activeFactsBefore);
    expect(sourceMetadataState(db)).toEqual(bookmarksBefore);
    expect(gaugeState(db)).toEqual(gaugesBefore);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      accounts: [{ vendor: 'claude', account: 'claude-selected' }],
      phase: 'sources',
    });
  } finally {
    db.close(true);
    Bun.gc(true);
  }
}, 60_000);
