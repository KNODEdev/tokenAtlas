import { useId, useState, type ReactNode } from "react";
import type { CycleBreakdownResponse } from "../lib/api";
import { dayTime, full, usd, usageModelLabel } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
import type { CodexWindowModelRow, WindowPriceParts } from "../../shared/codex-window-detail";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { ModelCacheHistory } from "./ModelCacheHistory";
import { TableRow, Card, EmptyState, ErrorState, Fact, FactNote, Facts, HelpBlock, HelpDot, LoadingCard, Table, Tabs, Td, Th } from "./ui";
import { WindowModelTable } from "./WindowModelTable";
import { freshWindowInput, windowTokenDefinitions, windowTokenLabels } from "../lib/window-tokens";
import "./CodexWindowModels.css";

export interface CodexWindowModelsProps {
  account?: string;
  data: CycleBreakdownResponse | null;
  loading: boolean;
  error: string | null;
  cycleLabel: string;
}

interface ModelSummary {
  model: string;
  rows: CodexWindowModelRow[];
  calls: number;
  input: number;
  cached: number;
  cacheWrite: number;
  cache_write_complete: boolean;
  output: number;
  reasoning: number;
  total: number;
}

interface PriceSummary {
  total: number;
  pricedTokens: number;
}

const finite = (value: number): number => Number.isFinite(value) ? value : 0;
const tokens = (row: CodexWindowModelRow): number => finite(row.input) + finite(row.output);
const fresh = freshWindowInput;
const number = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? "—" : full(value);
const decimal = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(getLocale(), { maximumFractionDigits: 2 });
const money = (value: number | null | undefined, prefix = ""): string => value == null || !Number.isFinite(value) ? "—" : prefix + usd(value);
const rate = (value: number | null | undefined): string => value == null || !Number.isFinite(value)
  ? "—"
  : value.toLocaleString(getLocale(), { maximumFractionDigits: 6 });
const date = (value: string): string => {
  if (!value) return "—";
  const utc = /Z$/i.test(value);
  const clean = value.replace("T", " ").replace(/Z$/i, "").replace(/\.\d+$/, "");
  return clean + (utc ? " UTC" : "");
};
const reasonLabel = (value: string | null): string => value ? value.replaceAll("_", " ") : "—";

function summaryRows(rows: CodexWindowModelRow[]): ModelSummary[] {
  const byModel = new Map<string, ModelSummary>();
  for (const row of rows) {
    const model = row.model || "unknown model";
    const current = byModel.get(model) ?? {
      model,
      rows: [],
      calls: 0,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      cache_write_complete: true,
      output: 0,
      reasoning: 0,
      total: 0,
    };
    current.rows.push(row);
    current.calls += finite(row.calls);
    current.input += finite(row.input);
    current.cached += finite(row.cached);
    current.cacheWrite += finite(row.cache_write);
    // Older stored answers lack completeness evidence too.
    current.cache_write_complete &&= row.cache_write_complete === true;
    current.output += finite(row.output);
    current.reasoning += finite(row.reasoning);
    current.total += tokens(row);
    byModel.set(model, current);
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function pricedSummary(rows: CodexWindowModelRow[], basis: "api" | "credits"): PriceSummary {
  return rows.reduce<PriceSummary>((result, row) => {
    const parts = row[basis];
    if (!parts || !Number.isFinite(parts.total)) return result;
    result.total += parts.total;
    result.pricedTokens += tokens(row);
    return result;
  }, { total: 0, pricedTokens: 0 });
}

function partialAmount(rows: CodexWindowModelRow[], basis: "api" | "credits", totalTokens: number, format: (value: number | null, prefix?: string) => string): string {
  const priced = pricedSummary(rows, basis);
  if (priced.pricedTokens <= 0) return "—";
  return format(priced.total, priced.pricedTokens < totalTokens ? "≥ " : "");
}

function coverage(rows: CodexWindowModelRow[], basis: "api" | "credits", totalTokens: number): string {
  if (totalTokens <= 0) return "—";
  const priced = pricedSummary(rows, basis);
  return `${number(priced.pricedTokens)} / ${number(totalTokens)} (${(100 * priced.pricedTokens / totalTokens).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%)`;
}

/** Shown only when some tokens lack a dated rate; full coverage needs no line. */
function CoverageNote({ rows, basis, totalTokens }: { rows: CodexWindowModelRow[]; basis: "api" | "credits"; totalTokens: number }) {
  const { t } = useI18n();
  const priced = pricedSummary(rows, basis).pricedTokens;
  if (totalTokens <= 0 || priced >= totalTokens) return null;
  const share = `${(100 * priced / totalTokens).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%`;
  return <FactNote><span style={{ color: "var(--warn)" }} title={coverage(rows, basis, totalTokens)}>{t("coverage", "pokrycie")} {share}</span></FactNote>;
}

function sourceLabel(source: string): string {
  try {
    const url = new URL(source);
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return source;
  }
}

/** Rate sources, listed once for the whole drawer; confidence is named only when it is not the official list. */
function Sources({ rows }: { rows: CodexWindowModelRow[] }) {
  const { t } = useI18n();
  const lines = new Map<string, { label: string; parts: WindowPriceParts }>();
  for (const row of rows) {
    for (const [basis, label] of [["api", t("API", "API")], ["credits", t("Credits", "Kredyty")]] as const) {
      const parts = row[basis];
      if (!parts) continue;
      lines.set(`${basis}|${parts.sources.join(" ")}|${parts.confidence}`, { label, parts });
    }
  }
  if (lines.size === 0) return null;
  return (
    <div className="codex-models-sources">
      {[...lines.entries()].map(([key, { label, parts }]) => <span key={key}>
        {label}: {parts.sources.length
          ? parts.sources.map((source, index) => {
              const value = /^https?:\/\//i.test(source)
                ? <a href={source} target="_blank" rel="noreferrer">{sourceLabel(source)}</a>
                : source;
              return <span key={`${source}-${index}`}>{index > 0 && ", "}{value}</span>;
            })
          : t("no source", "brak źródła")}
        {parts.confidence !== "official" && <>{" · "}{t("user rate", "stawka użytkownika")}</>}
      </span>)}
    </div>
  );
}

function cost(parts: WindowPriceParts | null, key: "input" | "cached" | "cache_write" | "output" | "total", kind: "usd" | "credits"): string {
  if (!parts) return "—";
  return kind === "usd" ? money(parts[key]) : decimal(parts[key]);
}

function DetailedRateTable({ row }: { row: CodexWindowModelRow }) {
  const { t } = useI18n();
  const pieces: Array<{
    label: ReactNode;
    key: string;
    quantity: number;
    apiRate: number | null;
    apiCost: string;
    creditRate: number | null;
    creditCost: string;
  }> = [
    { key: "fresh", label: t("Fresh input", "Świeży input"), quantity: fresh(row), apiRate: row.api?.rates.in_uncached ?? null, apiCost: cost(row.api, "input", "usd"), creditRate: row.credits?.rates.in_uncached ?? null, creditCost: cost(row.credits, "input", "credits") },
    { key: "cached", label: t("Cache read input", "Input odczytany z cache"), quantity: finite(row.cached), apiRate: row.api?.rates.in_cache_read ?? null, apiCost: cost(row.api, "cached", "usd"), creditRate: row.credits?.rates.in_cache_read ?? null, creditCost: cost(row.credits, "cached", "credits") },
    { key: "write", label: t("Cache write input", "Input zapisany do cache"), quantity: finite(row.cache_write), apiRate: null, apiCost: "—", creditRate: null, creditCost: "—" },
    {
      key: "output",
      label: <>{t("Output (including reasoning)", "Output (z reasoning)")}{finite(row.reasoning) > 0 && <span className="codex-models-note"> · {t("reasoning", "reasoning")} {number(finite(row.reasoning))}</span>}</>,
      quantity: finite(row.output), apiRate: row.api?.rates.out_total ?? null, apiCost: cost(row.api, "output", "usd"), creditRate: row.credits?.rates.out_total ?? null, creditCost: cost(row.credits, "output", "credits"),
    },
  ];
  return (
    <Table tableId="CodexWindowModels:0">
      <thead><TableRow header>
        <Th columnId="c0">{t("Piece", "Część")}</Th>
        <Th columnId="c1" align="right">{t("Quantity", "Ilość")}</Th>
        <Th columnId="c2" align="right">USD/M</Th><Th columnId="c3" align="right">USD</Th>
        <Th columnId="c4" align="right">{t("Credits/M", "Kredyty/M")}</Th><Th columnId="c5" align="right">{t("Credits", "Kredyty")}</Th>
      </TableRow></thead>
      <tbody>
        {/* Missing write evidence is distinct from a reported zero. */}
        {pieces.filter(piece => piece.quantity > 0 || piece.key === "write" && row.cache_write_complete !== true).map(piece => <TableRow key={piece.key}>
          <Td>{piece.label}</Td><Td align="right" mono>{piece.key === "write" && row.cache_write_complete !== true
            ? piece.quantity > 0 ? `≥ ${number(piece.quantity)}` : "—" : number(piece.quantity)}</Td>
          <Td align="right" mono>{rate(piece.apiRate)}</Td><Td align="right" mono>{piece.apiCost}</Td>
          <Td align="right" mono>{rate(piece.creditRate)}</Td><Td align="right" mono>{piece.creditCost}</Td>
        </TableRow>)}
        <TableRow>
          <Td><strong>{t("Total", "Razem")}</strong></Td><Td align="right" mono><strong>{number(tokens(row))}</strong></Td>
          <Td align="right" mono>—</Td><Td align="right" mono><strong>{cost(row.api, "total", "usd")}</strong></Td>
          <Td align="right" mono>—</Td><Td align="right" mono><strong>{cost(row.credits, "total", "credits")}</strong></Td>
        </TableRow>
      </tbody>
    </Table>
  );
}

const differs = (actual: number | null | undefined, standard: number | null | undefined) =>
  actual != null && Number.isFinite(actual) && (standard == null || Math.abs(actual - standard) > 1e-9);

const variantLabel = (row: CodexWindowModelRow, t: (en: string, pl: string) => string): string =>
  `${row.speed === "unknown" ? t("Unknown speed", "Nieznany tryb") : row.speed} · ${row.long_context ? t("long context", "długi kontekst") : t("regular context", "zwykły kontekst")}`;

/** One dated rate row: its variant, when it was seen and what it cost by piece. */
function RowDetails({ row, index }: { row: CodexWindowModelRow; index: number }) {
  const { t } = useI18n();
  return (
    <section>
      <h3 title={row.speed === "unknown" ? t("Standard is a reference scenario, not an actual bill", "Standard to scenariusz referencyjny, nie rzeczywisty rachunek") : undefined}>
        {index + 1}. {variantLabel(row, t)}
      </h3>
      <div className="codex-models-meta" title={`${date(row.first)} → ${date(row.last)}`}>
        {dayTime(row.first)} → {dayTime(row.last)} · {t("calls", "wywołania")} {number(row.calls)}
      </div>
      {row.unpriced_reason && <div className="codex-models-meta" style={{ color: "var(--warn)" }}>
        {t("Unpriced reason", "Powód braku wyceny")}: {reasonLabel(row.unpriced_reason)}
      </div>}
      {/* The actual estimate repeats the Standard total unless the calls ran in another mode. */}
      {differs(row.actual_api, row.api?.total) && <div className="codex-models-meta">{t("Actual known-speed API estimate", "Rzeczywisty szacunek API dla znanego trybu")}: {money(row.actual_api)}</div>}
      {differs(row.actual_credits, row.credits?.total) && <div className="codex-models-meta">{t("Actual known-speed credits estimate", "Rzeczywisty szacunek kredytów dla znanego trybu")}: {decimal(row.actual_credits)}</div>}
      <DetailedRateTable row={row} />
    </section>
  );
}

/** The drawer's body for one model: every dated rate row it was priced with in the window, then the rate sources once. */
export function ModelRates({ rows }: { rows: CodexWindowModelRow[] }) {
  return <>
    {rows.map((row, index) => <RowDetails key={`${row.first}-${row.last}-${row.speed}-${index}`} row={row} index={index} />)}
    <Sources rows={rows} />
  </>;
}

/** How the table counts models; it stands beside the section title, which already names the window. */
export function CodexModelsHelp({ data }: { data: CycleBreakdownResponse | null }) {
  const { t } = useI18n();
  return <HelpDot label={t("How models are counted", "Jak liczymy modele")}>
    <HelpBlock>{t("Canonical rows after meter pairing and mirror handling. Amounts marked ≥ are priced lower bounds when some calls lack a dated rate.", "Kanoniczne wiersze po sparowaniu z licznikiem i obsłudze kopii. Kwoty z oznaczeniem ≥ są dolną granicą, gdy część wywołań nie ma datowanej stawki.")}</HelpBlock>
    <HelpBlock>{t("Cache read and cache write are input counters; cache write is not a separate output stream. Total tokens are input + output. Reasoning is shown inside output and is not added a second time.", "Cache read i cache write to liczniki inputu; cache write nie jest osobnym strumieniem outputu. Suma tokenów to input + output. Reasoning jest pokazany wewnątrz outputu i nie jest dodawany drugi raz.")}</HelpBlock>
    <HelpBlock>{t("Click a model to see its dated rates and costs.", "Kliknij model, aby zobaczyć jego datowane stawki i koszty.")}</HelpBlock>
    {(data?.model_detail?.unknown_speed_tokens ?? 0) > 0 && <HelpBlock>{t("Unknown speed tokens use Standard only as the reference scenario; they are not an observed bill.", "Tokeny o nieznanym trybie używają Standardu wyłącznie jako scenariusza referencyjnego; nie są zaobserwowanym rachunkiem.")}</HelpBlock>}
  </HelpDot>;
}

export function codexModelCount(data: CycleBreakdownResponse | null): number {
  return new Set((data?.model_detail?.rows ?? []).map(row => row.model || "unknown model")).size;
}

const credits = (value: number | null, prefix?: string) => value == null || !Number.isFinite(value) ? "—" : `${prefix ?? ""}${decimal(value)}`;
const percent = (part: number, whole: number): string => whole > 0
  ? `${(100 * part / whole).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}%`
  : "—";

/** API Standard per million priced tokens: what makes a model expensive, not only its volume. */
function perMillion(rows: CodexWindowModelRow[]): string {
  const priced = pricedSummary(rows, "api");
  return priced.pricedTokens > 0 ? money(priced.total * 1_000_000 / priced.pricedTokens) : "—";
}

/** Where the model's API Standard went, by priced piece, in the token composition card's colours. */
export function CostSplit({ rows }: { rows: CodexWindowModelRow[] }) {
  const { t } = useI18n();
  const sum = (basis: "api" | "credits", key: "input" | "cached" | "output") =>
    rows.reduce((total, row) => total + (row[basis] && Number.isFinite(row[basis]![key]) ? row[basis]![key] : 0), 0);
  const pieces = [
    { key: "cached", label: t("Cache read input", "Odczyt z cache"), color: "var(--accent)", tokens: rows.reduce((total, row) => total + finite(row.cached), 0) },
    { key: "input", label: t("Fresh input", "Świeży input"), color: "var(--violet)", tokens: rows.reduce((total, row) => total + fresh(row), 0) },
    { key: "output", label: t("Output (including reasoning)", "Output (z reasoning)"), color: "var(--ok)", tokens: rows.reduce((total, row) => total + finite(row.output), 0) },
  ] as const;
  const amounts = pieces.map(piece => ({ ...piece, api: sum("api", piece.key), credits: sum("credits", piece.key) }));
  const whole = amounts.reduce((total, piece) => total + piece.api, 0);
  if (whole <= 0) return null;
  return (
    <section aria-label={t("Where the API Standard went", "Na co poszedł API Standard")}>
      <h3>{t("Where the API Standard went", "Na co poszedł API Standard")}</h3>
      <div className="codex-models-split-bar">
        {amounts.map(piece => piece.api > 0 && <span key={piece.key} title={`${piece.label} · ${money(piece.api)} · ${percent(piece.api, whole)}`}
          style={{ width: `${100 * piece.api / whole}%`, background: piece.color }} />)}
      </div>
      <div className="codex-models-split-legend">
        {amounts.map(piece => <div key={piece.key}>
          <span className="codex-models-split-dot" style={{ background: piece.color }} />
          <span>{piece.label}</span>
          <span className="mono codex-models-split-tokens">{number(piece.tokens)} {t("tok.", "tok.")}</span>
          <span className="mono">{money(piece.api)}</span>
          <span className="mono">{decimal(piece.credits)}</span>
          <span className="mono codex-models-split-share">{percent(piece.api, whole)}</span>
        </div>)}
      </div>
    </section>
  );
}

/** One line under the table, only when some tokens have no dated rate; it replaces a coverage column. */
function CoverageLine({ summaries, total }: { summaries: ModelSummary[]; total: ModelSummary }) {
  const { t } = useI18n();
  const api = pricedSummary(total.rows, "api").pricedTokens, credit = pricedSummary(total.rows, "credits").pricedTokens;
  if (api >= total.total && credit >= total.total) return null;
  const missing = summaries.filter(summary => pricedSummary(summary.rows, "api").pricedTokens < summary.total).map(summary => usageModelLabel(summary.model));
  return <div className="codex-models-coverage" title={`API ${coverage(total.rows, "api", total.total)} · ${t("credits", "kredyty")} ${coverage(total.rows, "credits", total.total)}`}>
    {percent(api, total.total)} {t("of tokens have a dated rate", "tokenów ma datowaną stawkę")} · {number(total.total - api)} {t("without one", "bez wyceny")}
    {missing.length > 0 && ` (${missing.join(", ")})`}
    {credit !== api && ` · ${t("credits", "kredyty")} ${percent(credit, total.total)}`}
  </div>;
}

export function CodexWindowModels({ data, loading, error, cycleLabel, account }: CodexWindowModelsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState<{ model: string; opener: HTMLElement | null } | null>(null);
  const [tab, setTab] = useState<"costs" | "cache" | "rates">("costs");
  const tabId = useId();
  const detail = data?.model_detail ?? null;
  // The section header above names the view and the window, so the states below carry no card title of their own.
  if (error) return <ErrorState message={error} />;
  if (loading && !detail) return <LoadingCard label={t("Loading model details…", "Wczytywanie szczegółów modeli…")} height={180} shape="table" />;
  if (!detail || detail.rows.length === 0) {
    return <EmptyState
      title={t("No model detail in this window", "Brak szczegółów modeli w tym oknie")}
      detail={t("The selected cycle has no canonical model rows yet.", "Wybrany cykl nie ma jeszcze kanonicznych wierszy modeli.")}
    />;
  }
  const summaries = summaryRows(detail.rows);
  const total = summaries.reduce<ModelSummary>((result, row) => ({
    model: t("Total", "Razem"), rows: [...result.rows, ...row.rows], calls: result.calls + row.calls,
    input: result.input + row.input, cached: result.cached + row.cached, cacheWrite: result.cacheWrite + row.cacheWrite,
    cache_write_complete: result.cache_write_complete && row.cache_write_complete,
    output: result.output + row.output, reasoning: result.reasoning + row.reasoning, total: result.total + row.total,
  }), { model: t("Total", "Razem"), rows: [], calls: 0, input: 0, cached: 0, cacheWrite: 0, cache_write_complete: true, output: 0, reasoning: 0, total: 0 });
  const shown = open ? summaries.find(summary => summary.model === open.model) ?? null : null;
  const labels = windowTokenLabels(t), definitions = windowTokenDefinitions(t);
  return (
    <Card>
      {(detail.excluded_mirror_events > 0 || detail.excluded_counter_events > 0 || detail.invalid_token_events > 0) && <div className="mono" style={{ margin: "0 0 var(--s-3)", color: "var(--faint)", fontSize: "var(--fs-3)" }}>
        {(detail.excluded_mirror_events > 0 || detail.excluded_counter_events > 0) && <>{t("Excluded", "Pominięto")}: {number(detail.excluded_mirror_events)} {t("mirror events", "kopii")}, {number(detail.excluded_counter_events)} {t("counter events", "zdarzeń licznika")}.</>}
        {detail.invalid_token_events > 0 && <span style={{ color: "var(--warn)" }}> {t("Invalid token events", "Nieprawidłowe zdarzenia tokenów")}: {number(detail.invalid_token_events)}.</span>}
      </div>}
      <WindowModelTable tableId="CodexWindowModels:1" selectedModel={open?.model} rows={summaries.map(summary => ({
        ...summary, cache_write: summary.cacheWrite,
        api: pricedSummary(summary.rows, "api"), credits: pricedSummary(summary.rows, "credits"),
      }))} onOpen={(model, opener) => { setTab("costs"); setOpen({ model, opener }); }} />
      <CoverageLine summaries={summaries} total={total} />
      {shown && open && <AccountPeriodDrawer busy={false} returnFocus={open.opener} onClose={() => setOpen(null)}
        className="ui-detail-drawer" title={usageModelLabel(shown.model)} subtitle={cycleLabel}
        closeLabel={t("Close model details", "Zamknij szczegóły modelu")}>
        <Facts>
          <Fact label={t("Calls", "Wywołania")} value={number(shown.calls)} />
          <Fact label={t("Tokens", "Tokeny")} value={number(shown.total)} />
          <Fact label={t("API Standard", "API Standard")} value={partialAmount(shown.rows, "api", shown.total, money)} notes={<CoverageNote rows={shown.rows} basis="api" totalTokens={shown.total} />} />
          <Fact label={t("Credits Standard", "Kredyty Standard")} value={partialAmount(shown.rows, "credits", shown.total, credits)} notes={<CoverageNote rows={shown.rows} basis="credits" totalTokens={shown.total} />} />
        </Facts>
        <Facts>
          <Fact label={<span title={definitions.input}>{labels.input}</span>}
            value={number(shown.input)} />
          <Fact label={<span title={definitions.fresh}>{labels.fresh}</span>} value={shown.cache_write_complete ? number(shown.input - shown.cached - shown.cacheWrite) : "—"} />
          <Fact label={<span title={definitions.cached}>{labels.cached}</span>} value={number(shown.cached)} />
          <Fact label={<span title={definitions.cache_write}>{labels.cache_write}</span>} value={shown.cache_write_complete ? number(shown.cacheWrite) : shown.cacheWrite > 0 ? `≥ ${number(shown.cacheWrite)}` : "—"} />
          <Fact label={<span title={definitions.output}>{labels.output}</span>} value={number(shown.output)}
            notes={shown.reasoning > 0 ? <FactNote>{t("reasoning", "reasoning")} {number(shown.reasoning)}</FactNote> : undefined} />
          <Fact label={<span title={definitions.cache_share}>{labels.cache_share}</span>} value={percent(shown.cached, shown.input)} />
          <Fact label={<span title={t("API Standard per million priced tokens", "API Standard na milion wycenionych tokenów")}>{t("$/M tokens", "$/M tokenów")}</span>} value={perMillion(shown.rows)} />
        </Facts>
        <Tabs value={tab} onChange={setTab} options={[
          { value: "costs", label: t("Costs", "Koszty") },
          { value: "cache", label: "Cache" },
          { value: "rates", label: t("Rates", "Stawki") },
        ]} tablist={{ label: t("Model details", "Szczegóły modelu"), idBase: tabId, panelId: `${tabId}-panel` }} />
        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
          {tab === "costs" && <CostSplit rows={shown.rows} />}
          {tab === "cache" && <ModelCacheHistory timeline={detail.cache_timeline} model={shown.model} account={account} />}
          {tab === "rates" && <ModelRates rows={shown.rows} />}
        </div>
      </AccountPeriodDrawer>}
    </Card>
  );
}
