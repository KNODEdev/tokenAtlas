import { useEffect, useState, type CSSProperties } from "react";
import type { BillingCycle, BillingCycleWindow } from "../../shared/billing-cycles";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useContextPreview } from "../lib/context-premium";
import { billingAccountWithContextPreview } from "../lib/window-context-preview";
import { useI18n, type MessageTranslator } from "../lib/i18n";
import { capacityUnitFormat } from "../lib/codex-capacity";
import {
  RESET_KINDS, allSubscriptions, billingAccountOf, cycleUsdPaid, kindCounts, monthRow, perDollar, perResetCapacity, perWindowPct, periodCycles, pointsFallback, readMonthState, summarize, tokenSplit, writeMonthState,
  type AllUnit, type MonthAmount, type MonthPeriod, type MonthRow, type MonthState, type MonthSummary, type MonthUnit, type PerDollar, type ResetKind,
} from "../lib/subscription-month";
import { providerColor, subscriptionName, type RosterCard } from "../lib/roster";
import type { DataSettingsTarget } from "../lib/data-settings";
import { causeLabel, causeTone, durationText } from "../lib/window-end-cause";
import { subscriptionPlan } from "../lib/subscription-plan";
import { TableRow, Bar, Card, EmptyState, ErrorState, Field, GhostButton, HelpDot, KpiStrip, LoadingCard, Pill, Table, Td, Th, toneColor } from "./ui";
import { cycleMarks, cycleMoney, cyclePrice, priceKind } from "./BillingCycles";
import { productName } from "./SubscriptionCards";
import { planName } from "./AccountHistoryTimeline";
import { ValueChart, type ValueBar } from "./ValueChart";
import "./CodexCapacitySummary.css";
import "./GlobalCapacity.css";
import "./SubscriptionMonth.css";

/**
 * Capacity → "Subscription month" (docs/reset-capacity-plan-2026-10-11.md step 4, approved by the user 11.10): one row
 * per billing cycle of the chosen subscription with its base capacity, the bonuses of early resets by kind (switchable),
 * the total and what was used. Everything is read from `/api/billing-cycles`; only stored numbers are added, subtracted
 * and divided here.
 */
type T = MessageTranslator;

const kindLabel = (kind: ResetKind, t: T) => kind === "automatic" ? t("Automatic (provider)", "Automatyczne (dostawca)")
  : kind === "unidentified" ? t("Unidentified (probably automatic)", "Nieustalone (prawdopodobnie automatyczne)")
  : kind === "banked" ? t("Banked", "Banked") : t("Single-account", "Pojedyncze konto");
/** Short column heads; the full name is the head's title. */
const kindColumn = (kind: ResetKind, t: T) => kind === "automatic" ? t("Automatic", "Automatyczne")
  : kind === "unidentified" ? t("Unidentified", "Nieustalone") : kind === "banked" ? t("Banked", "Banked") : t("Single", "Pojedyncze");
const unitLabel = (unit: MonthUnit, t: T) => unit === "api" ? "API $" : unit === "credits" ? t("Credits", "Kredyty")
  : unit === "tokens" ? t("Tokens", "Tokeny") : t("Window points", "Punkty okna");
const dayMonth = (value: string, locale: string) => new Date(value).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const fullDay = (value: string, locale: string) => new Date(value).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

function formatter(unit: MonthUnit, locale: string, t: T) {
  const pp = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const base = capacityUnitFormat(unit === "api" ? "api_standard" : unit === "credits" ? "credits_low" : "tokens", locale);
  const value = (amount: number) => unit === "pp" ? `${pp.format(amount)} ${t("pp", "pkt")}` : base.full(amount);
  const range = (amount: MonthAmount | { range?: { low: number; high: number } }) => amount.range
    ? `${t("credits", "kredyty")} ${base.full(amount.range.low)}–${base.full(amount.range.high)}` : undefined;
  return { value, range };
}

/** Plain words for the stored flags of a cycle and its calibration. */
function flagWords(cycle: BillingCycle, t: T): string[] {
  const words: string[] = [];
  const flags = new Set(cycle.flags);
  if (cycle.capacity?.calibration.scope === "observed_partial_traffic")
    words.push(t("Only traffic seen on this machine counts — the capacity is a lower bound.", "Liczy się tylko ruch widoczny na tym komputerze — pojemność jest dolną granicą."));
  if (flags.has("capacity_borrowed_windows")) words.push(t("Too few windows inside the cycle: the nearest windows of the same plan were added to the calibration.",
    "Za mało okien w cyklu: do kalibracji dodano najbliższe okna tego samego planu."));
  if (flags.has("capacity_calibration_below_100pp")) words.push(t("The calibration rests on less than 100 window points.", "Kalibracja opiera się na mniej niż 100 punktach okna."));
  if (flags.has("capacity_outliers_excluded")) words.push(t("Windows far from the account's usual value per point were left out.", "Pominięto okna odbiegające od zwykłej wartości punktu tego konta."));
  if (flags.has("capacity_regime_mixed")) words.push(t("The cycle's windows have different capacity regimes: no capacity.", "Okna cyklu mają różne reżimy pojemności: brak pojemności."));
  if (flags.has("capacity_uncalibrated") && !flags.has("capacity_regime_mixed")) words.push(t("No window of this plan can calibrate the capacity yet.", "Żadne okno tego planu nie pozwala jeszcze skalibrować pojemności."));
  if (flags.has("price_unknown")) words.push(t("The price of this cycle is unknown.", "Cena tego cyklu jest nieznana."));
  if (flags.has("anchor_uncertain")) words.push(t("The payment date is uncertain.", "Data płatności jest niepewna."));
  if (flags.has("inferred_from_readings")) words.push(t("The cycle is inferred from readings after the declared end.", "Cykl przyjęto z odczytów po zadeklarowanym końcu."));
  if (flags.has("partial_coverage")) words.push(t("Readings do not cover the whole cycle.", "Odczyty nie pokrywają całego cyklu."));
  if (flags.has("window_end_uncertain")) words.push(t("Some window ends are uncertain.", "Koniec niektórych okien jest niepewny."));
  if (flags.has("window_traffic_unseen")) words.push(t("Some windows' % rose with no traffic stored on this machine: used amounts are unknown.",
    "W niektórych oknach % wzrósł bez ruchu zapisanego na tym komputerze: zużycie jest nieznane."));
  if (flags.has("window_sums_missing")) words.push(t("Some windows have no stored sums: used amounts are unknown.", "Niektóre okna nie mają zapisanych sum: zużycie jest nieznane."));
  return words;
}

const capacityMissing = (cycle: BillingCycle, t: T) => cycle.flags.includes("capacity_regime_mixed")
  ? t("No capacity: the cycle's windows have mixed capacity regimes", "Brak pojemności: okna cyklu mają mieszane reżimy pojemności")
  : t("No capacity: no calibration for this plan yet", "Brak pojemności: brak kalibracji dla tego planu");

const periodLabel = (period: MonthPeriod, t: T) => period === "current" ? t("Current cycle", "Bieżący cykl")
  : period === "previous" ? t("Previous cycle", "Poprzedni cykl") : t("Whole period", "Cały okres");
const pctText = (value: number | null) => value === null ? "—" : `${Math.round(value)}%`;
/** Dates of a period's cycles: one cycle by day and month, several by full days with their count. */
function spanText(cycles: readonly BillingCycle[], locale: string, t: T): string {
  if (!cycles.length) return t("no cycle", "brak cyklu");
  const starts = cycles.map((cycle) => cycle.start).sort(), ends = cycles.map((cycle) => cycle.end).sort();
  return cycles.length === 1 ? `${dayMonth(starts[0]!, locale)}–${dayMonth(ends[0]!, locale)}`
    : `${fullDay(starts[0]!, locale)} – ${fullDay(ends.at(-1)!, locale)} · ${cycles.length} ${t("cycles", "cykli")}`;
}
/** Paid per currency as written; catalog prices marked as in the billing cycles. */
function paidByCurrency(summary: MonthSummary, locale: string, t: T): string {
  if (!summary.paid.length) return "—";
  return summary.paid.map((entry) => `${cycleMoney(entry.amount, entry.currency, locale)}${entry.catalog ? ` ${t("cat.", "kat.")}` : ""}`).join(" · ");
}
/** In USD when every priced cycle has its rate (marked when a catalog price is part of it); otherwise per currency. */
function paidText(summary: MonthSummary, locale: string, t: T): string {
  if (summary.paidUsd === null) return paidByCurrency(summary, locale, t);
  return `${cycleMoney(summary.paidUsd, "USD", locale)}${summary.paid.some((entry) => entry.catalog) ? ` ${t("cat.", "kat.")}` : ""}`;
}

/** One paid dollar's worth: API $ as a multiple ("31×"), other units as an amount per dollar. */
function perFormat(unit: MonthUnit, value: (amount: number) => string, locale: string) {
  const short = (amount: number | null) => amount === null ? "—" : unit === "api"
    ? `${amount.toLocaleString(locale, { maximumFractionDigits: amount < 10 ? 1 : 0 })}×` : value(amount);
  return { short, full: (amount: number | null) => amount === null || unit === "api" ? short(amount) : `${short(amount)} / $1` };
}
/** The sums behind a per-dollar figure, or why there is none. */
function perTitle(per: PerDollar, kind: "used" | "capacity", amount: (value: number | null) => string, locale: string, t: T): string {
  const [sum, paid, cycles] = kind === "used" ? [per.usedSum, per.usedPaid, per.usedCycles] : [per.capacitySum, per.capacityPaid, per.capacityCycles];
  if (!cycles) return kind === "used" ? t("No cycle with both its usage and a price above zero", "Brak cyklu ze znanym zużyciem i ceną powyżej zera")
    : t("No cycle with both a capacity and a price above zero", "Brak cyklu ze znaną pojemnością i ceną powyżej zera");
  return `${kind === "used" ? t("Used", "Zużyto") : t("Capacity", "Pojemność")} ${amount(sum)} ÷ ${t("paid", "zapłacono")} ${cycleMoney(Math.round(paid * 100) / 100, "USD", locale)}`
    + ` · ${cycles} ${cycles === 1 ? t("cycle", "cykl") : t("cycles", "cykli")}`;
}
const returnHelp = (t: T) => t("Return: what was used, at API prices, for each dollar paid. 1× = the same as paying API prices.",
  "Zwrot: ile zużyto według cen API za każdego zapłaconego dolara. 1× = tyle samo, co płacenie według cen API.");
const potentialHelp = (t: T) => t("Potential: the whole capacity for each dollar paid — what the subscription could return.",
  "Potencjał: cała pojemność za każdego zapłaconego dolara — ile abonament mógłby zwrócić.");

const UNIT_ORDER: readonly MonthUnit[] = ["api", "credits", "tokens", "pp"];
/** The same unit choice for one subscription and for all; a unit that does not apply stays visible, disabled, with the reason. */
function UnitChoice({ unit, unavailable, creditsTitle, onChoose }: {
  unit: MonthUnit; unavailable: Partial<Record<MonthUnit, string>>; creditsTitle: string; onChoose: (unit: MonthUnit) => void;
}) {
  const { t } = useI18n();
  return <Field label={t("Unit", "Jednostka")}>
    <div className="ui-choice" role="group" aria-label={t("Unit", "Jednostka")}>
      {UNIT_ORDER.map((value) => <button key={value} type="button" aria-pressed={unit === value} disabled={!!unavailable[value]} data-unit={value}
        title={unavailable[value] ?? (value === "credits" ? creditsTitle : undefined)} onClick={() => onChoose(value)}>{unitLabel(value, t)}</button>)}
    </div>
  </Field>;
}
function ResetChoice({ enabled, counts, state, update }: {
  enabled: ReadonlySet<ResetKind>; counts: Record<ResetKind, number>; state: MonthState; update: (next: MonthState) => void;
}) {
  const { t } = useI18n();
  return <Field label={t("Resets counted", "Liczone resety")} title={t("Scheduled resets are always counted; an end that was not a reset never adds capacity.",
    "Planowe resety są liczone zawsze; koniec, który nie był resetem, nigdy nie dodaje pojemności.")}>
    <div className="ui-choice" role="group" aria-label={t("Resets counted", "Liczone resety")}>
      {RESET_KINDS.map(({ id }) => <button key={id} type="button" aria-pressed={enabled.has(id)} data-reset-kind={id} title={kindLabel(id, t)}
        onClick={() => update({ ...state, off: enabled.has(id) ? [...state.off, id] : state.off.filter((kind) => kind !== id) })}>
        {kindColumn(id, t)} {counts[id]}</button>)}
    </div>
  </Field>;
}
/**
 * One head for both tables (user decision 21.10): only the first column names its rows. A plain function, not a
 * component, because the table reads its column schema from the literal head elements.
 */
function valueHead(first: string, t: T) {
  return <thead><TableRow header>
    <Th columnId="subject">{first}</Th><Th columnId="plan">{t("Plan", "Plan")}</Th>
    <Th columnId="paid" align="right" title={t("In USD at the NBP mid rate of the day before each payment; the price as written in the tooltip",
      "W USD po średnim kursie NBP z dnia przed każdą płatnością; cena jak zapisana w podpowiedzi")}>{t("Paid", "Zapłacono")}</Th>
    <Th columnId="capacity" align="right" title={t("Capacity with the counted early-reset bonuses", "Pojemność z liczonymi premiami z wczesnych resetów")}>{t("Capacity", "Pojemność")}</Th>
    <Th columnId="base" align="right" defaultHidden title={t("Capacity without any early-reset bonus", "Pojemność bez premii z wczesnych resetów")}>{t("Without resets", "Bez resetów")}</Th>
    <Th columnId="resets" align="right" defaultHidden title={t("The bonuses of the counted early resets (their number in brackets)", "Premie z liczonych wczesnych resetów (ich liczba w nawiasie)")}>{t("From resets", "Z resetów")}</Th>
    <Th columnId="used" align="right">{t("Used", "Zużyto")}</Th><Th columnId="used-pct" align="right">{t("Used %", "Zużyto %")}</Th>
    <Th columnId="unused" align="right">{t("Unused", "Niewykorzystane")}</Th>
    <Th columnId="return" align="right" title={returnHelp(t)}>{t("Return", "Zwrot")}</Th>
    <Th columnId="potential" align="right" title={potentialHelp(t)}>{t("Potential", "Potencjał")}</Th>
  </TableRow></thead>;
}
/** The plan with its vendor's ink, as in the subscription rail. */
const PlanCell = ({ color, children }: { color: string; children: string }) =>
  <Td><span className="capacity-subject"><i className="capacity-swatch" style={{ background: color }} />{children}</span></Td>;

function useMonthState(): [MonthState, (next: MonthState) => void] {
  const [state, setState] = useState(readMonthState);
  return [state, (next) => { setState(next); writeMonthState(next); }];
}

function PeriodChoice({ period, pinned, onChoose }: { period: MonthPeriod; pinned: boolean; onChoose: (period: MonthPeriod) => void }) {
  const { t } = useI18n();
  return <Field label={t("Period", "Okres")}>
    <div className="ui-choice" role="group" aria-label={t("Period", "Okres")}>
      {(["current", "previous", "all"] as const).map((value) => <button key={value} type="button" data-period={value}
        aria-pressed={!pinned && period === value} onClick={() => onChoose(value)}>{periodLabel(value, t)}</button>)}
    </div>
  </Field>;
}

/**
 * The capacity of a period against what it used (approved 11.10): the table's own Total and Used summed over the cycles
 * with a capacity; a cycle without one is left out of both and named in a note.
 */
/** Why cycles were left out of the sums: no calibration, or no stored usage in the unit. */
function excludedText(summary: Pick<MonthSummary, "uncalibrated" | "usageUnknown">, t: T): string | null {
  const parts = [
    summary.uncalibrated ? t("{0} {1} without calibration",
      `${summary.uncalibrated} ${summary.uncalibrated === 1 ? "cykl" : "cykle"} bez kalibracji`, [summary.uncalibrated, summary.uncalibrated === 1 ? "cycle" : "cycles"]) : null,
    summary.usageUnknown ? t("{0} {1} without stored usage in this unit",
      `${summary.usageUnknown} ${summary.usageUnknown === 1 ? "cykl" : "cykle"} bez zapisanego zużycia w tej jednostce`, [summary.usageUnknown, summary.usageUnknown === 1 ? "cycle" : "cycles"]) : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(t(" and ", " i "))} ${t("not included", "nie wliczone")}` : null;
}
/** Title of a used amount that is unknown in the unit while the points are known. */
const usageUnknownTitle = (pp: number | null, t: T) => `${t("Usage in this unit not stored for some windows", "Zużycie w tej jednostce nie jest zapisane dla części okien")}${
  pp === null ? "" : `; ${t("points used", "zużyte punkty")}: ${Math.round(pp)}`}`;

/** Window points as windows ("2.44 windows") and as points ("61 pp"): the fallback when the unit's usage is unknown. */
function pointFormats(locale: string, t: T) {
  const windows = (pp: number | null) => pp === null ? "—" : `${(pp / 100).toLocaleString(locale, { maximumFractionDigits: 2 })} ${t("windows", "okien")}`;
  const points = (pp: number | null) => pp === null ? "—" : `${Math.round(pp).toLocaleString(locale)} ${t("pp", "pkt")}`;
  return { windows, points };
}
const pointsNote = (t: T) => t("In window points: usage in this unit is not stored for this cycle (its traffic runs on another machine)",
  "W punktach okna: zużycie w tej jednostce nie jest zapisane dla tego cyklu (jego ruch idzie przez inny komputer)");

function CapacitySummary({ summary: unitSummary, points, heading, span, amount: unitAmount, current, scope, period, pinned, onPeriod, enabled, per, perText }: {
  summary: MonthSummary; heading: string; span: string; amount: (value: number | null) => string; current: BillingCycle | null;
  scope?: string; period: MonthPeriod; pinned: boolean; onPeriod: (period: MonthPeriod) => void; enabled: ReadonlySet<ResetKind>;
  /** The same cycles in window points when none has its usage in the unit. */
  points?: MonthSummary | null;
  /** What one paid dollar bought over the same cycles, in the unit. */
  per: PerDollar; perText: ReturnType<typeof perFormat>;
}) {
  const { t, locale } = useI18n();
  // In points: capacities as windows, the use as points; the paid amounts and the note stay those of the unit.
  const formats = pointFormats(locale, t);
  const summary = points ? { ...points, paid: unitSummary.paid, unpriced: unitSummary.unpriced, uncalibrated: unitSummary.uncalibrated,
    paidUsd: unitSummary.paidUsd, paidUsdMissing: unitSummary.paidUsdMissing,
    usageUnknown: unitSummary.usageUnknown, pointsUsed: unitSummary.pointsUsed, pointWindows: unitSummary.pointWindows, cycles: unitSummary.cycles } : unitSummary;
  const amount = points ? formats.windows : unitAmount, usedAmount = points ? formats.points : unitAmount;
  const over = summary.unused !== null && summary.unused < 0;
  const average = perWindowPct(summary);
  // One reset's worth: in window points it is a whole window by definition, so it is shown in the unit only.
  const perReset = points ? null : perResetCapacity(summary);
  const projection = current?.current && current.to_date
    ? `${t("to date", "do dziś")} ${pctText(current.to_date.used_pct)}${current.projection ? ` · ${t("minimal projection", "projekcja minimalna")} ${pctText(current.projection.used_pct)}` : ""}`
    : null;
  // One row of headline numbers (user decision 17.10); what they are made of goes into their tooltips.
  const split = summary.base === null || summary.capacity === null ? undefined : [
    `${t("Without early resets", "Bez wczesnych resetów")} ${amount(summary.base)} · ${t("resets added", "resety dodały")} +${amount(summary.capacity - summary.base)}`,
    ...RESET_KINDS.map(({ id }) => `${kindLabel(id, t)} +${amount(summary.bonuses[id])}${enabled.has(id) ? "" : ` (${t("not counted", "nie liczone")})`}`),
  ].join("\n");
  const unused = summary.unused === null ? undefined
    : `${over ? t("Over capacity", "Ponad pojemność") : t("Unused", "Niewykorzystane")} ${amount(Math.abs(summary.unused))}`;
  const perWindow = average === null ? undefined
    : t("Average use per window {0}%: how much of each window was used before its end", `Średnie zużycie okna ${Math.round(average)}%: ile z każdego okna zużyto przed jego końcem`, [Math.round(average)]);
  return <div className="capacity-section subscription-month-summary" data-summary>
    <div className="capacity-section-head">
      {/* The period choice names the period; its dates stay in the tooltip. A clicked row has no choice pressed, so it is named. */}
      <h3 title={`${heading} · ${span}`}>{t("Subscription capacity vs usage", "Pojemność abonamentu vs zużycie")}{scope ? ` · ${scope}` : ""}</h3>
      {pinned && <span className="capacity-section-sub">{heading} · {span}</span>}
    </div>
    <div className="ui-toolbar subscription-month-summary-controls"><PeriodChoice period={period} pinned={pinned} onChoose={onPeriod} /></div>
    {!summary.cycles.length ? <p className="subscription-month-summary-note" data-no-cycle>{t("No cycle in this period.", "Brak cyklu w tym okresie.")}</p>
    : <KpiStrip columns={7} items={[
      { label: t("Total capacity", "Pojemność razem"), value: amount(summary.capacity), absent: summary.capacity === null, title: split },
      { label: t("Per reset", "Na reset"), value: amount(perReset), absent: perReset === null,
        note: perReset === null ? undefined : t("one window · {0} windows", `jedno okno · ${summary.capacityWindows.toLocaleString(locale, { maximumFractionDigits: 1 })} okien`,
          [summary.capacityWindows.toLocaleString(locale, { maximumFractionDigits: 1 })]),
        title: t("The whole capacity, every reset kind included, over the windows of these cycles: what one reset gives on average.",
          "Cała pojemność, ze wszystkimi rodzajami resetów, podzielona przez okna tych cykli: ile średnio daje jeden reset.") },
      { label: t("Used", "Zużyto"), value: usedAmount(summary.used), absent: summary.used === null, title: unused },
      { label: t("Utilisation", "Wykorzystanie"), value: pctText(summary.utilisation), absent: summary.utilisation === null,
        color: over ? toneColor("warn") : undefined, title: perWindow,
        note: <>{summary.utilisation !== null && <Bar value={summary.utilisation} color={over ? toneColor("warn") : undefined} />}
          {over && unused && <span data-over>{unused}</span>}{projection && <span data-projection>{projection}</span>}</> },
      { label: t("Paid", "Zapłacono"), value: paidText(summary, locale, t), absent: !summary.paid.length,
        // The amounts as paid and the rate basis stay in the tooltip.
        title: summary.paidUsd !== null && summary.paid.some((entry) => entry.currency !== "USD")
          ? `${paidByCurrency(summary, locale, t)}\n${t("In USD at the NBP mid rate of the day before each payment", "W USD po średnim kursie NBP z dnia przed każdą płatnością")}` : undefined,
        note: summary.unpriced ? t("{0} without a known price", `${summary.unpriced} bez znanej ceny`, [summary.unpriced])
          : summary.paidUsdMissing ? t("exchange rate pending", "kurs w drodze") : undefined },
      { label: t("Return", "Zwrot"), value: perText.full(per.used), absent: per.used === null,
        title: `${returnHelp(t)}\n${perTitle(per, "used", unitAmount, locale, t)}` },
      { label: t("Potential", "Potencjał"), value: perText.full(per.capacity), absent: per.capacity === null,
        title: `${potentialHelp(t)}\n${perTitle(per, "capacity", unitAmount, locale, t)}` },
    ]} />}
    {points && summary.cycles.length > 0 && <p className="subscription-month-summary-note" data-points-fallback>{pointsNote(t)}</p>}
    {excludedText(summary, t) && <p className="subscription-month-summary-note" data-excluded={summary.uncalibrated + summary.usageUnknown}>{excludedText(summary, t)}</p>}
  </div>;
}

export function SubscriptionMonth(props: { vendor: string; account: string; dataRevision?: number; initialCycle?: string;
  /** "All subscriptions": every subscription's cycles summed, one row per subscription; a row selects it like the rail. */
  all?: { cards: RosterCard[]; select: (id: string) => void };
  openDataSettings?: (target: DataSettingsTarget) => void }) {
  return props.all ? <AllSubscriptionsMonth cards={props.all.cards} select={props.all.select} dataRevision={props.dataRevision} />
    : <OneSubscriptionMonth vendor={props.vendor} account={props.account} dataRevision={props.dataRevision} initialCycle={props.initialCycle} openDataSettings={props.openDataSettings} />;
}

function OneSubscriptionMonth({ vendor, account, dataRevision, initialCycle, openDataSettings }: { vendor: string; account: string; dataRevision?: number; initialCycle?: string;
  openDataSettings?: (target: DataSettingsTarget) => void }) {
  const { t, locale } = useI18n();
  const [state, update] = useMonthState();
  // A clicked row: shown in the details and in the summary until a period is chosen again.
  const [selected, setSelected] = useState<string | null>(initialCycle ?? null);
  const key = billingAccountOf(vendor, account);
  const billing = useAsync((signal) => api.billingCyclesOf(key.provider, key.account, signal), [key.provider, key.account, dataRevision]);
  const contextPreview = useContextPreview();
  const entry = billing.data ? billingAccountWithContextPreview(billing.data, contextPreview) : null;
  // Stored rows: read again shortly while the background producers catch up (as Settings does), also before the first ones.
  useEffect(() => {
    if (!entry?.stale) return;
    const timer = setTimeout(() => billing.reload(), 4000);
    return () => clearTimeout(timer);
  }, [entry?.stale, billing.data]);
  const credits = key.provider === "codex";
  const unit: MonthUnit = state.unit === "credits" && !credits ? "api" : state.unit;
  const enabled = new Set(RESET_KINDS.map(({ id }) => id).filter((id) => !state.off.includes(id)));

  if (!billing.data && billing.error) return <ErrorState message={billing.error} onRetry={billing.reload} />;
  if (!billing.data) return <LoadingCard label={t("Loading billing cycles…", "Wczytywanie okresów rozliczeniowych…")} />;
  const cycles = [...(entry?.cycles ?? [])].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const rows = cycles.map((cycle) => monthRow(cycle, unit, enabled));
  const counts = kindCounts(cycles);
  const chosen = rows.find((row) => row.cycle.start === selected) ?? rows.find((row) => row.cycle.current) ?? rows[0] ?? null;
  const format = formatter(unit, locale, t);
  const amount = (value: number | null) => value === null ? "—" : format.value(value);
  const pct = pctText;
  const pinned = rows.find((row) => row.cycle.start === selected)?.cycle ?? null;
  const summaryCycles = pinned ? [pinned] : periodCycles(cycles, state.period);
  const summary = summarize(summaryCycles, unit, enabled), points = pointsFallback(summaryCycles, unit, enabled);
  const perText = perFormat(unit, format.value, locale), color = providerColor(key.provider);
  const bars: ValueBar[] = rows.map((row) => {
    const per = perDollar([row.cycle], unit, enabled);
    return { key: row.cycle.start, label: `${dayMonth(row.cycle.start, locale)}–${dayMonth(row.cycle.end, locale)}`,
      sub: `${planName(row.cycle.plan, key.provider, row.cycle.start)}${row.cycle.current ? ` · ${t("ongoing", "trwa")}` : ""}`, color,
      used: per.used, capacity: per.capacity, usedTitle: perTitle(per, "used", amount, locale, t), capacityTitle: perTitle(per, "capacity", amount, locale, t),
      selected: row === chosen, onSelect: () => setSelected(row.cycle.start) };
  });

  return <section className="global-capacity subscription-month"><Card pad="0" style={{ overflow: "hidden" }}>
    <div className="ui-toolbar global-capacity-controls">
      <UnitChoice unit={unit} onChoose={(value) => update({ ...state, unit: value })}
        unavailable={credits ? {} : { credits: t("Credits are a Codex unit", "Kredyty są jednostką Codex") }}
        creditsTitle={t("The middle of the low–high credit range", "Środek zakresu kredytów (niski–wysoki)")} />
      <ResetChoice enabled={enabled} counts={counts} state={state} update={update} />
      <HelpDot label={t("How a cycle is counted", "Jak liczymy cykl")}>{t("Each billing cycle's capacity: base windows + early-reset bonuses by kind = total; used is measured against the total. Return and potential divide what was used and the capacity by the USD paid for the cycle. Newest cycle first; click a row for its details.",
        "Pojemność każdego okresu rozliczeniowego: okna bazowe + premie z wczesnych resetów według rodzaju = razem; zużycie liczone względem całości. Zwrot i potencjał dzielą zużycie i pojemność przez kwotę w USD zapłaconą za cykl. Najnowszy cykl na górze; kliknij wiersz, aby zobaczyć szczegóły.")}</HelpDot>
    </div>
    {entry?.stale && <p role="status" className="global-capacity-status">{t("Updating in the background — figures may change shortly.", "Aktualizacja w tle — liczby mogą się zaraz zmienić.")}</p>}
    <div className="global-capacity-body">
      {!rows.length ? entry?.stale
        ? <EmptyState title={t("Preparing billing cycles", "Przygotowywanie okresów rozliczeniowych")}
          detail={t("The billing cycles of this subscription are being prepared in the background; this view refreshes on its own.",
            "Okresy rozliczeniowe tego abonamentu są przygotowywane w tle; widok odświeży się sam.")} />
        : <EmptyState title={t("No billing cycles", "Brak okresów rozliczeniowych")}
          detail={t("This subscription has no plan periods with cycles. Plans are set in Settings → Accounts.", "Ten abonament nie ma okresów planu z cyklami. Plany ustawisz w Ustawieniach → Konta.")} />
        : <>
          <CapacitySummary summary={summary} amount={amount} span={spanText(summaryCycles, locale, t)}
            heading={pinned ? t("Selected cycle", "Wybrany cykl") : periodLabel(state.period, t)}
            current={summaryCycles.length === 1 ? summaryCycles[0]! : null} period={state.period} pinned={pinned !== null}
            onPeriod={(period) => { setSelected(null); update({ ...state, period }); }} enabled={enabled} points={points}
            per={perDollar(summaryCycles, unit, enabled)} perText={perText} />
          <ValueSection unit={unit} bars={bars} perText={perText} legend={[{ label: productName(vendor), color }]} />
          <div className="capacity-section">
            <div className="capacity-section-head">
              <h3>{t("Capacity of each cycle", "Pojemność każdego cyklu")} · {unitLabel(unit, t)}</h3>
            </div>
            <div className="subscription-month-table">
              <Table tableId="SubscriptionMonth:cycles">
                {valueHead(t("Cycle", "Cykl"), t)}
                <tbody>{rows.map((row) => <CycleRow key={row.cycle.start} row={row} unit={unit} vendor={key.provider} enabled={enabled} selected={row === chosen}
                  onSelect={() => setSelected(row.cycle.start)} amount={amount} pct={pct} range={format.range} perText={perText} />)}</tbody>
              </Table>
            </div>
          </div>
          {chosen && <CycleDetail row={chosen} enabled={enabled}
            onEdit={openDataSettings && (() => openDataSettings({ area: "windows", account, cycle: { start: chosen.cycle.start, end: chosen.cycle.end } }))} />}
        </>}
    </div>
  </Card></section>;
}

/** The value chart over the table's rows: per $1 in the unit, with the 1× line in API $. */
function ValueSection({ unit, bars, perText, legend }: {
  unit: MonthUnit; bars: ValueBar[]; perText: ReturnType<typeof perFormat>; legend: Array<{ label: string; color: string }>;
}) {
  const { t } = useI18n();
  if (!bars.some((bar) => bar.used !== null || bar.capacity !== null)) return null;
  const title = `${t("Value per $1", "Wartość za $1")} · ${unitLabel(unit, t)}`;
  return <div className="capacity-section" data-value-section>
    <div className="capacity-section-head">
      <h3>{title}</h3>
      <HelpDot label={t("Value per $1", "Wartość za $1")}>{`${returnHelp(t)} ${potentialHelp(t)} ${t("A cycle without a price above zero has no bar.",
        "Cykl bez ceny powyżej zera nie ma słupka.")}`}</HelpDot>
    </div>
    <ValueChart bars={bars} title={title} format={perText.short} reference={unit === "api" ? 1 : undefined} legend={legend} />
  </div>;
}

/** Paid in USD (the written price and its kind in the tooltip); the price as written while its USD is unknown. */
function paidCell(cycle: BillingCycle, t: T, locale: string): { text: string; title?: string } {
  const usd = cycleUsdPaid(cycle), kind = priceKind(cycle, t);
  if (usd === null) return { text: cycle.price.amount === null ? "—" : cyclePrice(cycle, t, locale) };
  return { text: `${cycleMoney(usd, "USD", locale)}${kind ? ` ${kind}` : ""}`, title: cycle.price.currency === "USD" ? undefined : cyclePrice(cycle, t, locale) };
}

function CycleRow({ row, unit, vendor, enabled, selected, onSelect, amount, pct, range, perText }: {
  row: MonthRow; unit: MonthUnit; vendor: string; enabled: ReadonlySet<ResetKind>; selected: boolean; onSelect: () => void;
  amount: (value: number | null) => string; pct: (value: number | null) => string;
  range: (value: { range?: { low: number; high: number } }) => string | undefined;
  perText: ReturnType<typeof perFormat>;
}) {
  const { t, locale } = useI18n();
  const { cycle } = row;
  const missing = row.capacity.value === null ? capacityMissing(cycle, t) : undefined;
  const usedTitle = cycle.current && cycle.to_date
    ? `${t("Of the windows to date", "Z okien do dziś")}: ${pct(cycle.to_date.used_pct)}${cycle.projection ? ` · ${t("minimal projection", "projekcja minimalna")}: ${cycle.projection.windows_min.toLocaleString(locale, { maximumFractionDigits: 2 })} ${t("windows", "okien")} → ${pct(cycle.projection.used_pct)}` : ""}`
    : undefined;
  const unused = row.total === null || row.used.value === null ? null : row.total - row.used.value;
  const per = perDollar([cycle], unit, enabled), paid = paidCell(cycle, t, locale);
  return <TableRow className={`subscription-month-row${selected ? " is-selected" : ""}`} onClick={onSelect} data-cycle-row={cycle.start} aria-selected={selected}>
    <Td mono>{dayMonth(cycle.start, locale)}–{dayMonth(cycle.end, locale)}{cycleMarks(cycle) ? ` ${cycleMarks(cycle)}` : ""}
      {cycle.current && <span className="subscription-month-sub">{t("ongoing", "trwa")}</span>}</Td>
    <PlanCell color={providerColor(vendor)}>{planName(cycle.plan, vendor, cycle.start)}</PlanCell>
    <Td mono align="right" title={paid.title}>{paid.text}</Td>
    <Td mono align="right" title={missing}><strong>{amount(row.total)}</strong></Td>
    <Td mono align="right" title={missing}>{amount(row.base)}</Td>
    <ResetsCell row={row} enabled={enabled} missing={missing} amount={amount} range={range} />
    <Td mono align="right" title={row.used.value === null && row.capacity.value !== null ? usageUnknownTitle(cycle.used_pp, t) : range(row.used)}>{amount(row.used.value)}</Td>
    <Td mono align="right" title={usedTitle}>{pct(row.usedPct)}
      {cycle.current && cycle.to_date && <span className="subscription-month-sub">{t("to date", "do dziś")} {pct(cycle.to_date.used_pct)}</span>}</Td>
    <Td mono align="right">{unused !== null && unused < 0 ? `${t("over", "ponad")} ${amount(-unused)}` : amount(unused)}</Td>
    <Td mono align="right" title={perTitle(per, "used", amount, locale, t)}><strong>{perText.short(per.used)}</strong></Td>
    <Td mono align="right" title={perTitle(per, "capacity", amount, locale, t)}>{perText.short(per.capacity)}</Td>
  </TableRow>;
}

/** The counted early resets of a cycle in one cell; each kind, a kind not counted and carried resets in its tooltip. */
function ResetsCell({ row, enabled, missing, amount, range }: {
  row: MonthRow; enabled: ReadonlySet<ResetKind>; missing?: string; amount: (value: number | null) => string;
  range: (value: { range?: { low: number; high: number } }) => string | undefined;
}) {
  const { t } = useI18n();
  const counted = RESET_KINDS.filter(({ id }) => enabled.has(id)).reduce((sum, { id }) => sum + row.bonuses[id].count + row.bonuses[id].carried, 0);
  const lines = RESET_KINDS.flatMap(({ id }) => {
    const bonus = row.bonuses[id], resets = bonus.count + bonus.carried;
    if (!resets) return [];
    const carried = bonus.carried ? t("{0} from a reset in the previous cycle", `${bonus.carried} z resetu w poprzednim cyklu`, [bonus.carried]) : null;
    return [[`${kindLabel(id, t)}: ${bonus.value === null ? "—" : `+${amount(bonus.value)}`} (${resets})`, range(bonus), carried,
      enabled.has(id) ? null : t("not counted", "nie liczone")].filter(Boolean).join(" · ")];
  });
  const value = row.base === null || row.total === null ? null : row.total - row.base;
  return <td className="ui-td is-num subscription-month-bonus" data-resets title={[missing, ...lines].filter(Boolean).join("\n") || undefined}>
    {counted === 0 ? "—" : value === null ? `— (${counted})` : `+${amount(value)} (${counted})`}</td>;
}

function CycleDetail({ row, enabled, onEdit }: { row: MonthRow; enabled: ReadonlySet<ResetKind>; onEdit?: () => void }) {
  const { t, locale } = useI18n();
  const { cycle } = row;
  const tokens = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const calibration = cycle.capacity?.calibration;
  const banked = cycle.resets?.banked?.origins;
  const words = flagWords(cycle, t);
  const cells = (value: { input: number; cached: number; output: number } | null | undefined) => (["input", "cached", "output"] as const)
    .map((part) => <Td key={part} mono align="right">{value ? tokens.format(value[part]) : "—"}</Td>);
  // Where the capacity rests: its calibration, the windows left out and the origin of banked credits.
  const provenance = [
    calibration ? `${t("Calibration", "Kalibracja")}: ${calibration.windows} ${t("windows", "okien")} (${calibration.inside} ${t("inside the cycle", "w cyklu")}, ${calibration.windows - calibration.inside} ${t("borrowed", "dobranych")}) · ${calibration.pp.toLocaleString(locale, { maximumFractionDigits: 0 })} ${t("pp", "pkt")} · ${fullDay(calibration.from, locale)} – ${fullDay(calibration.until, locale)}`
      : row.capacity.value === null ? capacityMissing(cycle, t) : null,
    calibration && calibration.outliers.count > 0
      ? `${t("Outliers left out", "Pominięte odstające okna")}: ${calibration.outliers.count} · ${calibration.outliers.starts.map((start) => fullDay(start, locale)).join(", ")}` : null,
    banked ? `${t("Banked credits", "Kredyty banked")}: ${t("granted to all accounts", "przyznane wszystkim kontom")} ${banked.all_accounts} · ${t("origin unknown", "pochodzenie nieznane")} ${banked.unknown}` : null,
  ].filter((line): line is string => !!line);
  return <div className="subscription-month-detail" aria-label={t("Cycle details", "Szczegóły cyklu")}>
    <div className="subscription-month-detail-head">
      <h3>{t("Cycle", "Cykl")} {fullDay(cycle.start, locale)} – {fullDay(cycle.end, locale)}
        {words.length > 0 && <span className="subscription-month-warnings" title={words.join("\n")} data-cycle-warnings>
          <Pill tone="warn">{words.length} {words.length === 1 ? t("warning", "uwaga") : t("warnings", "uwagi")}</Pill></span>}</h3>
      {provenance.length > 0 && <HelpDot label={t("Calibration", "Kalibracja")}>
        {provenance.map((line) => <span key={line} className="subscription-month-help-line">{line}</span>)}</HelpDot>}
    </div>
    <div className="subscription-month-tokens" aria-label={t("Tokens", "Tokeny")}>
      <Table tableId="SubscriptionMonth:3">
        <thead><TableRow header><Th columnId="kind">{t("Tokens", "Tokeny")}</Th>
          <Th columnId="input" align="right">{t("input", "wejście")}</Th><Th columnId="cached" align="right">{t("cached", "z cache")}</Th><Th columnId="output" align="right">{t("output", "wyjście")}</Th></TableRow></thead>
        <tbody>
          <TableRow data-tokens="capacity"><Td>{t("Capacity", "Pojemność")}</Td>{cells(tokenSplit(cycle, enabled))}</TableRow>
          <TableRow data-tokens="used"><Td>{t("Used", "Zużyte")}</Td>{cells(cycle.used_units?.tokens)}</TableRow>
        </tbody>
      </Table>
    </div>
    {cycle.main_windows && cycle.main_windows.length > 0 && <CycleWindows cycle={cycle} windows={cycle.main_windows} onEdit={onEdit} />}
  </div>;
}

const windowShare = (value: number | null, locale: string) => value === null ? "—" : `${(value * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;

/**
 * The cycle's main-counter windows from reset to reset: a strip over the cycle's time (width = the window's time in the
 * cycle, fill = what it used before its end, ink = how it ended), then the same windows as a compact table.
 */
function CycleWindows({ cycle, windows, onEdit }: { cycle: BillingCycle; windows: BillingCycleWindow[]; onEdit?: () => void }) {
  const { t, locale } = useI18n();
  const moment = (value: string) => new Date(value).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const from = Date.parse(cycle.start), span = Math.max(1, Date.parse(cycle.end) - from);
  const describe = (window: BillingCycleWindow) => `${moment(window.start)} → ${moment(window.end)} · ${causeLabel(window.cause, t)} · ${pctText(window.used_pp)}`;
  const ink = (window: BillingCycleWindow) => toneColor(causeTone(window.cause));
  return <div className="subscription-month-windows" aria-label={t("Windows of the cycle", "Okna cyklu")}>
    <div className="subscription-month-windows-head">
      <span>{t("Windows", "Okna")} · {windows.length}</span>
      {onEdit && <GhostButton onClick={onEdit} title={t("Correct how the windows ended", "Popraw sposób zakończenia okien")}>{t("Edit windows", "Edytuj okna")} →</GhostButton>}
    </div>
    <div className="subscription-month-strip" aria-hidden="true">
      {windows.map((window) => {
        const left = Math.max(0, (Date.parse(window.start) - from) / span), right = Math.min(1, (Date.parse(window.end) - from) / span);
        if (right <= left) return null;
        const fill = window.used_pp === null ? 0 : Math.min(100, Math.max(0, window.used_pp));
        return <span key={window.start} className="subscription-month-strip-window" data-strip-window={window.start} title={describe(window)}
          style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}>
          <span className="subscription-month-strip-fill" style={{ height: `${fill}%`, background: ink(window) }} />
        </span>;
      })}
    </div>
    <div className="subscription-month-strip-axis" aria-hidden="true"><span>{dayMonth(cycle.start, locale)}</span><span>{dayMonth(cycle.end, locale)}</span></div>
    <div className="subscription-month-windows-list">
      <Table tableId="SubscriptionMonth:1">
        <thead><TableRow header>
          <Th columnId="c0">{t("Start", "Start")}</Th><Th columnId="length">{t("Length", "Długość")}</Th><Th columnId="c1">{t("How it ended", "Jak się skończyło")}</Th>
          <Th columnId="c2" align="right" title={t("Its rise on the allowance meter before its end", "Wzrost licznika przydziału przed końcem okna")}>{t("Used", "Zużyto")}</Th>
          <Th columnId="c3" align="right" title={t("Its part of the cycle's capacity", "Jego część pojemności cyklu")}>{t("Share", "Udział")}</Th>
        </TableRow></thead>
        <tbody>{windows.map((window) => <TableRow key={window.start} data-window={window.start} data-cause={window.cause ?? ""}>
          <Td mono title={`${moment(window.start)} → ${moment(window.end)}`}>{moment(window.start)}</Td>
          <Td mono>{window.cause === "open" ? t("ongoing", "trwa") : durationText(window.start, window.end, t)}</Td>
          <Td><span className="subscription-month-cause" style={{ "--cause-ink": ink(window) } as CSSProperties}>{causeLabel(window.cause, t)}</span></Td>
          <Td mono align="right"><span className="subscription-month-used">
            {window.used_pp !== null && <Bar value={Math.min(100, window.used_pp)} height={6} color={window.used_pp >= 100 ? toneColor("crit") : undefined} />}
            <span>{pctText(window.used_pp)}</span></span></Td>
          <Td mono align="right" title={window.share < 1 ? t("{0} of the window lies in this cycle", `${windowShare(window.share, locale)} okna przypada na ten cykl`, [windowShare(window.share, locale)]) : undefined}>
            {windowShare(window.capacity_share, locale)}</Td>
        </TableRow>)}</tbody>
      </Table>
    </div>
  </div>;
}

/** "All subscriptions": the period's sum over every subscription and one row per subscription. */
function AllSubscriptionsMonth({ cards, select, dataRevision }: { cards: RosterCard[]; select: (id: string) => void; dataRevision?: number }) {
  const { t, locale } = useI18n();
  const [state, update] = useMonthState();
  const billing = useAsync((signal) => api.billingCycles(signal), [dataRevision]);
  const contextPreview = useContextPreview();
  const stale = billing.data?.accounts.some((entry) => entry.stale) ?? false;
  useEffect(() => {
    if (!stale) return;
    const timer = setTimeout(() => billing.reload(), 4000);
    return () => clearTimeout(timer);
  }, [stale, billing.data]);
  // Window points do not add up across subscriptions; credits only over Codex.
  const unit: AllUnit = state.unit === "pp" ? "api" : state.unit;
  const enabled = new Set(RESET_KINDS.map(({ id }) => id).filter((id) => !state.off.includes(id)));
  if (!billing.data && billing.error) return <ErrorState message={billing.error} onRetry={billing.reload} />;
  if (!billing.data) return <LoadingCard label={t("Loading billing cycles…", "Wczytywanie okresów rozliczeniowych…")} />;
  const { rows, empty, total } = allSubscriptions(billing.data.accounts.map(entry => billingAccountWithContextPreview(entry, contextPreview)), state.period, unit, enabled);
  const anyCycles = billing.data.accounts.some((entry) => entry.cycles.length > 0);
  const counts = kindCounts(rows.flatMap((row) => row.cycles));
  const format = formatter(unit, locale, t);
  const amount = (value: number | null) => value === null ? "—" : format.value(value);
  const pointsText = pointFormats(locale, t);
  // The rail's card of a billing account: its name and plan label, and the id the rail selects.
  const cardOf = (provider: string, account: string) => cards.find((card) => card.id.toLowerCase() === account
    && billingAccountOf(card.vendor, card.id).provider === provider) ?? cards.find((card) => card.id.toLowerCase() === account) ?? null;
  const nameOf = (provider: string, account: string) => { const card = cardOf(provider, account); return card ? subscriptionName(card) : account; };
  const perText = perFormat(unit, format.value, locale);
  // Each row's subscription: its rail card, vendor ink and the plan of its newest cycle in the period (what was paid for).
  const lines = rows.map((row) => {
    const card = cardOf(row.provider, row.account), vendor = card?.vendor ?? row.provider;
    const plan = subscriptionPlan(vendor, row.cycles[0]?.plan ?? card?.plan ?? null);
    return { row, card, vendor, color: providerColor(vendor), plan: `${productName(vendor)}${plan ? ` · ${plan}` : ""}`,
      per: perDollar(row.cycles, unit, enabled) };
  });
  const bars: ValueBar[] = lines.map(({ row, card, color, plan, per }) => ({ key: `${row.provider}|${row.account}`,
    label: nameOf(row.provider, row.account), sub: plan, color, used: per.used, capacity: per.capacity,
    usedTitle: perTitle(per, "used", amount, locale, t), capacityTitle: perTitle(per, "capacity", amount, locale, t),
    onSelect: card ? () => select(card.id) : undefined }));
  const legend = [...new Map(lines.map((line) => [line.color, { label: productName(line.vendor), color: line.color }])).values()];
  return <section className="global-capacity subscription-month"><Card pad="0" style={{ overflow: "hidden" }}>
    <div className="ui-toolbar global-capacity-controls">
      <UnitChoice unit={unit} onChoose={(value) => update({ ...state, unit: value })}
        unavailable={{ pp: t("Window points do not add up across subscriptions", "Punkty okna nie sumują się między abonamentami") }}
        creditsTitle={t("Codex subscriptions only · the middle of the low–high credit range", "Tylko abonamenty Codex · środek zakresu kredytów (niski–wysoki)")} />
      <ResetChoice enabled={enabled} counts={counts} state={state} update={update} />
      <HelpDot label={t("How subscriptions are summed", "Jak sumujemy abonamenty")}>{t("Each subscription's own cycles of the period, summed. Capacity includes the counted reset bonuses; used is measured against it. Return and potential divide what was used and the capacity by the USD paid. Click a row to open that subscription.",
        "Własne cykle każdego abonamentu w wybranym okresie, zsumowane. Pojemność obejmuje liczone premie z resetów; zużycie liczone względem niej. Zwrot i potencjał dzielą zużycie i pojemność przez zapłaconą kwotę w USD. Kliknij wiersz, aby otworzyć ten abonament.")}</HelpDot>
    </div>
    {stale && <p role="status" className="global-capacity-status">{t("Updating in the background — figures may change shortly.", "Aktualizacja w tle — liczby mogą się zaraz zmienić.")}</p>}
    <div className="global-capacity-body">
      {!anyCycles ? <EmptyState title={t("No billing cycles", "Brak okresów rozliczeniowych")}
        detail={t("No subscription has plan periods with cycles yet. Plans are set in Settings → Accounts.", "Żaden abonament nie ma jeszcze okresów planu z cyklami. Plany ustawisz w Ustawieniach → Konta.")} />
        : <>
          <CapacitySummary summary={total} amount={amount} heading={`${periodLabel(state.period, t)} ${t("of each subscription", "każdego abonamentu")}`}
            span={total.from && total.until ? `${fullDay(total.from, locale)} – ${fullDay(total.until, locale)}` : t("no cycle", "brak cyklu")}
            current={null} scope={unit === "credits" ? t("Codex only", "tylko Codex") : undefined} period={state.period} pinned={false}
            onPeriod={(period) => update({ ...state, period })} enabled={enabled}
            per={perDollar(rows.flatMap((row) => row.cycles), unit, enabled)} perText={perText} />
          <ValueSection unit={unit} bars={bars} perText={perText} legend={legend} />
          <div className="capacity-section">
            <div className="capacity-section-head">
              <h3>{t("Subscriptions", "Abonamenty")} · {unitLabel(unit, t)}</h3>
            </div>
            <div className="subscription-month-table">
              <Table tableId="SubscriptionMonth:subscriptions">
                {valueHead(t("Subscription", "Abonament"), t)}
                <tbody>{lines.map(({ row, card, color, plan, per }) => {
                  const kinds = kindCounts(row.cycles), excluded = excludedText(row.summary, t);
                  const pointsUsed = row.cycles.reduce((sum, cycle) => sum + (cycle.used_pp ?? 0), 0);
                  // Usage unknown in the unit: the same figures in window points, marked as such and never summed.
                  const points = pointsFallback(row.cycles, unit, enabled), summary = points ?? row.summary;
                  const cap = points ? pointsText.windows : amount, use = points ? pointsText.points : amount;
                  const marked = points ? pointsNote(t) : undefined;
                  return <TableRow key={`${row.provider}|${row.account}`} className="subscription-month-row" data-subscription-row={`${row.provider}|${row.account}`}
                    onClick={card ? () => select(card.id) : undefined}>
                    <Td>{nameOf(row.provider, row.account)}<span className="subscription-month-sub mono">{spanText(row.cycles, locale, t)}</span>
                      {excluded && <span className="subscription-month-sub">{excluded}</span>}</Td>
                    <PlanCell color={color}>{plan}</PlanCell>
                    <Td mono align="right" title={row.summary.paid.some((entry) => entry.currency !== "USD") ? paidByCurrency(row.summary, locale, t) : undefined}>
                      {paidText(row.summary, locale, t)}</Td>
                    <Td mono align="right" title={marked}><strong>{cap(summary.capacity)}</strong></Td>
                    <Td mono align="right" title={marked}>{cap(summary.base)}</Td>
                    <Td mono align="right" title={[marked, ...RESET_KINDS.filter(({ id }) => kinds[id]).map(({ id }) =>
                      `${kindLabel(id, t)}: ${kinds[id]}${enabled.has(id) ? "" : ` · ${t("not counted", "nie liczone")}`}`)].filter(Boolean).join("\n") || undefined}>
                      {summary.capacity === null || summary.base === null ? "—" : `+${cap(summary.capacity - summary.base)}`}</Td>
                    <Td mono align="right" title={marked ?? (summary.used === null && summary.usageUnknown ? usageUnknownTitle(pointsUsed, t) : undefined)}>{use(summary.used)}</Td>
                    <Td mono align="right" title={marked}>{pctText(summary.utilisation)}</Td>
                    <Td mono align="right" title={marked}>{summary.unused !== null && summary.unused < 0 ? `${t("over", "ponad")} ${cap(-summary.unused)}` : cap(summary.unused)}</Td>
                    <Td mono align="right" title={perTitle(per, "used", amount, locale, t)}><strong>{perText.short(per.used)}</strong></Td>
                    <Td mono align="right" title={perTitle(per, "capacity", amount, locale, t)}>{perText.short(per.capacity)}</Td>
                  </TableRow>;
                })}</tbody>
              </Table>
            </div>
            {empty.length > 0 && <p className="subscription-month-summary-note" data-no-cycle-subscriptions>
              {t("No cycle in this period", "Brak cyklu w tym okresie")}: {empty.map((entry) => nameOf(entry.provider, entry.account)).join(", ")}</p>}
          </div>
        </>}
    </div>
  </Card></section>;
}
