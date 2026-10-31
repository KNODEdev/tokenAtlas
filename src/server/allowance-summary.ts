import type { AppContext } from "./app-context-types";
import type { CapacityCyclesEntry, CapacityCyclesResponse } from "../shared/capacity-cycles";
import { CODEX_COUNTERS } from "../shared/codex-counters";
import { WEEKLY_MINUTES } from "../shared/capacity-value";
import { resolvePlanFacts } from "../shared/plan-catalog";
import { ALLOWANCE_UNITS, allowanceHeadline, allowanceRatios, summarizeAllowance, type AllowanceCandidate, type AllowanceCandidatesResponse,
  type AllowanceSide, type AllowanceSideState, type AllowanceSummaryResponse, type AllowanceUnit } from "../shared/allowance-summary";
import { handleCapacityCycles } from "./capacity-cycles";
import { capacityCycleSubjects } from "./capacity-cycle-producer";
import { counterFitsPlan, countersOf, mainCounterOf } from "./main-counter";
import { loadPlans } from "./plans";
import { loadPlansCatalog } from "./plans-catalog";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) => DAY.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const bad = (error: string) => Response.json({ error }, { status: 400 });
const CODEX_WEEKLY = CODEX_COUNTERS[WEEKLY_MINUTES].id;

/** The account's main weekly counter on a paid plan: never a scoped sub-limit, never a longer Free meter. */
function mainWeeklyCounter(ctx: AppContext, provider: string, account: string): string | null {
  if (provider === "codex") return CODEX_WEEKLY;
  const weekly = countersOf(ctx.sqlite, provider, account).filter(c => c.minutes === WEEKLY_MINUTES);
  return (mainCounterOf(weekly.filter(c => counterFitsPlan(c, false))) ?? mainCounterOf(weekly))?.id ?? null;
}
function weeklyCounters(ctx: AppContext, provider: string, account: string): string[] {
  return provider === "codex" ? [CODEX_WEEKLY] : countersOf(ctx.sqlite, provider, account).filter(c => c.minutes === WEEKLY_MINUTES).map(c => c.id);
}
/** Stored cycles of the weekly counter through the capacity comparison read, the last published ones while updating. */
async function weeklyEntries(ctx: AppContext, url: URL, since: string, until: string, account?: string): Promise<CapacityCyclesEntry[]> {
  const request = new URL("/api/capacity-cycles", url);
  for (const [key, value] of Object.entries({ since, until, window_minutes: String(WEEKLY_MINUTES) })) request.searchParams.set(key, value);
  const response = handleCapacityCycles(ctx, request, { ...(account ? { account } : {}), allowStale: true });
  if (response.status !== 200) throw new Error(((await response.json()) as { error?: string }).error ?? `capacity cycles ${response.status}`);
  return ((await response.json()) as CapacityCyclesResponse).accounts;
}
function stateOf(entry: CapacityCyclesEntry | undefined): AllowanceSideState {
  return !entry || entry.unavailable ? "unavailable" : entry.error ? "error" : entry.preparing ? "preparing" : entry.stale ? "updating" : "current";
}

/**
 * What one allowance buys, month by month, for one or two (account, counter) sides (UR-014 REQ-060), or with
 * `candidates=1` the subscriptions a reader can choose from. Reads the stored cycle register only: no event is priced
 * or scanned and no work is queued; while the producer recalculates, the last published cycles answer as `updating`.
 */
export async function handleAllowanceSummary(ctx: AppContext, url: URL, now = Date.now()): Promise<Response> {
  ctx = { ...ctx, plans: ctx.plans ?? loadPlans(), plansCatalog: ctx.plansCatalog ?? loadPlansCatalog() };
  const readAt = new Date(now).toISOString();
  const subjects = capacityCycleSubjects(ctx);
  if (url.searchParams.get("candidates") === "1") return candidates(ctx, url, subjects, readAt, now);

  const since = url.searchParams.get("since") ?? "", until = url.searchParams.get("until") ?? "";
  if (!validDay(since) || !validDay(until) || since > until) return bad("Expected since and until as YYYY-MM-DD");
  const unit = (url.searchParams.get("unit") ?? "api_standard") as AllowanceUnit;
  if (!ALLOWANCE_UNITS.includes(unit)) return bad("Expected unit api_standard or tokens");
  const picks: Array<{ account: string; counter: string | null }> = [];
  for (const side of ["a", "b"] as const) {
    const account = url.searchParams.get(side)?.trim().toLowerCase();
    if (!account) { if (side === "a") return bad("Expected a subscription in a"); continue; }
    const provider = subjects.get(account);
    if (!provider) return bad(`Unknown subscription ${account}`);
    const asked = url.searchParams.get(`${side}_counter`);
    const counter = asked ?? mainWeeklyCounter(ctx, provider, account);
    if (!counter) return bad(`No weekly counter for ${account}`);
    if (asked !== null && !weeklyCounters(ctx, provider, account).includes(asked)) return bad(`${account} has no weekly counter ${asked}`);
    picks.push({ account, counter });
  }
  if (picks.length === 2 && picks[0]!.account === picks[1]!.account && picks[0]!.counter === picks[1]!.counter)
    return bad("Expected two different sides");

  const sides: AllowanceSide[] = [];
  for (const pick of picks) {
    const provider = subjects.get(pick.account)!;
    const rows = (await weeklyEntries(ctx, url, since, until, pick.account)).filter(row => row.provider === provider);
    // Before any cycle is published a provider answers once for the account, without a counter.
    const entry = rows.find(row => row.counter === pick.counter) ?? rows.find(row => row.counter === "");
    const state = stateOf(entry);
    const published = state === "current" || state === "updating";
    sides.push({ provider, account: pick.account, counter: pick.counter!, counter_label: entry?.counter_label ?? "", state,
      ...(entry?.error ? { error: entry.error } : {}),
      summary: published ? summarizeAllowance(entry!.windows, { asOf: readAt, since, until }) : null });
  }
  const [a, b] = sides;
  const ratios = a?.summary && b?.summary ? allowanceRatios(a.summary, b.summary, unit) : [];
  return Response.json({ since, until, unit, read_at: readAt, sides, ratios, headline: allowanceHeadline(ratios) } satisfies AllowanceSummaryResponse,
    { headers: sides.some(side => side.state === "updating") ? { "X-Analysis": "stale", "Cache-Control": "no-store" } : { "X-Analysis": "stored" } });
}

async function candidates(ctx: AppContext, url: URL, subjects: Map<string, string>, readAt: string, now: number): Promise<Response> {
  const since = dayOf(now - 31 * 86_400_000), until = dayOf(now), from = Date.parse(`${since}T00:00:00Z`);
  const entries = await weeklyEntries(ctx, url, since, until);
  const list: AllowanceCandidate[] = [];
  for (const [account, provider] of subjects) {
    if (account.endsWith("::business")) continue;
    const counter = mainWeeklyCounter(ctx, provider, account);
    if (!counter) continue;
    const rows = entries.filter(row => row.account === account && row.provider === provider);
    const entry = rows.find(row => row.counter === counter) ?? rows.find(row => row.counter === "");
    const windows = entry?.windows ?? [];
    const latest = [...windows].sort((x, y) => Date.parse(y.cycle_start ?? y.start) - Date.parse(x.cycle_start ?? x.start))[0];
    const plan = latest?.plan ?? null;
    list.push({ provider, account, counter, counter_label: entry?.counter_label ?? "", state: stateOf(entry), plan,
      plan_label: latest?.plan_detail?.label ?? plan,
      usd_per_month: plan ? resolvePlanFacts(ctx.plansCatalog, provider, plan, until).usd_per_month : null,
      recent_cycles: windows.filter(window => Date.parse(window.cycle_start ?? window.start) >= from).length });
  }
  return Response.json({ read_at: readAt, candidates: list } satisfies AllowanceCandidatesResponse);
}
