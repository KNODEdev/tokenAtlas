import { getLocale, translate } from "./i18n";
import { isCodexInternalReview } from "../../shared/codex-internal";

export function usageModelLabel(model: string): string {
  return isCodexInternalReview(model)
    ? translate("Codex internal review", "Wewnętrzne review Codexa") : model;
}

export function compact(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9, digits) + "B";
  if (abs >= 1e6) return trim(n / 1e6, digits) + "M";
  if (abs >= 1e3) return trim(n / 1e3, abs >= 1e5 ? 0 : 1) + "k";
  return trim(n, 0);
}
function trim(n: number, digits: number): string {
  return n.toLocaleString(getLocale(), { maximumFractionDigits: digits, useGrouping: false });
}
export function full(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString(getLocale()).replace(/\u00a0/g, " ");
}
/** Polish count noun: 1 → one; 2–4 except 12–14 → few; otherwise many. */
export function polishPlural(n: number, one: string, few: string, many: string): string {
  const units = Math.abs(n) % 10, tens = Math.abs(n) % 100;
  return n === 1 ? one : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}
/** "23 020 requests" / "43 żądania": a whole count with its noun in the active language. */
export function countLabel(n: number, en: [string, string], pl: [string, string, string]): string {
  return `${full(n)} ${translate(n === 1 ? en[0] : en[1], polishPlural(n, ...pl))}`;
}
export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return "$" + n.toLocaleString(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const WORKDAY_HOURS = 8;
function qty(n: number): string {
  if (n >= 100) return full(n);
  const r = Math.round(n * 10) / 10;
  return r.toLocaleString(getLocale(), { minimumFractionDigits: Number.isInteger(r) ? 0 : 1, maximumFractionDigits: 1 });
}
export function workTimeLine(hoursTotal: number | null | undefined): string | null {
  if (hoursTotal == null || !Number.isFinite(hoursTotal) || hoursTotal < 0) return null;
  return `≈ ${qty(hoursTotal)} h · ≈ ${qty(hoursTotal / WORKDAY_HOURS)} ${translate("workdays", "dni rob.")} (${WORKDAY_HOURS}h)`;
}
export function duration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "—";
  const totalMin = Math.round(hours * 60);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}
export function dayMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }).format(d);
}
export function dayTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const datePart = new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }).format(d);
  const timePart = new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${datePart} ${timePart}`;
}
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function signedPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "\u2212" : "";
  return sign + Math.abs(n).toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
}
export function signedPp(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "\u2212" : "";
  return sign + Math.abs(n).toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }) + " pp";
}
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return translate("just now", "przed chwilą");
  if (mins < 60) return `${mins} ${translate("min ago", "min temu")}`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} ${translate("h ago", "h temu")}`;
  return `${Math.round(h / 24)} ${translate("days ago", "dni temu")}`;
}
