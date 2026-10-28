import { dailyJournalFile } from "../providers/core/journal-files";
import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyDrizzleMigrations } from "../db/migrate";
import { ingestGaugesAsync } from "../ingest/gauges";
import { flushGaugeJournal, PROBE_JOURNAL_FILE } from "../providers/core/journal";
import { deliverGaugeJournal } from "../server/background-jobs";
import { createFetchHandler, type AppContext } from "../server/api";
import { currentRegistry } from "../server/current/registry";
import { publishCurrentBatch } from "../server/current/store";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { adaptersWith, noMirror, successfulNoop } from "./test-support";
import { removeTestFixture } from "../test-cleanup";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { splitProbeReaderFixtureConfig } from "../server/probe-reader.fixture";

const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, file)).href);
const declarations = ["MAIN", "LAPTOP"].map(machine => ({ id: "one", vendor: "codex", machine,
  home: `${ARCHIVE_LOGICAL_ROOT}/codex/${machine}-fixture`, source_home: "C:/Users/fixture/.codex" }));
const accounts = splitProbeReaderFixtureConfig(declarations);

function open(file: string, migrate = false) {
  const db = new Database(file, { create: true });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000");
    if (migrate) {
      applyDrizzleMigrations(drizzle(db));
      replaceDeclaredPeriods(db, ACCOUNT_PERIODS, declarations.map(source => ({
        provider: "codex", subject: `codex/${source.machine}-fixture`.toLowerCase(), value: "one",
        from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
        readings: 0, evidence: "fixture",
      })));
    }
    return db;
  } catch (error) { db.close(true); throw error; }
}
function state(db: Database) {
  return {
    probes: db.query("SELECT * FROM probe_windows ORDER BY id").all(),
    receipts: db.query("SELECT * FROM gauge_journal_receipts ORDER BY entry_id").all(),
    bookmarks: db.query("SELECT * FROM gauge_files ORDER BY store, path").all(),
    usage: db.query("SELECT * FROM sync_revisions").all(),
    gaugeRevision: db.query("SELECT data_revision FROM vendor_sync_revisions WHERE vendor='gauges'").all(),
    projection: db.query("SELECT * FROM current_projection_state").all(),
  };
}
function router(sqlite: Database) {
  const context = { sqlite, accounts, homeConflict: null, eraErrors: [],
    homeToSubId: new Map(), subIdToHomes: new Map(), claudeGauge: {}, grokGauge: {},
    rateCards: { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {} },
  } as unknown as AppContext;
  return createFetchHandler(context);
}

/** Real producer subprocess; only synthetic paths/data are passed to it. No live probe. */
async function produce(dbPath: string, archiveRoot: string, machine: string, ts: string, percent: number, error = false) {
  const root = path.join(archiveRoot, "gauges", `${machine}-fixture`);
  const code = `
    import { Database } from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
    import { configureGaugeJournal } from ${moduleUrl("../providers/core/journal.ts")};
    import { persistProbeWindows } from ${moduleUrl("../providers/core/probe.ts")};
    const db = new Database(${JSON.stringify(dbPath)});
    try {
      configureGaugeJournal(${JSON.stringify(root)}, { archiveRoot: ${JSON.stringify(archiveRoot)} });
      persistProbeWindows(db, "codex", "one", ${JSON.stringify(ts)}, [{
        kind: ${JSON.stringify(error ? "error" : "primary")}, group: "codex", scope: null, plan: "plus",
        reportedPercentSide: "used", usedPercent: ${error ? "null" : percent}, remainingPercent: null,
        vendorPercent: ${error ? "null" : percent}, windowMinutes: 300, allowance: null, used: null,
        remaining: null, resetsAt: ${JSON.stringify(new Date(Date.now() + 3_600_000).toISOString())},
        rateLimitReached: false, resetCredits: null, profile: "fixture", ok: ${!error},
        error: ${JSON.stringify(error ? "synthetic-no-login" : null)}, extra: { home: "C:/Users/fixture/.codex" }
      }]);
    } finally { db.close(true); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe",
    env: { ...process.env, TOKENATLAS_MACHINE: machine, TOKENATLAS_LOGIN: "fixture",
      TOKENATLAS_DB: dbPath, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: path.join(archiveRoot, "config") } });
  const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 5000);
  try { expect(await child.exited).toBe(0); await stdout; expect(await stderr).toBe(""); }
  finally { clearTimeout(timeout); if (child.exitCode == null) child.kill(); await child.exited; }
  return { journalRoot: root, archiveRoot };
}
async function deliver(dbPath: string, target: { journalRoot: string; archiveRoot: string }) {
  // A NEW delivery (the background writer's job), after the original producer process has already exited.
  const db = open(dbPath);
  try {
    expect(deliverGaugeJournal(db, target)).toMatchObject({ error: null, pending: 0 });
    expect(db.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
  } finally { db.close(true); }
}

test("local acceptance: independent producers, restarted delivery, real sync publication and read-only current after restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-gauge-current-acceptance-"));
  const archive = path.join(dir, "isolated-archive");
  const producerA = path.join(dir, "main.sqlite"), producerB = path.join(dir, "laptop.sqlite");
  const receiver = path.join(dir, "receiver.sqlite");
  let db: Database | null = null;
  let coordinator: SyncCoordinator | null = null;
  try {
    open(producerA, true).close(true); open(producerB, true).close(true); db = open(receiver, true);
    const time = Date.now() - 120_000;
    const iso = (offset: number) => new Date(time + offset).toISOString();
    const first = await produce(producerA, archive, "MAIN", iso(0), 42);
    const pending = open(producerA);
    try {
      expect(flushGaugeJournal(pending, first)).toEqual({ delivered: 0, error: "archive-unavailable" });
      expect(pending.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 1 });
    } finally { pending.close(true); }
    expect(fs.existsSync(archive)).toBe(false);
    fs.mkdirSync(archive); await deliver(producerA, first);
    let revision = 0;
    coordinator = new SyncCoordinator({ archiveInputs: () => undefined, dbPath: receiver, rootDir: path.resolve(import.meta.dir, "../.."), mirror: noMirror,
      configFingerprint: () => "acceptance-v1", sourceFingerprint: () => String(++revision),
      prepareStage: () => {}, refreshDerived: () => {},
      adapters: adaptersWith({ gauges: async ctx => {
        const result = (await ingestGaugesAsync({ atlasPath: ctx.stageDbPath, archiveRoot: archive, ownStore: "RECEIVER-fixture", force: ctx.reparse === true, evidenceDbPath: ctx.gaugeEvidenceDbPath }));
        return { ...successfulNoop(), processedInputs: result.files, writtenRows: result.rows };
      } }),
    });
    const sync = async (mode: "incremental" | "full" = "incremental") => {
      const result = await enterSyncPipeline(coordinator!, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode }).completion;
      if (result.status === "success") {
        const now = new Date().toISOString();
        let steps = 0;
        while (publishCurrentBatch(db!, currentRegistry(accounts.subscriptions, now), now, 32, accounts)) {
          if (++steps > 500) throw new Error("current projection did not settle");
        }
      }
      return result;
    };
    const get = () => router(db!)(new Request("http://127.0.0.1/api/subscriptions/one/current"));
    const usage = db.query("SELECT data_revision FROM sync_revisions").get();
    expect((await sync()).status).toBe("success");
    expect((await (await get()).json()).data.limits[0]).toMatchObject({ used_percent: 42, machine: "MAIN" });

    // A malformed replay after a valid new record must not publish ANY of that stage.
    const file = path.join(first.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date()));
    const original = fs.readFileSync(file, "utf8");
    await produce(producerA, archive, "MAIN", iso(10_000), 43); await deliver(producerA, first);
    const valid = fs.readFileSync(file, "utf8");
    const invalid = JSON.parse(original.trim()); delete invalid.p.subject;
    fs.appendFileSync(file, JSON.stringify(invalid) + "\n");
    const before = state(db);
    expect((await sync()).status).toBe("failure");
    expect(state(db)).toEqual(before);
    // Repair ONLY this disposable fixture; operator archives must never be truncated.
    fs.writeFileSync(file, valid);
    expect((await sync()).status).toBe("success");
    expect((await (await get()).json()).data.limits[0].used_percent).toBe(43);

    const second = await produce(producerB, archive, "LAPTOP", iso(30_000), 51); await deliver(producerB, second);
    expect((await sync()).status).toBe("success");
    await produce(producerA, archive, "MAIN", iso(-30_000), 20); await deliver(producerA, first);
    expect((await sync()).status).toBe("success");
    await produce(producerA, archive, "MAIN", iso(60_000), 0, true); await deliver(producerA, first);
    expect((await sync()).status).toBe("success");
    fs.appendFileSync(file, original); // Exactly the same version-2 delivery ID.
    expect((await sync("full")).status).toBe("success");
    expect(db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 5 });
    expect(db.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 5 });
    expect(db.query("SELECT data_revision FROM sync_revisions").get()).toEqual(usage);
    const current = (await (await get()).json()).data;
    expect(current.limits[0]).toMatchObject({ used_percent: 51, machine: "LAPTOP" });
    expect(current.latest_error).toMatchObject({ machine: "MAIN", code: "probe-failed" });
    coordinator.close(); coordinator = null;
    db.exec("DROP TABLE probe_windows"); db.close(true); db = new Database(receiver, { readonly: true });
    const changes = db.query("SELECT total_changes() AS n").get();
    const reopened = await get(); expect(reopened.status).toBe(200);
    expect((await reopened.json()).data.limits[0]).toMatchObject({ used_percent: 51, machine: "LAPTOP" });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  } finally {
    coordinator?.close(); db?.close(true);
    removeTestFixture(dir, { recursive: true, force: true });
  }
}, 15_000);
