import type { Database } from "bun:sqlite";
import { readGlmProbe, type GlmProbeSample } from "../providers/adapters/glm";
import { limitPace, measuredAgeMinutes, round, windowFromReset } from "../providers/core/limit";
import { DEFAULT_PROBE_MINUTES } from "./probe-health";
import { sameResetWindow } from "../providers/adapters/claude";
import { readLimitWindowsWhere } from "../db/limit-windows";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { readWindowSums, WindowUsagePreparing } from "./window-usage-read";
import { unpricedModels } from "./window-usage-presentation";
import { type WindowSums } from "./window-usage-contracts";
import type { UnpricedModel } from "../shared/missing-rate";
export interface GlmModelRow {
  model: string;
  calls: number;
  in_tok: number;
  cache_read: number;
  out_tok: number;
  reasoning: number;
  usd: number;
}
export interface GlmSpend {
  since_ts: string;
  until_ts: string;
  calls: number;
  sessions: number;
  gross: number;
  fresh: number;
  in_tok: number;
  cache_read: number;
  out_tok: number;
  reasoning: number;
  usd: number;
  usd_basis: "api-eq";
  models: GlmModelRow[];
  unpriced_tokens: number;
  /** `unpriced_tokens` per model; present only when some exist. */
  unpriced_models?: UnpricedModel[];
}
/**
 * Everything one saved window sample fixes by itself: the vendor counter and the boundaries
 * its own reset implies. `spend` follows the requested live horizon, clipped at the declared
 * reset; `credits_per_mtok` always uses spending only through the saved sample timestamp, so
 * later traffic is never divided by an older percentage.
 */
export interface GlmWindowMeasurement {
  kind: string;
  label: string;
  window_hours: number | null;
  allowance: number | null;
  used: number;
  remaining: number | null;
  percent: number;
  vendor_percent: number | null;
  measured_at: string;
  reset_at: string | null;
  window_start: string | null;
  spend: GlmSpend | null;
  credits_per_mtok: number | null;
  note: string | null;
}
/** The live card: the measurement above plus the countdown fields that depend on the clock. */
export interface GlmWindowReport extends GlmWindowMeasurement {
  measured_age_minutes: number;
  remaining_hours: number | null;
  elapsed_percent: number | null;
  pp_ahead: number | null;
}
export interface GlmLimitReport {
  subscription: string;
  level: string | null;
  measured_at: string;
  headline_kind: string;
  windows: GlmWindowReport[];
  caveats: string[];
}
function labelOf(hours: number | null, kind: string): string {
  if (hours == null) return kind;
  if (hours <= 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
const MAX_DATE_MS = 8_640_000_000_000_000;

function glmWindowBounds(s: GlmProbeSample): {
  sampleMs: number;
  resetMs: number;
  windowStartMs: number;
} | null {
  const hours = s.window_hours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return null;
  const durationMs = hours * 3_600_000;
  const sampleMs = Date.parse(s.ts);
  const resetMs = typeof s.resets_at === "string" ? Date.parse(s.resets_at) : NaN;
  const windowStartMs = resetMs - durationMs;
  if (
    !Number.isFinite(durationMs) || durationMs <= 0 ||
    !Number.isFinite(sampleMs) || !Number.isFinite(resetMs) ||
    !Number.isFinite(windowStartMs) || Math.abs(windowStartMs) > MAX_DATE_MS
  ) return null;
  // A usable observation describes a positive interval after the window start. The reset
  // instant belongs to the next cycle, so the saved sample must be strictly before it.
  if (!(windowStartMs < sampleMs && sampleMs < resetMs)) return null;
  return { sampleMs, resetMs, windowStartMs };
}

function glmWindowNote(s: GlmProbeSample, bounds: ReturnType<typeof glmWindowBounds>): string | null {
  return bounds
    ? null
    : !s.resets_at && s.used === 0
      ? "okno nietknięte — reset liczy się dopiero od pierwszego zużycia, więc vendor nie podaje daty"
      : !s.resets_at
        ? "vendor nie podał daty resetu tego okna"
        : "odczyt wypada poza prawidłowym dodatnim oknem resetu";
}

/**
 * A GLM window's traffic from its stored row (`window_usage`): every counted call of the cycle, valued at
 * the usage ledger's stored Standard price (the z.ai list price; the plan itself returns no price).
 */
export function glmStoredSpend(sums: Pick<WindowSums, "rail">, sinceIso: string, untilIso: string): GlmSpend {
  const out: GlmSpend = { since_ts: sinceIso, until_ts: untilIso, calls: 0, sessions: sums.rail.sessions ?? 0, gross: sums.rail.tokens,
    fresh: 0, in_tok: 0, cache_read: 0, out_tok: 0, reasoning: 0, usd: round(sums.rail.api_standard), usd_basis: "api-eq", models: [],
    unpriced_tokens: sums.rail.unpriced_tokens };
  for (const row of sums.rail.by_model) {
    if (row.excluded !== null) continue;
    const uncached = row.input - row.cached;
    out.calls += row.calls; out.in_tok += uncached; out.cache_read += row.cached; out.out_tok += row.output; out.reasoning += row.reasoning;
    out.fresh += uncached + row.output;
    out.models.push({ model: row.model || "-", calls: row.calls, in_tok: uncached, cache_read: row.cached, out_tok: row.output,
      reasoning: row.reasoning, usd: round(row.api_standard) });
  }
  out.models.sort((a, b) => b.usd - a.usd || b.calls - a.calls);
  const unpriced = unpricedModels(sums.rail.by_model);
  return unpriced.length ? { ...out, unpriced_models: unpriced } : out;
}

/** The stored window whose readings hold a saved sample, and its sums; "preparing" until both are published. */
function storedSampleWindow(sqlite: Database, account: string, s: GlmProbeSample, sampleMs: number,
  windows: () => ProbeLimitWindow[]): Pick<WindowSums, "rail" | "readings"> {
  const window = windows().filter((candidate) => sameResetWindow(candidate.reset, s.resets_at))
    .find((candidate) => candidate.readings.some((reading) => Date.parse(reading.ts) === sampleMs));
  if (!window) throw new WindowUsagePreparing();
  return readWindowSums(sqlite, "glm", account, window.counter, [window], ["rail", "readings"]).get(window.id)!;
}
/**
 * One saved sample from stored rows: the sample is a reading of a stored limit window; the live spend is
 * that window's whole cycle (no call after the clock exists), and the calibration pairs the saved credits
 * with the running total at the sample's own instant, so later traffic never divides an older percentage.
 */
export function storedGlmMeasurement(sqlite: Database, account: string, s: GlmProbeSample, nowMs: number,
  windows: () => ProbeLimitWindow[]): GlmWindowMeasurement {
  const bounds = glmWindowBounds(s);
  const base = { kind: s.kind, label: labelOf(s.window_hours, s.kind), window_hours: s.window_hours, allowance: s.allowance, used: s.used,
    remaining: s.remaining, percent: round(s.percent), vendor_percent: s.vendor_percent, measured_at: s.ts, reset_at: s.resets_at,
    window_start: bounds ? new Date(bounds.windowStartMs).toISOString() : null, note: glmWindowNote(s, bounds) };
  if (!bounds) return { ...base, spend: null, credits_per_mtok: null };
  const sums = storedSampleWindow(sqlite, account, s, bounds.sampleMs, windows);
  const throughMs = Math.min(nowMs, bounds.resetMs);
  const spend = throughMs > bounds.windowStartMs ? glmStoredSpend(sums, base.window_start!, new Date(throughMs).toISOString()) : null;
  const atSample = sums.readings.find((reading) => Date.parse(reading.ts) === bounds.sampleMs)?.usage.tokens ?? 0;
  return { ...base, spend, credits_per_mtok: atSample > 0 && s.used > 0 ? round(s.used / (atSample / 1_000_000)) : null };
}
function buildWindow(
  sqlite: Database,
  account: string,
  s: GlmProbeSample,
  nowMs: number,
  windows: () => ProbeLimitWindow[]
): GlmWindowReport {
  // Validate before calling the shared clock helper so malformed or overflowing hours cannot
  // reach Date construction. A valid saved measurement remains usable after its reset expires.
  const timing = glmWindowBounds(s)
    ? windowFromReset(s.resets_at, s.window_hours, nowMs)
    : null;
  const pace = limitPace(s.percent, timing);
  return {
    ...storedGlmMeasurement(sqlite, account, s, nowMs, windows),
    measured_age_minutes: measuredAgeMinutes(s.ts, nowMs)!,
    remaining_hours: timing ? round(timing.remainingHours) : null,
    elapsed_percent: timing?.elapsedPercent != null ? round(timing.elapsedPercent) : null,
    pp_ahead: pace.ppAhead != null ? round(pace.ppAhead) : null,
  };
}
/** One saved sample's calibration evidence: its percentage and the API value of its window's traffic up to the sample. */
export interface GlmCalibrationWindow {
  kind: string;
  window_hours: number | null;
  percent: number;
  measured_at: string;
  /** API Standard value (z.ai list prices) of the window's counted calls through the sample; null without a valid window. */
  spend_usd: number | null;
}
export interface GlmCalibrationReport {
  subscription: string;
  level: string | null;
  /** Newest sample of any window kind; each window still carries its own `measured_at`. */
  measured_at: string;
  windows: GlmCalibrationWindow[];
}
/**
 * The saved observations, and nothing else (plan U4.4: stored rows, no call read). Each window's
 * percentage is paired with the running total of its stored window at that window's OWN sample, so
 * later traffic, a window reset, a restart or the minute of the read cannot move a calibration that
 * was already measured. Window kinds are measured separately because their samples carry separate
 * timestamps. A row not yet prepared raises `WindowUsagePreparing`.
 */
export function buildGlmCalibration(sqlite: Database, subscription = "glm"): GlmCalibrationReport | null {
  const samples = readGlmProbe(sqlite, subscription);
  if (samples.length === 0) return null;
  const account = subscription.toLowerCase();
  let stored: ProbeLimitWindow[] | null = null;
  const windows = () => stored ??= readLimitWindowsWhere(sqlite, "glm", account, () => true);
  return {
    subscription,
    level: samples[0]?.level ?? null,
    measured_at: samples.map((s) => s.ts).sort().at(-1)!,
    windows: samples.map((s) => {
      const bounds = glmWindowBounds(s);
      const reading = bounds ? storedSampleWindow(sqlite, account, s, bounds.sampleMs, windows).readings
        .find((candidate) => Date.parse(candidate.ts) === bounds.sampleMs) : undefined;
      return { kind: s.kind, window_hours: s.window_hours, percent: round(s.percent), measured_at: s.ts,
        spend_usd: bounds ? round(reading?.usage.api_standard ?? 0) : null };
    }),
  };
}
/**
 * The GLM card (plan U1.4): each saved quota sample with its window's traffic from stored rows
 * (`limit_windows`, `window_usage`); nothing here reads calls. A row not yet prepared raises
 * `WindowUsagePreparing`.
 */
export function buildGlmLimit(
  sqlite: Database,
  subscription = "glm"
): GlmLimitReport | null {
  const samples = readGlmProbe(sqlite, subscription);
  if (samples.length === 0) return null;
  const nowMs = Date.now();
  const account = subscription.toLowerCase();
  let stored: ProbeLimitWindow[] | null = null;
  const limitWindows = () => stored ??= readLimitWindowsWhere(sqlite, "glm", account, () => true);
  const windows = samples.map((s) => buildWindow(sqlite, account, s, nowMs, limitWindows));
  const headline = windows.reduce((a, b) => (b.percent > a.percent ? b : a), windows[0]!);
  const caveats: string[] = [
    "Limit planu jest w KREDYTACH ważonych per model i typ tokena, nie w tokenach. Tokeny obok pochodzą z bazy opencode i są osobną miarą tej samej pracy — nie da się ich podzielić przez przydział.",
    "Dolary są API-eq: cennik listowy z.ai zastosowany do zmierzonych tokenów. Mówią, ile ten ruch kosztowałby BEZ abonamentu, a nie ile z abonamentu zeszło — plan nie zwraca żadnej ceny (cost w opencode jest zawsze 0).",
    "Licznik konta widzi każdy ruch tym kluczem, a indeks tylko ten, który przeszedł przez bazę opencode. Procent może więc urosnąć bez wzrostu tokenów — to poprawne zachowanie licznika.",
  ];
  const rounded = windows.filter((w) => w.vendor_percent != null && Math.abs(w.vendor_percent - w.percent) >= 0.5);
  if (rounded.length > 0) {
    caveats.push(
      `Vendor zaokrągla swój procent do liczby całkowitej (${rounded
        .map((w) => `${w.label}: ${w.vendor_percent}% wobec ${w.percent}%`)
        .join(", ")}). Na karcie jest iloraz zużycia przez przydział, bo obie liczby przychodzą w tej samej odpowiedzi.`
    );
  }
  const stale = windows.filter((w) => w.measured_age_minutes > 30);
  if (stale.length > 0) {
    caveats.push(
      `Odczyt ma ${Math.max(...stale.map((w) => w.measured_age_minutes))} min — probe chodzi co ${
        process.env.TOKENATLAS_PROBE_MINUTES ?? DEFAULT_PROBE_MINUTES
      } min, więc taki wiek znaczy, że ostatnie cykle nie doszły.`
    );
  }
  return {
    subscription,
    level: samples[0]?.level ?? null,
    measured_at: samples.map((s) => s.ts).sort().at(-1)!,
    headline_kind: headline.kind,
    windows,
    caveats,
  };
}
