import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { loadAccountResolver } from "../src/server/account-resolver";
import { archiveFolderOf } from "../src/server/event-source";
import {
  HarnessBlockedError,
  CURRENT_CYCLE_BREAKDOWN_REFERENCE,
  CURRENT_BREAKDOWN_REFERENCE,
  checkPreparationIdentity,
  compareWholeResponses,
  copyStableDatabase,
  createSyntheticReadPathInputs,
  prepareReadPathWorkingCopy,
  validateReadPathOptions,
  verifyRealHandlerParity,
} from "./lib/read-path-harness";
import {
  READ_PATH_BREAKDOWN_REFERENCE,
  READ_PATH_CYCLE_BREAKDOWN_REFERENCE,
  overviewCycleRouteOracleGuard,
  overviewRouteOracleGuard,
} from "./lib/overview-reference";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-read-path-"));
  roots.push(root);
  return { root, ...createSyntheticReadPathInputs(root) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("macro identities are checked before a separate writable copy is prepared", () => {
  const options = fixture();
  const dbBefore = fs.readFileSync(options.databaseCopy);
  const configBefore = fs.readFileSync(options.configCopy);
  const identity = checkPreparationIdentity(options.databaseCopy, options.configCopy);
  expect(identity).toMatchObject({ logical_source_ids_match: true, source_homes_match: true });
  const prepared = prepareReadPathWorkingCopy(options);
  const written = JSON.parse(fs.readFileSync(path.join(prepared.configDir, "accounts.json"), "utf8"));
  expect(written._read_path_harness).toBeUndefined();
  expect(written.version).toBe(2);
  expect(written.subscriptions[0].home).toBeUndefined();
  expect(written.sources[0].home).toContain("archive-copy");
  expect(written.sources[0].source_home).toContain("logical-user-identity");
  using db = new Database(prepared.database, { readonly: true });
  const resolver = loadAccountResolver(db, written.subscriptions);
  for (const [index, account] of ["indexed-a", "indexed-b", "empty", "oracle"].entries()) {
    const source = archiveFolderOf(written.sources[index].home, prepared.archive)?.key;
    expect(source).toBeDefined();
    expect(resolver.resolve("codex", source!, null, "2026-09-24T00:00:00.000Z").account).toBe(account);
  }
  expect(fs.readFileSync(options.databaseCopy)).toEqual(dbBefore);
  expect(fs.readFileSync(options.configCopy)).toEqual(configBefore);
  expect(fs.existsSync(options.output)).toBe(false);
});

test("archive/home macro mismatch blocks before any working files are written", () => {
  const options = fixture();
  const config = JSON.parse(fs.readFileSync(options.configCopy, "utf8"));
  config._read_path_harness.logical_context.archive = path.join(options.root, "different-logical-archive");
  fs.writeFileSync(options.configCopy, JSON.stringify(config));
  expect(() => prepareReadPathWorkingCopy(options)).toThrow(HarnessBlockedError);
  try { prepareReadPathWorkingCopy(options); }
  catch (error) { expect((error as HarnessBlockedError).reason).toBe("source-homes-mismatch"); }
  expect(fs.readdirSync(options.workDir)).toEqual([]);
  expect(fs.existsSync(options.output)).toBe(false);
});

test("missing, aliased, active-production and pre-existing destinations are rejected", () => {
  const options = fixture();
  expect(() => validateReadPathOptions({ ...options, databaseCopy: path.join(options.root, "missing.sqlite") }))
    .toThrow(HarnessBlockedError);
  expect(() => validateReadPathOptions({ ...options, output: options.databaseCopy })).toThrow(HarnessBlockedError);
  fs.writeFileSync(options.output, "occupied");
  expect(() => validateReadPathOptions(options)).toThrow(HarnessBlockedError);
  fs.rmSync(options.output);
  const previous = process.env.TOKENATLAS_DB;
  process.env.TOKENATLAS_DB = options.databaseCopy;
  try { expect(() => validateReadPathOptions(options)).toThrow(HarnessBlockedError); }
  finally {
    if (previous === undefined) delete process.env.TOKENATLAS_DB;
    else process.env.TOKENATLAS_DB = previous;
  }
});

test("canonical ancestor junctions cannot route inputs or output directories into production", () => {
  const options = fixture();
  const production = path.join(options.root, "simulated-production");
  const alias = path.join(options.root, "production-alias");
  fs.mkdirSync(production);
  for (const child of ["work", "archive", "reports", "inputs"]) fs.mkdirSync(path.join(production, child));
  fs.copyFileSync(options.databaseCopy, path.join(production, "inputs", "copy.sqlite"));
  fs.copyFileSync(options.configCopy, path.join(production, "inputs", "accounts.json"));
  fs.symlinkSync(production, alias, process.platform === "win32" ? "junction" : "dir");
  const previous = process.env.TOKENATLAS_ARCHIVE;
  process.env.TOKENATLAS_ARCHIVE = alias;
  try {
    for (const changed of [
      { workDir: path.join(alias, "work") },
      { archiveCopy: path.join(alias, "archive") },
      { output: path.join(alias, "reports", "report.json") },
      { databaseCopy: path.join(alias, "inputs", "copy.sqlite") },
      { configCopy: path.join(alias, "inputs", "accounts.json") },
      { workDir: path.join(production, "work") },
    ]) {
      expect(() => validateReadPathOptions({ ...options, ...changed })).toThrow(HarnessBlockedError);
    }
    expect(fs.readdirSync(path.join(production, "work"))).toEqual([]);
    expect(fs.readdirSync(path.join(production, "reports"))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.TOKENATLAS_ARCHIVE;
    else process.env.TOKENATLAS_ARCHIVE = previous;
  }
});

test("rollback journals and a writer starting after validation are rejected at the copy boundary", () => {
  const options = fixture();
  validateReadPathOptions(options);
  const destination = path.join(options.workDir, "boundary-copy.sqlite");
  const writer = new Database(options.databaseCopy);
  try {
    writer.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
    writer.query("UPDATE probe_windows SET machine='ACTIVE-WRITER' WHERE rowid=(SELECT MIN(rowid) FROM probe_windows)").run();
    expect(fs.existsSync(options.databaseCopy + "-journal")).toBe(true);
    expect(() => validateReadPathOptions(options)).toThrow(HarnessBlockedError);
    expect(() => copyStableDatabase(options.databaseCopy, destination)).toThrow(HarnessBlockedError);
    expect(fs.existsSync(destination)).toBe(false);
  } finally {
    writer.exec("ROLLBACK");
    writer.close(true);
  }
});

test("whole-response parity retains duplicates, nulls and money/ownership/usage fields", () => {
  const response = {
    generated_at: "2026-09-06T12:00:00.000Z",
    rows: [
      { id: "a", used_percent: null, usd: 1.25, owner: "indexed-a" },
      { id: "a", used_percent: null, usd: 1.25, owner: "indexed-a" },
    ],
  };
  const clock = [{ pointer: "/generated_at", mode: "frozen" as const, value: "2026-09-06T12:00:00.000Z" }];
  expect(compareWholeResponses(response, structuredClone(response), clock).equal).toBe(true);
  const withoutDuplicate = structuredClone(response); withoutDuplicate.rows.pop();
  expect(compareWholeResponses(response, withoutDuplicate, clock).equal).toBe(false);
  for (const key of ["used_percent", "usd", "owner"] as const) {
    const changed = structuredClone(response);
    (changed.rows[0] as Record<string, unknown>)[key] = key === "used_percent" ? 0 : key === "usd" ? 9.99 : "someone-else";
    expect(compareWholeResponses(response, changed, clock).equal).toBe(false);
  }
});

test("clock fields pass only an explicit frozen or independent recomputation policy", () => {
  const left = { observed_at: 100, age_ms: 25, value: 4 };
  const right = { observed_at: 100, age_ms: 25, value: 4 };
  const recomputed = [{
    pointer: "/age_ms",
    mode: "recomputed" as const,
    compute: (document: unknown) => 125 - (document as typeof left).observed_at,
  }];
  expect(compareWholeResponses(left, right, recomputed).equal).toBe(true);
  right.age_ms = 0;
  expect(compareWholeResponses(left, right, recomputed).equal).toBe(false);
});

test("real-handler parity is fixed to the oracle and wires money, ownership and usage controls", async () => {
  expect(overviewRouteOracleGuard().status).toBe("pass");
  const changedOracle = structuredClone(READ_PATH_BREAKDOWN_REFERENCE) as unknown as { totals: { tokens: number } };
  changedOracle.totals.tokens += 1;
  expect(overviewRouteOracleGuard(changedOracle).status).toBe("blocked");
  expect(overviewCycleRouteOracleGuard().status).toBe("pass");
  const changedCycleOracle = structuredClone(READ_PATH_CYCLE_BREAKDOWN_REFERENCE) as unknown as {
    days: Array<{ usd: number }>;
  };
  changedCycleOracle.days[0]!.usd += 1;
  expect(overviewCycleRouteOracleGuard(changedCycleOracle).status).toBe("blocked");
  const stable = (request: Request) => Response.json(structuredClone(
    new URL(request.url).pathname === "/api/cycle-breakdown"
      ? CURRENT_CYCLE_BREAKDOWN_REFERENCE
      : CURRENT_BREAKDOWN_REFERENCE,
  ));
  const missingCredit = (request: Request) => new URL(request.url).pathname === "/api/cycle-breakdown"
    ? Response.json(READ_PATH_CYCLE_BREAKDOWN_REFERENCE) : stable(request);
  expect((await verifyRealHandlerParity(missingCredit)).status).toBe("blocked");
  const oldFreshInput = (request: Request) => new URL(request.url).pathname === "/api/breakdown"
    ? Response.json(READ_PATH_BREAKDOWN_REFERENCE) : stable(request);
  expect(CURRENT_BREAKDOWN_REFERENCE.rows[0]!.token_details.fresh_in).toBe(2_220_000);
  expect((await verifyRealHandlerParity(oldFreshInput)).status).toBe("blocked");
  const passing = await verifyRealHandlerParity(stable);
  expect(passing).toMatchObject({
    status: "pass",
    full_response_reference_matches: true,
    full_response_candidate_matches: true,
    repeated_real_handler_parity: true,
    mutation_controls: {
      monetary_drift_detected: true,
      ownership_drift_detected: true,
      usage_drift_detected: true,
    },
  });
  expect(passing.clock_policy.map((row) => row.pointer)).toEqual(["/scope/since_ts", "/scope/until_ts"]);
  expect(passing.cycle_breakdown).toMatchObject({
    status: "pass",
    route_alias: "/api/cycle-breakdown",
    full_response_reference_matches: true,
    full_response_candidate_matches: true,
    repeated_real_handler_parity: true,
    mutation_controls: {
      day_monetary_drift_detected: true,
      day_ownership_drift_detected: true,
      day_usage_drift_detected: true,
    },
  });
  expect(passing.cycle_breakdown.clock_policy.length).toBe(14);
  let cycleCalls = 0;
  const drifted = async (request: Request) => {
    if (new URL(request.url).pathname !== "/api/cycle-breakdown") return stable(request);
    const body = structuredClone(CURRENT_CYCLE_BREAKDOWN_REFERENCE) as unknown as { days: Array<{ usd: number }> };
    if (cycleCalls++ > 0) body.days[0]!.usd += 1;
    return Response.json(body);
  };
  expect((await verifyRealHandlerParity(drifted)).status).toBe("blocked");
});


test("whole-response equality ignores object key order but preserves array order and all fields", () => {
  expect(compareWholeResponses({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }).equal).toBe(true);
  expect(compareWholeResponses({ rows: [1, 2] }, { rows: [2, 1] }).equal).toBe(false);
  expect(compareWholeResponses({ value: null }, {}).equal).toBe(false);
});
