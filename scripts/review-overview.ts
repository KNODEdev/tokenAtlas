/** Explicit copied-database diagnostic; never starts the app, migrates or accesses an archive.
 * JSON contains numbers/statuses/code identity only, never rows, paths, SQL errors or account IDs.
 */
import { Database } from "../src/db/sqlite";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ReviewPreflight } from "./review-preflight";
import { LATEST_ACCOUNT_STATE_SQL } from "../src/server/latest-account-state-query.fixture";
import {
  OVERVIEW_REFERENCE_SHA,
  REFERENCE_ACCOUNT_STATE_SQL,
  overviewOracleGuard,
  sameRows,
} from "./lib/overview-reference";

type QueryName = "reference" | "candidate";
const MIN_WARM_RUNS = 20;
const MIN_PROCESS_RUNS = 5;
const round = (value: number) => Math.round(value * 1000) / 1000;
const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
  return {
    samples_ms: values.map(round),
    p50_ms: values.length ? round(at(0.5)) : null,
    p95_ms: values.length ? round(at(0.95)) : null,
    quantile_method: "nearest-rank" as const,
  };
}

function codeIdentity() {
  const git = (...args: string[]) => {
    try {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      });
      return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    } catch { return null; }
  };
  const status = git("status", "--porcelain", "--untracked-files=no");
  const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");
  return {
    head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    tracked_changes: status == null ? null : status !== "", reference: OVERVIEW_REFERENCE_SHA,
    reference_sql_sha256: digest(REFERENCE_ACCOUNT_STATE_SQL),
    candidate_sql_sha256: digest(LATEST_ACCOUNT_STATE_SQL),
  };
}

function other(name: QueryName): QueryName {
  return name === "reference" ? "candidate" : "reference";
}

function isolatedReviewPreflight(databaseCopy: string): ReviewPreflight {
  const child = Bun.spawnSync([
    process.execPath,
    path.join(import.meta.dir, "review-preflight.ts"),
    "--db-copy",
    databaseCopy,
  ], { stdout: "pipe", stderr: "pipe" });
  try {
    const report = JSON.parse(child.stdout.toString()) as ReviewPreflight;
    if (report.status === "blocked" && report.reason === "database-unreadable" &&
      report.migrations && report.journal && report.projection) {
      // Bun 1.3 on Windows can report a forced-close failure after a complete read-only inspection.
      // The dedicated child has exited, so its handles are gone; retain the completed inspection.
      return { ...report, status: report.migrations.applied < report.migrations.available ? "upgrade-required" : "compatible",
        reason: null };
    }
    return report;
  } catch {
    return {
      schema_version: 1,
      kind: "read-only-local-preflight",
      status: "blocked",
      reason: "database-unreadable",
      migrations: null,
      journal: null,
      projection: null,
      acceptance: { private_golden: "not-run", multi_pc: "not-run", user_review: "not-recorded" },
    };
  }
}

/** One process-local measurement. CLI evidence wraps this in independent Bun processes. */
export function measureOverviewRead(databaseCopy: string, samples = MIN_WARM_RUNS, start: QueryName = "reference") {
  if (!Number.isInteger(samples) || samples < 2 || samples > 200) throw new Error("invalid-sample-count");
  const preflight = isolatedReviewPreflight(databaseCopy);
  const oracle = overviewOracleGuard();
  const base = {
    schema_version: 2,
    kind: "overview-read-diagnostic",
    generated_at: new Date().toISOString(),
    code: codeIdentity(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    preflight,
    oracle,
    limits: {
      scope: "historical pre-W9 latestAccountState SQL only; not current Overview, HTTP, process startup or disk-cold I/O",
      first_pair_order: `${start}-then-${other(start)}`,
      warm_order: "interleaved A/B, alternating start",
      readonly_main: true,
      private_golden: "not-run",
      multi_pc: "not-run",
      ui_acceptance: "not-recorded",
    },
  };
  if (preflight.status === "blocked") return { ...base, status: "blocked" as const, reason: "preflight-blocked" };
  if (oracle.status === "blocked") return { ...base, status: "blocked" as const, reason: "oracle-drift" };
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(databaseCopy, { readonly: true, strict: true });
    const database = sqlite;
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    if (!(database.query("PRAGMA table_info(probe_windows)").all() as {name:string}[])
      .some(column => column.name === "era_unattributed"))
      return { ...base, status: "blocked" as const, reason: "historical-query-schema-retired" };
    const measure = (db: Database, name: QueryName) => {
      const sql = name === "reference" ? REFERENCE_ACCOUNT_STATE_SQL : LATEST_ACCOUNT_STATE_SQL;
      const before = performance.now();
      const rows = db.query(sql).all();
      return { rows, ms: performance.now() - before };
    };
    const result = database.transaction(() => {
      const firstName = start;
      const secondName = other(start);
      const first = measure(database, firstName);
      const second = measure(database, secondName);
      const referenceRows = firstName === "reference" ? first.rows : second.rows;
      const candidateRows = firstName === "candidate" ? first.rows : second.rows;
      let parity = sameRows(referenceRows, candidateRows);
      const firstMs = { reference: null as number | null, candidate: null as number | null };
      firstMs[firstName] = round(first.ms);
      firstMs[secondName] = round(second.ms);
      const times = { reference: [] as number[], candidate: [] as number[] };
      for (let i = 0; i < samples; i++) {
        const firstWarm = i % 2 === 0 ? start : other(start);
        for (const name of [firstWarm, other(firstWarm)] as const) {
          const current = measure(database, name);
          parity = sameRows(referenceRows, current.rows) && parity;
          times[name].push(current.ms);
        }
      }
      const count = database.query(`SELECT COUNT(*) AS rows, COUNT(DISTINCT subject) AS subjects
        FROM probe_windows WHERE provider='codex'`).get() as { rows: number; subjects: number };
      const sqliteVersion = database.query("SELECT sqlite_version() AS version").get() as { version: string };
      return {
        parity,
        result_rows: candidateRows.length,
        codex_probe_rows: count.rows,
        codex_subjects: count.subjects,
        sqlite_version: sqliteVersion.version,
        first_ms: firstMs,
        warm: { reference: distribution(times.reference), candidate: distribution(times.candidate) },
      };
    }).deferred();
    const changed = (database.query("SELECT total_changes() AS n").get() as { n: number }).n !== 0;
    const passed = result.parity && !changed;
    return {
      ...base,
      status: passed ? "measured" as const : "blocked" as const,
      reason: passed ? null : "parity-or-readonly-failed",
      database_bytes: fs.statSync(databaseCopy).size,
      main_writes: changed,
      ...result,
    };
  } catch {
    return { ...base, status: "blocked" as const, reason: "query-unavailable" };
  } finally {
    try {
      Bun.gc(true);
      (sqlite as (Database & { clearQueryCache(): void }) | null)?.clearQueryCache();
      sqlite?.close(true);
    } catch {}
  }
}

interface ProcessRun {
  run: number;
  starting_order: string;
  process_ms: number | null;
  result: ReturnType<typeof measureOverviewRead>;
}

export async function measureOverviewReadProcesses(
  databaseCopy: string,
  samples = MIN_WARM_RUNS,
  processRuns = MIN_PROCESS_RUNS,
) {
  if (samples < MIN_WARM_RUNS || processRuns < MIN_PROCESS_RUNS) throw new Error("insufficient-repetitions");
  const beforeDigest = sha256File(databaseCopy);
  const runs: ProcessRun[] = [];
  for (let index = 0; index < processRuns; index++) {
    const start: QueryName = index % 2 === 0 ? "reference" : "candidate";
    const before = performance.now();
    const child = Bun.spawn([
      process.execPath,
      path.join(import.meta.dir, "review-overview.ts"),
      "--db-copy", databaseCopy,
      "--samples", String(samples),
      "--start", start,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TOKENATLAS_OVERVIEW_WORKER: "1" },
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const elapsed = round(performance.now() - before);
    const output = await stdout;
    await stderr;
    let result: ReturnType<typeof measureOverviewRead>;
    try { result = JSON.parse(output) as ReturnType<typeof measureOverviewRead>; }
    catch { result = { status: "blocked", reason: "worker-output-invalid" } as ReturnType<typeof measureOverviewRead>; }
    runs.push({ run: index + 1, starting_order: `${start}-then-${other(start)}`, process_ms: elapsed, result });
    if (exitCode !== 0 || result.status !== "measured") break;
  }
  const immutableInput = beforeDigest === sha256File(databaseCopy);
  const passed = runs.length === processRuns && runs.every((run) => run.result.status === "measured") && immutableInput;
  const first = runs[0]?.result;
  const referenceWarm = runs.flatMap((run) => run.result.status === "measured" ? run.result.warm.reference.samples_ms : []);
  const candidateWarm = runs.flatMap((run) => run.result.status === "measured" ? run.result.warm.candidate.samples_ms : []);
  return {
    ...(first ?? {
      schema_version: 2,
      kind: "overview-read-diagnostic",
      generated_at: new Date().toISOString(),
      code: codeIdentity(),
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      preflight: isolatedReviewPreflight(databaseCopy),
      oracle: overviewOracleGuard(),
    }),
    status: passed ? "measured" as const : "blocked" as const,
    reason: passed ? null : "process-suite-or-immutability-failed",
    immutable_input: immutableInput,
    timing: {
      sql: { reference: distribution(referenceWarm), candidate: distribution(candidateWarm) },
      route: null,
      context: null,
      process: {
        required_runs: MIN_PROCESS_RUNS,
        completed_runs: runs.length,
        cache_conditions: "new Bun process and SQLite connection per run; OS/disk cache preserved and uncontrolled",
        runs: runs.map((run) => ({
          run: run.run,
          starting_order: run.starting_order,
          process_ms: run.process_ms,
          first_ms: run.result.status === "measured" ? run.result.first_ms : { reference: null, candidate: null },
          warm: run.result.status === "measured" ? run.result.warm : null,
          status: run.result.status,
        })),
      },
      browser: null,
    },
  };
}

export function parseOverviewArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--db-copy", "--out", "--machine", "--samples", "--process-runs"].includes(key) ||
        !value || value.startsWith("--") || values.has(key)) throw new Error("invalid-arguments");
    values.set(key, value);
  }
  const databaseCopy = values.get("--db-copy"), output = values.get("--out"), label = values.get("--machine");
  const samples = Number(values.get("--samples") ?? String(MIN_WARM_RUNS));
  const processRuns = Number(values.get("--process-runs") ?? String(MIN_PROCESS_RUNS));
  if (!databaseCopy || !output || !["MAIN", "LAPTOP", "SYNTHETIC"].includes(label ?? "") ||
      !Number.isInteger(samples) || samples < MIN_WARM_RUNS || samples > 200 ||
      !Number.isInteger(processRuns) || processRuns < MIN_PROCESS_RUNS || processRuns > 20 ||
      path.extname(output).toLowerCase() !== ".json" || path.resolve(databaseCopy) === path.resolve(output)) {
    throw new Error("invalid-arguments");
  }
  return { databaseCopy, output, label: label!, samples, processRuns };
}

function parseWorkerArgs(args: string[]) {
  const dbAt = args.indexOf("--db-copy"), samplesAt = args.indexOf("--samples"), startAt = args.indexOf("--start");
  const databaseCopy = args[dbAt + 1], samples = Number(args[samplesAt + 1]), start = args[startAt + 1];
  if (dbAt < 0 || samplesAt < 0 || startAt < 0 || !databaseCopy ||
      !Number.isInteger(samples) || samples < MIN_WARM_RUNS || !["reference", "candidate"].includes(start ?? "")) {
    throw new Error("invalid-worker-arguments");
  }
  return { databaseCopy, samples, start: start as QueryName };
}

if (import.meta.main) {
  if (process.env.TOKENATLAS_OVERVIEW_WORKER === "1") {
    try {
      const args = parseWorkerArgs(process.argv.slice(2));
      const report = measureOverviewRead(args.databaseCopy, args.samples, args.start);
      console.log(JSON.stringify(report));
      process.exitCode = report.status === "measured" ? 0 : 1;
    } catch {
      console.log(JSON.stringify({ status: "blocked", reason: "invalid-worker-arguments" }));
      process.exitCode = 2;
    }
  } else {
    let args: ReturnType<typeof parseOverviewArgs>;
    try { args = parseOverviewArgs(process.argv.slice(2)); }
    catch {
      console.error("Usage: bun run review:overview --db-copy <isolated-copy.sqlite> --out <new-report.json> --machine MAIN|LAPTOP [--samples 20] [--process-runs 5]");
      process.exit(2);
    }
    let fd: number;
    try { fd = fs.openSync(args.output, "wx", 0o600); }
    catch { console.error("Report not created: use a new .json file in an existing private directory."); process.exit(2); }
    try {
      const report = { ...(await measureOverviewReadProcesses(args.databaseCopy, args.samples, args.processRuns)), machine_label: args.label };
      fs.writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
      console.log("Overview SQL report saved to the explicitly requested output file.");
      process.exitCode = report.status === "measured" ? 0 : 1;
    } catch {
      fs.writeFileSync(fd, JSON.stringify({ schema_version: 2, status: "blocked", reason: "measurement-failed" }) + "\n");
      process.exitCode = 1;
    } finally { fs.closeSync(fd); }
  }
}
