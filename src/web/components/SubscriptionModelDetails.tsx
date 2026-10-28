import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { full, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { TableRow, HelpBlock, HelpDot, EmptyState, Fact, Facts, GhostButton, Table, Td, Th } from "./ui";
import { modelVersionSortValue, useTableSort } from "../lib/table-sort";

const PAGE_SIZE = 50;

const BUCKETS = [
  { key: "in_uncached", label: "Input uncached", pl: "Wejście bez cache", priced: true },
  { key: "in_cache_read", label: "Cache read", pl: "Odczyt z cache", priced: true },
  { key: "in_cache_write_5m", label: "Cache write 5m", pl: "Zapis cache 5 min", priced: true },
  { key: "in_cache_write_1h", label: "Cache write 1h", pl: "Zapis cache 1 godz.", priced: true },
  { key: "in_cache_write_unknown", label: "Cache write unknown", pl: "Zapis cache nieznany", priced: true },
  { key: "out_total", label: "Output", pl: "Wyjście", priced: true },
  { key: "out_thinking", label: "Reasoning subset", pl: "W tym rozumowanie", priced: false },
] as const;

type BucketKey = (typeof BUCKETS)[number]["key"];
type NumericValue = number | null | undefined;
type NumericRecord = Record<string, NumericValue>;

interface PartialSum {
  value: number | null;
  partial: boolean;
}

interface Summary {
  calls: PartialSum;
  quantities: Record<BucketKey, PartialSum>;
  tokens: PartialSum;
  apiStandard: PartialSum;
  apiActual: PartialSum;
}

const monoGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(140px, 1.4fr) repeat(3, minmax(92px, auto))",
  gap: "4px 10px",
  alignItems: "baseline",
};

function finite(value: NumericValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function partialSum(values: NumericValue[]): PartialSum {
  let value = 0;
  let known = 0;
  let partial = false;
  for (const raw of values) {
    const item = finite(raw);
    if (item === null) {
      partial = true;
      continue;
    }
    value += item;
    known += 1;
  }
  return { value: known ? value : null, partial };
}

function numericRecord(values: Record<string, NumericValue>): NumericRecord {
  return values as NumericRecord;
}

function rowQuantity(row: SubscriptionModelDetail, key: BucketKey): number | null {
  return finite(numericRecord(row.quantities)[key]);
}

function rowRate(row: SubscriptionModelDetail, key: BucketKey): number | null {
  return finite(numericRecord(row.rates)[key]);
}

function rowCost(row: SubscriptionModelDetail, key: BucketKey): number | null {
  return finite(numericRecord(row.costs)[key]);
}

function summarize(rows: SubscriptionModelDetail[]): Summary {
  const quantities = Object.fromEntries(BUCKETS.map(({ key }) => [key, partialSum(rows.map((row) => rowQuantity(row, key)))])) as Record<BucketKey, PartialSum>;
  return {
    calls: partialSum(rows.map((row) => row.calls)),
    quantities,
    tokens: partialSum(rows.map((row) => row.tokens)),
    apiStandard: partialSum(rows.map((row) => row.api_standard)),
    apiActual: partialSum(rows.map((row) => row.api_actual)),
  };
}

function numberText(value: number | null, partial = false): string {
  if (value === null) return "—";
  return `${partial ? "≥ " : ""}${full(value)}`;
}

function rateText(value: number | null, locale: string): string {
  if (value === null) return "—";
  return value.toLocaleString(locale, { maximumFractionDigits: 6 });
}

function moneyText(value: number | null, partial = false): string {
  if (value === null) return "—";
  return `${partial ? "≥ " : ""}${usd(value)}`;
}

function sourceNode(source: string | null): ReactNode {
  if (!source) return <span>—</span>;
  if (/^https?:\/\//i.test(source)) return <a href={source} target="_blank" rel="noreferrer">{source}</a>;
  return <span>{source}</span>;
}

function hasMissingActualPricing(row: SubscriptionModelDetail): boolean {
  if (finite(row.tokens) === null || row.tokens <= 0) return false;
  if (row.api_actual == null || !Number.isFinite(row.api_actual)) return true;
  return BUCKETS.some(({ key, priced }) => {
    if (!priced) return false;
    const quantity = rowQuantity(row, key);
    if (quantity !== null && quantity <= 0) return false;
    return rowRate(row, key) === null || rowCost(row, key) === null;
  });
}

function pricingIssueLabel(row: SubscriptionModelDetail, t: (en: string, pl: string) => string): string {
  return row.pricing_issue === "unknown_mode" ? t("mode not recorded", "tryb niezapisany") : t("missing rates", "brak stawek");
}

function rowTarget(row: SubscriptionModelDetail, account: string, t: (en: string, pl: string) => string): DataSettingsTarget {
  const speed = row.speed === "standard" || row.speed === "fast" ? row.speed : undefined;
  return {
    area: row.pricing_issue === "unknown_mode" ? "data" : "rates",
    account,
    since: row.day,
    until: row.day,
    model: row.model,
    basis: "api_equivalent_usd",
    ...(speed ? { speed } : {}),
    issue: row.pricing_issue === "unknown_mode" ? t("The event mode is unknown; inspect source completeness. Editing a rate does not establish the recorded mode.", "Tryb zdarzenia jest nieznany; sprawdź kompletność źródeł. Edycja stawki nie ustala trybu użytego w zdarzeniu.") : t("Missing actual model rate or bucket cost for this date.", "Brak rzeczywistej stawki modelu lub kosztu bucketu dla tej daty."),
  };
}

function BucketDetails({ row, locale, t }: { row: SubscriptionModelDetail; locale: string; t: (en: string, pl: string) => string }) {
  return <section style={{ whiteSpace: "normal" }}>
    <h3>{t("Actual pricing", "Rzeczywisty cennik")}</h3>
    <HelpDot label={t("Actual pricing rules", "Zasady rzeczywistej wyceny")}>
      {t("quantity × rate / 1M = cost", "ilość × stawka / 1M = koszt")} · {t("API Standard is comparison only", "API Standard jest tylko porównaniem")}
    </HelpDot>
    <div className="mono" style={{ ...monoGrid, marginTop: 8, color: "var(--faint)", fontSize: "var(--fs-2)" }}>
      <strong>{t("Bucket", "Bucket")}</strong><strong>{t("Quantity", "Ilość")}</strong><strong>{t("Actual rate / 1M", "Rzeczywista stawka / 1M")}</strong><strong>{t("Actual cost", "Rzeczywisty koszt")}</strong>
      {BUCKETS.map(({ key, label, pl, priced }) => {
        const quantity = rowQuantity(row, key);
        const rate = rowRate(row, key);
        const cost = rowCost(row, key);
        const missing = priced && (rate === null || cost === null) && (quantity === null || quantity > 0);
        return <div key={key} style={{ display: "contents" }}>
          <span>{t(label, pl)}{!priced && <span style={{ color: "var(--muted)" }}> · {t("inside output", "w output")}</span>}</span>
          <span>{numberText(quantity)}</span>
          <span>{priced && rate === null ? <span className="ui-missing">{t("no rate", "brak stawki")}</span> : rateText(rate, locale)}</span>
          <span>{priced && cost === null ? <span className="ui-missing">{t("no rate", "brak stawki")}</span> : moneyText(cost)}{missing && <span style={{ color: "var(--warn)", marginLeft: 6 }}>{pricingIssueLabel(row, t)}</span>}</span>
        </div>;
      })}
      <strong>{t("Actual total", "Rzeczywista suma")}</strong><strong>{numberText(finite(row.tokens))}</strong><span>—</span><strong>{finite(row.api_actual) === null ? pricingIssueLabel(row, t) : moneyText(finite(row.api_actual))}</strong>
    </div>
    <HelpDot label={t("Pricing source", "Źródło cennika")}>
      <HelpBlock>{t("Pricing source", "Źródło cennika")}: {sourceNode(row.pricing_source)}</HelpBlock>
      {row.pricing_note && <HelpBlock>{t("Pricing note", "Notatka cennika")}: {row.pricing_note}</HelpBlock>}
      <HelpBlock>{t("Reasoning is a subset of output and is not charged a second time.", "Rozumowanie jest częścią wyjścia i nie jest naliczane drugi raz.")}</HelpBlock>
    </HelpDot>
  </section>;
}

export function SubscriptionModelDetailBody({ row, openDataSettings, account }: { row: SubscriptionModelDetail; openDataSettings?: (target: DataSettingsTarget) => void; account: string }) {
  const { locale, t } = useI18n();
  return <>
    <Facts>
      <Fact label={t("Day", "Dzień")} value={row.day} />
      <Fact label={t("Model", "Model")} value={row.model} />
      <Fact label={t("Mode", "Tryb")} value={row.speed} />
      <Fact label={t("Source", "Źródło")} value={row.source} />
      <Fact label={t("Calls", "Wywołania")} value={numberText(finite(row.calls))} />
      <Fact label={t("Tokens", "Tokeny")} value={numberText(finite(row.tokens))} />
      <Fact label={t("API Standard", "API Standard")} value={finite(row.api_standard) === null ? <span className="ui-missing">{t("no rate", "brak stawki")}</span> : moneyText(finite(row.api_standard))} />
      {/* The missing-pricing reason is said once, as the value; a partial figure keeps its amount and is marked by tone. */}
      <Fact label={t("API actual", "API rzeczywiste")} tone={hasMissingActualPricing(row) ? "warn" : undefined}
        value={finite(row.api_actual) === null ? pricingIssueLabel(row, t) : moneyText(finite(row.api_actual))} />
    </Facts>
    <BucketDetails row={row} locale={locale} t={t} />
    {hasMissingActualPricing(row) && openDataSettings && <div className="ui-toolbar">
      <GhostButton onClick={() => openDataSettings(rowTarget(row, account, t))}>{row.pricing_issue === "unknown_mode" ? t("Inspect source data", "Sprawdź dane źródłowe") : t("Edit rates", "Edytuj stawki")}</GhostButton>
    </div>}
  </>;
}

function SummaryCell({ summary, kind }: { summary: PartialSum; kind: "number" | "money" }) {
  const { t } = useI18n();
  return <>{kind === "money" ? summary.value === null ? <span className="ui-missing">{t("no rate", "brak stawki")}</span> : moneyText(summary.value, summary.partial) : numberText(summary.value, summary.partial)}</>;
}

export interface SubscriptionModelDetailsProps {
  rows: SubscriptionModelDetail[];
  openDataSettings?: (target: DataSettingsTarget) => void;
  account: string;
}

export function SubscriptionModelDetails({ rows, openDataSettings, account }: SubscriptionModelDetailsProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<{ key: string; opener: HTMLElement | null } | null>(null);
  const rowKey = (row: SubscriptionModelDetail, index: number) => `${account}:${row.day}:${row.model}:${row.speed}:${row.source}:${index}`;
  const shown = rows.find((row, index) => rowKey(row, index) === open?.key);
  const pricingColumn = rows.some(hasMissingActualPricing);
  const visibleBuckets = BUCKETS.filter(({ key }) => !key.startsWith("in_cache_write_") || rows.some(row => { const value = rowQuantity(row, key); return value === null || value !== 0; }));
  const [page, setPage] = useState(0);
  // Retain the original identity when sorting changes the row's page or position.
  const { rows: sorted, sorting } = useTableSort(rows.map((row, index) => ({ row, key: rowKey(row, index) })), {
    c0: item => item.row.day, c1: item => modelVersionSortValue(item.row.model), c2: item => item.row.speed, c3: item => item.row.source,
    c4: item => finite(item.row.calls), c6: item => finite(item.row.tokens),
    c7: item => finite(item.row.api_standard), c8: item => finite(item.row.api_actual),
    ...Object.fromEntries(BUCKETS.map(({ key }) => [`token:${key}`, (item: { row: SubscriptionModelDetail }) => rowQuantity(item.row, key)])),
  }, locale, { column: "c0", direction: "desc" }, () => setPage(0));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = sorted.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const pageRows = pageItems.map(item => item.row);
  const pageSummary = useMemo(() => summarize(pageRows), [pageRows]);
  const totalSummary = useMemo(() => summarize(rows), [rows]);
  const firstRow = rows.length ? currentPage * PAGE_SIZE + 1 : 0;
  const lastRow = Math.min(rows.length, (currentPage + 1) * PAGE_SIZE);

  // Rendered inside the Models view's folded section, which carries the title: no card in a card.
  return <div>
    <p className="mono" style={{ color: "var(--muted)", fontSize: "var(--fs-3)", lineHeight: 1.55, margin: "0 0 8px" }}>
      {rows.length} {t("rows", "wierszy")} · {t("page", "strona")} {currentPage + 1}/{pageCount}
      <HelpDot label={t("Model pricing", "Wycena modeli")}>{t("Actual rates and bucket costs are shown separately from the API Standard comparison. Missing rates are named; totals marked ≥ are known lower bounds. Reasoning is included in output.", "Rzeczywiste stawki i koszty bucketów są pokazane osobno od porównania API Standard. Brakujące stawki są opisane; sumy z ≥ są znanymi dolnymi granicami. Rozumowanie jest zawarte w wyjściu.")}</HelpDot>
    </p>
    {!rows.length && <EmptyState title={t("No model detail rows", "Brak wierszy szczegółów modeli")} detail={t("There is no subscription model traffic in the selected data.", "W wybranych danych nie ma ruchu modeli subskrypcji.")} />}
    {!!rows.length && <>
      <Table tableId="SubscriptionModelDetails:0" sorting={sorting}>
        <thead><TableRow header>
          <Th columnId="c0">{t("Day", "Dzień")}</Th>
          <Th columnId="c1">{t("Model", "Model")}</Th>
          <Th columnId="c2">{t("Mode", "Tryb")}</Th>
          <Th columnId="c3">{t("Source", "Źródło")}</Th>
          <Th columnId="c4" align="right">{t("Calls", "Wywołania")}</Th>
          {visibleBuckets.map(({ key, label, pl }) => <Th columnId={`token:${key}`} key={key} align="right" title={key === "out_thinking" ? t("Reasoning is a subset of output.", "Rozumowanie jest częścią wyjścia.") : undefined}>{t(label, pl)}</Th>)}
          <Th columnId="c6" align="right">{t("Tokens", "Tokeny")}</Th>
          <Th columnId="c7" align="right">{t("API Standard", "API Standard")}</Th>
          <Th columnId="c8" align="right">{t("API actual", "API rzeczywiste")}</Th>
          {pricingColumn && <Th columnId="c9">{t("Pricing", "Wycena")}</Th>}
        </TableRow></thead>
        <tbody>
          {pageItems.map(({ row, key }) => {
            const missing = hasMissingActualPricing(row);
            const choose = (opener: HTMLElement | null) => setOpen({ key, opener });
            return <TableRow key={key} className={`ui-open-row${open?.key === key ? " is-selected" : ""}`}
              onClick={event => choose(event.currentTarget.querySelector<HTMLButtonElement>(".ui-open-row-button"))}>
              <Td mono><button type="button" className="ui-open-row-button" aria-haspopup="dialog"
                onClick={event => { event.stopPropagation(); choose(event.currentTarget); }}>{row.day} <span aria-hidden="true">›</span></button></Td>
              <Td title={row.model}>{row.model}</Td>
              <Td>{row.speed}</Td>
              <Td title={row.source}>{row.source}</Td>
              <Td align="right" mono>{numberText(finite(row.calls))}</Td>
              {visibleBuckets.map(({ key }) => <Td key={key} align="right" mono>{numberText(rowQuantity(row, key))}</Td>)}
              <Td align="right" mono>{numberText(finite(row.tokens))}</Td>
              <Td align="right" mono>{finite(row.api_standard) === null ? <span className="ui-missing">{t("no rate", "brak stawki")}</span> : moneyText(finite(row.api_standard))}</Td>
              <Td align="right" mono>{finite(row.api_actual) === null ? pricingIssueLabel(row, t) : moneyText(finite(row.api_actual))}</Td>
              {pricingColumn && <Td style={{ whiteSpace: "normal", minWidth: 190 }}>
                {missing && <div onClick={event => event.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", color: "var(--warn)", fontSize: "var(--fs-3)" }}>
                  {/* An empty actual figure already names the reason; a partial one needs it here. */}
                  {finite(row.api_actual) !== null && <span>{pricingIssueLabel(row, t)}</span>}
                  {openDataSettings && <GhostButton onClick={() => openDataSettings(rowTarget(row, account, t))}>{row.pricing_issue === "unknown_mode" ? t("Inspect source data", "Sprawdź dane źródłowe") : t("Edit rates", "Edytuj stawki")}</GhostButton>}
                </div>}
              </Td>}
            </TableRow>;
          })}
        </tbody>
        <tfoot>
          <TableRow>
            <Td colSpan={4}><strong>{t("Page subtotal", "Suma strony")}</strong> <span className="mono" style={{ color: "var(--faint)", fontSize: "var(--fs-2)" }}>({firstRow}–{lastRow})</span></Td>
            <Td align="right" mono><strong><SummaryCell summary={pageSummary.calls} kind="number" /></strong></Td>
            {visibleBuckets.map(({ key }) => <Td key={key} align="right" mono><strong><SummaryCell summary={pageSummary.quantities[key]} kind="number" /></strong></Td>)}
            <Td align="right" mono><strong><SummaryCell summary={pageSummary.tokens} kind="number" /></strong></Td>
            <Td align="right" mono><strong><SummaryCell summary={pageSummary.apiStandard} kind="money" /></strong></Td>
            <Td align="right" mono><strong><SummaryCell summary={pageSummary.apiActual} kind="money" /></strong></Td>
            {pricingColumn && <Td>{null}</Td>}
          </TableRow>
          <TableRow>
            <Td colSpan={4}><strong>{t("All rows total", "Suma wszystkich wierszy")}</strong> <span className="mono" style={{ color: "var(--faint)", fontSize: "var(--fs-2)" }}>({rows.length})</span></Td>
            <Td align="right" mono><strong><SummaryCell summary={totalSummary.calls} kind="number" /></strong></Td>
            {visibleBuckets.map(({ key }) => <Td key={key} align="right" mono><strong><SummaryCell summary={totalSummary.quantities[key]} kind="number" /></strong></Td>)}
            <Td align="right" mono><strong><SummaryCell summary={totalSummary.tokens} kind="number" /></strong></Td>
            <Td align="right" mono><strong><SummaryCell summary={totalSummary.apiStandard} kind="money" /></strong></Td>
            <Td align="right" mono><strong><SummaryCell summary={totalSummary.apiActual} kind="money" /></strong></Td>
            {pricingColumn && <Td>{null}</Td>}
          </TableRow>
        </tfoot>
      </Table>
      {pageCount > 1 && <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <GhostButton disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>{t("Previous", "Poprzednia")}</GhostButton>
        <span className="mono" style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{firstRow}–{lastRow} / {rows.length}</span>
        <GhostButton disabled={currentPage >= pageCount - 1} onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}>{t("Next", "Następna")}</GhostButton>
      </div>}
    </>}
    {shown && open && <AccountPeriodDrawer busy={false} returnFocus={open.opener} onClose={() => setOpen(null)}
      className="ui-detail-drawer" title={shown.model} subtitle={shown.day + " · " + shown.source}
      closeLabel={t("Close model details", "Zamknij szczegóły modelu")}>
      <SubscriptionModelDetailBody row={shown} account={account} openDataSettings={openDataSettings} />
    </AccountPeriodDrawer>}
  </div>;
}
