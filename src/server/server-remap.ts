import type { Database } from "../db/sqlite";
import type { RemapProgress, RemapResult } from "../projects/remap";
import path from "path";
import type { AppContext } from "./app-context-types";
import { appendLogTail, readProcessLines } from "./server-process-output";
import { remap } from "../projects/remap";

const REMAP_PROGRESS_PREFIX = "@@tokenatlas-progress ";

function indexRowCounts(sqlite: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ["events", "claude_events", "oc_events", "grok_events", "gemini_events"]) {
    try {
      const row = sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | null;
      if (row) counts[table] = row.n;
    } catch {
      // A vendor this machine has never ingested has no table yet.
    }
  }
  return counts;
}

export interface RemapState {
  running: boolean;
  why: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  ok: boolean | null;
  log_tail: string[];
  /** The last event the child emitted, and a human-readable form of it. Both
   *  are null/idle before the first run: a reader must not have to tell "never
   *  started" from "started but silent". */
  message: string;
  progress: RemapProgress | null;
  /** Keyed `phase:table` so a finished table keeps its final counts on screen
   *  while a later phase reports on the same table again. */
  tables: Record<
    string,
    { phase: RemapProgress["phase"]; message: string; assigned?: number; total?: number }
  >;
  /** Row counts read once at launch. A remap rewrites derived columns but never
   *  adds or drops rows, so these stay true for the whole run and give the wait
   *  a sense of scale. */
  rows: Record<string, number>;
  result: RemapResult | null;
}

function freshRemapState(): RemapState {
  return {
    running: false,
    why: null,
    started_at: null,
    finished_at: null,
    exit_code: null,
    ok: null,
    log_tail: [],
    message: "Indeks gotowy",
    progress: null,
    tables: {},
    rows: {},
    result: null,
  };
}

const remapState: RemapState = freshRemapState();

export function getRemapState(): RemapState {
  return remapState;
}

// The full remap rewrites every event table; done in-process it blocks the event
// loop for minutes and /api/health never answers, so the launcher never opens the
// browser. A subprocess keeps the server responsive; WAL lets it write while we read,
// and PRAGMA data_version rolls the response-cache stamp when it lands.
export function startStartupRemap(
  rootDir: string,
  why: string,
  dbPath: string,
  ctx?: AppContext,
  onComplete?: () => void
): RemapState {
  if (remapState.running) return remapState;
  remapState.running = true;
  remapState.why = why;
  remapState.started_at = new Date().toISOString();
  remapState.finished_at = null;
  remapState.exit_code = null;
  remapState.ok = null;
  remapState.log_tail = [];
  remapState.message = "Przygotowuję lokalny indeks";
  remapState.progress = null;
  remapState.tables = {};
  remapState.rows = ctx ? indexRowCounts(ctx.sqlite) : {};
  remapState.result = null;
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", path.join(rootDir, "src", "projects", "remap.ts"), "--progress-json"],
    cwd: rootDir,
    env: { ...process.env, TOKENATLAS_DB: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Read line by line rather than buffering both pipes to completion: the whole
  // point of the progress events is that they arrive while the child still runs.
  const onStdout = (line: string) => {
    if (!line.startsWith(REMAP_PROGRESS_PREFIX)) {
      appendLogTail(remapState, line);
      return;
    }
    try {
      const progress = JSON.parse(line.slice(REMAP_PROGRESS_PREFIX.length)) as RemapProgress;
      remapState.progress = progress;
      remapState.message = progress.message;
      if (progress.table) {
        remapState.tables[`${progress.phase}:${progress.table}`] = {
          phase: progress.phase,
          message: progress.message,
          assigned: progress.assigned,
          total: progress.total,
        };
      }
      if (progress.result) remapState.result = progress.result;
    } catch {
      // A line that only looks like a progress event is still log output.
      appendLogTail(remapState, line);
    }
  };
  (async () => {
    try {
      const [exit] = await Promise.all([
        proc.exited,
        readProcessLines(proc.stdout, onStdout),
        readProcessLines(proc.stderr, (line) => appendLogTail(remapState, line)),
      ]);
      remapState.exit_code = exit;
      remapState.ok = exit === 0;
      remapState.message = exit === 0 ? "Indeks gotowy" : "Nie udało się przygotować indeksu";
    } catch (e) {
      remapState.exit_code = -1;
      remapState.ok = false;
      remapState.message = "Nie udało się przygotować indeksu";
      remapState.log_tail = [];
      appendLogTail(remapState, String(e));
    } finally {
      remapState.running = false;
      remapState.finished_at = new Date().toISOString();
      console.log(
        remapState.ok
          ? `[tokenAtlas API] Background remap done (${remapState.result?.rules ?? 0} rule(s)).`
          : `[tokenAtlas API] Background remap failed (exit ${remapState.exit_code}):\n  ${remapState.log_tail.join("\n  ")}`
      );
      onComplete?.();
    }
  })();
  return remapState;
}

export function handleProjectsRemap(ctx: AppContext): Response {
  if (remapState.running) {
    return Response.json(
      { error: "startup remap is still running - try again when it finishes" },
      { status: 409 }
    );
  }
  try {
    return Response.json({ ok: true, remap: remap(ctx.sqlite) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
