import { useMemo } from "react";
import { api, type BreakdownRow } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { TableRow, Bar, Card, CardTitle, EmptyState, LoadingCard, Table, Td, Th } from "./ui";
import { compact, full, pct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
const UNKNOWN = "?";
export interface CycleModelsProps {
  account: string;
  sinceIso: string;
  untilIso: string;
  projectId?: string;
  cycleLabel: string;
  limit?: number;
  titled?: boolean;
}
export function CycleModels({ account, sinceIso, untilIso, projectId, cycleLabel, limit = 8, titled = true }: CycleModelsProps) {
  const { language, t } = useI18n();
  const state = useAsync(
    signal =>
      api.breakdown({
        dim: "model",
        account,
        since_ts: sinceIso,
        until_ts: untilIso,
        ...(projectId ? { project_id: projectId } : {}),
      }, signal),
    [account, sinceIso, untilIso, projectId]
  );
  const view = useMemo(() => {
    const rows = state.data?.rows ?? [];
    const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
    const totals = sorted.reduce(
      (acc, r) => ({ tokens: acc.tokens + r.tokens, usd: acc.usd + r.usd, calls: acc.calls + r.calls }),
      { tokens: 0, usd: 0, calls: 0 }
    );
    const head = sorted.slice(0, limit);
    const tail = sorted.slice(limit);
    const rest =
      tail.length > 0
        ? tail.reduce(
            (acc, r) => ({ ...acc, tokens: acc.tokens + r.tokens, usd: acc.usd + r.usd, calls: acc.calls + r.calls }),
            { name: `${t("other", "pozostałe")} (${tail.length})`, vendor: tail[0]!.vendor, tokens: 0, usd: 0, calls: 0 } as BreakdownRow
          )
        : null;
    return { head, rest, totals, count: sorted.length };
  }, [language, limit, state.data, t]);
  if (state.loading && !state.data) return <LoadingCard label={t("Loading model breakdown...", "Wczytywanie podziału na modele...")} height={200} shape="table" />;
  if (state.error) {
    return (
      <Card>
        {titled && <CardTitle title={t("Models in this cycle", "Modele w tym cyklu")} sub={cycleLabel} />}
        <EmptyState title={t("Could not calculate model breakdown", "Nie udało się policzyć podziału na modele")} detail={state.error} />
      </Card>
    );
  }
  if (view.count === 0) {
    return (
      <Card>
        {titled && <CardTitle title={t("Models in this cycle", "Modele w tym cyklu")} sub={cycleLabel} />}
        <EmptyState
          title={t("No indexed calls in this window", "Brak zindeksowanych wywołań w tym oknie")}
          detail={t("The cycle window comes from the gauge, while this table comes from the event index. Empty means there are no rollouts for this account in this interval, often because indexing has not seen them yet. Run synchronization and return here.", "Okno cyklu pochodzi ze wskaźnika, a ta tabela z indeksu zdarzeń. Puste znaczy, że dla tego konta nie ma w tym przedziale żadnych rolloutów - najczęściej dlatego, że indeksowanie jeszcze ich nie widziało. Uruchom synchronizację i wróć tutaj.")}
        />
      </Card>
    );
  }
  const max = view.head[0]?.tokens ?? 0;
  return (
    <Card>
      {titled ? (
        <CardTitle
          title={t("Models in this cycle", "Modele w tym cyklu")}
          sub={`${cycleLabel} · ${view.count} ${view.count === 1 ? t("model", "model") : t("models", "modeli")}`}
          help={t("Gross tokens; API equivalent by rate cards.", "Tokeny brutto; API-eq według cenników.")}
          right={
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {compact(view.totals.tokens)} · <span style={{ color: "var(--text)" }}>{usd(view.totals.usd)}</span>
            </span>
          }
        />
      ) : (
        <div
          className="mono"
          style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: "var(--fs-3)", color: "var(--muted)" }}
        >
          <span>
            {cycleLabel} · {view.count} {view.count === 1 ? t("model", "model") : t("models", "modeli")} · {t("gross, API equivalent by rate cards", "brutto, API-eq wg cenników")}
          </span>
          <span>
            {compact(view.totals.tokens)} · <span style={{ color: "var(--text)" }}>{usd(view.totals.usd)}</span>
          </span>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Table tableId="CycleModels:0">
          <thead>
            <TableRow header>
              <Th columnId="c0">{t("model", "model")}</Th>
              <Th columnId="c1" align="right">{t("calls", "wywołania")}</Th>
              <Th columnId="c2" align="right">{t("tokens", "tokeny")}</Th>
              <Th columnId="c3">{t("share", "udział")}</Th>
              <Th columnId="c4" align="right">{t("fresh input", "świeży input")}</Th>
              <Th columnId="c5" align="right">{t("API-equivalent", "API-eq")}</Th>
            </TableRow>
          </thead>
          <tbody>
            {view.head.map((r) => (
              <ModelRow key={r.name} row={r} max={max} total={view.totals.tokens} />
            ))}
            {view.rest && <ModelRow key="__rest" row={view.rest} max={max} total={view.totals.tokens} muted />}
            <TableRow>
              <Td>
          <span style={{ color: "var(--muted)" }}>{t("total", "razem")}</span>
              </Td>
              <Td align="right" mono>
                {full(view.totals.calls)}
              </Td>
              <Td align="right" mono>
                {compact(view.totals.tokens)}
              </Td>
              <Td>
                <span />
              </Td>
              <Td align="right" mono>
                <span style={{ color: "var(--faint)" }}>—</span>
              </Td>
              <Td align="right" mono>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{usd(view.totals.usd)}</span>
              </Td>
            </TableRow>
          </tbody>
        </Table>
      </div>
      <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
        {t("API equivalent values traffic at API list prices - it shows what this cycle would cost without a subscription, not what was paid.", "API-eq wycenia ruch wg cennika API — mówi, ile ten cykl kosztowałby BEZ abonamentu, nie ile zapłacono.")}
      </div>
    </Card>
  );
}
function ModelRow({
  row,
  max,
  total,
  muted,
}: {
  row: BreakdownRow;
  max: number;
  total: number;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const share = total > 0 ? (row.tokens / total) * 100 : 0;
  const width = max > 0 ? (row.tokens / max) * 100 : 0;
  const fresh = row.token_details?.fresh_in;
  const out = row.token_details?.out_tok;
  const newWork = fresh != null || out != null ? (fresh ?? 0) + (out ?? 0) : null;
  return (
    <TableRow>
      <Td>
        <span
          className="mono"
          style={{ color: muted || row.name === UNKNOWN ? "var(--muted)" : "var(--text)" }}
          title={row.name === UNKNOWN ? t("Rollouts without a model name in metadata", "Rollouty bez nazwy modelu w metadanych") : row.name}
        >
          {row.name === UNKNOWN ? t("unnamed", "bez nazwy") : row.name}
        </span>
      </Td>
      <Td align="right" mono>
        {full(row.calls)}
      </Td>
      <Td align="right" mono>
        {compact(row.tokens)}
      </Td>
      <Td>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 120 }}>
          <div style={{ flex: 1 }}>
            <Bar value={width} height={6} color={muted ? "var(--faint)" : "var(--accent)"} />
          </div>
          <span style={{ fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)", fontSize: "var(--fs-3)", color: "var(--muted)", width: 44, textAlign: "right" }}>
            {pct(share, 1)}
          </span>
        </div>
      </Td>
      <Td align="right" mono>
        {newWork != null ? compact(newWork) : <span style={{ color: "var(--faint)" }}>—</span>}
      </Td>
      <Td align="right" mono>
        <span style={{ color: "var(--text)" }}>{usd(row.usd)}</span>
      </Td>
    </TableRow>
  );
}
