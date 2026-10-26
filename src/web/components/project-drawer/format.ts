import type { CalendarGranularity } from "../../lib/api";
import { translate } from "../../lib/i18n";

export function hours(seconds: number): number {
  return seconds / 3600;
}

export function subjectKey(row: { kind: "project" | "repo"; id: string }): string {
  return `${row.kind === "project" ? "p" : "r"}:${row.id}`;
}

export function granularityOptions(): Array<{ value: CalendarGranularity; label: string; title: string }> {
  return [
    { value: "day", label: translate("Day", "Dzień"), title: translate("Calendar day", "Dzień kalendarzowy") },
    { value: "week", label: translate("Week", "Tydzień"), title: translate("Calendar week", "Tydzień kalendarzowy") },
    { value: "month", label: translate("Month", "Miesiąc"), title: translate("Calendar month", "Miesiąc kalendarzowy") },
  ];
}

export function localizedPlural(
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  const pl = abs === 1 ? plOne : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? plFew : plMany;
  return translate(abs === 1 ? enOne : enMany, pl);
}

export const MASK = "•••";

export function captureFileName(subjectName: string, chart: string, granularity: string): string {
  const slug =
    subjectName
      .toLowerCase()
      .replace(/ł/g, "l")
      .normalize("NFD")
      .replace(/[^a-z0-9]/g, (ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x300 && code <= 0x36f ? "" : "-";
      })
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "projekt";
  return `tokenatlas-${slug}-${chart}-${granularity}.png`;
}
