import type { ClaudeLimitResponse, ClaudeModelCost } from "../lib/api";
import { compact, dayTime, full, pct, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { TableRow, Card, CardTitle, EmptyState, EstimateTag, KpiStrip, Pill, Table, Td, Th, type KpiSpec, type Tone } from "./ui";
import { subscriptionPlan } from "../lib/subscription-plan";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorState } from "./ui";

/** Mounted by the existing calibration tab; other tabs only need the small card. */
export function ClaudeCalibrationHistoryCard({ data, account, bounds }: {
  data: ClaudeLimitResponse; account: string; bounds?: { from: string; until: string } | null;
}) {
  const state = useAsync<ClaudeLimitResponse>(signal => api.claudeLimit(account,bounds,signal), [account,bounds?.from,bounds?.until]);
  return state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : <ClaudeCalibrationCard data={state.data ?? data} showModels />;
}
const CONFIDENCE_TONE: Record<string, Tone> = {
  high: "ok",
  medium: "accent",
  low: "warn",
  none: "crit",
};
function confidenceLabel(confidence: string, t: (en: string, pl: string) => string): string {
  return ({
    high: t("high confidence", "wysoka pewność"),
    medium: t("medium confidence", "średnia pewność"),
    low: t("low confidence", "niska pewność"),
    none: t("no calibration", "brak kalibracji"),
  } as Record<string, string>)[confidence] ?? confidence;
}
function modelTone(m: ClaudeModelCost): string {
  if (!m.observed) return "var(--faint)";
  if (m.low_sample) return "var(--muted)";
  return "var(--text)";
}
function TokensPerPoint({ model }: { model: ClaudeModelCost }) {
  if (model.gross_tokens_per_point == null) return <span style={{ color: "var(--faint)" }}>—</span>;
  return (
    <span style={{ color: modelTone(model) }}>
      {compact(model.gross_tokens_per_point)}
    </span>
  );
}
function ageLabel(minutes: number): string {
  if (minutes < 1) return translate("just now", "przed chwilą");
  if (minutes < 90) return `${Math.round(minutes)} ${translate("min ago", "min temu")}`;
  return `${Math.round(minutes / 60)} ${translate("h ago", "h temu")}`;
}
function Gauge({
  label,
  measured,
  est,
}: {
  label: string;
  measured: number | null;
  est: number | null;
}) {
  const { t } = useI18n();
  const shown = measured ?? est;
  const gap = measured != null && est != null ? est - measured : null;
  return (
    <span className="mono" style={{ fontSize: "var(--fs-4)" }}>
      {label}{" "}
      <strong style={{ fontSize: "var(--fs-5)", fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)" }}>{shown != null ? pct(shown, measured != null ? 0 : 1) : "—"}</strong>
      {gap != null && Math.abs(gap) >= 0.5 && (
        <span style={{ color: "var(--muted)" }} title={t("What the index counts - the difference is usage missed by the total, or a stale point cost.", "Co liczy indeks — różnica to zużycie, którego suma nie widzi, albo nieaktualny koszt punktu.")}>
          {` (${t("index", "indeks")} ${pct(est as number, 1)})`}
        </span>
      )}
    </span>
  );
}
interface ClaudeCalibrationCardProps {
  data: ClaudeLimitResponse;
  showCalibration?: boolean;
  showModels?: boolean;
}
export function ClaudeModelsCard({ data }: { data: ClaudeLimitResponse }) {
  return <Card><div style={{ marginTop: 0 }}><ClaudeModelsTable data={data} /></div></Card>;
}
export function ClaudeCalibrationCard({
  data,
  showCalibration = true,
  showModels = false,
}: ClaudeCalibrationCardProps) {
  const { t } = useI18n();
  const cal = data.calibration;
  const cur = data.current;
  if (!cal) {
    if (!showCalibration) return null;
    return (
      <Card>
        <CardTitle title={t("Cost per 1% of week (Claude)", "Koszt 1% tygodnia (Claude)")} sub={t("declared ceiling - no usable reading", "deklarowany pułap — brak użytecznego odczytu")} />
        <EmptyState
          title={t("No calibration", "Brak kalibracji")}
          detail={t("claude-gauge.json contains observations, but none provides an “All models” reading.", "claude-gauge.json ma obserwacje, ale żadna nie niesie odczytu „All models”.")}
        />
      </Card>
    );
  }
  const tone = CONFIDENCE_TONE[cal.confidence] ?? "neutral";
  const agreement = cal.agreement_ratio;
  const tiles: KpiSpec[] = [
    { label: t("1 point =", "1 punkt ="), value: usd(cal.usd_per_point), note: t("API list prices", "ceny listowe API") },
    {
      label: t("whole window", "całe okno"), value: usd(cal.window_value_usd),
      note: cal.fable_window_value_usd != null ? `${t("including Fable", "w tym Fable")} ${usd(cal.fable_window_value_usd)}` : t("Fable sub-limit unknown", "sub-limit Fable nieznany"),
    },
    {
      label: t("bar agreement", "zgodność słupków"), value: agreement != null ? pct(agreement * 100, 1) : "—",
      color: agreement != null && Math.abs(agreement - 1) <= 0.05 ? "var(--ok)" : "var(--warn)",
      note: cal.usd_per_point_fable != null && cal.usd_per_point_rest != null
        ? `Fable ${usd(cal.usd_per_point_fable)} ${t("vs rest", "vs reszta")} ${usd(cal.usd_per_point_rest)}`
        : t("no second bar", "brak drugiego słupka"),
    },
    ...(cal.boost_ends ? [{
      label: t("after boost", "po booście"), value: usd(cal.usd_per_point_unboosted), color: "var(--warn)",
      note: `${t("limit", "limit")} x${cal.boost_factor} ${t("until", "do")} ${cal.boost_ends}`,
    }] : []),
  ];
  return (
    <Card>
      {showCalibration && <>
      <CardTitle
        title={t("Cost per 1% of week (Claude)", "Koszt 1% tygodnia (Claude)")}
        sub={`${subscriptionPlan("claude", data.plan, cal.source_ts) ?? t("unknown plan", "plan nieznany")} · ${t("window", "okno")} ${Math.round(data.window_hours)} h · ${t("reading", "odczyt")} ${dayTime(cal.source_ts)}`}
        right={
          <Pill tone={tone} dot>
            {confidenceLabel(cal.confidence, t)}
          </Pill>
        }
      />
      <div style={{ marginTop: "var(--s-6)" }}><KpiStrip items={tiles} /></div>
      <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-4)" }}>{cal.reason}</div>
      {cur && (
        <section
          style={{
            marginTop: "var(--s-6)",
            padding: "var(--s-5) var(--s-6)",
            borderRadius: "var(--r-chip)",
            background: "var(--sunk)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s-5)", flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)" }}>
              {t("Current window", "Bieżące okno")} · {t("reset", "reset")} {dayTime(cur.reset_at)}
            </span>
            <span style={{ display: "inline-flex", gap: "var(--s-4)", alignItems: "center" }}>
              {cur.percent_all_measured != null ? (
                <Pill tone="ok" dot>
                  {`${t("from account", "z konta")}${cur.measured_age_minutes != null ? ` · ${ageLabel(cur.measured_age_minutes)}` : ""}`}
                </Pill>
              ) : (
                <EstimateTag title={t("The account did not respond - percentage calculated from point cost, not measured.", "Konto nie odpowiedziało — procent policzony z kosztu punktu, nie odczytany.")}>
                  {t("estimate", "szacunek")}
                </EstimateTag>
              )}
              <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                {t("elapsed", "upłynęło")} {pct(cur.elapsed_percent, 1)}
              </span>
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: "var(--s-4)" }}>
            <Gauge label={t("All models", "Wszystkie modele")} measured={cur.percent_all_measured} est={cur.percent_all_est} />
            <Gauge label="Fable" measured={cur.percent_fable_measured} est={cur.percent_fable_est} />
            {data.probe?.session_percent != null && (
              <span className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>
                {t("session", "sesja")}{" "}
                <strong style={{ color: "var(--text)", fontSize: "var(--fs-5)", fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)" }}>{pct(data.probe.session_percent, 0)}</strong>
                {data.probe.session_resets_at ? ` · ${t("reset", "reset")} ${dayTime(data.probe.session_resets_at)}` : ""}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: "var(--s-3)" }}>
            <span className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>
              {t("remaining", "zostało")} {cur.remaining_usd != null ? usd(cur.remaining_usd) : "—"} · {full(cur.spend.calls)} {t("calls", "wywołań")} ·{" "}
              {usd(cur.spend.usd)} {t("in index", "w indeksie")}
            </span>
            {cur.projected_end_percent != null && (
              <span className="mono" style={{ fontSize: "var(--fs-4)", color: cur.projected_end_percent > 100 ? "var(--crit)" : "var(--muted)" }}>
                {t("forecast at reset", "prognoza na reset")} {pct(cur.projected_end_percent, 0)}
              </span>
            )}
          </div>
        </section>
      )}
      {data.observations.length > 0 && (
        <section style={{ marginTop: "var(--s-7)", paddingTop: "var(--s-6)", borderTop: "var(--rule)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s-5)" }}>
            <span style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)" }}>
              {t("Calibration observations", "Obserwacje kalibracyjne")}
            </span>
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {data.observations.length} {t("readings", "odczytów")}
            </span>
          </div>
          <div style={{ marginTop: "var(--s-4)" }}>
            <Table tableId="ClaudeLimitPanel:0">
              <thead>
                <TableRow header>
                  <Th columnId="c0">{t("reading", "odczyt")}</Th>
                  <Th columnId="c1">{t("source", "źródło")}</Th>
                  <Th columnId="c2" align="right">{t("All models", "Wszystkie modele")}</Th>
                  <Th columnId="c3" align="right">Fable</Th>
                  <Th columnId="c4" align="right">{t("spent", "wydano")}</Th>
                  <Th columnId="c5" align="right">$/{t("point", "punkt")}</Th>
                </TableRow>
              </thead>
              <tbody>
                {data.observations.map((observation) => (
                  <TableRow key={`${observation.ts}:${observation.reset_ts}`}>
                    <Td mono title={`${t("Measured through", "Zmierzono do")} ${dayTime(observation.measured_through)} · ${t("reset", "reset")} ${dayTime(observation.reset_ts)}`}>
                      {dayTime(observation.ts)}
                    </Td>
                    <Td>
                      <span className="mono" style={{ color: "var(--muted)" }} title={observation.note}>
                        {observation.basis === "probe" ? t("account", "konto") : observation.source ?? t("manual", "ręcznie")}
                      </span>
                    </Td>
                    <Td mono align="right">{observation.percent_all != null ? pct(observation.percent_all) : "—"}</Td>
                    <Td mono align="right">{observation.percent_fable != null ? pct(observation.percent_fable) : "—"}</Td>
                    <Td mono align="right">{usd(observation.spend.usd)}</Td>
                    <Td mono align="right">{observation.usd_per_point != null ? usd(observation.usd_per_point) : "—"}</Td>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </div>
        </section>
      )}
      </>}
      {showModels && <div style={{ marginTop: showCalibration ? "var(--s-7)" : 0 }}>
        <ClaudeModelsTable data={data} />
      </div>}
    </Card>
  );
}

function modelExplanation(model: ClaudeModelCost, data: ClaudeLimitResponse): string {
  const result = data.claude_capacity;
  if (!result) return "";
  const interval = result.sample ? `${result.sample.from} – ${result.sample.through}` : "";
  return [translate("Conditional model equivalent weighted by API cost; not a provider-confirmed model allowance.",
    "Warunkowy ekwiwalent modelu ważony kosztem API; nie jest potwierdzonym limitem dostawcy dla tego modelu."),
    result.api_value_basis === "standard" ? "API Standard" : "API actual",
    interval, model.absent ? translate("Unavailable: {0}", `Brak wyniku: ${model.absent}`, [model.absent]) : null,
    result.price_reference_model ? translate("Price/token relative to {0}, using the observed cache mix.",
      `Cena/token względem ${result.price_reference_model}, przy zaobserwowanym miksie cache.`, [result.price_reference_model]) : null].filter(Boolean).join(" · ");
}

function ClaudeModelsTable({ data }: { data: ClaudeLimitResponse }) {
  const { t } = useI18n();
  const models = data.claude_capacity?.models ?? data.models;
  const measured = models.filter(model => model.observed), scaled = models.filter(model => !model.observed);
  return (
        <Table tableId="ClaudeLimitPanel:1">
          <thead>
            <TableRow header>
              <Th columnId="c0">{t("model", "model")}</Th>
              <Th columnId="c1" align="right">{t("price/token", "cena/token")}</Th>
              <Th columnId="c2" align="right">{t("1% = gross tokens", "1% = tokenów brutto")}</Th>
              <Th columnId="c3" align="right">{t("1% = fresh tokens", "1% = świeżych")}</Th>
              <Th columnId="c4" align="right">{t("1% = calls", "1% = wywołań")}</Th>
              <Th columnId="c5" align="right">{t("$/1M gross", "$/1M brutto")}</Th>
              <Th columnId="c6" align="right">{t("share of window", "udział w oknie")}</Th>
            </TableRow>
          </thead>
          <tbody>
            {[...measured, ...scaled].map((m) => (
              <TableRow key={m.model} title={modelExplanation(m, data)}>
                <Td mono style={{ color: modelTone(m) }}>
                  {m.model}
                  {!m.observed && (
                    <span style={{ marginLeft: 8 }}>
                      <EstimateTag title={t("The model did not run in the calibrated window - value scaled by list price with a typical cache mix.", "Model nie pracował w kalibrowanym oknie — liczba przeskalowana ceną listową przy typowym miksie cache.")}>
                        {t("from list price", "z cennika")}
                      </EstimateTag>
                    </span>
                  )}
                  {m.observed && m.low_sample && (
                    <span style={{ marginLeft: 8 }}>
                      <EstimateTag title={t("Too little traffic in the window: the cache mix of a few calls is not a weekly mix.", "Za mało ruchu w oknie: miks cache kilku wywołań nie jest miksem tygodnia.")}>
                        {t("small sample", "mała próba")}
                      </EstimateTag>
                    </span>
                  )}
                </Td>
                <Td mono align="right" style={{ color: "var(--muted)" }}>
                  {m.price_index != null ? `${m.price_index.toLocaleString(getLocale(), { maximumFractionDigits: 3 })}x` : "—"}
                </Td>
                <Td mono align="right">
                  <TokensPerPoint model={m} />
                </Td>
                <Td mono align="right" style={{ color: "var(--muted)" }}>
                  {m.fresh_tokens_per_point != null ? compact(m.fresh_tokens_per_point) : "—"}
                </Td>
                <Td mono align="right" style={{ color: "var(--muted)" }}>
                  {m.calls_per_point != null ? full(Math.round(m.calls_per_point)) : "—"}
                </Td>
                <Td mono align="right" style={{ color: "var(--muted)" }}>
                  {m.usd_per_1m_gross != null ? usd(m.usd_per_1m_gross) : "—"}
                </Td>
                <Td mono align="right" style={{ color: m.share_of_points != null ? "var(--text)" : "var(--faint)" }}>
                  {m.share_of_points != null ? pct(m.share_of_points, 1) : "—"}
                </Td>
              </TableRow>
            ))}
          </tbody>
        </Table>
  );
}
