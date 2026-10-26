import { Bar, Card, CardTitle, Pill } from "../../components/ui";
import { TableGrid, TableGridRow } from "../../components/DataTable";
import { compact, pct } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { apiEq, type Tinted } from "./format";

export function CompareView({
  accounts,
  total,
  valueOf,
  money,
}: {
  accounts: Tinted[];
  total: number;
  valueOf: (s: { tokens: number; usd: number | null; priced_usd?: number }) => number;
  money: boolean;
}) {
  const { t } = useI18n();
  const maxVal = Math.max(...accounts.map(valueOf), 1);
  const maxCalls = Math.max(...accounts.map((a) => a.calls), 1);
  const perCall = (a: Tinted) => (a.calls > 0 ? valueOf(a) / a.calls : 0);
  const maxPerCall = Math.max(...accounts.map(perCall), 1);
  return (
    <Card>
      <CardTitle
        title={t("Subscription by subscription", "Subskrypcja przy subskrypcji")}
        help={`${t("Three bars per row, each relative to its own maximum:", "Trzy paski na wiersz, każdy względem własnego maksimum:")} ${money ? t("API-equivalent cost", "koszt API-eq") : t("usage", "zużycie")}, ${t("number of calls and", "liczba wywołań i")} ${money ? t("cost", "koszt") : t("usage", "zużycie")} ${t("per call. Different lengths mean the subscription works differently, not only more.", "na jedno wywołanie. Różna długość = ta subskrypcja pracuje inaczej, nie tylko więcej.")}`}
      />
      <TableGrid tableId="AllAggregate:subscriptions"><div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 12 }}>
        <TableGridRow header
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: "150px repeat(3, minmax(0, 1fr))",
            gap: 14,
            fontSize: "var(--fs-3)",
            color: "var(--muted)",
            paddingBottom: 6,
            borderBottom: "1px solid var(--line2)",
          }}
        >
          <span>{t("subscription", "subskrypcja")}</span>
          <span>{money ? t("API-equivalent cost", "koszt API-eq") : t("token usage", "zużycie w tokenach")}</span>
          <span>{t("calls", "wywołania")}</span>
          <span>{money ? t("cost per call", "koszt na wywołanie") : t("tokens per call", "tokeny na wywołanie")}</span>
        </TableGridRow>
        {accounts.map((a) => (
          <TableGridRow
            key={a.id}
            style={{
              display: "grid",
              gridTemplateColumns: "150px repeat(3, minmax(0, 1fr))",
              gap: 14,
              alignItems: "center",
              padding: "9px 0",
              borderBottom: "var(--rule)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: a.color, flex: "0 0 8px" }} />
              <span className="mono" title={a.label} style={{ fontWeight: 600, fontSize: "var(--fs-4)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.label}
              </span>
              <Pill tone="neutral">{a.vendor}</Pill>
            </div>
            <BarCell label={money ? apiEq(a) : compact(valueOf(a))} frac={valueOf(a) / maxVal} color={a.color} />
            <BarCell label={compact(a.calls)} frac={a.calls / maxCalls} color={a.color} />
            <BarCell
              label={money ? apiEq(a, a.usd === null && a.priced_usd === undefined ? null : perCall(a)) : compact(perCall(a))}
              frac={perCall(a) / maxPerCall}
              color={a.color}
              sub={total > 0 ? `${pct((valueOf(a) / total) * 100)} ${t("of total", "całości")}` : undefined}
            />
          </TableGridRow>
        ))}
      </div></TableGrid>
    </Card>
  );
}
function BarCell({ label, frac, color, sub }: { label: string; frac: number; color: string; sub?: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: "var(--fs-4)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", marginBottom: 3 }}>
        {label}
        {sub && <span style={{ color: "var(--faint)", marginLeft: 6, fontSize: "var(--fs-2)" }}>{sub}</span>}
      </div>
      <Bar value={Math.max(0, Math.min(1, frac)) * 100} color={color} />
    </div>
  );
}
