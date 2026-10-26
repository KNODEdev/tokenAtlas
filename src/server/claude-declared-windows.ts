import type { Database } from "bun:sqlite";
import { anchoredWindows, MIN_HISTORY_PERIOD_HOURS, resolveCadence, type AnchoredWindow, type CyclesConfig,
  type ObservedCadence } from "./cycles";
import { ProbeAccountIndexUnavailable, readPreparedProbeCadences } from "./current/probe-account-reader";
import type { PeriodIndex } from "./account-periods";
import { planReconstructionSpans } from "./window-plan-periods";

/** Nominal length of a counter in hours: the reading's own duration, else the counter kind's. */
export function railWindowHours(provider: string, kind: string, windowMinutes: number | null): number | null {
  if (windowMinutes != null) return windowMinutes / 60;
  if (kind === "session" || kind === "five_hour") return 5;
  if (kind === "weekly" || kind === "weekly_all" || kind === "weekly_scoped" || kind === "seven_day") return 168;
  return null;
}

/**
 * The reset instant a cadence is anchored to: the reported reset to the nearest whole minute. Claude reports
 * the same reset with sub-second jitter from reading to reading (11:00:00.314, then 10:59:59.725); anchored
 * as reported, every new reading gave each reconstructed window a new identity, so the window producer
 * deleted and summed all of them again and every screen's data version moved with each probe round.
 */
export function cadenceAnchor(resetsAt: string | null): string | null {
  if (resetsAt == null) return null;
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) ? new Date(Math.round(ms / 60_000) * 60_000).toISOString() : resetsAt;
}

/** The newest reset reading of a counter as the observed cadence; throws while the probe index prepares. */
export function observedCadence(db: Database, provider: string, subject: string, kind: string): ObservedCadence {
  const prepared = readPreparedProbeCadences(db, provider, subject);
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  const row = prepared.find(sample => sample.kind === kind)?.latest;
  return {
    periodHours: railWindowHours(provider, kind, row?.window_minutes as number | null ?? null),
    anchorIso: cadenceAnchor(row?.resets_at as string | null ?? null),
    source: "probe",
  };
}

export const CLAUDE_HISTORY_KINDS = [
  { kind: "weekly_all", scope: null as string | null },
  { kind: "weekly_scoped", scope: "Fable" as string | null },
] as const;

/** A reconstructed Claude window without its clock-dependent fields; `isCurrent` follows from the reader's clock. */
export type DeclaredWindow = Omit<AnchoredWindow, "offset" | "isCurrent">;
export interface DeclaredWindowSet { kind: string; scope: string | null; windows: DeclaredWindow[] }

/**
 * Claude windows reconstructed from the cadence (cycles.json declarations or the observed reset) for the
 * weeks the meter never reported, as the rail shows them. `earliestMs` is the start of the account's first
 * ownership period. Known plan history bounds reconstruction; a partly covered week retains its reset
 * and identity. Measured windows are published separately and never filtered here.
 */
export function claudeDeclaredWindows(db: Database, account: string, cycles: CyclesConfig, nowMs: number,
  earliestMs: number | null, plans: PeriodIndex | null = null): DeclaredWindowSet[] {
  const spans = planReconstructionSpans(plans, "claude", account, true);
  if (spans?.length === 0) return [];
  return CLAUDE_HISTORY_KINDS.map(spec => {
    const cadence = resolveCadence(cycles, account, spec.kind, observedCadence(db, "claude", account, spec.kind));
    const usable = cadence.periodHours != null && cadence.anchorIso != null && cadence.periodHours >= MIN_HISTORY_PERIOD_HOURS;
    // Inactive weeks must not consume the history allowance and push valid old windows out.
    const candidates = usable ? anchoredWindows(cadence, { nowMs, earliestMs,
      limit: spans === null ? cadence.historyWindows : Number.MAX_SAFE_INTEGER }) : [];
    const windows = spans === null ? candidates : candidates.filter(window =>
      spans.some(span => span.from <= nowMs && span.from < window.resetMs && span.until > window.startMs)).slice(0, cadence.historyWindows);
    return { kind: spec.kind, scope: spec.scope,
      windows: windows.map(({ offset: _offset, isCurrent: _current, ...window }) => window) };
  }).filter(set => set.windows.length > 0);
}
