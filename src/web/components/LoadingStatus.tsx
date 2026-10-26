import { createContext, useContext, useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";

export const LoadingScope = createContext("");

/** Loading that has lasted this long names its elapsed time; shorter waits stay quiet. */
const SLOW_AFTER_SECONDS = 3;
/** Past this the line adds that the server is still preparing the data. */
const LONG_AFTER_SECONDS = 20;

export function LoadingStatus({ label }: { label: string }) {
  const scope = useContext(LoadingScope);
  return <PendingStatus key={`${scope}:${label}`} label={label} />;
}

function useSecondsSince(startedAt: number): number {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** A new selection or stage gets its own elapsed time, even while still loading. */
function PendingStatus({ label }: { label: string }) {
  const { t } = useI18n();
  const [startedAt] = useState(() => Date.now());
  const seconds = useSecondsSince(startedAt);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <div className="ui-loading-status" aria-busy="true">
    {/* Indeterminate: no value, since no loader here knows how much is left. */}
    <span className="ui-loading-spinner" role="progressbar" aria-label={label} />
    <span role="status" className="ui-loading-label">{label}</span>
    {seconds >= SLOW_AFTER_SECONDS && <span className="mono ui-loading-elapsed">{t("Elapsed", "Upłynęło")}: {elapsed}</span>}
    {seconds >= LONG_AFTER_SECONDS && <span className="ui-loading-hint">{t("The server is still preparing this data; the view fills in by itself.", "Serwer wciąż przygotowuje te dane; widok uzupełni się sam.")}</span>}
  </div>;
}

// Fixed, not random, so a re-render does not make the placeholder jump.
const BAR_HEIGHTS = [38, 54, 46, 70, 62, 48, 80, 66, 58, 74, 52, 44, 60, 72, 56, 40, 64, 50];
const CELL_WIDTHS = ["72%", "48%", "56%", "38%"];

/** Bars need a definite height: a panel's minimum height alone does not give them one. */
function ChartSkeleton({ height }: { height: number }) {
  return <div className="ui-skel-block ui-skel-chart" aria-hidden="true" style={{ height: Math.max(72, height) }}>
    {BAR_HEIGHTS.map((value, index) => <span key={index} className="ui-skel" style={{ height: `${value}%` }} />)}
  </div>;
}

export type LoadingShape = "lines" | "kpi" | "chart" | "table";

/**
 * Placeholder in the shape of the content that will replace it: headline tiles, a chart, table
 * rows or text lines. Purely decorative; the status line carries the accessible state.
 */
export function LoadingSkeleton({ shape, height = 0 }: { shape: LoadingShape; height?: number }) {
  if (shape === "kpi") return <div className="ui-skel-block" aria-hidden="true">
    <div className="ui-skel-kpis">
      {[0, 1, 2].map(index => <div key={index} className="ui-skel-kpi">
        <span className="ui-skel" style={{ width: "46%", height: 8 }} />
        <span className="ui-skel" style={{ width: index === 1 ? "62%" : "50%", height: 24, marginTop: 8 }} />
        <span className="ui-skel" style={{ width: "100%", height: 6, marginTop: 12 }} />
        <span className="ui-skel" style={{ width: "74%", height: 8, marginTop: 10 }} />
      </div>)}
    </div>
    {height > 220 && <ChartSkeleton height={height - 200} />}
  </div>;
  if (shape === "chart") return <ChartSkeleton height={height - 72} />;
  if (shape === "table") {
    const rows = Math.max(2, Math.min(12, Math.floor((height - 64) / 30)));
    return <div className="ui-skel-block ui-skel-table" aria-hidden="true">
      <div className="ui-skel-row is-head">{CELL_WIDTHS.map((_, index) => <span key={index} className="ui-skel" style={{ width: "40%" }} />)}</div>
      {Array.from({ length: rows }, (_, row) => <div key={row} className="ui-skel-row" style={{ opacity: Math.max(0.35, 1 - row * 0.08) }}>
        {CELL_WIDTHS.map((width, index) => <span key={index} className="ui-skel" style={{ width: CELL_WIDTHS[(index + row) % CELL_WIDTHS.length] ?? width }} />)}
      </div>)}
    </div>;
  }
  return <div className="ui-skel-block ui-skel-lines" aria-hidden="true">
    {["68%", "52%", "36%"].map(width => <span key={width} className="ui-skel" style={{ width }} />)}
  </div>;
}
