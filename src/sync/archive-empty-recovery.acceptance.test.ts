import { afterEach, expect, test } from "bun:test";
import { removeTestFixture } from "../test-cleanup";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import path from "node:path";
import { createCodexSchema, createTestDatabase } from "./test-support";
import { VENDOR_IDS, type SyncRunResult } from "./contracts";
import { handleManualCapacity } from "../server/manual-capacity";
import type { ManualCapacityInput, ManualCapacityStore } from "../shared/manual-capacity";

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0)) {
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const ACCOUNT = "claude-recovery";
const PROFILE = "RECOVERY-PC-user";
const GEMINI_PROFILE = "MAPPEDPROFILE";
const START = "2026-08-10T10:00:00.000Z";
const END = "2026-08-10T12:00:00.000Z";
const COUNTER = '["weekly_all","weekly",10080]';
const GENERATION = 920_000;

const RATES = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {
    anthropic: {
      source: "empty-archive-recovery-fixture",
      models: {
        "claude-recovery-fixture": {
          in_uncached: 2,
          in_cache_read: 0,
          in_cache_write_5m: 0,
          in_cache_write_1h: 0,
          out_total: 10,
        },
      },
    },
  },
} as const;

function initializeEngineSchema(dbPath: string): void {
  createCodexSchema(dbPath);
}

function count(sqlite: Database, table: string): number {
  // The usage ledger is installed on its first background preparation.
  if (table === "usage_ledger_facts" && !sqlite.query(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger_facts'"
  ).get()) return 0;
  return (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function createManualMeasurement(configRoot: string): Promise<ManualCapacityStore> {
  const endpoint = `http://localhost/api/manual-capacity?provider=claude&account=${ACCOUNT}`;
  const initialResponse = await handleManualCapacity(new Request(endpoint), configRoot);
  expect(initialResponse.status).toBe(200);
  const initial = await initialResponse.json() as ManualCapacityStore;
  const measurement: ManualCapacityInput = {
    counter: COUNTER,
    start: START,
    end: END,
    start_percent: 20,
    end_percent: 60,
    approximate_time: false,
    note: "Recovered provider panel reading",
  };
  const response = await handleManualCapacity(new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: initial.revision, measurement }),
  }), configRoot);
  expect(response.status).toBe(200);
  const store = await response.json() as ManualCapacityStore;
  expect(store.measurements).toHaveLength(1);
  return store;
}

function createOpenCodeFixture(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const source = new Database(file, { create: true });
  try {
    source.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    source.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    source.query("INSERT INTO session VALUES (?, ?)").run("open-session", "C:/recovered/opencode");
    source.query("INSERT INTO message VALUES (?, ?, ?)").run(
      "open-message",
      "open-session",
      JSON.stringify({
        role: "assistant",
        modelID: "glm-5",
        providerID: "zai",
        time: { created: Date.UTC(2026, 7, 10, 11, 0, 0) },
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        cost: 0.01,
      }),
    );
  } finally {
    source.close(true);
  }
}

function createGeminiFixture(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const source = new Database(file, { create: true });
  try {
    source.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    source.query("INSERT INTO gen_metadata VALUES (0, ?)")
      .run(new Uint8Array([10, 4, 34, 2, 16, 123]));
  } finally {
    source.close(true);
  }
  const fallbackTime = Date.parse("2026-08-10T11:15:00.000Z") / 1000;
  fs.utimesSync(file, fallbackTime, fallbackTime);
}

async function runRebuild(
  dbPath: string,
  request: Record<string, unknown>,
  env: Record<string, string>,
): Promise<SyncRunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "runner.ts"), JSON.stringify({
      dbPath,
      rootDir: process.cwd(),
      request,
    })],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill(), 60_000);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(watchdog));
  expect(exit, stderr).toBe(0);
  const line = stdout.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length)) as SyncRunResult;
}

function vendorStatuses(result: SyncRunResult) {
  return result.vendors
    .map(vendor => ({ vendor: vendor.vendor, status: vendor.status, error: vendor.error }))
    .sort((left, right) => left.vendor.localeCompare(right.vendor));
}

function expectedVendorStatuses() {
  return [...VENDOR_IDS]
    .map(vendor => ({ vendor, status: "success" as const, error: null }))
    .sort((left, right) => left.vendor.localeCompare(right.vendor));
}

function recoveredFacts(dbPath: string) {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return {
      claude: sqlite.query(`SELECT call_id,account_key,model,speed,in_uncached,out_total
        FROM claude_events ORDER BY call_id`).all(),
      codex: sqlite.query("SELECT ts,model,in_tok,out_tok FROM events ORDER BY ts").all(),
      opencode: sqlite.query(`SELECT store,message_id,model,provider,in_tok,out_tok,reasoning,cache_read,cache_write,cost
        FROM oc_events ORDER BY store,message_id`).all(),
      grok: sqlite.query(`SELECT store,session_id,prompt_id,model,in_tok,out_tok
        FROM grok_events ORDER BY store,session_id,prompt_id`).all(),
      gemini: sqlite.query(`SELECT store,conversation_id,gen_idx,model,fresh_in
        FROM gemini_events ORDER BY store,conversation_id,gen_idx`).all(),
      gauges: sqlite.query(`SELECT subject,ts,used_percent FROM probe_windows
        ORDER BY ts`).all(),
      claudeFiles: sqlite.query("SELECT store,path,size,mtime,calls FROM claude_files ORDER BY store,path").all(),
      codexFiles: sqlite.query("SELECT home,path,size,mtime,events FROM files ORDER BY home,path").all(),
      grokFiles: sqlite.query("SELECT store,path,size,mtime,turns FROM grok_files ORDER BY store,path").all(),
      geminiFiles: sqlite.query("SELECT store,path,size,mtime,generations FROM gemini_files ORDER BY store,path").all(),
      gaugeFiles: sqlite.query("SELECT store,path,size,mtime,rows FROM gauge_files ORDER BY store,path").all(),
      probeCounters: sqlite.query("SELECT * FROM probe_counters ORDER BY id").all(),
    };
  } finally {
    sqlite.close(true);
  }
}

async function recoveredReport(
  dbPath: string,
  configRoot: string,
  env: Record<string, string>,
): Promise<{
  store: ManualCapacityStore;
  accounts: string[];
  events: number;
  tokens: number;
  amount: number;
  observedPp: number;
  tokensPerPp: number;
  ledgerFacts: number;
  ledgerValuations: string;
  gemini: { events: number; tokens: number; amount: number | null; status: string };
}> {
  const manualModule = JSON.stringify(path.resolve(import.meta.dir, "../server/manual-capacity.ts"));
  const accountingModule = JSON.stringify(path.resolve(import.meta.dir, "../server/subscription-accounting.ts"));
  const ledgerModule = JSON.stringify(path.resolve(import.meta.dir, "../server/usage-ledger.fixture.ts"));
  const pathsModule = JSON.stringify(path.resolve(import.meta.dir, "../config/paths.ts"));
  const declarationsModule = JSON.stringify(path.resolve(import.meta.dir, "../server/period-declarations.ts"));
  const measureModule = JSON.stringify(path.resolve(import.meta.dir, "../server/claude-code-capacity.fixture.ts"));
  const analysisModule = JSON.stringify(path.resolve(import.meta.dir, "../db/analysis.ts"));
  const currentRegistryModule = JSON.stringify(path.resolve(import.meta.dir, "../server/current/registry.ts"));
  const currentStoreModule = JSON.stringify(path.resolve(import.meta.dir, "../server/current/store.ts"));
  const probeReaderModule = JSON.stringify(path.resolve(import.meta.dir, "../server/current/probe-account-reader.ts"));
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
    import { readManualCapacity } from ${manualModule};
    import { buildSubscriptionAccountingReport } from ${accountingModule};
    import { fillUsageLedger } from ${ledgerModule};
    import { ARCHIVE_LOGICAL_ROOT } from ${pathsModule};
    import { applyPeriodDeclarations } from ${declarationsModule};
    import { measureAnalysis } from ${measureModule};
    import { installAnalysisTracking } from ${analysisModule};
    import { currentRegistry } from ${currentRegistryModule};
    import { publishCurrentBatch } from ${currentStoreModule};
    import { preparedProbeAccountIndexReady } from ${probeReaderModule};
    import { prepareLimitWindowsFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "../server/limit-windows.fixture.ts"))};
    const sqlite = new Database(${JSON.stringify(dbPath)});
    const configRoot = ${JSON.stringify(configRoot)};
    const accounts = JSON.parse(fs.readFileSync(path.join(configRoot, "accounts.json"), "utf8"));
    const rates = JSON.parse(fs.readFileSync(path.join(configRoot, "rate-cards.json"), "utf8"));
    const store = readManualCapacity("claude", configRoot);
    // The server applies the archived declarations on its first tick; the rebuild itself only restores the file.
    const declarations = applyPeriodDeclarations(sqlite, path.join(configRoot, "account-periods.json"));
    if (declarations.errors.length) throw new Error(declarations.errors.join("; "));
    // Start the regular producers, then publish with the restored source declarations and
    // the real archive root so the archived Claude meter resolves through its dated source.
    installAnalysisTracking(sqlite);
    const physical = { archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: "fixture" };
    const registry = currentRegistry(accounts.subscriptions);
    let steps = 0;
    while (publishCurrentBatch(sqlite, registry, new Date().toISOString(), 32, accounts, physical)) {
      if (++steps > 1000) throw new Error("Current probe publication did not settle");
    }
    for (const [provider, account] of [["claude", ${JSON.stringify(ACCOUNT)}], ["gemini", "gemini-recovery"]])
      if (!preparedProbeAccountIndexReady(sqlite, provider, account)) throw new Error("Prepared probe index missing for " + provider + "/" + account);
    // The usage ledger: facts carry archived sources; accounts resolve at read time from the declarations.
    for (const provider of ["claude", "gemini"]) fillUsageLedger(sqlite, provider, rates, ARCHIVE_LOGICAL_ROOT, 2);
    // The maintenance worker publishes the limit windows from the prepared readings and restored measurements.
    prepareLimitWindowsFixture(sqlite, { sources: accounts.sources, subscriptions: accounts.subscriptions,
      manualCapacity: provider => provider === "claude" ? store.measurements : [] });
    const detail = "manual:" + store.measurements[0].id;
    const measured = measureAnalysis(sqlite, () => ({ claude: buildSubscriptionAccountingReport({
      sqlite,
      declarations: accounts.subscriptions,
      rateCards: rates,
      plans: { segments: [], capacity_regimes: [] },
      plansCatalog: { provider_groups: [] },
      manualCapacity: store.measurements,
    }, "claude", {
      account: ${JSON.stringify(ACCOUNT)},
      since: "2026-08-10",
      until: "2026-08-10",
      detail_cycle: detail,
    }), gemini: buildSubscriptionAccountingReport({sqlite,declarations:accounts.subscriptions,rateCards:rates,plans:{segments:[],capacity_regimes:[]},
      plansCatalog:{provider_groups:[]}}, "gemini", {account:"gemini-recovery",since:"2026-08-10",until:"2026-08-10"}) }));
    const report = measured.value.claude;
    const geminiReport = measured.value.gemini;
    const window = report.windows.find(item => item.id === detail);
    if (!window) throw new Error("Recovered manual window is missing");
    const ledgerFacts = sqlite.query("SELECT COUNT(*) AS n FROM usage_ledger_facts").get().n;
    // The stored valuations, with the ledger revisions: a reopen must neither reprice nor republish them.
    const ledgerValuations = JSON.stringify([sqlite.query(\`SELECT provider,row_id,std_key,std_reason,std_nano,std_femto,
      act_key,act_reason,act_nano,act_femto,glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts ORDER BY provider,row_id\`).all(),
      sqlite.query("SELECT provider,revision,rules_digest FROM usage_ledger_state ORDER BY provider").all()]);
    sqlite.close(true);
    console.log(JSON.stringify({
      store,
      accounts: accounts.subscriptions.map(item => item.id),
      events: report.events,
      tokens: report.tokens,
      amount: report.amounts.api_equivalent_usd.value,
      observedPp: window.observed_pp,
      tokensPerPp: window.usage.tokens / window.observed_pp,
      ledgerFacts,
      ledgerValuations,
      gemini: {events:geminiReport.events,tokens:geminiReport.tokens,
        amount:geminiReport.amounts.api_equivalent_usd.value,status:geminiReport.amounts.api_equivalent_usd.status},
    }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill(), 60_000);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(watchdog));
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout.trim());
}

test("an empty database restores all archived collectors, gauges, rates and manual capacity by reading the archive in place while provider homes are absent", async () => {
  const created = createTestDatabase();
  temporary.push(created.directory);
  initializeEngineSchema(created.dbPath);

  const archiveRoot = path.join(created.directory, "archive");
  const configRoot = path.join(created.directory, "application-config");
  const localState = path.join(created.directory, "local-state");
  const absentHome = path.join(created.directory, "absent-user-home");
  const absentOneDrive = path.join(created.directory, "absent-onedrive");
  fs.mkdirSync(archiveRoot);
  fs.mkdirSync(path.join(archiveRoot,".archive-inventory"));
  fs.writeFileSync(path.join(archiveRoot,".archive-inventory/identity.json"),JSON.stringify({schema:1,archiveId:"empty-recovery-fixture"}));
  fs.mkdirSync(configRoot);

  const claudeHome = path.join(archiveRoot, "claude", PROFILE);
  const claudeFile = path.join(claudeHome, "project", "session.jsonl");
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, [
    { id: "claude-a", session: "session-a", ts: "2026-08-10T10:30:00.000Z", input: 100, output: 50 },
    { id: "claude-b", session: "session-b", ts: "2026-08-10T11:30:00.000Z", input: 200, output: 100 },
  ].map(row => JSON.stringify({
    type: "assistant",
    sessionId: row.session,
    timestamp: row.ts,
    message: {
      id: row.id,
      model: "claude-recovery-fixture",
      stop_reason: "end_turn",
      usage: { input_tokens: row.input, output_tokens: row.output, speed: "standard" },
    },
  })).join("\n") + "\n");

  const codexHome = path.join(archiveRoot, "codex", PROFILE);
  const codexFile = path.join(codexHome, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, [
    { type: "session_meta", payload: { originator: "codex-tui", thread_source: "user", cwd: "C:/recovered" } },
    { type: "turn_context", payload: { model: "gpt-recovery", effort: "high", cwd: "C:/recovered" } },
    { timestamp: "2026-08-10T11:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7, output_tokens: 1 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");

  const openCodeFile = path.join(archiveRoot, "opencode", PROFILE, "opencode.sqlite");
  createOpenCodeFixture(openCodeFile);

  const grokFile = path.join(
    archiveRoot,
    "grok",
    PROFILE,
    "sessions",
    "C%3A%2Fwork",
    "session",
    "updates.jsonl",
  );
  fs.mkdirSync(path.dirname(grokFile), { recursive: true });
  fs.writeFileSync(grokFile, JSON.stringify({
    params: {
      sessionId: "same-session",
      _meta: { agentTimestampMs: Date.parse("2026-08-10T11:00:00Z") },
      update: {
        prompt_id: "p1",
        usage: { modelUsage: { "grok-code": { inputTokens: 9, outputTokens: 3 } } },
      },
    },
  }) + "\n");

  const geminiHome = path.join(archiveRoot, "gemini", GEMINI_PROFILE);
  const geminiFile = path.join(geminiHome, "conversations", "conversation.db");
  createGeminiFixture(geminiFile);

  const gaugeFile = path.join(archiveRoot, "gauges", "recovery-pc", "probe_windows.jsonl");
  fs.mkdirSync(path.dirname(gaugeFile), { recursive: true });
  const gaugeRow = (ts: string, used: number) => JSON.stringify({
    provider: "claude",
    subject: ACCOUNT,
    ts,
    kind: "weekly_all",
    limit_group: "weekly",
    reported_percent_side: "used",
    used_percent: used,
    window_minutes: 10080,
    machine: "recovery-pc",
    login: "fixture",
    extra: { home: "C:/Users/fixture/.claude" },
    raw_subject: ACCOUNT,
    ok: 1,
  });
  fs.writeFileSync(gaugeFile, `${gaugeRow(START, 20)}\n${gaugeRow(END, 60)}\n`);

  const accountsFile = path.join(configRoot, "accounts.json");
  // Register v8: an account is a dated period of an archived source, restored from this file.
  const periodsFile = path.join(configRoot, "account-periods.json");
  const projectsFile = path.join(configRoot, "projects.json");
  const ratesFile = path.join(configRoot, "rate-cards.json");
  fs.writeFileSync(accountsFile, JSON.stringify({ version: 2, subscriptions: [
    { id: ACCOUNT, vendor: "claude" },
    { id: "codex-recovery", vendor: "codex" },
    { id: "opencode-recovery", vendor: "opencode" },
    { id: "grok-recovery", vendor: "grok" },
    { id: "gemini-recovery", vendor: "gemini" },
  ], sources: [
    { vendor: "claude", machine: "recovery-pc", login: "fixture", home: claudeHome, source_home: "C:/Users/fixture/.claude" },
    { vendor: "codex", home: codexHome },
    { vendor: "opencode", home: path.dirname(openCodeFile) },
    { vendor: "grok", home: path.join(archiveRoot, "grok", PROFILE) },
    { vendor: "gemini", home: geminiHome },
  ] }));
  fs.writeFileSync(periodsFile, JSON.stringify({ version: 1, accounts: [
    { provider: "claude", source: `claude/${PROFILE}`, account: ACCOUNT, from: "2026-08-01", evidence: "fixture" },
    { provider: "gemini", source: `gemini/${GEMINI_PROFILE}`, account: "gemini-recovery", from: "2026-08-01", evidence: "fixture" },
  ] }));
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [] }));
  fs.writeFileSync(ratesFile, JSON.stringify(RATES));
  const manualStore = await createManualMeasurement(configRoot);
  const manualFile = path.join(configRoot, "manual-capacity-claude.json");
  expect(fs.existsSync(manualFile)).toBe(true);

  const request = {
    trigger: "manual",
    scope: { kind: "all" },
    mode: "incremental",
    reparse: {},
    rebuildGeneration: GENERATION,
    collection: "archive",
  } as const;

  const emptyCounts = {
    claude: 0,
    codex: 0,
    opencode: 0,
    grok: 0,
    gemini: 0,
    gauges: 0,
    facts: 0,
  };
  let sqlite = new Database(created.dbPath, { readonly: true });
  try {
    expect({
      claude: count(sqlite, "claude_events"),
      codex: count(sqlite, "events"),
      opencode: count(sqlite, "oc_events"),
      grok: count(sqlite, "grok_events"),
      gemini: count(sqlite, "gemini_events"),
      gauges: count(sqlite, "probe_windows"),
      facts: count(sqlite, "usage_ledger_facts"),
    }).toEqual(emptyCounts);
  } finally {
    sqlite.close(true);
  }

  // No provider folder exists (absent home, AppData and OneDrive): every source is read from the archive,
  // and the application configuration is the live one the rebuild finds in Settings.
  const recoveredConfig = configRoot;
  const isolatedEnv = {
    TOKENATLAS_ARCHIVE: archiveRoot,
    TOKENATLAS_CONFIG: recoveredConfig,
    TOKENATLAS_LOCAL_STATE: localState,
    TOKENATLAS_DB: created.dbPath,
    TOKENATLAS_FROZEN_CONFIG: "1",
    TOKENATLAS_MACHINE: "RECOVERY-FIXTURE",
    TOKENATLAS_LOGIN: "fixture",
    HOME: absentHome,
    USERPROFILE: absentHome,
    APPDATA:path.join(created.directory,"absent-appdata"),
    LOCALAPPDATA:path.join(created.directory,"absent-localappdata"),
    OneDrive: absentOneDrive,
  };

  const firstRun = await runRebuild(created.dbPath, request, isolatedEnv);
  expect({
    status: firstRun.status,
    error: firstRun.error,
    vendors: vendorStatuses(firstRun),
  }).toEqual({
    status: "success",
    error: null,
    vendors: expectedVendorStatuses(),
  });
  expect(firstRun.vendors).toHaveLength(VENDOR_IDS.length);
  // The archive is read where it is: no copy store beside the database.
  expect(fs.existsSync(path.join(path.dirname(created.dbPath), "sync-staging", "archive-jobs"))).toBe(false);

  const firstFacts = recoveredFacts(created.dbPath);
  expect(firstFacts.claude).toEqual([
    // The sessions name no account; the recovered declared period of their folder does (stage 4, W4).
    { call_id: "claude-a", account_key: null, model: "claude-recovery-fixture", speed: "standard", in_uncached: 100, out_total: 50 },
    { call_id: "claude-b", account_key: null, model: "claude-recovery-fixture", speed: "standard", in_uncached: 200, out_total: 100 },
  ]);
  expect(firstFacts.codex).toEqual([
    { ts: "2026-08-10T11:00:00.000Z", model: "gpt-recovery", in_tok: 7, out_tok: 1 },
  ]);
  expect(firstFacts.opencode).toEqual([{
    store: PROFILE,
    message_id: "open-message",
    model: "glm-5",
    provider: "zai",
    in_tok: 10,
    out_tok: 4,
    reasoning: 2,
    cache_read: 3,
    cache_write: 1,
    cost: 0.01,
  }]);
  expect(firstFacts.grok).toEqual([{
    store: "grok",
    session_id: "same-session",
    prompt_id: "p1",
    model: "grok-code",
    in_tok: 9,
    out_tok: 3,
  }]);
  // The fixture intentionally has no Gemini model declaration. Its 123 fresh
  // tokens remain attributable to the recovered account while the model stays
  // missing, rather than being converted into a guessed zero-priced model.
  expect(firstFacts.gemini).toEqual([{
    store: "source:gemini:MAPPEDPROFILE",
    conversation_id: "conversation",
    gen_idx: 0,
    model: null,
    fresh_in: 123,
  }]);
  expect(firstFacts.gauges).toEqual([
    { subject: ACCOUNT, ts: START, used_percent: 20 },
    { subject: ACCOUNT, ts: END, used_percent: 60 },
  ]);
  const firstReport = await recoveredReport(created.dbPath, recoveredConfig, isolatedEnv);
  expect(firstReport.store).toEqual(manualStore);
  expect(firstReport.accounts).toEqual([
    ACCOUNT,
    "codex-recovery",
    "opencode-recovery",
    "grok-recovery",
    "gemini-recovery",
  ]);
  expect(firstReport).toMatchObject({
    events: 2,
    tokens: 450,
    amount: 0.0021,
    observedPp: 40,
    tokensPerPp: 11.25,
  });
  expect(firstReport.gemini).toMatchObject({events:1,tokens:123,amount:null});
  expect(firstReport.gemini.status).not.toBe("complete");
  // Two Claude calls and one Gemini call, each a stored ledger fact.
  expect(firstReport.ledgerFacts).toBe(3);

  const resumed = await runRebuild(created.dbPath, request, isolatedEnv);
  expect({
    status: resumed.status,
    error: resumed.error,
    vendors: vendorStatuses(resumed),
  }).toEqual({
    status: "success",
    error: null,
    vendors: expectedVendorStatuses(),
  });
  expect(resumed.vendors).toHaveLength(VENDOR_IDS.length);
  expect(recoveredFacts(created.dbPath)).toEqual(firstFacts);

  const reopenedReport = await recoveredReport(created.dbPath, recoveredConfig, isolatedEnv);
  expect(reopenedReport).toEqual(firstReport);
}, 60_000);
