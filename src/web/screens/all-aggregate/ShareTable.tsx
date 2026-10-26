import { useDisclosure } from "../../lib/disclosure";
import { useState } from "react";
import { Card, CardTitle, Disclosure, Pill, Table, TableRow, Td, Th } from "../../components/ui";
import { compact, pct } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { apiEq, formatNumber, type Tinted } from "./format";

export function ShareTable({
  accounts,
  total,
  valueOf,
  folded = false,
}: {
  accounts: Tinted[];
  total: number;
  valueOf: (s: { tokens: number; usd: number | null; priced_usd?: number }) => number;
  /** Analytics repeats History's table, so the viewer can fold it; the choice is remembered (IA-43). */
  folded?: boolean;
}) {
  const { t, locale } = useI18n();
  const [foldedOpen, setFoldedOpen] = useDisclosure("aggregate:share-table");
  const open = !folded || foldedOpen;
  const setOpen = setFoldedOpen;
  const formatDate = (iso: string | null) => iso ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "—";
  return (
    <Card pad="0">
      <div style={{ padding: "var(--s-8) var(--s-9) var(--s-2)" }}>
        <CardTitle title={t("Subscription share", "Udział subskrypcji")} help={t("All indexed usage, regardless of limit windows.", "Całe zaindeksowane zużycie, niezależnie od okien limitu.")}
          right={folded ? <Disclosure open={open} onToggle={() => setOpen(!open)}>{open ? t("hide", "zwiń") : t("show {0} rows", `pokaż ${accounts.length} wierszy`, [accounts.length])}</Disclosure> : undefined} />
      </div>
      {open && <Table tableId="AllAggregate:1">
        <thead>
          <TableRow header>
            <Th columnId="c0">{t("subscription", "subskrypcja")}</Th>
            <Th columnId="c1">{t("vendor", "vendor")}</Th>
            <Th columnId="c2" align="right">{t("tokens", "tokeny")}</Th>
             <Th columnId="c3" align="right">{t("API-equivalent", "API-eq")}</Th>
            <Th columnId="c4" align="right">{t("calls", "wywołania")}</Th>
            <Th columnId="c5" align="right">{t("share", "udział")}</Th>
            <Th columnId="c6">{t("range", "zakres")}</Th>
          </TableRow>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <TableRow key={a.id}>
              <Td mono>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: a.color }} />
                  <b>{a.label}</b>
                </span>
              </Td>
              <Td>
                <Pill tone="neutral">{a.vendor}</Pill>
              </Td>
              <Td align="right" mono title={formatNumber(a.tokens, locale)}>
                {compact(a.tokens)}
              </Td>
              <Td align="right" mono>
                {apiEq(a)}
              </Td>
              <Td align="right" mono>
                {compact(a.calls)}
              </Td>
              <Td align="right" mono>
                {total > 0 ? pct((valueOf(a) / total) * 100) : "—"}
              </Td>
              <Td mono style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
                {formatDate(a.first_ts)} → {formatDate(a.last_ts)}
              </Td>
            </TableRow>
          ))}
        </tbody>
      </Table>}
    </Card>
  );
}
