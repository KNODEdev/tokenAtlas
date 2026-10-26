import type { PlanUnit } from "../../lib/planUnits";
import { translate, useI18n } from "../../lib/i18n";
import { formatQty, formatMoney } from "../../lib/mixFormat";
import { EstimateTag, Table, TableRow, Td, Th } from "../ui";
import { localizedPlural } from "./format";
import { SubscriptionName } from "./SubscriptionName";

export interface WhatIfRow {
  subId: string;
  name: string;
  color: string;
  plan: string | null;
  planTooltip: string | null;
  unit: PlanUnit | null;
  conv: { windows: number | null; parallel: number | null; usd: number | null } | null;
}

const BASIS_ORDER: Record<PlanUnit["basis"], number> = { measured: 0, single: 1, none: 2 };

function windowLength(hoursPerWindow: number | null): string {
  if (hoursPerWindow == null) return "—";
  return hoursPerWindow % 24 === 0 ? `${formatQty(hoursPerWindow / 24)} ${translate("days", "dni")}` : `${formatQty(hoursPerWindow)} h`;
}

/**
 * All project traffic priced at the API catalog and poured into one plan at a time: how many of its
 * windows it would burn, how busy one plan would be, and what that capacity costs at the plan price.
 */
export function WhatIfTable({ rows, rangeDays }: { rows: WhatIfRow[]; rangeDays: number | null }) {
  const { t } = useI18n();
  const sorted = [...rows].sort((a, b) => BASIS_ORDER[a.unit?.basis ?? "none"] - BASIS_ORDER[b.unit?.basis ?? "none"]);
  return (
    <Table tableId="ProjectDrawer:1">
      <thead>
        <TableRow header>
          <Th columnId="c0">{t("subscription", "abonament")}</Th>
          <Th columnId="c1" align="right" title={t("How long one capacity window of this plan lasts.", "Ile trwa jedno okno pojemności tego planu.")}>{t("window", "okno")}</Th>
          <Th columnId="c2" align="right" title={t("How many full capacity windows of this plan all project traffic would consume at API list price.", "Ile pełnych okien pojemności tego planu zużyłby cały ruch projektu wyceniony cennikiem API.")}>
            {t("full windows", "pełne okna")}
          </Th>
          <Th columnId="c3" align="right" title={t("Full windows consumed divided by all windows available in the range: the average capacity use of one plan, not a number of subscriptions.", "Zużyte pełne okna ÷ wszystkie okna dostępne w zakresie: średnie użycie pojemności jednego planu, a nie liczba abonamentów.")}>
            {t("avg. use of 1 plan", "śr. użycie 1 planu")}
          </Th>
          <Th columnId="c4" align="right" title={t("What that used capacity costs at this plan's monthly price over the range.", "Ile ta zużyta pojemność kosztuje po miesięcznej cenie tego planu w tym zakresie.")}>
            {t("$ at 100%", "$ przy 100%")}
          </Th>
          <Th columnId="c5" title={t("How the window capacity is known: measured on many closed windows, from one reading, or not at all.", "Skąd znana jest pojemność okna: zmierzona na wielu zamkniętych oknach, z jednego odczytu albo wcale.")}>
            {t("measurement", "pomiar")}
          </Th>
        </TableRow>
      </thead>
      <tbody>
        {sorted.map((row) => {
          const unit = row.unit;
          const basis = unit?.basis ?? "none";
          const known = row.conv?.windows != null;
          const note = unit?.note || t("Window capacity calibration unavailable", "Brak kalibracji pojemności okna");
          const windowTitle =
            unit?.windowHours != null
              ? `${t("1 capacity window", "1 okno pojemności")}: ${windowLength(unit.windowHours)} = ${unit.windowValue != null ? formatMoney(unit.windowValue) : "—"} ${t("in the API catalog", "w cenniku API")}${
                  rangeDays != null ? ` · ${t("this range contains", "w tym zakresie mieści się")} ${formatQty((rangeDays * 24) / unit.windowHours)} ${localizedPlural((rangeDays * 24) / unit.windowHours, "window", "windows", "okno", "okna", "okien")}` : ""
                }`
              : undefined;
          return (
            <TableRow key={row.subId} data-basis={basis}>
              <Td>
                <SubscriptionName color={row.color} name={row.name} plan={row.plan} tooltip={row.planTooltip} />
              </Td>
              <Td align="right" mono title={windowTitle} style={{ color: "var(--muted)" }}>{known ? windowLength(unit?.windowHours ?? null) : "—"}</Td>
              <Td align="right" mono style={{ color: "var(--text)" }}>{known ? `≈ ${formatQty(row.conv!.windows!)}` : "—"}</Td>
              <Td align="right" mono style={{ color: "var(--text)" }}>{known && row.conv!.parallel != null ? `≈ ${formatQty(row.conv!.parallel * 100)}%` : "—"}</Td>
              <Td align="right" mono style={{ color: "var(--text)" }}>{known && row.conv!.usd != null ? `≈ ${formatMoney(row.conv!.usd)}` : "—"}</Td>
              <Td style={{ width: 1 }}>
                {basis !== "measured" && (
                  <EstimateTag title={note}>{basis === "single" ? t("1 reading", "1 odczyt") : t("no measurement", "brak pomiaru")}</EstimateTag>
                )}
              </Td>
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}
