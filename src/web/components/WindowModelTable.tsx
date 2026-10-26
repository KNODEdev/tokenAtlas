import type { WindowTokenCounts } from "../../shared/window-model-usage";
import { full, usd, usageModelLabel } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
import { freshWindowInput, sumWindowTokens, totalWindowTokens, windowTokenDefinitions, windowTokenLabels } from "../lib/window-tokens";
import { Table, TableRow, Td, Th } from "./ui";
import "./CodexWindowModels.css";

export interface WindowModelPrice { total: number; pricedTokens: number }
export interface WindowModelSummary extends WindowTokenCounts {
  model: string;
  calls: number;
  api: WindowModelPrice | null;
  /** Undefined means this provider has no Standard credit unit. */
  credits?: WindowModelPrice | null;
}

const percent = (part: number, whole: number) => whole > 0
  ? `${(100 * part / whole).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%` : "—";
const addPrice = (rows: WindowModelSummary[], key: "api" | "credits"): WindowModelPrice | null => {
  const priced = rows.flatMap(row => row[key] ? [row[key]!] : []);
  return priced.length ? { total: priced.reduce((sum, row) => sum + row.total, 0),
    pricedTokens: priced.reduce((sum, row) => sum + row.pricedTokens, 0) } : null;
};

function modelCells(row: WindowModelSummary, whole: number, bold: boolean, t: (en: string, pl: string) => string) {
  const total = totalWindowTokens(row);
  const cell = (value: string) => bold ? <strong>{value}</strong> : value;
  const amount = (price: WindowModelPrice | null | undefined, credits = false) => {
    if (price === undefined) return t("not applicable", "nie dotyczy");
    if (!price || price.pricedTokens <= 0) return t("no rate", "brak stawki");
    return `${price.pricedTokens < total ? "≥ " : ""}${credits
      ? price.total.toLocaleString(getLocale(), { maximumFractionDigits: 2 }) : usd(price.total)}`;
  };
  return <>
    <Td align="right" mono>{cell(full(row.calls))}</Td>
    <Td mono><span className="codex-models-share">
      {!bold && <span className="codex-models-share-track" title={percent(total, whole)}>
        <span style={{ width: `${whole > 0 ? 100 * total / whole : 0}%` }} />
      </span>}{cell(full(total))}
    </span></Td>
    <Td align="right" mono>{cell(full(row.input))}</Td>
    <Td align="right" mono>{cell(row.cache_write_complete === false ? "—" : full(freshWindowInput(row)))}</Td>
    <Td align="right" mono>{cell(full(row.cached))}</Td>
    <Td align="right" mono>{cell(row.cache_write_complete === false ? (row.cache_write > 0 ? `≥ ${full(row.cache_write)}` : "—") : full(row.cache_write))}</Td>
    <Td align="right" mono title={`${full(row.cached)} / ${full(row.input)}`}>{cell(percent(row.cached, row.input))}</Td>
    <Td align="right" mono title={row.reasoning > 0 ? `${t("including reasoning", "w tym rozumowanie")}: ${full(row.reasoning)}` : undefined}>{cell(full(row.output))}</Td>
    <Td align="right" mono style={{ borderLeft: "1px solid var(--line)" }}>{cell(amount(row.api))}</Td>
    <Td align="right" mono>{cell(row.api && row.api.pricedTokens > 0 ? usd(row.api.total * 1_000_000 / row.api.pricedTokens) : "—")}</Td>
    <Td align="right" mono>{cell(amount(row.credits, true))}</Td>
  </>;
}

/** Both providers use the same columns, definitions and weighted totals. */
export function WindowModelTable({ rows, tableId, onOpen, selectedModel }: {
  rows: WindowModelSummary[];
  tableId: string;
  onOpen?: (model: string, opener: HTMLElement | null) => void;
  selectedModel?: string;
}) {
  const { t } = useI18n();
  const labels = windowTokenLabels(t), definitions = windowTokenDefinitions(t);
  const total: WindowModelSummary = { ...sumWindowTokens(rows), model: t("Total", "Razem"),
    calls: rows.reduce((sum, row) => sum + row.calls, 0), api: addPrice(rows, "api"),
    credits: rows.every(row => row.credits === undefined) ? undefined : addPrice(rows, "credits") };
  const whole = totalWindowTokens(total);
  return <div className="codex-models-table"><Table tableId={tableId}>
    <thead><TableRow header>
      <Th columnId="c0">{t("Model", "Model")}</Th>
      <Th columnId="c1" align="right">{t("Calls", "Wywołania")}</Th>
      <Th columnId="c2" title={`${definitions.total} ${t("The bar shows the model's share of all tokens in the window.", "Pasek pokazuje udział modelu we wszystkich tokenach okna.")}`}>{labels.total}</Th>
      <Th columnId="input" align="right" title={definitions.input}>{labels.input}</Th>
      <Th columnId="fresh" align="right" title={definitions.fresh}>{labels.fresh}</Th>
      <Th columnId="cached" align="right" title={definitions.cached}>{labels.cached}</Th>
      <Th columnId="cache-write" align="right" title={definitions.cache_write}>{labels.cache_write}</Th>
      <Th columnId="c3" align="right" title={definitions.cache_share}>{labels.cache_share}</Th>
      <Th columnId="c4" align="right" title={definitions.output}>{labels.output}</Th>
      <Th columnId="c5" align="right" className="codex-models-price"
        title={t("Traffic valued at dated Standard API rates; a comparison estimate, not the subscription payment.", "Ruch wyceniony według datowanych stawek Standard API; szacunek do porównań, nie opłata abonamentowa.")}>{t("API Standard", "API Standard")}</Th>
      <Th columnId="c6" align="right" title={t("API Standard per million priced tokens", "API Standard na milion wycenionych tokenów")}>{t("$/M tok.", "$/M tok.")}</Th>
      <Th columnId="c7" align="right">{t("Credits Standard", "Kredyty Standard")}</Th>
    </TableRow></thead>
    <tbody>{rows.map(row => <TableRow key={row.model} className={onOpen ? `ui-open-row${selectedModel === row.model ? " is-selected" : ""}` : undefined}
      onClick={onOpen ? event => onOpen(row.model, event.currentTarget.querySelector("button")) : undefined}>
      <Td title={row.model}>{onOpen ? <button type="button" className="ui-open-row-button" aria-haspopup="dialog"
        onClick={event => { event.stopPropagation(); onOpen(row.model, event.currentTarget); }}>
        {usageModelLabel(row.model)} <span aria-hidden="true">›</span>
      </button> : usageModelLabel(row.model)}</Td>
      {modelCells(row, whole, false, t)}
    </TableRow>)}
      <TableRow><Td><strong>{total.model}</strong></Td>{modelCells(total, whole, true, t)}</TableRow>
    </tbody>
  </Table></div>;
}
