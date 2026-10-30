import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import { useI18n } from "../lib/i18n";
import { compact, full, usageModelLabel, usd } from "../lib/format";
import { COST_BUSIEST, COST_ORDER_KEY, COST_PICKED_KEY, COST_PRESET_SIZE, THIN_SAMPLE_TOKENS, costLines, costPresets, ladderRows, modelUnitCosts, modelVersion,
  type CostLine, type ListRates, type ModelUnitCost as UnitCostRow } from "../lib/model-unit-cost";
import { storedPicks, writePicks } from "../lib/model-speed";
import { modelColorsByTokens } from "../lib/model-colors";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { ChartExport } from "./ChartExport";
import { GhostButton, HelpBlock, HelpDot, Table, TableColGroup, TableRow, Tabs, Td, Th } from "./ui";
import { Kpi, KpiRow, unit, useWidth } from "./WindowStatusCard";
import { barPath, niceStep, textWidth } from "../lib/bar-chart";
import "../screens/History.css";
import "../screens/Speed.css";
import "./SubscriptionChoice.css";
import "./ModelUsage.css";
import "./ModelUnitCost.css";

type Translate = (en: string, pl: string) => string;
type Part = keyof Omit<ListRates, "changed">;
const PARTS: readonly Part[] = ["cacheRead", "input", "cacheWrite", "output"];

function partLabel(part: Part, t: Translate): string {
  return { cacheRead: t("Cache read", "Odczyt cache"), input: t("Input", "Input"), cacheWrite: t("Cache write", "Zapis cache"), output: t("Output", "Output") }[part];
}

/** Dollars per 1M with the digits a cheap rate needs: $12, $1.25, $0.125. */
export function perMillionText(value: number | null | undefined, locale: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const digits: Intl.NumberFormatOptions = value >= 100 ? { maximumFractionDigits: 0 } : value >= 10 ? { maximumFractionDigits: 1 }
    : value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 };
  return "$" + value.toLocaleString(locale, digits);
}

const ratioText = (value: number | null, locale: string) => value === null || !Number.isFinite(value) ? "—"
  : `${value.toLocaleString(locale, value >= 10 ? { maximumFractionDigits: 0 } : value >= 1 ? { maximumFractionDigits: 1 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
const shortLabel = (text: string, max = 28) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

type BarOrder = "cost" | "line";
function storedOrder(): BarOrder {
  try { return localStorage.getItem(COST_ORDER_KEY) === "line" ? "line" : "cost"; } catch { return "cost"; }
}
/** −77%, +12%; one decimal below 10% so a small move does not read as none. */
function changeText(change: number, locale: string): string {
  const percent = Math.abs(change) * 100;
  return `${change < 0 ? "−" : "+"}${percent.toLocaleString(locale, { maximumFractionDigits: percent < 10 ? 1 : 0 })}%`;
}

/** One glyph per list price, the same in the chart and its legend. */
function Glyph({ part, x, y }: { part: Part; x: number; y: number }) {
  switch (part) {
    case "cacheRead": return <circle className="muc-glyph is-hollow" cx={x} cy={y} r={3.5} />;
    case "input": return <line className="muc-glyph is-tick" x1={x} x2={x} y1={y - 6} y2={y + 6} />;
    case "cacheWrite": return <rect className="muc-glyph is-hollow" x={x - 3} y={y - 3} width={6} height={6} transform={`rotate(45 ${x} ${y})`} />;
    case "output": return <rect className="muc-glyph is-solid" x={x - 3.5} y={y - 3.5} width={7} height={7} />;
  }
}

/**
 * Cost per 1M tokens of each model over the selected dates: the Standard API value of its priced tokens divided by
 * them, against the list prices of each token type. "All" colours models by vendor, one subscription by shade.
 */
export function ModelUnitCost({ data, codex, vendor }: { data: CodexAccountingReport; codex: boolean; vendor?: string }) {
  const { t, locale } = useI18n();
  const aggregate = data.provider?.id === "all";
  const summary = useMemo(() => modelUnitCosts(data, codex || aggregate), [data, codex, aggregate]);
  const colors = useMemo(() => modelColorsByTokens(summary.rows, aggregate ? undefined : vendor), [summary, aggregate, vendor]);
  const modelName = (model: string | null) => model == null ? t("unknown model", "nieznany model") : usageModelLabel(model);
  // A $0 model (a separately limited one) has no place on a log scale and says nothing about price.
  const positive = useMemo(() => ladderRows(summary.rows), [summary]);
  const dearest = positive[0], cheapest = positive.at(-1);
  /*
   * The ladder shows the picked models, chosen as on the Speed chart: chips above it, a drawer with search and presets.
   * Nothing stored shows every model; a stored list keeps models that appear later off until picked.
   */
  // One choice per subscription (or "All"), as the Speed chart keeps its series.
  const scope = data.scope.account ?? data.provider?.id ?? "all";
  const [stored, setStored] = useState<Set<string> | null>(() => storedPicks(COST_PICKED_KEY, scope));
  useEffect(() => setStored(storedPicks(COST_PICKED_KEY, scope)), [scope]);
  const shown = stored ? positive.filter(row => stored.has(row.model!)) : positive;
  const setPicked = (next: Set<string>) => { setStored(next); writePicks(COST_PICKED_KEY, scope, next); };
  const toggle = (model: string) => {
    const next = new Set(shown.map(row => row.model!));
    if (next.has(model)) next.delete(model); else next.add(model);
    setPicked(next);
  };
  const [hover, setHover] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const openDrawer = () => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDrawer(true); };
  const presets = useMemo(() => costPresets(summary.rows), [summary]);
  const [order, setOrder] = useState<BarOrder>(storedOrder);
  const pickOrder = (next: BarOrder) => {
    setOrder(next);
    try { localStorage.setItem(COST_ORDER_KEY, next); } catch { /* The order still applies for this visit. */ }
  };
  const lines = order === "line" ? costLines(shown) : undefined;
  // The same priced tokens as if every one were fresh input: what cache reads save and output adds.
  const withInput = summary.rows.filter(row => row.perMillion !== null && (row.rates?.input ?? 0) > 0);
  const inputTokens = withInput.reduce((sum, row) => sum + row.pricedTokens, 0);
  const inputPrice = inputTokens > 0 ? withInput.reduce((sum, row) => sum + row.pricedTokens * row.rates!.input!, 0) / inputTokens : null;
  const inputActual = inputTokens > 0 ? withInput.reduce((sum, row) => sum + row.apiUsd!, 0) / inputTokens * 1e6 : null;
  const versusInput = inputPrice && inputActual !== null ? inputActual / inputPrice : null;
  const coverage = summary.tokens > 0 ? summary.pricedTokens / summary.tokens : null;
  const money = (value: number | null) => value === null ? "—" : <>{perMillionText(value, locale)}{unit(" /1M")}</>;
  return <div className="models">
    <KpiRow columns={4}>
      <Kpi label={t("Average per 1M", "Średnio za 1M")} value={money(summary.perMillion)} visual={null}
        caption={<>{compact(summary.pricedTokens)} {t("priced tokens", "wycenionych tokenów")}{coverage !== null && coverage < 0.995 ? ` · ${Math.round(coverage * 100)}%` : ""} · {usd(summary.apiUsd)}</>} />
      <Kpi label={t("Most expensive", "Najdroższy")} value={money(dearest?.perMillion ?? null)} visual={null} caption={dearest ? modelName(dearest.model) : "—"} />
      <Kpi label={t("Cheapest", "Najtańszy")} value={money(cheapest?.perMillion ?? null)} visual={null} caption={cheapest ? modelName(cheapest.model) : "—"} />
      <Kpi label={t("Vs fresh input", "Wobec ceny inputu")} value={versusInput === null ? "—" : <>{ratioText(versusInput, locale)}</>} visual={null}
        caption={<>{t("input price", "cena inputu")} {perMillionText(inputPrice, locale)} /1M{" "}
          <HelpDot label={t("Vs fresh input", "Wobec ceny inputu")}>{t("The actual cost per 1M divided by what the same tokens would cost at each model's fresh-input price. Cache reads pull it down, output pushes it up.", "Rzeczywisty koszt 1M podzielony przez koszt tych samych tokenów po cenie świeżego inputu każdego modelu. Odczyty z cache go obniżają, output podnosi.")}</HelpDot></>} />
    </KpiRow>
    <ChartExport title={t("Cost per 1M tokens", "Koszt 1M tokenów")} available={positive.length > 0}><section className="models-chart" aria-label={t("Cost per 1M tokens", "Koszt 1M tokenów")}>
      <div className="archive-head">
        <div><b>{t("Cost per 1M tokens", "Koszt 1M tokenów")}</b> <span className="archive-sub">· {t("API-eq Standard ÷ priced tokens · against list prices · log scale", "API-eq Standard ÷ wycenione tokeny · na tle cennika · skala log")}</span>{" "}
          <HelpDot label={t("Cost per 1M tokens", "Koszt 1M tokenów")}>
            <HelpBlock>{t("The dot is the model's real mix: its Standard API value over the selected dates divided by its priced tokens. The band behind it runs from the cheapest to the dearest list price of one token type.", "Kropka to rzeczywisty miks modelu: jego wartość Standard API w wybranych datach podzielona przez wycenione tokeny. Pasek za nią biegnie od najtańszej do najdroższej ceny cennikowej jednego typu tokenów.")}</HelpBlock>
            <HelpBlock>{t("List prices are the latest dated rates in the range, in USD per 1M. Unpriced tokens stay out of the ratio; a dashed line marks the average of all models.", "Ceny cennikowe to najnowsze stawki z zakresu, w USD za 1M. Niewycenione tokeny są poza ilorazem; przerywana linia to średnia wszystkich modeli.")}</HelpBlock>
          </HelpDot></div>
        <div className="archive-legend">
          <span><i className="muc-legend-dot" />{t("actual per 1M", "rzeczywisty za 1M")}</span>
          {PARTS.map(part => <span key={part}><svg className="muc-legend-glyph" viewBox="0 0 14 14" aria-hidden="true"><Glyph part={part} x={7} y={7} /></svg>{partLabel(part, t)}</span>)}
        </div>
      </div>
      {positive.length > 0 && <div className="muc-picker-bar">
        <div className="speed-chips" onMouseLeave={() => setHover(null)}>
          {shown.map(row => <span key={row.model} className={`speed-chip${hover === row.model ? " is-hot" : ""}`} title={modelName(row.model)}
            onMouseEnter={() => setHover(row.model)}>
            <span className="muc-swatch" style={{ background: colors.get(row.model) ?? "var(--muted)" }} />
            <span>{shortLabel(modelName(row.model))}</span>
            <span className="speed-chip-value">{perMillionText(row.perMillion, locale)}</span>
            <button type="button" className="speed-chip-remove" onClick={() => toggle(row.model!)} title={t("Remove from the chart", "Usuń z wykresu")}
              aria-label={t("Remove {0} from the chart", `Usuń ${modelName(row.model)} z wykresu`, [modelName(row.model)])}>×</button>
          </span>)}
          {shown.length < positive.length && <button type="button" className="speed-chip-add" onClick={openDrawer}>{t("+ add model", "+ dodaj model")}</button>}
        </div>
        <GhostButton onClick={openDrawer}>{t("Models · {0}/{1}", `Modele · ${shown.length}/${positive.length}`, [shown.length, positive.length])}</GhostButton>
      </div>}
      {!summary.rows.length ? <div className="archive-empty">{t("No events in this period.", "Brak zdarzeń w tym okresie.")}</div>
        : !positive.length ? <div className="archive-empty">{t("No priced model in this period.", "Brak wycenionego modelu w tym okresie.")}</div>
        : !shown.length ? <div className="archive-empty">{t("No model is picked.", "Nie wybrano żadnego modelu.")}{" "}
          <button type="button" className="ui-legend-all" onClick={openDrawer}>{t("Pick models", "Wybierz modele")}</button></div>
        : <PriceLadder rows={shown} colors={colors} average={summary.perMillion} label={modelName} highlight={hover} />}
    </section></ChartExport>
    {shown.length > 0 && <ChartExport title={t("Average cost per 1M tokens", "Średni koszt 1M tokenów")}><section className="models-chart" aria-label={t("Average cost per 1M tokens", "Średni koszt 1M tokenów")}>
      <div className="archive-head">
        <div><b>{t("Average cost per 1M tokens", "Średni koszt 1M tokenów")}</b> <span className="archive-sub">· {lines
          ? t("the models above, by line, oldest version first · linear scale", "modele z wykresu wyżej, według linii, od najstarszej wersji · skala liniowa")
          : t("the models above, dearest first · linear scale", "modele z wykresu wyżej, od najdroższego · skala liniowa")}</span>{" "}
          <span data-capture-exclude=""><HelpDot label={t("Average cost per 1M tokens", "Średni koszt 1M tokenów")}>
            <HelpBlock>{t("Each bar is the model's actual cost per 1M over the selected dates, the same figure as the dot above and Actual /1M in the table. Under the name: its priced tokens. The dashed line is the average of all models.", "Każdy słupek to rzeczywisty koszt 1M modelu w wybranych datach, ta sama liczba co kropka wyżej i Rzecz. /1M w tabeli. Pod nazwą: jego wycenione tokeny. Przerywana linia to średnia wszystkich modeli.")}</HelpBlock>
            <HelpBlock>{t("By line puts the versions of one model side by side, oldest first; lone models close the chart. The percentage compares each version with the oldest one that has at least {0} priced tokens. It is the actual cost, so a different share of cache reads moves it as much as a price change.", `Według linii stawia wersje jednego modelu obok siebie, od najstarszej; pojedyncze modele zamykają wykres. Procent porównuje każdą wersję z najstarszą, która ma co najmniej ${compact(THIN_SAMPLE_TOKENS)} wycenionych tokenów. To rzeczywisty koszt, więc inny udział odczytów z cache zmienia go tak samo jak zmiana cennika.`, [compact(THIN_SAMPLE_TOKENS)])}</HelpBlock>
          </HelpDot></span></div>
        <span data-capture-exclude=""><Tabs value={order} onChange={pickOrder} options={[
          { value: "cost", label: t("Cost", "Koszt"), title: t("Dearest first", "Od najdroższego") },
          { value: "line", label: t("Line", "Linia"), title: t("Versions of one model side by side", "Wersje jednego modelu obok siebie") },
        ]} /></span>
      </div>
      <CostBars rows={shown} lines={lines} colors={colors} average={summary.perMillion} label={modelName} highlight={hover} />
    </section></ChartExport>}
    {drawer && <AccountPeriodDrawer busy={false} onClose={() => { setDrawer(false); setHover(null); }} returnFocus={opener.current} className="speed-series-drawer"
      closeLabel={t("Close the model choice", "Zamknij wybór modeli")} title={t("Models on the chart", "Modele na wykresie")}
      subtitle={t("{0} of {1} picked · the average line counts every model", `wybrane: ${shown.length} z ${positive.length} · linia średniej liczy wszystkie modele`,
        [shown.length, positive.length])}>
      <CostModelPicker rows={positive} shown={new Set(shown.map(row => row.model!))} colors={colors} label={modelName} search={search} onSearch={setSearch}
        onToggle={toggle} onHover={setHover} presets={[
          { label: t("All", "Wszystkie"), title: t("Every priced model of the period", "Każdy wyceniony model okresu"), apply: () => setPicked(new Set(positive.map(row => row.model!))) },
          { label: t("Busiest {0}", `Najczęstsze ${COST_BUSIEST}`, [COST_BUSIEST]), title: t("The models with the most tokens", "Modele z największą liczbą tokenów"), apply: () => setPicked(presets.busiest) },
          { label: t("Dearest {0}", `Najdroższe ${COST_PRESET_SIZE}`, [COST_PRESET_SIZE]), title: t("The highest cost per 1M", "Najwyższy koszt za 1M"), apply: () => setPicked(presets.dearest) },
          { label: t("Cheapest {0}", `Najtańsze ${COST_PRESET_SIZE}`, [COST_PRESET_SIZE]), title: t("The lowest cost per 1M", "Najniższy koszt za 1M"), apply: () => setPicked(presets.cheapest) },
          { label: t("Clear", "Wyczyść"), title: t("Take every model off the chart", "Zdejmij wszystkie modele z wykresu"), apply: () => setPicked(new Set()) },
        ]} />
    </AccountPeriodDrawer>}
    {summary.rows.length > 0 && <UnitCostTable rows={summary.rows} colors={colors} label={modelName} />}
  </div>;
}

/** The drawer's content: search, presets and one row per priced model with its tokens and cost per 1M. */
function CostModelPicker({ rows, shown, colors, label, search, onSearch, onToggle, onHover, presets }: {
  rows: UnitCostRow[]; shown: ReadonlySet<string>; colors: Map<string | null, string>; label: (model: string | null) => string;
  search: string; onSearch: (value: string) => void; onToggle: (model: string) => void; onHover: (model: string | null) => void;
  presets: { label: string; title: string; apply: () => void }[];
}) {
  const { t, locale } = useI18n();
  const query = search.trim().toLowerCase();
  const matching = rows.filter(row => !query || label(row.model).toLowerCase().includes(query) || row.model!.toLowerCase().includes(query));
  return <div className="speed-picker">
    <div className="speed-picker-tools">
      <input type="search" className="ui-input" value={search} onChange={event => onSearch(event.target.value)}
        placeholder={t("Search models…", "Szukaj modelu…")} aria-label={t("Search models", "Szukaj modelu")} />
    </div>
    <div className="speed-picker-presets">
      {presets.map(preset => <button key={preset.label} type="button" className="ui-legend-all" title={preset.title} onClick={preset.apply}>{preset.label}</button>)}
    </div>
    {matching.length ? <div className="speed-drawer-list" onMouseLeave={() => onHover(null)}>
      {matching.map(row => <label key={row.model} className="speed-drawer-row" onMouseEnter={() => onHover(row.model)}>
        <input type="checkbox" checked={shown.has(row.model!)} onChange={() => onToggle(row.model!)} />
        <span className="muc-swatch" style={{ background: colors.get(row.model) ?? "var(--muted)" }} />
        <span className="speed-drawer-name mono">{label(row.model)}</span>
        <span className="mono speed-drawer-facts">{compact(row.tokens)} {t("tokens", "tokenów")} · {perMillionText(row.perMillion, locale)} /1M</span>
      </label>)}
    </div> : <div className="archive-empty">{t("No model matches.", "Żaden model nie pasuje.")}</div>}
  </div>;
}

function PriceLadder({ rows, colors, average, label, highlight }: {
  rows: UnitCostRow[]; colors: Map<string | null, string>; average: number | null; label: (model: string | null) => string; highlight: string | null;
}) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(900);
  const values = rows.flatMap(row => [row.perMillion!, ...PARTS.map(part => row.rates?.[part] ?? 0)]).filter(value => value > 0);
  const from = Math.floor(Math.log10(Math.min(...values))), to = Math.max(from + 1, Math.ceil(Math.log10(Math.max(...values))));
  const LEFT = 200, RIGHT = 72, TOP = 22, ROW = 30;
  const bottom = TOP + rows.length * ROW, height = bottom + 24;
  const x = (value: number) => LEFT + (Math.log10(value) - from) / (to - from) * (width - LEFT - RIGHT);
  const decades = Array.from({ length: to - from + 1 }, (_, index) => 10 ** (from + index));
  // A narrow range keeps its 2 and 5 steps readable; a wide one shows decades only.
  const ticks = decades.length <= 3 ? [...decades, ...decades.slice(0, -1).flatMap(value => [2 * value, 5 * value])].sort((a, b) => a - b) : decades;
  return <div ref={ref}>
    <svg className="muc-svg" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={t("Cost per 1M tokens by model", "Koszt 1M tokenów według modeli")}>
      {ticks.map(value => <g key={value}>
        <line className="muc-grid" x1={x(value)} x2={x(value)} y1={TOP - 4} y2={bottom} />
        <text className="muc-tick" x={x(value)} y={bottom + 16} textAnchor="middle">{perMillionText(value, locale)}</text>
      </g>)}
      {average !== null && average > 0 && <g>
        <line className="muc-average" x1={x(average)} x2={x(average)} y1={TOP - 8} y2={bottom} />
        <text className="muc-note" x={x(average)} y={TOP - 11} textAnchor="middle">{t("average", "średnia")} {perMillionText(average, locale)}</text>
      </g>}
      {rows.map((row, index) => {
        const y = TOP + index * ROW + ROW / 2, color = colors.get(row.model) ?? "var(--muted)";
        const rates = PARTS.flatMap(part => { const value = row.rates?.[part]; return value != null && value > 0 ? [[part, value] as const] : []; });
        const low = rates.length ? Math.min(...rates.map(([, value]) => value)) : null, high = rates.length ? Math.max(...rates.map(([, value]) => value)) : null;
        const title = [
          `${label(row.model)} · ${perMillionText(row.perMillion, locale)} / 1M`,
          `${full(row.pricedTokens)} ${t("priced tokens", "wycenionych tokenów")} · ${usd(row.apiUsd)}`,
          ...PARTS.map(part => `${partLabel(part, t)}: ${perMillionText(row.rates?.[part], locale)}`),
          ...(row.rates?.changed ? [t("Prices changed in the range; the latest are shown.", "Ceny zmieniły się w zakresie; pokazane są najnowsze.")] : []),
          ...(row.partial ? [t("Some tokens have no rate and stay out of the ratio.", "Część tokenów nie ma stawki i jest poza ilorazem.")] : []),
        ].join("\n");
        // A hovered chip or drawer row picks its model out; the rest fade.
        return <g key={row.model ?? ""} className={`muc-row${highlight !== null && highlight !== row.model ? " is-dim" : ""}`}>
          <title>{title}</title>
          <rect className="muc-row-hit" x={0} y={y - ROW / 2} width={width} height={ROW} />
          <text className="muc-label" x={LEFT - 14} y={y + 4} textAnchor="end">{shortLabel(label(row.model))}</text>
          {low !== null && high !== null && <rect className="muc-band" x={x(low) - 4} y={y - 4} width={Math.max(8, x(high) - x(low) + 8)} height={8} rx={4}
            style={{ fill: `color-mix(in oklab, ${color} 22%, transparent)` }} />}
          {rates.map(([part, value]) => <Glyph key={part} part={part} x={x(value)} y={y} />)}
          <circle className="muc-dot" cx={x(row.perMillion!)} cy={y} r={6} style={{ fill: color }} />
          <text className="muc-value" x={width - RIGHT + 12} y={y + 4}>{perMillionText(row.perMillion, locale)}</text>
        </g>;
      })}
    </svg>
  </div>;
}

/**
 * The same averages as hatched bars, dearest first: each model's actual cost per 1M over the selected dates, with the
 * all-model average as a dashed line. Linear, so the gap between a dear and a cheap model reads at a glance.
 * With `lines` the bars stand by model line instead, each version marked against the line's base.
 */
function CostBars({ rows, lines, colors, average, label, highlight }: {
  rows: UnitCostRow[]; lines?: CostLine[]; colors: Map<string | null, string>; average: number | null; label: (model: string | null) => string;
  highlight: string | null;
}) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(900);
  const hatchId = `muc-hatch-${useId().replace(/:/g, "")}`;
  // By line: room above for the line names and below for the change against the base.
  const LEFT = 52, RIGHT = 8, TOP = lines ? 46 : 26, PLOT = 260, AXIS = lines ? 56 : 40;
  const bottom = TOP + PLOT, height = bottom + AXIS;
  // A gap of GAP slots between lines; one slot per bar either way.
  const GAP = 0.6;
  const bars = lines ? lines.flatMap((line, group) => line.bars.map(bar => ({ ...bar, line, group })))
    : rows.map(row => ({ row, base: false, thin: false, change: null, line: null, group: 0 }));
  const groups = lines?.length ?? 1;
  const peak = Math.max(...rows.map(row => row.perMillion!), average ?? 0) || 1;
  const step = niceStep(peak * 1.12), max = Math.ceil(peak * 1.12 / step) * step;
  const y = (value: number) => bottom - value / max * PLOT;
  // One number of decimals for the whole axis: $0.50 and $1.00, not $0.5 and $1.00.
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  const tick = (value: number) => "$" + value.toLocaleString(locale, { minimumFractionDigits: value ? decimals : 0, maximumFractionDigits: decimals });
  const averageText = average !== null && average > 0 ? `${t("average", "średnia")} ${perMillionText(average, locale)}` : null;
  // Lone models close the line order and sit near the average, so its label gets room of its own past the bars.
  const reserve = lines && averageText ? textWidth(averageText, 12) + 12 : 0;
  const slot = (width - LEFT - RIGHT - 8 - reserve) / (bars.length + (groups - 1) * GAP), bar = Math.min(44, slot * 0.62);
  const centerOf = (index: number, group: number) => LEFT + 8 + slot * (index + group * GAP + 0.5);
  // Under a bracket the version is enough; a lone model has none, so it keeps its line: "astra 6".
  const shortName = (line: CostLine, model: string) => {
    const version = modelVersion(model);
    return line.bars.length > 1 ? version : version === model ? label(model) : `${line.label} ${version}`;
  };
  // Names keep to their slot; the full name is in the tooltip.
  const nameSize = slot >= textWidth("gpt-5.6-terra", 12) + 8 ? 12 : 11;
  const fit = (text: string) => shortLabel(text, Math.max(4, Math.floor((slot - 6) / (nameSize * 0.56))));
  return <div ref={ref}>
    <svg className="muc-svg" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={t("Average cost per 1M tokens by model", "Średni koszt 1M tokenów według modeli")}>
      <defs>
        <pattern id={hatchId} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={7} stroke="var(--hatch)" strokeWidth={1.2} />
        </pattern>
      </defs>
      {Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step).map(value => <g key={value}>
        {value > 0 && <line className="muc-grid" x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} />}
        <text className="muc-tick" x={LEFT - 10} y={y(value) + 4} textAnchor="end">{tick(value)}</text>
      </g>)}
      <line x1={LEFT} x2={width - RIGHT} y1={bottom + 0.5} y2={bottom + 0.5} stroke="var(--line2)" />
      {/* A bracket and name over each line of several versions; lone models need none. */}
      {lines && (() => {
        let start = 0;
        return lines.map((line, group) => {
          const first = start;
          start += line.bars.length;
          if (line.bars.length < 2) return null;
          const left = centerOf(first, group) - bar / 2, right = centerOf(first + line.bars.length - 1, group) + bar / 2;
          return <g key={line.key} className="muc-line">
            <path className="muc-bracket" d={`M${left} 28 V22 H${right} V28`} />
            <text className="muc-line-name" x={(left + right) / 2} y={15} textAnchor="middle">{shortLabel(line.label, Math.max(4, Math.floor((right - left + slot * 0.3) / 7)))}</text>
          </g>;
        });
      })()}
      {bars.map(({ row, base, thin, change, line, group }, index) => {
        const color = colors.get(row.model) ?? "var(--muted)", center = centerOf(index, group), top = y(row.perMillion!);
        const path = barPath(center - bar / 2, top, bar, bottom);
        const baseModel = line?.bars.find(item => item.base)?.row.model;
        const note = base ? t("base of its line", "baza swojej linii")
          : thin ? t("under {0} priced tokens: too few to compare", `poniżej ${compact(THIN_SAMPLE_TOKENS)} wycenionych tokenów: za mało do porównania`, [compact(THIN_SAMPLE_TOKENS)])
          : change !== null && baseModel ? t("{0} against {1}", `${changeText(change, locale)} wobec ${label(baseModel)}`, [changeText(change, locale), label(baseModel)]) : null;
        return <g key={row.model ?? ""} className={`muc-row${highlight !== null && highlight !== row.model ? " is-dim" : ""}`}>
          <title>{`${label(row.model)} · ${perMillionText(row.perMillion, locale)} / 1M\n${full(row.pricedTokens)} ${t("priced tokens", "wycenionych tokenów")} · ${usd(row.apiUsd)}${note ? `\n${note}` : ""}`}</title>
          <path d={path} style={{ fill: color }} />
          <path d={path} fill={`url(#${hatchId})`} />
          <text className="muc-value" x={center} y={top - 7} textAnchor="middle">{perMillionText(row.perMillion, locale)}</text>
          <text className="muc-label" x={center} y={bottom + 17} textAnchor="middle" style={{ fontSize: nameSize }}>
            {fit(line ? shortName(line, row.model!) : label(row.model))}</text>
          <text className="muc-tick" x={center} y={bottom + 32} textAnchor="middle">{compact(row.pricedTokens)}</text>
          {change !== null ? <text className="muc-change" x={center} y={bottom + 48} textAnchor="middle">{changeText(change, locale)}</text>
            : base ? <text className="muc-tick" x={center} y={bottom + 48} textAnchor="middle">{t("base", "baza")}</text>
            : thin && <text className="muc-tick is-thin" x={center} y={bottom + 48} textAnchor="middle">{t("few tokens", "mało tokenów")}</text>}
        </g>;
      })}
      {/* Drawn last so the bars do not hide it. */}
      {average !== null && averageText && <g>
        <line className="muc-average" x1={LEFT} x2={width - RIGHT} y1={y(average)} y2={y(average)} />
        <text className="muc-note" x={width - RIGHT} y={y(average) - 5} textAnchor="end">{averageText}</text>
      </g>}
    </svg>
  </div>;
}

function UnitCostTable({ rows, colors, label }: { rows: UnitCostRow[]; colors: Map<string | null, string>; label: (model: string | null) => string }) {
  const { t, locale } = useI18n();
  const rate = (row: UnitCostRow, part: Part) => row.rates?.[part] ?? null;
  return <section aria-label={t("Cost per 1M and list prices", "Koszt 1M i cennik")}>
    <Table tableId="ModelUnitCost:0" defaultSort={{ column: "c3", direction: "desc" }} fixed><TableColGroup>
      <col /><col style={{ width: 76 }} /><col style={{ width: 92 }} /><col style={{ width: 84 }} /><col style={{ width: 72 }} />
      {PARTS.map(part => <col key={part} style={{ width: 84 }} />)}
    </TableColGroup><thead><TableRow header>
      <Th columnId="c0">{t("Model", "Model")}</Th>
      <Th columnId="c1" align="right">{t("Tokens", "Tokeny")}</Th>
      <Th columnId="c2" align="right" title={t("Standard API rates; ≥ = known part", "Stawki Standard API; ≥ = znana część")}>API-eq</Th>
      <Th columnId="c3" align="right" title={t("API-eq of the priced tokens per 1M of them", "API-eq wycenionych tokenów na 1M z nich")}>{t("Actual /1M", "Rzecz. /1M")}</Th>
      <Th columnId="c4" align="right" title={t("Actual per 1M divided by the fresh-input price", "Rzeczywisty koszt 1M podzielony przez cenę świeżego inputu")}>{t("× input", "× input")}</Th>
      {PARTS.map((part, index) => <Th key={part} columnId={`c${5 + index}`} align="right" title={t("List price, USD per 1M", "Cena cennikowa, USD za 1M")}>{partLabel(part, t)}</Th>)}
    </TableRow></thead><tbody>
      {rows.map(row => {
        const input = rate(row, "input");
        const ratio = row.perMillion !== null && input ? row.perMillion / input : null;
        return <TableRow key={row.model ?? ""}>
          <Td sortValue={row.model ?? ""} style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={row.model ?? undefined}>
            <span className="muc-swatch" style={{ background: colors.get(row.model) ?? "var(--muted)" }} />
            {row.model == null ? <span className="models-muted">{label(null)}</span> : <span className="mono">{row.model}</span>}
          </Td>
          <Td sortValue={row.tokens} mono align="right" title={full(row.tokens)}>{compact(row.tokens)}</Td>
          <Td sortValue={row.apiUsd} mono align="right">{row.apiUsd === null ? <span className="models-muted">{t("no rate", "brak stawki")}</span> : `${row.partial ? "≥ " : ""}${usd(row.apiUsd)}`}</Td>
          <Td sortValue={row.perMillion} mono align="right" title={row.partial ? t("priced tokens only", "tylko wycenione tokeny") : undefined}><b>{perMillionText(row.perMillion, locale)}</b></Td>
          <Td sortValue={ratio} mono align="right">{ratioText(ratio, locale)}</Td>
          {PARTS.map(part => <Td key={part} sortValue={rate(row, part)} mono align="right"
            title={row.rates?.changed ? t("Prices changed in the range; the latest are shown.", "Ceny zmieniły się w zakresie; pokazane są najnowsze.") : undefined}>
            {perMillionText(rate(row, part), locale)}{row.rates?.changed && part === "output" ? " *" : ""}</Td>)}
        </TableRow>;
      })}
    </tbody></Table>
  </section>;
}
