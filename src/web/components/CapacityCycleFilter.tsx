import { useState } from "react";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { capacityFull, capacityIsLowerBound, capacityPlanLabel, capacityUnitFormat, type CapacityUnit } from "../lib/codex-capacity";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { useI18n } from "../lib/i18n";
import { TableRow, GhostButton, Table, Th, Td } from "./ui";
import { TriStateCheck } from "./TriStateCheck";
import { WindowQualityLabel } from "./WindowEvidenceDetails";
import { capacityUnitLabel } from "./CodexCapacitySummary";

/** Visibility only: hidden cycles remain available here without another report read. */
export function CapacityCycleFilter({ windows, hidden, onChange, unit = "api_standard", basis = "observed" }: {
  windows: CodexComparisonWindow[]; hidden: ReadonlySet<string>; onChange: (ids: string[]) => void;
  unit?: CapacityUnit; basis?: CapacityBasis;
}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const date = (value: string) => value.replace("T", " ").slice(0, 16);
  const options = [...windows].sort((a, b) => b.start.localeCompare(a.start)).map(window => {
    const start = window.cycle_start ?? window.start;
    const end = window.cycle_end ?? window.reset;
    return {
      id: window.id,
      window, start, end,
      full: `${date(start)} → ${date(end)} UTC · ${capacityPlanLabel(window)}`,
      plan: capacityPlanLabel(window),
    };
  });
  const shown = options.filter(option => option.full.toLowerCase().includes(query.trim().toLowerCase()));
  const visible = windows.filter(window => !hidden.has(window.id)).length;
  const checked = shown.filter(option => !hidden.has(option.id)).length;
  const format = capacityUnitFormat(unit, locale);
  const setShown = (show: boolean) => {
    const ids = new Set(hidden);
    for (const option of shown) { if (show) ids.delete(option.id); else ids.add(option.id); }
    onChange([...ids]);
  };
  return <section className="stats-window-filter" aria-label={t("Cycle visibility", "Widoczność okien")}>
      <h3 className="stats-section-title">{t("Windows", "Okna")} · {visible}/{windows.length}</h3>
      <div className="stats-window-tools">
        <input className="ui-input stats-window-search" type="search" aria-label={t("Find a window", "Znajdź okno")}
          placeholder={t("Find a window…", "Znajdź okno…")} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="stats-window-actions">
          <GhostButton disabled={!shown.length} onClick={() => setShown(true)}>{query.trim() ? t("Show matches", "Pokaż pasujące") : t("Show all", "Pokaż wszystkie")}</GhostButton>
          <GhostButton disabled={!shown.length} onClick={() => setShown(false)}>{query.trim() ? t("Hide matches", "Ukryj pasujące") : t("Hide all", "Ukryj wszystkie")}</GhostButton>
        </div>
      </div>
      <Table tableId="CapacityCycleFilter:0"><thead><TableRow header>
        <Th columnId="c0"><TriStateCheck state={!checked ? "none" : checked === shown.length ? "all" : "some"}
          label={t("Show matching windows", "Pokaż pasujące okna")} onChange={() => setShown(checked !== shown.length)} /></Th>
        <Th columnId="c1">{t("Start · UTC", "Początek · UTC")}</Th><Th columnId="c2">{t("End · UTC", "Koniec · UTC")}</Th>
        <Th columnId="c3">{t("Plan", "Plan")}</Th><Th columnId="c4" align="right">{t("Meter Δ", "Przyrost")}</Th>
        <Th columnId="c5" align="right">100% · {capacityUnitLabel(unit, t)}</Th><Th columnId="c6">{t("Quality", "Jakość")}</Th>
      </TableRow></thead><tbody>
        {shown.map(option => { const full = capacityFull(option.window, unit, basis); return <TableRow key={option.id}>
          <Td title={option.full}>
          <input type="checkbox" data-cycle-id={option.id} checked={!hidden.has(option.id)} aria-label={`${t("Show window", "Pokaż okno")}: ${option.full}`}
            onChange={event => { const ids = new Set(hidden); if (event.target.checked) ids.delete(option.id); else ids.add(option.id); onChange([...ids]); }} />
          </Td>
          <Td mono title={date(option.start) + " UTC"}>{date(option.start)}</Td>
          <Td mono title={date(option.end) + " UTC"}>{date(option.end)}</Td>
          <Td>{option.plan}</Td><Td mono align="right">{option.window.observed_pp.toLocaleString(locale, { maximumFractionDigits: 1 })} {t("pp", "p.p.")}</Td>
          <Td mono align="right">{full === null ? "—" : `${capacityIsLowerBound(option.window, unit) ? "≥ " : "≈ "}${format.full(full)}`}</Td>
          <Td><WindowQualityLabel window={option.window} /></Td>
        </TableRow>; })}
        {!shown.length && <TableRow><Td colSpan={7}>{t("Nothing matches", "Brak pasujących")}</Td></TableRow>}
      </tbody></Table>
  </section>;
}
