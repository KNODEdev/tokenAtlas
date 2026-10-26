import { TableGrid, TableGridRow } from "./DataTable";
import type { CycleView } from "../lib/cycle";
import { cyclePlanDescription } from "../lib/codex-window-stats";
import { compact, dayTime, duration, signedPp } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
import { windowResult, windowResultLabel } from "../lib/window-archive";

// Fits the Overview card at 1400px with both rails: the start · duration and result cells wrap instead of scrolling.
const HISTORY_COLS = "44px 48px minmax(80px,1fr) 104px 58px 64px minmax(72px,0.7fr) minmax(92px,0.9fr) minmax(64px,84px)";

function localizedNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits });
}

/**
 * The window table shared by the Overview's "Window history" tab and the History archive
 * (docs/design/audit-history-compare-mockup.html: one component instead of three).
 */
export function CycleHistoryTable({ cycles, selectedIndex, medianPercent, onOpen, onDetails }: {
  /** Rows in display order. */
  cycles: CycleView[];
  /** The highlighted row. */
  selectedIndex: number | null;
  medianPercent: number | null;
  onOpen: (index: number) => void;
  onDetails: (index: number) => void;
}) {
  const { t } = useI18n();
  const maxPercent = Math.max(100, ...cycles.map((c) => c.usedPercent));
  return (
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <TableGrid tableId="CycleHistoryTable:history"><div style={{ minWidth: 700 }}>
        <TableGridRow header
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: HISTORY_COLS,
            gap: 10,
            padding: "0 6px 6px",
            borderBottom: "1px solid var(--line2)",
            fontSize: "var(--fs-3)",
            color: "var(--muted)",
          }}
        >
          <span>{t("cycle", "cykl")}</span>
          <span>{t("used", "zużyte")}</span>
          <span>{t("vs 100% · median", "vs 100% · mediana")}</span>
          <span style={{ textAlign: "right" }}>{t("tokens / allow.", "tokeny / allow.")}</span>
          <span style={{ textAlign: "right" }}>{t("Δ median", "Δ med")}</span>
          <span style={{ textAlign: "right" }}>{t("average burn", "średni burn")}</span>
          <span>{t("model", "model")}</span>
          <span>{t("window", "okno")}</span>
          <span style={{ textAlign: "right" }}>{t("result", "wynik")}</span>
        </TableGridRow>
        {cycles.map((c) => {
          const dMed = medianPercent != null ? c.usedPercent - medianPercent : null;
          return (
            <TableGridRow as="button"
              key={c.index}
              onClick={() => onOpen(c.index)}
              onDoubleClick={() => onDetails(c.index)}
              className="hoverline"
              title={`${dayTime(c.startIso)} → ${dayTime(c.isActive ? c.resetIso ?? c.endIso : c.raw.work_to_ts)} · ${duration(c.elapsedHours)} ${t("elapsed", "trwania")}`}
              style={{
                display: "grid",
                gridTemplateColumns: HISTORY_COLS,
                gap: 10,
                alignItems: "center",
                width: "100%",
                padding: "7px 6px",
                border: "none",
                borderBottom: "var(--rule)",
                background: c.index === selectedIndex ? "var(--accent-soft)" : "transparent",
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
                color: "var(--text)",
              }}
            >
              <span style={{ fontFamily: "var(--font-figure)", fontSize: "var(--fs-3)", fontWeight: c.isActive ? 600 : 400, color: c.isActive ? "var(--text)" : "var(--muted)" }}>
                 #{localizedNumber(c.number)}<br /><span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--fs-1)" }}>{cyclePlanDescription(c)}</span>
              </span>
              <span style={{ fontFamily: "var(--font-figure)", fontSize: "var(--fs-5)", fontWeight: 600, letterSpacing: "var(--ls-tight)", color: c.color }}>
                 {localizedNumber(c.usedPercent)}%
              </span>
              <span
                style={{
                  position: "relative",
                  display: "block",
                  height: 8,
                  background: "var(--sunk)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-bar)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(c.usedPercent / maxPercent) * 100}%`, background: "var(--accent)", display: "block" }}
                />
                {medianPercent != null && (
                  <span
                    title={t("median {0}%", "mediana " + localizedNumber(medianPercent) + "%", [localizedNumber(medianPercent)])}
                    style={{
                      position: "absolute",
                      left: `${(medianPercent / maxPercent) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      background: "var(--text)",
                      opacity: 0.55,
                      display: "block",
                    }}
                  />
                )}
              </span>
              <span style={{ fontFamily: "var(--font-figure)", fontSize: "var(--fs-2)", letterSpacing: "var(--ls-tight)", textAlign: "right", color: "var(--muted)", whiteSpace: "nowrap" }}>
                {c.raw.sample_count > 0 ? compact(c.tokensTotal) : "—"}
                <span style={{ color: "var(--faint)" }}> / {compact(c.calibration.allowanceTokens)}</span>
              </span>
              <span
                style={{
                  fontFamily: "var(--font-figure)",
                  fontSize: "var(--fs-2)",
                  letterSpacing: "var(--ls-tight)",
                  fontWeight: 600,
                  textAlign: "right",
                  color: dMed == null ? "var(--faint)" : dMed > 0 ? "var(--warn)" : "var(--ok)",
                }}
              >
                {signedPp(dMed, 1)}
              </span>
              <span style={{ fontFamily: "var(--font-figure)", fontSize: "var(--fs-2)", letterSpacing: "var(--ls-tight)", textAlign: "right", color: "var(--muted)" }}>
                {c.burnPerDay != null ? `${compact(c.burnPerDay)}/d` : "—"}
              </span>
              <span
                className="mono"
                title={c.topModel ?? undefined}
                style={{ fontSize: "var(--fs-3)", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {c.topModel ?? "—"}
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                {dayTime(c.startIso)} · {duration(c.elapsedHours)}
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-3)", textAlign: "right", color: "var(--muted)" }}>
                {c.isActive ? t("current", "bieżące") : windowResultLabel(windowResult(c.usedPercent, false, c.elapsedHours, c.windowHours))}
              </span>
            </TableGridRow>
          );
        })}
      </div></TableGrid>
    </div>
  );
}

/** The only addition to the Overview's window tables: a link to the whole archive in History. */
export function FullHistoryLink({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="mono" onClick={onOpen}
      style={{ background: "none", border: 0, padding: 0, font: "inherit", fontSize: "var(--fs-3)", fontWeight: 500, color: "var(--accent)", cursor: "pointer" }}>
      {t("Full history ({0} windows) →", `Cała historia (${localizedNumber(count)} okien) →`, [localizedNumber(count)])}
    </button>
  );
}
