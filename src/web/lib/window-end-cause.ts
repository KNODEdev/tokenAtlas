import type { BillingCycleWindow } from "../../shared/billing-cycles";
import type { Tone } from "../components/ui";

type T = (english: string, polish: string) => string;
export type EndCause = NonNullable<BillingCycleWindow["cause"]>;

export const causeLabel = (cause: EndCause | null, t: T) => cause === "scheduled" ? t("Scheduled reset", "Planowy reset")
  : cause === "provider" ? t("Provider reset", "Reset dostawcy") : cause === "provider_probable" ? t("Provider reset (probable)", "Reset dostawcy (prawdopodobny)")
  : cause === "banked" ? t("Banked reset", "Reset banked") : cause === "unknown" ? t("Unidentified", "Nieustalony")
  : cause === "single" ? t("Single-account reset", "Reset pojedynczego konta") : cause === "plan_change" ? t("Plan change", "Zmiana planu")
  : cause === "not_reset" ? t("Continued (no reset)", "Kontynuacja (bez resetu)") : cause === "open" ? t("Ongoing", "Trwa") : "—";

/**
 * The ink of an end: an early reset that adds capacity is green, one whose kind is uncertain ochre, the live window the
 * accent, a scheduled end and the ends that add nothing neutral.
 */
export function causeTone(cause: EndCause | null): Tone {
  switch (cause) {
    case "provider": case "banked": case "single": return "ok";
    case "provider_probable": case "unknown": return "warn";
    case "open": return "accent";
    default: return "neutral";
  }
}

/** A window's length: "7 d", "2 d 15 h", "5 h 30 min". */
export function durationText(fromIso: string, untilIso: string, t: T): string {
  const minutes = Math.max(0, Math.round((Date.parse(untilIso) - Date.parse(fromIso)) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  const d = t("d", "d"), h = t("h", "h"), min = t("min", "min");
  if (days) return hours ? `${days} ${d} ${hours} ${h}` : `${days} ${d}`;
  return rest && hours < 10 ? `${hours} ${h} ${rest} ${min}` : `${hours} ${h}`;
}
