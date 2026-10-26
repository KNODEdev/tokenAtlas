import { isDeepStrictEqual } from "node:util";
import { referencePlanHealth } from "./planhealth-reference";
import { Database } from "../../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  READ_PATH_BREAKDOWN_REFERENCE,
  READ_PATH_BREAKDOWN_ROUTE,
  READ_PATH_CYCLE_BREAKDOWN_REFERENCE,
  READ_PATH_CYCLE_BREAKDOWN_ROUTE,
  overviewCycleRouteOracleGuard,
  overviewRouteOracleGuard,
} from "./overview-reference";
import { normEraKey } from "../../src/server/eras";
import { parseAccountsV2, type AccountsV2 } from "../../src/config/accounts-v2";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../../src/db/period-store";
import { resolveArchiveRootFromEnv, resolveConfigRootFromEnvironment } from "../../src/config/path-environment";
import { resolveDbPath } from "../../src/db";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const round = (value: number) => Math.round(value * 1000) / 1000;
const fileDigest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

interface LogicalContext {
  archive: string;
  userprofile: string;
  machine: string;
  login: string;
  profile: string;
}

type HarnessAccounts = AccountsV2 & { _read_path_harness?: { logical_context?: Partial<LogicalContext>; synthetic?: boolean } };

export interface ReadPathOptions {
  databaseCopy: string;
  configCopy: string;
  archiveCopy: string;
  workDir: string;
  output: string;
  delayMs?: number;
}

export class HarnessBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "HarnessBlockedError";
  }
}

function fail(reason: string): never {
  throw new HarnessBlockedError(reason);
}

function normalized(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalFromExistingAncestor(target: string, reason: string): string {
  let cursor = path.resolve(target);
  const tail: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(cursor);
      return normalized(path.join(real, ...tail.reverse()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") fail(reason);
      const parent = path.dirname(cursor);
      if (parent === cursor) fail(reason);
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function canonicalExisting(target: string, reason: string): string {
  try { return normalized(fs.realpathSync.native(target)); }
  catch { fail(reason); }
}

function samePath(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertPlainFile(file: string, reason: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch { fail(reason); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(reason);
}

function assertPlainDirectory(directory: string, reason: string): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch { fail(reason); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(reason);
}

function productionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  // The same resolution as the app, so an archive or database chosen in Settings stays protected.
  const archive = resolveArchiveRootFromEnv(env);
  return [archive, resolveConfigRootFromEnvironment(env, archive), resolveDbPath(undefined, env)];
}

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

function assertNoDatabaseSidecars(databaseCopy: string): void {
  if (SQLITE_SIDECARS.some((suffix) => fs.existsSync(databaseCopy + suffix))) {
    fail("database-copy-has-live-sidecars");
  }
}

export function copyStableDatabase(databaseCopy: string, destination: string): void {
  assertNoDatabaseSidecars(databaseCopy);
  const before = fileDigest(databaseCopy);
  try {
    fs.copyFileSync(databaseCopy, destination, fs.constants.COPYFILE_EXCL);
    assertNoDatabaseSidecars(databaseCopy);
    if (before !== fileDigest(databaseCopy)) fail("input-changed-during-preparation");
  } catch (error) {
    try { if (fs.existsSync(destination)) fs.rmSync(destination); } catch {}
    throw error;
  }
}

/** Validate every path before creating a working copy or reserving a report. */
export function validateReadPathOptions(options: ReadPathOptions): ReadPathOptions {
  const values = Object.values({
    databaseCopy: options.databaseCopy,
    configCopy: options.configCopy,
    archiveCopy: options.archiveCopy,
    workDir: options.workDir,
    output: options.output,
  });
  if (values.some((value) => !value || !path.isAbsolute(value))) fail("all-paths-must-be-explicit-and-absolute");
  assertPlainFile(options.databaseCopy, "database-copy-missing-or-unsafe");
  assertPlainFile(options.configCopy, "config-copy-missing-or-unsafe");
  assertPlainDirectory(options.archiveCopy, "archive-copy-missing-or-unsafe");
  assertPlainDirectory(options.workDir, "work-directory-missing-or-unsafe");
  assertPlainDirectory(path.dirname(options.output), "output-directory-missing-or-unsafe");
  if (fs.existsSync(options.output)) fail("output-already-exists");
  if (fs.readdirSync(options.workDir).length !== 0) fail("work-directory-not-unused");
  assertNoDatabaseSidecars(options.databaseCopy);
  const canonical = [
    canonicalExisting(options.databaseCopy, "database-copy-missing-or-unsafe"),
    canonicalExisting(options.configCopy, "config-copy-missing-or-unsafe"),
    canonicalExisting(options.archiveCopy, "archive-copy-missing-or-unsafe"),
    canonicalExisting(options.workDir, "work-directory-missing-or-unsafe"),
    canonicalFromExistingAncestor(options.output, "output-directory-missing-or-unsafe"),
  ];
  for (let i = 0; i < canonical.length; i++) {
    for (let j = i + 1; j < canonical.length; j++) {
      if (samePath(canonical[i]!, canonical[j]!)) fail("path-alias-detected");
    }
  }
  const canonicalProduction = productionRoots().map((root) =>
    canonicalFromExistingAncestor(root, "production-root-unresolvable"));
  for (const production of canonicalProduction) {
    for (const candidate of canonical) {
      if (samePath(candidate, production) || within(candidate, production)) fail("production-path-rejected");
    }
  }
  const repository = canonicalFromExistingAncestor(ROOT, "repository-root-unresolvable");
  if (within(canonical[3]!, repository) || within(canonical[2]!, repository)) fail("working-io-inside-repository");
  const delayMs = options.delayMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5_000) fail("invalid-delay");
  return { ...options, delayMs };
}

function logicalContext(config: HarnessAccounts): LogicalContext | null {
  const value = config._read_path_harness?.logical_context;
  if (!value) return null;
  const context = {
    archive: value.archive,
    userprofile: value.userprofile,
    machine: value.machine,
    login: value.login,
    profile: value.profile,
  };
  if (Object.values(context).some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    fail("logical-context-incomplete");
  }
  if (!path.isAbsolute(context.archive!) || !path.isAbsolute(context.userprofile!)) fail("logical-context-unsafe");
  return context as LogicalContext;
}

/** Expand path identity with copied logical roots; isolated archive I/O is never used here. */
export function materializeLogicalPath(raw: string, context: LogicalContext | null): string {
  const hasMacro = /\$\{(?:ARCHIVE|USERPROFILE|HOME|MACHINE|PROFILE|LOGIN)\}/.test(raw) || raw.startsWith("~");
  if (hasMacro && !context) fail("logical-context-required-for-macros");
  let value = raw;
  if (context) {
    value = value
      .replace(/\$\{ARCHIVE\}/g, context.archive)
      .replace(/\$\{USERPROFILE\}|\$\{HOME\}/g, context.userprofile)
      .replace(/\$\{MACHINE\}/g, context.machine)
      .replace(/\$\{PROFILE\}/g, context.profile)
      .replace(/\$\{LOGIN\}/g, context.login);
    if (value.startsWith("~")) value = path.join(context.userprofile, value.slice(1));
  }
  if (/\$\{[^}]+\}/.test(value)) fail("unknown-logical-path-macro");
  return path.normalize(value);
}

export function materializeAccounts(config: HarnessAccounts): AccountsV2 {
  const context = logicalContext(config);
  if (!Array.isArray(config.subscriptions) || config.subscriptions.length === 0) fail("subscriptions-missing");
  if (!Array.isArray(config.sources) || config.sources.length === 0) fail("sources-missing");
  const { _read_path_harness: _private, ...rest } = config;
  try {
    return parseAccountsV2({ ...rest, sources: config.sources.map(source => ({ ...source,
      home: materializeLogicalPath(source.home, context),
      ...(source.source_home ? { source_home: materializeLogicalPath(source.source_home, context) } : {}),
    })) });
  } catch { fail("accounts-v2-invalid"); }
}

function readConfig(file: string): HarnessAccounts {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HarnessAccounts;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("config-copy-invalid");
    return parsed;
  } catch (error) {
    if (error instanceof HarnessBlockedError) throw error;
    fail("config-copy-invalid");
  }
}

/**
 * The copy must hold the sources the materialized declarations name: every Codex home it
 * recorded is a declared `home` or `source_home`, or the context would read another archive.
 */
export function checkPreparationIdentity(databaseCopy: string, configCopy: string) {
  const materialized = materializeAccounts(readConfig(configCopy));
  let homes: string[];
  try {
    using sqlite = new Database(databaseCopy, { readonly: true, strict: true });
    sqlite.exec("PRAGMA query_only=ON");
    homes = (sqlite.query("SELECT home FROM events UNION SELECT home FROM ratelimit").all() as Array<{ home: string }>)
      .map((row) => row.home);
  } catch { fail("database-copy-unreadable"); }
  const declared = new Set(materialized.sources
    .flatMap(source => [source.home, source.source_home]).filter((home): home is string => !!home).map(normEraKey));
  if (homes.some((home) => !declared.has(normEraKey(home)))) fail("source-homes-mismatch");
  return { materialized, logical_source_ids_match: true, source_homes_match: true };
}

export function prepareReadPathWorkingCopy(options: ReadPathOptions) {
  const initial = validateReadPathOptions(options);
  const before = { database: fileDigest(initial.databaseCopy), config: fileDigest(initial.configCopy) };
  const identity = checkPreparationIdentity(initial.databaseCopy, initial.configCopy);
  if (before.database !== fileDigest(initial.databaseCopy) || before.config !== fileDigest(initial.configCopy)) {
    fail("input-changed-during-preparation");
  }
  const checked = validateReadPathOptions(initial);
  const started = performance.now();
  const database = path.join(checked.workDir, "atlas-working.sqlite");
  const configDir = path.join(checked.workDir, "config");
  const configFile = path.join(configDir, "accounts.json");
  copyStableDatabase(checked.databaseCopy, database);
  fs.mkdirSync(configDir);
  const configFd = fs.openSync(configFile, "wx", 0o600);
  try { fs.writeFileSync(configFd, JSON.stringify(identity.materialized, null, 2) + "\n"); }
  finally { fs.closeSync(configFd); }
  assertNoDatabaseSidecars(checked.databaseCopy);
  const immutableInputs = before.database === fileDigest(checked.databaseCopy) && before.config === fileDigest(checked.configCopy);
  if (!immutableInputs) fail("input-changed-during-preparation");
  return {
    database,
    configDir,
    archive: checked.archiveCopy,
    output: checked.output,
    preparation_ms: round(performance.now() - started),
    immutable_inputs: immutableInputs,
    logical_source_ids_match: identity.logical_source_ids_match,
    source_homes_match: identity.source_homes_match,
  };
}

export type ClockFieldPolicy =
  | { pointer: string; mode: "frozen"; value: unknown }
  | { pointer: string; mode: "recomputed"; compute: (document: unknown) => unknown };

function pointerValue(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let current = document;
  for (const encoded of pointer.split("/").slice(1)) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current == null || typeof current !== "object" || !(key in current)) return Symbol.for("missing");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Exact whole-response comparison. Clock fields must pass a named policy; no key is removed. */
export function compareWholeResponses(left: unknown, right: unknown, clockPolicies: ClockFieldPolicy[] = []) {
  const policyResults = clockPolicies.map((policy) => {
    const leftValue = pointerValue(left, policy.pointer);
    const rightValue = pointerValue(right, policy.pointer);
    const expectedLeft = policy.mode === "frozen" ? policy.value : policy.compute(left);
    const expectedRight = policy.mode === "frozen" ? policy.value : policy.compute(right);
    return {
      pointer: policy.pointer,
      mode: policy.mode,
      pass: Object.is(leftValue, expectedLeft) && Object.is(rightValue, expectedRight),
    };
  });
  return {
    equal: isDeepStrictEqual(left, right) && policyResults.every((result) => result.pass),
    clock_policy: policyResults,
  };
}

const ROUTE_CLOCK_POLICIES: ClockFieldPolicy[] = [
  { pointer: "/scope/since_ts", mode: "frozen", value: "2020-01-01T00:00:00.000Z" },
  { pointer: "/scope/until_ts", mode: "frozen", value: "2020-01-02T00:00:00.000Z" },
];
const CYCLE_ROUTE_CLOCK_POLICIES: ClockFieldPolicy[] = [
  { pointer: "/since_ts", mode: "frozen", value: "2020-01-01T12:00:00.000Z" },
  { pointer: "/until_ts", mode: "frozen", value: "2020-01-01T18:00:00.000Z" },
  { pointer: "/session_window_minutes", mode: "frozen", value: 1440 },
  { pointer: "/days/0/date", mode: "frozen", value: "2020-01-01" },
  { pointer: "/days/0/dow", mode: "frozen", value: 2 },
  { pointer: "/days/0/from_ts", mode: "frozen", value: "2020-01-01T12:00:00.000Z" },
  { pointer: "/days/0/to_ts", mode: "frozen", value: "2020-01-01T18:00:00.000Z" },
  { pointer: "/days/0/hours", mode: "frozen", value: 6 },
  { pointer: "/days/0/is_today", mode: "frozen", value: false },
  { pointer: "/sessions/0/start_ts", mode: "frozen", value: "2020-01-01T12:00:00.000Z" },
  { pointer: "/sessions/0/end_ts", mode: "frozen", value: "2020-01-01T18:00:00.000Z" },
  { pointer: "/sessions/0/active", mode: "frozen", value: false },
  { pointer: "/sessions/0/reported_reset_ts", mode: "frozen", value: null },
  { pointer: "/short_counter/last_reported_ts", mode: "frozen", value: null },
];

type ReadPathHandler = (request: Request) => Response | Promise<Response>;

async function captureJson(handler: ReadPathHandler, route: string): Promise<unknown> {
  const response = await handler(new Request(`http://127.0.0.1${route}`));
  if (response.status !== 200) fail("real-handler-parity-response-unavailable");
  try { return await response.json(); }
  catch { fail("real-handler-parity-response-invalid"); }
}

function mutateFirstDay(document: unknown, key: string, value: unknown): unknown | null {
  const copy = structuredClone(document) as { days?: unknown[] };
  if (!Array.isArray(copy.days) || copy.days.length === 0 || copy.days[0] == null || typeof copy.days[0] !== "object") {
    return null;
  }
  (copy.days[0] as Record<string, unknown>)[key] = value;
  return copy;
}

function mutateTopLevel(document: unknown, key: string, value: unknown): unknown | null {
  if (document == null || typeof document !== "object" || Array.isArray(document)) return null;
  const copy = structuredClone(document) as Record<string, unknown>;
  copy[key] = value;
  return copy;
}

export const CURRENT_BREAKDOWN_REFERENCE = {
  ...READ_PATH_BREAKDOWN_REFERENCE,
  rows: READ_PATH_BREAKDOWN_REFERENCE.rows.map(row => ({ ...row, token_details: {
    ...row.token_details,
    // Fresh input excludes both cache categories; the frozen oracle counted cache writes as fresh.
    fresh_in: row.token_details.in_tok - row.token_details.cached_in - row.token_details.cache_write,
  } })),
} as const;

// The frozen SQL oracle predates the additive credit KPI. Its 2020 event has no
// published credit rule, so independently require one unpriced call and no value.
export const CURRENT_CYCLE_BREAKDOWN_REFERENCE = {
  ...READ_PATH_CYCLE_BREAKDOWN_REFERENCE,
  credit_equivalent: {
    value: null, priced_credits: 0, unpriced_calls: 1, basis: "dated-standard-reference",
  },
} as const;

async function verifyCycleBreakdownParity(handler: ReadPathHandler) {
  const oracle = overviewCycleRouteOracleGuard();
  const referenceStarted = performance.now();
  const referenceCapture = await captureJson(handler, READ_PATH_CYCLE_BREAKDOWN_ROUTE);
  const referenceMs = round(performance.now() - referenceStarted);
  const candidateStarted = performance.now();
  const candidateCapture = await captureJson(handler, READ_PATH_CYCLE_BREAKDOWN_ROUTE);
  const candidateMs = round(performance.now() - candidateStarted);
  const fixedReference = structuredClone(CURRENT_CYCLE_BREAKDOWN_REFERENCE) as Record<string, unknown>;
  const fixedParity = compareWholeResponses(fixedReference, referenceCapture, CYCLE_ROUTE_CLOCK_POLICIES);
  const candidateParity = compareWholeResponses(referenceCapture, candidateCapture, CYCLE_ROUTE_CLOCK_POLICIES);
  const candidateAgainstFixed = compareWholeResponses(fixedReference, candidateCapture, CYCLE_ROUTE_CLOCK_POLICIES);
  const candidateDay = (candidateCapture as { days?: Array<Record<string, unknown>> })?.days?.[0];
  const mutations = {
    monetary: mutateFirstDay(candidateCapture, "usd", Number(candidateDay?.usd) + 1),
    // `account` is the ownership scope applied to every day row returned by this route.
    ownership: mutateTopLevel(candidateCapture, "account", "wrong-owner"),
    usage: mutateFirstDay(candidateCapture, "tokens", Number(candidateDay?.tokens) + 1),
  };
  const mutationControls = {
    day_monetary_drift_detected: mutations.monetary != null &&
      !compareWholeResponses(referenceCapture, mutations.monetary, CYCLE_ROUTE_CLOCK_POLICIES).equal,
    day_ownership_drift_detected: mutations.ownership != null &&
      !compareWholeResponses(referenceCapture, mutations.ownership, CYCLE_ROUTE_CLOCK_POLICIES).equal,
    day_usage_drift_detected: mutations.usage != null &&
      !compareWholeResponses(referenceCapture, mutations.usage, CYCLE_ROUTE_CLOCK_POLICIES).equal,
  };
  const pass = oracle.status === "pass" && fixedParity.equal && candidateParity.equal && candidateAgainstFixed.equal &&
    Object.values(mutationControls).every(Boolean);
  return {
    status: pass ? "pass" as const : "blocked" as const,
    route_alias: "/api/cycle-breakdown",
    oracle,
    full_response_reference_matches: fixedParity.equal,
    full_response_candidate_matches: candidateAgainstFixed.equal,
    repeated_real_handler_parity: candidateParity.equal,
    clock_policy: fixedParity.clock_policy,
    mutation_controls: mutationControls,
    timing: { reference_capture_ms: referenceMs, candidate_capture_ms: candidateMs },
  };
}

function mutateFirstRow(document: unknown, key: string, value: unknown): unknown | null {
  const copy = structuredClone(document) as { rows?: unknown[] };
  if (!Array.isArray(copy.rows) || copy.rows.length === 0 || copy.rows[0] == null || typeof copy.rows[0] !== "object") {
    return null;
  }
  (copy.rows[0] as Record<string, unknown>)[key] = value;
  return copy;
}

/** Compare two real-handler captures to a frozen independent response and run protected-field controls. */
export async function verifyRealHandlerParity(handler: ReadPathHandler) {
  const oracle = overviewRouteOracleGuard();
  const referenceStarted = performance.now();
  const referenceCapture = await captureJson(handler, READ_PATH_BREAKDOWN_ROUTE);
  const referenceMs = round(performance.now() - referenceStarted);
  const candidateStarted = performance.now();
  const candidateCapture = await captureJson(handler, READ_PATH_BREAKDOWN_ROUTE);
  const candidateMs = round(performance.now() - candidateStarted);
  const fixedReference = structuredClone(CURRENT_BREAKDOWN_REFERENCE) as Record<string, unknown>;
  const fixedParity = compareWholeResponses(fixedReference, referenceCapture, ROUTE_CLOCK_POLICIES);
  const candidateParity = compareWholeResponses(referenceCapture, candidateCapture, ROUTE_CLOCK_POLICIES);
  const candidateAgainstFixed = compareWholeResponses(fixedReference, candidateCapture, ROUTE_CLOCK_POLICIES);
  const candidateRow = (candidateCapture as { rows?: Array<Record<string, unknown>> })?.rows?.[0];
  const mutations = {
    monetary: mutateFirstRow(candidateCapture, "usd", Number(candidateRow?.usd) + 1),
    ownership: mutateFirstRow(candidateCapture, "name", "wrong-owner"),
    usage: mutateFirstRow(candidateCapture, "tokens", Number(candidateRow?.tokens) + 1),
  };
  const mutationControls = {
    monetary_drift_detected: mutations.monetary != null &&
      !compareWholeResponses(referenceCapture, mutations.monetary, ROUTE_CLOCK_POLICIES).equal,
    ownership_drift_detected: mutations.ownership != null &&
      !compareWholeResponses(referenceCapture, mutations.ownership, ROUTE_CLOCK_POLICIES).equal,
    usage_drift_detected: mutations.usage != null &&
      !compareWholeResponses(referenceCapture, mutations.usage, ROUTE_CLOCK_POLICIES).equal,
  };
  const cycleBreakdown = await verifyCycleBreakdownParity(handler);
  const pass = oracle.status === "pass" && fixedParity.equal && candidateParity.equal && candidateAgainstFixed.equal &&
    cycleBreakdown.status === "pass" &&
    Object.values(mutationControls).every(Boolean);
  return {
    status: pass ? "pass" as const : "blocked" as const,
    route_alias: "/api/breakdown",
    oracle,
    full_response_reference_matches: fixedParity.equal,
    full_response_candidate_matches: candidateAgainstFixed.equal,
    repeated_real_handler_parity: candidateParity.equal,
    clock_policy: fixedParity.clock_policy,
    mutation_controls: mutationControls,
    timing: { reference_capture_ms: referenceMs, candidate_capture_ms: candidateMs },
    cycle_breakdown: cycleBreakdown,
  };
}

export function createSyntheticReadPathInputs(root: string) {
  // Migrations load environment-bound configuration; the serve path sets its isolated roots first.
  const { applyDrizzleMigrations } = require("../../src/db/migrate") as typeof import("../../src/db/migrate");
  if (!path.isAbsolute(root)) fail("synthetic-root-must-be-absolute");
  assertPlainDirectory(root, "synthetic-root-missing-or-unsafe");
  if (fs.readdirSync(root).length !== 0) fail("synthetic-root-not-empty");
  const canonicalRoot = canonicalExisting(root, "synthetic-root-missing-or-unsafe");
  for (const production of productionRoots().map((candidate) =>
    canonicalFromExistingAncestor(candidate, "production-root-unresolvable"))) {
    if (samePath(canonicalRoot, production) || within(canonicalRoot, production)) fail("production-path-rejected");
  }
  const inputs = path.join(root, "inputs"), archive = path.join(root, "archive-copy"), work = path.join(root, "work");
  fs.mkdirSync(inputs); fs.mkdirSync(archive); fs.mkdirSync(work);
  const databaseCopy = path.join(inputs, "atlas-copy.sqlite");
  const configCopy = path.join(inputs, "accounts-copy.json");
  const output = path.join(root, "server-report.json");
  const logical: LogicalContext = {
    archive,
    userprofile: path.join(root, "logical-user-identity"),
    machine: "SYNTHETIC-PC",
    login: "review",
    profile: "SYNTHETIC-PC-review",
  };
  const config: HarnessAccounts = {
    _read_path_harness: { logical_context: logical, synthetic: true },
    version: 2,
    subscriptions: [
      { id: "indexed-a", vendor: "codex", status: "active", account: "a@example.test" },
      { id: "indexed-b", vendor: "codex", status: "active", account: "b@example.test" },
      { id: "empty", vendor: "codex", status: "active", account: "empty@example.test" },
      { id: "oracle", vendor: "codex", status: "active", account: "oracle@example.test" },
    ],
    sources: [
      { vendor: "codex", machine: logical.machine, login: logical.login, home: "${ARCHIVE}/codex/${PROFILE}-a", source_home: "${HOME}/.codex-a" },
      { vendor: "codex", machine: logical.machine, login: logical.login, home: "${ARCHIVE}/codex/${PROFILE}-b", source_home: "${HOME}/.codex-b" },
      { vendor: "codex", machine: logical.machine, login: logical.login, home: "${ARCHIVE}/codex/${PROFILE}-empty", source_home: "${HOME}/.codex-empty" },
      { vendor: "codex", machine: logical.machine, login: logical.login, home: "${ARCHIVE}/codex/${PROFILE}-oracle", source_home: "${HOME}/.codex-oracle" },
    ],
  };
  const materialized = materializeAccounts(config);
  const homes = new Map(materialized.subscriptions.map((sub, index) => [sub.id, materialized.sources[index]!.home]));
  const sqlite = new Database(databaseCopy, { create: true });
  try {
    applyDrizzleMigrations(drizzle(sqlite));
    replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, materialized.subscriptions.map((sub, index) => ({
      provider: "codex", subject: `codex/${path.basename(materialized.sources[index]!.home)}`,
      value: sub.id, from: "2000-01-01", until: null, origin: "declared" as const,
      firstSeen: null, lastSeen: null, readings: 0, evidence: "synthetic-read-path-fixture",
    })));
    sqlite.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, home TEXT NOT NULL, path TEXT NOT NULL,
      ts TEXT NOT NULL, surface TEXT, model TEXT, project_id TEXT, cwd TEXT,
      in_tok INTEGER NOT NULL DEFAULT 0, cached_in INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
      reasoning_out INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ratelimit (home TEXT NOT NULL, path TEXT, ts TEXT NOT NULL,
      window_minutes INTEGER NOT NULL, limit_id TEXT NOT NULL, used_percent REAL NOT NULL,
      resets_at INTEGER, plan_type TEXT, limit_name TEXT);
  `);
    const now = Date.now(), day = 86_400_000;
    sqlite.transaction(() => {
    const oracleHome = homes.get("oracle")!;
    sqlite.query(`INSERT INTO events(home,path,ts,surface,model,project_id,in_tok,cached_in,cache_write,out_tok,reasoning_out)
      VALUES (?,?,?,'cli','gpt-5.5','oracle-project',?,?,?,?,?)`)
      .run(oracleHome, `${oracleHome}/fixed-a.jsonl`, "2020-01-01T06:00:00.000Z", 1_000_000, 250_000, 10_000, 100_000, 25_000);
    sqlite.query(`INSERT INTO events(home,path,ts,surface,model,project_id,in_tok,cached_in,cache_write,out_tok,reasoning_out)
      VALUES (?,?,?,'cli','gpt-5.5','oracle-project',?,?,?,?,?)`)
      .run(oracleHome, `${oracleHome}/fixed-b.jsonl`, "2020-01-01T18:00:00.000Z", 2_000_000, 500_000, 20_000, 200_000, 50_000);
    for (const [index, id] of ["indexed-a", "indexed-b"].entries()) {
      const home = homes.get(id)!;
      const reset = now + (index === 0 ? 3 : 2) * day;
      for (let cycle = 0; cycle < 3; cycle++) {
        const cycleReset = reset - (2 - cycle) * 7 * day;
        const points = index === 0 ? 4 : 6;
        for (let point = 0; point < points; point++) {
          const ts = new Date(cycleReset - 7 * day + point * day + 60_000).toISOString();
          sqlite.query(`INSERT INTO events(home,path,ts,surface,model,project_id,in_tok,cached_in,out_tok)
            VALUES (?,?,?,'cli','gpt-5','synthetic-project',?,?,?)`)
            .run(home, `${home}/synthetic-${cycle}.jsonl`, ts, 1_000 + index * 5_000 + point * 100, 400, 200);
          sqlite.query(`INSERT INTO ratelimit VALUES (?,?,?,10080,'codex',?,?, 'pro','weekly')`)
            .run(home, `${home}/synthetic-${cycle}.jsonl`, ts, 10 + index * 30 + point * 5, Math.floor(cycleReset / 1000));
        }
      }
      sqlite.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,scope,reported_percent_side,
        used_percent,window_minutes,resets_at,machine,ok)
        VALUES ('codex',?,?,'secondary','codex','subscription','used',?,10080,?,'SYNTHETIC-PC',1)`)
        .run(id, new Date(now - 60_000).toISOString(), 35 + index * 20, new Date(reset).toISOString());
    }
    })();
  } finally {
    Bun.gc(true);
    (sqlite as Database & { clearQueryCache(): void }).clearQueryCache();
    sqlite.close(true);
  }
  fs.writeFileSync(configCopy, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { databaseCopy, configCopy, archiveCopy: archive, workDir: work, output };
}

const SAFE_API_ROUTES = new Set([
  "/api/accounts", "/api/projects", "/api/roster", "/api/windows",
  "/api/usage-series", "/api/cycle-breakdown", "/api/bootstrap", "/api/revisions",
  "/api/setup", "/api/sync", "/api/breakdown", "/api/planhealth",
  "/api/global-usage",
  // Read-only routes used by the approved shell and the September 26 Overview history/calibration.
  "/api/app-activity", "/api/analysis/rebuild", "/api/codex-accounting",
]);

function safeApiPath(pathname: string): boolean {
  return SAFE_API_ROUTES.has(pathname) || /^\/api\/subscriptions\/[^/]+\/current$/.test(pathname);
}

async function prepareSyntheticRegisters(ctx: import("../../src/server/api").AppContext): Promise<number> {
  const started=performance.now();
  const {prepareUsageRegisters}=await import("../../src/server/usage-register.fixture");
  const {prepareProbeReaderFixture}=await import("../../src/server/probe-reader.fixture");
  const {currentRegistry}=await import("../../src/server/current/registry");
  const {publishCurrentBatch}=await import("../../src/server/current/store");
  const {resolveCodexAccountingConfig}=await import("../../src/server/codex-accounting-pricing");
  // The frozen SQL oracle declares this synthetic 2020 tariff; no official price is backdated.
  const config=resolveCodexAccountingConfig(ctx.rateCards);
  ctx.rateCards={...ctx.rateCards,unit:"per 1M",codex_accounting:{version:1,rules:[
    ...config.rules.filter(rule=>rule.model!=="gpt-5.5" || rule.billing_basis!=="api_equivalent_usd"),
    {id:"synthetic-read-path-api",model:"gpt-5.5",speed:"standard",billing_basis:"api_equivalent_usd",
      valid_from:"2000-01-01",verified_at:"2026-01-01",confidence:"user",sources:["https://example.test/read-path-price"],
      multiplier:1,rates:{in_uncached:5,in_cache_read:0.5,in_cache_write:5,out_total:30}},
  ]}};
  const sources=ctx.accounts.sources.map((source,index)=>({...source,id:ctx.accounts.subscriptions[index]!.id}));
  prepareUsageRegisters(ctx.sqlite,ctx.rateCards,sources,ctx.homeToSubId);
  prepareProbeReaderFixture(ctx.sqlite,sources);
  const now=new Date().toISOString();
  for(let step=0;step<1000;step++) {
    if(!publishCurrentBatch(ctx.sqlite,currentRegistry(ctx.accounts.subscriptions,now),now,32,ctx.accounts))break;
    if(step===999)throw new Error("Synthetic read-path fixture did not settle");
  }
  // The maintenance worker stores windows and their sums before screens read them; this fixture has no worker.
  const {prepareLimitWindowsFixture}=await import("../../src/server/limit-windows.fixture");
  const {prepareWindowUsageFixture}=await import("../../src/server/window-usage.fixture");
  prepareLimitWindowsFixture(ctx.sqlite,{sources,subscriptions:ctx.accounts.subscriptions});
  prepareWindowUsageFixture(ctx.sqlite,{rateCards:ctx.rateCards,subscriptions:ctx.accounts.subscriptions,manualCapacity:()=>[],cycles:{windows:[]}});
  return round(performance.now() - started);
}

async function serve(options: ReadPathOptions): Promise<never> {
  const prepared = prepareReadPathWorkingCopy(options);
  const outputFd = fs.openSync(prepared.output, "wx", 0o600);
  process.env.TOKENATLAS_DB = prepared.database;
  process.env.TOKENATLAS_CONFIG = prepared.configDir;
  process.env.TOKENATLAS_ARCHIVE = prepared.archive;
  process.env.TOKENATLAS_MACHINE = "SYNTHETIC-PC";
  process.env.TOKENATLAS_LOGIN = "review";
  const contextStarted = performance.now();
  const api = await import("../../src/server/api");
  const ctx = api.createAppContext(prepared.database);
  try {
    ctx.probeSourceExists = () => false;
    const contextMs = round(performance.now() - contextStarted);
    const contextWrites = (ctx.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const synthetic = readConfig(options.configCopy)._read_path_harness?.synthetic === true;
    let fixturePreparationMs = synthetic ? await prepareSyntheticRegisters(ctx) : null;
    const handler = api.createFetchHandler(ctx);
    if (synthetic) {
      const started=performance.now();
      const routes=[READ_PATH_BREAKDOWN_ROUTE,READ_PATH_CYCLE_BREAKDOWN_ROUTE,
        ...["unknown","empty","indexed-a","indexed-b"].map(account=>`/api/planhealth?account=${account}`)];
      for(const route of routes) {
        const response=await ctx.analysisReader!(ctx,new Request(`http://localhost${route}`));
        if(response.status!==(route==="/api/planhealth?account=unknown" ? 400 : 200)) {
          fail("synthetic-report-preparation-failed");
        }
      }
      fixturePreparationMs! += round(performance.now() - started);
    }
    const parityChangesBefore = (ctx.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const responseParity = await verifyRealHandlerParity(handler);
    const planhealth: Array<{ account: string; status: number; expected: unknown }> = [];
    for (const account of ["unknown", "empty", "indexed-a", "indexed-b"]) {
      const route = `/api/planhealth?account=${account}`;
      const reference = referencePlanHealth(ctx, new URL(`http://localhost${route}`));
      const candidate = await handler(new Request(`http://localhost${route}`));
      const expected = await reference.json();
      const actual = await candidate.json();
      if (reference.status !== candidate.status || !compareWholeResponses(expected, actual).equal) {
        fail("planhealth-full-response-parity-failed");
      }
      planhealth.push({ account, status: reference.status, expected });
    }
    const parityChangesAfter = (ctx.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
    if (responseParity.status !== "pass" || parityChangesAfter !== parityChangesBefore) {
      fail("real-handler-response-parity-failed");
    }
    const routeSamples: Array<{ route_alias: string; route_ms: number | null; status: number; response_bytes: number | null; writes: number }> = [];
    const report = () => ({
      schema_version: 2,
      kind: "isolated-read-path-server",
      status: "ready",
      safety: {
        explicit_copies: true,
        immutable_inputs: prepared.immutable_inputs,
        logical_source_ids_match: prepared.logical_source_ids_match,
        source_homes_match: prepared.source_homes_match,
        start_server_called: false,
        production_defaults_used: false,
        canonical_realpaths_verified: true,
        ancestor_junctions_resolved: true,
        sqlite_sidecars_absent_at_validation: true,
        sqlite_sidecars_absent_at_copy_boundary: true,
        real_handler_full_response_parity: true,
        allowed_api_routes: [...SAFE_API_ROUTES, "/api/subscriptions/:alias/current"],
      },
      timing: {
        sql: null,
        route: { samples: routeSamples },
        context: { preparation_ms: prepared.preparation_ms, create_context_ms: contextMs, preparation_writes: contextWrites,
          synthetic_register_preparation_ms:fixturePreparationMs },
        process: null,
        browser: null,
      },
      parity: responseParity,
      planhealth: { status: "PASS", cases: planhealth },
      environment: { status: "synthetic-local", bun: Bun.version, platform: process.platform, arch: process.arch },
    });
    const writeReport = () => {
      fs.ftruncateSync(outputFd, 0);
      fs.writeSync(outputFd, JSON.stringify(report(), null, 2) + "\n", 0, "utf8");
      fs.fsyncSync(outputFd);
    };
    writeReport();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/__read-path-report" && req.method === "GET") {
          writeReport();
          return Response.json(report());
        }
        if (url.pathname.startsWith("/api/") && (!safeApiPath(url.pathname) || !["GET", "HEAD"].includes(req.method))) {
          return new Response("Blocked by isolated read-path harness", { status: 405 });
        }
        if (url.pathname === "/api/cycle-breakdown" && options.delayMs) await Bun.sleep(options.delayMs);
        const changesBefore = (ctx.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
        const started = performance.now();
        const response = await handler(req);
        const changesAfter = (ctx.sqlite.query("SELECT total_changes() AS n").get() as { n: number }).n;
        if (url.pathname.startsWith("/api/")) {
          const contentLengthHeader = response.headers.get("content-length");
          const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
          routeSamples.push({
            route_alias: url.pathname,
            route_ms: Number.isFinite(started) ? round(performance.now() - started) : null,
            status: response.status,
            response_bytes: contentLength != null && Number.isFinite(contentLength) ? contentLength : null,
            writes: changesAfter - changesBefore,
          });
        }
        return response;
      },
    });
    console.log(`READ_PATH_HARNESS_URL=http://127.0.0.1:${server.port}`);
    const close = () => {
      try { writeReport(); } catch {}
      server.stop(true);
      ctx.analysisReader?.close();
      ctx.sqlite.close(true);
      fs.closeSync(outputFd);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { close(); process.exit(0); });
    await new Promise(() => {});
    throw new Error("unreachable");
  } catch (error) {
    ctx.analysisReader?.close();
    ctx.sqlite.close(true);
    fs.closeSync(outputFd);
    throw error;
  }
}

function optionMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) fail("invalid-arguments");
    values.set(key, value);
  }
  return values;
}

function parseServeArgs(args: string[]): ReadPathOptions {
  const values = optionMap(args);
  const allowed = new Set(["--db-copy", "--config-copy", "--archive-copy", "--work-dir", "--out", "--delay-ms"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) fail("invalid-arguments");
  return {
    databaseCopy: values.get("--db-copy") ?? "",
    configCopy: values.get("--config-copy") ?? "",
    archiveCopy: values.get("--archive-copy") ?? "",
    workDir: values.get("--work-dir") ?? "",
    output: values.get("--out") ?? "",
    delayMs: Number(values.get("--delay-ms") ?? "0"),
  };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "create-synthetic") {
      const values = optionMap(args);
      if (values.size !== 1 || !values.get("--root")) fail("invalid-arguments");
      console.log(JSON.stringify(createSyntheticReadPathInputs(values.get("--root")!)));
    } else if (command === "measure-synthetic") {
      const values = optionMap(args);
      const output = values.get("--out");
      if (values.size !== 1 || !output || !path.isAbsolute(output) || fs.existsSync(output)) fail("invalid-arguments");
      assertPlainDirectory(path.dirname(output), "output-directory-missing-or-unsafe");
      const syntheticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ta-read-path-measure-"));
      try {
        const inputs = createSyntheticReadPathInputs(syntheticRoot);
        const { measureOverviewReadProcesses } = await import("../review-overview");
        const report = await measureOverviewReadProcesses(inputs.databaseCopy, 20, 5);
        fs.writeFileSync(output, JSON.stringify({ ...report, machine_label: "SYNTHETIC" }, null, 2) + "\n", {
          flag: "wx", mode: 0o600,
        });
        console.log(JSON.stringify({ status: report.status, immutable_input: report.immutable_input,
          process_runs: report.timing.process.completed_runs, warm_pairs_per_process: 20 }));
        process.exitCode = report.status === "measured" ? 0 : 1;
      } finally {
        fs.rmSync(syntheticRoot, { recursive: true, force: true });
      }
    } else if (command === "serve") {
      await serve(parseServeArgs(args));
    } else {
      fail("invalid-arguments");
    }
  } catch (error) {
    const reason = error instanceof HarnessBlockedError ? error.reason : "harness-failed";
    if(process.env.TOKENATLAS_HARNESS_DEBUG==="1")console.error(error);
    console.error(`READ_PATH_HARNESS_BLOCKED=${reason}`);
    process.exitCode = error instanceof HarnessBlockedError ? 2 : 1;
  }
}
