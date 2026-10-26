import { TableGrid, TableGridRow } from "./DataTable";
import type { RailWindow } from "../lib/windows";
import { compact, dayTime, pct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";

const HISTORY_COLS = "150px 56px minmax(100px,1fr) 64px 80px 90px minmax(110px,0.8fr)";

/**
 * The limit-window table shared by Claude's Overview "Window history" tab and the History archive
 * (docs/design/audit-history-compare-mockup.html: the same table in both places).
 */
export function RailWindowTable({ rows, isSelected, onSelect }: {
  /** Rows in display order, newest first. */
  rows: RailWindow[];
  isSelected: (window: RailWindow) => boolean;
  onSelect?: (window: RailWindow) => void;
}) {
  const { t } = useI18n();
  const header = [t("window", "okno"), t("used", "zużyte"), t("vs 100%", "vs 100%"), "Fable", t("tokens", "tokeny"), "API-eq", t("note", "uwaga")];
  return (
    <div style={{ marginTop: "var(--s-5)", overflowX: "auto" }}>
      <TableGrid tableId="RailWindowTable:history"><div style={{ minWidth: 820 }}>
        <TableGridRow header style={{ display: "grid", gridTemplateColumns: HISTORY_COLS, gap: "var(--s-5)", padding: "0 var(--s-3) var(--s-3)", borderBottom: "1px solid var(--line2)",
          fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {header.map((label, i) => <span key={label} style={i >= 3 && i <= 5 ? { textAlign: "right" } : undefined}>{label}</span>)}
        </TableGridRow>
        {rows.map((w) => {
          const fable = w.sublimits[0] ?? null;
          const approx = (basis: RailWindow["percentBasis"], value: number | null) => basis !== "measured" && value != null ? "≈" : "";
          const mark = w.counterSegment?.startDrop ? `↓ ${t("after plan change", "po zmianie planu")}`
            : w.counterSegment?.endDrop ? `${t("until plan change", "do zmiany planu")} ↓` : "";
          return (
            <TableGridRow key={w.key} className="mono" onClick={onSelect ? () => onSelect(w) : undefined}
              style={{ display: "grid", gridTemplateColumns: HISTORY_COLS, gap: "var(--s-5)", alignItems: "center", padding: "var(--s-4) var(--s-3)",
                borderBottom: "var(--rule)", fontSize: "var(--fs-4)", background: isSelected(w) ? "var(--accent-soft)" : "transparent", cursor: onSelect ? "pointer" : undefined }}>
              <span style={{ color: w.isCurrent ? "var(--text)" : "var(--muted)", fontWeight: w.isCurrent ? "var(--fw-semibold)" : "var(--fw-regular)", whiteSpace: "nowrap" }}>
                {dayTime(w.startIso)}<br /><span style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>→ {dayTime(w.resetIso)}{w.isCurrent ? ` · ${t("current", "bieżące")}` : ""}</span>
              </span>
              <span style={{ fontSize: "var(--fs-5)", fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)", color: w.usedPercent == null ? "var(--faint)" : "var(--text)" }}>
                {approx(w.percentBasis, w.usedPercent)}{pct(w.usedPercent)}
              </span>
              <span style={{ position: "relative", display: "block", boxSizing: "border-box", height: 8, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
                {w.usedPercent != null && <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, w.usedPercent)}%`, background: "var(--accent)", display: "block" }} />}
              </span>
              <span style={{ textAlign: "right", color: "var(--muted)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>{fable ? `${approx(fable.percentBasis, fable.usedPercent)}${pct(fable.usedPercent)}` : "—"}</span>
              <span style={{ textAlign: "right", color: "var(--muted)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>{w.tokensTotal != null ? compact(w.tokensTotal) : "—"}</span>
              <span style={{ textAlign: "right", color: "var(--muted)", fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>{w.usd != null ? usd(w.usd) : "—"}</span>
              <span title={w.note ?? undefined} style={{ fontSize: "var(--fs-3)", color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: w.note ? "help" : undefined }}>
                {mark || (w.note ? "ⓘ" : "")}
              </span>
            </TableGridRow>
          );
        })}
      </div></TableGrid>
    </div>
  );
}
