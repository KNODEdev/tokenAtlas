import { useState, type ReactNode } from "react";
import type { CodexComparisonWindow as Window } from "../../shared/codex-accounting";
import { compareReferenceValuations, referenceComparisonIssue, referenceValuationPer100, type ReferenceComparisonIssue } from "../../shared/subscription-revaluation";
import type { DataSettingsTarget } from "../lib/data-settings";
import { useI18n } from "../lib/i18n";
import { TableRow, Dropdown, Table, Th, Td } from "./ui";
import { WindowQualityLabel } from "./WindowEvidenceDetails";
import { capacityPlanLabel } from "../lib/codex-capacity";

const messages: Record<ReferenceComparisonIssue, [string, string]> = {
  same_cycle: ["Choose two different cycles.", "Wybierz dwa różne cykle."],
  different_account: ["The cycles belong to different accounts.", "Cykle należą do różnych kont."],
  different_duration: ["The cycles have different counter durations.", "Cykle mają różne długości licznika."],
  unresolved_plan: ["A historical plan is mixed or unresolved. Confirm both plans before comparing.", "Plan historyczny jest mieszany lub nieustalony. Potwierdź oba plany przed porównaniem."],
  different_plan: ["The cycles have different historical plans.", "Cykle mają różne plany historyczne."],
  different_multiplier: ["The plan multipliers differ or one is unknown.", "Mnożniki planów różnią się lub jeden jest nieznany."],
  invalid_dates: ["Cycle timing is unavailable or invalid.", "Czas cyklu jest niedostępny lub nieprawidłowy."],
  overlapping_cycles: ["Select non-overlapping cycles in chronological order.", "Wybierz niepokrywające się cykle w kolejności chronologicznej."],
  same_reset: ["These observations share the same reset; they are not independent cycles.", "Te obserwacje mają wspólny reset; nie są niezależnymi cyklami."],
  small_sample: ["Each cycle needs more than 2 observed percentage points; smaller samples are too sensitive to meter rounding.", "Każdy cykl wymaga obserwacji ponad 2 punktów procentowych; mniejsze próby są zbyt wrażliwe na zaokrąglenie licznika."],
  missing_prices: ["At least one cycle has no requests priced by both the historical and reference price lists.", "Co najmniej jeden cykl nie ma żądań wycenionych jednocześnie według cennika historycznego i referencyjnego."],
};

/** Resolve IDs against the current filtered response, never retain stale window objects. */
export function selectRevaluationPair(windows: Window[], firstId: string, secondId: string) {
  const rows = [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const validFirst = rows.find(a => rows.some(b => referenceComparisonIssue(a, b) === null));
  const first = rows.find(w => w.id === firstId) ?? validFirst ?? rows[0];
  const validSeconds = first ? rows.filter(w => referenceComparisonIssue(first, w) === null) : [];
  const second = rows.find(w => w.id === secondId) ?? validSeconds.at(-1) ?? rows.at(-1);
  return { rows, first, second };
}

export function SubscriptionRevaluation({ windows, referenceDay, openDataSettings, initialSelection, onSelectionChange }: {
  windows: Window[] | null; referenceDay: string; openDataSettings?: (target: DataSettingsTarget) => void;
  initialSelection?: { first: string; second: string }; onSelectionChange?: (selection: { first: string; second: string }) => void;
}) {
  const { t, locale } = useI18n();
  const [firstId, setFirstId] = useState(initialSelection?.first ?? "");
  const [secondId, setSecondId] = useState(initialSelection?.second ?? "");
  const { rows, first, second } = selectRevaluationPair(windows ?? [], firstId, secondId);
  const n = (value: number | undefined, digits = 1) => value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString(locale, { maximumFractionDigits: digits });
  const usd = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
  const label = (w: Window) => `${date(w.cycle_start ?? w.start)} → ${date(w.cycle_end ?? w.reset)} · ${capacityPlanLabel(w)}`;
  const issue = first && second ? referenceComparisonIssue(first, second) : null;
  const difference = first && second ? compareReferenceValuations(first, second) : null;
  const cell = (w: Window | undefined, render: (value: Window) => ReactNode) => <Td style={{ whiteSpace: "normal", overflowWrap: "anywhere", verticalAlign: "top", width: "40%" }}>{w ? render(w) : "—"}</Td>;
  const row = (title: string, render: (w: Window) => ReactNode) => <TableRow><Td style={{ whiteSpace: "normal", verticalAlign: "top", width: "20%" }}>{title}</Td>{cell(first, render)}{cell(second, render)}</TableRow>;
  const ratio = (value: number | undefined, total: number) => `${n(value, 0)} / ${n(total, 0)}${value !== undefined && total > 0 ? ` (${n(100 * value / total)}%)` : ""}`;
  const reviewData = () => {
    if (!first || !openDataSettings) return;
    const boundaries = [first, second ?? first].flatMap(w => [w.cycle_start ?? w.start, w.cycle_end ?? w.reset])
      .filter(ts => Number.isFinite(Date.parse(ts))).map(ts => new Date(ts).toISOString()).sort();
    const area = issue === "unresolved_plan" || issue === "different_plan" || issue === "different_multiplier" ? "subscriptions"
      : issue && issue !== "missing_prices" ? "data" : "rates";
    openDataSettings({ area, account: first.account, since: boundaries[0]?.slice(0, 10), until: boundaries.at(-1)?.slice(0, 10),
      basis: "api_equivalent_usd", speed: "standard", issue: issue ? t(...messages[issue]) : t("Review historical and reference rates", "Sprawdź stawki historyczne i referencyjne") });
  };
  return <div className="capacity-detail">
    <p>{t("Reference price date", "Data cennika referencyjnego")}: <strong>{referenceDay}</strong>. {t("Standard API valuation with original request quantities and context sizes. Promotional allowance boosts are not normalized here. These are neither credit conversions nor actual bills.", "Wycena Standard API z oryginalnymi ilościami tokenów i rozmiarami kontekstu. Promocyjne zwiększenia limitu abonamentu nie są tu normalizowane. To nie jest przeliczenie kredytów ani faktyczny rachunek.")}</p>
    {rows.length ? <>
      <div className="capacity-pair">
        <label>{t("Cycle 1", "Cykl 1")} <Dropdown value={first?.id ?? ""} onChange={value => {
          const chosen = selectRevaluationPair(rows, value, "");
          const selection = { first: value, second: chosen.second?.id ?? "" };
          setFirstId(selection.first); setSecondId(selection.second); onSelectionChange?.(selection);
        }} options={rows.map(w => ({ value: w.id, label: label(w) }))} /></label>
        <label>{t("Cycle 2", "Cykl 2")} <Dropdown value={second?.id ?? ""} onChange={value => { setSecondId(value); onSelectionChange?.({ first: first?.id ?? "", second: value }); }}
          options={rows.map(w => ({ value: w.id, label: label(w) }))} /></label>
      </div>
      <Table tableId="SubscriptionRevaluation:0"><thead><TableRow header><Th columnId="c0">{t("Comparison evidence", "Dane porównania")}</Th><Th columnId="c1">{t("Cycle 1", "Cykl 1")}</Th><Th columnId="c2">{t("Cycle 2", "Cykl 2")}</Th></TableRow></thead><tbody>
        {row(t("Matched time range", "Dopasowany przedział czasu"), w => `${date(w.start)} — ${date(w.end)}`)}
        {row(t("Historical plan / multiplier", "Plan historyczny / mnożnik"), capacityPlanLabel)}
        {row(t("Counter duration / observed pp", "Długość licznika / obserwowane pp"), w => `${n(w.window_minutes, 0)} min / ${n(w.observed_pp)} pp`)}
        {row(t("Jointly priced / matched requests", "Wspólnie wycenione / dopasowane żądania"), w => ratio(w.usage.revaluation_events, w.usage.events))}
        {row(t("Jointly priced / matched tokens", "Wspólnie wycenione / dopasowane tokeny"), w => ratio(w.usage.revaluation_tokens, w.usage.tokens))}
        {row(t("Historical USD / 100 pp (joint cohort)", "Historyczne USD / 100 pp (wspólny zbiór)"), w => usd(referenceValuationPer100(w)?.historical ?? null))}
        {row(t("Reference USD / 100 pp (joint cohort)", "Referencyjne USD / 100 pp (wspólny zbiór)"), w => usd(referenceValuationPer100(w)?.reference ?? null))}
        {row(t("Cycle quality", "Jakość cyklu"), w => <WindowQualityLabel window={w} />)}
        {row(t("Cache reads / input tokens", "Odczyt cache / tokeny wejściowe"), w => ratio(w.usage.cached, w.usage.input))}
        {row(t("Fast / unknown-mode tokens", "Tokeny Fast / nieznany tryb"), w => `${ratio(w.usage.fast_tokens, w.usage.tokens)} · ${ratio(w.usage.unknown_tokens, w.usage.tokens)}`)}
        {row(t("Model share of matched tokens", "Udział modeli w dopasowanych tokenach"), w => w.models.length ? w.models.map(m => <div key={m.name}>{m.name}: {ratio(m.tokens, w.usage.tokens)}</div>) : "—")}
      </tbody></Table>
      {difference ? <p>{t("Historical change", "Zmiana historyczna")}: <strong>{usd(difference.historical_change)}</strong> ≈ {t("price effect", "wpływ cen")} <strong>{usd(difference.price_effect)}</strong> + {t("remaining work difference at fixed prices", "pozostała różnica pracy przy stałych cenach")} <strong>{usd(difference.fixed_price_work_difference)}</strong> (USD / 100 pp). {t("Displayed amounts are rounded.", "Wyświetlane kwoty są zaokrąglone.")}<br /><span className="mono">H₂ − H₁ = ((H₂ − R₂) − (H₁ − R₁)) + (R₂ − R₁)</span></p>
        : <p role="status">{t("Comparison unavailable", "Porównanie niedostępne")}: {issue ? t(...messages[issue]) : t("Choose two cycles.", "Wybierz dwa cykle.")}</p>}
      {openDataSettings && first && <button type="button" onClick={reviewData}>{t("Review comparison data", "Sprawdź dane porównania")}</button>}
    </> : <p role="status">{windows === null ? t("Cycle comparison is unavailable for this scope; select a subscription without a project filter.", "Porównanie cykli jest niedostępne w tym zakresie; wybierz subskrypcję bez filtra projektu.") : t("No cycles remain in the selected range and filters.", "Brak cykli w wybranym zakresie i filtrach.")}</p>}
    <p>{t("H and R use the exact same jointly priced requests within each cycle. Missing prices remain gaps; partial coverage describes only that subset. The remaining difference can reflect model mix, cache, context size, Standard/Fast or unknown modes, promotions and missing traffic. It does not prove a nominal allowance reduction.", "H i R obejmują dokładnie te same wspólnie wycenione żądania w każdym cyklu. Brakujące ceny pozostają lukami; częściowe pokrycie opisuje tylko ten podzbiór. Pozostała różnica może wynikać z udziału modeli, cache, rozmiaru kontekstu, trybu Standard/Fast lub nieznanego, promocji i brakującego ruchu. Nie dowodzi zmniejszenia nominalnego limitu.")}</p>
  </div>;
}
