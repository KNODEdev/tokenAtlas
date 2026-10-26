import { TableGrid, TableGridRow } from "./DataTable";
import type { CycleUsageRow } from "../lib/api";
import { compact, full, pct, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { modelColors } from "../lib/model-colors";
import { Eyebrow } from "./ui";
export interface ModelShare extends CycleUsageRow {
  color: string;
  share: number;
  pp: number | null;
}
export function modelShares(
  rows: CycleUsageRow[],
  usedPercent: number | null,
  limit = 6
): { shares: ModelShare[]; totalTokens: number; totalUsd: number } {
  const sorted = [...rows].filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const totalTokens = sorted.reduce((a, r) => a + r.tokens, 0);
  const totalUsd = sorted.reduce((a, r) => a + r.usd, 0);
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const merged: CycleUsageRow[] =
    tail.length > 0
      ? [
          ...head,
          tail.reduce(
            (acc, r) => ({
              name: acc.name,
              calls: acc.calls + r.calls,
              tokens: acc.tokens + r.tokens,
              fresh: acc.fresh + r.fresh,
              usd: acc.usd + r.usd,
              ...((acc.usd_partial || r.usd_partial) ? { usd_partial: true } : {}),
            }),
            { name: `${translate("other", "pozostałe")} (${tail.length})`, calls: 0, tokens: 0, fresh: 0, usd: 0 } as CycleUsageRow
          ),
        ]
      : head;
  const fills = modelColors(head.map((r) => r.name));
  return {
    totalTokens,
    totalUsd,
    shares: merged.map((r, i) => {
      const share = totalTokens > 0 ? (r.tokens / totalTokens) * 100 : 0;
      const isRest = tail.length > 0 && i === merged.length - 1;
      return {
        ...r,
        color: isRest ? "var(--faint)" : fills[i]!,
        share,
        pp: usedPercent != null ? (share / 100) * usedPercent : null,
      };
    }),
  };
}
export function ModelShareBar({
  rows,
  usedPercent,
  limit = 6,
  dense = false,
}: {
  rows: CycleUsageRow[];
  usedPercent: number | null;
  limit?: number;
  dense?: boolean;
}) {
  const { t } = useI18n();
  const { shares, totalTokens, totalUsd } = modelShares(rows, usedPercent, limit);
  const partialUsd = rows.some(row => row.tokens > 0 && row.usd_partial);
  const costLabel = (row: CycleUsageRow) => row.usd_partial
    ? row.usd > 0 ? `≥ ${usd(row.usd)}` : "—"
    : usd(row.usd);
  if (shares.length === 0) {
    return (
      <div>
        <Eyebrow>{t("Model share of usage", "Udział modeli w zużyciu")}</Eyebrow>
        <div className="mono" style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {t("The index has no calls assigned to this window yet.", "Indeks nie ma jeszcze wywołań przypisanych do tego okna.")}
        </div>
      </div>
    );
  }
  const COLS = "minmax(0,1fr) 64px 52px 60px 58px";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
        <Eyebrow>{t("Model share of usage", "Udział modeli w zużyciu")}</Eyebrow>
        <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          100% ={" "}
          <b style={{ color: "var(--text)" }}>{usedPercent != null ? pct(usedPercent) : compact(totalTokens)}</b>{" "}
          {usedPercent != null ? t("allowance used", "wykorzystanego limitu") : t("tokens", "tokenów")}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          height: 14,
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
          border: "1px solid var(--line)",
          background: "var(--sunk)",
        }}
      >
        {shares.map((s) => (
          <div
            key={s.name}
            title={`${s.name}: ${pct(s.share, 1)} ${t("of usage", "zużycia")}${
                s.pp != null ? ` = ${s.pp.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp ${t("allowance", "limitu")}` : ""
            } · ${full(s.tokens)} ${t("tokens", "tokenów")} · ${costLabel(s)} API-eq`}
            style={{ width: `${s.share}%`, background: s.color, minWidth: s.share > 0 ? 2 : 0 }}
          />
        ))}
      </div>
      {dense ? (
        <div className="mono" style={{ marginTop: 5, fontSize: "var(--fs-2)", color: "var(--muted)" }}>
          {shares
            .slice(0, 3)
            .map((s) => `${s.name} ${s.share.toFixed(0)}%`)
            .join(" · ")}
          {shares.length > 3 ? ` · +${shares.length - 3}` : ""}
        </div>
      ) : (
        <TableGrid tableId="ModelShareBar:models"><div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
          <TableGridRow header
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 8,
              padding: "0 0 var(--s-2)",
              borderBottom: "1px solid var(--line2)",
              fontSize: "var(--fs-2)",
              color: "var(--muted)",
            }}
          >
            <span>{t("model", "model")}</span>
            <span style={{ textAlign: "right" }}>{t("tokens", "tokeny")}</span>
            <span style={{ textAlign: "right" }}>{t("share", "udział")}</span>
            <span style={{ textAlign: "right" }}>{t("pp of limit", "pp limitu")}</span>
            <span style={{ textAlign: "right" }}>API-eq</span>
          </TableGridRow>
          {shares.map((s) => (
            <TableGridRow
              key={s.name}
              className="mono"
              style={{ display: "grid", gridTemplateColumns: COLS, gap: 8, alignItems: "center", fontSize: "var(--fs-3)", padding: "var(--s-2) 0", borderBottom: "var(--rule)" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ width: 7, height: 7, borderRadius: "var(--r-bar)", background: s.color, flex: "0 0 7px" }} />
                <span
                  title={s.name}
                  style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {s.name}
                </span>
              </span>
              <span style={{ textAlign: "right", color: "var(--muted)", fontFamily: "var(--font-figure)" }} title={`${full(s.tokens)} ${t("gross tokens", "tokenów brutto")}`}>
                {compact(s.tokens)}
              </span>
              <span style={{ textAlign: "right", color: "var(--text)", fontWeight: 600, fontFamily: "var(--font-figure)" }}>{pct(s.share, 1)}</span>
              <span
                style={{ textAlign: "right", color: s.pp == null ? "var(--faint)" : "var(--warn)", fontFamily: "var(--font-figure)" }}
                title={t("Share × used allowance - how many percentage points of the limit this model used", "Udział × zużytego limitu - ile punktów procentowych limitu wykorzystał ten model")}
              >
                {s.pp == null ? "—" : `${s.pp.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`}
              </span>
              <span style={{ textAlign: "right", color: "var(--ok)", fontFamily: "var(--font-figure)" }} title={s.usd_partial ? t("Incomplete price coverage", "Niepełne pokrycie cenami") : undefined}>{costLabel(s)}</span>
            </TableGridRow>
          ))}
          <div className="mono" style={{ marginTop: "var(--s-3)", fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
            {t("Total", "Razem")} {compact(totalTokens)} {t("tokens", "tokenów")} · {partialUsd ? totalUsd > 0 ? `≥ ${usd(totalUsd)}` : "—" : usd(totalUsd)} API-eq. {t("The pp column distributes used allowance proportionally to tokens - the gauge does not identify which model moved it.", "Kolumna pp rozkłada zużyty limit proporcjonalnie do tokenów - wskaźnik nie mówi, który model go zmienił.")}
          </div>
        </div></TableGrid>
      )}
    </div>
  );
}
