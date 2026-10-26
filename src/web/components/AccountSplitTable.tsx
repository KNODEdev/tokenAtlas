import { DataTable, TableRow } from "./ui";
import { OUTSIDE_CODE_PRODUCT_KEY, type ClaudeAccountSplit } from "../../shared/claude-code-capacity";
import { compact, pct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";

/**
 * The whole Claude account of one weekly window, split by the vendor's surfaces. Claude Code is
 * the measured row; every other row and the total are estimates derived from the same reading,
 * so they carry "≈" and a label instead of passing for measurements.
 */
export function AccountSplitTable({ split }: { split: ClaudeAccountSplit }) {
  const { t } = useI18n();
  const rows = [...split.rows].sort((a, b) => Number(b.measured) - Number(a.measured) || b.percent - a.percent);
  const approx = (measured: boolean, text: string) => (measured ? text : `≈ ${text}`);
  const cell = { padding: "var(--s-2) 0", borderBottom: "var(--rule)", textAlign: "right" as const };
  // Amounts in the figure voice, like the tables' numeric columns.
  const num = { ...cell, fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" };
  const head = { ...cell, borderBottom: "1px solid var(--line2)", fontWeight: "var(--fw-regular)" };
  const basis = (measured: boolean) => (
    <td style={{ ...cell, color: measured ? "var(--ok)" : "var(--muted)" }}>
      {measured ? t("measured", "zmierzone") : t("estimate", "szacunek")}
    </td>
  );
  return (
    <DataTable tableId="AccountSplitTable:0" className="mono" style={{ width: "100%", marginTop: "var(--s-3)", fontSize: "var(--fs-3)", borderCollapse: "collapse", color: "var(--text)" }}>
      <thead>
        <TableRow header style={{ color: "var(--muted)" }}>
          <th data-column-id="c0" style={{ ...head, textAlign: "left" }}>{t("Surface", "Produkt")}</th>
          <th data-column-id="c1" style={head}>{t("share", "udział")}</th>
          <th data-column-id="c2" style={head}>{t("API-eq", "API-eq")}</th>
          <th data-column-id="c3" style={head}>{t("tokens", "tokeny")}</th>
          <th data-column-id="c4" style={head} aria-label={t("Basis", "Podstawa")} />
        </TableRow>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <td style={{ ...cell, textAlign: "left" }}>
              {row.key === OUTSIDE_CODE_PRODUCT_KEY
                ? t("Outside Claude Code (no split read)", "Poza Claude Code (bez odczytu podziału)")
                : row.display_name ?? row.key}
            </td>
            <td style={num}>{pct(row.percent)}</td>
            <td style={num}>{row.api_usd == null ? "—" : approx(row.measured, usd(row.api_usd))}</td>
            <td style={num}>{row.tokens == null ? "—" : approx(row.measured, compact(row.tokens))}</td>
            {basis(row.measured)}
          </TableRow>
        ))}
        <TableRow style={{ fontWeight: "var(--fw-semibold)" }}>
          <td style={{ ...cell, borderBottom: 0, textAlign: "left" }}>{t("Whole account", "Całe konto")}</td>
          <td style={{ ...num, borderBottom: 0 }}>{pct(100)}</td>
          <td style={{ ...num, borderBottom: 0 }}>{split.account_api_usd == null ? "—" : approx(false, usd(split.account_api_usd))}</td>
          <td style={{ ...num, borderBottom: 0 }}>{split.account_tokens == null ? "—" : approx(false, compact(split.account_tokens))}</td>
          {basis(false)}
        </TableRow>
      </tbody>
    </DataTable>
  );
}
