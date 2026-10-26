import type { WindowPoolSeries } from "../lib/pool-series";
import { poolAmount, poolLabel } from "../lib/credit-pools-view";
import { compact, pct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { ChartUnit } from "../lib/window-units";

const ink = (index: number) => index % 2 === 0 ? "var(--violet)" : "var(--accent)";
const amount = (value: number, mode: ChartUnit) => mode === "pct" ? pct(value, value > 0 && value < 10 ? 1 : 0) : mode === "usd" ? usd(value)
  : mode === "credits" ? poolAmount(value, "credits") : compact(value);

/** Pool curves share the allowance plot, time axis and selected unit, each starting at zero. */
export function PoolUsageChart({ rows, mode, x, y, startMs, spanMs }: {
  rows: readonly WindowPoolSeries[]; mode: ChartUnit; x: (t: number) => number; y: (pct: number) => number; startMs: number; spanMs: number;
}) {
  const { t } = useI18n();
  return <g data-pool-usage-chart>
    {rows.map((row, index) => row.points.length > 0 && <g key={row.key} data-pool-series={row.pool.key} data-pool-basis={row.basis}>
      <polyline points={row.points.map(point => `${x((Date.parse(point.at) - startMs) / spanMs * 100).toFixed(1)},${y(point.pct).toFixed(1)}`).join(" ")}
        stroke={ink(index)} strokeWidth={1.75} strokeDasharray={row.basis === "funded" ? "5 4" : undefined} strokeLinejoin="round" fill="none" />
      {row.points.map((point, i) => <circle key={i} cx={x((Date.parse(point.at) - startMs) / spanMs * 100)} cy={y(point.pct)} r={5} fill="transparent">
        <title>{`${poolLabel(row.pool)} · ${row.pool.key} · ${row.basis === "observed" ? t("account readings", "odczyty konta") : t("funded calls valuation", "wycena wywołań z puli")} · ${row.partial ? "≥ " : ""}${row.estimate ? "≈ " : ""}${amount(point.value, mode)} · ${point.since} → ${point.at}`}</title>
      </circle>)}
    </g>)}
  </g>;
}

export function PoolUsageLegend({ rows, mode }: { rows: readonly WindowPoolSeries[]; mode: ChartUnit }) {
  const { t } = useI18n();
  return <>{rows.map((row, index) => <span key={row.key} style={{ color: ink(index) }} title={[
    row.pool.key,
    row.basis === "observed" ? t("Observed account spend; this does not identify which calls the pool funded.", "Zaobserwowany wydatek konta; nie określa, które wywołania opłacono z puli.")
      : t("Stored valuation of calls with known funding; not an account debit.", "Zapisana wycena wywołań ze znanym finansowaniem; nie jest obciążeniem konta."),
    row.estimate ? t("Window equivalent at this window's measured usage mix, using the value at 100% or counted usage divided by the current meter reading. Account dollars remain financial amounts, separate from API-eq.",
      "Ekwiwalent okna przy zmierzonym miksie jego użycia: wartość przy 100% lub policzone użycie podzielone przez bieżący odczyt licznika. Dolary konta pozostają kwotą finansową, oddzielną od API-eq.") : "",
    row.partial ? t("partial data", "częściowe dane") : "",
  ].filter(Boolean).join(" · ")}>
    <i style={{ display: "inline-block", width: 18, verticalAlign: "middle", marginRight: 6, borderTop: `2px ${row.basis === "funded" ? "dashed" : "solid"} ${ink(index)}` }} />
    {poolLabel(row.pool)} · {row.basis === "observed" ? t("account readings", "odczyty konta") : t("funded calls valuation", "wycena wywołań z puli")}
    {" · "}{row.value == null ? row.unavailable === "history" ? t("Timeline unavailable", "Historia niedostępna") : t("no conversion basis", "brak podstawy przeliczenia")
      : `${row.partial ? "≥ " : ""}${row.estimate ? "≈ " : ""}${amount(row.value, mode)}`}
    {(mode !== row.unit || row.value == null) && <> · {poolAmount(row.nativeValue, row.unit)}</>}
  </span>)}</>;
}
