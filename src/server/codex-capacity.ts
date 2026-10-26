import type { AppContext } from "./api";
import { accountingOptions, currentCodexWindowMinutes } from "./codex-accounting";
import { handleCapacityCycles } from "./capacity-cycles";
import { preparingRows } from "./data-views";
import { CODEX_COUNTERS, CODEX_WINDOW_MINUTES } from "../shared/codex-counters";
import { CODEX_ANALYSIS_PROVIDER } from "../shared/subscription-accounting";
import type { CodexCapacityReport, CodexCapacityRange } from "../shared/codex-capacity";
import type { CapacityCyclesResponse } from "../shared/capacity-cycles";
import { hasCapacityCycleResults } from "../db/capacity-cycle-results";

/** All uses the published cycle inventory too, not the raw-history coverage report. */
export function handleCodexCapacityRange(ctx: AppContext, url: URL): Response {
  let options;
  try { options = accountingOptions(url.searchParams); }
  catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  if (!options.account || ["all", "__all__"].includes(options.account) || options.account.endsWith("::business"))
    return Response.json({ error: "Expected one subscription" }, { status: 400 });
  if (!hasCapacityCycleResults(ctx.sqlite)) return preparingRows();
  const minutes = options.window_minutes ?? currentCodexWindowMinutes(ctx.sqlite, options.account);
  const row = ctx.sqlite.query(`SELECT MIN(start_ts) first, MAX(json_extract(body,'$.end')) last FROM capacity_cycle_results
    WHERE provider='codex' AND account=? AND window_minutes=? AND body IS NOT NULL`).get(options.account, minutes) as { first: string | null; last: string | null };
  return Response.json({ range: row.first && row.last ? { since: row.first.slice(0, 10), until: row.last.slice(0, 10) } : null } satisfies CodexCapacityRange);
}

/** A direct register read: independent of response-cache keys, prefill, report workers and the writer queue. */
export async function handleCodexCapacity(ctx: AppContext, url: URL): Promise<Response> {
  let scope;
  try { scope = accountingOptions(url.searchParams); }
  catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  if (!scope.account || ["all", "__all__"].includes(scope.account) || scope.account.endsWith("::business")
    || scope.project || scope.reference_day || scope.detail_cycle)
    return Response.json({ error: "Prepared capacity requires one subscription without a project or reference price date" }, { status: 400 });
  const minutes = scope.window_minutes ?? currentCodexWindowMinutes(ctx.sqlite, scope.account);
  const request = new URL("/api/capacity-cycles", url);
  for (const [key, value] of Object.entries({ since: scope.since, until: scope.until, window_minutes: minutes })) request.searchParams.set(key, String(value));
  const response = handleCapacityCycles(ctx, request, { account: scope.account, allowStale: true });
  if (response.status !== 200) return response;
  const result = await response.json() as CapacityCyclesResponse;
  const entry = result.accounts.find(row => row.account === scope.account && row.provider === "codex");
  if (!entry) return Response.json({ error: "Unknown Codex subscription" }, { status: 400 });
  if (entry.error) return Response.json({ error: entry.error }, { status: 503 });
  if (entry.preparing) return preparingRows();
  return Response.json({ projection: true, ...(entry.stale ? { updating: true as const } : {}), scope, windows: entry.windows,
    provider: { ...CODEX_ANALYSIS_PROVIDER, counter: CODEX_COUNTERS[minutes].id,
      counters: CODEX_WINDOW_MINUTES.map(value => CODEX_COUNTERS[value]), counter_reason: null },
  } satisfies CodexCapacityReport, { headers: entry.stale ? { "X-Analysis": "stale", "Cache-Control": "no-store" } : { "X-Analysis": "stored" } });
}
