import { useMemo, type CSSProperties } from "react";
import type { CapacityBasis, CapacityEquivalents, Provenance, SeatTime, TokenTypeBreakdown } from "../lib/api";
import { compact, full } from "../lib/format";
import {
  calibrationSummary,
  formatEquivalentQty,
  formatEquivalentsLine,
  formatMoney,
  formatQty,
  MONEY_HINT,
  utilisationVerdict,
  provenanceAxesLine,
  provenanceLacksCalibration,
  provenanceTitle,
  capacityAxisLabel,
  cadenceAxisLabel,
  priceAxisLabel,
  RECEIPT_HINT,
} from "../lib/mixFormat";
import { useI18n } from "../lib/i18n";
import { vendorShade } from "../lib/model-colors";
import { billingUnavailable } from "../lib/plan-cost-status";
import type { BillingUnavailableReason } from "../../shared/plan-price-coverage";
import { DataTable, TableRow, EstimateTag, Pill, type Tone } from "./ui";
const KNOWN_SUBSCRIPTION_COLORS: Record<string, string> = {
  codex1: "var(--codex)",
  codex2: vendorShade("var(--codex)", 1),
  codex3: vendorShade("var(--codex)", 2),
  codex: "var(--codex)",
  claude: "var(--claude)",
  anthropic: "var(--claude)",
  grok: "var(--grok)",
  gemini: "var(--gemini)",
  glm: "var(--glm)",
  opencode: "var(--glm)",
};
const FALLBACK_PALETTE = [
  "var(--accent)",
  "var(--ok)",
  "var(--warn)",
  "var(--violet)",
  // Extra series are mixed from the inks, so they follow the theme.
  "color-mix(in oklab, var(--ok) 60%, var(--muted))",
  "color-mix(in oklab, var(--crit) 70%, var(--warn))",
  "color-mix(in oklab, var(--ok) 50%, var(--accent))",
  "color-mix(in oklab, var(--warn) 70%, var(--surface))",
];
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
export function subscriptionColor(id: string): string {
  const k = id.toLowerCase().trim();
  if (KNOWN_SUBSCRIPTION_COLORS[k]) return KNOWN_SUBSCRIPTION_COLORS[k]!;
  if (k.startsWith("codex")) {
    const num = parseInt(k.replace(/\D/g, ""), 10);
    if (!Number.isNaN(num)) {
      return vendorShade("var(--codex)", Math.max(0, num - 1));
    }
    return "var(--codex)";
  }
  if (k.startsWith("claude") || k === "live" || k === "desktop") return "var(--claude)";
  if (k.startsWith("grok")) return "var(--grok)";
  if (k.startsWith("gemini")) return "var(--gemini)";
  if (k.startsWith("opencode") || k.startsWith("glm")) return "var(--glm)";
  return FALLBACK_PALETTE[hashString(k) % FALLBACK_PALETTE.length]!;
}
function capacityTone(b: CapacityBasis): Tone {
  switch (b) {
    case "measured":
      return "ok";
    case "single":
      return "warn";
    case "none":
      return "neutral";
  }
}
export function ProvenanceChip({
  provenance,
  compact,
  style,
  }: {
  provenance: Provenance;
  compact?: boolean;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const absent = provenanceLacksCalibration(provenance);
  const title = provenanceTitle(provenance);
  if (compact) {
    const tone: Tone = absent ? "neutral" : capacityTone(provenance.capacity);
    return (
      <span style={style} title={title}>
        <Pill tone={tone}>{absent ? t("no calibration", "brak kalibracji") : provenanceAxesLine(provenance)}</Pill>
      </span>
    );
  }
  return (
    <span
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap", ...style }}
    >
      <Pill tone={capacityTone(provenance.capacity)}>{capacityAxisLabel(provenance.capacity)}</Pill>
      <Pill tone={provenance.price === "rate-card" ? "ok" : "neutral"}>{priceAxisLabel(provenance.price)}</Pill>
      <Pill
        tone={
          provenance.cadence === "declared"
            ? "ok"
            : provenance.cadence === "probe"
              ? "accent"
              : provenance.cadence === "default"
                ? "violet"
                : "neutral"
        }
      >
        {cadenceAxisLabel(provenance.cadence)}
      </Pill>
      {absent && <EstimateTag>{t("no calibration", "brak kalibracji")}</EstimateTag>}
    </span>
  );
}
export function ReceiptRow({
  label,
  billedUsd,
  equivalents,
  provenance,
  planLabel,
  compact,
  color,
}: {
  label: string;
  billedUsd: number | null;
  equivalents: CapacityEquivalents;
  provenance: Provenance;
  planLabel?: string | null;
  compact?: boolean;
  color?: string;
}) {
  const { t } = useI18n();
  const eqLine = formatEquivalentsLine(equivalents, planLabel);
  const absent = [equivalents.full_5h_sessions, equivalents.weekly_cycles].every(
    (equivalent) => equivalent.absent !== null || !Number.isFinite(equivalent.value),
  );
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        padding: compact ? "6px 0" : "8px 0",
        borderBottom: "var(--rule)",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", gap: 8, alignItems: "flex-start" }}>
        {color && (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "var(--r-dot)",
              background: color,
              marginTop: 6,
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: compact ? "var(--fs-4)" : "var(--fs-5)", fontWeight: 600, color: "var(--text)" }}>{label}</div>
          <div
            className="mono"
            style={{
              fontSize: "var(--fs-3)",
              color: absent ? "var(--faint)" : "var(--muted)",
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {eqLine}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
        <div
          className="mono"
          title={MONEY_HINT.billed}
          style={{ fontSize: compact ? "var(--fs-4)" : "var(--fs-5)", fontWeight: 500, color: "var(--text)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em" }}
        >
          {billedUsd == null ? t("no declared price", "brak zadeklarowanej ceny") : formatMoney(billedUsd)}
        </div>
        <ProvenanceChip provenance={provenance} compact={compact} />
      </div>
    </div>
  );
}
export function CalibrationChip({ provenance }: { provenance: Provenance }) {
  useI18n();
  const s = calibrationSummary(provenance);
  return (
    <span title={s.detail}>
      <Pill tone={s.tone}>{s.label}</Pill>
    </span>
  );
}
export interface ReceiptLine {
  subId: string;
  plan: string | null;
  color: string;
  billedUsd: number | null;
  billingUnavailableReasons?: BillingUnavailableReason[];
  costAtFullUseUsd: number | null;
  apiUsd: number;
  equivalents: CapacityEquivalents;
  provenance: Provenance;
  seatTime?: SeatTime | null;
  tokensByType?: TokenTypeBreakdown | null;
  usdByType?: TokenTypeBreakdown | null;
}
function tokenColumns(t: (en: string, pl: string) => string): Array<{ key: keyof TokenTypeBreakdown; label: string; hint: string }> {
  return [
    { key: "in_uncached", label: "input", hint: t("fresh input - input tokens not from cache", "świeży input - tokeny wejściowe, które nie wyszły z cache") },
    { key: "cache_read", label: "cache", hint: t("input served from cache - about 97% of Codex input traffic", "input podany z cache - u Codeksa ~97% ruchu wejściowego") },
    { key: "cache_write", label: t("write", "zapis"), hint: t("cache writes (Claude 5m and 1h combined)", "zapis do cache (u Claude'a 5m + 1h razem)") },
    { key: "out", label: t("output", "output"), hint: t("output including reasoning tokens", "output razem z tokenami rozumowania") },
  ];
}
function typeUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return formatMoney(v);
}
function perMillionHint(tokens: number, usd: number | null): string {
  if (usd == null || tokens <= 0) return "";
  return ` · efektywnie $${((usd / tokens) * 1e6).toFixed(2)}/1M`;
}
function seatMonthsQty(months: number): string {
  if (months > 0 && months < 0.1) return months.toFixed(2);
  return formatQty(months);
}
// Table head and rows as in .ui-table: a solid rule under the head, dashed rules between rows.
const HEAD: CSSProperties = {
  fontSize: "var(--fs-3)",
  color: "var(--muted)",
  fontWeight: 400,
  padding: "0 0 var(--s-4)",
  borderBottom: "1px solid var(--line2)",
  whiteSpace: "nowrap",
};
const CELL: CSSProperties = {
  padding: "var(--s-4) 0",
  borderTop: "var(--rule)",
  fontSize: "var(--fs-4)",
  whiteSpace: "nowrap",
};
// Numeric columns speak in the figure voice.
const NUM: CSSProperties = { ...CELL, fontFamily: "var(--font-figure)", letterSpacing: "-0.02em" };
export function ReceiptTable({ lines, dense, nameOf = id => id }: { lines: ReceiptLine[]; dense?: boolean; nameOf?: (id: string) => string }) {
  const { t } = useI18n();
  const columns = useMemo(() => tokenColumns(t), [t]);
  const anyBilled = lines.some((l) => l.billedUsd != null);
  const anyFull = lines.some((l) => l.costAtFullUseUsd != null);
  const totalBilled = anyBilled ? lines.reduce((a, l) => a + (l.billedUsd ?? 0), 0) : null;
  const totalFull = anyFull ? lines.reduce((a, l) => a + (l.costAtFullUseUsd ?? 0), 0) : null;
  const totalApi = lines.reduce((a, l) => a + l.apiUsd, 0);
  const totalTok: TokenTypeBreakdown = { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 };
  const totalTypeUsd: TokenTypeBreakdown = { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 };
  let anyTypeTok = false;
  let anyTypeUsd = false;
  let allTypeUsd = true;
  for (const l of lines) {
    if (l.tokensByType) {
      anyTypeTok = true;
      for (const c of columns) totalTok[c.key] += l.tokensByType[c.key];
    }
    if (l.usdByType) {
      anyTypeUsd = true;
      for (const c of columns) totalTypeUsd[c.key] += l.usdByType[c.key];
    } else {
      allTypeUsd = false;
    }
  }
  const verdict = utilisationVerdict(totalBilled, totalFull);
  const noSum = t("Windows from different plans have no common unit, so these two columns cannot be summed.", "Okna różnych planów nie mają wspólnej jednostki, więc te dwie kolumny nie mają sumy.");
  return (
    <div style={{ overflowX: "auto" }}>
      <DataTable tableId="mix:0" style={{ width: "100%", borderCollapse: "collapse", minWidth: dense ? 360 : 980 }}>
        <thead>
          <TableRow header>
            <th data-column-id="c0" style={{ ...HEAD, textAlign: "left" }}>{t("subscription", "abonament")}</th>
            {!dense && (
              <th data-column-id="c1" style={{ ...HEAD, textAlign: "right" }} title={RECEIPT_HINT.sessions}>
                {t("5h sessions", "sesje 5h")}
              </th>
            )}
            <th data-column-id="c2" style={{ ...HEAD, textAlign: "right" }} title={RECEIPT_HINT.weekly}>
              {t("weekly sub.", "tyg. ab.")}
            </th>
            <th data-column-id="c3" style={{ ...HEAD, textAlign: "right" }} title={RECEIPT_HINT.monthly}>
              {t("monthly sub.", "mies. ab.")}
            </th>
            {!dense &&
              columns.map((c) => (
                <th data-column-id="c4"
                  key={c.key}
                  style={{ ...HEAD, textAlign: "right" }}
                  title={`${c.hint}. ${t("Below the token count: cost of this type at API list price.", "Pod liczbą tokenów: koszt tego typu w cenniku API.")}`}
                >
                  {c.label}
                </th>
              ))}
            <th data-column-id="c5" style={{ ...HEAD, textAlign: "right" }} title={MONEY_HINT.api}>
              {t("API list price", "cennik API")}
            </th>
            <th data-column-id="c6" style={{ ...HEAD, textAlign: "right" }} title={RECEIPT_HINT.fullUse}>
              {t("$ by capacity", "$ wg pojemności")}
            </th>
            <th data-column-id="c7" style={{ ...HEAD, textAlign: "right" }} title={RECEIPT_HINT.actual}>
              {t("$ by calendar", "$ wg kalendarza")}
            </th>
            {!dense && (
              <th data-column-id="c8"
                style={{ ...HEAD, textAlign: "right" }}
                title={t(
                  "Coverage of the subscription window capacity measurement. It affects capacity conversions only, not actual amounts.",
                  "Pokrycie pomiaru pojemności okna abonamentu; wpływa tylko na przeliczenia pojemności, nie na rzeczywiste kwoty.",
                )}
              >
                  {t("window measurement", "pomiar okna")}
              </th>
            )}
          </TableRow>
        </thead>
        <tbody>
          {lines.map((l) => {
            const verdict = utilisationVerdict(l.billedUsd, l.costAtFullUseUsd);
            return (
              <TableRow key={l.subId}>
                <td style={{ ...CELL, whiteSpace: "normal" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span
                      aria-hidden
                      style={{ width: 7, height: 7, borderRadius: "var(--r-dot)", background: l.color, flexShrink: 0 }}
                    />
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{nameOf(l.subId)}</span>
                    {l.plan && (
                      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                        {l.plan}
                      </span>
                    )}
                  </div>
                </td>
                {!dense && (
                  <td className="mono" style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}>
                    {formatEquivalentQty(l.equivalents.full_5h_sessions)}
                  </td>
                )}
                <td className="mono" style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}>
                  {formatEquivalentQty(l.equivalents.weekly_cycles)}
                </td>
                <td className="mono" style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}>
                  {formatEquivalentQty(l.equivalents.monthly_subscriptions)}
                </td>
                {!dense &&
                  columns.map((c) => {
                    const tok = l.tokensByType?.[c.key] ?? null;
                    const cost = l.usdByType?.[c.key] ?? null;
                    return (
                      <td
                        key={c.key}
                        className="mono"
                        title={
                          tok == null
                            ? c.hint
                            : `${full(tok)} tok (${c.label})${perMillionHint(tok, cost)}${cost == null ? ` · ${t("type cost unknown - vendor values the total with its own counter", "koszt typu nieznany - vendor wycenia całość własnym licznikiem")}` : ""}`
                        }
                        style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}
                      >
                        <div>{tok == null ? "—" : compact(tok)}</div>
                        <div style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
                          {cost == null ? "—" : typeUsd(cost)}
                        </div>
                      </td>
                    );
                  })}
                <td
                  className="mono"
                  title={MONEY_HINT.api}
                  style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}
                >
                  {formatMoney(l.apiUsd)}
                </td>
                <td
                  className="mono"
                  title={RECEIPT_HINT.fullUse}
                  style={{ ...NUM, textAlign: "right", color: "var(--muted)" }}
                >
                  {l.costAtFullUseUsd == null ? "—" : formatMoney(l.costAtFullUseUsd)}
                </td>
                <td style={{ ...CELL, textAlign: "right" }}>
                  <div className="mono" title={l.billedUsd == null ? billingUnavailable(l.billingUnavailableReasons).hint : MONEY_HINT.billed} style={{ fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em" }}>
                    {l.billedUsd == null ? billingUnavailable(l.billingUnavailableReasons).label : formatMoney(l.billedUsd)}
                  </div>
                  {l.seatTime != null && Number.isFinite(l.seatTime.months) && (
                    <div
                      className="mono"
                      title={t("The same amount expressed as subscription TIME: calendar $ ÷ declared monthly price. This is purchased plan time; the weekly/monthly subscription columns on the left measure capacity.", "Ta sama kwota wyrażona w CZASIE abonamentu: $ wg kalendarza ÷ deklarowana cena miesięczna. To wykupiony czas planu — kolumny „tyg./mies. ab.” po lewej mierzą co innego: pojemność.")}
                      style={{ fontSize: "var(--fs-2)", color: "var(--muted)" }}
                    >
                      = {seatMonthsQty(l.seatTime.weeks)} {t("weeks", "tyg.")} / {seatMonthsQty(l.seatTime.months)} {t("months", "mies.")} {t("of plan", "planu")}
                    </div>
                  )}
                  {verdict && (
                    <div
                      className="mono"
                      title={verdict.hint}
                      style={{ fontSize: "var(--fs-2)", color: verdict.tone === "warn" ? "var(--warn)" : "var(--faint)" }}
                    >
                      {verdict.label}
                      {verdict.impossible && " ⚠"}
                    </div>
                  )}
                </td>
                {!dense && (
                  <td style={{ ...CELL, textAlign: "right" }}>
                    <CalibrationChip provenance={l.provenance} />
                  </td>
                )}
              </TableRow>
            );
          })}
        </tbody>
        <tfoot>
          <TableRow>
            <td style={{ ...CELL, borderTop: "1px solid var(--line2)", fontWeight: 600, color: "var(--muted)" }}>
              {t("total", "razem")}
            </td>
            {!dense && <td style={{ ...CELL, borderTop: "1px solid var(--line2)" }} />}
            <td
              className="mono"
              title={noSum}
              style={{ ...CELL, borderTop: "1px solid var(--line2)", textAlign: "right", color: "var(--faint)", fontSize: "var(--fs-2)" }}
            >
              {t("not summed", "bez sumy")}
            </td>
            <td
              className="mono"
              title={noSum}
              style={{ ...CELL, borderTop: "1px solid var(--line2)", textAlign: "right", color: "var(--faint)", fontSize: "var(--fs-2)" }}
            >
              {t("not summed", "bez sumy")}
            </td>
            {!dense &&
              columns.map((c) => (
                <td
                  key={c.key}
                  className="mono"
                  title={
                    anyTypeTok
                          ? `${full(totalTok[c.key])} tok (${c.label})${anyTypeUsd && !allTypeUsd ? ` · ${t("sum $ excludes rows whose types cannot be priced (grok)", "suma $ bez wierszy, których typów nie da się wycenić (grok)")}` : ""}`
                      : c.hint
                  }
                  style={{ ...NUM, borderTop: "1px solid var(--line2)", textAlign: "right", color: "var(--muted)" }}
                >
                  <div>{anyTypeTok ? compact(totalTok[c.key]) : "—"}</div>
                  <div style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>
                    {anyTypeUsd ? typeUsd(totalTypeUsd[c.key]) : "—"}
                  </div>
                </td>
              ))}
            <td
              className="mono"
              title={MONEY_HINT.api}
              style={{ ...NUM, borderTop: "1px solid var(--line2)", textAlign: "right", color: "var(--muted)" }}
            >
              {formatMoney(totalApi)}
            </td>
            <td
              className="mono"
              style={{ ...NUM, borderTop: "1px solid var(--line2)", textAlign: "right", color: "var(--muted)" }}
            >
              {totalFull == null ? "—" : formatMoney(totalFull)}
            </td>
            <td style={{ ...CELL, borderTop: "1px solid var(--line2)", textAlign: "right" }}>
              <div
                className="mono"
                style={{ fontWeight: 600, color: totalBilled == null ? "var(--faint)" : "var(--text)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em" }}
              >
                {totalBilled == null ? billingUnavailable().label : `${lines.some(l => l.billedUsd == null) ? "≥ " : ""}${formatMoney(totalBilled)}`}
              </div>
              {verdict && (
                <div
                  className="mono"
                  title={verdict.hint}
                  style={{ fontSize: "var(--fs-2)", color: verdict.tone === "warn" ? "var(--warn)" : "var(--faint)" }}
                >
                  {verdict.label}
                  {verdict.impossible && " ⚠"}
                </div>
              )}
            </td>
            {!dense && <td style={{ ...CELL, borderTop: "1px solid var(--line2)" }} />}
          </TableRow>
        </tfoot>
      </DataTable>
    </div>
  );
}
export function ReceiptLegend() {
  const { language, t } = useI18n();
  const items: Array<[string, string]> = [
    [t("weekly / monthly subs.", "tyg. / mies. ab."), t("How many full windows of this plan this work would consume at API prices. Capacity, not time.", "ile PEŁNYCH okien tego planu ważyłaby ta praca w cenach API — pojemność, nie czas")],
    [t("input / cache / write / output", "input / cache / zapis / output"), t("Tokens by type. The line below shows the cost of that type at API list price; the tooltip shows the effective price per 1M.", "tokeny wg typu; pod liczbą koszt tego typu w cenniku API, w dymku efektywna cena za 1M")],
    [t("API list price", "cennik API"), t("What the same traffic would cost without a subscription. A counterfactual used for shares and capacity.", "ile ten sam ruch kosztowałby bez abonamentu — kontrfakt; z tej kwoty liczą się udziały i pojemność")],
    [t("$ by capacity", "$ wg pojemności"), t("Price for the capacity actually used. It is the number of full plan months represented by this work.", "cena za pojemność faktycznie zużytą — tyle pełnych miesięcy planu, ile ta praca waży")],
    [t("$ by calendar", "$ wg kalendarza"), t("Plan price proportional to calendar days and traffic share. It includes windows that were not fully used.", "cena planu proporcjonalna do dni × udział w ruchu — niesie w sobie okna niedopalone")],
    [t("= N weeks / months of plan", "= N tyg. / mies. planu"), t("The same amount divided by the monthly price. Purchased subscription time, while the weekly and monthly columns measure used capacity.", "ta sama kwota ÷ cena miesięczna: wykupiony CZAS abonamentu (okna liczone po cenie planu) — nie mylić z „tyg./mies. ab.”, które mierzą zużytą pojemność")],
    [t("used N%", "wyk. N%"), t("The share of subscription capacity used in this period. Above 100% (⚠) is impossible and indicates an understated window.", "jaka część pojemności abonamentu poszła w tym okresie — cena się w tym ilorazie skraca; ponad 100% (⚠) jest niemożliwe i znaczy zaniżone okno")],
    [t("window measurement", "pomiar okna"), t("Coverage 68% means calibration dates overlap 68% of the selected range. It is not the percentage of limit used. A 1-reading label describes sample quality; later non-zero readings improve it.", "„pokrycie 68%” znaczy, że daty kalibracji nakładają się na 68% wybranego zakresu — to nie jest procent wykorzystania limitu; „1 odczyt” opisuje jakość próbki, którą poprawiają kolejne niezerowe odczyty z następnych okien")],
  ];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 8 }}>
      {items.map(([k, v]) => (
        <span key={k} style={{ fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>{k}</strong>{language === "pl" ? " — " : " - "}{v}
        </span>
      ))}
    </div>
  );
}
