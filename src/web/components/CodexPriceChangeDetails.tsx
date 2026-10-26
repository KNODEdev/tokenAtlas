import type { CodexTokenRates } from "../../shared/codex-accounting";
import { uniformPriceRatio, type CodexPriceChange } from "../../shared/codex-price-changes";
import { useI18n } from "../lib/i18n";
import { TableRow, Table, Td, Th } from "./ui";

export function CodexPriceChangeDetails({ change }: { change: CodexPriceChange }) {
  const { t, locale } = useI18n();
  const number = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 4 });
  const vector = (rates: CodexTokenRates | null) => rates
    ? [rates.in_uncached, rates.in_cache_read, rates.out_total].map(number).join(" / ")
    : t("Not established", "Nie ustalono");
  return <div>
    <p>{t("Standard rates per million tokens: fresh input / cache read / output. Earlier vectors are reconstructed references; the exact intraday change time is unknown (UTC date boundary).", "Stawki Standard za milion tokenów: świeże wejście / cache read / wyjście. Wcześniejsze wektory są rekonstrukcją referencyjną; dokładna godzina zmiany jest nieznana (granica daty UTC).")}</p>
    <Table tableId="CodexPriceChangeDetails:0"><thead><TableRow header><Th columnId="c0">{t("Model", "Model")}</Th><Th columnId="c1">API USD · {t("before → after", "przed → po")}</Th><Th columnId="c2">{t("Credits · before → after", "Kredyty · przed → po")}</Th><Th columnId="c3">{t("Same credit budget", "Ten sam budżet kredytów")}</Th></TableRow></thead>
      <tbody>{change.models.map(model => {
        const ratio = model.creditsBefore ? uniformPriceRatio(model.creditsBefore, model.creditsAfter) : null;
        return <TableRow key={model.name}><Td>{model.name}</Td><Td mono>{vector(model.apiBefore)} → {vector(model.apiAfter)}</Td>
          <Td mono>{vector(model.creditsBefore)} → {vector(model.creditsAfter)}</Td>
          <Td>{ratio ? `${number(1 / ratio)}× ` + t("as many identical tokens, conditionally", "tyle identycznych tokenów, warunkowo") : t("Historical credit rate unverified", "Dawna stawka kredytowa niepotwierdzona")}</Td></TableRow>;
      })}</tbody></Table>
    {change.includedUsage === "declared_change" ? <p>{t(
      "OpenAI links this reduction to updated usage limits. If API and allowance consumption fall in the same proportion while the budget stays fixed, more identical work fits but its value at the new API prices stays unchanged. A lower dollar bar cannot be explained by the API reduction alone under that scenario.",
      "OpenAI łączy tę obniżkę z aktualizacją limitów użycia. Jeśli cena API i koszt obciążający abonament spadają proporcjonalnie, a budżet pozostaje stały, mieści się więcej identycznej pracy, lecz jej wartość w nowych cenach API się nie zmienia. W tym scenariuszu sama obniżka API nie wyjaśnia niższego słupka dolarowego."
    )}</p> : <p>{t(
      "The Sol promotion is also noted beneath the credit table. The old credit vector and its change date are not confirmed. Test both scenarios: unchanged 100 / 10 / 500 credits, or a proportional reduction from 125 / 12.5 / 750. The second vector is a hypothesis, not a historical tariff. Do not classify this as API-only. The promotion lasts at least through November 21; its end is unknown.",
      "Promocja Sola jest opisana również pod tabelą kredytów. Nie potwierdzono starego wektora ani daty jego zmiany. Sprawdzamy dwa scenariusze: niezmienione 100 / 10 / 500 kredytów albo proporcjonalna obniżka ze 125 / 12,5 / 750. Drugi wektor jest hipotezą, nie historyczną taryfą. Nie klasyfikujemy tego jako zmiany wyłącznie API. Promocja trwa co najmniej do 21 listopada; koniec jest nieznany."
    )}</p>}
    <p>{t("Nominal Pro budget: unverified. Credit rates help explain consumption but do not establish a fixed credit allowance behind the percentage meter. Model/cache mix, Fast, context, missing logs and resets must also be controlled.", "Nominalny budżet Pro: niepotwierdzony. Stawki kredytowe pomagają wyjaśnić zużycie, lecz nie ustalają stałej liczby kredytów ukrytej pod licznikiem procentowym. Trzeba również kontrolować miks modeli/cache, Fast, kontekst, braki logów i resety.")}</p>
    <p>{t("Sources", "Źródła")}: {change.sources.map((source, index) => <span key={source}>{index > 0 && " · "}<a href={source} target="_blank" rel="noreferrer">{new URL(source).hostname}{new URL(source).pathname}</a></span>)}</p>
  </div>;
}
