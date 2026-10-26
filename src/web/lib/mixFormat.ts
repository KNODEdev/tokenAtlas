import { usd } from "./format";
import { getLocale, translate } from "./i18n";
import type {
  CadenceBasis,
  CalendarGranularity,
  CapacityBasis,
  CapacityEquivalents,
  Equivalent,
  PriceBasis,
  Provenance,
  SeatTime,
} from "./api";
export type MoneyKind = "billed" | "api";
type EquivalentKind = "session" | "weekly";

function localizedNumber(value: number, options: Intl.NumberFormatOptions): string {
  return value.toLocaleString(getLocale(), options).replace(/\u00a0/g, " ");
}

export const BRAK_KALIBRACJI = "brak kalibracji";
export function noCalibrationLabel(): string {
  return translate("no calibration", BRAK_KALIBRACJI);
}

// Keep these Polish primitives for legacy callers. UI-facing values below are dynamic.
export const DECLARED_PLAN_COST_LABEL = "koszt planów wg deklaracji, proporcjonalnie";
export const DECLARED_PLAN_COST_HINT =
  "Koszt z zapisanych cykli, proporcjonalnie do ich rzeczywistej długości. Poza cyklami: datowana cena katalogowa planu × dni / 30,44. Kwota jest dzielona udziałem w ruchu konta. Brak historii planu lub kursu pozostaje nieznany. To nie jest faktura ani dowód zapłaty.";
export function calendarPlanCostHint(t: (en: string, pl: string) => string = translate): string {
  return t("Cost from stored billing cycles, prorated over their actual duration. Outside cycles: the dated catalog price × days / 30.44. The amount is allocated by the account's traffic shares. Missing plan history or exchange rates remain unknown. This is not an invoice or proof of payment.", DECLARED_PLAN_COST_HINT);
}
export const MONEY_LABEL: Record<MoneyKind, string> = {
  get billed() {
    return translate("allocated share of declared plan cost", "przypisany udział w deklarowanym, proporcjonalnym koszcie planów");
  },
  get api() {
    return translate("API list price", "cennik API");
  },
};
export const MONEY_HINT: Record<MoneyKind, string> = {
  get billed() {
    return calendarPlanCostHint();
  },
  get api() {
    return translate("What this traffic would cost at API rates without a subscription.", "Ile ten ruch kosztowałby po cenniku API bez abonamentu.");
  },
};
export function polishPlural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  if (!Number.isInteger(abs)) return many;
  if (abs === 1) return one;
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
export function formatQty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const fractionDigits = Number.isInteger(normalized) ? 0 : 1;
  return localizedNumber(normalized, { minimumFractionDigits: fractionDigits, maximumFractionDigits: 1 });
}
export function formatMoney(n: number | null | undefined): string {
  return usd(n);
}
export function formatMoneyLabeled(n: number | null | undefined, kind: MoneyKind): string {
  return `${formatMoney(n)} · ${MONEY_LABEL[kind]}`;
}
export function formatSeatTime(seat: SeatTime | null | undefined): string {
  if (seat == null || !Number.isFinite(seat.months) || !Number.isFinite(seat.weeks)) return "—";
  return `${formatQty(seat.months)} ${translate("mo.", "mies.")} / ${formatQty(seat.weeks)} ${translate("wk. of subscription", "tyg. abonamentu")}`;
}
function unitFor(kind: EquivalentKind, n: number): string {
  const singular = Math.abs(n) === 1;
  return kind === "session"
    ? translate(singular ? "session" : "sessions", polishPlural(n, "sesja", "sesje", "sesji"))
    : translate(singular ? "week" : "weeks", polishPlural(n, "tydzień", "tygodnie", "tygodni"));
}
function equivalentPresent(eq: Equivalent | null | undefined): eq is Extract<Equivalent, { absent: null }> {
  return eq != null && eq.absent === null && Number.isFinite(eq.value);
}
export function formatCapacityEquivalent(
  eq: Equivalent | null | undefined,
  kind: EquivalentKind,
): string {
  if (!equivalentPresent(eq)) return noCalibrationLabel();
  const displayed = Math.round(eq.value * 10) / 10;
  const normalized = Object.is(displayed, -0) ? 0 : displayed;
  return `≈ ${formatQty(eq.value)} ${unitFor(kind, normalized)}`;
}
export function formatEquivalentsLine(
  equivalents: CapacityEquivalents | null | undefined,
  planLabel?: string | null,
): string {
  const sessions = formatCapacityEquivalent(equivalents?.full_5h_sessions, "session");
  const weekly = formatCapacityEquivalent(equivalents?.weekly_cycles, "weekly");
  if (!equivalentPresent(equivalents?.full_5h_sessions) && !equivalentPresent(equivalents?.weekly_cycles)) {
    return noCalibrationLabel();
  }
  const line = `${sessions} · ${weekly}`;
  return planLabel ? `${line} ${planLabel}` : line;
}
export function calendarGranularityLabel(g: CalendarGranularity): string {
  switch (g) {
    case "day":
      return translate("calendar day", "dzień kalendarzowy");
    case "week":
      return translate("calendar week", "tydzień kalendarzowy");
    case "month":
      return translate("calendar month", "miesiąc kalendarzowy");
  }
}
export function capacityAxisLabel(b: CapacityBasis): string {
  switch (b) {
    case "measured":
      return translate("measured", "pomiar");
    case "single":
      return translate("single reading", "jednorazowy");
    case "none":
      return translate("none", "brak");
  }
}
export function priceAxisLabel(b: PriceBasis): string {
  switch (b) {
    case "rate-card":
      return translate("rate card", "cennik");
    case "none":
      return translate("none", "brak");
  }
}
export function cadenceAxisLabel(b: CadenceBasis): string {
  switch (b) {
    case "declared":
      return translate("declared", "deklaracja");
    case "probe":
      return translate("probe", "sonda");
    case "default":
      return translate("default", "domyślny");
    case "none":
      return translate("none", "brak");
  }
}
export function provenanceAxesLine(p: Provenance): string {
  return `${capacityAxisLabel(p.capacity)} · ${priceAxisLabel(p.price)} · ${cadenceAxisLabel(p.cadence)}`;
}
export function provenanceLacksCalibration(p: Provenance): boolean {
  return p.capacity === "none" || p.coverage === "none";
}
export function provenanceTitle(p: Provenance): string {
  const cover = p.calibration_covers_period
    ? translate("Calibration covers the period.", "Kalibracja pokrywa okres.")
    : translate("Calibration does not cover the period.", "Kalibracja nie pokrywa okresu.");
  return `${translate("Capacity", "Pojemność")}: ${capacityAxisLabel(p.capacity)}. ${translate("Price", "Cena")}: ${priceAxisLabel(p.price)}. ${translate("Cadence", "Rytm")}: ${cadenceAxisLabel(p.cadence)}. ${cover}`;
}
export interface CalibrationSummary {
  label: string;
  tone: "ok" | "warn" | "neutral";
  detail: string;
  usable: boolean;
}
export function calibrationSummary(p: Provenance): CalibrationSummary {
  const axes = `${translate("Axes: capacity", "Osie: pojemność")} ${capacityAxisLabel(p.capacity)}, ${translate("price", "cena")} ${priceAxisLabel(p.price)}, ${translate("cadence", "rytm")} ${cadenceAxisLabel(p.cadence)}.`;
  if (p.capacity === "none") {
    return {
      label: noCalibrationLabel(),
      tone: "neutral",
      usable: false,
      detail: translate(
        "There is no basis for calculating this plan's window capacity, so the sessions / weeks / months columns stay empty. The adjacent dollar estimates do not require capacity calibration; they depend on configured prices and are not invoices. {0}",
        `Nie ma z czego policzyć pojemności okna tego planu, więc kolumny „sesje / tygodnie / miesiące" zostają puste. Szacunki dolarowe obok nie wymagają kalibracji pojemności; zależą od skonfigurowanych cen i nie są fakturą. ${axes}`, [axes],
      ),
    };
  }
  if (p.coverage === "none") {
    return {
      label: translate("period uncovered", "poza okresem"),
      tone: "warn",
      usable: false,
      detail: translate(
        "Window-capacity calibration has no day in common with this range, so the conversion would transfer someone else's measurement. {0}",
        `Kalibracja pojemności okna nie ma z tym zakresem ani jednego wspólnego dnia, więc przeliczenie byłoby przeniesieniem cudzego pomiaru. ${axes}`, [axes],
      ),
    };
  }
  if (p.coverage === "partial") {
    const pct = Math.round(p.measured_share * 100);
    const single = p.capacity === "single";
    return {
      label: `${translate("coverage", "pokrycie")} ${localizedNumber(pct, { maximumFractionDigits: 0 })}%${single ? translate(" · 1 reading", " · 1 odczyt") : ""}`,
      tone: "warn",
      usable: true,
      detail: translate(
        "Window-capacity calibration dates overlap {0}% of the selected range. This is not the percentage of the limit used.{1} Future explicitly saved calibrations will increase coverage; the period before the first reading cannot be reconstructed. {2}",
        `Daty kalibracji pojemności nakładają się na ${pct}% wybranego zakresu. To NIE jest procent wykorzystania limitu.${single ? " Sama skala pojemności stoi na jednym odczycie, więc jest rzędem wielkości." : " Skala pojemności pochodzi z wielu zamkniętych okien."} Kolejne świadomie zapisane kalibracje zwiększą pokrycie przyszłych zakresów; okresu sprzed pierwszego odczytu nie da się odtworzyć. ${axes}`, [localizedNumber(pct, { maximumFractionDigits: 0 }), single ? " The capacity scale is based on one reading, so it is an order of magnitude." : " The capacity scale comes from many closed windows.", axes],
      ),
    };
  }
  if (p.capacity === "single") {
    return {
      label: translate("1 reading", "1 odczyt"),
      tone: "warn",
      usable: true,
      detail: translate(
        "Window capacity is based on a single calibration, not a distribution from many windows - the adjacent numbers are an order of magnitude, not a measurement. {0}",
        `Pojemność okna stoi na POJEDYNCZEJ kalibracji, nie na rozkładzie z wielu okien - liczby obok są rzędem wielkości, nie pomiarem. ${axes}`, [axes],
      ),
    };
  }
  return {
    label: translate("measurement", "pomiar"),
    tone: "ok",
    usable: true,
    detail: translate(
      "Window capacity was calculated from many closed windows, and the range fits within the calibration. {0}",
      `Pojemność okna policzona z wielu zamkniętych okien, a zakres mieści się w kalibracji. ${axes}`, [axes],
    ),
  };
}
export function formatEquivalentQty(eq: Equivalent | null | undefined): string {
  if (eq == null || eq.absent !== null || !Number.isFinite(eq.value)) return "—";
  const v = eq.value;
  if (v > 0 && v < 0.1) return `≈ ${localizedNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `≈ ${formatQty(v)}`;
}
export const RECEIPT_HINT = {
  get weekly() {
    return translate(
      "How many full weekly windows of this plan this work would consume at API list price. This is capacity, not time.",
      "Ile PEŁNYCH okien tygodniowych tego planu ważyłaby ta praca, licząc po cenniku API. To pojemność, nie czas.",
    );
  },
  get monthly() {
    return translate(
      "The same in months: how many full monthly subscriptions of this plan the work would burn through. Derived from weeks, so it does not add to them.",
      "To samo w miesiącach: ile pełnych miesięcznych abonamentów tego planu trzeba by wypalić do zera. Wyprowadzone z tygodni, więc NIE dodaje się do nich.",
    );
  },
  get sessions() {
    return translate(
      "How many full 5-hour windows of this plan this work would consume. Independent estimate - it does not add to weekly windows.",
      "Ile pełnych okien 5-godzinnych tego planu ważyłaby ta praca. Niezależna estymata - nie sumuje się z tygodniami.",
    );
  },
  get fullUse() {
    return translate(
      "Price for the capacity actually used: as many full plan months as this work represents in the plan, multiplied by the monthly price. It excludes windows nobody used up.",
      "Cena za pojemność FAKTYCZNIE zużytą: tyle pełnych miesięcy planu, ile ta praca w nim waży, razy cena miesiąca. Nie zawiera okien, których nikt nie dopalił.",
    );
  },
  get actual() {
    return translate(
      "Calendar-based price: the plan price proportional to days, allocated by traffic share. The subscription costs the same regardless of usage, so this includes unused windows.",
      "Cena wg KALENDARZA: cena planu proporcjonalna do dni, podzielona udziałem w ruchu. Abonament kosztuje tyle samo niezależnie od wypalenia, więc ta liczba niesie w sobie okna niedopalone.",
    );
  },
} as const;
export function overpayFactor(actual: number | null, atFullUse: number | null): number | null {
  if (actual == null || atFullUse == null || !(atFullUse > 0)) return null;
  return actual / atFullUse;
}
export interface UtilisationVerdict {
  ratio: number;
  label: string;
  tone: "warn" | "ok" | "neutral";
  hint: string;
  impossible: boolean;
}
const UTILISATION_DEADBAND = 0.05;
export function utilisationVerdict(
  actual: number | null,
  atFullUse: number | null,
): UtilisationVerdict | null {
  const factor = overpayFactor(actual, atFullUse);
  if (factor == null || !Number.isFinite(factor) || factor <= 0) return null;
  const ratio = 1 / factor;
  const fractional = ratio < 0.1;
  const percentage = fractional ? ratio * 100 : Math.round(ratio * 100);
  const label = `${translate("used", "wyk.")} ${localizedNumber(percentage, {
    minimumFractionDigits: fractional ? 1 : 0,
    maximumFractionDigits: fractional ? 1 : 0,
  })}%`;
  if (ratio > 1 + UTILISATION_DEADBAND) {
    return {
      ratio,
      label,
      tone: "warn",
      impossible: true,
      hint: translate(
        "Usage above 100% is impossible with a hard limit. It indicates underestimated window capacity, not a bargain. Known causes: median capacity spans several plans, and windows are counted as days × 24/168 even though the Codex window is sliding.",
        "Wykorzystanie ponad 100% jest przy sztywnym limicie NIEMOŻLIWE — to mówi o zaniżonej pojemności okna, nie o okazji. Znane przyczyny: mediana pojemności rozpięta na kilku planach oraz liczenie okien jako dni×24/168, gdy okno Codeksa jest przesuwne.",
      ),
    };
  }
  return {
    ratio,
    label,
    tone: ratio < 0.5 ? "warn" : "ok",
    impossible: false,
    hint: translate(
      "How much of this subscription's capacity was used in this period. Low usage means the subscription paid for windows nobody used up. The plan price cancels out in this ratio, so this measures usage, not price.",
      "Jaka część pojemności tego abonamentu poszła w tym okresie. Niskie wykorzystanie znaczy, że zapłacono za okna, których nikt nie dopalił — cena planu się w tym ilorazie skraca, więc to jest miara zużycia, nie ceny.",
    ),
  };
}
export function dayRangeLabel(from: string, until: string): string {
  const short = (value: string) => {
    if (value.length !== 10) return value;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(getLocale(), {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      timeZone: "UTC",
    }).format(date);
  };
  return `${short(from)} → ${short(until)}`;
}
