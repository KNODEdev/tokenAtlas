import fs from "fs";
import { atomicArchiveWrite } from "../sync/archive-publication";
import path from "path";
import { configFile, configWriteTarget } from "../config/paths";
import type { Database } from "bun:sqlite";
import { HOUR_MS, rollingWindow, round } from "../providers/core/limit";
import { readGrokProbe } from "../providers/adapters/grok";
import { sameResetWindow } from "../providers/adapters/claude";
import { readLimitWindowsWhere } from "../db/limit-windows";
import { readSpanSums, readWindowIntervals, readWindowSums, WindowUsagePreparing } from "./window-usage-read";
import { type WindowSums } from "./window-usage-contracts";
import { grokAnchoredWindow, grokDeclaredWindowHours, grokGaugeAccount, grokGaugeObservations, grokObservationId, grokObservationSpan,
  grokRollingId, type GrokGaugeConfig, type GrokGaugeObservation, type GrokResetAnchor } from "./grok-gauge-spans";
export { loadGrokGauge } from "./grok-gauge-spans";
export type { GrokGaugeConfig, GrokGaugeObservation, GrokResetAnchor } from "./grok-gauge-spans";
export function grokGaugePath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, "grok-gauge.json") : configFile("grok-gauge.json");
}
export function saveGrokResetAnchor(rootDir: string | undefined, anchor: GrokResetAnchor | null): GrokGaugeConfig {
  const readFrom = grokGaugePath(rootDir);
  const file = rootDir ? readFrom : configWriteTarget("grok-gauge.json");
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(readFrom)) {
    try {
      raw = JSON.parse(fs.readFileSync(readFrom, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`grok-gauge.json jest nieparsowalny, odmawiam nadpisania: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (anchor) raw.reset_anchor = anchor;
  else delete raw.reset_anchor;
  atomicArchiveWrite(file, JSON.stringify(raw, null, 2) + "\n");
  return raw as GrokGaugeConfig;
}
export interface GrokLimitSpend {
  turns: number;
  calls: number;
  gross: number;
  fresh: number;
  usd: number;
}
export interface GrokObservationReport {
  ts: string;
  percent: number;
  visible_share: number;
  window_start: string;
  spend: GrokLimitSpend;
  usd_per_point: number | null;
  source: string | null;
  note: string | null;
}
export interface GrokCalibration {
  source_ts: string;
  usd_per_point: number;
  window_value_usd: number;
  visible_share: number;
  confidence: "medium" | "low" | "none";
  reason: string;
}
export interface GrokCurrentWindow {
  window_start: string;
  window_end: string;
  anchored: boolean;
  anchor_ts: string | null;
  reset_in_hours: number | null;
  spend: GrokLimitSpend;
  percent_measured: number | null;
  measured_at: string | null;
  measurement_age_minutes: number | null;
  measurement_source: "grok_billing" | null;
  percent_est: number | null;
  remaining_usd: number | null;
  idle_hours: number | null;
}
export interface GrokLimitReport {
  configured: boolean;
  plan: string | null;
  window_hours: number;
  observations: GrokObservationReport[];
  calibration: GrokCalibration | null;
  current: GrokCurrentWindow | null;
  caveats: string[];
}
const EMPTY_SPEND: GrokLimitSpend = { turns: 0, calls: 0, gross: 0, fresh: 0, usd: 0 };
/**
 * The counted traffic of a stored span (a limit window or an interval of `window_usage`) as the gauge
 * shows it. The money is xAI's own price of each call (cost ticks), never a rate card. The usage
 * ledger keeps one fact per turn and no count of the model calls inside it, so `calls` counts turns.
 */
export function grokStoredSpend(sums: Pick<WindowSums, "cycle" | "rail">): GrokLimitSpend {
  const counted = sums.rail.by_model.filter((model) => model.excluded === null);
  return {
    turns: sums.cycle.cycle_usage.events,
    calls: sums.cycle.cycle_usage.events,
    gross: sums.rail.tokens,
    fresh: counted.reduce((sum, model) => sum + model.input - model.cached + model.output, 0),
    usd: round(sums.rail.reported?.usd ?? 0),
  };
}
export interface GrokCalibrationReport {
  /**
   * The window length the manual observations are measured over: the declared one, or the
   * 168 h default. A live probe may report a different period for the CURRENT window, but it
   * must never redefine the denominator of a reading taken weeks ago - nor may its expiry.
   */
  window_hours: number;
  /** Configured observations of the right shape, before unparsable timestamps are dropped. */
  declared: number;
  observations: GrokObservationReport[];
  calibration: GrokCalibration | null;
  /** The observation the calibration was taken from; `null` when none qualifies. */
  source: GrokObservationReport | null;
}
/**
 * Manual calibration from saved evidence only: the declared window length, the declared reset
 * anchor and the traffic each observation's own window actually contains (`spendOf`). Nothing here
 * reads the probe journal or the clock, so an expiring live reading cannot move a historical
 * denominator, and a historical calibration cannot be erased by the current window ending.
 */
function grokCalibrationFrom(cfg: GrokGaugeConfig,
  spendOf: (observation: GrokGaugeObservation, span: { start: string; end: string }) => GrokLimitSpend): GrokCalibrationReport {
  const observationsIn = grokGaugeObservations(cfg);
  const reports: GrokObservationReport[] = [];
  for (const o of observationsIn) {
    const span = grokObservationSpan(cfg, o);
    if (!span) continue;
    const spend = spendOf(o, span);
    const share = typeof o.visible_share === "number" && o.visible_share > 0 ? Math.min(1, o.visible_share) : 1;
    const visiblePoints = o.percent * share;
    reports.push({
      ts: o.ts,
      percent: o.percent,
      visible_share: share,
      window_start: span.start,
      spend,
      usd_per_point: visiblePoints > 0 && spend.usd > 0 ? round(spend.usd / visiblePoints, 4) : null,
      source: o.source ?? null,
      note: o.note ?? null,
    });
  }
  reports.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const usable = reports.filter((r) => r.usd_per_point != null);
  const zeroChecks = reports.filter((r) => r.percent === 0);
  const deepest = usable.reduce<GrokObservationReport | null>(
    (best, r) => (best == null || r.percent > best.percent ? r : best),
    null
  );
  let calibration: GrokCalibration | null = null;
  if (deepest?.usd_per_point != null) {
    calibration = {
      source_ts: deepest.ts,
      usd_per_point: deepest.usd_per_point,
      window_value_usd: round(deepest.usd_per_point * 100),
      visible_share: deepest.visible_share,
      confidence: usable.length >= 2 ? "medium" : "low",
      reason:
        (usable.length >= 2
          ? `${usable.length} odczyty; skalę ustawia ten przy ${deepest.percent}%`
          : `pojedynczy odczyt przy ${deepest.percent}% — skala jest ustalona, ale jej liniowość nie została sprawdzona`) +
        (zeroChecks.length > 0
          ? `; ${zeroChecks.length === 1 ? "punkt zerowy potwierdzony" : `${zeroChecks.length} punkty zerowe potwierdzone`} odczytem konta`
          : ""),
    };
  }
  return { window_hours: grokDeclaredWindowHours(cfg), declared: observationsIn.length, observations: reports, calibration, source: deepest };
}
/** The calibration from the stored observation spans of `window_usage`; a missing row is "preparing". */
export function storedGrokCalibration(sqlite: Database, cfg: GrokGaugeConfig): GrokCalibrationReport {
  const account = grokGaugeAccount(cfg);
  const published = new Map(readWindowIntervals(sqlite, "grok", account).map((interval) => [interval.id, interval]));
  const ids: string[] = [];
  for (const o of grokGaugeObservations(cfg)) {
    const span = grokObservationSpan(cfg, o), interval = published.get(grokObservationId(o.ts));
    if (!span) continue;
    // An observation the producer has not published yet (or published over other bounds) is still being prepared.
    if (!interval || interval.start !== span.start || interval.end !== span.end) throw new WindowUsagePreparing();
    ids.push(interval.id);
  }
  const stored = readSpanSums(sqlite, "grok", account, ids, ["cycle", "rail"]);
  return grokCalibrationFrom(cfg, (o) => grokStoredSpend(stored.get(grokObservationId(o.ts))!));
}

type StoredWindow = { startIso: string; endIso: string; spend: GrokLimitSpend; basis: "measured" | "anchored" | "rolling" };
/** The current window of the gauge and its traffic, from stored rows only. */
function storedCurrentWindow(sqlite: Database, cfg: GrokGaugeConfig, account: string, nowMs: number, windowHours: number,
  measured: { resets_at: string | null; period_start: string | null; ts: string } | null): StoredWindow {
  if (measured) {
    // The Billing reading is a reading of a stored limit window; its sums are that window's row.
    const window = readLimitWindowsWhere(sqlite, "grok", account, () => true)
      .filter((candidate) => sameResetWindow(candidate.reset, measured.resets_at))
      .find((candidate) => candidate.readings.some((reading) => Date.parse(reading.ts) === Date.parse(measured.ts)));
    if (!window) throw new WindowUsagePreparing();
    const sums = readWindowSums(sqlite, "grok", account, window.counter, [window], ["cycle", "rail"]).get(window.id)!;
    return { startIso: measured.period_start!, endIso: measured.resets_at!, spend: grokStoredSpend(sums), basis: "measured" };
  }
  const intervals = readWindowIntervals(sqlite, "grok", account);
  const anchor = grokAnchoredWindow(cfg.reset_anchor, windowHours, nowMs);
  if (anchor) {
    // The producer keeps the anchored period of the newest call; a later period has no call yet.
    const stored = intervals.find((interval) => interval.kind === "anchored" && interval.start === anchor.startIso);
    const spend = stored
      ? grokStoredSpend(readSpanSums(sqlite, "grok", account, [stored.id], ["cycle", "rail"]).get(stored.id)!)
      : { ...EMPTY_SPEND };
    return { startIso: anchor.startIso, endIso: anchor.endIso, spend, basis: "anchored" };
  }
  // The rolling fallback ends at the newest call, not at the clock; without any call it is empty.
  const rolling = intervals.find((interval) => interval.kind === "rolling" && interval.id === grokRollingId(Math.round(windowHours * 60)));
  if (!rolling) {
    const empty = rollingWindow(windowHours, nowMs);
    return { startIso: empty.windowStart, endIso: empty.windowEnd, spend: { ...EMPTY_SPEND }, basis: "rolling" };
  }
  const sums = readSpanSums(sqlite, "grok", account, [rolling.id], ["cycle", "rail"]).get(rolling.id)!;
  return { startIso: rolling.start, endIso: rolling.end, spend: grokStoredSpend(sums), basis: "rolling" };
}
/** The account's newest call, the end of its rolling fallbacks; null without any. */
export function newestGrokCall(sqlite: Database, account: string): string | null {
  return readWindowIntervals(sqlite, "grok", account).find((interval) => interval.kind === "rolling")?.end ?? null;
}

/**
 * The Grok gauge (plan U1.4): the Billing reading, the manual calibration and the current window's
 * traffic, read from stored rows (`limit_windows`, `window_usage` and the producer's Grok intervals);
 * nothing here reads calls. A row not yet prepared raises `WindowUsagePreparing`.
 */
export function buildGrokLimit(sqlite: Database, cfg: GrokGaugeConfig, nowIso?: string): GrokLimitReport {
  const subscription = cfg.subscription || cfg.store || "grok";
  const account = grokGaugeAccount(cfg);
  const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
  const measured = readGrokProbe(sqlite, subscription);
  const measuredStartMs = measured?.period_start ? new Date(measured.period_start).getTime() : NaN;
  const measuredEndMs = measured?.resets_at ? new Date(measured.resets_at).getTime() : NaN;
  const activeMeasured =
    measured &&
    Number.isFinite(measuredStartMs) &&
    Number.isFinite(measuredEndMs) &&
    measuredStartMs <= nowMs &&
    nowMs < measuredEndMs
      ? measured
      : null;
  const declaredWindowHours = grokDeclaredWindowHours(cfg);
  const windowHours = activeMeasured?.window_minutes && activeMeasured.window_minutes > 0
    ? activeMeasured.window_minutes / 60
    : declaredWindowHours;
  const caveats = [...(cfg.caveats || [])];
  // The saved calibration does not depend on the live window, so it is the same report
  // whether the probe below is active, expired or absent.
  if (grokGaugeObservations(cfg).length === 0 && !activeMeasured) {
    return {
      configured: false,
      plan: cfg.plan ?? null,
      window_hours: windowHours,
      observations: [],
      calibration: null,
      current: null,
      caveats,
    };
  }
  const saved = storedGrokCalibration(sqlite, cfg);
  const reports = saved.observations;
  const calibration = saved.calibration;
  const deepest = saved.source;
  const window = storedCurrentWindow(sqlite, cfg, account, nowMs, windowHours, activeMeasured);
  const anchor = window.basis === "anchored";
  const startIso = window.startIso, endIso = window.endIso, spend = window.spend;
  const lastTs = newestGrokCall(sqlite, account);
  const idleHours = lastTs ? round((nowMs - new Date(lastTs).getTime()) / HOUR_MS, 1) : null;
  const perPoint = calibration?.usd_per_point ?? null;
  // An estimate needs indexed traffic in the window: an empty window is "no
  // reading", not 0%.
  const percentEst = perPoint && spend.turns > 0 ? round(spend.usd / perPoint, 1) : null;
  const measurementAgeMinutes = activeMeasured
    ? round(Math.max(0, (nowMs - new Date(activeMeasured.ts).getTime()) / 60_000), 1)
    : null;
  const current: GrokCurrentWindow = {
    window_start: startIso,
    window_end: endIso,
    anchored: activeMeasured != null || anchor,
    anchor_ts: activeMeasured?.period_start ?? cfg.reset_anchor?.ts ?? null,
    reset_in_hours:
      activeMeasured || anchor ? round((new Date(endIso).getTime() - nowMs) / HOUR_MS, 1) : null,
    spend,
    percent_measured: activeMeasured?.percent ?? null,
    measured_at: activeMeasured?.ts ?? null,
    measurement_age_minutes: measurementAgeMinutes,
    measurement_source: activeMeasured ? "grok_billing" : null,
    percent_est: percentEst,
    remaining_usd:
      perPoint && percentEst != null ? round(Math.max(0, 100 - percentEst) * perPoint) : null,
    idle_hours: idleHours,
  };
  if (activeMeasured) {
    caveats.push(
      `Procent ${activeMeasured.percent}% i reset ${activeMeasured.resets_at} są ODCZYTANE z Billing Groka ` +
        `(${measurementAgeMinutes ?? 0} min temu). Tokeny i koszt obok pochodzą z lokalnego indeksu i mogą obejmować tylko część ruchu widzianego przez konto.`
    );
  }
  if (calibration) {
    caveats.push(
      `Skalę ustawia jeden odczyt: ${deepest!.percent}% przy $${deepest!.spend.usd} zaindeksowanego zużycia, ` +
        `czyli $${calibration.usd_per_point}/punkt. To DOLNE ograniczenie kosztu punktu — każdy dolar zjedzony przez czat grok.com podnosi je i nie widać go stąd.`
    );
    if (calibration.visible_share >= 1) {
      caveats.push(
        "Kalibracja przypisuje CAŁY tygodniowy pool ruchowi z CLI (`visible_share` = 1). Jeśli grok.com też z niego jadł, ustaw proporcję w grok-gauge.json — cała skala przeliczy się sama."
      );
    }
    if (activeMeasured) {
      caveats.push(
        "Ręczna kalibracja nie steruje już procentem na karcie. Służy wyłącznie do wyceny całego okna i jako fallback, gdy odczyt Billing jest niedostępny."
      );
    } else if (anchor) {
      const a = cfg.reset_anchor!;
      const bounds =
        a.last_refusal_ts && a.first_success_ts
          ? ` Reset zaciśnięty między ostatnią odmową (${a.last_refusal_ts}) a pierwszą udaną turą (${a.first_success_ts}).`
          : "";
      caveats.push(
        `Okno jest ZAKOTWICZONE na zadeklarowanym resecie ${a.ts}${
          a.precision === "day" ? " (znany DZIEŃ, nie godzina — granica okna może być przesunięta o kilkanaście godzin)" : ""
        }.${bounds} To awaryjna deklaracja poparta logiem CLI; aktywny odczyt Billing ma przed nią pierwszeństwo.`
      );
    } else {
      caveats.push(
        "Okno jest KROCZĄCE i zastępcze, nie zmierzone: obejmuje 7 dni do ostatniej zaindeksowanej tury, bo vendor nie podaje momentu resetu. Procent opada, gdy stary ruch wypada z okna — to starzenie się próbki, nie reset. Pierwsza chwila, w której grok znowu odpowie, jest kotwicą; wpisz ją jako `reset_anchor` w grok-gauge.json."
      );
    }
    caveats.push(
      "„Wyczerpany” znaczy „co najmniej 100%”: nie wiadomo, ile pracy odbiło się od ściany. Punkt jest więc realnie nie droższy niż policzony, a procent liczony dalej — nie niższy niż pokazany."
    );
  }
  if (!activeMeasured && !anchor && idleHours != null && idleHours > 24) {
    caveats.push(
      `Ostatnia tura CLI była ${Math.round(idleHours / 24)} dni temu. Jeśli reset wypadł od tego czasu, zaindeksowane zużycie należy do POPRZEDNIEGO okna, a nie do tego, które konto właśnie wyczerpało — wtedy ta skala opisuje tamten tydzień.`
    );
  }
  if (spend.turns === 0) {
    caveats.push(
      activeMeasured
        ? "W bieżącym okresie nie ma lokalnych tur CLI, ale procent konta nadal jest prawidłowy: Billing obejmuje także ruch spoza tego indeksu."
        : anchor
        ? "W biezacym oknie nie ma ani jednej tury CLI. Procent 0 znaczy wiec: CLI nie tknelo tego tygodnia. To NIE znaczy, ze konto ma pelny pool - czat grok.com jada z tego samego poola i nie zostawia tu sladu."
        : "W bieżącym oknie kroczącym nie ma ani jednej tury CLI — procent poniżej opisuje pusty odcinek, nie puste konto."
    );
  }
  return {
    configured: true,
    plan: activeMeasured?.plan ?? cfg.plan ?? null,
    window_hours: windowHours,
    observations: reports,
    calibration,
    current,
    caveats,
  };
}
