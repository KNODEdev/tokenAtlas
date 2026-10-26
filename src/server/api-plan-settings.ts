import {finalContextResponse} from "./codex-context-final-read";
import {contextRequested,type JsonResponse} from "./codex-context-preview";
import type { CapacityRegime, PlansConfig } from "./plans";
import type { PeriodIndex, DatedPeriod } from "./account-periods";
import { catalogPlanPrice, capacityRegimesFor, plansPath, savePlans, capacityRegimeFingerprint, replaceCapacityRegimes, validatePlans, resolveCapacityRegime } from "./plans";
import type { AppContext, SubscriptionAccount } from "./app-context-types";
import { planPeriodIndex } from "./account-periods";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { isValidDateString } from "./api-request-params";
import { catalogPath, prepareLocalCatalogWrite, loadPublishedCatalog, savePlansCatalog, stripDefaultReferences, catalogWritePath, loadPlansCatalog } from "./plans-catalog";
import type { CyclesConfig } from "./cycles";
import { findCadenceSegments } from "./cycles";
import type { PlanWindowObservation } from "./plan-capacity-contracts";
import { readPreparedProbeAccountHistory, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { normEraVendor } from "./eras";
import { collectPlanWindowObservations } from "./plan-capacity-observations";
import { buildPlanCapacity } from "./plan-capacity";

/** The plan an account's plan periods give on a day, as Subscriptions reads its price and calibration. */
interface PlanOnDay {
  /** Canonical plan value of the covering period, e.g. "pro", "max-5x". */
  plan: string | null;
  /** The catalog plan it names (the Account periods rule); null when the catalog does not know it. */
  plan_id: string | null;
  /** `gap`: between two plan periods; `uncovered`: before the first or after the last; `none`: no plan periods. */
  basis: "declared" | "observed" | "gap" | "uncovered" | "none";
  /** Bounds of the covering period, or of the hole around the day. */
  from: string | null;
  until: string | null;
}

interface PlanSettingRow {
  subscription: string;
  vendor: string;
  account: string | null;
  fallback_usd_per_month: number | null;
  plan_on_day: PlanOnDay;
  capacity_regimes: CapacityRegime[];
}

function planOnDay(ctx: AppContext, index: PeriodIndex | null, vendor: string, subscription: string, asOf: string): PlanOnDay {
  const periods = index?.periodsOf(vendor, subscription) ?? [];
  if (!index || periods.length === 0) return { plan: null, plan_id: null, basis: "none", from: null, until: null };
  // The plan in force at the end of the day, as leverage reads "the plan on a day".
  const at = `${asOf}T23:59:59.999Z`;
  const resolved = index.resolve(vendor, subscription, at);
  if (resolved.value !== null && resolved.basis !== "direct") {
    return { plan: resolved.value, plan_id: catalogPlanPrice(ctx.plansCatalog, vendor, resolved.value, asOf)?.plan_id ?? null, basis: resolved.basis,
      from: resolved.period?.from ?? null, until: resolved.period?.until ?? null };
  }
  const atMs = Date.parse(at);
  const before = periods.filter((period) => period.until !== null && Date.parse(period.until) <= atMs)
    .map((period) => period.until!).sort().at(-1) ?? null;
  const after = periods.filter((period) => Date.parse(period.from) > atMs).map((period) => period.from).sort()[0] ?? null;
  return { plan: null, plan_id: null, basis: resolved.basis === "gap" ? "gap" : "uncovered", from: before, until: after };
}

function planSettingRows(ctx: AppContext, asOf = new Date().toISOString().slice(0, 10)): PlanSettingRow[] {
  const ids = new Map<string, string>();
  const accounts = new Map<string, SubscriptionAccount>();
  for (const account of ctx.accounts.subscriptions || []) {
    const id = account.id.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (ids.has(key)) continue;
    ids.set(key, id);
    accounts.set(key, account);
  }
  const cardSubs = ctx.rateCards.subscriptions || {};
  const rates = new Map(
    Object.entries(cardSubs).map(([id, rate]) => [id.toLowerCase(), rate] as const),
  );
  let index: PeriodIndex | null = null;
  try { index = planPeriodIndex(loadPeriods(ctx.sqlite, PLAN_PERIODS)); }
  catch (error) { console.warn("[plans] plan periods unreadable:", error instanceof Error ? error.message : error); }
  const rows: PlanSettingRow[] = [];
  for (const [key, id] of ids) {
    const account = accounts.get(key);
    const raw = account?.vendor?.trim().toLowerCase() ?? "";
    const vendor = raw === "anthropic" ? "claude" : raw === "openai" ? "codex" : raw;
    const rate = rates.get(key);
    rows.push({
      subscription: id,
      vendor,
      account: account?.account?.trim() || null,
      fallback_usd_per_month: rate?.usd_per_month ?? null,
      plan_on_day: planOnDay(ctx, index, vendor, id, asOf),
      capacity_regimes: capacityRegimesFor(ctx.plans, id),
    });
  }
  return rows.sort((a, b) => a.subscription.localeCompare(b.subscription));
}

export function handlePlans(ctx: AppContext, url?: URL): Response {
  const asOf = url?.searchParams.get("as_of") ?? undefined;
  if (asOf !== undefined && !isValidDateString(asOf)) {
    return Response.json({ error: "as_of must be YYYY-MM-DD" }, { status: 400 });
  }
  return Response.json({
    path: plansPath(),
    rows: planSettingRows(ctx, asOf),
  });
}

interface PlanSaveBody {
  subscription?: string;
  capacity_regimes?: Array<{
    id: string;
    factor: number;
    from?: string | null;
    until?: string | null;
    plan_id?: string | null;
    window_kind?: string | null;
    source?: CapacityRegime["source"];
    source_url?: string | null;
    confirmed?: boolean;
    enabled?: boolean;
    note?: string | null;
  }>;
  expected_capacity_regimes?: CapacityRegime[];
}

export async function handlePlansSave(ctx: AppContext, req: Request, persist = (next: PlansConfig) => savePlans(undefined, next)): Promise<Response> {
  let body: PlanSaveBody;
  try {
    body = (await req.json()) as PlanSaveBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || (body.subscription != null && typeof body.subscription !== "string")) {
    return Response.json({ error: "Invalid subscription settings" }, { status: 400 });
  }
  const subscription = body.subscription?.trim();
  if (!subscription) {
    return Response.json({ error: "potrzebne `subscription`" }, { status: 400 });
  }
  // Plan stages are retired (27.09): plan history is edited in Account periods, prices in the Plans catalog.
  if (["segments", "clear"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    return Response.json({ error: "Plan stages are retired; declare plan history in Account periods. / Etapy planu wycofano; historię planu deklaruj w Okresach kont." }, { status: 400 });
  }
  const validRows = (value: unknown): value is CapacityRegime[] => Array.isArray(value) && value.every(r =>
    r && typeof r === "object" && typeof r.id === "string" && typeof r.factor === "number" &&
    ["from", "until", "plan_id", "window_kind", "source", "note", "source_url"].every(k => r[k] == null || typeof r[k] === "string") &&
    ["enabled", "confirmed"].every(k => r[k] == null || typeof r[k] === "boolean"));
  if (!validRows(body.capacity_regimes)) return Response.json({ error: "Invalid capacity periods" }, { status: 400 });
  if (body.expected_capacity_regimes !== undefined) {
    if (!validRows(body.expected_capacity_regimes)) return Response.json({ error: "Invalid previous capacity periods" }, { status: 400 });
    if (capacityRegimeFingerprint(capacityRegimesFor(ctx.plans, subscription)) !== capacityRegimeFingerprint(body.expected_capacity_regimes)) {
      return Response.json({ error: "Capacity periods changed in another editor. Reload settings before saving. / Okresy zmieniono w innym edytorze. Odśwież ustawienia przed zapisem." }, { status: 409 });
    }
  }
  const next = replaceCapacityRegimes(
    ctx.plans,
    subscription,
    body.capacity_regimes.map((regime) => ({ ...regime, subscription })),
  );
  const errors = validatePlans(next);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  try {
    persist(next);
  } catch (e) {
    return Response.json({ error: `zapis ${plansPath()} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  ctx.plans = next;
  return Response.json({ ok: true, rows: planSettingRows(ctx) });
}

export function handlePlansCatalog(ctx: AppContext): Response {
  return Response.json({
    path: catalogPath(),
    catalog: ctx.plansCatalog,
  });
}

function cadenceKindAliases(kind: string): Set<string> {
  const lower = kind.toLowerCase();
  if (["weekly", "weekly_all", "weekly_scoped", "seven_day"].includes(lower)) {
    return new Set(["weekly", "weekly_all", "weekly_scoped", "seven_day"]);
  }
  if (["5h", "session", "five_hour"].includes(lower)) {
    return new Set(["5h", "session", "five_hour"]);
  }
  return new Set([lower]);
}

function cyclesSnapshotForDay(cfg: CyclesConfig, aliases: Set<string>, day: string): CyclesConfig {
  const windows = (cfg.windows || []).flatMap((row) => {
    if (!aliases.has(row.kind.toLowerCase())) return [row];
    const segments = findCadenceSegments(cfg, row.subscription, row.kind);
    const covering = segments.filter((seg) => seg.from == null || seg.from <= day).at(-1);
    if (!covering) return [];
    return [{
      subscription: row.subscription,
      kind: row.kind,
      period_hours: covering.period_hours,
      anchor_ts: covering.anchor_ts ?? null,
      history_windows: covering.history_windows ?? null,
      note: covering.note ?? null,
    }];
  });
  return { ...cfg, windows };
}

function cadenceDayInsidePlanObservation(
  ctx: AppContext,
  aliases: Set<string>,
  observation: PlanWindowObservation
): string {
  let latestSample: string | null = null;
  if (observation.subscription_id) {
    const prepared = readPreparedProbeAccountHistory(ctx.sqlite, normEraVendor(observation.provider_alias),
      observation.subscription_id, observation.start_ts, observation.end_ts);
    if (!prepared) throw new ProbeAccountIndexUnavailable();
    latestSample = prepared.rows.filter(row => aliases.has(row.kind.toLowerCase())
      && row.kind !== "error" && (row.ok == null || row.ok === 1))
      .sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)[0]?.ts ?? null;
  }
  const resetMs = Date.parse(observation.end_ts);
  const sampleMs = latestSample == null ? NaN : Date.parse(latestSample);
  const insideMs = Number.isFinite(sampleMs) && (!Number.isFinite(resetMs) || sampleMs < resetMs)
    ? sampleMs
    : resetMs - 1;
  return Number.isFinite(insideMs)
    ? new Date(insideMs).toISOString().slice(0, 10)
    : observation.start_ts.slice(0, 10);
}

export function collectVersionedPlanWindowObservations(
  ctx: AppContext,
  query: { provider: string; plan_id: string; window_kind: string }
): PlanWindowObservation[] {
  const aliases = cadenceKindAliases(query.window_kind);
  const cuts = [...new Set(
    (ctx.cycles.windows || [])
      .filter((row) => aliases.has(row.kind.toLowerCase()))
      .flatMap((row) => findCadenceSegments(ctx.cycles, row.subscription, row.kind))
      .map((seg) => seg.from)
      .filter((from): from is string => from != null)
  )].sort();
  const starts: Array<string | null> = [null, ...cuts];
  const out = new Map<string, PlanWindowObservation>();
  let planPeriods: DatedPeriod[] = [];
  try { planPeriods = loadPeriods(ctx.sqlite, PLAN_PERIODS); }
  catch (error) { console.warn("[plan-capacity] plan periods unreadable; no plan resolves:", error instanceof Error ? error.message : error); }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1] ?? null;
    const day = start ?? "0001-01-01";
    const observations = collectPlanWindowObservations(
      { ...ctx, cycles: cyclesSnapshotForDay(ctx.cycles, aliases, day), planPeriods },
      query
    );
    for (const observation of observations) {
      const cadenceDay = cadenceDayInsidePlanObservation(ctx, aliases, observation);
      if (start != null && cadenceDay < start) continue;
      if (end != null && cadenceDay >= end) continue;
      const subscription = observation.subscription_id;
      if (subscription) {
        const startDay = observation.start_ts.slice(0, 10);
        const endMs = Date.parse(observation.end_ts);
        const inclusiveEndDay = Number.isFinite(endMs)
          ? new Date(Math.max(Date.parse(observation.start_ts) || endMs, endMs - 1)).toISOString().slice(0, 10)
          : startDay;
        const checkDays = new Set<string>([startDay, inclusiveEndDay]);
        for (const regime of capacityRegimesFor(ctx.plans, subscription)) {
          if (regime.from && regime.from >= startDay && regime.from <= inclusiveEndDay) checkDays.add(regime.from);
          if (regime.until) {
            const afterMs = Date.parse(`${regime.until}T00:00:00Z`) + 86_400_000;
            if (Number.isFinite(afterMs)) {
              const after = new Date(afterMs).toISOString().slice(0, 10);
              if (after >= startDay && after <= inclusiveEndDay) checkDays.add(after);
            }
          }
        }
        const capacityStates = [...checkDays].map((capacityDay) => resolveCapacityRegime(ctx.plans, {
          subscription,
          day: capacityDay,
          plan_id: observation.plan_id,
          window_kind: observation.window_kind,
        }));
        const capacityKeys = new Set(capacityStates.map((state) => `${state.id ?? "base"}\u0000${state.factor}`));
        if (capacityKeys.size > 1) {
          observation.exclusion_reason = observation.exclusion_reason ?? "cross_capacity_regime_unattributable";
        } else {
          observation.capacity_factor = capacityStates[0]?.factor ?? 1;
          observation.capacity_regime_id = capacityStates[0]?.id ?? null;
        }
      }
      const key = `${observation.window_id}\u0000${observation.start_ts}\u0000${observation.end_ts}`;
      out.set(key, observation);
    }
  }
  return [...out.values()].sort(
    (a, b) => a.end_ts.localeCompare(b.end_ts) || a.window_id.localeCompare(b.window_id)
  );
}

export function handlePlanCapacity(ctx: AppContext, url: URL): Response {
 return finalContextResponse(ctx.sqlite,contextRequested(url)&&["codex","openai"].includes(url.searchParams.get("provider")??""),
  (db,json)=>planCapacityBody({...ctx,sqlite:db},url,json),{catalog:ctx.plansCatalog,plan:true,source:"plan"});
}
function planCapacityBody(ctx:AppContext,url:URL,json:JsonResponse):Response {
  const provider = url.searchParams.get("provider")?.trim() ?? "";
  const planId = url.searchParams.get("plan_id")?.trim() ?? "";
  const windowKind = url.searchParams.get("window_kind")?.trim() ?? "";
  const asOf = url.searchParams.get("as_of")?.trim() || new Date().toISOString().slice(0, 10);
  if (!provider || !planId || !windowKind) {
    return json({ error: "potrzebne `provider`, `plan_id` i `window_kind`" }, { status: 400 });
  }
  const observations = collectVersionedPlanWindowObservations(ctx, {
    provider,
    plan_id: planId,
    window_kind: windowKind,
  });
  return json(
    buildPlanCapacity({
      catalog: ctx.plansCatalog,
      rateCard: ctx.rateCards,
      observations,
      provider,
      plan_id: planId,
      window_kind: windowKind,
      as_of: asOf,
    })
  );
}

export async function handlePlansCatalogSave(ctx: AppContext, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const incoming = asRecord(body)?.catalog ?? body;
  const prepared = prepareLocalCatalogWrite(incoming, loadPublishedCatalog());
  if (!prepared.ok) return Response.json({ error: prepared.error }, { status: 400 });
  try {
    savePlansCatalog(undefined, stripDefaultReferences(prepared.catalog));
  } catch (e) {
    return Response.json(
      { error: `zapis ${catalogWritePath()} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
  ctx.plansCatalog = loadPlansCatalog();
  return handlePlansCatalog(ctx);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
