import type { AtlasModel, CycleView } from "../lib/cycle";
import { compact, dayTime, duration, full, pct, signedPct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Eyebrow, EstimateTag, GhostButton, Pill } from "./ui";
function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, fontSize: "var(--fs-4)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="mono" style={{ fontWeight: 600, color: tone ?? "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}
// Drawer sections are divided by dashed rules, not boxes.
const SECTION = { display: "flex", flexDirection: "column", gap: 7, paddingTop: 14, borderTop: "var(--rule)" } as const;
export function CycleDrawer({
  cycle,
  model,
  onClose,
  onOpen,
  onEvents,
}: {
  cycle: CycleView;
  model: AtlasModel;
  onClose: () => void;
  onOpen: (index: number) => void;
  /** History only: opens Usage events for this cycle's subscription and dates (UI audit decision 2). */
  onEvents?: () => void;
}) {
  const { t } = useI18n();
  const medianTokens = model.median.tokens;
  const vsMedian = medianTokens && medianTokens > 0 ? (cycle.tokensTotal / medianTokens - 1) * 100 : null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 30, background: "color-mix(in oklab, var(--bg) 72%, transparent)", display: "flex", justifyContent: "flex-end" }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(380px, 92vw)",
          height: "100%",
          background: "var(--surface)",
          border: "1px solid var(--pencil)",
          borderRight: 0,
          borderRadius: "var(--r-card)",
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--pencil)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <Eyebrow>{cycle.isActive ? t("active cycle", "aktywny cykl") : t("closed cycle", "cykl zamknięty")}</Eyebrow>
            <div className="ui-display" style={{ fontSize: "var(--fs-card-title)", lineHeight: 1.2, marginTop: 2 }}>{cycle.label}</div>
            <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: 2 }}>
              {dayTime(cycle.startIso)} → {dayTime(cycle.endIso)}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("Close cycle details", "Zamknij szczegóły cyklu")}
            className="hovertext"
            style={{ background: "transparent", border: "none", color: "var(--muted)", fontSize: "var(--fs-6)", cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className="ui-figure" style={{ fontSize: "var(--fs-9)", lineHeight: 1, color: cycle.color }}>
              {cycle.usedPercent.toFixed(0)}
              <span style={{ fontSize: "var(--fs-7)", color: "var(--muted)" }}>%</span>
            </div>
            <div>
              <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginBottom: 2 }}>{t("allowance used", "wykorzystany limit")}</div>
              <Pill tone={cycle.usedPercent >= 100 ? "crit" : cycle.usedPercent >= 90 ? "warn" : "neutral"}>
                {cycle.resultLabel}
              </Pill>
            </div>
          </div>
          <div style={SECTION}>
            <Eyebrow>{t("work in cycle", "praca w cyklu")}</Eyebrow>
            <Row label={t("Tokens", "Tokeny")} value={compact(cycle.tokensTotal)} />
            <Row label={t("Calls", "Wywołania")} value={full(cycle.calls)} />
            <Row label={t("API equivalent cost", "Koszt API-equivalent")} value={usd(cycle.usd)} />
              <Row label={t("Top model", "Główny model")} value={cycle.topModel ?? "—"} />
            {vsMedian != null && (
              <Row
                label={t("vs cycle median", "vs mediana cykli")}
                value={signedPct(vsMedian)}
                tone={vsMedian > 0 ? "var(--warn)" : "var(--ok)"}
              />
            )}
          </div>
          <div style={SECTION}>
            <Eyebrow>{t("time", "czas")}</Eyebrow>
            <Row label={t("Window length", "Długość okna")} value={duration(cycle.windowHours)} />
            <Row label={t("Elapsed", "Upłynęło")} value={`${duration(cycle.elapsedHours)} · ${pct(cycle.elapsedPercent)}`} />
            {cycle.remainingHours != null && <Row label={t("Until reset", "Do resetu")} value={duration(cycle.remainingHours)} />}
            <Row label={t("Burn", "Dzienne zużycie")} value={cycle.burnPerDay != null ? `${compact(cycle.burnPerDay)}/d` : "—"} />
          </div>
          <div style={SECTION}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Eyebrow>{t("observed allowance", "obserwowany limit")}</Eyebrow>
              <EstimateTag title={cycle.calibration.reason}>{cycle.calibration.confidence}</EstimateTag>
            </div>
            {cycle.calibration.allowanceTokens != null ? (
              <>
                <Row label={t("Allowance", "Limit")} value={compact(cycle.calibration.allowanceTokens)} />
                <Row label={t("Tokens per 1 pp", "Tokeny na 1 pp")} value={compact(cycle.calibration.tokensPerPercent)} />
              </>
            ) : (
              <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
                {t("Calibration unavailable", "Kalibracja niedostępna")}: {cycle.calibration.reason}.
              </div>
            )}
          </div>
          <div style={SECTION}>
            <Eyebrow>{t("models in cycle", "modele w cyklu")}</Eyebrow>
            {cycle.raw.source_models.slice(0, 6).map((m) => (
              <Row key={m.model} label={m.model} value={full(m.calls)} />
            ))}
            {cycle.raw.source_models.length === 0 && (
              <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                {t("No assigned sessions.", "Brak przypisanych sesji.")}
              </div>
            )}
          </div>
          {onEvents && <GhostButton onClick={onEvents}>{t("Events for this window", "Zdarzenia tego okna")} →</GhostButton>}
          <GhostButton onClick={() => onOpen(cycle.index)}>{t("Show this window in Overview", "Pokaż to okno w Przeglądzie")} →</GhostButton>
        </div>
      </aside>
    </div>
  );
}
