import type { ParsePool } from "./parse-pool";
import { fileParseTask, runFileTasks, type FileParseTask } from "./file-parse-tasks";
/** Ingest opencode usage into oc_events.
 *
 *  opencode (the glm / ox-alpha / qwen channel) keeps everything in one live
 *  SQLite database. The archive holds a VACUUM INTO snapshot of it, refreshed
 *  by _sync.bat - a live db+wal must never be raw-copied, so the snapshot is
 *  the only thing this ingest reads.
 *
 *  Every assistant message carries its own token counters (input / output /
 *  reasoning / cache read / cache write - disjoint, Anthropic-style), the
 *  model id and the provider. A changed snapshot reconciles messages per store
 *  inside one transaction; an unchanged snapshot is skipped by size+mtime,
 *  exactly like every other vendor. --force bypasses that bookmark.
 *
 *  Usage: bun run src/ingest/opencode.ts [--snapshot <path>] [--store <name>] [--force]
 */

import { Database } from "../db/sqlite";
import { type OpencodeRow } from "./opencode-types";
import fs from "node:fs";
import {IngestTimer,type IngestTimings,type IngestTimingHandler} from "./ingest-timings";
import path from "node:path";
import { archive, archiveProfiles, MACHINE, preferredProfile } from "../config/paths";
import { resolveDbPath } from "../db";

// opencode partitions the archive by MACHINE. The snapshot to read is this
// machine's if it has one, otherwise whichever the archive already holds - a
// second PC then charts the shared history instead of nothing at all.
const ARCHIVE_SNAPSHOT = archive(
  "opencode",
  preferredProfile("opencode") ?? MACHINE,
  "opencode.sqlite"
);

export interface OpencodeIngestResult {
  timings?:IngestTimings;
  rows: number;
  skipped: boolean;
  dirtyRange?: { from: string; to: string } | null;
}

function* ingestOpencodeSteps(
  snapshotPath: string,
  store: string,
  options: { atlasPath?: string; force?: boolean; logicalPath?: string; archivedInput?: boolean; onTimings?:IngestTimingHandler; parsePool?: ParsePool } = {},
): Generator<FileParseTask<OpencodeRow[]>, OpencodeIngestResult, OpencodeRow[]> {
  const timer=new IngestTimer(options.onTimings);
  const st = timer.measure("discoveryMs",()=>fs.statSync(snapshotPath));timer.emit(true);
  const bookmark = JSON.stringify({ path: path.resolve(options.logicalPath ?? snapshotPath), size: st.size, mtime: st.mtimeMs });
  const bookmarkKey = `opencode_snapshot:${store}`;
  const atlasPath = resolveDbPath(options.atlasPath);
  if (!fs.existsSync(path.dirname(atlasPath))) fs.mkdirSync(path.dirname(atlasPath), { recursive: true });
  // This ingest uses raw SQL only. Opening the SQLite handle directly avoids
  // retaining an unused Drizzle wrapper (and its WAL lock) for every store.
  const sqlite = new Database(atlasPath, { create: true });
  try {
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA synchronous = NORMAL;");
    sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const previousQuery = sqlite.query("SELECT value FROM meta WHERE key = ?");
    const previous = previousQuery.get(bookmarkKey) as { value: string } | null;
    if (!options.force && previous?.value === bookmark) {
      const countQuery = sqlite.query("SELECT count(*) AS n FROM oc_events WHERE store = ?");
      const row = countQuery.get(store) as { n: number };
      return { rows: row.n, skipped: true, dirtyRange: null,...(options.onTimings?{timings:timer.snapshot()}:{}) };
    }

    const task = fileParseTask("opencode", { file: snapshotPath, archivedInput: options.archivedInput });
    const parsed = yield {
      pooled: pool => timer.pool(() => task.pooled(pool)),
    };
    timer.emit(true);
    const rows = parsed.map(row => [store, ...row] as [string, ...OpencodeRow]);

    const writeStarted=performance.now();
    const previousRange = sqlite
      .query("SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM oc_events WHERE store = ?")
      .get(store) as { from_ts: string | null; to_ts: string | null };

    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const ids=rows.map(row=>row[1]);
      if(new Set(ids).size!==ids.length)throw new Error("Duplicate OpenCode message identity in snapshot");
      sqlite.query(`DELETE FROM oc_events WHERE store=?
        AND message_id NOT IN (SELECT value FROM json_each(?))`).run(store,JSON.stringify(ids));
      const fields=["session_id","ts","model","provider","agent","mode","project","directory",
        "in_tok","out_tok","reasoning","cache_read","cache_write","cost"];
      const ins = sqlite.prepare(
        `INSERT INTO oc_events (store, message_id, session_id, ts, model, provider, agent, mode,
                                project, directory, in_tok, out_tok, reasoning, cache_read, cache_write, cost)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(store,message_id) DO UPDATE SET ${fields.map(field=>`${field}=excluded.${field}`).join(",")}
         WHERE ${fields.map(field=>`typeof(oc_events.${field})<>typeof(excluded.${field}) OR oc_events.${field} IS NOT excluded.${field}`).join(" OR ")}`
      );
      try {
        for (const r of rows) ins.run(...r);
      } finally {
        ins.finalize();
      }
      sqlite.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [bookmarkKey, bookmark],
      );
      sqlite.exec("COMMIT");
      timer.add("stageWriteMs",performance.now()-writeStarted);timer.emit(true);
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }

    const timestamps = [previousRange.from_ts, previousRange.to_ts, ...rows.map((row) => row[3])]
      .filter((timestamp): timestamp is string => timestamp != null)
      .sort();
    return {
      ...(options.onTimings?{timings:timer.snapshot()}:{}),
      rows: rows.length,
      skipped: false,
      dirtyRange:
        timestamps.length > 0
          ? { from: timestamps[0]!, to: timestamps[timestamps.length - 1]! }
          : null,
    };
  } finally {
    sqlite.close();
    timer.stop();
  }
}

export function ingestOpencodeAsync(...args: Parameters<typeof ingestOpencodeSteps>): Promise<OpencodeIngestResult> {
  return runFileTasks(ingestOpencodeSteps(...args), args[2]?.parsePool);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Every machine's snapshot, not just this one's: the store column already
  // names the machine, so all of them can live side by side and both PCs then
  // report the same totals. The ingest reconciles PER STORE, so adding
  // machines cannot double-count and a re-run is idempotent.
  const explicit = flag("--snapshot");
  const force = args.includes("--force");
  const snapshots = explicit
    ? [explicit]
    : archiveProfiles("opencode").map((m) => archive("opencode", m, "opencode.sqlite"));
  const found = snapshots.filter((s) => fs.existsSync(s));
  if (found.length === 0) {
    console.error(
      `no opencode snapshot found (looked in ${archive("opencode")}) - run _sync.bat (or db-backup.ts) first`
    );
    process.exit(1);
  }
  for (const snapshot of found) {
    // The store names the MACHINE the snapshot came from, read off its own
    // folder rather than hardcoded: a wrong key would leave another machine's
    // rows stranded beside the fresh ones instead of replacing them.
    const store = flag("--store") ?? path.basename(path.dirname(snapshot));
    const result = await ingestOpencodeAsync(snapshot, store, { force, archivedInput: true });
    console.log(
      result.skipped
        ? `oc_events[${store}]: ${result.rows.toLocaleString()} assistant messages (snapshot unchanged, skipped)`
        : `oc_events[${store}]: ${result.rows.toLocaleString()} assistant messages reconciled`,
    );
  }
}
