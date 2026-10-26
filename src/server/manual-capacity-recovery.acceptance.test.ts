import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RateCard } from "./pricing";
import { measureAnalysis } from "./claude-code-capacity.fixture";
import type { ManualCapacityInput, ManualCapacityMeasurement, ManualCapacityStore } from "../shared/manual-capacity";
import { removeTestFixture } from "../test-cleanup";
import { prepareProviderReaderFacts } from "./provider-reader.fixture";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";

const roots: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const root of roots.splice(0)) removeTestFixture(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const START = "2026-08-10T10:00:00.000Z";
const END = "2026-08-10T12:00:00.000Z";
const COUNTER = '["weekly_all","weekly",10080]';
const RATES: RateCard = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {
    anthropic: {
      source: "manual-capacity-recovery-fixture",
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
};

async function childJson(code: string, env: NodeJS.ProcessEnv): Promise<any> {
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill(), 30_000);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(watchdog));
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

test("HTTP manual Claude capacity survives edit, restart from the archive and deletion without repricing prepared traffic", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-manual-recovery-"));
  roots.push(base);
  const archiveRoot = path.join(base, "archive");
  const configRoot = path.join(archiveRoot, "config");
  const localState = path.join(base, "local-state");
  const prior = Object.fromEntries(["TOKENATLAS_ARCHIVE", "TOKENATLAS_CONFIG", "TOKENATLAS_LOCAL_STATE", "TOKENATLAS_FROZEN_CONFIG"]
    .map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    TOKENATLAS_ARCHIVE: archiveRoot,
    TOKENATLAS_CONFIG: configRoot,
    TOKENATLAS_LOCAL_STATE: localState,
    TOKENATLAS_FROZEN_CONFIG: "1",
  });

  let db: Database | null = null;
  try {
    const [manualModule, inventoryModule, supportModule, accountingModule, ledgerModule, analysisModule] = await Promise.all([
      import("./manual-capacity"),
      import("../sync/archive-inventory"),
      import("../sync/test-support"),
      import("./subscription-accounting"),
      import("./usage-ledger-producer"),
      import("../db/analysis"),
    ]);
    const { handleManualCapacity, readManualCapacity } = manualModule;
    const { ensureArchiveIdentity } = inventoryModule;
    const { createTestDatabase } = supportModule;
    const { buildSubscriptionAccountingReport } = accountingModule;
    const { stepUsageLedger, usageLedgerState } = ledgerModule;
    const { installAnalysisTracking } = analysisModule;

    const created = createTestDatabase();
    roots.push(created.directory);
    db = new Database(created.dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    installAnalysisTracking(db);

    fs.mkdirSync(archiveRoot);
    ensureArchiveIdentity(archiveRoot);
    fs.mkdirSync(configRoot);
    const accountsFile = path.join(configRoot, "accounts.json");
    fs.writeFileSync(accountsFile, JSON.stringify({ subscriptions: [
      { id: ACCOUNT_A, vendor: "claude", home: "fixture-a" },
      { id: ACCOUNT_B, vendor: "claude", home: "fixture-b" },
    ] }, null, 2) + "\n");

    const insertEvent = db.query(`INSERT INTO claude_events
      (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,project_id,in_uncached,out_total)
      VALUES (?,?,?,?,?,'claude-recovery-fixture','standard',?,'cli','fixture',NULL,?,?)`);
    const addEvent = (id: string, ts: string, account: string, input: number, output: number) =>
      insertEvent.run("fixture", id, `session-${id}`, path.join(base, `${id}.jsonl`), ts, account, input, output);
    addEvent("a-one", "2026-08-10T10:30:00.000Z", ACCOUNT_A, 100, 50);
    addEvent("a-two", "2026-08-10T11:30:00.000Z", ACCOUNT_A, 200, 100);
    addEvent("b-foreign", "2026-08-10T11:00:00.000Z", ACCOUNT_B, 1000, 500);
    insertEvent.finalize();

    const insertProbe = db.query(`INSERT INTO probe_windows
      (provider,subject,ts,plan,kind,limit_group,reported_percent_side,used_percent,vendor_percent,resets_at,window_minutes,ok,machine)
      VALUES ('claude',?,?,'pro','weekly_all','weekly','used',?,?,?,10080,1,'fixture')`);
    insertProbe.run(ACCOUNT_A, START, 20, 20, "2026-08-17T00:00:00.000Z");
    insertProbe.run(ACCOUNT_A, END, 40, 40, "2026-08-17T00:00:00.000Z");
    insertProbe.finalize();

    for (const account of [ACCOUNT_A, ACCOUNT_B]) {
      let steps = 0;
      while (!prepareProviderReaderFacts(db, "claude", account, undefined, 2, RATES).complete) {
        if (++steps > 100) throw new Error("Prepared subscription facts did not finish");
      }
    }
    // The two saved samples come from the same physical Claude profile as the account-a event source.
    prepareProbeReaderFixture(db, [{ id: ACCOUNT_A, vendor: "claude", machine: "fixture", login: "fixture",
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/fixture`, source_home: "C:/Users/fixture/.claude" }]);

    const report = (manualCapacity: ManualCapacityMeasurement[], account = ACCOUNT_A, detail?: string) => {
      // The maintenance worker publishes windows with the measurements the editor saved.
      prepareLimitWindowsFixture(db!, { manualCapacity: provider => provider === "claude" ? manualCapacity : [] });
      // ...and their sums, standalone measurements included.
      prepareWindowUsageFixture(db!, { rateCards: RATES, claudeGauge: {}, cycles: { windows: [] },
        manualCapacity: provider => provider === "claude" ? manualCapacity : [] });
      const measured = measureAnalysis(db!, () => buildSubscriptionAccountingReport({
        sqlite: db!,
        rateCards: RATES,
        plans: { segments: [], capacity_regimes: [] },
        plansCatalog: { provider_groups: [] },
        manualCapacity,
      }, "claude", {
        account,
        since: "2026-08-10",
        until: "2026-08-10",
        ...(detail ? { detail_cycle: detail } : {}),
      }));
      return measured.value;
    };
    const count = (table: string, where = "") =>
      (db!.query(`SELECT COUNT(*) AS n FROM ${table}${where}`).get() as { n: number }).n;
    // The prepared traffic's stored valuations and the ledger's revision: repricing would change them.
    const VALUATIONS = `SELECT row_id,std_key,std_reason,std_nano,std_femto,act_key,act_reason,act_nano,act_femto,
      glb_key,glb_reason,glb_nano,glb_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`;
    const ledger = () => ({ valuations: JSON.stringify(db!.query(VALUATIONS).all()), revision: usageLedgerState(db!, "claude")!.revision });
    const probeRows = () => db!.query(`SELECT provider,subject,ts,kind,limit_group,used_percent,resets_at
      FROM probe_windows ORDER BY id`).all();

    const expectedProbeRows = [
      { provider: "claude", subject: ACCOUNT_A, ts: START, kind: "weekly_all", limit_group: "weekly", used_percent: 20, resets_at: "2026-08-17T00:00:00.000Z" },
      { provider: "claude", subject: ACCOUNT_A, ts: END, kind: "weekly_all", limit_group: "weekly", used_percent: 40, resets_at: "2026-08-17T00:00:00.000Z" },
    ];
    expect(probeRows()).toEqual(expectedProbeRows);
    const probeReport = report([]);
    expect(probeReport.events).toBe(2);
    expect(probeReport.tokens).toBe(450);
    expect(probeReport.amounts.api_equivalent_usd).toMatchObject({ status: "complete", value: 0.0021, priced_events: 2, priced_tokens: 450 });
    report([], ACCOUNT_B);
    const prepared = ledger();
    const factRows = count("usage_ledger_facts");
    expect(factRows).toBe(3);

    const invoke = async (body?: unknown): Promise<{ response: Response; store: ManualCapacityStore }> => {
      const response = await handleManualCapacity(new Request(
        `http://localhost/api/manual-capacity?provider=claude&account=${ACCOUNT_A}`,
        body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      ), configRoot);
      return { response, store: await response.json() as ManualCapacityStore };
    };

    const initial = await invoke();
    expect(initial.response.status).toBe(200);
    expect(initial.store).toEqual({ revision: "empty", measurements: [] });
    const input: ManualCapacityInput = {
      counter: COUNTER,
      start: START,
      end: END,
      start_percent: 20,
      end_percent: 40,
      approximate_time: false,
      note: "Original provider panel reading",
    };
    const added = await invoke({ revision: initial.store.revision, measurement: input });
    expect(added.response.status).toBe(200);
    expect(added.store.measurements).toHaveLength(1);
    const id = added.store.measurements[0]!.id;
    expect(readManualCapacity("claude", configRoot)).toEqual(added.store);

    const addedReport = report(added.store.measurements, ACCOUNT_A, `manual:${id}`);
    const addedWindow = addedReport.windows!.find(window => window.manual_measurement?.id === id)!;
    expect(addedReport.events).toBe(2);
    expect(addedReport.tokens).toBe(450);
    expect(addedWindow).toMatchObject({
      start: START, cycle_start: "2026-08-10T00:00:00.000Z",
      end: END,
      observed_pp: 20,
      manual_measurement: { id, approximate_time: false, note: input.note },
      usage: { events: 2, tokens: 450, api_standard: 0.0021 },
    });
    expect(addedWindow.timeline!.readings.filter(reading => reading.source === "manual").map(reading => [reading.percent, reading.source])).toEqual([[20, "manual"], [40, "manual"]]);
    expect(addedWindow.usage.tokens / addedWindow.observed_pp).toBe(22.5);
    expect(addedWindow.usage.api_standard / addedWindow.observed_pp).toBeCloseTo(0.000105, 12);
    expect(ledger()).toEqual(prepared);
    expect(count("usage_ledger_facts")).toBe(factRows);

    const editedInput: ManualCapacityInput = {
      ...input,
      id,
      end_percent: 60,
      approximate_time: true,
      note: "Corrected approximate panel reading",
    };
    const edited = await invoke({ revision: added.store.revision, measurement: editedInput });
    expect(edited.response.status).toBe(200);
    expect(edited.store.measurements).toHaveLength(1);
    const editedReport = report(edited.store.measurements, ACCOUNT_A, `manual:${id}`);
    const editedWindow = editedReport.windows!.find(window => window.manual_measurement?.id === id)!;
    expect(editedWindow).toMatchObject({
      start: START, cycle_start: "2026-08-10T00:00:00.000Z",
      end: END,
      observed_pp: 40,
      manual_measurement: { id, approximate_time: true, note: editedInput.note },
      usage: { events: 2, tokens: 450, api_standard: 0.0021 },
    });
    expect(editedWindow.timeline!.readings.filter(reading => reading.source === "manual").map(reading => [reading.percent, reading.source])).toEqual([[20, "manual"], [60, "manual"]]);
    expect(editedWindow.usage.tokens / editedWindow.observed_pp).toBe(11.25);
    expect(editedWindow.usage.api_standard / editedWindow.observed_pp).toBeCloseTo(0.0000525, 12);
    expect(report(edited.store.measurements, ACCOUNT_B).windows!.some(window => window.id.startsWith("manual:"))).toBe(false);
    expect(report(edited.store.measurements, ACCOUNT_B).tokens).toBe(1500);
    expect(probeRows()).toEqual(expectedProbeRows);
    expect(ledger()).toEqual(prepared);
    expect(stepUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });

    fs.writeFileSync(path.join(configRoot, "rate-cards.json"), JSON.stringify(RATES));
    // The saved readings live in the archive's own configuration, which is the durable copy.
    expect(fs.existsSync(path.join(archiveRoot, "config", "manual-capacity-claude.json"))).toBe(true);

    // Recovery reads that configuration in place: a restarted process with no local state of its own
    // rebuilds the edited window from the archive and the prepared database without repricing.
    db.close(true);
    db = null;
    const manualModulePath = JSON.stringify(path.resolve(import.meta.dir, "manual-capacity.ts"));
    const accountingModulePath = JSON.stringify(path.resolve(import.meta.dir, "subscription-accounting.ts"));
    const measureModulePath = JSON.stringify(path.resolve(import.meta.dir, "claude-code-capacity.fixture.ts"));
    const recovered = await childJson(`import fs from 'node:fs'; import path from 'node:path'; import {Database} from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
      import {readManualCapacity} from ${manualModulePath};
      import {buildSubscriptionAccountingReport} from ${accountingModulePath};
      import {measureAnalysis} from ${measureModulePath};
      import {prepareLimitWindowsFixture} from ${JSON.stringify(path.resolve(import.meta.dir, "limit-windows.fixture.ts"))};
      import {prepareWindowUsageFixture} from ${JSON.stringify(path.resolve(import.meta.dir, "window-usage.fixture.ts"))};
      const db = new Database(${JSON.stringify(created.dbPath)});
      const store = readManualCapacity('claude');
      prepareLimitWindowsFixture(db, { manualCapacity: provider => provider === 'claude' ? store.measurements : [] });
      const config = process.env.TOKENATLAS_CONFIG;
      if (!config) throw new Error('missing restored config');
      prepareWindowUsageFixture(db, { rateCards: JSON.parse(fs.readFileSync(path.join(config,'rate-cards.json'),'utf8')), claudeGauge: {},
        cycles: { windows: [] }, manualCapacity: provider => provider === 'claude' ? store.measurements : [] });
      const accounts = JSON.parse(fs.readFileSync(path.join(config,'accounts.json'),'utf8')).subscriptions.map(s => s.id);
      const context = {sqlite:db,rateCards:JSON.parse(fs.readFileSync(path.join(config,'rate-cards.json'),'utf8')),plans:{segments:[],capacity_regimes:[]},plansCatalog:{provider_groups:[]},manualCapacity:store.measurements};
      const opts = {account:${JSON.stringify(ACCOUNT_A)},since:'2026-08-10',until:'2026-08-10',detail_cycle:'manual:'+store.measurements[0].id};
      const measured = measureAnalysis(db, () => buildSubscriptionAccountingReport(context,'claude',opts));
      const report = measured.value;
      const window = report.windows.find(w => w.manual_measurement?.id === store.measurements[0].id);
      const other = buildSubscriptionAccountingReport(context,'claude',{account:${JSON.stringify(ACCOUNT_B)},since:'2026-08-10',until:'2026-08-10'});
      const probes = db.query('SELECT provider,subject,ts,kind,limit_group,used_percent,resets_at FROM probe_windows ORDER BY id').all();
      const valuations = JSON.stringify(db.query(${JSON.stringify(VALUATIONS)}).all());
      const revision = db.query("SELECT revision FROM usage_ledger_state WHERE provider='claude'").get().revision;
      const facts = db.query('SELECT COUNT(*) AS n FROM usage_ledger_facts').get().n;
      db.close(true);
      console.log(JSON.stringify({store,accounts,probes,ledger:{valuations,revision},facts,report:{events:report.events,tokens:report.tokens,amount:report.amounts.api_equivalent_usd.value,window},other:{events:other.events,tokens:other.tokens,manualIds:(other.windows || []).filter(w => w.id.startsWith('manual:')).map(w => w.id)}}));`, {
      ...process.env,
      TOKENATLAS_ARCHIVE: archiveRoot,
      TOKENATLAS_CONFIG: configRoot,
      TOKENATLAS_LOCAL_STATE: path.join(base, "recovered-local-state"),
      TOKENATLAS_FROZEN_CONFIG: "1",
    });

    expect(recovered.store).toEqual(edited.store);
    expect(recovered.accounts).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(recovered.probes).toEqual(expectedProbeRows);
    expect(recovered.ledger).toEqual(prepared);
    expect(recovered.facts).toBe(factRows);
    expect(recovered.report).toMatchObject({
      events: 2,
      tokens: 450,
      amount: 0.0021,
      window: {
        id: expect.any(String),
        start: START, cycle_start: "2026-08-10T00:00:00.000Z",
        end: END,
        observed_pp: 40,
        manual_measurement: { id, approximate_time: true, note: editedInput.note },
        usage: { events: 2, tokens: 450, api_standard: 0.0021 },
      },
    });
    expect(recovered.report.window.timeline.readings.filter((reading: { source: string }) => reading.source === "manual").map((reading: { percent: number; source: string }) => [reading.percent, reading.source])).toEqual([[20, "manual"], [60, "manual"]]);
    expect(recovered.report.window.usage.tokens / recovered.report.window.observed_pp).toBe(11.25);
    expect(recovered.report.window.usage.api_standard / recovered.report.window.observed_pp).toBeCloseTo(0.0000525, 12);
    expect(recovered.other).toEqual({ events: 1, tokens: 1500, manualIds: [] });

    db = new Database(created.dbPath);
    const removed = await invoke({ revision: edited.store.revision, remove: id });
    expect(removed.response.status).toBe(200);
    expect(removed.store.measurements).toEqual([]);
    expect(readManualCapacity("claude", configRoot)).toEqual(removed.store);
    const deletedReport = report([]);
    expect(deletedReport.windows).toEqual(probeReport.windows);
    expect(probeRows()).toEqual(expectedProbeRows);
    expect(ledger()).toEqual(prepared);
    expect(count("usage_ledger_facts")).toBe(factRows);

    const deletedRestart = await childJson(`import {readManualCapacity} from ${manualModulePath};
      console.log(JSON.stringify(readManualCapacity('claude')));`, {
      ...process.env,
      TOKENATLAS_ARCHIVE: archiveRoot,
      TOKENATLAS_CONFIG: configRoot,
      TOKENATLAS_LOCAL_STATE: localState,
      TOKENATLAS_FROZEN_CONFIG: "1",
    });
    expect(deletedRestart).toEqual(removed.store);
  } finally {
    if (db) {
      try { db.close(true); } catch { /* already closed during a failed restart assertion */ }
    }
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 60_000);
