import type { CSSProperties } from "react";
import type { BillingCycle } from "../../shared/billing-cycles";
import { useI18n } from "../lib/i18n";
import { planName } from "./AccountHistoryTimeline";

/**
 * Billing cycles in Settings → Accounts (docs/billing-cycles-design-2026-10-08.md §7, approved by the user 08.10): thin
 * dividers with a price and % label on the plan lane, and the cycle rows of the "Subscription" table. Everything is
 * read from `/api/billing-cycles`; nothing is computed here beyond formatting.
 */
type T = (english: string, polish: string) => string;

export function cycleMoney(amount: number | null, currency: string | null, locale: string): string {
  if (amount === null) return "?";
  const number = amount.toLocaleString(locale, { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 });
  if (currency === "USD") return `$${number}`;
  if (currency === "EUR") return `${number} €`;
  return currency ? `${number} ${currency}` : number;
}
/** Day and month on this computer's clock, as every date of the subscription table. */
const dayMonth = (value: string, locale: string) => new Date(value).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
const number = (value: number, locale: string, digits = 2) => value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "≈" an uncertain payment day; "?" a cycle inferred from readings (§7). */
export function cycleMarks(cycle: BillingCycle): string {
  return `${cycle.basis === "inferred" ? "?" : ""}${cycle.anchor_uncertain ? "≈" : ""}`;
}
export function cycleBasis(cycle: BillingCycle, t: T): string {
  return cycle.basis === "declared" ? t("Your declaration", "Twój wpis") : cycle.basis === "observed" ? t("From readings", "z odczytów")
    : t("Inferred from readings", "przyjęte z odczytów");
}
/** The kind of a cycle's price after its amount: none for a receipt, "rep." for a repeated one, "cat." for a catalog price. */
export function priceKind(cycle: BillingCycle, t: T): string {
  return cycle.price.amount === null || cycle.price.source === "declared" ? "" : cycle.price.source === "repeated" ? t("rep.", "powt.") : t("cat.", "kat.");
}
/** What the cycle cost: the declared amount, the same payment repeated, or the catalog price (both marked). */
export function cyclePrice(cycle: BillingCycle, t: T, locale: string): string {
  const money = cycleMoney(cycle.price.amount, cycle.price.currency, locale), kind = priceKind(cycle, t);
  return kind ? `${money} ${kind}` : money;
}
/** The price in USD: the amount itself for USD, else the NBP conversion; null while unknown. */
export function cycleUsd(cycle: BillingCycle): number | null {
  return cycle.price.usd ?? (cycle.price.currency === "USD" ? cycle.price.amount : null);
}
/** Where a price comes from and how it became dollars, for its tooltip. */
function priceTitle(cycle: BillingCycle, t: T, locale: string): string {
  const kind = cycle.price.amount === null ? t("Price unknown", "Cena nieznana")
    : cycle.price.source === "declared" ? t("Receipt", "Dowód płatności")
    : cycle.price.source === "repeated" ? t("The last full-cycle payment, repeated", "Ostatnia płatność za pełny cykl, powtórzona")
    : t("Catalog price, not a payment", "Cena z cennika, nie płatność");
  const fx = cycle.price.fx;
  if (!fx) return kind;
  if (fx.usd_rate === null || fx.rate === null) return `${kind} · ${t("NBP rate pending", "kurs NBP w drodze")}`;
  const rate = (value: number) => value.toLocaleString(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const pair = fx.currency === "PLN" ? `USD ${rate(fx.usd_rate)} PLN` : `${fx.currency} ${rate(fx.rate)} PLN · USD ${rate(fx.usd_rate)} PLN`;
  return `${kind} · NBP ${fx.table ?? ""} ${fx.effective_day ?? ""}: ${pair}`.replace(/\s+/g, " ");
}

/** The lane's dividers and labels: one block per cycle, over the plan bars (inferred cycles have no bar under them). */
export function CycleLaneMarks({ cycles, provider, from, until, position, marked, onSelect }: {
  cycles: BillingCycle[]; provider: string; from: number; until: number;
  position: (key: string, start: number, stop: number) => CSSProperties;
  /** Class names for a cycle key ("cycle|<start>") that is selected or hovered in the timeline. */
  marked?: (key: string) => string;
  /** Selects an inferred cycle, which has no plan bar under it to take the click. */
  onSelect?: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  return <>{cycles.filter((cycle) => Date.parse(cycle.end) > from && Date.parse(cycle.start) < until).map((cycle) => {
    const key = `cycle|${cycle.start}`, start = Date.parse(cycle.start), stop = Date.parse(cycle.end);
    const pct = cycle.used_pct === null ? null : `${Math.round(cycle.used_pct)}%`;
    const price = cycleMoney(cycle.price.amount, cycle.price.currency, locale);
    const label = [cycleMarks(cycle) + (cycle.basis === "inferred" ? ` ${planName(cycle.plan, provider, cycle.start)} ` : "") + price, pct].filter(Boolean).join(" · ").trim();
    const title = `${t("Billing cycle", "Cykl")} ${dayMonth(cycle.start, locale)}–${dayMonth(cycle.end, locale)} · ${planName(cycle.plan, provider, cycle.start)} · ${cyclePrice(cycle, t, locale)}`
      + `${pct ? ` · ${t("used", "zużyto")} ${pct}` : ""} · ${cycleBasis(cycle, t)}${cycle.anchor_uncertain ? ` · ${t("payment date uncertain", "data płatności niepewna")}` : ""}`;
    return <div key={key} className={`account-history-cycle is-${cycle.basis}${cycle.anchor_uncertain ? " is-uncertain" : ""}${cycle.current ? " is-current" : ""}${marked?.(key) ?? ""}`}
      style={position(key, start, stop)} title={title} data-cycle={cycle.start}
      onClick={cycle.basis === "inferred" && onSelect ? () => onSelect(key) : undefined}>
      <span className="mono">{label}</span>
    </div>;
  })}</>;
}

/** A cycle's figures for its row in the subscription table: what it cost, the windows it held, what it used and was worth. */
export function cycleFigures(cycle: BillingCycle, t: T, locale: string) {
  const pct = (value: number | null) => value === null ? "—" : `${Math.round(value)} %`;
  const usd = cycleUsd(cycle);
  const api = cycle.api_usd ?? cycle.unmetered?.api_usd ?? null;
  // One window point in dollars: the stored per-point price scaled from the price's currency.
  const point = cycle.per_window_point === null ? null : usd === null ? null
    : cycle.price.amount ? cycle.per_window_point * usd / cycle.price.amount : 0;
  return {
    price: cyclePrice(cycle, t, locale), priceTitle: priceTitle(cycle, t, locale),
    usd: usd === null ? cycle.price.amount === null ? "—" : "?" : cycleMoney(usd, "USD", locale),
    windows: cycle.windows.touched ? number(cycle.windows.share + cycle.windows.idle, locale)
      : cycle.unmetered ? `≈${number(cycle.unmetered.windows, locale)} ${t("without %", "bez %")}` : "—",
    windowsTitle: cycle.windows.touched ? `${number(cycle.windows.share, locale)} ${t("windows", "okien")} + ${number(cycle.windows.idle, locale)} ${t("idle", "przerw")} · ${cycle.windows.touched} ${t("touched", "dotkniętych")}`
      + (cycle.windows.observed_share !== null && cycle.windows.observed_share < 0.999 ? ` · ${t("readings cover", "odczyty pokrywają")} ${Math.round(cycle.windows.observed_share * 100)}%` : "") : undefined,
    used: cycle.current && cycle.to_date ? `${pct(cycle.used_pct)} (${t("to date", "do dziś")} ${pct(cycle.to_date.used_pct)})` : pct(cycle.used_pct),
    usedTitle: cycle.projection ? `${t("minimal projection", "projekcja minimalna")}: ${number(cycle.projection.windows_min, locale)} ${t("windows", "okien")} → ${pct(cycle.projection.used_pct)}` : undefined,
    api: `${api === null ? "—" : Math.round(api).toLocaleString(locale)} / ${cycle.capacity_usd === null ? "—" : Math.round(cycle.capacity_usd).toLocaleString(locale)}`,
    point: point === null ? "—" : cycleMoney(point, "USD", locale),
  };
}
