import { useMemo } from "react";
import type { CalendarGranularity, RepoBucketPoint } from "../../lib/api";
import type { I18nValue } from "../../lib/i18n";
import { translate } from "../../lib/i18n";
import { calendarDateLabels } from "../../lib/chart-dates";
import { duration, full } from "../../lib/format";
import { formatQty, formatMoney, MONEY_LABEL } from "../../lib/mixFormat";
import type { PlanUnit } from "../../lib/planUnits";
import { spacedTicks } from "../WindowBarChart";
import { hours } from "./format";

type SubDollars = { api_usd: number; billed_usd: number | null };

type VendorCoverage = { vendor: string; first: string | null; last: string | null };

function vendorForSeries(id: string, vendorBySub: Record<string, string>): string | undefined {
  return vendorBySub[id] || vendorBySub[id.toLowerCase()] || undefined;
}

function vendorCoversBucket(bucket: string, vendor: string, coverage: VendorCoverage[]): boolean {
  const row = coverage.find((c) => c.vendor === vendor);
  if (!row || row.first == null) return false;
  if (bucket < row.first) return false;
  if (row.last != null && bucket > row.last) return false;
  return true;
}

function uncoveredSeries(
  bucket: string,
  seriesIds: string[],
  coverage: VendorCoverage[],
  vendorBySub: Record<string, string>,
): string[] {
  return seriesIds.filter((id) => {
    const vendor = vendorForSeries(id, vendorBySub);
    if (vendor == null) return true;
    return !vendorCoversBucket(bucket, vendor, coverage);
  });
}

function knownBilledSum(values: Iterable<SubDollars>): number {
  let sum = 0;
  for (const v of values) {
    if (v.billed_usd == null) continue;
    sum += v.billed_usd;
  }
  return sum;
}

function sortSubDollars(entries: Array<[string, SubDollars]>): Array<[string, SubDollars]> {
  return [...entries].sort((a, b) => {
    const av = a[1].billed_usd;
    const bv = b[1].billed_usd;
    if (av == null && bv == null) return a[0].localeCompare(b[0]);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

export function formatPct(pct: number): string {
  return `${pct > 0 && pct < 10 ? pct.toFixed(1) : formatQty(Math.round(pct))}%`;
}

/** "of one 7-day window" / "jednego okna 7-dniowego". */
function windowPhrase(windowHours: number | null): string {
  if (windowHours == null) return translate("of one window", "jednego okna");
  return windowHours % 24 === 0
    ? translate("of one {0}-day window", `jednego okna ${formatQty(windowHours / 24)}-dniowego`, [formatQty(windowHours / 24)])
    : translate("of one {0}h window", `jednego okna ${formatQty(windowHours)}h`, [formatQty(windowHours)]);
}

export interface MixChartData {
  points: RepoBucketPoint[];
  totalsBySub?: Record<string, SubDollars>;
  /** Window capacity per subscription, for the "% of window limit" unit. */
  units?: PlanUnit[];
  vendorCoverage?: VendorCoverage[];
  vendorBySub?: Record<string, string>;
  granularity: CalendarGranularity;
}

interface ModelOptions {
  unitMode: "usd" | "pct";
  chartWidth: number;
  hoverIdx: number | null;
  hideValues: boolean;
  idleGap: number;
  nameOf: (id: string) => string;
  t: I18nValue["t"];
  locale: string;
}

interface PlotBar {
  id: string | null;
  pct: number | null;
  single: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Presentation of the supplied history only; no reads, valuation or persistent state. */
export function useProjectMixModel(
  { points, totalsBySub, units = [], vendorCoverage = [], vendorBySub = {}, granularity }: MixChartData,
  { unitMode, chartWidth, hoverIdx, hideValues, idleGap, nameOf, t, locale }: ModelOptions,
) {
  const activeSubs = useMemo(
    () => sortSubDollars(Object.entries(totalsBySub ?? {})),
    [totalsBySub],
  );
  const seriesIds = useMemo(() => activeSubs.map(([k]) => k), [activeSubs]);
  // The history may carry no allocated plan cost at all; then the bars show the API catalog value
  // instead of empty stubs, and every label says which measure is drawn.
  const measure: "billed" | "api" = points.some((p) => knownBilledSum(Object.values(p.by_sub ?? {})) > 0 || (p.billed_usd ?? 0) > 0) ? "billed" : "api";
  const valueOf = (v: SubDollars): number | null => (measure === "billed" ? v.billed_usd : v.api_usd);
  const pointValue = (p: RepoBucketPoint): number | null => (measure === "billed" ? p.billed_usd : p.api_usd);
  const pointIncomplete = (p: RepoBucketPoint): boolean => (measure === "billed" ? p.billed_complete === false : p.api_complete === false);
  const measureLabel = measure === "billed" ? MONEY_LABEL.billed : t("value at API prices", "wartość wg cennika API");
  // The title names what one bar is: whose money, which prices, per which period.
  const perPeriod = granularity === "day" ? t("$ per day", "$ na dzień") : granularity === "month" ? t("$ per month", "$ na miesiąc") : t("$ per week", "$ na tydzień");
  const chartTitle = measure === "billed"
    ? `${t("Cost from your subscriptions", "Koszt z Twoich abonamentów")} · ${perPeriod}`
    : `${t("Project traffic value at API prices", "Wartość ruchu projektu wg cennika API")} · ${perPeriod}`;
  // "% of window limit": each subscription's API-value spend over ONE full window of its own plan.
  // Limits differ per plan, so these bars sit side by side and are never summed.
  const pctMode = unitMode === "pct";
  const unitOf = (id: string): PlanUnit | null => units.find((u) => u.id.toLowerCase() === id.toLowerCase()) ?? null;
  const capacityOf = (id: string): PlanUnit | null => {
    const unit = unitOf(id);
    return unit && unit.basis !== "none" && unit.windowValue != null && unit.windowValue > 0 ? unit : null;
  };
  const pctOf = (id: string, p: RepoBucketPoint): number | null => {
    const unit = capacityOf(id);
    const spend = p.by_sub?.[id]?.api_usd;
    return unit && spend != null ? (spend / unit.windowValue!) * 100 : null;
  };
  const pctSeries = seriesIds.filter((id) => capacityOf(id) != null);
  const maxPct = Math.max(100, ...points.flatMap((p) => pctSeries.map((id) => pctOf(id, p) ?? 0)));
  const pctLine = (id: string, p: RepoBucketPoint): string => {
    const unit = capacityOf(id);
    if (!unit) return `  ${nameOf(id)}: ${t("no window measurement", "brak pomiaru okna")}`;
    if (hideValues) return `  ${nameOf(id)}`;
    const single = unit.basis === "single" ? ` · ${t("1 reading", "1 odczyt")}` : "";
    return `  ${nameOf(id)}: ${formatPct(pctOf(id, p) ?? 0)} ${windowPhrase(unit.windowHours)} (${formatMoney(p.by_sub?.[id]?.api_usd ?? 0)} ${t("of", "z")} ${formatMoney(unit.windowValue)})${single}`;
  };
  const periodWord = granularity === "day" ? t("per day", "na dzień") : granularity === "month" ? t("per month", "na miesiąc") : t("per week", "na tydzień");
  const shownTitle = pctMode ? `${t("Share of each subscription's window limit", "Udział w limicie okna każdej subskrypcji")} · ${periodWord}` : chartTitle;
  const totalsIncomplete =
    activeSubs.some(([, v]) => valueOf(v) == null) || points.some(pointIncomplete);
  const anyUncovered = points.some(
    (p) => uncoveredSeries(p.bucket, seriesIds, vendorCoverage, vendorBySub).length > 0,
  );
  if (points.length === 0) return null;
  const W = 100;
  const H = 180;
  const padTop = 8;
  const padBottom = 22;
  const plotH = H - padTop - padBottom;
  const limitY = padTop + plotH * (1 - 100 / maxPct);
  const maxBilled = Math.max(
    ...points.map((p) => {
      const memberSum = Object.values(p.by_sub ?? {}).reduce((sum, v) => sum + (valueOf(v) ?? 0), 0);
      if (memberSum > 0) return memberSum;
      const total = pointValue(p);
      return total != null && total > 0 ? total : 0;
    }),
    0.01
  );
  const maxSeconds = Math.max(...points.map((p) => p.active_seconds || 0), 1);
  const slot = W / points.length;
  const barW = Math.max(slot * 0.65, 0.7);
  const linePts = points
    .map((p, i) => {
      const x = i * slot + slot / 2;
      const y = padTop + plotH * (1 - (p.active_seconds || 0) / maxSeconds);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const dateLabels = calendarDateLabels(points.map(point => point.bucket), locale);
  const keptDates = spacedTicks(dateLabels.map((text, index) => ({ text, center: (index + 0.5) * chartWidth / points.length })));
  const hoveredPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoveredUncovered = hoveredPoint
    ? uncoveredSeries(hoveredPoint.bucket, seriesIds, vendorCoverage, vendorBySub)
    : [];

  const buckets = points.map((p, i) => {
    const x = i * slot + (slot - barW) / 2;
    const uncovered = uncoveredSeries(p.bucket, seriesIds, vendorCoverage, vendorBySub);
    const incomplete = pctMode ? p.api_complete === false : pointIncomplete(p);
    const bars: PlotBar[] = [];
    let tooltip: string;
    let hasStack: boolean;
    let incompleteY: number;
    let incompleteHeight: number;
    let showIncomplete: boolean;
    if (pctMode) {
      const bw = barW / Math.max(pctSeries.length, 1);
      const values = pctSeries.map((id, j) => ({ id, j, pct: pctOf(id, p) ?? 0 })).filter((b) => b.pct > 0);
      const tallest = Math.max(0, ...values.map((b) => b.pct));
      const listed = [...new Set([...seriesIds, ...Object.keys(p.by_sub ?? {})])];
      for (const b of values) {
        const h = (plotH * b.pct) / maxPct;
        bars.push({ id: b.id, pct: b.pct, single: capacityOf(b.id)!.basis === "single",
          x: x + b.j * bw, y: padTop + plotH - h, width: Math.max(bw * 0.9, 0.3), height: Math.max(h, 0.1) });
      }
      tooltip = `${p.bucket}${hideValues ? `\n${t("values hidden", "liczby ukryte")}` : ""}${incomplete ? `\n${t("incomplete", "niepełne")}` : ""}\n\n${t("Subscriptions", "Subskrypcje")}:\n` +
                  listed.map((id) => (uncovered.includes(id) && !p.by_sub?.[id] ? `  ${nameOf(id)}: ${t("no data", "brak danych")}` : pctLine(id, p))).join("\n");
      hasStack = bars.length > 0;
      incompleteY = padTop + plotH - (plotH * tallest) / maxPct;
      incompleteHeight = (plotH * tallest) / maxPct;
      showIncomplete = incomplete && bars.length > 0;
    } else {
      let currentY = padTop + plotH;
      const members = sortSubDollars(Object.entries(p.by_sub ?? {}));
      const knownBars = members.filter((entry): entry is [string, SubDollars] => (valueOf(entry[1]) ?? 0) > 0);
      const stackBaseY = currentY;
      const uncoveredSet = new Set(uncovered);
      const memberIds = new Set(members.map(([k]) => k));
      const memberLines = [
        ...members.map(([k, v]) => uncoveredSet.has(k)
          ? `  ${nameOf(k)}: ${t("no data", "brak danych")}`
          : `  ${nameOf(k)}: ${valueOf(v) == null ? "—" : formatMoney(valueOf(v))}`),
        ...uncovered.filter((id) => !memberIds.has(id)).map((id) => `  ${nameOf(id)}: ${t("no data", "brak danych")}`),
      ].join("\n");
      hasStack = knownBars.length > 0 || (pointValue(p) ?? 0) > 0;
      tooltip = hideValues
                   ? `${p.bucket}\n${t("values hidden", "liczby ukryte")}` +
                     (incomplete ? `\n${t("incomplete", "niepełne")}` : "") +
                     (uncovered.length > 0 ? `\n${t("no data", "brak danych")}` : "") +
                     (members.length > 0 || uncovered.length > 0
                       ? `\n\n${t("Subscriptions", "Subskrypcje")}:\n` +
                         [
                           ...members.map(([k]) => `  ${nameOf(k)}`),
                           ...uncovered.filter((id) => !memberIds.has(id)).map((id) => `  ${nameOf(id)}`),
                         ].join("\n")
                       : "")
                   : `${p.bucket}\n` +
                     `${measureLabel}: ${formatMoney(pointValue(p))}${incomplete ? ` · ${t("incomplete", "niepełne")}` : ""}${uncovered.length > 0 ? ` · ${t("no data", "brak danych")}` : ""}\n` +
                     `${t("API catalog", "Cennik API")}: ${formatMoney(p.api_usd)}${p.api_complete === false ? ` · ${t("incomplete", "niepełne")}` : ""}\n` +
                     `${t("Active time", "Czas aktywny")}: ≈ ${duration(hours(p.active_seconds))} (${t("threshold", "próg")} ${idleGap}m)\n` +
                     `${t("Tokens", "Tokeny")}: ${full(p.tokens)}` +
                     (memberLines ? `\n\n${t("Subscriptions", "Subskrypcje")}:\n` + memberLines : "");
      if (knownBars.length > 0) {
        for (const [k, v] of knownBars) {
          const h = (plotH * (valueOf(v) ?? 0)) / maxBilled;
          currentY -= h;
          bars.push({ id: k, pct: null, single: false, x, y: currentY, width: barW, height: Math.max(h, 0.1) });
        }
      } else if ((pointValue(p) ?? 0) > 0) {
        const h = (plotH * (pointValue(p) ?? 0)) / maxBilled;
        currentY -= h;
        bars.push({ id: null, pct: null, single: false, x, y: currentY, width: barW, height: Math.max(h, 0.1) });
      }
      incompleteY = hasStack ? currentY : padTop + plotH - 2;
      incompleteHeight = hasStack ? stackBaseY - currentY : 2;
      showIncomplete = incomplete;
    }
    return { point: p, index: i, x, barW, bars, incomplete, uncovered, tooltip, hasStack,
      incompleteRect: showIncomplete ? { y: incompleteY, height: incompleteHeight } : null };
  });
  const timeDots = points.map((p, i) => ({ bucket: p.bucket,
    cx: i * slot + slot / 2, cy: padTop + plotH * (1 - (p.active_seconds || 0) / maxSeconds) }));
  const legend = {
    pctMode, totalsIncomplete, anyUncovered,
    rows: activeSubs.slice(0, 6).map(([id, value]) => {
      const unit = unitOf(id);
      const capacity = capacityOf(id);
      return { id, name: nameOf(id), amount: valueOf(value), unit, capacity,
        uncovered: points.some((p) => uncoveredSeries(p.bucket, [id], vendorCoverage, vendorBySub).length > 0),
        peakPct: pctMode && capacity != null && !hideValues ? Math.max(0, ...points.map((p) => pctOf(id, p) ?? 0)) : null };
    }),
  };
  return {
    heading: { pctMode, shownTitle, measureLabel },
    plot: { pctMode, W, H, padTop, plotH, limitY, linePts, timeDots, buckets },
    axis: { dateLabels, keptDates },
    hover: hoveredPoint ? { point: hoveredPoint, amount: pointValue(hoveredPoint),
      incomplete: pointIncomplete(hoveredPoint), uncovered: hoveredUncovered, measureLabel } : null,
    legend,
  };
}

export type ProjectMixModel = NonNullable<ReturnType<typeof useProjectMixModel>>;
