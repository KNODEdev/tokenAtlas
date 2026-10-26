import { ChartExport } from "./ChartExport";
import { useState } from "react";
import type { CapacityCycleModel } from "../../shared/capacity-cycle";
import { isCodexInternalReview } from "../../shared/codex-internal";
import { compact, countLabel, full, pct, usageModelLabel } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { usageWithContext } from "../lib/capacity-context";
import { CAPACITY_MEASURE_COLOR, TOKEN_TYPE_COLOR } from "../lib/codex-capacity";
import { TableRow, CardTitle, Dropdown, HelpBlock, HelpDot, Table, Td, Th } from "./ui";
import "./CapacityCycleModels.css";

type Metric = "api_standard" | "credits_low" | "tokens";
const tokenParts = ["fresh", "cached", "cache_write", "output"] as const;
const colors = TOKEN_TYPE_COLOR;

function value(row: CapacityCycleModel, metric: Metric): number | null {
  return metric !== "tokens" && row.events <= row.unpriced_events ? null : row[metric];
}

/** API value per 1M tokens of the priced traffic only, so unpriced requests neither dilute nor inflate it. */
export function apiPerMillion(row: CapacityCycleModel): number | null {
  return value(row, "api_standard") === null || row.priced_tokens <= 0 ? null : 1e6 * row.api_standard / row.priced_tokens;
}

/** Cache read as a share of all input, the definition the window table's "Cache / input" uses. */
export function cacheShare(row: CapacityCycleModel): number | null {
  return row.input > 0 ? 100 * row.cached / row.input : null;
}

const SUMMED = ["events", "tokens", "input", "cached", "output", "fast_tokens", "unknown_tokens", "priced_tokens", "unpriced_events",
  "api_standard", "credits_low", "credits_high"] as const;

/** All models as one row; cache write stays unknown when any model's is. */
function totalOf(rows: CapacityCycleModel[], name: string): CapacityCycleModel {
  const total = Object.fromEntries(SUMMED.map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)])) as Record<typeof SUMMED[number], number>;
  return { ...total, name, pricing_issues: {}, cache_write_in_input: rows.every(row => row.cache_write_in_input),
    cache_write: rows.some(row => row.cache_write === null) ? null : rows.reduce((sum, row) => sum + row.cache_write!, 0) };
}

export function CapacityCycleModels({ models, creditsAvailable, contextImpact = false }: { models: CapacityCycleModel[]; creditsAvailable: boolean; contextImpact?: boolean }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<Metric>("api_standard");
  const activeMetric = !creditsAvailable && metric === "credits_low" ? "tokens" : metric;
  const money = (amount: number) => amount.toLocaleString(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: amount > 0 && amount < .01 ? 4 : 2 });
  const decimal = (amount: number) => amount.toLocaleString(locale, { maximumFractionDigits: 2 });
  const metricLabel = activeMetric === "api_standard" ? "API · USD" : activeMetric === "credits_low" ? "Credits" : t("Tokens", "Tokeny");
  const amount = (row: CapacityCycleModel, key: Metric) => {
    const n = value(row, key);
    if (n === null) return t("No valuation", "Brak wyceny");
    return (key !== "tokens" && row.unpriced_events > 0 ? "≥ " : "") + (key === "api_standard" ? money(n) : key === "tokens" ? compact(n) : decimal(n));
  };
  const rows = models.map(row => contextImpact ? usageWithContext(row, true) : row)
    .sort((a, b) => (value(b, activeMetric) ?? -1) - (value(a, activeMetric) ?? -1) || a.name.localeCompare(b.name));
  const maximum = Math.max(0, ...rows.map(row => value(row, activeMetric) ?? 0));
  const total = rows.reduce((sum, row) => sum + (value(row, activeMetric) ?? 0), 0);
  const writeIncluded = rows.every(row => row.cache_write_in_input && row.cache_write !== null);
  const visibleParts = writeIncluded ? tokenParts : tokenParts.filter(part => part !== "cache_write");
  const partLabels = { fresh: writeIncluded ? t("Input without cache", "Input bez cache") : t("Input without cache read", "Input bez cache read"), cached: "Cache read", cache_write: "Cache write", output: "Output" };
  const reasons: Record<string, string> = {
    missing_rate: t("No configured rate", "Brak ustalonej stawki"), invalid_tokens: t("Invalid token counters", "Nieprawidłowe liczniki tokenów"),
    incomplete_usage: t("Incomplete usage record", "Niepełny zapis zużycia"), invalid_timestamp: t("Invalid event date", "Nieprawidłowa data zdarzenia"),
    missing_cache_write_rate: t("Cache write rate missing", "Brak stawki zapisu cache"),
    cache_write_semantics_unknown: t("Cache write credit accounting unconfirmed", "Nieustalony sposób naliczania kredytów za zapis cache"),
    invalid_cache_totals: t("Inconsistent cache counters", "Niespójne liczniki cache"), unknown_mode: t("Billing mode unconfirmed", "Nieustalony tryb naliczania"),
  };
  const tokenCell = (n: number | null) => <Td mono align="right" title={full(n)}>{compact(n)}</Td>;
  const requests = (n: number) => countLabel(n, ["request", "requests"], ["żądanie", "żądania", "żądań"]);
  // A tiny but nonzero share must not read as zero.
  const share = (n: number) => { const s = 100 * n / total; return s > 0 && s < .1 ? `< ${(.1).toLocaleString(locale)}%` : s.toLocaleString(locale, { maximumFractionDigits: 1 }) + "%"; };
  const perMillion = (row: CapacityCycleModel) => { const n = apiPerMillion(row); return n === null ? "—" : money(n); };
  const totals = rows.length > 1 ? totalOf(rows, t("Total", "Razem")) : null;
  const modelCells = (row: CapacityCycleModel) => <>
    <Td mono align="right">{amount(row, "api_standard")}</Td>{creditsAvailable && <Td mono align="right">{amount(row, "credits_low")}</Td>}
    <Td mono align="right" title={row.unpriced_events > 0 ? `${t("Priced tokens", "Wycenione tokeny")}: ${full(row.priced_tokens)}` : undefined}>{perMillion(row)}</Td>
    {tokenCell(row.input)}{tokenCell(row.cached)}<Td mono align="right">{pct(cacheShare(row), 1)}</Td>{tokenCell(row.cache_write)}{tokenCell(row.output)}{tokenCell(row.tokens)}</>;
  return <section className="capacity-cycle-models" aria-label={t("Models in this cycle", "Modele w tym cyklu")}>
    <CardTitle title={t("Models in the whole cycle", "Modele w całym cyklu")}
      right={<HelpDot label={t("Model comparison basis", "Podstawa porównania modeli")}><HelpBlock>{t("All recorded traffic assigned to this cycle, including traffic outside the meter sample.", "Cały zapisany ruch przypisany do tego cyklu, również poza próbką licznika.")}</HelpBlock><HelpBlock>{t("API uses each event's Standard rates. Values are price equivalents, not a subscription bill.", "API stosuje stawki Standard z daty zdarzenia. Kwoty są ekwiwalentami cenowymi, nie rachunkiem za abonament.")}</HelpBlock>
        {creditsAvailable && <HelpBlock>{t("Credits retain confirmed Fast usage; missing mode records use Standard. ≥ marks a priced subtotal.", "Credits uwzględniają potwierdzony Fast; brak zapisu trybu oznacza przyjęcie Standard. ≥ oznacza wycenioną część.")}</HelpBlock>}
        <HelpBlock>{t("Shares refer to the priced portion. A missing price is not zero cost.", "Udziały dotyczą wycenionej części. Brak ceny nie oznacza zerowego kosztu.")}</HelpBlock>
        <HelpBlock>{t("USD / 1M is the API value divided by the priced tokens, input and output together. Cache / input is cache read divided by all input.", "USD / 1M to wartość API podzielona przez wycenione tokeny, wejście i wyjście razem. Cache / input to cache read podzielony przez całe wejście.")}</HelpBlock>
        <HelpBlock>{rows.every(row => row.cache_write_in_input)
          ? t("Input includes cache read and cache write. Total = Input + Output.", "Input zawiera cache read i cache write. Suma = Input + Output.")
          : t("Cache read is part of Input. Cache write is shown separately; its overlap with input is unconfirmed. Total = Input + Output.", "Cache read jest częścią Input. Cache write pokazujemy osobno — jego nakładanie się na input jest nieustalone. Suma = Input + Output.")}</HelpBlock>
      </HelpDot>} />
    {!rows.length ? <p className="capacity-cycle-note">{t("No recorded model usage in this cycle.", "Brak zapisanego zużycia modeli w tym cyklu.")}</p> : <>
      <div className="ui-toolbar">
        <label className="ui-field"><span className="ui-field-label">{t("Compare by", "Porównaj według")}</span>
          {/* Bare: the cycle drawer gives it the look of its other fields. */}
          <Dropdown className="" ariaLabel={t("Model chart metric", "Miara wykresu modeli")} value={activeMetric} onChange={value => setMetric(value as Metric)} options={[
            { value: "api_standard", label: "API · USD" }, ...(creditsAvailable ? [{ value: "credits_low", label: "Credits" }] : []), { value: "tokens", label: t("Tokens", "Tokeny") },
          ]} />
        </label>
        <span className="capacity-cycle-note">{countLabel(rows.length, ["model", "models"], ["model", "modele", "modeli"])}{" · "}{t("Sorted from largest usage", "Od największego zużycia")}</span>
      </div>
      <ChartExport title={t("Model usage comparison", "Porównanie zużycia modeli") + " · " + metricLabel}><figure className="capacity-model-chart" aria-label={t("Model usage comparison", "Porównanie zużycia modeli") + " · " + metricLabel}>
        {rows.map(row => {
          const n = value(row, activeMetric), width = maximum > 0 && n !== null ? 100 * n / maximum : 0;
          const parts = { fresh: Math.max(0, row.input - row.cached - (writeIncluded ? row.cache_write ?? 0 : 0)), cached: row.cached, cache_write: row.cache_write ?? 0, output: row.output };
          const title = `${usageModelLabel(row.name)} · ${amount(row, activeMetric)}${activeMetric === "tokens" ? ` (${full(row.tokens)})` : ""}`;
          return <div key={row.name} className="capacity-model-chart-row">
            <span title={row.name}>{usageModelLabel(row.name)}</span>
            <div className="capacity-model-track" data-unpriced={n === null || undefined} role="img" aria-label={title} title={title}>
              {n === null ? <span className="capacity-model-unpriced">{t("No valuation", "Brak wyceny")}</span>
                : <div className="capacity-model-fill" style={{ width: `${width}%`, background: CAPACITY_MEASURE_COLOR[activeMetric] }}>
                  {activeMetric === "tokens" && visibleParts.map(part => <span key={part} title={`${partLabels[part]}: ${full(parts[part])}`}
                    style={{ width: `${row.tokens > 0 ? 100 * parts[part] / row.tokens : 0}%`, background: colors[part] }} />)}
                </div>}
            </div>
            <span className="mono capacity-model-amount" title={activeMetric === "tokens" ? full(row.tokens) : undefined}>{n === null ? "—" : amount(row, activeMetric)}</span>
            <span className="mono capacity-model-share">{n !== null && total > 0 ? share(n) : "—"}</span>
          </div>;
        })}
        {activeMetric === "tokens" && <figcaption className="capacity-cycle-note"><span className="ui-toolbar">{visibleParts.map(part => <span key={part}><span style={{ color: colors[part] }}>■</span> {partLabels[part]}</span>)}</span></figcaption>}
      </figure></ChartExport>
      <Table tableId="CapacityCycleModels:0"><thead><TableRow header><Th columnId="c0">{t("Model", "Model")}</Th><Th columnId="c1" align="right">API · USD</Th>{creditsAvailable && <Th columnId="c2" align="right">Credits</Th>}
        <Th columnId="c8" align="right" title={t("API value per 1M priced tokens", "Wartość API na 1 mln wycenionych tokenów")}>USD / 1M</Th>
        <Th columnId="c3" align="right" title={t("Total input, including cache", "Całe wejście, łącznie z cache")}>Input</Th><Th columnId="c4" align="right">Cache read</Th>
        <Th columnId="c9" align="right" title={t("Cache read divided by all input", "Cache read podzielony przez całe wejście")}>Cache / input</Th>
        <Th columnId="c5" align="right">Cache write</Th><Th columnId="c6" align="right">Output</Th><Th columnId="c7" align="right">{t("Total tokens", "Suma tokenów")}</Th></TableRow></thead>
        <tbody>{rows.map(row => <TableRow key={row.name}><Td title={row.name}>{usageModelLabel(row.name)}<div className="capacity-cycle-note">{requests(row.events)}</div></Td>{modelCells(row)}</TableRow>)}</tbody>
        {totals && <tfoot><TableRow className="capacity-model-total"><Td>{totals.name}<div className="capacity-cycle-note">{requests(totals.events)}</div></Td>{modelCells(totals)}</TableRow></tfoot>}
      </Table>
      {rows.filter(row => row.unpriced_events > 0).map(row => <p key={row.name} className="capacity-cycle-notice"><strong>{usageModelLabel(row.name)}</strong>: {full(row.tokens - row.priced_tokens)} {t("tokens without valuation", "tokenów bez wyceny")} ({requests(row.unpriced_events)}). {isCodexInternalReview(row.name)
        ? t("Internal action review; no established price. Token records are retained.", "Wewnętrzna kontrola działań; brak ustalonej ceny. Zapisy tokenów są zachowane.")
        : Object.keys(row.pricing_issues).map(reason => reasons[reason] ?? t("Valuation unavailable", "Wycena niedostępna")).join(" · ") + "."}</p>)}
    </>}
  </section>;
}
