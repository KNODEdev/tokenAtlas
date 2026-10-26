import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { activeDatabasePath } from "../src/db";

// Each scenario launches a Bun process; busy Windows hosts can exceed the 5 s default.
setDefaultTimeout(15_000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "price-ledger-audit-tests-"));
const config = path.join(root, "config");
fs.mkdirSync(config);
fs.writeFileSync(path.join(config, "rate-cards.json"), JSON.stringify({ vendors: {}, codex_accounting: { version: 1, rules: [] } }));
afterAll(() => {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) && path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error("Unexpected fixture root");
  fs.rmSync(root, { recursive: true, force: true });
});
const script = path.resolve(import.meta.dir, "price-ledger-copy-audit.ts");
const execute = (target: string, ...args: string[]) => Bun.spawnSync([process.execPath, target, ...args], {
  env: { ...process.env, TOKENATLAS_CONFIG: config, TOKENATLAS_FROZEN_CONFIG: "1",
    TOKENATLAS_ARCHIVE: path.join(root, "archive"), TOKENATLAS_LOCAL_STATE: path.join(root, "state"),
    TOKENATLAS_TEMP_DIR: path.join(root, "scratch") },
  stdout: "pipe", stderr: "pipe",
});
const run = (...args: string[]) => execute(script, ...args);

test("requires an explicit copy and rejects the active database before opening it", () => {
  expect(run().exitCode).not.toBe(0);
  const live = activeDatabasePath();
  if (fs.existsSync(live)) {
    const result = run("--copy", live);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Pass a frozen copy, not the active database");
  }
});

test("rejects a copy with unapplied write evidence", () => {
  const copy = path.join(root, "journal.sqlite");
  fs.writeFileSync(copy, "not opened");
  fs.writeFileSync(`${copy}-wal`, "unapplied evidence");
  const result = run("--copy", copy);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Frozen copy has a write journal");
  expect(fs.readFileSync(copy, "utf8")).toBe("not opened");
});

test("freezes exact integer evidence and the selected rate card without changing the copy", () => {
  const copy = path.join(root, "fixture.sqlite");
  const db = new Database(copy);
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
    service_tier TEXT,speed TEXT,speed_source TEXT,source_offset INTEGER,response_id TEXT,turn_id TEXT,
    billing_mode TEXT,plan_type TEXT,usage_source TEXT,producer_version TEXT,usage_status TEXT,cache_write_status TEXT);
    INSERT INTO events VALUES ('source','rollout','2026-09-30T00:00:00Z','?',
    9007199254740993,0,0,1,0,NULL,'unknown',NULL,0,NULL,NULL,'unknown',NULL,'synthetic','1','valid','missing')`);
  db.close();
  const before = fs.readFileSync(copy);
  const result = run("--copy", copy);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString());
  const manifest = JSON.parse(fs.readFileSync(report.report, "utf8"));
  expect(manifest.facts.rows).toBe(1);
  expect(manifest.audit.token_bounds[0].maximum).toBe("9007199254740993");
  expect(manifest.audit.models[0].missing_identifier).toBe("1");
  expect(manifest.audit.identity.missing_raw_tier).toBe("1");
  expect(manifest.legacy_scope_rules_ready).toBe(false);
  expect(manifest.database.sha256).toHaveLength(64);
  expect(fs.readFileSync(manifest.rules.frozen)).toEqual(fs.readFileSync(path.join(config, "rate-cards.json")));
  expect(fs.readFileSync(copy)).toEqual(before);
  const checked = execute(path.resolve(import.meta.dir, "price-ledger-reference-check.ts"), "--manifest", report.report);
  expect(checked.exitCode).toBe(0);
  const comparison = JSON.parse(checked.stdout.toString());
  expect(comparison.price_checks).toBe(4);
  expect(comparison.mismatches).toBe(0);
  const wrong = { ...manifest, database: { ...manifest.database, sha256: "0".repeat(64) } };
  const wrongPath = path.join(root, "wrong-manifest.json");
  fs.writeFileSync(wrongPath, JSON.stringify(wrong));
  const rejected = execute(path.resolve(import.meta.dir, "price-ledger-reference-check.ts"), "--manifest", wrongPath);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr.toString()).toContain("Frozen database hash mismatch");
});

test("source sample records accounting evidence and missing files without storing conversation text", () => {
  const archive = path.join(root, "archive");
  fs.mkdirSync(archive, { recursive: true });
  const transcript = path.join(archive, "sample.jsonl");
  const secretText = "synthetic text must not be retained\u2028in evidence";
  const sessionEvidence = "synthetic-session-not-retained-verbatim", responseEvidence = "synthetic-response-not-retained-verbatim";
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "thread_settings_applied", payload: { thread_settings: { service_tier: "priority" } } }),
    JSON.stringify({ type: "thread_settings_applied", payload: { thread_settings: { service_tier: null } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "ultrafast" } } }),
    JSON.stringify({ type: "session_meta", payload: { id: sessionEvidence, instructions: secretText } }),
    ...[1, 2].map(() => JSON.stringify({ type: "token_usage_record", payload: { thread_id: sessionEvidence, response_id: responseEvidence } })),
    JSON.stringify({ type: "token_usage_record", payload: { response_id: responseEvidence } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 128000 } } }),
    JSON.stringify({ type: "compacted", payload: { message: secretText } }),
    "invalid json",
  ].join("\n"));
  const copy = path.join(root, "source-sample.sqlite");
  const db = new Database(copy);
  db.exec("CREATE TABLE events(model TEXT,home TEXT,path TEXT,ts TEXT,service_tier TEXT)");
  const insert = db.query("INSERT INTO events VALUES (?,'source',?,'2026-09-30T00:00:00Z',NULL)");
  insert.run("observed-model", transcript);
  insert.run("unavailable-model", path.join(archive, "missing.jsonl"));
  db.close();
  const result = execute(path.resolve(import.meta.dir, "price-ledger-source-sample.ts"), "--copy", copy);
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  const bytes = fs.readFileSync(output.report, "utf8");
  const report = JSON.parse(bytes);
  expect(output.selected).toBe(2);
  expect(output.sampled).toBe(1);
  const sampled = report.evidence.find((row: { status: string }) => row.status === "sampled");
  expect(sampled.tiers.priority).toBe(1);
  expect(sampled.tiers.ultrafast).toBe(1);
  expect(sampled.explicit_tier_nulls).toBe(1);
  expect(sampled.context_readings).toBe(1);
  expect(sampled.compaction_records).toBe(1);
  expect(sampled.malformed).toBe(1);
  expect(sampled.session_identity_hashes).toHaveLength(1);
  expect(sampled.session_identity_hashes[0]).toHaveLength(64);
  expect(sampled.rich_requests).toBe(3);
  expect(sampled.unique_request_identities).toBe(1);
  expect(sampled.missing_request_identity).toBe(1);
  expect(sampled.repeated_request_identity).toBe(1);
  expect(report.evidence.some((row: { status: string }) => row.status === "unavailable")).toBe(true);
  expect(bytes).not.toContain(secretText);
  expect(bytes).not.toContain(sessionEvidence);
  expect(bytes).not.toContain(responseEvidence);
});
