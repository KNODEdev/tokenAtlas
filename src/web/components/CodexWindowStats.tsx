import type { CycleBreakdownResponse } from "../lib/api";
import type { windowRates } from "../lib/codex-window-stats";
import { relativeChange } from "../lib/codex-capacity";
import { compact, signedPct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { missingRateAmountTitle, missingRateIn, missingRateNote, useMissingRates } from "../lib/missing-rate";
import { KpiStrip, type KpiSpec } from "./ui";

type Rates = ReturnType<typeof windowRates>;
/** Reference conversions of the window (per-point averages, valuations). */
export function CodexWindowStats({ totals, rates, previousRates, historyRates, usedPercent, loading, error, historyLoading = false, historyError = null, open = false }: {
  totals: CycleBreakdownResponse | null; rates: Rates; previousRates: Rates | null; historyRates: Rates[];
  usedPercent: number; loading: boolean; error: string | null; historyLoading?: boolean; historyError?: string | null;
  open?: boolean;
}) {
  const { t, locale } = useI18n();
  const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const amount = (n: number | null | undefined, format: (n: number) => string = compact, partial = false) => n == null ? "—" : `${partial ? "≥ " : ""}${format(n)}`;
  const noComparison = t("— no comparison", "— brak porównania");
  const comparisonTitle = t("Previous observed window: same account, plan and counter, at least 10% used. Unknown promotion terms do not confirm equal contractual capacity. Incomplete pricing compares only the explicitly labelled priced portion.", "Poprzednie obserwowane okno: to samo konto, plan i licznik, zużycie co najmniej 10%. Nieznane promocje nie potwierdzają równej pojemności umownej. Niepełna wycena porównuje wyłącznie wyraźnie oznaczoną wycenioną część.");
  const change = (metric: "tokens" | "api" | "credits"): KpiSpec["comparison"] => {
    const partial = metric === "api" ? rates.apiPartial || previousRates?.apiPartial
      : metric === "credits" ? rates.creditsPartial || previousRates?.creditsPartial : false;
    const delta = relativeChange(rates[metric], previousRates?.[metric] ?? null);
    const missing = historyError ? t("— comparison read failed", "— błąd odczytu porównania")
      : historyLoading ? t("— loading comparison", "— odczyt porównania")
      : partial ? t("— incomplete pricing", "— niepełna wycena") : noComparison;
    return { value: delta === null ? missing : `${signedPct(delta)} ${partial ? t("priced part vs previous", "wyceniona część vs poprzednie") : t("vs previous", "vs poprzednie")}`,
      title: comparisonTitle + (partial ? " " + t("This compares priced subtotals only; missing prices can change the result. It is not a comparison of complete costs.", "Porównanie obejmuje tylko wycenione części; brakujące stawki mogą zmienić wynik. To nie jest porównanie pełnych kosztów.") : "") };
  };
  const range = (metric: "tokens" | "api" | "credits", format: (n: number) => string = compact) => {
    const values = historyRates.filter(r => metric === "api" ? !r.apiPartial : metric === "credits" ? !r.creditsPartial : true)
      .flatMap(r => r[metric] === null ? [] : [r[metric]!]).sort((a, b) => a - b);
    if (historyError) return t("comparison history read failed", "odczyt historii porównań nieudany");
    if (historyLoading) return t("loading comparison history…", "odczyt historii porównań…");
    if (values.length < 4) return t("average for this window", "średnia tego okna");
    const quantile = (p: number) => {
      const x = (values.length - 1) * p, i = Math.floor(x);
      return values[i]! + (values[Math.ceil(x)]! - values[i]!) * (x - i);
    };
    return `${t("typical", "typowo")} ${format(quantile(0.25))}–${format(quantile(0.75))} · n=${values.length}`;
  };
  const credit = totals?.credit_equivalent;
  const missingRate = missingRateIn(totals?.unpriced.models, useMissingRates());
  const perPointTitle = t("Recorded total for this window divided by its displayed used percentage. An estimated reference average, not a directly calibrated quota rate. It does not require a previous window. ≥ marks incomplete pricing.",
    "Zarejestrowana suma tego okna podzielona przez pokazany procent zużycia. Szacunkowa średnia referencyjna, nie bezpośrednia kalibracja limitu. Nie wymaga poprzedniego okna. ≥ oznacza niepełną wycenę.");
  const rateAmount = (value: number | null, format: (n: number) => string = compact, partial = false) =>
    value === null ? "—" : (partial ? "≥ " : "≈ ") + format(value);

  const references: KpiSpec[] = [
    missingRate.tokens > 0
      ? { label: t("API equivalent", "Ekwiwalent API"), value: totals && totals.totals.usd > 0 ? amount(totals.totals.usd, usd, true) : t("no price", "brak ceny"),
        note: missingRateNote(missingRate.models), title: missingRateAmountTitle(missingRate.models) }
      : { label: t("API equivalent", "Ekwiwalent API"), value: amount(totals && (totals.totals.usd > 0 || totals.unpriced.tokens === 0) ? totals.totals.usd : null, usd, (totals?.unpriced.tokens ?? 0) > 0), note: t("Standard valuation · not a bill", "wycena Standard · nie rachunek") },
    { label: t("Credit equivalent", "Ekwiwalent kredytów"), value: amount(credit?.value ?? (credit && credit.priced_credits > 0 ? credit.priced_credits : null), num, (credit?.unpriced_calls ?? 0) > 0),
      note: credit?.unpriced_calls ? `${num(credit.unpriced_calls)} ${t("calls without a rate", "wywołań bez stawki")}` : t("Standard valuation · not balance", "wycena Standard · nie saldo") },
    { label: t("Tokens / pp", "Tokeny / p.p."), value: rateAmount(rates.tokens), note: range("tokens"), comparison: change("tokens"), title: perPointTitle },
    { label: t("API$ / pp", "API$ / p.p."), value: rateAmount(rates.api, usd, rates.apiPartial), note: range("api", usd), comparison: change("api"), title: perPointTitle },
    { label: t("Credits / pp", "Kredyty / p.p."), value: rateAmount(rates.credits, num, rates.creditsPartial), note: range("credits", num), comparison: change("credits"), title: perPointTitle },
  ];
  return <details open={open}>
    <summary className="ui-disclosure">{t("Reference values and comparisons", "Przeliczniki i porównania")}</summary>
    <div style={{ marginTop: "var(--s-4)" }}>
      <KpiStrip items={references} columns={5} />
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-3)" }}>
        {error ? t("Could not read this window's traffic.", "Nie udało się odczytać ruchu tego okna.") : loading ? t("Loading this window's traffic…", "Odczyt ruchu tego okna…")
          : usedPercent > 0
            ? t("Window averages", "Średnie okna") + ": " + t("recorded totals", "zarejestrowane sumy") + " ÷ " + num(usedPercent) + " " + t("pp used · ≈ reference estimate", "p.p. zużycia · ≈ szacunek referencyjny")
            : t("A per-point average is unavailable at 0% usage.", "Przy zużyciu 0% nie można wyliczyć średniej na punkt procentowy.")}
      </div>
    </div>
  </details>;
}
