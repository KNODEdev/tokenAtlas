import fs from "fs";
import path from "path";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { configFile, configWriteTarget } from "../config/paths";
import { HOUR_MS } from "../providers/core/limit";
export type CadenceSource = "declared" | "probe" | "default" | "none";
export interface CadenceSegment {
  from: string | null;
  period_hours: number;
  anchor_ts?: string | null;
  history_windows?: number | null;
  note?: string | null;
  source?: CadenceSource;
  legacy_origin?: true;
}
export interface CadenceSegmentInput {
  from?: unknown;
  period_hours?: unknown;
  anchor_ts?: unknown;
  history_windows?: unknown;
  note?: unknown;
  source?: unknown;
}
export interface CycleWindowConfig {
  subscription: string;
  kind: string;
  period_hours?: number | null;
  anchor_ts?: string | null;
  history_windows?: number | null;
  note?: string | null;
  segments?: CadenceSegment[];
}
export interface CyclesConfig {
  _comment?: string[];
  windows?: CycleWindowConfig[];
}
const FILE = "cycles.json";
export const DEFAULT_HISTORY_WINDOWS = 40;
export const MIN_HISTORY_PERIOD_HOURS = 24;
export function cyclesPath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configFile(FILE);
}
export function cyclesWritePath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configWriteTarget(FILE);
}
export function loadCycles(rootDir?: string): CyclesConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(cyclesPath(rootDir), "utf-8")) as CyclesConfig;
    return { ...parsed, windows: Array.isArray(parsed.windows) ? parsed.windows : [] };
  } catch {
    return { windows: [] };
  }
}
export function saveCycles(rootDir: string | undefined, cfg: CyclesConfig): void {
  atomicArchiveWrite(cyclesWritePath(rootDir), JSON.stringify(cfg, null, 2) + "\n");
}
const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
export function isStrictCalendarDay(val: unknown): val is string {
  if (typeof val !== "string" || !CALENDAR_DAY_RE.test(val)) return false;
  const [yStr, mStr, dStr] = val.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}
export function isStrictIsoInstant(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const match = ISO_INSTANT_RE.exec(val);
  if (!match || !isStrictCalendarDay(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[7] == null ? 0 : Number(match[7]);
  const offsetMinute = match[8] == null ? 0 : Number(match[8]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const ms = Date.parse(val);
  return Number.isFinite(ms);
}
export function segmentsForCadence(window: CycleWindowConfig | null | undefined): CadenceSegment[] {
  if (!window) return [];
  if (Array.isArray(window.segments)) {
    return window.segments.map((segment) => ({ ...segment, source: "declared" as const })).sort((a, b) => {
      if (a.from == null && b.from == null) return 0;
      if (a.from == null) return -1;
      if (b.from == null) return 1;
      return a.from.localeCompare(b.from);
    });
  }
  if (window.period_hours != null && Number.isFinite(window.period_hours) && window.period_hours > 0) {
    const segment: CadenceSegment = {
      from: null,
      period_hours: window.period_hours,
      anchor_ts: window.anchor_ts ?? null,
      history_windows: window.history_windows ?? null,
      note: window.note ?? null,
      source: "declared",
    };
    Object.defineProperty(segment, "legacy_origin", { value: true, enumerable: false });
    return [segment];
  }
  return [];
}
export function findCycleRow(cfg: CyclesConfig, subscription: string, kind: string): CycleWindowConfig | null {
  const s = subscription.toLowerCase();
  const k = kind.toLowerCase();
  const found = (cfg.windows || []).find(
    (row) => row.subscription.toLowerCase() === s && row.kind.toLowerCase() === k
  );
  if (!found) return null;
  if (found.period_hours == null && Array.isArray(found.segments) && found.segments.length > 0) {
    const sorted = segmentsForCadence(found);
    const latest = sorted[sorted.length - 1];
    return {
      ...found,
      period_hours: latest?.period_hours ?? null,
      anchor_ts: latest?.anchor_ts ?? null,
      history_windows: latest?.history_windows ?? null,
      note: latest?.note ?? null,
    };
  }
  return found;
}
export function findCadenceSegments(cfg: CyclesConfig, subscription: string, kind: string): CadenceSegment[] {
  const row = findCycleRow(cfg, subscription, kind);
  return segmentsForCadence(row);
}
export function validateCycles(cfg: CyclesConfig): string[] {
  const errors: string[] = [];
  const seenKeys = new Set<string>();
  for (const row of cfg.windows || []) {
    const sub = (row.subscription || "").trim();
    const kind = (row.kind || "").trim();
    if (!sub || !kind) {
      errors.push("każdy wiersz potrzebuje `subscription` i `kind`");
      continue;
    }
    const key = `${sub.toLowerCase()}/${kind.toLowerCase()}`;
    if (seenKeys.has(key)) {
      errors.push(`zduplikowany wiersz ${sub}/${kind}`);
    }
    seenKeys.add(key);
    if (Array.isArray(row.segments)) {
      const seenFrom = new Set<string>();
      for (const seg of row.segments) {
        if (seg.from === undefined) {
          errors.push(`${sub}/${kind}: każdy segment wymaga jawnego pola 'from'`);
        }
        const fromKey = seg.from == null ? "__ORIGIN__" : seg.from;
        if (seenFrom.has(fromKey)) {
          errors.push(`${sub}/${kind}: zduplikowana granica 'from' '${seg.from ?? "null"}'`);
        }
        seenFrom.add(fromKey);
        if (seg.from != null && !isStrictCalendarDay(seg.from)) {
          errors.push(`${sub}/${kind}: nieprawidłowa data 'from' '${seg.from}'`);
        }
        if (
          seg.period_hours == null ||
          !(Number.isFinite(seg.period_hours) && seg.period_hours > 0 && seg.period_hours <= 24 * 366)
        ) {
          errors.push(`${sub}/${kind}: period_hours musi być z zakresu (0, 8784]`);
        }
        if (!seg.anchor_ts || !isStrictIsoInstant(seg.anchor_ts)) {
          errors.push(`${sub}/${kind}: anchor_ts '${seg.anchor_ts ?? "null"}' nie jest poprawną datą ISO`);
        }
        if (
          seg.history_windows != null &&
          !(Number.isInteger(seg.history_windows) && seg.history_windows >= 0 && seg.history_windows <= 400)
        ) {
          errors.push(`${sub}/${kind}: history_windows musi być liczbą całkowitą z 0..400`);
        }
        if (seg.source != null && seg.source !== "declared") {
          errors.push(`${sub}/${kind}: source nie może być '${seg.source}' w deklaracji`);
        }
      }
    } else {
      if (
        row.period_hours != null &&
        !(Number.isFinite(row.period_hours) && row.period_hours > 0 && row.period_hours <= 24 * 366)
      ) {
        errors.push(`${sub}/${kind}: period_hours musi być z zakresu (0, 8784]`);
      }
      if (row.anchor_ts != null && row.anchor_ts !== "" && !isStrictIsoInstant(row.anchor_ts)) {
        errors.push(`${sub}/${kind}: anchor_ts '${row.anchor_ts}' nie jest poprawną datą ISO`);
      }
      if (
        row.history_windows != null &&
        !(Number.isInteger(row.history_windows) && row.history_windows >= 0 && row.history_windows <= 400)
      ) {
        errors.push(`${sub}/${kind}: history_windows musi być liczbą całkowitą z 0..400`);
      }
    }
  }
  return errors;
}
export function validateCadenceHistoryInput(
  subscription: string,
  kind: string,
  segments: unknown[]
): string[] {
  const rawSegments = segments.map((value) => {
    const seg = value != null && typeof value === "object"
      ? value as CadenceSegmentInput
      : {};
    return {
      from: seg.from,
      period_hours: seg.period_hours,
      anchor_ts: seg.anchor_ts,
      history_windows: seg.history_windows,
      note: seg.note,
      source: seg.source,
    };
  }) as unknown as CadenceSegment[];
  return validateCycles({ windows: [{ subscription, kind, segments: rawSegments }] });
}
export function replaceCadenceHistory(
  cfg: CyclesConfig,
  subscription: string,
  kind: string,
  segments: CadenceSegmentInput[]
): CyclesConfig {
  const s = subscription.toLowerCase();
  const k = kind.toLowerCase();
  const rest = (cfg.windows || []).filter(
    (w) => !(w.subscription.toLowerCase() === s && w.kind.toLowerCase() === k)
  );
  if (segments.length === 0) {
    return { ...cfg, windows: rest };
  }
  const rawSegments: CadenceSegment[] = segments.map((seg) => ({
    from: seg.from as string | null,
    period_hours: seg.period_hours as number,
    anchor_ts: seg.anchor_ts as string,
    history_windows: seg.history_windows == null ? null : seg.history_windows as number,
    note: seg.note == null ? null : seg.note as string,
    source: "declared",
  }));
  rawSegments.sort((a, b) => {
    if (a.from == null && b.from == null) return 0;
    if (a.from == null) return -1;
    if (b.from == null) return 1;
    return a.from.localeCompare(b.from);
  });
  const cleanWindow: CycleWindowConfig = {
    subscription,
    kind,
    segments: rawSegments,
  };
  return { ...cfg, windows: [...rest, cleanWindow] };
}
export function removeCycleHistory(cfg: CyclesConfig, subscription: string, kind: string): CyclesConfig {
  const s = subscription.toLowerCase();
  const k = kind.toLowerCase();
  return {
    ...cfg,
    windows: (cfg.windows || []).filter(
      (w) => !(w.subscription.toLowerCase() === s && w.kind.toLowerCase() === k)
    ),
  };
}
export function removeCycleRow(cfg: CyclesConfig, subscription: string, kind: string): CyclesConfig {
  return removeCycleHistory(cfg, subscription, kind);
}
export function upsertCycleRow(cfg: CyclesConfig, row: CycleWindowConfig): CyclesConfig {
  const s = row.subscription.toLowerCase();
  const k = row.kind.toLowerCase();
  const existing = findCycleRow(cfg, row.subscription, row.kind);
  if (Array.isArray(row.segments)) {
    return replaceCadenceHistory(cfg, row.subscription, row.kind, row.segments);
  }
  if (existing && Array.isArray(existing.segments) && existing.segments.length > 0) {
    const segments = segmentsForCadence(existing);
    const latest = segments[segments.length - 1]!;
    segments[segments.length - 1] = {
      ...latest,
      period_hours: row.period_hours ?? latest.period_hours,
      anchor_ts: row.anchor_ts !== undefined ? row.anchor_ts : latest.anchor_ts,
      history_windows: row.history_windows !== undefined ? row.history_windows : latest.history_windows,
      note: row.note !== undefined ? row.note : latest.note,
      source: "declared",
    };
    return replaceCadenceHistory(cfg, row.subscription, row.kind, segments);
  }
  const windows = [...(cfg.windows || [])];
  const at = windows.findIndex(
    (w) => w.subscription.toLowerCase() === s && w.kind.toLowerCase() === k
  );
  const clean: CycleWindowConfig = { subscription: row.subscription, kind: row.kind };
  if (row.period_hours != null) clean.period_hours = row.period_hours;
  if (row.anchor_ts) clean.anchor_ts = row.anchor_ts;
  if (row.history_windows != null) clean.history_windows = row.history_windows;
  const previous = at >= 0 ? windows[at] : existing;
  const note = row.note ?? previous?.note ?? null;
  if (note) clean.note = note;
  if (at >= 0) windows[at] = clean;
  else windows.push(clean);
  return { ...cfg, windows };
}
export interface ObservedCadence {
  periodHours: number | null;
  anchorIso: string | null;
  source?: CadenceSource;
}
export interface Cadence {
  subscription: string;
  kind: string;
  periodHours: number | null;
  periodSource: CadenceSource;
  anchorIso: string | null;
  anchorSource: CadenceSource;
  historyWindows: number;
  historySource: CadenceSource;
  note: string | null;
  segments?: CadenceSegment[];
  observed?: ObservedCadence;
}
export interface ResolvedCadenceForDay {
  subscription: string;
  kind: string;
  day: string;
  periodHours: number | null;
  periodSource: CadenceSource;
  anchorIso: string | null;
  anchorSource: CadenceSource;
  historyWindows: number;
  historySource: CadenceSource;
  segmentFrom: string | null;
  note: string | null;
  sourceWon: CadenceSource;
  declaredCovering: boolean;
}
export function resolveCadenceForDay(
  cfg: CyclesConfig,
  subscription: string,
  kind: string,
  day: string,
  observed: ObservedCadence
): ResolvedCadenceForDay {
  const normDay = day.slice(0, 10);
  const segments = findCadenceSegments(cfg, subscription, kind);
  let chosen: CadenceSegment | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    const fromStr = seg.from ? seg.from.slice(0, 10) : null;
    const nextFromStr = next && next.from ? next.from.slice(0, 10) : null;
    if (fromStr == null || fromStr <= normDay) {
      if (nextFromStr == null || normDay < nextFromStr) {
        chosen = seg;
        break;
      }
    }
  }
  const observedSource = observed.source ?? "probe";
  if (chosen) {
    const periodHours = chosen.period_hours;
    let anchorIso = chosen.anchor_ts ?? null;
    let anchorSource: CadenceSource = chosen.anchor_ts ? "declared" : "none";
    if (chosen.legacy_origin && anchorIso == null && observed.anchorIso) {
      anchorIso = observed.anchorIso;
      anchorSource = observedSource;
    }
    const historyWindows = chosen.history_windows ?? DEFAULT_HISTORY_WINDOWS;
    const historySource: CadenceSource = chosen.history_windows != null ? "declared" : "default";
    return {
      subscription,
      kind,
      day: normDay,
      periodHours,
      periodSource: "declared",
      anchorIso,
      anchorSource,
      historyWindows,
      historySource,
      segmentFrom: chosen.from,
      note: chosen.note ?? null,
      sourceWon: "declared",
      declaredCovering: true,
    };
  }
  const periodHours = observed.periodHours ?? null;
  const periodSource: CadenceSource = observed.periodHours != null ? observedSource : "none";
  const anchorIso = observed.anchorIso ?? null;
  const anchorSource: CadenceSource = observed.anchorIso != null ? observedSource : "none";
  const historyWindows = DEFAULT_HISTORY_WINDOWS;
  const historySource: CadenceSource = "default";
  return {
    subscription,
    kind,
    day: normDay,
    periodHours,
    periodSource,
    anchorIso,
    anchorSource,
    historyWindows,
    historySource,
    segmentFrom: null,
    note: null,
    sourceWon: periodSource !== "none" ? periodSource : "none",
    declaredCovering: false,
  };
}
export function resolveCadence(
  cfg: CyclesConfig,
  subscription: string,
  kind: string,
  observed: ObservedCadence,
  asOf?: string | null
): Cadence {
  const segments = findCadenceSegments(cfg, subscription, kind);
  if (asOf) {
    const dayRes = resolveCadenceForDay(cfg, subscription, kind, asOf, observed);
    return {
      subscription,
      kind,
      periodHours: dayRes.periodHours,
      periodSource: dayRes.periodSource,
      anchorIso: dayRes.anchorIso,
      anchorSource: dayRes.anchorSource,
      historyWindows: dayRes.historyWindows,
      historySource: dayRes.historySource,
      note: dayRes.note,
      segments,
      observed,
    };
  }
  const observedSource = observed.source ?? "probe";
  const latestSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  if (latestSegment) {
    const periodHours = latestSegment.period_hours;
    let anchorIso = latestSegment.anchor_ts ?? null;
    let anchorSource: CadenceSource = latestSegment.anchor_ts ? "declared" : "none";
    if (latestSegment.legacy_origin && anchorIso == null && observed.anchorIso) {
      anchorIso = observed.anchorIso;
      anchorSource = observedSource;
    }
    const historyWindows = latestSegment.history_windows ?? DEFAULT_HISTORY_WINDOWS;
    const historySource: CadenceSource = latestSegment.history_windows != null ? "declared" : "default";
    return {
      subscription,
      kind,
      periodHours,
      periodSource: "declared",
      anchorIso,
      anchorSource,
      historyWindows,
      historySource,
      note: latestSegment.note ?? null,
      segments,
      observed,
    };
  }
  const periodHours = observed.periodHours ?? null;
  const periodSource: CadenceSource = observed.periodHours != null ? observedSource : "none";
  const anchorIso = observed.anchorIso ?? null;
  const anchorSource: CadenceSource = observed.anchorIso != null ? observedSource : "none";
  const historyWindows = DEFAULT_HISTORY_WINDOWS;
  const historySource: CadenceSource = "default";
  return {
    subscription,
    kind,
    periodHours,
    periodSource,
    anchorIso,
    anchorSource,
    historyWindows,
    historySource,
    note: null,
    segments: [],
    observed,
  };
}
export interface AnchoredWindow {
  offset: number;
  startMs: number;
  resetMs: number;
  startIso: string;
  resetIso: string;
  isCurrent: boolean;
  segmentFrom?: string | null;
  periodHours: number;
  periodSource: CadenceSource;
  anchorIso: string;
  anchorSource: CadenceSource;
  source: CadenceSource;
}
export interface EffectiveCadenceSegment {
  from: string | null;
  period_hours: number;
  period_source: CadenceSource;
  anchor_ts: string | null;
  anchor_source: CadenceSource;
  history_windows?: number | null;
  note?: string | null;
  source: CadenceSource;
}
export function effectiveSegmentsForReconstruction(
  segments: CadenceSegment[] | undefined,
  observed?: ObservedCadence
): EffectiveCadenceSegment[] {
  const declared = segments ? [...segments].filter((s) => s.period_hours > 0) : [];
  declared.sort((a, b) => {
    if (a.from == null && b.from == null) return 0;
    if (a.from == null) return -1;
    if (b.from == null) return 1;
    return a.from.localeCompare(b.from);
  });
  const filledDeclared: EffectiveCadenceSegment[] = declared.map((seg) => {
    let anchor = seg.anchor_ts ?? null;
    let anchorSource: CadenceSource = seg.anchor_ts ? "declared" : "none";
    if (seg.legacy_origin && anchor == null && observed?.anchorIso) {
      anchor = observed.anchorIso;
      anchorSource = observed.source ?? "probe";
    }
    const periodSource: CadenceSource = "declared";
    const source: CadenceSource = anchorSource !== "none" ? anchorSource : periodSource;
    return {
      from: seg.from,
      period_hours: seg.period_hours,
      period_source: periodSource,
      anchor_ts: anchor,
      anchor_source: anchorSource,
      history_windows: seg.history_windows,
      note: seg.note,
      source,
    };
  });
  if (filledDeclared.length > 0) return filledDeclared;
  if (observed && observed.periodHours != null && observed.periodHours > 0 && observed.anchorIso) {
    const probeSource = observed.source ?? "probe";
    return [
      {
        from: null,
        period_hours: observed.periodHours,
        period_source: probeSource,
        anchor_ts: observed.anchorIso,
        anchor_source: probeSource,
        source: probeSource,
      },
    ];
  }
  return [];
}
export function reconstructAnchoredWindows(
  segments: EffectiveCadenceSegment[],
  opts: {
    nowMs: number;
    earliestMs: number | null;
    limit?: number;
    defaultHistoryWindows?: number;
  }
): AnchoredWindow[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => {
    if (a.from == null && b.from == null) return 0;
    if (a.from == null) return -1;
    if (b.from == null) return 1;
    return a.from.localeCompare(b.from);
  });
  const nowMs = opts.nowMs;
  const earliestMs = opts.earliestMs;
  const allWindows: AnchoredWindow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const next = sorted[i + 1];
    if (!seg.period_hours || seg.period_hours <= 0 || !seg.anchor_ts) continue;
    const periodMs = seg.period_hours * HOUR_MS;
    const anchorMs = Date.parse(seg.anchor_ts);
    if (!Number.isFinite(anchorMs) || !(periodMs > 0)) continue;
    const segStartMs = seg.from
      ? Date.parse(`${seg.from}T00:00:00.000Z`)
      : (earliestMs ?? 0);
    const segEndMs = next && next.from
      ? Date.parse(`${next.from}T00:00:00.000Z`)
      : null;
    if (!Number.isFinite(segStartMs)) continue;
    if (segEndMs != null && !Number.isFinite(segEndMs)) continue;
    if (segEndMs != null && segEndMs <= segStartMs) continue;
    const upperRefMs = segEndMs != null ? segEndMs : nowMs + periodMs;
    const maxK = Math.floor((upperRefMs - anchorMs) / periodMs);
    const minK = Math.ceil((segStartMs + periodMs - anchorMs) / periodMs);
    for (let k = maxK; k >= minK; k--) {
      const resetMs = anchorMs + k * periodMs;
      const startMs = resetMs - periodMs;
      if (startMs < segStartMs) continue;
      if (segEndMs != null && resetMs > segEndMs) continue;
      if (earliestMs != null && resetMs <= earliestMs) continue;
      allWindows.push({
        offset: 0,
        startMs,
        resetMs,
        startIso: new Date(startMs).toISOString(),
        resetIso: new Date(resetMs).toISOString(),
        isCurrent: startMs <= nowMs && nowMs < resetMs,
        segmentFrom: seg.from,
        periodHours: seg.period_hours,
        periodSource: seg.period_source,
        anchorIso: seg.anchor_ts,
        anchorSource: seg.anchor_source,
        source: seg.source,
      });
    }
  }
  allWindows.sort((a, b) => b.startMs - a.startMs);
  const currentIdx = allWindows.findIndex((w) => w.isCurrent);
  const baseIdx = currentIdx >= 0 ? currentIdx : 0;
  for (let i = 0; i < allWindows.length; i++) {
    allWindows[i]!.offset = baseIdx - i;
  }
  const limit = Math.max(0, opts.limit ?? opts.defaultHistoryWindows ?? DEFAULT_HISTORY_WINDOWS);
  return limit === 0 ? [] : allWindows.slice(0, limit);
}
export function anchoredWindows(
  cadence: Cadence,
  opts: { nowMs: number; earliestMs: number | null; limit?: number }
): AnchoredWindow[] {
  const observed: ObservedCadence = cadence.observed ?? {
    periodHours: cadence.periodHours,
    anchorIso: cadence.anchorIso,
    source: cadence.periodSource,
  };
  const effective = effectiveSegmentsForReconstruction(cadence.segments, observed);
  if (effective.length === 0) return [];
  return reconstructAnchoredWindows(effective, {
    nowMs: opts.nowMs,
    earliestMs: opts.earliestMs,
    limit: opts.limit ?? cadence.historyWindows,
  });
}
