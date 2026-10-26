import { useI18n } from "../../lib/i18n";
import { compact, duration } from "../../lib/format";
import { formatMoney } from "../../lib/mixFormat";
import { EstimateTag } from "../ui";
import { hours, MASK } from "./format";
import { formatPct, type ProjectMixModel } from "./mix-chart-model";

export function ProjectMixHover({ hover, hideValues, idleGap }: {
  hover: ProjectMixModel["hover"];
  hideValues: boolean;
  idleGap: number;
}) {
  const { t } = useI18n();
  const hoveredPoint = hover?.point ?? null;
  const hoveredUncovered = hover?.uncovered ?? [];
  const measureLabel = hover?.measureLabel;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ minWidth: 0 }}>
        {hoveredPoint ? (
          <div
            className="mono"
            style={{
              fontSize: "var(--fs-3)",
              padding: "var(--s-2) var(--s-4)",
              background: "var(--sunk)",
              borderRadius: "var(--r-chip)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{hoveredPoint.bucket}</span>
            {hideValues ? (
              <span style={{ color: "var(--faint)" }}>{t("values hidden", "liczby ukryte")}</span>
            ) : (
              <>
                <span>
                  {measureLabel}: <strong>{formatMoney(hover!.amount)}</strong>
                  {hover!.incomplete && (
                    <span data-billed-incomplete="" style={{ color: "var(--warn)", marginLeft: 6 }}>
                      {t("incomplete", "niepełne")}
                    </span>
                  )}
                  {hoveredUncovered.length > 0 && (
                    <span data-uncovered="" style={{ color: "var(--muted)", marginLeft: 6 }}>
                      {t("no data", "brak danych")}
                    </span>
                  )}
                </span>
                <span style={{ color: "var(--warn)" }} title={`${t("Estimated active time", "Szacowany czas aktywny")} (${t("threshold", "próg")} ${idleGap} min)`}>
                  {t("Time", "Czas")}: <strong>≈ {duration(hours(hoveredPoint.active_seconds))}</strong>
                  <span style={{ fontSize: "var(--fs-2)", color: "var(--faint)", marginLeft: 3 }}>({idleGap}m)</span>
                </span>
                <span style={{ color: "var(--faint)" }}>{compact(hoveredPoint.tokens)} {t("tokens", "tok")}</span>
              </>
            )}
          </div>
        ) : (
          <div style={{ height: 26 }} />
        )}
      </div>
    </div>
  );
}

export function ProjectMixLegend({ legend, hideValues, idleGap, colorOf }: {
  legend: ProjectMixModel["legend"];
  hideValues: boolean;
  idleGap: number;
  colorOf: (id: string) => string;
}) {
  const { t } = useI18n();
  const { pctMode, totalsIncomplete, anyUncovered } = legend;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 14px",
        marginTop: "var(--s-5)",
        paddingTop: "var(--s-4)",
        borderTop: "var(--rule)",
        fontSize: "var(--fs-3)",
      }}
    >
      {legend.rows.map(({ id: k, name, amount, uncovered, unit, capacity, peakPct }) => (
        <div key={k} data-legend-sub={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "var(--r-bar)",
              background: colorOf(k),
              display: "inline-block",
              outline:
                amount == null
                  ? "1px dashed var(--warn)"
                  : uncovered
                    ? "1px dotted var(--faint)"
                    : undefined,
            }}
          />
          <span style={{ color: "var(--text)" }}>{name}</span>
          {pctMode ? (
            capacity == null ? (
              <EstimateTag title={unit?.note || t("Window capacity calibration unavailable", "Brak kalibracji pojemności okna")}>{t("no measurement", "brak pomiaru")}</EstimateTag>
            ) : (
              <>
                <span className="mono" style={{ color: "var(--faint)" }} title={t("Highest share of one window in a single period", "Największa część jednego okna w jednym okresie")}>
                  {hideValues ? MASK : `${t("peak", "szczyt")} ${formatPct(peakPct!)}`}
                </span>
                {capacity!.basis === "single" && <EstimateTag title={unit?.note}>{t("1 reading", "1 odczyt")}</EstimateTag>}
              </>
            )
          ) : (
            <span className="mono" style={{ color: "var(--faint)" }}>
              {hideValues ? MASK : formatMoney(amount)}
            </span>
          )}
        </div>
      ))}
      {totalsIncomplete && (
        <span data-billed-incomplete="" className="mono" style={{ color: "var(--warn)" }}>
          {t("incomplete", "niepełne")}
        </span>
      )}
      {anyUncovered && (
        <span data-uncovered="" className="mono" style={{ color: "var(--muted)" }}>
          {t("no data", "brak danych")}
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{
            width: 12,
            height: 2,
            background: "var(--warn)",
            display: "inline-block",
          }}
        />
        <span style={{ color: "var(--warn)" }}>{t("active time", "czas aktywny")} ≈</span>
        <span className="mono" style={{ color: "var(--faint)" }}>
          ({t("own scale", "własna skala")}, {t("threshold", "próg")} {idleGap}m)
        </span>
      </div>
    </div>
  );
}
