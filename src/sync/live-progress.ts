import fs from "node:fs";
import path from "node:path";
import type { SyncRunResult } from "./contracts";
import type { SyncProgress } from "../shared/sync-progress";

/**
 * The run's status lives in `sync_runs`, inside the database the run is writing. While a
 * publication transaction is open (or a status save is skipped as busy) other connections
 * see an older record, so the progress panel froze on a finished step. The coordinator
 * therefore mirrors every status change into this file first; the API overlays it.
 */
const MAX_BYTES = 64 * 1024;
const THROTTLE_MS = 250;
// Small, bounded vendor details the progress panel and diagnostics read during a run.
const LIVE_DIAGNOSTICS = ["ingestTimings", "activeTimingStep", "selectedInputs",
  "firstFill", "appended", "deltaIdentities"] as const;

const RUN_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// Own folder: the stage cleanup scans sync-staging and records its position in `meta` whenever
// it meets a file it must keep, which a live run's file would cause on every synchronization.
const liveFolder = (dbPath: string) => path.join(path.dirname(dbPath), "sync-staging", "live");

export function liveProgressPath(dbPath: string, runId: string): string | null {
  if (!dbPath || dbPath === ":memory:" || !RUN_ID.test(runId)) return null;
  return path.join(liveFolder(dbPath), `${runId}.json`);
}

/** Runs are claimed one at a time per database: any other run's file is left over from a crash. */
export function pruneLiveProgress(dbPath: string, currentRunId: string): void {
  if (!dbPath || dbPath === ":memory:") return;
  let names: string[];
  try { names = fs.readdirSync(liveFolder(dbPath)); } catch { return; }
  for (const name of names) {
    if (name === `${currentRunId}.json` || !/^[0-9a-f-]{36}\.json(?:\.tmp)?$/i.test(name)) continue;
    try { fs.unlinkSync(path.join(liveFolder(dbPath), name)); } catch { /* Retried by the next run. */ }
  }
}

interface LiveSnapshot {
  runId: string;
  sequence: number;
  progress?: SyncProgress;
  vendors: Array<Pick<SyncRunResult["vendors"][number], "vendor" | "status" | "startedAt" | "finishedAt" | "writtenRows"
    | "timings"> & { diagnostics: Record<string, unknown> }>;
}

function snapshot(result: SyncRunResult): LiveSnapshot {
  return {
    runId: result.runId,
    sequence: result.statusSequence ?? 0,
    progress: result.progress,
    vendors: result.vendors.map(vendor => ({
      vendor: vendor.vendor, status: vendor.status, startedAt: vendor.startedAt, finishedAt: vendor.finishedAt,
      writtenRows: vendor.writtenRows, timings: vendor.timings,
      diagnostics: Object.fromEntries(LIVE_DIAGNOSTICS.filter(key => vendor.diagnostics?.[key] !== undefined)
        .map(key => [key, vendor.diagnostics[key]])),
    })),
  };
}

const progressKey = (result: SyncRunResult) => {
  const p = result.progress;
  return `${p?.phase}|${p?.vendor}|${p?.completed}|`
    + result.vendors.map(vendor => `${vendor.status}:${String((vendor.diagnostics?.activeTimingStep as {name?:string}|undefined)?.name)}`).join(",");
};

/** Writes are advisory: a failure to write never changes the run's outcome. */
export function liveProgressWriter(dbPath: string, runId: string) {
  const file = liveProgressPath(dbPath, runId);
  let last = -Infinity, lastKey = "", trailing: ReturnType<typeof setTimeout> | undefined, cleared = false, folder = false;
  const flush = (result: SyncRunResult) => {
    if (trailing) { clearTimeout(trailing); trailing = undefined; }
    if (!file || cleared) return;
    try {
      if (!folder) { fs.mkdirSync(path.dirname(file), { recursive: true }); folder = true; }
      fs.writeFileSync(file + ".tmp", JSON.stringify(snapshot(result)));
      fs.renameSync(file + ".tmp", file);
      last = performance.now(); lastKey = progressKey(result);
    } catch { /* Progress must never change the run's outcome. */ }
  };
  return {
    write(result: SyncRunResult): void {
      if (!file || cleared) return;
      // Every status save advances the version, written or not: the database record saved next
      // carries it, so a file left older (skipped, throttled or failed) never overrides it.
      result.statusSequence = (result.statusSequence ?? 0) + 1;
      // Steps, statuses and operations are written at once; counters at most every 250 ms, and a
      // skipped counter is written when the interval ends so the file never keeps an older one.
      const elapsed = performance.now() - last;
      if (progressKey(result) !== lastKey || elapsed >= THROTTLE_MS) { flush(result); return; }
      trailing ??= setTimeout(() => flush(result), THROTTLE_MS - elapsed);
      trailing.unref?.();
    },
    clear(): void {
      cleared = true;
      if (trailing) { clearTimeout(trailing); trailing = undefined; }
      if (!file) return;
      for (const candidate of [file, file + ".tmp"]) {
        try { fs.unlinkSync(candidate); } catch { /* Disposable advisory state. */ }
      }
    },
  };
}

function validProgress(value: unknown): value is SyncProgress {
  const p = value as SyncProgress | undefined;
  return !!p && typeof p.phase === "string" && typeof p.startedAt === "string"
    && Number.isSafeInteger(p.completed) && Number.isSafeInteger(p.total) && p.completed >= 0 && p.total >= p.completed;
}

/** The running run's newest status, from the advisory file when it is readable and valid. */
export function withLiveProgress(dbPath: string, run: SyncRunResult | null): SyncRunResult | null {
  if (run?.status !== "running") return run;
  const file = liveProgressPath(dbPath, run.runId);
  if (!file) return run;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return run;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as LiveSnapshot;
    if (value.runId !== run.runId || !Array.isArray(value.vendors) || !Number.isSafeInteger(value.sequence)
      || value.sequence < (run.statusSequence ?? 0)) return run;
    const live = new Map(value.vendors.map(vendor => [vendor.vendor, vendor]));
    return {
      ...run,
      ...(validProgress(value.progress) ? { progress: value.progress } : {}),
      vendors: run.vendors.map(vendor => {
        const newer = live.get(vendor.vendor);
        if (!newer || typeof newer.status !== "string") return vendor;
        const diagnostics = { ...vendor.diagnostics, ...newer.diagnostics };
        // A finished step leaves no active step behind in the newer status.
        if (!("activeTimingStep" in newer.diagnostics)) delete diagnostics.activeTimingStep;
        return { ...vendor, status: newer.status, startedAt: newer.startedAt, finishedAt: newer.finishedAt,
          writtenRows: newer.writtenRows, timings: newer.timings ?? vendor.timings, diagnostics };
      }),
    };
  } catch { return run; }
}
