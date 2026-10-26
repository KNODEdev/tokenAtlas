import { Fragment, useState } from "react";
import type { CodexComparisonWindow as Row, WindowUsage, TimelineMarker } from "../../shared/codex-accounting";
import { capacityPerPoint, capacityPeriodLabel, compareCapacity, defaultCapacityPair, type CapacityMetric, type CapacityUnit } from "../lib/codex-capacity";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { privateText } from "../lib/privacy";
import { CodexCapacitySummary, type CapacityReportTab } from "./CodexCapacitySummary";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { TableRow, Fact, FactNote, Facts, Field, GhostButton, HelpBlock, HelpDot, Selector, Table, Tabs, Td, Th } from "./ui";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { CodexColumnsDrawer } from "./CodexColumnsDrawer";
import type { DataSettingsTarget } from "../lib/data-settings";
import type { CycleAnalysisScope } from "../lib/capacity-cycle";
import { QUALITY_TONE, WindowEvidenceDetails, qualityLabel } from "./WindowEvidenceDetails";
import { usageModelLabel } from "../lib/format";
import { Chip } from "./WindowStatusCard";
import { MeasurementEditor, manualSaveError, removeManualReading, type ManualCapacityProps } from "./ManualCapacityMeasurements";
import { assessWindowQuality } from "../../shared/subscription-quality";
import "./CodexWindowTable.css";
import { capacityPlanLabel } from "../lib/codex-capacity";

const number = (n: number | null) => n == null ? "—" : n.toLocaleString(getLocale(), { maximumFractionDigits: 2 });
const percent = (n: number, d: number) => d > 0 ? `${number(100 * n / d)}%` : "—";
const date = (s: string) => s.replace("T", " ").slice(0, 16);
const sourceName = (s: string) => {
  const name = s.split(/[\\/]/).at(-1) || s;
  return name === "nieznane źródło" ? translate("unknown source", "nieznane źródło") : name;
};
const modelName = (s: string) => s === "nieznany model" ? translate("unknown model", "nieznany model") : usageModelLabel(s);
const capacityAmount = (r: Row, metric: "api_standard" | "credits_low" | "credits_high") => {
  const value = capacityPerPoint(r, metric);
  return number(value === null ? null : r.usage[metric]);
};
const capacityPerPointNumber = (r: Row, metric: CapacityMetric, divisor = 1) => {
  const value = capacityPerPoint(r, metric);
  return number(value === null ? null : value / divisor);
};
const columns = [
  { id: "period", en: "Measured (UTC)", pl: "Pomiar (UTC)", hint: ["The interval matched to meter readings; amounts cover this interval.", "Przedział dopasowany do odczytów licznika; kwoty dotyczą tego przedziału."], value: (r: Row) => date(r.start) + " → " + date(r.end) },
  { id: "cycle", en: "Cycle (UTC)", pl: "Cykl (UTC)", hint: ["From reset to reset.", "Od resetu do resetu."], value: (r: Row) => (r.window_minutes ? `${r.window_minutes}m · ` : "") + (r.cycle_start === null ? translate("Start unknown", "Początek nieustalony") : date(r.cycle_start ?? r.start)) + " → " + date(r.cycle_end ?? r.reset) },
  { id: "reset", en: "Reset (UTC)", pl: "Reset (UTC)", value: (r: Row) => date(r.reset) },
  { id: "plan", en: "Account / plan", pl: "Konto / plan", value: (r: Row) => r.account + " / " + capacityPlanLabel(r) },
  { id: "counter", en: "Meter", pl: "Licznik", value: (r: Row) => number(r.start_percent) + " → " + number(r.end_percent) + "%" },
  { id: "pp", en: "Consumption (pp)", pl: "Zużycie (p.p.)", value: (r: Row) => number(r.observed_pp) },
  { id: "events", en: "Events", pl: "Zdarzenia", value: (r: Row) => number(r.usage.events) },
  { id: "tokens", en: "Input + output tokens", pl: "Tokeny in + out", value: (r: Row) => number(r.usage.tokens) },
  { id: "fresh", en: "Fresh input", pl: "Input bez cache", value: (r: Row) => number(r.usage.input - r.usage.cached - (r.usage.cache_write_5m ?? 0) - (r.usage.cache_write_1h ?? 0) - (r.usage.cache_write_unknown ?? 0)) },
  { id: "cache", en: "Cached input", pl: "Input cache", value: (r: Row) => number(r.usage.cached) },
  { id: "output", en: "Output", pl: "Output", value: (r: Row) => number(r.usage.output) },
  { id: "cacheShare", en: "Cache / input", pl: "Cache / input", value: (r: Row) => percent(r.usage.cached, r.usage.input) },
  { id: "fast", en: "Fast / tokens", pl: "Fast / tokeny", value: (r: Row) => percent(r.usage.fast_tokens, r.usage.tokens) },
  { id: "unknown", en: "Unknown mode", pl: "Nieznany tryb", value: (r: Row) => percent(r.usage.unknown_tokens, r.usage.tokens) },
  { id: "coverage", en: "Pricing coverage", pl: "Pokrycie wyceny", hint: ["Share of tokens with a known price; not proof that every computer’s logs are present.", "Udział tokenów ze znaną ceną; nie potwierdza kompletności logów ze wszystkich komputerów."], value: (r: Row) => percent(r.usage.priced_tokens, r.usage.tokens) },
  { id: "missing", en: "Unpriced events", pl: "Bez wyceny (zdarzenia)", value: (r: Row) => number(r.usage.unpriced_events) },
  { id: "api", en: "API USD", pl: "API USD", hint: ["Priced work at Standard API rates.", "Wyceniona praca według stawek API Standard."], value: (r: Row) => capacityAmount(r, "api_standard") },
  { id: "creditLow", en: "Credits", pl: "Kredyty", hint: ["Unknown mode counted as Standard.", "Nieznany tryb liczony jako Standard."], value: (r: Row) => capacityAmount(r, "credits_low") },
  { id: "creditHigh", en: "Credits (Fast)", pl: "Kredyty (Fast)", hint: ["Unknown mode counted as Fast.", "Nieznany tryb liczony jako Fast."], value: (r: Row) => capacityAmount(r, "credits_high") },
  { id: "tokenPP", en: "M tokens / 1%", pl: "M tokenów / 1%", value: (r: Row) => capacityPerPointNumber(r, "tokens", 1e6) },
  { id: "apiPP", en: "API $ / 1%", pl: "API $ / 1%", hint: ["Standard API value of one meter point.", "Wartość API Standard jednego punktu licznika."], value: (r: Row) => capacityPerPointNumber(r, "api_standard") },
  { id: "lowPP", en: "Credits / 1%", pl: "Kredyty / 1%", hint: ["Unknown mode counted as Standard.", "Nieznany tryb liczony jako Standard."], value: (r: Row) => capacityPerPointNumber(r, "credits_low") },
  { id: "highPP", en: "Credits / 1% (Fast)", pl: "Kredyty / 1% (Fast)", hint: ["Unknown mode counted as Fast.", "Nieznany tryb liczony jako Fast."], value: (r: Row) => capacityPerPointNumber(r, "credits_high") },
  { id: "sources", en: "Sources (PC profiles)", pl: "Źródła (profile PC)", value: (r: Row) => r.sources.map(s => sourceName(s.name)).join(", ") || "—" },
  { id: "models", en: "Models / token share", pl: "Modele / udział tokenów", value: (r: Row) => r.models.map(m => modelName(m.name) + ": " + percent(m.tokens, r.usage.tokens)).join(", ") || "—" },
  { id: "probes", en: "Probes", pl: "Odczyty", value: (r: Row) => number(r.probes) },
  { id: "gap", en: "Longest gap (h)", pl: "Najdłuższa przerwa (h)", value: (r: Row) => number(r.max_gap_hours) },
] as const;
type Column = typeof columns[number]["id"];
const CREDIT_COLUMN_IDS: ReadonlySet<Column> = new Set(["creditLow", "creditHigh", "lowPP", "highPP"]);
const presetOptions: Array<{ en: string; pl: string; ids: Column[] }> = [
  { en: "Capacity", pl: "Pojemność", ids: ["cycle", "counter", "apiPP", "lowPP", "coverage", "unknown"] },
  { en: "Tokens and mode", pl: "Tokeny i tryb", ids: ["period", "tokens", "fresh", "cache", "output", "cacheShare", "fast", "unknown", "tokenPP"] },
  { en: "Sources and quality", pl: "Źródła i jakość", ids: ["period", "reset", "plan", "sources", "models", "coverage", "missing", "probes", "gap"] },
  { en: "All", pl: "Wszystkie", ids: columns.map(c => c.id) },
];
const storageKey = "tokenatlas.codex-window-columns.v1";
// Text columns stay left-aligned; every other column is a number and aligns right.
const TEXT_COLUMN_IDS: ReadonlySet<Column> = new Set(["period", "cycle", "reset", "plan", "counter", "sources", "models"]);
const shortDate = (s: string) => s.replace("T", " ").slice(5, 16);
// Fixed table layout: an open detail panel must not widen the columns. Dates and names get fixed widths,
// numbers share the rest, and a wide column set scrolls instead of squeezing below these minimums.
// Full token counts ("3,541,130,430") need more room than ratios and per-pp values; numbers are set in
// Plex Mono (the figure voice), which is wider than the former sans digits.
const COLUMN_WIDTH: Partial<Record<Column, number>> = { apiPP: 150, period: 104, cycle: 104, reset: 96, plan: 150, counter: 80, sources: 200, models: 240,
  tokens: 116, fresh: 108, cache: 116, output: 100, creditLow: 86, creditHigh: 86 };
const NUMBER_MIN_WIDTH = 72, EVIDENCE_WIDTH = 112;
function initialColumns(): Column[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(saved)) {
      const valid = [...new Set(saved.filter((id): id is Column => columns.some(c => c.id === id)))];
      if (valid.length) return valid;
    }
  } catch { /* Storage may be unavailable in private browsing. */ }
  return presetOptions[0]!.ids;
}
function localizedColumns() {
  return columns.map(({ en, pl, ...column }) => ({ ...column, label: translate(en, pl),
    hint: "hint" in column ? translate(column.hint[0], column.hint[1]) : undefined }));
}
function UsageDetails({ rows, kind, creditsAvailable = true }: { rows: Array<WindowUsage & { name: string }>; kind: "source" | "model"; creditsAvailable?: boolean }) {
  const { t } = useI18n();
  const hasCacheWrite5m = rows.some(r => r.cache_write_5m !== undefined);
  const hasCacheWrite1h = rows.some(r => r.cache_write_1h !== undefined);
  const hasCacheWriteUnknown = rows.some(r => r.cache_write_unknown !== undefined);
  return <Table tableId="CodexWindowTable:0"><thead><TableRow header><Th columnId="c0">{kind === "model" ? t("Model", "Model") : t("Source", "Źródło")}</Th><Th columnId="c1" align="right">{t("Tokens", "Tokeny")}</Th><Th columnId="c2" align="right">Fast</Th><Th columnId="c3" align="right">{t("Unknown mode", "Nieznany tryb")}</Th><Th columnId="c4" align="right">{t("Coverage", "Pokrycie")}</Th><Th columnId="c5" align="right">API Standard USD</Th>
    {hasCacheWrite5m && <Th columnId="c6" align="right">{t("Cache write 5m", "Zapis cache 5 min")}</Th>}
    {hasCacheWrite1h && <Th columnId="c7" align="right">{t("Cache write 1h", "Zapis cache 1 godz.")}</Th>}
    {hasCacheWriteUnknown && <Th columnId="c8" align="right">{t("Cache write unknown", "Nieznany zapis cache")}</Th>}
    {creditsAvailable && <Th columnId="c9" align="right">{t("Credits: unknown Standard / Fast", "Kredyty: nieznany Standard / Fast")}</Th>}</TableRow></thead>
    <tbody>{rows.map(r => <TableRow key={r.name}><Td title={r.name}>{kind === "model" ? modelName(r.name) : sourceName(r.name)}</Td><Td mono align="right">{number(r.tokens)}</Td><Td mono align="right">{percent(r.fast_tokens, r.tokens)}</Td><Td mono align="right">{percent(r.unknown_tokens, r.tokens)}</Td><Td mono align="right">{percent(r.priced_tokens, r.tokens)}</Td>
      <Td mono align="right">{number(r.events > r.unpriced_events ? r.api_standard : null)}</Td>
      {hasCacheWrite5m && <Td mono align="right">{number(r.cache_write_5m ?? null)}</Td>}
      {hasCacheWrite1h && <Td mono align="right">{number(r.cache_write_1h ?? null)}</Td>}
      {hasCacheWriteUnknown && <Td mono align="right">{number(r.cache_write_unknown ?? null)}</Td>}
      {creditsAvailable && <Td mono align="right">{r.events > r.unpriced_events ? `${number(r.credits_low)} – ${number(r.credits_high)}` : "—"}</Td>}</TableRow>)}</tbody></Table>;
}

export function MeasurementDetails({ row: r, creditsAvailable = true, openDataSettings }: { row: Row; creditsAvailable?: boolean; openDataSettings?: (target: DataSettingsTarget) => void }) {
  const { t } = useI18n();
  return <>
    <Facts>
      <Fact label={t("Account / plan", "Konto / plan")} value={r.account + " / " + capacityPlanLabel(r)} />
      <Fact label={t("Meter", "Licznik")} value={number(r.start_percent) + " → " + number(r.end_percent) + "%"}
        notes={<FactNote>{t("Consumption (pp)", "Zużycie (p.p.)")}: {number(r.observed_pp)}</FactNote>} />
      <Fact label={t("Reset (UTC)", "Reset (UTC)")} value={date(r.reset)} />
      <Fact label={t("Events", "Zdarzenia")} value={number(r.usage.events)} />
      <Fact label={t("Tokens", "Tokeny")} value={number(r.usage.tokens)} />
      <Fact label={t("API Standard", "API Standard")} value={capacityAmount(r, "api_standard")}
        notes={<FactNote>{t("Coverage", "Pokrycie")}: {percent(r.usage.priced_tokens, r.usage.tokens)}</FactNote>} />
    </Facts>
    <WindowEvidenceDetails window={r} open={openDataSettings} unfolded />
    <section><h3>{t("Computers and sources", "Komputery i źródła")}</h3><UsageDetails rows={r.sources} kind="source" creditsAvailable={creditsAvailable} /></section>
    <section><h3>{t("Models", "Modele")}</h3><UsageDetails rows={r.models} kind="model" creditsAvailable={creditsAvailable} /></section>
  </>;
}

export function CodexWindowTable({ windows, allWindows, unit, minObservedPercent, range, view = "capacity", basis = "observed", markers = [], creditsAvailable = true, openDataSettings, analysisScope, manual, contextImpact, capacityTab }: {
  /** Measurements view: add, edit and remove manual percentage readings in place (providers that accept them). */
  manual?: ManualCapacityProps;
  markers?: TimelineMarker[]; windows: Row[] | null; view?: "capacity" | "measurements" | "methodology" | "trends" | "usage"; basis?: CapacityBasis; creditsAvailable?: boolean; openDataSettings?: (target: DataSettingsTarget) => void; analysisScope?: CycleAnalysisScope;
  /** Capacity view only: cycles before the display filters, the unit switch, the Min used % filter and the report dates. */
  allWindows?: Row[]; unit?: CapacityUnit; minObservedPercent?: number; range?: { since: string; until: string };
  /** The context-impact preview the windows were priced with. */
  contextImpact?: boolean;
  /** Capacity view: which of the report's views the screen's tab row shows. */
  capacityTab?: CapacityReportTab;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(initialColumns);
  const [baselineId, setBaselineId] = useState("");
  const [currentId, setCurrentId] = useState("");
  // Newest first, like the cycle list (user, 2026-10-21).
  const [newestFirst, setNewestFirst] = useState(true);
  const [open, setOpen] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  const shown = windows?.find(row => row.id === open?.id);
  const [columnsOpen, setColumnsOpen] = useState(false);
  // "new" opens the add panel above the table; a measurement id opens the editor under its row.
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const availableColumns = localizedColumns().filter(c => creditsAvailable || !CREDIT_COLUMN_IDS.has(c.id));
  const availablePresets = presetOptions.map(preset => ({ ...preset, ids: preset.ids.filter(id => creditsAvailable || !CREDIT_COLUMN_IDS.has(id)) }));
  const activeSelected = selected.filter(id => creditsAvailable || !CREDIT_COLUMN_IDS.has(id));
  const safeSelected = activeSelected.length ? activeSelected : (availablePresets[0]?.ids ?? ["period"]);
  const visible = safeSelected.flatMap(id => {
    const column = availableColumns.find(c => c.id === id);
    return column ? [column] : [];
  });
  const rows = newestFirst ? [...(windows ?? [])].reverse() : windows ?? [];
  const actionsWidth = manual && rows.some(r => r.manual_measurement) ? 150 : 96;
  const defaults = defaultCapacityPair(windows ?? []);
  const baseline = windows?.find(r => r.id === baselineId) ?? defaults.baseline;
  const current = windows?.find(r => r.id === currentId) ?? defaults.current;
  const hasComparableBaseline = baseline ? rows.some(r => compareCapacity(baseline, r).compatible) : false;
  const deltaLabel = creditsAvailable
    ? t("Credit change per 1% vs reference (unknown = Standard)", "Zmiana kredytów na 1% względem odniesienia (nieznany = Standard)")
    : t("API change per 1% vs reference", "Zmiana API na 1% względem odniesienia");
  const delta = (r: Row) => {
    if (!baseline) return "—";
    const comparison = compareCapacity(baseline, r);
    const value = comparison.compatible ? comparison.change(creditsAvailable ? "credits_low" : "api_standard") : null;
    return value === null ? "—" : number(value) + "%";
  };
  // State shared by every row is said once above the table; the column stays only for differing rows or manual readings.
  const statuses = rows.map(r => assessWindowQuality(r).status);
  const commonStatus = statuses.length && statuses.every(status => status === statuses[0]) ? statuses[0]! : null;
  const evidenceColumn = !commonStatus || rows.some(r => r.manual_measurement);
  const showDelta = hasComparableBaseline && rows.some(r => delta(r) !== "—");
  const apiMax = Math.max(0, ...rows.map(r => capacityPerPoint(r, "api_standard") ?? 0));
  const tableMinWidth = (evidenceColumn ? EVIDENCE_WIDTH : 0) + actionsWidth + visible.reduce((sum, c) => sum + (COLUMN_WIDTH[c.id] ?? NUMBER_MIN_WIDTH), 0)
    + (showDelta ? NUMBER_MIN_WIDTH : 0);
  function choose(ids: Column[]) {
    if (!ids.length) return;
    const available = ids.filter(id => creditsAvailable || !CREDIT_COLUMN_IDS.has(id));
    if (!available.length) return;
    setSelected(available);
    try { localStorage.setItem(storageKey, JSON.stringify(available)); } catch { /* Selection still works for this visit. */ }
  }
  function download() {
    const quote = (value: string) => { const s = privateText(value); return `"${(/^[=+@]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
    const csv = [visible.map<string>(c => c.label).concat(hasComparableBaseline ? [deltaLabel] : []),
      ...rows.map(r => visible.map(c => c.value(r)).concat(hasComparableBaseline ? [delta(r)] : []))].map(row => row.map(quote).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = translate("codex-window-comparison.csv", "codex-okna-porownanie.csv");
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section aria-label={t("Subscription capacity comparison", "Porównanie pojemności subskrypcji")} style={{ fontSize: "var(--fs-3)", lineHeight: 1.6, margin: "14px 0" }}>
    {windows && windows.length > 0 && (view === "capacity" || view === "methodology") && <CodexCapacitySummary analysisScope={analysisScope} markers={markers} basis={basis} mode={view === "methodology" ? "methodology" : "overview"} windows={windows}
      allWindows={allWindows} unit={unit} minObservedPercent={minObservedPercent} range={range} baseline={baseline} current={current} onBaseline={setBaselineId} onCurrent={setCurrentId} creditsAvailable={creditsAvailable} openDataSettings={openDataSettings} contextImpact={contextImpact} tab={capacityTab} />}
    {!windows?.length && <p>{t("No cycles with a usable meter reading were found. Expand the date range or choose another account.", "Brak cykli z odczytem pozwalającym obliczyć pojemność. Poszerz zakres dat lub wybierz inne konto.")}</p>}
    {view === "measurements" && <div className="measurements">
      <div className="capacity-section-head">
        <h3>{t("Measurements", "Pomiary")} <span className="capacity-faint">{rows.length}</span></h3>
        {commonStatus && <Chip tone={QUALITY_TONE[commonStatus]}>{t("all", "wszystkie")}: {{ comparable: t("comparable", "porównywalne"), partial: t("partial data", "częściowe dane"), insufficient: t("insufficient data", "niewystarczające dane") }[commonStatus]}</Chip>}
        <HelpDot label={t("How to read the measurements", "Jak czytać pomiary")}>
          <HelpBlock>{t("Each row represents a reset cycle. Measurement dates show the largest interval matched to meter readings; the amounts here use that same interval. The Capacity view also shows total traffic across the cycle. An early reset can shorten a cycle.", "Każdy wiersz reprezentuje cykl resetu. Daty pomiaru pokazują maksymalny przedział dopasowany do odczytów licznika; kwoty tutaj dotyczą tego samego przedziału. Widok Pojemność pokazuje także sumę ruchu w całym cyklu. Wcześniejszy reset może skrócić cykl.")}</HelpBlock>
          <HelpBlock>{t("Choose columns to customize the table. Open a row to see its evidence, computers, models and pricing coverage.", "Wybierz kolumny, aby dostosować tabelę. Otwórz wiersz, aby zobaczyć podstawy pomiaru, komputery, modele i pokrycie wyceny.")}</HelpBlock>
          <HelpBlock>{creditsAvailable
            ? t("API and credits share the priced portion. The two credit scenarios assign all unknown requests to Standard or all to Fast; known modes stay unchanged. Rates follow the pricing rules for each event date; historical backfills are assumptions. Spark has a separate limit and is excluded. Tools and missing rates are not added. Per-1% values and the change against a reference are scenarios, not evidence of a subscription change; small meter increases and reading gaps weaken the comparison.", "API i kredyty dotyczą wspólnej wycenionej części. Dwa scenariusze kredytów przypisują cały nieznany ruch do Standard albo Fast; znane tryby pozostają bez zmian. Stawki odpowiadają datom reguł cennika; historyczne uzupełnienia są założeniem. Spark ma osobny limit i jest pominięty. Narzędzia oraz brakujące stawki nie są doliczone. Wartości na 1% i zmiana względem odniesienia są scenariuszem, nie dowodem zmiany abonamentu; mały przyrost licznika i luki odczytów osłabiają porównanie.")
            : t("API values use configured rates for priced traffic; unknown traffic remains visible in coverage and token totals. Rates follow the pricing rules for each event date; historical backfills are assumptions. Tools and missing rates are not added. Per-1% values and the change against a reference describe recorded traffic and rates, not proof of a subscription change.", "Wartości API stosują skonfigurowane stawki dla wycenionego ruchu; nieznany ruch pozostaje widoczny w pokryciu i sumach tokenów. Stawki odpowiadają datom reguł cennika; historyczne uzupełnienia są założeniem. Narzędzia oraz brakujące stawki nie są doliczone. Wartości na 1% i zmiana względem odniesienia opisują zapisany ruch i stawki, nie dowodzą zmiany abonamentu.")}</HelpBlock>
        </HelpDot>
        <span className="ui-spacer" />
        {manual && <GhostButton aria-expanded={editing === "new"} onClick={() => { setEditing(editing === "new" ? null : "new"); setRemoving(null); }}>+ {t("Add measurement", "Dodaj pomiar")}</GhostButton>}
      </div>
      {manual && editing === "new" && <MeasurementEditor {...manual} key={`new:${manual.provider}:${manual.account}`} onClose={() => setEditing(null)} />}
      {columnsOpen && <CodexColumnsDrawer columns={availableColumns} selected={safeSelected} onChange={ids => choose(ids as Column[])} onClose={() => setColumnsOpen(false)} />}
      {windows !== null && <>
        <div className="ui-toolbar measurements-toolbar">
          <Field label={t("Columns", "Kolumny")}>
            <Selector ariaLabel={t("Column preset", "Zestaw kolumn")} value={String(availablePresets.findIndex(p => p.ids.length === safeSelected.length && p.ids.every((id, i) => id === safeSelected[i])))}
              onChange={value => { const preset = availablePresets[Number(value)]; if (preset) choose(preset.ids); }}
              options={[{ value: "-1", label: t("Custom", "Własny"), disabled: true }, ...availablePresets.map((preset, i) => ({ value: String(i), label: t(preset.en, preset.pl) }))]} />
          </Field>
          <Field label={t("Order", "Kolejność")}>
            <Tabs value={newestFirst ? "newest" : "oldest"} onChange={value => setNewestFirst(value === "newest")}
              options={[{ value: "newest", label: t("Newest first", "Najnowsze") }, { value: "oldest", label: t("Oldest first", "Najstarsze") }]} />
          </Field>
          <Field label={t("Change vs", "Zmiana względem")} title={deltaLabel}>
            <Selector ariaLabel={t("Calculate changes from cycle", "Licz zmiany względem cyklu")} value={baseline?.id ?? ""} onChange={setBaselineId}
              options={[...(!baseline ? [{ value: "", label: t("No reference", "Brak odniesienia") }] : []),
                ...rows.map(r => ({ value: r.id, label: `${capacityPeriodLabel(r, getLocale())} · ${capacityPlanLabel(r)} · ${number(r.end_percent)}%` }))]} />
          </Field>
          <span className="ui-spacer" />
          <GhostButton onClick={download} disabled={!rows.length}>{t("Download CSV", "Pobierz CSV")}</GhostButton>
        </div>
        {manualError && <p role="alert" className="ui-alert">{manualError}</p>}
        <div className="measurements-scroll">
          <table className="measurements-table" style={{ minWidth: tableMinWidth }}>
            <colgroup>
              {evidenceColumn && <col style={{ width: EVIDENCE_WIDTH }} />}
              {visible.map(c => <col key={c.id} style={COLUMN_WIDTH[c.id] ? { width: COLUMN_WIDTH[c.id] } : undefined} />)}
              {showDelta && <col />}
              <col style={{ width: actionsWidth }} />
            </colgroup>
            <thead><tr>
              {evidenceColumn && <th scope="col">{t("Evidence", "Dane")}</th>}
              {visible.map(c => <th key={c.id} scope="col" className={TEXT_COLUMN_IDS.has(c.id) ? undefined : "is-number"} title={c.hint}>{c.label}</th>)}
              {showDelta && <th scope="col" className="is-number" title={deltaLabel}>{t("Change", "Zmiana")}</th>}
              <th scope="col" className="measurements-actions-head data-table-last-heading" aria-label={t("Actions", "Akcje")}>
                <button type="button" className="ui-button data-table-columns-button" aria-haspopup="dialog" aria-expanded={columnsOpen}
                  aria-label={t("Choose table columns", "Wybierz kolumny tabeli")} title={t("Columns: visibility and order", "Kolumny: widoczność i kolejność")}
                  onClick={() => setColumnsOpen(true)}>▥</button>
              </th>
            </tr></thead>
            <tbody>{rows.map(r => {
              const quality = assessWindowQuality(r);
              const manualId = manual ? r.manual_measurement?.id : undefined;
              const selected = open?.id === r.id;
              const choose = (opener: HTMLElement | null) => setOpen({ id: r.id, opener });
              const span = visible.length + (showDelta ? 1 : 0) + (evidenceColumn ? 2 : 1);
              const apiPerPoint = capacityPerPoint(r, "api_standard");
              const shortQuality = { comparable: t("comparable", "porównywalny"), partial: t("partial", "częściowy"), insufficient: t("insufficient", "niewystarczający") };
              return <Fragment key={r.id}><tr className={`ui-open-row${selected ? " is-selected" : ""}`} aria-current={selected || undefined}
                onClick={event => choose(event.currentTarget.querySelector<HTMLButtonElement>(".ui-open-row-button"))}>
                {evidenceColumn && <td className="measurements-evidence">
                  {quality.status !== commonStatus && <button type="button" className="ui-open-row-button" aria-haspopup="dialog"
                    aria-label={`${t("Measurement details", "Szczegóły pomiaru")}: ${date(r.start)} → ${date(r.end)}`}
                    onClick={event => { event.stopPropagation(); choose(event.currentTarget); }}>
                    <Chip tone={QUALITY_TONE[quality.status]} title={quality.reasons.map(reason => qualityLabel(reason, t)).join(" · ")}>{shortQuality[quality.status]}</Chip> <span aria-hidden="true">›</span>
                  </button>}
                  {r.manual_measurement && <Chip tone="var(--accent)" title={r.manual_measurement.note || undefined}>{t("manual", "ręczny")}</Chip>}
                </td>}
                {visible.map(c => <td key={c.id} className={`mono${TEXT_COLUMN_IDS.has(c.id) ? "" : " is-number"}`} title={c.value(r)}>
                  {c.id === "period" ? <span className="measurements-when">{shortDate(r.start)}<span>→ {shortDate(r.end)}</span></span>
                    : c.id === "cycle" ? <span className="measurements-when">{r.cycle_start === null ? t("Start unknown", "Początek nieustalony") : shortDate(r.cycle_start ?? r.start)}<span>→ {shortDate(r.cycle_end ?? r.reset)}</span></span>
                      : c.id === "reset" ? shortDate(r.reset)
                        : c.id === "apiPP" && apiPerPoint !== null && apiMax > 0 ? <span className="measurements-bar-cell">
                          <span className="measurements-bar"><span style={{ width: `${apiPerPoint / apiMax * 100}%` }} /></span>{c.value(r)}</span>
                          : c.value(r)}
                </td>)}
                {showDelta && <td className="mono is-number">{delta(r)}</td>}
                <td className="measurements-actions" onClick={event => event.stopPropagation()}><div className="measurements-actions-inner">
                  {removing === r.id && manualId ? <span className="manual-confirm" role="group" aria-label={t("Confirm removal", "Potwierdź usunięcie")}>
                    {t("Remove?", "Usunąć?")}
                    <button type="button" className="manual-danger" disabled={removeBusy} onClick={async () => {
                      if (!manual) return;
                      setRemoveBusy(true); setManualError(null);
                      try { await removeManualReading(manual.provider, manual.account, manualId); setRemoving(null); manual.onSaved(""); }
                      catch (error) { setManualError(manualSaveError(error, t)); }
                      finally { setRemoveBusy(false); }
                    }}>{t("Yes, remove", "Tak, usuń")}</button>
                    <button type="button" className="measurements-action" onClick={() => setRemoving(null)}>{t("Cancel", "Anuluj")}</button>
                  </span> : <>
                    {manualId && <button type="button" className="measurements-action" aria-expanded={editing === r.id}
                      aria-label={`${t("Edit manual reading", "Edytuj ręczny pomiar")}: ${date(r.start)} → ${date(r.end)}`}
                      onClick={() => { setEditing(editing === r.id ? null : r.id); setRemoving(null); }}>{t("Edit", "Edytuj")}</button>}
                    {manualId && <button type="button" className="measurements-action is-danger"
                      aria-label={`${t("Remove manual reading", "Usuń ręczny pomiar")}: ${date(r.start)} → ${date(r.end)}`}
                      onClick={() => { setRemoving(r.id); setEditing(null); }}>{t("Remove", "Usuń")}</button>}
                    <button type="button" className="measurements-action measurements-details" aria-haspopup="dialog" aria-label={`${t("Details", "Szczegóły")}: ${date(r.start)} → ${date(r.end)}`}
                      onClick={event => { event.stopPropagation(); choose(event.currentTarget); }}>{t("Details", "Szczegóły")}</button>
                  </>}
                </div>
                </td>
              </tr>
              {manual && manualId && editing === r.id && <tr className="measurements-panel-row"><td colSpan={span}>
                <MeasurementEditor {...manual} key={`edit:${manualId}`} initialId={manualId} onClose={() => setEditing(null)} />
              </td></tr>}
              </Fragment>;
            })}</tbody>
          </table>
        </div>
      </>}
    </div>}
    {view === "measurements" && shown && open && <AccountPeriodDrawer busy={false} returnFocus={open.opener} onClose={() => setOpen(null)}
      className="ui-detail-drawer" title={`${date(shown.start)} → ${date(shown.end)} UTC`} subtitle={shown.account}
      closeLabel={t("Close measurement details", "Zamknij szczegóły pomiaru")}>
      <MeasurementDetails row={shown} creditsAvailable={creditsAvailable} openDataSettings={openDataSettings} />
    </AccountPeriodDrawer>}
  </section>;
}
