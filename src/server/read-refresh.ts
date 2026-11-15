import { latestAccountState } from "./account-probes";
import type { AppContext } from "./app-context-types";
import { dataConfigurationStamp } from "./data-views";
import { storedScopeOf, WINDOW_SCREENS } from "./window-screens";
import { hasWindowAnswers, windowAnswerMarkedSince, windowAnswerMarkSeq } from "../db/window-answers";
import { withReadSnapshot } from "../db/analysis";
import type { ReadRefreshCheck } from "../shared/read-refresh";
import { readingsRevision } from "./cache";
import { gaugeJournalOutboxStatus } from "../providers/core/journal";
import { gaugeJournalDeliveryStatus } from "../providers/core/journal-runtime";
import type { LightReader } from "./direct-read";

/** Reads existing dependency metadata only; missing coverage keeps the ordinary full refresh. */
export function readRefreshCheck(ctx: AppContext, url: URL): ReadRefreshCheck | undefined {
  if (!url.searchParams.has("read_paths") || !hasWindowAnswers(ctx.sqlite)) return undefined;
  let paths: unknown;
  try { paths = JSON.parse(url.searchParams.get("read_paths")!); } catch { return undefined; }
  if (!Array.isArray(paths) || paths.length > 128 || paths.some(path => typeof path !== "string" || path.length > 4096)
    || url.searchParams.get("read_paths")!.length > 32768) return undefined;
  const value = url.searchParams.get("read_cursor"), from = value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  return withReadSnapshot(ctx.sqlite, () => {
    const cursor = windowAnswerMarkSeq(ctx.sqlite);
    const folded = (ctx.sqlite.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0;
    const configuration = dataConfigurationStamp(ctx, false) + ":" + JSON.stringify([
      ctx.sqlite.query("PRAGMA schema_version").get(),
      ctx.sqlite.query("SELECT value FROM meta WHERE key='account_periods_revision'").get(),
      ctx.sqlite.query("SELECT config_revision FROM sync_revisions WHERE id=1").get(),
    ]);
    const reset = from === null || from < folded || from > cursor;
    const unchanged: string[] = [];
    const dependencies: Record<string, string> = {};
    let latest: ReturnType<typeof latestAccountState> | undefined;
    const readLatest = () => latest ??= latestAccountState(ctx);
    for (const pathname of new Set(paths as string[])) {
      // Only application-relative paths; the registry owns account/provider/range semantics.
      if (!pathname.startsWith("/api/") || pathname.startsWith("//")) continue;
      const request = new URL(pathname, url.origin), scope = storedScopeOf(ctx, request);
      if (!scope || !Number.isFinite(scope.fromMs) || scope.untilMs !== null && !Number.isFinite(scope.untilMs)) continue;
      dependencies[pathname] = WINDOW_SCREENS[request.pathname]?.configuration?.(ctx, request, readLatest) ?? "shared";
      if (!reset && !windowAnswerMarkedSince(ctx.sqlite, scope, from!)) unchanged.push(pathname);
    }
    return { from, cursor, configuration, reset, dependencies, unchanged };
  });
}

/** The stored rows of the GET /api/sync answer, from one read snapshot. */
export interface SyncReadRows {
  readings_revision: number | null; read_changes: ReadRefreshCheck | undefined;
  outbox: ReturnType<typeof gaugeJournalOutboxStatus> | null;
}
export function syncReadRows(ctx: AppContext, url: URL): SyncReadRows {
  return withReadSnapshot(ctx.sqlite, () => {
    let outbox: SyncReadRows["outbox"] = null;
    try { outbox = gaugeJournalOutboxStatus(ctx.sqlite); } catch { /* reported as unknown, as before */ }
    return { readings_revision: readingsRevision(ctx.sqlite), read_changes: readRefreshCheck(ctx, url), outbox };
  });
}
/**
 * Polled by every tab: with a database file read on the lookup lane (direct-read.ts), never on the HTTP thread.
 * Null when the client left. A failed lookup answers as unknown rows, which the client takes as a full refresh.
 */
export async function readSyncRows(ctx: AppContext, url: URL, light?: LightReader, signal?: AbortSignal): Promise<SyncReadRows | null> {
  if (!light || !ctx.dbPath || ctx.dbPath === ":memory:") return syncReadRows(ctx, url);
  const answer = await light(ctx, { kind: "sync", url: `${url.pathname}${url.search}` }, signal);
  if (!answer) return null;
  return "error" in answer ? { readings_revision: null, read_changes: undefined, outbox: null } : answer.value as SyncReadRows;
}
/** The journal outbox of the sync answer (`gaugeJournalOutbox`): its stored counts with this process's delivery state. */
export function syncOutbox(counts: SyncReadRows["outbox"]) {
  const delivery = gaugeJournalDeliveryStatus();
  return { pending: counts?.pending ?? null, oldestQueuedAt: counts?.oldestQueuedAt ?? null, lastError: delivery.lastError,
    lastDeliveredAt: delivery.lastDeliveredAt, delivering: delivery.running };
}
