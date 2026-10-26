/**
 * U1.1 acceptance: stored limit windows (limit_windows) against the reference functions.
 *
 *   --dump <file>   Reference: today's window functions for every account and counter. Run this file from a
 *                   checkout of the reference commit (the functions it calls no longer exist after U1.1).
 *   --fill          Run the maintenance worker's producer (advanceLimitWindows) on the copy until idle.
 *   --compare <file> Table content against a reference dump, window by window (exact JSON equality).
 *
 * Paths are explicit (--db, --config, --archive); the live database is never discovered. --db must be a copy.
 * Every run writes a header: entry point, mode, sample, exclusions, power plan and timings.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

const { values: args } = parseArgs({ options: {
  db: { type: "string" }, config: { type: "string" }, archive: { type: "string" },
  dump: { type: "string" }, fill: { type: "boolean", default: false }, compare: { type: "string" }, out: { type: "string" },
  budget: { type: "string", default: "1000" },
} });
for (const key of ["db", "config", "archive"] as const) if (!args[key]) throw new Error(`Required --${key}`);
const dbPath = path.resolve(args.db!);
Object.assign(process.env, { TOKENATLAS_DB: dbPath, TOKENATLAS_CONFIG: path.resolve(args.config!),
  TOKENATLAS_ARCHIVE: path.resolve(args.archive!), TOKENATLAS_FROZEN_CONFIG: "1" });
const powerPlan = (() => { try { return execFileSync("powercfg", ["/getactivescheme"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const { Database } = await import("../../src/db/sqlite");
const locations = await import("../../src/config/paths");
const { readAccountsV2 } = await import("../../src/config/accounts-document");
const { loadAccountResolver } = await import("../../src/server/account-resolver");
const accounts = readAccountsV2(locations.configFile("accounts.json"));
accounts.sources = accounts.sources.map(s => ({ ...s, home: locations.expandPath(s.home),
  ...(s.source_home ? { source_home: locations.expandPath(s.source_home) } : {}) }));
const PROVIDERS = ["codex", "claude", "gemini", "glm", "grok"];
type Windows = Record<string, unknown[]>;
const keyOf = (provider: string, account: string, counter: string) => JSON.stringify([provider, account, counter]);
const header = (entry: string, mode: string, extra: Record<string, unknown> = {}) => ({ schema: "limit-windows-compare/v1",
  entry, mode, db: dbPath, config: process.env.TOKENATLAS_CONFIG, archive: process.env.TOKENATLAS_ARCHIVE, powerPlan,
  sample: "every account the account periods name, for codex, claude, gemini, glm and grok; every counter",
  exclusions: ["HTTP transport and response cache", "window sums (U1.2)", "live database"], ...extra });

if (args.dump) {
  // Reference functions as they exist at the reference commit; memo disabled, read-only connection.
  const db = new Database(dbPath, { readonly: true });
  const { loadPeriods, PLAN_PERIODS } = await import("../../src/db/period-store");
  const { loadCycles } = await import("../../src/server/cycles");
  const { readManualCapacity } = await import("../../src/server/manual-capacity");
  const codex = await import("../../src/server/codex-limit-windows") as Record<string, (...input: never[]) => unknown>;
  const probe = await import("../../src/server/probe-limit-windows") as unknown as Record<string, (...input: never[]) => unknown>;
  const resolver = loadAccountResolver(db, accounts.subscriptions), periods = loadPeriods(db, PLAN_PERIODS), cycles = loadCycles();
  const windows: Windows = {}, timings: Record<string, number> = {};
  const started = performance.now();
  for (const provider of PROVIDERS) for (const account of resolver.accounts(provider)) {
    let measurements: unknown[] = []; try { measurements = readManualCapacity(provider).measurements; } catch { /* Codex has none. */ }
    const t = performance.now();
    if (provider === "codex") for (const minutes of [10080, 300]) {
      windows[keyOf(provider, account, JSON.stringify(["codex", "codex", minutes]))] = (codex.loadCodexLimitWindows as (input: unknown) => unknown[])({
        sqlite: db, resolver, account, minutes, sources: accounts.sources, periods, measurements, memo: false });
    } else {
      const evidence = (probe.loadProbeLimitEvidence as (...input: unknown[]) => { samples: Array<{ resets_at: string | null; used_percent: number | null }> })(db, provider, account, resolver);
      const counters = [...new Set(evidence.samples.filter(s => s.resets_at && s.used_percent != null)
        .map(s => (probe.probeLimitCounter as (...input: unknown[]) => string)(s, account, cycles)))];
      for (const counter of counters) windows[keyOf(provider, account, counter)] = (probe.buildProbeLimitWindowsFromEvidence as (input: unknown) => unknown[])({
        sqlite: db, provider, account, counter, evidence, cycles, periods, measurements, memo: false });
    }
    timings[`${provider}:${account}`] = Math.round(performance.now() - t);
  }
  fs.writeFileSync(args.dump, JSON.stringify({ header: header("loadCodexLimitWindows / loadProbeLimitEvidence + buildProbeLimitWindowsFromEvidence (memo: false)",
    "read-only, reference commit", { ms: Math.round(performance.now() - started), timings }), windows }, null, 1));
  console.log(`reference: ${Object.keys(windows).length} registers, ${Object.values(windows).reduce((n, w) => n + w.length, 0)} windows`);
}

if (args.fill) {
  const { advanceLimitWindows, emptyLimitWindowStats } = await import("../../src/server/limit-window-producer");
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL");
  const stats = emptyLimitWindowStats();
  const started = performance.now();
  let turns = 0, slowest = 0;
  for (;;) {
    const t = performance.now();
    const result = advanceLimitWindows(db, { sources: accounts.sources, subscriptions: accounts.subscriptions,
      budgetMs: Number(args.budget), stats });
    slowest = Math.max(slowest, performance.now() - t);
    turns++;
    if (!result.pending || !result.progressed) { if (result.pending) console.log("stopped with pending work (blocked)"); break; }
  }
  const report = { header: header("advanceLimitWindows (analysis maintenance worker function)", "write to copy, until idle",
    { ms: Math.round(performance.now() - started), turns, slowestTurnMs: Math.round(slowest), stats }) };
  console.log(JSON.stringify(report, null, 1));
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
}

if (args.compare) {
  const { readLimitWindows } = await import("../../src/db/limit-windows");
  const db = new Database(dbPath, { readonly: true });
  const reference = JSON.parse(fs.readFileSync(args.compare, "utf8")) as { header: unknown; windows: Windows };
  const mismatches: unknown[] = [];
  let registers = 0, windows = 0;
  for (const [key, expected] of Object.entries(reference.windows)) {
    const [provider, account, counter] = JSON.parse(key) as [string, string, string];
    let actual: unknown[];
    try { actual = readLimitWindows(db, provider, account, counter); } catch (error) { mismatches.push({ key, error: String(error) }); continue; }
    registers++; windows += expected.length;
    if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
    const first = expected.findIndex((window, index) => JSON.stringify(window) !== JSON.stringify(actual[index]));
    mismatches.push({ key, expected: expected.length, actual: actual.length, firstDifference: first,
      expectedWindow: expected[first], actualWindow: actual[first] });
  }
  // Registers the table holds that the reference has not: also a difference.
  const stored = db.query("SELECT DISTINCT provider, account, counter FROM limit_windows").all() as Array<{ provider: string; account: string; counter: string }>;
  for (const row of stored) if (!(keyOf(row.provider, row.account, row.counter) in reference.windows))
    mismatches.push({ key: keyOf(row.provider, row.account, row.counter), extra: true });
  const report = { header: header("readLimitWindows (table) vs reference dump", "read-only", { reference: reference.header }),
    registers, windows, mismatches };
  console.log(JSON.stringify({ registers, windows, mismatches: mismatches.length }, null, 1));
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
  if (mismatches.length) { console.log(JSON.stringify(mismatches.slice(0, 3), null, 1)); process.exitCode = 1; }
}
