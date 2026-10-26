import { useMemo, useState, type CSSProperties } from "react";
import type { CodexComparisonWindow as Window } from "../../shared/codex-accounting";
import { TOKEN_TYPE_COLOR, usageTokenTypes } from "../lib/codex-capacity";
import { compact, full, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { HelpBlock, HelpDot, Tabs } from "./ui";
import { TableGridCells, useTableColumns } from "./DataTable";

type WriteKey = "cache_write_5m" | "cache_write_1h" | "cache_write_unknown";
const writeKeys: WriteKey[] = ["cache_write_5m", "cache_write_1h", "cache_write_unknown"];
// Cache write durations share one hue; the longer and the unlabelled ones are lighter tints of it.
const writeColors: Record<WriteKey, string> = {
  cache_write_5m: TOKEN_TYPE_COLOR.cache_write,
  cache_write_1h: `color-mix(in oklab, ${TOKEN_TYPE_COLOR.cache_write} 55%, var(--surface))`,
  cache_write_unknown: `color-mix(in oklab, ${TOKEN_TYPE_COLOR.cache_write} 32%, var(--surface))`,
};

/** One cycle's disjoint token types; `writes` is null where the source reports no cache write. */
interface CycleTokens {
  window: Window;
  fresh: number; cached: number; output: number; total: number;
  writes: Record<WriteKey, number> | null;
}

interface Column {
  key: string; label: string; color: string; title: string;
  value: (row: CycleTokens) => number | null;
}

function cycleTokens(window: Window): CycleTokens | null {
  const usage = window.cycle_usage ?? window.usage;
  if (usage.events <= 0) return null;
  const types = usageTokenTypes(usage);
  if (!types) return null;
  const writes = types.cache_write === null ? null
    : { cache_write_5m: usage.cache_write_5m ?? 0, cache_write_1h: usage.cache_write_1h ?? 0, cache_write_unknown: usage.cache_write_unknown ?? 0 };
  return { window, fresh: types.fresh, cached: types.cached, output: types.output, writes,
    total: types.fresh + types.cached + (types.cache_write ?? 0) + types.output };
}

const writeTotal = ({ writes }: CycleTokens) => writes ? writeKeys.reduce((sum, key) => sum + writes[key], 0) : null;
const share = (part: number, whole: number) => {
  if (!(whole > 0)) return "—";
  const percent = 100 * part / whole;
  return percent > 0 && percent < 0.01 ? "< 0.01%" : pct(percent, percent < 1 ? 2 : 1);
};

/**
 * Tokens of each cycle split by type. "Each type" gives every type its own column and scale, so
 * fresh input and output stay visible next to the cache reads that dwarf them; "Input vs output"
 * groups everything sent to the model against what it produced.
 */
export function CapacityTokenTypes({ windows, moment }: { windows: Window[]; moment: (time: number) => string }) {
  const { t } = useI18n();
  const [view, setView] = useState<"types" | "groups">("types");
  const rows = useMemo(() => [...windows].reverse().map(window => ({ window, tokens: cycleTokens(window) })), [windows]);
  const measured = rows.flatMap(row => row.tokens ? [row.tokens] : []);
  const writesReported = measured.some(row => row.writes !== null);
  const splitWrites = writeKeys.filter(key => measured.some(row => (row.writes?.[key] ?? 0) > 0));
  const writeLabel: Record<WriteKey, string> = {
    cache_write_5m: t("Cache write 5m", "Cache write 5m"), cache_write_1h: t("Cache write 1h", "Cache write 1h"),
    cache_write_unknown: t("Cache write, TTL unknown", "Cache write, TTL nieznany"),
  };
  const writeColumns: Column[] = !writesReported ? []
    : splitWrites.length > 1 || (splitWrites.length === 1 && splitWrites[0] !== "cache_write_unknown")
      ? splitWrites.map(key => ({ key, label: writeLabel[key], color: writeColors[key], value: row => row.writes?.[key] ?? null,
        title: t("Tokens written to the prompt cache with this lifetime.", "Tokeny zapisane do cache promptu z tym czasem życia.") }))
      : [{ key: "cache_write", label: "Cache write", color: TOKEN_TYPE_COLOR.cache_write, value: writeTotal,
        title: t("Tokens written to the prompt cache.", "Tokeny zapisane do cache promptu.") }];
  const fresh: Column = { key: "fresh", label: t("Fresh input", "Świeży input"), color: TOKEN_TYPE_COLOR.fresh, value: row => row.fresh,
    title: t("Input neither read from nor written to the cache.", "Input, który nie był ani odczytany z cache, ani do niego zapisany.") };
  const cached: Column = { key: "cached", label: "Cache read", color: TOKEN_TYPE_COLOR.cached, value: row => row.cached,
    title: t("Input read back from the prompt cache.", "Input odczytany z cache promptu.") };
  const output: Column = { key: "output", label: t("Output incl. reasoning", "Output z rozumowaniem"), color: TOKEN_TYPE_COLOR.output, value: row => row.output,
    title: t("Everything the model produced; the sources do not report reasoning separately.", "Wszystko, co wygenerował model; źródła nie podają rozumowania osobno.") };
  const inputSide: Column = { key: "input", label: t("Input side", "Strona wejścia"), color: TOKEN_TYPE_COLOR.cached,
    value: row => row.fresh + row.cached + (writeTotal(row) ?? 0),
    title: t("Everything sent to the model: fresh input, cache read and cache write.", "Wszystko wysłane do modelu: świeży input, cache read i cache write.") };
  const columns: Column[] = view === "types" ? [fresh, cached, ...writeColumns, output] : [inputSide, output];
  const inputParts: Column[] = [fresh, cached, ...writeColumns];
  const rangeTotal = measured.reduce((sum, row) => sum + row.total, 0);
  const maxima = new Map(columns.map(column => [column.key, Math.max(0, ...measured.map(row => column.value(row) ?? 0))]));
  const tableColumns = [{ id: "cycle", label: t("Cycle · UTC", "Cykl · UTC") }, ...columns.map(column => ({ id: column.key, label: column.label })), { id: "total", label: t("All tokens", "Wszystkie tokeny") }];
  const columnSettings = useTableColumns("CapacityTokenTypes", tableColumns);
  const template = { "--token-columns": columns.length, "--token-template": columnSettings.selected.map(id => id === "cycle" ? "calc(var(--s-10) * 4)" : id === "total" ? "calc(var(--s-8) * 4)" : "minmax(0, 1fr)").join(" ") } as CSSProperties;
  const gridCells = { columns: tableColumns, selected: columnSettings.selected };
  if (!measured.length) return null;

  const bar = (column: Column, row: CycleTokens) => {
    const value = column.value(row);
    if (value === null) return <span key={column.key} role="cell" className="capacity-token-cell capacity-unavailable">{t("not reported", "nie raportowany")}</span>;
    const max = maxima.get(column.key) ?? 0;
    const width = max > 0 ? 100 * value / max : 0;
    const title = `${column.label} · ${full(value)} ${t("tokens", "tokenów")} · ${share(value, row.total)} ${t("of this cycle", "tego cyklu")}`;
    const stacked = column === inputSide && value > 0;
    return <span key={column.key} className="capacity-token-cell" role="cell" title={title}>
      <span className="capacity-token-track">
        <span className="capacity-token-fill" style={{ width: `${width}%`, minWidth: value > 0 ? 2 : 0, background: stacked ? undefined : column.color }}>
          {stacked && inputParts.map(part => {
            const partValue = part.value(row) ?? 0;
            return partValue > 0 ? <span key={part.key} title={`${part.label} · ${full(partValue)}`} style={{ flexGrow: partValue, background: part.color }} /> : null;
          })}
        </span>
      </span>
      <span className="mono capacity-token-value">{compact(value)}</span>
      <span className="mono capacity-token-share">{share(value, row.total)}</span>
    </span>;
  };

  return <div className="capacity-section">
    <div className="capacity-section-head">
      <h3>{t("Token types by cycle", "Typy tokenów w cyklach")}</h3>
      <span className="capacity-section-sub">{view === "types"
        ? t("whole cycle · each column has its own scale", "cały cykl · każda kolumna ma własną skalę")
        : t("whole cycle · input and output each on their own scale", "cały cykl · wejście i wyjście mają osobne skale")}</span>
      <HelpDot label={t("How to read the token types", "Jak czytać typy tokenów")}>
        <HelpBlock>{t("Each row is one cycle from the list above, with all traffic assigned to it. Bars in one column share that column's scale: the longest bar is the column's largest cycle, so small types such as fresh input and output stay readable next to the cache reads that dwarf them.", "Każdy wiersz to jeden cykl z listy powyżej z całym przypisanym do niego ruchem. Paski w jednej kolumnie mają wspólną skalę tej kolumny: najdłuższy pasek to największy cykl w kolumnie, więc małe typy, jak świeży input i output, pozostają czytelne obok przytłaczających je odczytów cache.")}</HelpBlock>
        <HelpBlock>{t("Fresh input = input − cache read − cache write. The percentage beside a bar is that type's share of the cycle's tokens; in a column header, its share of all tokens in the listed cycles. Hover a bar for the exact count.", "Świeży input = input − cache read − cache write. Procent przy pasku to udział tego typu w tokenach cyklu; w nagłówku kolumny — we wszystkich tokenach pokazanych cykli. Wskaż pasek, aby zobaczyć dokładną liczbę.")}</HelpBlock>
        <HelpBlock>{t("Token counts only: this data does not yet carry the API value of each token type.", "Tylko liczby tokenów: te dane nie zawierają jeszcze wartości API dla poszczególnych typów tokenów.")}</HelpBlock>
      </HelpDot>
      <span className="ui-spacer" />
      <Tabs value={view} onChange={setView} options={[
        { value: "types", label: t("Each type", "Każdy typ osobno") },
        { value: "groups", label: t("Input vs output", "Wejście a wyjście") },
      ]} />
    </div>
    {!writesReported && <p className="capacity-section-sub capacity-token-note">Cache write: {t("not reported by this source", "to źródło go nie raportuje")}</p>}
    {columnSettings.drawer}
    <div className="capacity-token-grid" role="table" aria-label={t("Token types by cycle", "Typy tokenów w cyklach")} style={template}>
      <div className="capacity-token-row capacity-token-head" role="row"><TableGridCells {...gridCells} trigger={columnSettings.trigger}>
        <span role="columnheader">{t("Cycle · UTC", "Cykl · UTC")}</span>
        {columns.map(column => {
          const sum = measured.reduce((total, row) => total + (column.value(row) ?? 0), 0);
          return <span key={column.key} role="columnheader" title={`${column.title} ${t("Scale: 0 –", "Skala: 0 –")} ${compact(maxima.get(column.key) ?? 0)}.`}>
            <span>{column === inputSide
              ? <span className="capacity-token-swatches">{inputParts.map(part => <i key={part.key} style={{ background: part.color }} />)}</span>
              : <i style={{ background: column.color }} />}{column.label}</span>
            <b>{share(sum, rangeTotal)}</b>
          </span>;
        })}
        <span role="columnheader" className="capacity-right">{t("All tokens", "Wszystkie tokeny")}</span>
      </TableGridCells></div>
      {rows.map(({ window, tokens }) => <div key={window.id} className="capacity-token-row" role="row"><TableGridCells {...gridCells}>
        <span role="cell" className="mono capacity-token-cycle">
          {moment(Date.parse(window.cycle_start ?? window.start))}<span className="capacity-faint">→ {moment(Date.parse(window.cycle_end ?? window.reset))}</span>
        </span>
        {tokens ? columns.map(column => bar(column, tokens))
          : columns.map(column => <span key={column.key} role="cell" className="capacity-unavailable">—</span>)}
        <span role="cell" className="mono capacity-right" title={tokens ? `${full(tokens.total)} ${t("tokens", "tokenów")}` : undefined}>{tokens ? compact(tokens.total) : "—"}</span>
      </TableGridCells></div>)}
    </div>
  </div>;
}
