import type { TokenTypeBreakdown } from "../../lib/api";
import { translate, useI18n } from "../../lib/i18n";
import {
  formatMoney,
  formatQty,
  formatEquivalentQty,
  MONEY_HINT,
  RECEIPT_HINT,
  utilisationVerdict,
} from "../../lib/mixFormat";
import { Fragment } from "react";
import { billingUnavailable } from "../../lib/plan-cost-status";
import { compact, full } from "../../lib/format";
import { CalibrationChip } from "../mix";
import { Table, TableRow, Td, Th } from "../ui";
import { type SplitLine, currentPlan, usedHint, windowMeasurementHint } from "./subscriptions";
import { SubscriptionName } from "./SubscriptionName";

function tokenTypeColumns(): Array<{ key: keyof TokenTypeBreakdown; label: string; hint: string }> {
  return [
    { key: "in_uncached", label: "input", hint: translate("fresh input - input tokens not from cache", "świeży input - tokeny wejściowe, które nie wyszły z cache") },
    { key: "cache_read", label: "cache", hint: translate("input served from cache - about 97% of Codex input traffic", "input podany z cache - u Codeksa ~97% ruchu wejściowego") },
    { key: "cache_write", label: translate("write", "zapis"), hint: translate("cache writes (Claude 5m and 1h combined)", "zapis do cache (u Claude'a 5m + 1h razem)") },
    { key: "out", label: translate("output", "output"), hint: translate("output including reasoning tokens", "output razem z tokenami rozumowania") },
  ];
}

function typeUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return formatMoney(v);
}

function perMillionHint(tokens: number, usd: number | null): string {
  if (usd == null || tokens <= 0) return "";
  return ` · ${translate("effectively", "efektywnie")} $${((usd / tokens) * 1e6).toFixed(2)}/1M`;
}

function smallQty(n: number): string {
  return n > 0 && n < 0.1 ? n.toFixed(2) : formatQty(n);
}

/** "used 48%" without its word: the column header already says it. */
function usedPercent(label: string): string {
  const word = translate("used", "wyk.");
  return label.startsWith(word) ? label.slice(word.length).trim() : label;
}

const TOTAL_CELL: React.CSSProperties = { borderTop: "1px solid var(--line2)" };

/**
 * Split of the project by subscription. The default columns answer "who carried it and what it
 * cost"; capacity equivalents, token types and the window measurement wait behind `moreColumns`.
 * Every definition lives in its column header's tooltip.
 */
export function SubscriptionSplitTable({
  lines,
  nameOf = (id) => id,
  moreColumns = false,
}: {
  lines: SplitLine[];
  nameOf?: (id: string) => string;
  moreColumns?: boolean;
}) {
  const { t } = useI18n();
  const types = tokenTypeColumns();
  const anyBilled = lines.some((l) => l.billedUsd != null);
  const anyFull = lines.some((l) => l.costAtFullUseUsd != null);
  const totalBilled = anyBilled ? lines.reduce((a, l) => a + (l.billedUsd ?? 0), 0) : null;
  const totalFull = anyFull ? lines.reduce((a, l) => a + (l.costAtFullUseUsd ?? 0), 0) : null;
  const totalApi = lines.reduce((a, l) => a + l.apiUsd, 0);
  const totalTokens = lines.reduce((a, l) => a + l.tokens, 0);
  const totalTok: TokenTypeBreakdown = { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 };
  const totalTypeUsd: TokenTypeBreakdown = { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 };
  let anyTypeTok = false;
  let anyTypeUsd = false;
  let allTypeUsd = true;
  for (const l of lines) {
    if (l.tokensByType) {
      anyTypeTok = true;
      for (const c of types) totalTok[c.key] += l.tokensByType[c.key];
    }
    if (l.usdByType) {
      anyTypeUsd = true;
      for (const c of types) totalTypeUsd[c.key] += l.usdByType[c.key];
    } else {
      allTypeUsd = false;
    }
  }
  const totalVerdict = utilisationVerdict(totalBilled, totalFull);
  const noSum = t("Windows from different plans have no common unit, so these two columns cannot be summed.", "Okna różnych planów nie mają wspólnej jednostki, więc te dwie kolumny nie mają sumy.");
  const tokenTypesHint = t(
    "Tokens by type; the next column shows the cost of that type at API list price, its tooltip the effective price per 1M.",
    "Tokeny wg typu; następna kolumna pokazuje koszt tego typu w cenniku API, jej dymek efektywną cenę za 1M.",
  );
  const usedCell = (verdict: ReturnType<typeof utilisationVerdict>, style?: React.CSSProperties) => (
    <Td align="right" mono title={verdict?.hint} style={{ color: verdict?.tone === "warn" ? "var(--warn)" : "var(--muted)", ...style }}>
      {verdict ? `${usedPercent(verdict.label)}${verdict.impossible ? " ⚠" : ""}` : "—"}
    </Td>
  );
  return (
    <Table tableId="ProjectDrawer:0">
      <thead>
        <TableRow header>
          <Th columnId="c0">{t("subscription", "abonament")}</Th>
          <Th columnId="c1" align="right" title={t("All tokens this subscription carried for the project.", "Wszystkie tokeny, które ten abonament przeniósł dla projektu.")}>
            {t("tokens", "tokeny")}
          </Th>
          <Th columnId="c2" align="right" title={t("What the same traffic would cost without a subscription. A counterfactual used for shares and capacity.", "Ile ten sam ruch kosztowałby bez abonamentu — kontrfakt; z tej kwoty liczą się udziały i pojemność.")}>
            {t("API list price", "cennik API")}
          </Th>
          <Th columnId="c3" align="right" title={`${RECEIPT_HINT.actual} ${MONEY_HINT.billed}`}>{t("$ by calendar", "$ wg kalendarza")}</Th>
          <Th columnId="c4" align="right" title={usedHint()}>{t("used %", "wyk. %")}</Th>
          {moreColumns && (
            <>
              <Th columnId="c5" align="right" title={RECEIPT_HINT.fullUse}>{t("$ by capacity", "$ wg pojemności")}</Th>
              <Th columnId="c6"
                align="right"
                title={t(
                  "$ by calendar divided by the monthly price: purchased subscription time. The weekly and monthly columns measure used capacity instead.",
                  "$ wg kalendarza ÷ cena miesięczna: wykupiony CZAS abonamentu — nie mylić z „tyg./mies. ab.”, które mierzą zużytą pojemność.",
                )}
              >
                {t("plan time", "czas planu")}
              </Th>
              <Th columnId="c7" align="right" title={RECEIPT_HINT.sessions}>{t("5h sessions", "sesje 5h")}</Th>
              <Th columnId="c8" align="right" title={RECEIPT_HINT.weekly}>{t("weekly sub.", "tyg. ab.")}</Th>
              <Th columnId="c9" align="right" title={RECEIPT_HINT.monthly}>{t("monthly sub.", "mies. ab.")}</Th>
              {types.map((c) => (
                <Fragment key={c.key}>
                  <Th columnId={`tokens:${c.key}`} align="right" title={`${c.hint}. ${tokenTypesHint}`}>{c.label}</Th>
                  <Th columnId={`cost:${c.key}`} align="right" title={`${c.hint}: ${t("cost of this type at API list price.", "koszt tego typu w cenniku API.")}`}>{c.label} $</Th>
                </Fragment>
              ))}
              <Th columnId="c12" title={windowMeasurementHint()}>{t("window measurement", "pomiar okna")}</Th>
            </>
          )}
        </TableRow>
      </thead>
      <tbody>
        {lines.map((l) => {
          const verdict = utilisationVerdict(l.billedUsd, l.costAtFullUseUsd);
          const plan = currentPlan(l);
          return (
            <TableRow key={l.subId}>
              <Td>
                <SubscriptionName color={l.color} name={nameOf(l.subId)} plan={plan} tooltip={l.planTooltip ?? l.planHistory} />
              </Td>
              <Td align="right" mono title={full(l.tokens)} style={{ color: "var(--muted)" }}>{compact(l.tokens)}</Td>
              <Td align="right" mono title={MONEY_HINT.api} style={{ color: "var(--muted)" }}>{formatMoney(l.apiUsd)}</Td>
              <Td
                align="right"
                mono
                title={l.billedUsd == null ? billingUnavailable(l.billingUnavailableReasons).hint : l.seatTime != null && Number.isFinite(l.seatTime.months) ? `= ${smallQty(l.seatTime.weeks)} ${t("weeks", "tyg.")} / ${smallQty(l.seatTime.months)} ${t("months", "mies.")} ${t("of plan", "planu")}` : MONEY_HINT.billed}
                style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)" }}
              >
                {l.billedUsd == null ? billingUnavailable(l.billingUnavailableReasons).label : formatMoney(l.billedUsd)}
              </Td>
              {usedCell(verdict)}
              {moreColumns && (
                <>
                  <Td align="right" mono title={RECEIPT_HINT.fullUse} style={{ color: "var(--muted)" }}>
                    {l.costAtFullUseUsd == null ? "—" : formatMoney(l.costAtFullUseUsd)}
                  </Td>
                  <Td align="right" mono style={{ color: "var(--muted)" }}>
                    {l.seatTime != null && Number.isFinite(l.seatTime.months)
                      ? `${smallQty(l.seatTime.weeks)} ${t("weeks", "tyg.")} / ${smallQty(l.seatTime.months)} ${t("months", "mies.")}`
                      : "—"}
                  </Td>
                  <Td align="right" mono style={{ color: "var(--muted)" }}>{formatEquivalentQty(l.equivalents.full_5h_sessions)}</Td>
                  <Td align="right" mono style={{ color: "var(--muted)" }}>{formatEquivalentQty(l.equivalents.weekly_cycles)}</Td>
                  <Td align="right" mono style={{ color: "var(--muted)" }}>{formatEquivalentQty(l.equivalents.monthly_subscriptions)}</Td>
                  {types.map((c) => {
                    const tok = l.tokensByType?.[c.key] ?? null;
                    const cost = l.usdByType?.[c.key] ?? null;
                    return (
                      <Fragment key={c.key}>
                        <Td align="right" mono title={tok == null ? c.hint : `${full(tok)} tok (${c.label})`} style={{ color: "var(--muted)" }}>
                          {tok == null ? "—" : compact(tok)}
                        </Td>
                        <Td
                          align="right"
                          mono
                          title={
                            cost == null
                              ? t("type cost unknown - vendor values the total with its own counter", "koszt typu nieznany - vendor wycenia całość własnym licznikiem")
                              : `${c.label}${tok == null ? "" : perMillionHint(tok, cost)}`
                          }
                          style={{ color: "var(--faint)" }}
                        >
                          {cost == null ? "—" : typeUsd(cost)}
                        </Td>
                      </Fragment>
                    );
                  })}
                  <Td>
                    <CalibrationChip provenance={l.provenance} />
                  </Td>
                </>
              )}
            </TableRow>
          );
        })}
      </tbody>
      <tfoot>
        <TableRow>
          <Td style={{ ...TOTAL_CELL, fontWeight: "var(--fw-semibold)", color: "var(--muted)" }}>{t("total", "razem")}</Td>
          <Td align="right" mono title={full(totalTokens)} style={{ ...TOTAL_CELL, color: "var(--muted)" }}>{compact(totalTokens)}</Td>
          <Td align="right" mono title={MONEY_HINT.api} style={{ ...TOTAL_CELL, color: "var(--muted)" }}>{formatMoney(totalApi)}</Td>
          <Td align="right" mono style={{ ...TOTAL_CELL, fontWeight: "var(--fw-semibold)", color: totalBilled == null ? "var(--faint)" : "var(--text)" }}>
            {totalBilled == null ? billingUnavailable().label : `${lines.some(l => l.billedUsd == null) ? "≥ " : ""}${formatMoney(totalBilled)}`}
          </Td>
          {usedCell(totalVerdict, TOTAL_CELL)}
          {moreColumns && (
            <>
              <Td align="right" mono style={{ ...TOTAL_CELL, color: "var(--muted)" }}>{totalFull == null ? "—" : formatMoney(totalFull)}</Td>
              <Td style={TOTAL_CELL}>{null}</Td>
              <Td style={TOTAL_CELL}>{null}</Td>
              <Td align="right" title={noSum} style={{ ...TOTAL_CELL, color: "var(--faint)", fontSize: "var(--fs-2)" }}>{t("not summed", "bez sumy")}</Td>
              <Td align="right" title={noSum} style={{ ...TOTAL_CELL, color: "var(--faint)", fontSize: "var(--fs-2)" }}>{t("not summed", "bez sumy")}</Td>
              {types.map((c) => (
                <Fragment key={c.key}>
                  <Td align="right" mono title={anyTypeTok ? `${full(totalTok[c.key])} tok (${c.label})` : c.hint} style={{ ...TOTAL_CELL, color: "var(--muted)" }}>
                    {anyTypeTok ? compact(totalTok[c.key]) : "—"}
                  </Td>
                  <Td
                    align="right"
                    mono
                    title={anyTypeUsd && !allTypeUsd ? t("sum $ excludes rows whose types cannot be priced (grok)", "suma $ bez wierszy, których typów nie da się wycenić (grok)") : undefined}
                    style={{ ...TOTAL_CELL, color: "var(--faint)" }}
                  >
                    {anyTypeUsd ? typeUsd(totalTypeUsd[c.key]) : "—"}
                  </Td>
                </Fragment>
              ))}
              <Td style={TOTAL_CELL}>{null}</Td>
            </>
          )}
        </TableRow>
      </tfoot>
    </Table>
  );
}
