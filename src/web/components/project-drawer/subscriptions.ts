import type { ReceiptLine } from "../mix";
import type { SubscriptionSpend, PlanPeriod } from "../../lib/api";
import { translate } from "../../lib/i18n";
import { dayRangeLabel, formatMoney } from "../../lib/mixFormat";
import { subscriptionPlan, subscriptionPlanHistory } from "../../lib/subscription-plan";

export interface SplitLine extends ReceiptLine {
  tokens: number;
  /** "pro → max-5x" when the plan changed in the range; null for a single plan. */
  planHistory: string | null;
  /** The plan periods in the range, one per line (the plan chip's tooltip). */
  planTooltip?: string | null;
}

export function planHistoryLine(spend: SubscriptionSpend | null): string | null {
  const label = subscriptionPlanHistory(spend);
  return label?.includes("→") ? label : null;
}

/** The plan the account ended the range on; the full history lives in the chip's tooltip. */
export function currentPlan(line: Pick<SplitLine, "plan" | "planHistory">): string | null {
  const source = line.planHistory ?? line.plan;
  if (!source) return null;
  return source.split("→").pop()!.trim() || null;
}

export function usedHint(): string {
  return translate(
    "used N% - the share of subscription capacity used in this period. Above 100% (⚠) is impossible and indicates an understated window.",
    "wyk. N% - jaka część pojemności abonamentu poszła w tym okresie; cena się w tym ilorazie skraca; ponad 100% (⚠) jest niemożliwe i znaczy zaniżone okno.",
  );
}

export function windowMeasurementHint(): string {
  return translate(
    "window measurement - coverage 68% means calibration dates overlap 68% of the selected range. It is not the percentage of limit used. A 1-reading label describes sample quality; later non-zero readings improve it. It affects capacity conversions only, not actual amounts.",
    "pomiar okna - „pokrycie 68%” znaczy, że daty kalibracji nakładają się na 68% wybranego zakresu; to nie jest procent wykorzystania limitu. „1 odczyt” opisuje jakość próbki, którą poprawiają kolejne niezerowe odczyty z następnych okien. Wpływa tylko na przeliczenia pojemności, nie na rzeczywiste kwoty.",
  );
}

/** The subscription's plan periods in the range, one line each, for the plan chip's tooltip. */
export function planPeriodsTooltip(spend: SubscriptionSpend | null): string | null {
  if (!spend) return null;
  if (spend.plan_periods.length === 0) {
    return translate("No plan period covers these days. Price falls back to rate-cards.json.", "Tych dni nie opisał żaden okres planu - cena spadła na wartość z rate-cards.json.");
  }
  const source = (p: PlanPeriod) =>
    p.source === "declared" ? translate("declaration", "deklaracja")
      : p.source === "observed" ? translate("observed", "obserwowany")
      : p.source === "inferred" ? translate("inferred from readings", "przyjęty z odczytów")
      : translate("catalog", "cennik");
  // A stretch inside a billing cycle shows the cycle's price as paid, its USD equivalent and the NBP rate behind it.
  const cyclePrice = (cycle: NonNullable<PlanPeriod["cycle"]>) => {
    const kind = cycle.source === "declared" ? translate("payment", "płatność")
      : cycle.source === "repeated" ? translate("repeated payment", "powtórzona płatność") : translate("catalog", "cennik");
    const paid = cycle.amount == null ? "—" : cycle.currency && cycle.currency !== "USD" ? `${cycle.amount.toFixed(2)} ${cycle.currency}` : formatMoney(cycle.amount);
    const usd = cycle.currency && cycle.currency !== "USD"
      ? ` ≈ ${cycle.usd != null ? formatMoney(cycle.usd) : "?"}${cycle.fx?.effective_day ? ` (NBP ${cycle.fx.effective_day}${cycle.fx.usd_rate != null ? `, ${cycle.fx.usd_rate}` : ""})` : ` (${translate("NBP rate pending", "kurs NBP w drodze")})`}`
      : "";
    return `${paid}${usd} / ${translate("cycle", "cykl")} · ${kind}`;
  };
  const lines = [
    translate("plan from account periods", "plan z okresów kont"),
    ...spend.plan_periods.map((p) => `${dayRangeLabel(p.from, p.until)} · ${subscriptionPlan(spend.vendor, p.plan, p.from) ?? "—"} · ${p.cycle ? cyclePrice(p.cycle)
      : `${p.usd_per_month != null ? formatMoney(p.usd_per_month) : "—"} · ${source(p)}`}`),
  ];
  if (spend.usd_per_month != null) {
    lines.push(`${translate("avg.", "śr.")} ${formatMoney(spend.usd_per_month)}/${translate("month", "mies.")}`);
  }
  return lines.join("\n");
}

