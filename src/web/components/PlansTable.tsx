import { Fragment, useState } from "react";
import type {
  CalibrationStatus,
  PlanCapacityAbsentReason,
  PlanCapacityResult,
  PlanLimits,
  PlanQuantity,
  PlanTokenQuantities,
  PrimarySource,
} from "../lib/api";
import { PLAN_TOKEN_TYPES } from "../lib/api";
import { compact, usd } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { TableRow, Card, EmptyState, EstimateTag, Pill, Table, Td, Th, type Tone } from "./ui";
export interface PlanTableVersion {
  version_id: string;
  from: string | null;
  usd_per_month: number | null;
  limits: PlanLimits | null;
  source: string | null;
  note: string | null;
  window_kind: string | null;
  kind_absent_reason?: string | null;
  capacity: PlanCapacityResult | null;
}
export interface PlanTableRow {
  plan_id: string;
  label: string;
  provider_group: string;
  provider_label: string;
  active_version_id: string | null;
  active_from: string | null;
  usd_per_month: number | null;
  limits: PlanLimits | null;
  window_kind: string | null;
  kind_absent_reason?: string | null;
  capacity: PlanCapacityResult | null;
  versions: PlanTableVersion[];
  no_version_reason?: string | null;
}
const CAL_TONE: Record<CalibrationStatus, Tone> = {
  none: "neutral",
  working: "warn",
  reliable: "ok",
};
const COLS = 10;
function calibrationLabel(status: CalibrationStatus): string {
  if (status === "working") return translate("working", "robocza");
  if (status === "reliable") return translate("reliable", "wiarygodna");
  return translate("no data", "brak danych");
}
function sourceLabel(source: PrimarySource): string {
  if (source === "local_calibration") return translate("local", "lokalna");
  if (source === "default_reference") return translate("reference", "referencja");
  return "—";
}
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  switch (reason) {
    case "no_accepted_windows": return translate("no accepted windows", "brak zaakceptowanych okien");
    case "insufficient_windows": return translate("too few independent windows", "za mało niezależnych okien");
    case "cadence_span_short": return translate("cadence span too short", "za krótki zakres rytmu");
    case "inconsistent_gt_10pct": return translate("spread above 10%", "rozrzut powyżej 10%");
    case "missing_counter": return translate("counter missing", "brak licznika");
    case "missing_rate": return translate("rate missing", "brak stawki");
    case "no_reference": return translate("reference missing", "brak referencji");
    case "cross_version_unattributable": return translate("window crosses versions", "okno przecina wersje");
    case "duplicate_window": return translate("duplicate window", "duplikat okna");
    case "first_gate_rejected": return translate("rejected by quality gate", "odrzucone przez bramę jakości");
    case "unknown_provider": return translate("unknown provider", "nieznany dostawca");
    case "unknown_plan": return translate("unknown plan", "nieznany plan");
    case "no_version_for_day": return translate("no version for this day", "brak wersji na ten dzień");
    case "current_usage_unknown": return translate("current usage unavailable", "brak bieżącego zużycia");
    case "missing_price": return translate("price missing", "brak ceny");
    case "zero_tokens": return translate("zero vector", "wektor zerowy");
    case "mixed_cadence": return translate("mixed cadence", "mieszany rytm");
    case "no_match": return translate("not matched to catalog", "nie pasuje do katalogu");
    case "ambiguous_match": return translate("ambiguous plan", "niejednoznaczny plan");
    case "unknown_provider_alias": return translate("unknown provider alias", "nieznany alias dostawcy");
    case "unknown_window_kind": return translate("window cadence not declared", "brak zadeklarowanego rytmu okna");
    case "gap": return translate("gap", "luka");
    case "plan_period_gap": return translate("no plan in account periods", "brak planu w okresach kont");
    case "plan_gap": return translate("gap between plan periods", "luka między okresami planu");
    case "outside_plan_periods": return translate("outside plan periods", "poza okresami planu");
    case "unassigned": return translate("unassigned", "nieprzypisana");
    case "no_plan": return translate("no subscription, no limits", "brak abonamentu, brak limitów");
    default: {
      const fallback = reason.replace(/_/g, " ");
      return translate(fallback, fallback);
    }
  }
}
export function dash(reason?: string | null): { text: "—"; title: string | undefined } {
  const label = reasonLabel(reason);
  return { text: "—", title: label || undefined };
}
function moneyText(q: PlanQuantity | null | undefined): { text: string; title: string | undefined } {
  if (!q) return dash("missing_rate");
  if (q.absent != null) return dash(q.absent);
  return { text: usd(q.value), title: usd(q.value) };
}
function monthlyText(n: number | null | undefined): { text: string; title: string | undefined } {
  if (n == null) return { text: "—", title: translate("price unverified, not free", "cena niezweryfikowana, nie darmowa") };
  return { text: usd(n), title: `${usd(n)} / ${translate("month", "miesiąc")}` };
}
function limitLabel(key: string): string {
  switch (key) {
    case "window_hours": return translate("window hours", "godziny okna");
    case "weekly_cap": return translate("weekly cap", "limit tygodniowy");
    default: {
      const fallback = key.replace(/_/g, " ");
      return translate(fallback, fallback);
    }
  }
}
function limitsLine(limits: PlanLimits | null | undefined): string {
  if (!limits) return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(limits)) {
    if (v == null || v === false) continue;
    if (v === true) parts.push(limitLabel(k));
    else parts.push(`${limitLabel(k)} ${v}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}
function profileLine(profile: PlanTokenQuantities | null | undefined): { text: string; title: string | undefined } {
  if (!profile) return dash("missing_counter");
  const bits: string[] = [];
  let firstAbsent: PlanCapacityAbsentReason | null = null;
  for (const t of PLAN_TOKEN_TYPES) {
    const q = profile[t];
    if (!q || q.absent != null) {
      firstAbsent ??= q?.absent ?? "missing_counter";
      continue;
    }
    bits.push(`${shortType(t)} ${(q.value * 100).toFixed(0)}%`);
  }
  if (bits.length === 0) return dash(firstAbsent);
  return { text: bits.join(" · "), title: bits.join(" · ") };
}
function shortType(t: string): string {
  switch (t) {
    case "in_uncached":
      return "in";
    case "in_cache_read":
      return "cache r";
    case "in_cache_write_5m":
      return "w5m";
    case "in_cache_write_1h":
      return "w1h";
    case "out_total":
      return "out";
    default:
      return t;
  }
}
function Absent({ reason, children }: { reason?: string | null; children?: string }) {
  useI18n();
  const d = dash(reason);
  return (
    <span title={d.title} style={{ color: "var(--faint)" }}>
      {children ?? d.text}
      {d.title ? <span style={{ marginLeft: 6, fontWeight: 400 }}>{d.title}</span> : null}
    </span>
  );
}
export interface PlansTableProps {
  rows: PlanTableRow[];
  asOf: string;
  expandedIds?: string[];
  onEditPlan?: (planId: string, versionId?: string) => void;
}
export function PlansTable({
  rows,
  asOf,
  expandedIds,
  onEditPlan,
}: PlansTableProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Set<string>>(() => new Set(expandedIds ?? []));
  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t("No plans in this group", "Brak Planów w tej grupie")}
        detail={t("The provider catalog has no offer for the selected filter. Change the group or add a plan to the catalog.", "Katalog dostawców nie ma oferty dla wybranego filtra. Zmień grupę albo dopisz Plan w katalogu.")}
      />
    );
  }
  return (
    <Card pad="0">
      <Table tableId="PlansTable:0">
        <thead>
          <TableRow header>
            <Th columnId="c0">{""}</Th>
            <Th columnId="c1">{t("Plan", "Plan")}</Th>
            <Th columnId="c2">{t("Version", "Wersja")}</Th>
            <Th columnId="c3" align="right">{t("Price / month", "Cena / mies")}</Th>
            <Th columnId="c4">{t("Estimate", "Estymata")}</Th>
            <Th columnId="c5">{t("Calibration", "Kalibracja")}</Th>
            <Th columnId="c6">{t("Token profile", "Profil tokenów")}</Th>
            <Th columnId="c7" align="right">API / 1%</Th>
            <Th columnId="c8">{t("Source", "Źródło")}</Th>
            <Th columnId="c9" align="right">{t("Action", "Akcja")}</Th>
          </TableRow>
        </thead>
        <tbody>
          {rows.map((row) => {
            const expanded = open.has(row.plan_id);
            const cap = row.capacity;
            const primary = cap?.primary;
            const cal = cap?.local_calibration.tokens.status ?? "none";
            const calReason =
              cap?.local_calibration.tokens.reason ??
              row.no_version_reason ??
              row.kind_absent_reason ??
              "no_version_for_day";
            const source = primary?.source ?? "none";
            const profile = profileLine(primary?.token_profile);
            const api = moneyText(primary?.api_usd_per_1pct);
            const price = monthlyText(row.usd_per_month);
            const versionLabel = row.active_version_id ?? "—";
            return (
              <Fragment key={row.plan_id}>
                <TableRow
                  data-plan-id={row.plan_id}
                  data-version-id={row.active_version_id ?? ""}
                  data-as-of={asOf}
                  data-primary-source={source}
                  data-calibration={cal}
                  data-calibration-accepted={cap?.local_calibration.samples.accepted ?? ""}
                  data-api-absent={primary?.api_usd_per_1pct.absent ?? ""}
                  data-window-kind={row.window_kind ?? ""}
                  data-kind-absent={row.kind_absent_reason ?? ""}
                >
                  <Td>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={expanded ? t("Collapse history for {0}", `Zwiń historię ${row.label}`, [row.label]) : t("Expand history for {0}", `Rozwiń historię ${row.label}`, [row.label])}
                      onClick={() => toggle(row.plan_id)}
                      className="mono hovertext"
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--muted)",
                        cursor: "pointer",
                        padding: "0 4px",
                        fontSize: "var(--fs-3)",
                      }}
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                  </Td>
                  <Td>
                    <div style={{ fontWeight: "var(--fw-medium)" }}>{row.label}</div>
                    <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: 1 }}>
                      {row.provider_label} · {row.plan_id}
                    </div>
                  </Td>
                  <Td mono>
                    {row.active_version_id ? (
                      <span title={row.active_from ? t("from {0}", `od ${row.active_from}`, [row.active_from]) : t("from the beginning of known history", "od początku znanej historii")}>
                        {versionLabel}
                        {row.window_kind ? (
                          <span style={{ color: "var(--faint)", marginLeft: 6 }}>{row.window_kind}</span>
                        ) : (
                          <span style={{ marginLeft: 6 }}>
                            <Absent reason={row.kind_absent_reason ?? "unknown_window_kind"} />
                          </span>
                        )}
                      </span>
                    ) : (
                      <Absent reason={row.no_version_reason} />
                    )}
                  </Td>
                  <Td mono align="right" title={price.title}>
                    {row.usd_per_month == null ? <Absent reason="missing_price" /> : price.text}
                  </Td>
                  <Td>
                    {source === "none" ? (
                      <Absent reason={cap?.deviation.reason ?? row.no_version_reason} />
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span>{sourceLabel(source)}</span>
                        {source === "default_reference" && (
                          <EstimateTag title={t("Curated version reference - not a local measurement", "Kuratorowana referencja wersji — nie jest lokalnym pomiarem")}>
                            {t("reference", "referencja")}
                          </EstimateTag>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {cal === "none" ? (
                      <Absent reason={calReason} />
                    ) : (
                      <Pill tone={CAL_TONE[cal]}>{calibrationLabel(cal)}</Pill>
                    )}
                  </Td>
                  <Td mono title={profile.title} style={{ whiteSpace: "normal" }}>
                    {primary && profile.text !== "—" ? profile.text : <Absent reason={profile.title} />}
                  </Td>
                  <Td mono align="right" title={api.title}>
                    {api.text === "—" ? <Absent reason={primary?.api_usd_per_1pct.absent} /> : api.text}
                    {cap?.normalization === "standard" && api.text !== "—" && <span title={t("Standard equivalent accounting for the Speed allowance multiplier", "Ekwiwalent Standard uwzględniający mnożnik limitu Speed")}> Std</span>}
                  </Td>
                  <Td>
                    <ProvenanceLine
                      capacity={cap}
                      absentReason={row.kind_absent_reason ?? row.no_version_reason}
                    />
                  </Td>
                  <Td align="right">
                    {onEditPlan && (
                      <button
                        type="button"
                        style={{ padding: "var(--s-2) var(--s-5)", fontSize: "var(--fs-3)" }}
                        className="ui-button"
                        onClick={() => onEditPlan(row.plan_id, row.active_version_id ?? undefined)}
                      >
                        {t("edit in catalog", "edytuj w katalogu")}
                      </button>
                    )}
                  </Td>
                </TableRow>
                {expanded && (
                  <TableRow data-plan-history={row.plan_id}>
                    <Td colSpan={COLS} style={{ whiteSpace: "normal", background: "var(--sunk)" }}>
                      <VersionHistory row={row} asOf={asOf} onEditPlan={onEditPlan} />
                    </Td>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
function ProvenanceLine({
  capacity,
  absentReason,
}: {
  capacity: PlanCapacityResult | null;
  absentReason?: string | null;
}) {
  const { t } = useI18n();
  if (!capacity) return <Absent reason={absentReason ?? "no_reference"} />;
  const local = capacity.local_calibration.tokens.status;
  const ref = capacity.default_reference;
  const parts: string[] = [];
  parts.push(`${t("local", "lokalna")}: ${calibrationLabel(local)}`);
  if (ref.present) parts.push(`${t("reference", "referencja")}: ${t("present", "jest")}`);
  else parts.push(`${t("reference", "referencja")}: ${reasonLabel(ref.reason) || t("missing", "brak")}`);
  if (capacity.deviation.local_vs_reference != null) {
    parts.push(`${t("deviation", "odchylenie")} ${(capacity.deviation.local_vs_reference * 100).toFixed(0)}%`);
  }
  return (
    <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }} title={capacity.local_calibration.explanation}>
      {parts.join(" · ")}
    </span>
  );
}
function VersionHistory({
  row,
  asOf,
  onEditPlan,
}: {
  row: PlanTableRow;
  asOf: string;
  onEditPlan?: (planId: string, versionId?: string) => void;
}) {
  const { t } = useI18n();
  if (row.versions.length === 0) {
    return <EmptyState title={t("No version history", "Brak historii wersji")} detail={t("The catalog has no version of this plan.", "Katalog nie ma żadnej wersji tego Planu.")} />;
  }
  return (
    <div style={{ padding: "8px 4px 12px" }}>
      <div className="ui-eyebrow" style={{ margin: "0 10px 8px" }}>
        {t("Version history · lifetime calibration for every version · snapshot", "Historia wersji · kalibracja pełnego życia każdej wersji · snapshot")} {asOf} {t("does not trim samples", "nie przycina próbek")}
      </div>
      <Table tableId="PlansTable:1">
        <thead>
          <TableRow header>
            <Th columnId="c0">{t("Version", "Wersja")}</Th>
            <Th columnId="c1">{t("From", "Od")}</Th>
            <Th columnId="c2" align="right">{t("Price", "Cena")}</Th>
            <Th columnId="c3">{t("Limits", "Limity")}</Th>
            <Th columnId="c4">{t("Calibration", "Kalibracja")}</Th>
            <Th columnId="c5" align="right">{t("Windows", "Okna")}</Th>
            <Th columnId="c6">{t("Reference", "Referencja")}</Th>
            <Th columnId="c7">{t("Profile", "Profil")}</Th>
            <Th columnId="c8" align="right">API / 1%</Th>
            <Th columnId="c9" align="right">{t("Action", "Akcja")}</Th>
          </TableRow>
        </thead>
        <tbody>
          {row.versions.map((v) => {
            const cap = v.capacity;
            const cal = cap?.local_calibration.tokens.status ?? "none";
            const accepted = cap?.local_calibration.samples.accepted;
            const span = cap?.local_calibration.samples.span_hours;
            const profile = profileLine(cap?.primary.token_profile);
            const api = moneyText(cap?.primary.api_usd_per_1pct);
            const active = v.version_id === row.active_version_id;
            return (
              <TableRow
                key={v.version_id}
                data-history-version={v.version_id}
                data-lifetime-accepted={accepted ?? ""}
                data-lifetime-span={span ?? ""}
                data-lifetime-explanation={cap?.local_calibration.explanation ?? ""}
              >
                <Td mono>
                  {v.version_id}
                  {active && (
                    <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: "var(--fs-2)" }}>{t("as", "na")} {asOf}</span>
                  )}
                </Td>
                <Td mono>{v.from ?? t("origin", "początek")}</Td>
                <Td mono align="right">
                  {v.usd_per_month == null ? <Absent reason="missing_price" /> : usd(v.usd_per_month)}
                </Td>
                <Td style={{ whiteSpace: "normal", color: "var(--muted)" }}>{limitsLine(v.limits)}</Td>
                <Td>
                  {cal === "none" ? (
                    <Absent
                      reason={
                        cap?.local_calibration.tokens.reason ??
                        v.kind_absent_reason ??
                        "no_accepted_windows"
                      }
                    />
                  ) : (
                    <Pill tone={CAL_TONE[cal]}>{calibrationLabel(cal)}</Pill>
                  )}
                </Td>
                <Td mono align="right" data-calibration-lifetime="1">
                  {accepted == null ? (
                    <Absent reason="no_accepted_windows" />
                  ) : (
                    <span title={cap?.local_calibration.explanation}>
                      {accepted}
                      {span != null && <span style={{ color: "var(--faint)" }}>{` · ${compact(span)}h`}</span>}
                    </span>
                  )}
                </Td>
                <Td>
                  {cap?.default_reference.present ? (
                    <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                      {cap.default_reference.source ?? "jest"}
                    </span>
                  ) : (
                    <Absent reason={cap?.default_reference.reason ?? "no_reference"} />
                  )}
                </Td>
                <Td mono style={{ whiteSpace: "normal" }}>
                  {profile.text === "—" ? <Absent reason={profile.title} /> : profile.text}
                </Td>
                <Td mono align="right">
                  {api.text === "—" ? <Absent reason={cap?.primary.api_usd_per_1pct.absent} /> : api.text}
                </Td>
                <Td align="right">
                  {onEditPlan && (
                    <button
                      type="button"
                      style={{ padding: "var(--s-1) var(--s-4)", fontSize: "var(--fs-3)" }}
                      className="ui-button"
                      onClick={() => onEditPlan(row.plan_id, v.version_id)}
                    >
                      {t("edit version", "edytuj wersję")}
                    </button>
                  )}
                </Td>
              </TableRow>
            );
          })}
        </tbody>
      </Table>
      {row.versions.some((v) => v.note) && (
        <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", margin: "8px 10px 0", lineHeight: 1.45 }}>
          {row.versions
            .filter((v) => v.note)
            .map((v) => `${v.version_id}: ${v.note}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}
