import type { AtlasBootstrapStage, AtlasBootstrapResult } from "../db/bootstrap";
import type { Database } from "../db/sqlite";
import { bootstrapAtlasIndex } from "../db/bootstrap";
import { ARCHIVE_ROOT } from "../config/paths";

export interface AtlasBootstrapState {
  running: boolean;
  stage: AtlasBootstrapStage | null;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  status: AtlasBootstrapResult["status"] | null;
  selected_snapshot_id: string | null;
  catch_up_mode: AtlasBootstrapResult["catchUpMode"];
  attempts: AtlasBootstrapResult["attempts"];
  changed_path_rows: number;
  cleared_bookmarks: number;
  error: string | null;
}

/**
 * An empty database awaiting its first import from the archive. Live account readings wait for it:
 * one reading written first makes the gauge tables non-empty, which turned off the bulk first fill
 * and the parallel import of every provider (deployment 03.10). Readings are taken right after it.
 */
export let firstImportPending = false;

/**
 * A fresh database waits for its folders to be confirmed on the first-run screen before any import:
 * paths are read once at startup, so an import started at once could fill it from a folder the user
 * is about to change (user decision 2026-10-11). TOKENATLAS_CONFIRM_LOCATIONS=0 skips the wait.
 */
export let awaitingLocations = false;

export const LOCATIONS_CONFIRMED_KEY = "setup:locations-confirmed";

export function locationsConfirmed(sqlite: Database): boolean {
  try {
    return sqlite.query("SELECT 1 FROM meta WHERE key=?").get(LOCATIONS_CONFIRMED_KEY) != null;
  } catch { return false; }
}

const atlasBootstrapState: AtlasBootstrapState = {
  running: false,
  stage: null,
  message: "Bootstrap has not run",
  started_at: null,
  finished_at: null,
  ok: null,
  status: null,
  selected_snapshot_id: null,
  catch_up_mode: null,
  attempts: [],
  changed_path_rows: 0,
  cleared_bookmarks: 0,
  error: null,
};

export function getAtlasBootstrapState(): AtlasBootstrapState {
  return atlasBootstrapState;
}

export function runAtlasBootstrap(dbPath: string): AtlasBootstrapResult {
  Object.assign(atlasBootstrapState, {
    running: true,
    stage: "local-check" as AtlasBootstrapStage,
    message: "Checking the local Atlas index",
    started_at: new Date().toISOString(),
    finished_at: null,
    ok: null,
    status: null,
    selected_snapshot_id: null,
    catch_up_mode: null,
    attempts: [],
    changed_path_rows: 0,
    cleared_bookmarks: 0,
    error: null,
  });
  try {
    const result = bootstrapAtlasIndex({
      localDbPath: dbPath,
      archiveRoot: ARCHIVE_ROOT,
      onStage: (stage, message) => {
        Object.assign(atlasBootstrapState, { stage, message });
        console.log(`[tokenAtlas bootstrap] ${stage}: ${message}`);
      },
    });
    Object.assign(atlasBootstrapState, {
      status: result.status,
      selected_snapshot_id: result.selectedSnapshotId,
      catch_up_mode: result.catchUpMode,
      attempts: result.attempts,
      changed_path_rows: result.rebase?.changedRows ?? 0,
      cleared_bookmarks: result.rebase?.clearedBookmarks ?? 0,
    });
    if (!result.catchUpMode) {
      Object.assign(atlasBootstrapState, {
        running: false,
        stage: "complete" as AtlasBootstrapStage,
        message: "The local Atlas index is ready",
        finished_at: new Date().toISOString(),
        ok: true,
      });
    }
    return result;
  } catch (error) {
    Object.assign(atlasBootstrapState, {
      running: false,
      finished_at: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function setFirstImportPending(pending: boolean): void {
  firstImportPending = pending;
}

export function setAwaitingLocations(awaiting: boolean): void {
  awaitingLocations = awaiting;
}
