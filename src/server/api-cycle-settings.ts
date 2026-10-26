import { MIN_HISTORY_PERIOD_HOURS, resolveCadence, DEFAULT_HISTORY_WINDOWS, anchoredWindows, findCycleRow, cyclesPath, removeCycleHistory, validateCadenceHistoryInput, replaceCadenceHistory, isStrictIsoInstant, upsertCycleRow, validateCycles, saveCycles, cyclesWritePath } from "./cycles";
import type { ObservedCadence, CadenceSegmentInput, CyclesConfig } from "./cycles";
import { readPreparedProbeCadences, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { railWindowHours } from "./claude-declared-windows";
import { windowFromReset } from "../providers/core/limit";
import type { AppContext } from "./app-context-types";
import { preparingDataResponse } from "./preparing-response";

const CYCLE_KIND_LABELS: Record<string, string> = {
  weekly_all: "tydzień · całe konto",
  weekly_scoped: "tydzień · sub-limit modelu",
  weekly: "tydzień",
  session: "sesja",
  five_hour: "okno 5 h",
  primary: "gauge · primary",
  secondary: "gauge · secondary",
  rolling: "okno kroczące",
};

export interface CadenceSegmentRow {
  from: string | null;
  period_hours: number;
  period_source: string;
  anchor_ts: string | null;
  anchor_source: string;
  history_windows?: number | null;
  note?: string | null;
  source: string;
  declaration: boolean;
}

export interface CycleSettingRow {
  subscription: string;
  vendor: string;
  kind: string;
  label: string;
  period_hours: number | null;
  period_source: string;
  anchor_ts: string | null;
  anchor_source: string;
  history_windows: number;
  history_source: string;
  window_start: string | null;
  next_reset: string | null;
  history_available: number;
  editable: { period: boolean; anchor: boolean; history: boolean };
  declaration_editable: boolean;
  effect: string;
  declared: boolean;
  note: string | null;
  segments: CadenceSegmentRow[];
}

function cycleEditability(provider: string, kind: string, periodHours: number | null): {
  editable: { period: boolean; anchor: boolean; history: boolean };
  effect: string;
} {
  if (provider === "codex") {
    return {
      editable: { period: false, anchor: false, history: false },
      effect:
        "Codex podaje procent w każdej odpowiedzi, więc jego cykle są MIERZONE - granice okien wychodzą z serii próbek, nie z deklaracji. Korekta rytmu nie miałaby tu czego poprawić.",
    };
  }
  if (provider === "grok") {
    return {
      editable: { period: true, anchor: false, history: false },
      effect:
        "xAI nie podaje kotwicy resetu, więc okno jest kroczące - okres zmienia jego długość. Kotwica i historia czekają na pierwszy znany reset; do tego czasu wpisanie ich udawałoby wiedzę, której nie ma.",
    };
  }
  const shortWindow = periodHours != null && periodHours < MIN_HISTORY_PERIOD_HOURS;
  if (provider === "claude" && !shortWindow) {
    return {
      editable: { period: true, anchor: true, history: true },
      effect:
        "Kotwica i okres wyznaczają granice wszystkich okien wstecz, a zużycie w nich liczy się z indeksu i wycenia kursem punktu z kalibracji. To jedyne miejsce, z którego bierze się historia sprzed pierwszego probe'a.",
    };
  }
  if (shortWindow) {
    return {
      editable: { period: true, anchor: true, history: false },
      effect: `Okres i kotwica korygują granice bieżącego okna oraz tempo. Historii nie odtwarzamy: okno krótsze niż ${MIN_HISTORY_PERIOD_HOURS} h dałoby tysiące wierszy, z których żaden nie niesie odczytu.`,
    };
  }
  return {
    editable: { period: true, anchor: false, history: false },
    effect:
      "Okres koryguje granice bieżącego okna i tempo. Historii wstecz nie ma: dla tego vendora brakuje skali, którą można by zamienić zaindeksowane zużycie na procent okna.",
  };
}

function cycleSettingRows(ctx: AppContext, nowMs = Date.now()): CycleSettingRow[] {
  const nowDay = new Date(nowMs).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const targets: Array<{ provider: string; subject: string; kind: string }> = [];
  const cadences = new Map<string, ObservedCadence>();
  const push = (provider: string, subject: string, kind: string) => {
    const key = `${subject.toLowerCase()}/${kind.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ provider, subject, kind });
  };
  const prepared = readPreparedProbeCadences(ctx.sqlite);
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  for (const row of prepared) {
    push(row.provider, row.account, row.kind);
    cadences.set(`${row.provider}\0${row.account}\0${row.kind}`, {
      periodHours: railWindowHours(row.provider, row.kind, row.latest?.window_minutes as number | null ?? null),
      anchorIso: row.latest?.resets_at as string | null ?? null,
      source: "probe",
    });
  }
  const grokId = ctx.grokGauge.store || ctx.grokGauge.subscription || "grok";
  if ((ctx.sqlite.query(`SELECT 1 AS found FROM grok_events LIMIT 1`).get() as { found: number } | null)) {
    push("grok", grokId, "rolling");
  }
  for (const row of ctx.cycles.windows || []) push("?", row.subscription, row.kind);
  const vendorOf = (provider: string, subject: string): string => {
    if (provider !== "?") return provider;
    return ctx.accounts.subscriptions?.find((s) => s.id.toLowerCase() === subject.toLowerCase())?.vendor ?? "?";
  };
  const out: CycleSettingRow[] = [];
  for (const target of targets) {
    const vendor = vendorOf(target.provider, target.subject);
    const observed =
      target.provider === "?"
        ? { periodHours: null, anchorIso: null }
        : target.provider === "grok"
          ? { periodHours: ctx.grokGauge.window_hours ?? 168, anchorIso: null, source: "declared" as const }
          : cadences.get(`${target.provider}\0${target.subject.toLowerCase()}\0${target.kind}`)
            ?? { periodHours: railWindowHours(target.provider, target.kind, null), anchorIso: null, source: "probe" as const };
    const cadence = resolveCadence(ctx.cycles, target.subject, target.kind, observed, nowDay);
    const timing =
      cadence.periodHours != null && cadence.anchorIso != null
        ? windowFromReset(cadence.anchorIso, cadence.periodHours, nowMs)
        : null;
    const { editable, effect } = cycleEditability(vendor, target.kind, cadence.periodHours);
    const earliest =
      vendor === "claude"
        ? (ctx.sqlite.query(`SELECT min(ts) AS ts FROM claude_events`).get() as { ts: string | null } | null)?.ts ?? null
        : null;
    const declaredSegments: CadenceSegmentRow[] = (cadence.segments ?? []).map((s) => ({
      from: s.from,
      period_hours: s.period_hours,
      period_source: s.source ?? "declared",
      anchor_ts: s.anchor_ts ?? (s.legacy_origin ? observed.anchorIso : null),
      anchor_source: s.anchor_ts
        ? (s.source ?? "declared")
        : s.legacy_origin && observed.anchorIso
          ? (observed.source ?? "probe")
          : "none",
      history_windows: s.history_windows ?? null,
      note: s.note ?? null,
      source: s.source ?? "declared",
      declaration: true,
    }));
    const observedSource = observed.source ?? "probe";
    const observedFallback: CadenceSegmentRow | null = observed.periodHours != null
      ? {
          from: null,
          period_hours: observed.periodHours,
          period_source: observedSource,
          anchor_ts: observed.anchorIso,
          anchor_source: observed.anchorIso ? observedSource : "none",
          history_windows: DEFAULT_HISTORY_WINDOWS,
          note: "Fallback obowiązujący tam, gdzie żaden datowany segment deklaracji nie pokrywa dnia.",
          source: observedSource,
          declaration: false,
        }
      : null;
    const declarationCoversOrigin = declaredSegments.some((segment) => segment.from == null);
    const segments: CadenceSegmentRow[] = [
      ...(!declarationCoversOrigin && observedFallback ? [observedFallback] : []),
      ...declaredSegments,
    ];
    out.push({
      subscription: target.subject,
      vendor,
      kind: target.kind,
      label: CYCLE_KIND_LABELS[target.kind] ?? target.kind,
      period_hours: cadence.periodHours,
      period_source: cadence.periodSource,
      anchor_ts: cadence.anchorIso,
      anchor_source: cadence.anchorSource,
      history_windows: cadence.historyWindows,
      history_source: cadence.historySource,
      window_start: timing?.windowStart ?? null,
      next_reset: timing?.resetAt ?? null,
      history_available: editable.history
        ? anchoredWindows(cadence, {
            nowMs,
            earliestMs: earliest ? Date.parse(earliest) : null,
            limit: cadence.historyWindows,
          }).length
        : 0,
      editable,
      declaration_editable: true,
      effect,
      declared: findCycleRow(ctx.cycles, target.subject, target.kind) != null,
      note: cadence.note,
      segments,
    });
  }
  return out.sort(
    (a, b) => a.vendor.localeCompare(b.vendor) || a.subscription.localeCompare(b.subscription) || a.kind.localeCompare(b.kind)
  );
}

export function handleCycles(ctx: AppContext, opts?: { rootDir?: string; nowMs?: number }): Response {
  return Response.json({
    path: cyclesPath(opts?.rootDir),
    default_history_windows: DEFAULT_HISTORY_WINDOWS,
    min_history_period_hours: MIN_HISTORY_PERIOD_HOURS,
    rows: cycleSettingRows(ctx, opts?.nowMs),
  });
}

interface CycleSaveBody {
  subscription?: string;
  kind?: string;
  from?: string | null;
  period_hours?: number | null;
  anchor_ts?: string | null;
  history_windows?: number | null;
  note?: string | null;
  segments?: CadenceSegmentInput[];
  clear?: boolean;
}

export async function handleCyclesSave(
  ctx: AppContext,
  req: Request,
  opts?: { rootDir?: string; nowMs?: number }
): Promise<Response> {
  let body: CycleSaveBody;
  try {
    body = (await req.json()) as CycleSaveBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const subscription = body.subscription?.trim();
  const kind = body.kind?.trim();
  if (!subscription || !kind) {
    return Response.json({ error: "potrzebne `subscription` i `kind`" }, { status: 400 });
  }
  let next: CyclesConfig;
  if (body.clear) {
    next = removeCycleHistory(ctx.cycles, subscription, kind);
  } else if (Array.isArray(body.segments)) {
    const inputErrors = validateCadenceHistoryInput(subscription, kind, body.segments);
    if (inputErrors.length) {
      return Response.json({ error: inputErrors.join("; ") }, { status: 400 });
    }
    next = replaceCadenceHistory(ctx.cycles, subscription, kind, body.segments);
  } else {
    let anchorIso: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(body, "anchor_ts")) {
      if (body.anchor_ts == null || body.anchor_ts === "") {
        anchorIso = null;
      } else if (!isStrictIsoInstant(body.anchor_ts)) {
        return Response.json(
          { error: `${subscription}/${kind}: anchor_ts '${body.anchor_ts}' nie jest poprawną datą ISO` },
          { status: 400 }
        );
      } else {
        anchorIso = new Date(Date.parse(body.anchor_ts)).toISOString();
      }
    }
    next = upsertCycleRow(ctx.cycles, {
      subscription,
      kind,
      ...(Object.prototype.hasOwnProperty.call(body, "period_hours")
        ? { period_hours: body.period_hours }
        : {}),
      ...(anchorIso !== undefined ? { anchor_ts: anchorIso } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "history_windows")
        ? { history_windows: body.history_windows }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "note") ? { note: body.note } : {}),
    });
  }
  const errors = validateCycles(next);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  try {
    saveCycles(opts?.rootDir, next);
  } catch (e) {
    return Response.json(
      { error: `zapis ${cyclesWritePath(opts?.rootDir)} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
  ctx.cycles = next;
  try { return Response.json({ ok: true, rows: cycleSettingRows(ctx, opts?.nowMs) }); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return preparingDataResponse();
    throw error;
  }
}
