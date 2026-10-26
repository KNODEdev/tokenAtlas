import { useEffect, useState } from "react";
import type { ModelCapacityRow, ModelCapacitySpread } from "../../shared/model-capacity";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { compact, usd, usageModelLabel } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { TableRow, EmptyState, ErrorState, HelpBlock, HelpDot, KpiStrip, LoadingCard, Table, Tabs, Td, Th } from "./ui";
import { ModelUsageShare } from "./ModelUsageShare";

type ModelCapacityProps = {
  provider: string; account: string; counter?: string; since: string; until: string; dataRevision?: number; project?: string;
};
/** Usage share by model above the capacity estimates; both read the same stored window sums. */
export function ModelCapacity(props: ModelCapacityProps) {
  const { provider, account, project } = props;
  const shared = (provider === "codex" || provider === "claude") && !project && !account.endsWith("::business");
  return <>
    {shared && <ModelUsageShare {...props} />}
    <ModelCapacityEstimates {...props} />
  </>;
}
function ModelCapacityEstimates({ provider, account, counter, since, until, dataRevision, project }: ModelCapacityProps) {
  const { t, locale } = useI18n();
  const [unit, setUnit] = useState<"tokens" | "api_usd">("tokens");
  const supported = (provider === "codex" || provider === "claude") && !project && !account.endsWith("::business");
  const state = useAsync(signal => supported ? api.modelCapacity({ provider, account, counter, since, until }, signal) : Promise.resolve(null),
    [provider, account, counter, since, until, dataRevision, supported], true);
  const preparing = state.data?.preparing_windows ?? 0;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(state.reload, 2000);
    return () => clearInterval(timer);
  }, [preparing, state.reload]);
  if (project) return <EmptyState title={t("Select the whole subscription", "Wybierz cały abonament")} />;
  if (!supported) return <EmptyState title={t("Codex and Claude", "Codex i Claude")} />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data || state.loading && !state.data.rows.length) return <LoadingCard label={t("Model capacity", "Pojemność modeli")} shape="table" />;
  const rows = state.data.rows;
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const format = (value: number) => unit === "tokens" ? compact(value) : usd(value);
  const mode = (row: ModelCapacityRow) => ({ standard: "Standard", fast: "Fast", unknown: t("unknown", "nieznany"), mixed: t("mixed", "mieszany") })[row.mode];
  const reasons: Record<string, string> = {
    unknown_plan: t("Plan unknown or changed within the window", "Plan nieznany lub zmieniony w oknie"),
    unknown_terms: t("Allowance terms unconfirmed", "Warunki limitu niepotwierdzone"),
    manual: t("Manual readings", "Odczyty ręczne"),
    meter_gap: t("More than 30 minutes between readings", "Ponad 30 minut między odczytami"),
    partial_prices: t("Incomplete prices; API median uses only fully priced samples", "Niepełne ceny; mediana API korzysta tylko z kompletnie wycenionych próbek"),
    unknown_mode: t("Some traffic has no recorded mode", "Część ruchu nie ma zapisanego trybu"),
    first_100: t("Sample ends at the first 100%; later traffic is excluded", "Próbka kończy się na pierwszym 100%; późniejszy ruch jest pominięty"),
    no_single_model_sample: t("No interval with only this model and a positive meter increase", "Brak przedziału z wyłącznie tym modelem i dodatnim przyrostem licznika"),
    small_sample: t("Fewer than three samples of 20 pp or two separate windows", "Mniej niż trzy próbki po 20 p.p. lub dwa osobne okna"),
    local_traffic: t("Observed local Claude traffic; other products and source completeness unconfirmed", "Zaobserwowany lokalny ruch Claude; inne produkty i kompletność źródeł niepotwierdzone"),
    uncertain_traffic: t("Known traffic with imprecise times prevents confirming a single-model sample", "Znany ruch o niedokładnym czasie uniemożliwia potwierdzenie próbki jednego modelu"),
    changing_terms: t("Allowance terms changed inside the sample or the configuration is invalid", "Warunki limitu zmieniły się w próbce lub konfiguracja jest nieprawidłowa"),
  };
  const titleOf = (row: ModelCapacityRow) => [row.from && `${row.from} → ${row.through}`,
    `${n(row.observed_pp)} ${t("pp", "p.p.")} · ${n(row.events)} ${t("calls", "wywołań")} · ${n(row.small_samples)} ${t("samples below 20 pp", "próbek poniżej 20 p.p.")}`,
    `${t("Mode", "Tryb")}: ${mode(row)}`, ...row.reasons.map(reason => reasons[reason] ?? reason)].filter(Boolean).join("\n");
  const spreadTitle = (spread: ModelCapacitySpread | null) => spread
    ? `${t("Middle 50% of sample estimates", "Środkowe 50% oszacowań próbek")}: ${format(spread.p25)} – ${format(spread.p75)}` : undefined;
  return <section aria-label={t("Capacity by model", "Pojemność według modeli")}>
    <div className="ui-toolbar">
      <HelpDot label={t("How model capacity is measured", "Jak mierzymy pojemność modeli")}>
        <HelpBlock>{t("Only intervals between two readings of the same account and counter with exactly one model qualify. Consecutive intervals, including traffic on an unchanged rounded percentage, form disjoint samples of at least 20 pp. Mixed-model traffic is never allocated by token or API share.", "Uwzględniamy tylko przedziały między dwoma odczytami tego samego konta i licznika z dokładnie jednym modelem. Sąsiednie przedziały, również z ruchem przy niezmienionym zaokrąglonym procencie, tworzą rozłączne próbki co najmniej 20 p.p. Ruchu mieszanego nie rozdzielamy według udziału tokenów ani API.")}</HelpBlock>
        <HelpBlock>{t("Usage / meter increase × 100 estimates the capacity at the observed input, output and cache mix. Plans, recorded modes and known allowance regimes remain separate. Values are historical estimates, not a confirmed current vendor limit. Source completeness is unconfirmed.", "Zużycie / przyrost licznika × 100 szacuje pojemność przy zaobserwowanym miksie inputu, outputu i cache. Plany, zapisane tryby i znane warunki limitu pozostają osobno. Wartości są historycznymi szacunkami, nie potwierdzonym obecnym limitem dostawcy. Kompletność źródeł jest niepotwierdzona.")}</HelpBlock>
        <HelpBlock>{t("Range boundaries keep whole samples; samples crossing them are omitted. Small samples stay visible as tentative estimates. API uses stored historical Standard prices and excludes incompletely priced samples from its median.", "Granice zakresu zachowują całe próbki; próbki przecinające je są pomijane. Małe próbki pozostają widoczne jako wstępne szacunki. API korzysta z zapisanych historycznych cen Standard i pomija niekompletnie wycenione próbki w medianie.")}</HelpBlock>
      </HelpDot>
      <span className="ui-spacer" />
      <Tabs value={unit} onChange={setUnit} options={[{ value: "tokens", label: t("Tokens", "Tokeny") }, { value: "api_usd", label: "API $" }]} />
    </div>
    <KpiStrip items={[
      { label: t("Models", "Modele"), value: new Set(rows.filter(row => row.tokens).map(row => row.model)).size },
      { label: t("Samples ≥20 pp", "Próbki ≥20 p.p."), value: rows.reduce((sum, row) => sum + row.samples, 0) },
      { label: t("Meter increase", "Przyrost licznika"), value: `${n(rows.reduce((sum, row) => sum + row.observed_pp, 0))} ${t("pp", "p.p.")}` },
    ]} />
    {preparing > 0 && <LoadingCard label={`${t("Preparing windows", "Przygotowywanie okien")}: ${preparing}`} shape="table" />}
    {!rows.length && !preparing && <EmptyState title={t("No single-model samples", "Brak próbek z jednym modelem")} />}
    {!!rows.length && <Table tableId="ModelCapacity:0"><thead><TableRow header>
      <Th columnId="c0">{t("Model", "Model")}</Th><Th columnId="c1">{t("Plan", "Plan")}</Th><Th columnId="c2">{t("Mode", "Tryb")}</Th><Th columnId="c3" defaultHidden>{t("Sample dates", "Daty próbek")}</Th>
      <Th columnId="c4" align="right">{t("Median at 100%", "Mediana na 100%")}</Th><Th columnId="c5">{t("Middle 50%", "Środkowe 50%")}</Th>
      <Th columnId="c6" align="right">{t("Per 1%", "Na 1%")}</Th><Th columnId="c7" align="right">{t("Samples", "Próbki")}</Th><Th columnId="c8" align="right">{t("Windows", "Okna")}</Th>
    </TableRow></thead><tbody>{rows.map(row => {
      const estimate = row[unit], title = titleOf(row);
      return <TableRow key={row.key} title={title}>
        <Td>{usageModelLabel(row.model)}</Td><Td>{row.plan ?? "—"}{row.allowance_factor !== null && row.allowance_factor !== 1 ? ` · ×${n(row.allowance_factor)}` : ""}</Td><Td>{mode(row)}</Td>
        <Td mono>{row.from ? `${row.from.slice(0, 10)} → ${row.through?.slice(0, 10)}` : "—"}</Td>
        <Td mono align="right" title={unit === "api_usd" ? `${title}\n${row.priced_samples} ${t("fully priced samples", "kompletnie wycenionych próbek")}` : title}>
          <span style={{ color: row.tentative ? "var(--warn)" : undefined }}>{estimate ? `≈ ${format(estimate.median)}` : "—"}{estimate && row.tentative ? " ?" : ""}</span>
        </Td>
        <Td title={spreadTitle(estimate)}>
          <span className="mono">{estimate ? `${format(estimate.p25)} – ${format(estimate.p75)}` : "—"}</span>
        </Td>
        <Td mono align="right">{estimate ? format(estimate.median / 100) : "—"}</Td>
        <Td mono align="right" title={title}>{row.samples || (row.small_samples ? `${row.small_samples} ?` : "—")}</Td>
        <Td mono align="right">{row.windows || "—"}</Td>
      </TableRow>;
    })}</tbody></Table>}
  </section>;
}
