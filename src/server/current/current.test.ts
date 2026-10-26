import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../../db/migrate";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../../db/period-store";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../../db/probe-facts";
import { ARCHIVE_LOGICAL_ROOT, CONFIG_ROOT, LOGIN } from "../../config/paths";
import { PERIOD_DECLARATIONS_FILE } from "../period-declarations";
import type { BootstrapSnapshot, CurrentEnvelope, CurrentSubscription, SubscriptionDeclaration } from "../../web/lib/current-contract";
import type { SourceDeclaration } from "../archive-source";
import { handleCurrentRequest, currentSnapshot } from "./http";
import { currentRegistry } from "./registry";
import { projectionState, publishCurrentBatch } from "./store";
import { startAnalysisMaintenance } from "../analysis-maintenance";

const NOW = "2026-09-05T12:00:00.000Z";
const HOME = `C:/Users/${LOGIN}/.codex`;
const SOURCE = `codex/PC-A-${LOGIN}`.toLowerCase();
const declaration: SubscriptionDeclaration = { id: "sub", vendor: "codex" };
const source: SourceDeclaration = { vendor: "codex", machine: "PC-A",
  home: `${ARCHIVE_LOGICAL_ROOT}/codex/PC-A-${LOGIN}`, source_home: HOME };
const config = { subscriptions: [declaration], sources: [source] };
const connections: Database[] = [], directories: string[] = [];
afterEach(() => {
  connections.splice(0).forEach(db => db.close(true));
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});
function database(file = ":memory:") {
  const db = new Database(file, { create: true }); connections.push(db);
  applyDrizzleMigrations(drizzle(db));
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ provider: "codex", subject: SOURCE, value: "sub",
    from: "2020-01-01T00:00:00.000Z", until: null, origin: "declared", firstSeen: null,
    lastSeen: null, readings: 0, evidence: "fixture" }]);
  return db;
}
function sample(db: Database, ts = "2026-09-05T11:59:00.000Z", used = 40) {
  const id = Number(db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,reported_percent_side,
    used_percent,machine,profile,extra) VALUES('codex','stale',?,'primary','codex','used',?,'PC-A',?,?)`)
    .run(ts, used, LOGIN, JSON.stringify({ home: HOME })).lastInsertRowid);
  const row = db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
  const fact = createProbeCollection([{ ...row, raw_subject: null, login: LOGIN, source_home: HOME }])[0]!;
  db.transaction(() => { acceptProbeFact(db, fact); mapProbeLegacy(db, fact, id, "fixture-linked"); }).immediate();
  return id;
}
function settle(db: Database, now = NOW) {
  for (let i = 0; i < 200; i++)
    if (!publishCurrentBatch(db, currentRegistry(config.subscriptions, now), now, 8, config)) return;
  throw new Error("current writer did not settle");
}
function request(pathname = "/api/bootstrap", init?: RequestInit) {
  return new Request(`http://localhost${pathname}`, init);
}

 describe("version 2 current GET", () => {
  it("cold migration keeps the roster explicit while the writer prepares canonical ownership", () => {
    const db = database(); sample(db);
    const context = { sqlite: db, accounts: config };
    expect((currentSnapshot(context, NOW) as BootstrapSnapshot).status).toBe("initializing");
    expect(projectionState(db)?.schema_version).toBe(1);
    settle(db);
    expect(projectionState(db)?.schema_version).toBe(2);
    const sub = currentSnapshot(context, NOW, "sub") as CurrentEnvelope<CurrentSubscription>;
    expect(sub.status).toBe("ready");
    expect(sub.data.limits[0]?.used_percent).toBe(40);
  });
  it("GET reads the published projection after restart without history or writes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-v2-")); directories.push(directory);
    const file = path.join(directory, "atlas.sqlite"), db = database(file);
    sample(db); settle(db);
    db.exec("ALTER TABLE probe_windows RENAME TO unavailable_history");
    const cold = new Database(file, { readonly: true }); connections.push(cold);
    const context = { sqlite: cold, accounts: config };
    const sql: string[] = [];
    const traced = new Proxy(cold, { get(target, property) {
      if (property === "query") return (statement: string) => { sql.push(statement); return target.query(statement); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    for (const route of ["/api/bootstrap", "/api/revisions", "/api/subscriptions/sub/current"])
      expect(handleCurrentRequest({ ...context, sqlite: traced }, request(route), NOW)?.status).toBe(200);
    expect(sql.some(statement => /\b(probe_windows|unavailable_history|analysis_changes)\b/i.test(statement))).toBe(false);
    expect((currentSnapshot(context, NOW, "sub") as CurrentEnvelope<CurrentSubscription>).data.limits[0]?.used_percent).toBe(40);
  });
  it("methods, unknown IDs, and a missing schema remain explicit", async () => {
    const db = new Database(":memory:"); connections.push(db);
    const context = { sqlite: db, accounts: config };
    expect((currentSnapshot(context, NOW) as BootstrapSnapshot).error_code).toBe("migration-required");
    expect(handleCurrentRequest(context, request("/api/bootstrap", { method: "POST" }))?.status).toBe(405);
    expect(handleCurrentRequest(context, request("/api/subscriptions/missing/current"), NOW)?.status).toBe(404);
    expect(await handleCurrentRequest(context, request("/api/bootstrap", { method: "HEAD" }), NOW)?.text()).toBe("");
  });
});

describe("subscription registry", () => {
  it("does not merge same emails or homes into one subscription", () => {
    expect(currentRegistry([{ id: "a", vendor: "codex", account: "same@example.test" },
      { id: "b", vendor: "codex", account: "same@example.test" }], NOW)).toHaveLength(2);
  });
  it("does not infer a binding from subscription metadata", () => {
    expect(currentRegistry([{ id: "a", vendor: "codex" }], NOW)[0])
      .toMatchObject({ lifecycle: "unknown", binding_active: false });
  });
  it("retains an explicitly active subscription without a source", () => {
    expect(currentRegistry([{ id: "a", vendor: "codex", status: "active" }], NOW)[0])
      .toMatchObject({ lifecycle: "active", binding_active: false });
  });
});

it("presents the active physical binding from account periods without rebuilding current history", () => {
  const db = database(); sample(db); settle(db);
  const active = currentSnapshot({ sqlite: db, accounts: config }, NOW, "sub") as CurrentEnvelope<CurrentSubscription>;
  expect(active.data.binding_active).toBe(true);
  // The readings' stored evidence does not depend on the periods: a period change rewrites none of it.
  const evidence = () => db.query("SELECT probe_id,ord,revision FROM probe_sources ORDER BY probe_id,ord").all();
  const before = evidence();
  expect(before.length).toBe(1);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ provider: "codex", subject: SOURCE, value: "other",
    from: "2020-01-01T00:00:00.000Z", until: null, origin: "declared", firstSeen: null,
    lastSeen: null, readings: 0, evidence: "fixture-corrected" }]);
  const corrected = currentSnapshot({ sqlite: db, accounts: config }, NOW, "sub") as CurrentEnvelope<CurrentSubscription>;
  expect(corrected.data.binding_active).toBe(false);
  settle(db);
  expect((currentSnapshot({ sqlite: db, accounts: config }, NOW, "sub") as CurrentEnvelope<CurrentSubscription>)
    .data.binding_active).toBe(false);
  expect(evidence()).toEqual(before);
});

it("the background writer resumes linked current rows through its own connection (projection job)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-worker-")); directories.push(directory);
  const file = path.join(directory, "atlas.sqlite"), db = database(file);
  db.exec("PRAGMA journal_mode=WAL");
  const id = sample(db, new Date(Date.now() - 60_000).toISOString());
  // The account-period job in the same queue applies the declarations file, as the server does: declare there.
  const declarations = path.join(CONFIG_ROOT, PERIOD_DECLARATIONS_FILE);
  fs.mkdirSync(CONFIG_ROOT, { recursive: true });
  fs.writeFileSync(declarations, JSON.stringify({ version: 1, accounts: [{ provider: "codex", source: SOURCE, account: "sub",
    from: "2020-01-01T00:00:00.000Z", evidence: "fixture" }] }));
  const start = () => startAnalysisMaintenance(file, () => config, () => true, () => {}, { turnMs: 0 });
  let worker = start();
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) { worker.update(); await worker.waitForIdle(); await Bun.sleep(20); }
    expect(condition()).toBe(true);
  };
  try {
    await until(() => projectionState(db)?.schema_version === 2 && projectionState(db)?.generated_at != null);
    await worker.close();
    db.query("UPDATE probe_windows SET used_percent=65 WHERE id=?").run(id);
    const row = db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
    const fact = createProbeCollection([{ ...row, raw_subject: null, login: LOGIN, source_home: HOME }])[0]!;
    db.transaction(() => { acceptProbeFact(db, fact); mapProbeLegacy(db, fact, id, "fixture-corrected"); }).immediate();
    worker = start();
    await until(() => (currentSnapshot({ sqlite: db, accounts: config },
      new Date().toISOString(), "sub") as CurrentEnvelope<CurrentSubscription>).data.limits[0]?.used_percent === 65);
  } finally { await worker.close(); fs.rmSync(declarations, { force: true }); }
}, 12000);
