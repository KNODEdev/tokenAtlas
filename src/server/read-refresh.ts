import { latestAccountState } from "./account-probes";
import type { AppContext } from "./app-context-types";
import { dataConfigurationStamp } from "./data-views";
import { storedScopeOf, WINDOW_SCREENS } from "./window-screens";
import { hasWindowAnswers, windowAnswerMarkedSince, windowAnswerMarkSeq } from "../db/window-answers";
import { withReadSnapshot } from "../db/analysis";
import type { ReadRefreshCheck } from "../shared/read-refresh";

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
