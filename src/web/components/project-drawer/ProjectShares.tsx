import { compact, full, pct } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { formatMoney, MONEY_HINT } from "../../lib/mixFormat";
import { ErrorState, HelpBlock, HelpDot, LoadingCard, Table, Td, Th } from "../ui";
import { QuestionSection } from "./presentation";
import type { ProjectShares as Shares, ShareRow } from "./shares";

const RING = { size: 132, radius: 52, width: 16, gap: 2 };

/** The whole API value as a ring of its parts; the total stands in the middle, each part's numbers in its tooltip. */
function ShareDonut({ rows, label, total }: { rows: ShareRow[]; label: string; total: number }) {
  const { t } = useI18n();
  const circumference = 2 * Math.PI * RING.radius;
  const parts = rows.filter(row => row.apiShare > 0);
  // A single part is a closed ring; otherwise each arc leaves a surface gap before the next one.
  const gap = parts.length > 1 ? RING.gap : 0;
  let start = 0;
  return (
    <svg role="img" aria-label={label} width={RING.size} height={RING.size} viewBox={`0 0 ${RING.size} ${RING.size}`} style={{ flex: `0 0 ${RING.size}px` }}>
      <g transform={`rotate(-90 ${RING.size / 2} ${RING.size / 2})`}>
        {parts.map(row => {
          const length = (row.apiShare / 100) * circumference;
          const arc = <circle key={row.key || "rest"} data-share-arc={row.key} cx={RING.size / 2} cy={RING.size / 2} r={RING.radius} fill="none"
            stroke={row.color} strokeWidth={RING.width} strokeDasharray={`${Math.max(length - gap, 0.5)} ${circumference}`} strokeDashoffset={-start}>
            <title>{`${row.label}: ${pct(row.apiShare, 1)} ${t("of API value", "wartości API")} · ${formatMoney(row.apiUsd)} · ${full(row.tokens)} ${t("tokens", "tokenów")}`}</title>
          </circle>;
          start += length;
          return arc;
        })}
      </g>
      <text x="50%" y="48%" textAnchor="middle" className="ui-figure" style={{ fill: "var(--text)", fontSize: "var(--fs-4)" }}>{formatMoney(total)}</text>
      <text x="50%" y="62%" textAnchor="middle" style={{ fill: "var(--muted)", fontSize: "var(--fs-2)" }}>{t("API list price", "cennik API")}</text>
    </svg>
  );
}

function ShareTable({ id, heading, rows, total, billed }: { id: string; heading: string; rows: ShareRow[]; total: number; billed?: boolean }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-10)", minWidth: 0 }} data-shares={id}>
      <ShareDonut rows={rows} label={heading} total={total} />
      <div style={{ flex: 1, minWidth: 0 }}><Table tableId={`ProjectDrawer:shares:${id}`}>
        <thead>
          <tr>
            <Th columnId="name">{heading}</Th>
            <Th columnId="tokens" align="right" title={t("Priced tokens of this part", "Wycenione tokeny tej części")}>{t("tokens", "tokeny")}</Th>
            <Th columnId="token-share" align="right" title={t("Share of the project's priced tokens", "Udział w wycenionych tokenach projektu")}>%</Th>
            <Th columnId="api" align="right" title={MONEY_HINT.api}>{t("API list price", "cennik API")}</Th>
            <Th columnId="api-share" align="right" title={t("Share of the project's value at API prices", "Udział w wartości projektu wg cennika API")}>%</Th>
            {billed && <Th columnId="billed" align="right" title={MONEY_HINT.billed}>{t("subscriptions", "abonamenty")}</Th>}
            {billed && <Th columnId="billed-share" align="right" title={t("Share of the known cost from your subscriptions", "Udział w znanym koszcie Twoich abonamentów")}>%</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key || "rest"} data-share-row={row.key}>
              <Td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-3)", minWidth: 0 }}>
                  <span aria-hidden style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: row.color, flex: "0 0 8px" }} />
                  <span title={row.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
                </span>
              </Td>
              <Td align="right" mono title={full(row.tokens)}>{compact(row.tokens)}</Td>
              <Td align="right" mono style={{ color: "var(--muted)" }}>{pct(row.tokenShare, 1)}</Td>
              <Td align="right" mono>{formatMoney(row.apiUsd)}</Td>
              <Td align="right" mono style={{ fontWeight: "var(--fw-semibold)" }}>{pct(row.apiShare, 1)}</Td>
              {billed && <Td align="right" mono title={row.billedIncomplete ? t("Known part only: some subscription has no price for this range", "Tylko znana część: część abonamentów nie ma wyceny w tym zakresie") : undefined}>
                {row.billedUsd == null ? <span className="ui-missing">{t("no price", "brak wyceny")}</span> : `${row.billedIncomplete ? "≥ " : ""}${formatMoney(row.billedUsd)}`}
              </Td>}
              {billed && <Td align="right" mono style={{ color: "var(--muted)" }}>{row.billedShare == null ? "—" : pct(row.billedShare, 1)}</Td>}
            </tr>
          ))}
        </tbody>
      </Table></div>
    </div>
  );
}

/** Summary tab: the project's priced traffic split by subscription provider and by model. */
export function ProjectSharesSection({ shares, pending, error, onRetry }: {
  shares: Shares | null;
  pending: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <QuestionSection
      data="shares"
      title={t("What did it consist of?", "Z czego się składał?")}
      help={
        <HelpDot label={t("About these shares", "O tych udziałach")}>
          <HelpBlock>{t("Shares of the project's priced traffic in the selected range. The ring shows the share of the value at API prices.", "Udziały w wycenionym ruchu projektu w wybranym zakresie. Koło pokazuje udział w wartości wg cennika API.")}</HelpBlock>
          <HelpBlock>{t("Calls without a price are not included; they are listed in the report's data coverage. A model cannot carry a share of the subscription cost: that cost is known only per subscription.", "Wywołania bez ceny nie są wliczone; pokazuje je pokrycie danych raportu. Model nie dostaje udziału w koszcie abonamentów: ten koszt jest znany tylko dla całego abonamentu.")}</HelpBlock>
        </HelpDot>
      }
    >
      {error != null ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : pending ? (
        <LoadingCard label={t("Loading project cost data...", "Wczytuję dane kosztowe projektu...")} height={110} shape="kpi" />
      ) : !shares || shares.providers.length === 0 ? (
        <span className="ui-missing" style={{ fontSize: "var(--fs-3)" }}>{t("No priced traffic in the selected period.", "Brak wycenionego ruchu w wybranym okresie.")}</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-10)" }}>
          <ShareTable id="providers" heading={t("provider", "dostawca")} rows={shares.providers} total={shares.apiUsd} billed />
          {shares.models ? (
            <ShareTable id="models" heading={t("model", "model")} rows={shares.models} total={shares.apiUsd} />
          ) : (
            <span className="ui-missing" style={{ fontSize: "var(--fs-3)" }}>{t("The model split needs a newer server.", "Podział na modele wymaga nowszego serwera.")}</span>
          )}
        </div>
      )}
    </QuestionSection>
  );
}
