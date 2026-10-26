import type { PlanCapacityResult, PlanQuantity, PrimarySource } from "../lib/api";
import { usd } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { TableRow, Card, CardTitle, EmptyState, EstimateTag, Table, Td, Th } from "./ui";
import { dash, reasonLabel } from "./PlansTable";
/** `no_plan`: a declared "no subscription" stretch (reserved plan value `none`): $0, no limits. */
export type SubscriptionStageKind = "assigned" | "gap" | "unassigned" | "unmatched" | "no_plan";
export type SubscriptionPriceSource = "version" | "rate-card" | "no-plan" | "none";
export interface SubscriptionTableRow {
  id: string;
  provider_group: string;
  provider_label: string;
  vendor: string;
  stage_kind: SubscriptionStageKind;
  plan_id: string | null;
  plan_label: string | null;
  plan_query: string | null;
  stage_from: string | null;
  stage_until: string | null;
  usd_per_month: number | null;
  price_source: SubscriptionPriceSource;
  unmatched_reason?: string | null;
  gap_reason?: string | null;
  observed_plan_id?: string | null;
  observed_plan_label?: string | null;
  observed_from?: string | null;
  observed_until?: string | null;
  capacity: PlanCapacityResult | null;
}
function priceLabel(source: SubscriptionPriceSource): string {
  if (source === "version") return translate("plan version", "wersja Planu");
  if (source === "rate-card") return translate("catalog", "cennik");
  if (source === "no-plan") return translate("declared", "deklaracja");
  return "—";
}
function sourceLabel(source: PrimarySource): string {
  if (source === "local_calibration") return translate("local", "lokalna");
  if (source === "default_reference") return translate("reference", "referencja");
  return "—";
}
function Absent({ reason }: { reason?: string | null }) {
  useI18n();
  const d = dash(reason);
  return (
    <span title={d.title} style={{ color: "var(--faint)" }}>
      {d.text}
      {d.title ? <span style={{ marginLeft: 6, fontWeight: 400 }}>{d.title}</span> : null}
    </span>
  );
}
function money(q: PlanQuantity | null | undefined): { text: string; reason: string | null } {
  if (!q) return { text: "—", reason: "missing_rate" };
  if (q.absent != null) return { text: "—", reason: q.absent };
  return { text: usd(q.value), reason: null };
}
function range(from: string | null, until: string | null): string | undefined {
  if (!from && !until) return undefined;
  return `${from ?? translate("beginning", "początek")} → ${until ?? translate("today", "dziś")}`;
}
/**
 * Price and calibration of each billing account on the "As of" day (UI audit decision 16). The plan column
 * only says which plan the price and calibration were read for; plan history is edited on the same account's
 * timeline in Settings → Accounts.
 */
export function SubscriptionsTable({
  rows,
  asOf,
  selectedId,
  bare = false,
}: {
  rows: SubscriptionTableRow[];
  asOf: string;
  /** The subscription a data-settings link arrived for; marked, not opened. */
  selectedId?: string | null;
  /** Inside a fold whose summary already names the table: keep only the "as of" line. */
  bare?: boolean;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t("No subscriptions in this group", "Brak subskrypcji w tej grupie")}
        detail={t("There is no persistent billing account for the selected provider. The filter does not create rows for plans we do not have.", "Nie ma trwałego konta rozliczeniowego dla wybranego dostawcy. Filtr nie tworzy wierszy z Planów, których nie mamy.")}
      />
    );
  }
  return (
    <Card pad="0">
      <div style={{ padding: "var(--s-8) var(--s-9) var(--s-4)" }}>
        {bare ? (
          <div className="mono ui-card-subtitle">{`${t("as of", "stan na")} ${asOf}`}</div>
        ) : (
          <CardTitle
            title={t("Price and calibration", "Cena i kalibracja")}
            sub={`${t("as of", "stan na")} ${asOf}`}
          />
        )}
      </div>
      <Table tableId="SubscriptionsTable:0">
        <thead>
          <TableRow header>
            <Th columnId="c0">{t("Subscription", "Subskrypcja")}</Th>
            <Th columnId="c1">{t("Provider", "Dostawca")}</Th>
            <Th columnId="c2" title={t("The plan the price and calibration are read for on this day", "Plan, dla którego odczytano cenę i kalibrację w tym dniu")}>{t("Plan", "Plan")}</Th>
            <Th columnId="c3" align="right">{t("Price / month", "Cena / mies")}</Th>
            <Th columnId="c4" title={t("Where the monthly price comes from, and the calibration source", "Skąd pochodzi cena miesięczna i źródło kalibracji")}>{t("Price source", "Źródło ceny")}</Th>
            <Th columnId="c5" align="right" title={t("Uncached input tokens that use 1% of the limit", "Tokeny wejścia bez cache, które zużywają 1% limitu")}>{t("Tokens / 1%", "Tokeny / 1%")}</Th>
            <Th columnId="c6" align="right" title={t("API-equivalent dollars that use 1% of the limit", "Równowartość API w dolarach, która zużywa 1% limitu")}>API / 1%</Th>
          </TableRow>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = selectedId === row.id;
            const gap = row.stage_kind === "gap";
            const unmatched = row.stage_kind === "unmatched";
            const unassigned = row.stage_kind === "unassigned";
            // A plan read from the account's observed period, not declared.
            const observed = row.stage_kind === "assigned" && row.observed_plan_label != null;
            const hole = gap || unassigned || unmatched;
            // No subscription has no limit, so there is nothing to calibrate.
            const noPlan = row.stage_kind === "no_plan";
            const holeReason =
              (gap ? row.gap_reason : unmatched ? row.unmatched_reason : unassigned ? "unassigned" : null) ??
              (hole ? row.stage_kind : null);
            const api = noPlan ? { text: "—", reason: "no_plan" } : money(row.capacity?.primary.api_usd_per_1pct);
            const inTok = row.capacity?.primary.tokens_per_1pct.in_uncached;
            const tok =
              noPlan ? { text: "—" as const, reason: "no_plan" }
              : !inTok || inTok.absent != null
                ? { text: "—" as const, reason: inTok?.absent ?? (hole ? holeReason : "missing_counter") }
                : { text: String(Math.round(inTok.value)), reason: null };
            const source = row.capacity?.primary.source ?? "none";
            return (
              <TableRow
                key={row.id}
                data-subscription-id={row.id}
                data-stage={row.stage_kind}
                data-display-stage={observed ? "observed" : row.stage_kind}
                data-plan-id={row.plan_id ?? ""}
                data-plan-query={row.plan_query ?? ""}
                data-as-of={asOf}
                data-selected={selected ? "1" : "0"}
                data-api-absent={row.capacity?.primary.api_usd_per_1pct.absent ?? ""}
                style={{ background: selected ? "var(--accent-soft)" : undefined }}
              >
                <Td>
                  <span style={{ fontWeight: "var(--fw-medium)" }}>{row.id}</span>
                </Td>
                <Td>
                  <div>{row.provider_label || "—"}</div>
                  {row.vendor && row.vendor !== row.provider_group && (
                    <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                      {row.vendor}
                    </div>
                  )}
                </Td>
                <Td title={observed ? range(row.observed_from ?? null, row.observed_until ?? null) : range(row.stage_from, row.stage_until)}>
                  {observed ? (
                    <span>
                      <span style={{ fontWeight: 600 }}>≈ {row.observed_plan_label}</span>
                      <span style={{ marginLeft: 6 }}>
                        <EstimateTag title={t("Plan read from the account's readings on this day, not declared.", "Plan odczytany z odczytów konta w tym dniu, nie zadeklarowany.")}>
                          {t("observed", "obserwowane")}
                        </EstimateTag>
                      </span>
                    </span>
                  ) : gap || unassigned ? (
                    <Absent reason={holeReason} />
                  ) : unmatched ? (
                    <span>
                      <span style={{ color: "var(--crit)", fontWeight: 600 }}>{row.plan_query ?? "—"}</span>
                      <span className="mono" style={{ marginLeft: 6, color: "var(--faint)", fontSize: "var(--fs-3)" }}>
                        {reasonLabel(row.unmatched_reason) || t("not matched to catalog", "nie pasuje do katalogu")}
                      </span>
                    </span>
                  ) : (
                    <span>
                      <span style={{ fontWeight: 600 }}>{row.plan_label ?? row.plan_id}</span>
                      {row.plan_id && (
                        <span className="mono" style={{ marginLeft: 6, color: "var(--faint)", fontSize: "var(--fs-2)" }}>
                          {row.plan_id}
                        </span>
                      )}
                    </span>
                  )}
                </Td>
                <Td mono align="right">
                  {row.usd_per_month == null ? (
                    <Absent reason={hole ? holeReason : "missing_price"} />
                  ) : (
                    usd(row.usd_per_month)
                  )}
                </Td>
                <Td>
                  {row.price_source === "none" ? (
                    <Absent reason={hole ? holeReason : "missing_price"} />
                  ) : (
                    <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                      {priceLabel(row.price_source)}
                      {source !== "none" && row.stage_kind === "assigned" && (
                        <span>
                          {" · "}
                          {sourceLabel(source)}
                          {source === "default_reference" && (
                            <EstimateTag title={t("Curated reference for the plan version", "Kuratorowana referencja wersji Planu")}>ref</EstimateTag>
                          )}
                        </span>
                      )}
                    </span>
                  )}
                </Td>
                <Td mono align="right">
                  {tok.reason ? <Absent reason={tok.reason} /> : tok.text}
                </Td>
                <Td mono align="right">
                  {api.reason ? <Absent reason={api.reason} /> : api.text}
                </Td>
              </TableRow>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
