import { api, type BreakdownRow } from "../../lib/api";
import { Bar, Card, CardTitle, ErrorState, LoadingCard, Table, TableColGroup, TableRow, Tabs, Td, Th } from "../../components/ui";
import { compact, pct, usd as fmtUsd } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { surfaceName } from "../../lib/surfaces";
import { useAsync } from "../../lib/useAsync";
import { formatNumber } from "./format";
import { Kpi } from "./presentation";
import { modelVersionSortValue, useTableSort } from "../../lib/table-sort";

const MODEL_SORTS = [
  { value: "c0", en: "Newest", pl: "Najnowsze" },
  { value: "c1", en: "Tokens", pl: "Tokeny" },
  { value: "c2", en: "API-eq", pl: "API-eq" },
  { value: "c3", en: "$/M", pl: "$/M" },
];
const unitOf = (r: BreakdownRow) => (r.tokens > 0 ? r.usd / (r.tokens / 1e6) : 0);
function cachedOf(td: Record<string, number | undefined> | undefined): number {
  if (!td) return 0;
  return td.cached_in ?? td.in_cache_read ?? 0;
}
export function AllModels({ money }: { money: boolean }) {
  const { t, locale } = useI18n();
  const state = useAsync(
    signal =>
      Promise.all([
        api.breakdown({ dim: "model" },signal) as unknown as Promise<{ rows: BreakdownRow[] }>,
        api.breakdown({ dim: "surface" },signal) as unknown as Promise<{ rows: BreakdownRow[] }>,
      ]),
    []
  );
  const rows = (state.data?.[0].rows ?? []).filter((r) => r.tokens > 0);
  const { rows: sorted, sorting } = useTableSort(rows, {
    c0: r => modelVersionSortValue(r.name), c1: r => r.tokens, c2: r => r.usd,
    c3: unitOf, c4: r => r.tokens > 0 ? cachedOf(r.token_details) / r.tokens : null,
    c5: r => r.calls, c6: r => r.tokens,
  }, locale, { column: "c0", direction: "desc" });
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return <div className="ui-tab-page"><LoadingCard label={t("Loading models for all subscriptions", "Wczytuję modele wszystkich subskrypcji")} height={420} shape="chart" /></div>;
  const surfaces = state.data[1];
  const totTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totUsd = rows.reduce((s, r) => s + r.usd, 0);
  const totCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totCached = rows.reduce((s, r) => s + cachedOf(r.token_details), 0);
  const maxTokens = Math.max(...rows.map((r) => r.tokens), 1);
  const maxUsd = Math.max(...rows.map((r) => r.usd), 1);
  return (
    <div className="ui-tab-page">
      <Card>
        <div style={{ display: "flex", gap: 28, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Kpi label={t("Models with activity", "Modeli z ruchem")} value={String(rows.length)} />
          <Kpi label={t("Total tokens", "Tokeny łącznie")} value={compact(totTokens)} title={formatNumber(totTokens, locale)} />
          <Kpi label={t("API-equivalent value", "Wartość API-eq")} value={fmtUsd(totUsd)} sub={t("At API pricing, not an invoice", "po cenniku API, nie rachunek")} />
          <Kpi
            label={t("Average price", "Średnia cena")}
            value={totTokens > 0 ? `${fmtUsd(totUsd / (totTokens / 1e6))}/M` : "—"}
            sub={t("gross, including cache", "brutto, z cache")}
          />
          <Kpi
            label={t("From cache", "Z cache")}
            value={totTokens > 0 ? pct((totCached / totTokens) * 100) : "—"}
            sub={t("reads, not fresh input", "odczyty, nie świeże wejście")}
          />
          <div style={{ marginLeft: "auto" }}>
            <Tabs
              value={sorting.sort?.column ?? ""}
              onChange={column => sorting.onSort({ column, direction: "desc" })}
              options={MODEL_SORTS.map(({ value, en, pl }) => ({ value, label: t(en, pl) }))}
            />
          </div>
        </div>
      </Card>
      <Card pad="0">
        <div style={{ padding: "var(--s-8) var(--s-9) var(--s-2)" }}>
          <CardTitle
            title={t("Models - all subscriptions", "Modele — wszystkie subskrypcje")}
            help={t(
              "Two bars per row, each relative to its own maximum. Different lengths mean a model costs differently from its weight: a longer cost bar is expensive per unit, a shorter one is a model that benefits from cache. All indexed usage, without a limit window.",
              "Dwa paski na wiersz, każdy względem własnego maksimum. Różna długość = model kosztuje inaczej, niż waży: dłuższy pasek kosztu to model drogi za jednostkę, krótszy - taki, który pracuje z cache. Całe zaindeksowane zużycie, bez okna limitu."
            )}
            right={<BarLegend />}
          />
        </div>
        <Table tableId="AllAggregate:0" sorting={sorting}>
          <TableColGroup>
            <col style={{ width: "21%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "31%" }} />
          </TableColGroup>
          <thead>
            <TableRow header>
              <Th columnId="c0">{t("model", "model")}</Th>
              <Th columnId="c1" align="right">{t("tokens", "tokeny")}</Th>
              <Th columnId="c2" align="right">{t("API-equivalent", "API-eq")}</Th>
              <Th columnId="c3" align="right" title={t("Gross cost per million tokens - lower means cheaper per unit of work", "Koszt miliona tokenów brutto - im niżej, tym taniej za jednostkę pracy")}>
                $/M
              </Th>
              <Th columnId="c4" align="right" title={t("How many of these tokens are cache reads rather than fresh input", "Ile z tych tokenów to odczyt z cache, a nie świeże wejście")}>
                {t("cache", "cache")}
              </Th>
              <Th columnId="c5" align="right">{t("calls", "wywołania")}</Th>
              <Th columnId="c6" title={t("Top bar: token share. Bottom bar: API-eq share.", "Górny pasek: udział w tokenach. Dolny: udział w API-eq.")}>{t("tokens / API-eq", "tokeny / API-eq")}</Th>
            </TableRow>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const cached = cachedOf(r.token_details);
              return (
                <TableRow key={`${r.vendor}:${r.name}`}>
                  <Td mono>
                    <div>{r.name}</div>
                    <div style={{ fontSize: "var(--fs-2)", color: "var(--faint)", marginTop: 1 }}>{r.vendor}</div>
                  </Td>
                  <Td align="right" mono title={formatNumber(r.tokens, locale)}>
                    {compact(r.tokens)}
                    <span style={{ color: "var(--faint)", marginLeft: 5, fontSize: "var(--fs-2)" }}>
                      {totTokens > 0 ? pct((r.tokens / totTokens) * 100) : ""}
                    </span>
                  </Td>
                  <Td align="right" mono>
                    {fmtUsd(r.usd)}
                    <span style={{ color: "var(--faint)", marginLeft: 5, fontSize: "var(--fs-2)" }}>
                      {totUsd > 0 ? pct((r.usd / totUsd) * 100) : ""}
                    </span>
                  </Td>
                  <Td align="right" mono>
                    {r.usd > 0 ? fmtUsd(unitOf(r)) : "—"}
                  </Td>
                  <Td align="right" mono style={{ color: cached > 0 ? "var(--text)" : "var(--faint)" }}>
                    {r.tokens > 0 ? pct((cached / r.tokens) * 100) : "—"}
                  </Td>
                  <Td align="right" mono>
                    {compact(r.calls)}
                  </Td>
                  <Td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <Bar value={(r.tokens / maxTokens) * 100} color="var(--accent)" height={7} />
                      <Bar value={(r.usd / maxUsd) * 100} color="var(--warn)" height={7} />
                    </div>
                  </Td>
                </TableRow>
              );
            })}
          </tbody>
          <tfoot>
            <TableRow>
              <Td mono style={{ fontWeight: 600 }}>
                {t("total", "razem")}
              </Td>
              <Td align="right" mono style={{ fontWeight: 600 }} title={formatNumber(totTokens, locale)}>
                {compact(totTokens)}
              </Td>
              <Td align="right" mono style={{ fontWeight: 600 }}>
                {fmtUsd(totUsd)}
              </Td>
              <Td align="right" mono>
                {totTokens > 0 ? fmtUsd(totUsd / (totTokens / 1e6)) : "—"}
              </Td>
              <Td align="right" mono>
                {totTokens > 0 ? pct((totCached / totTokens) * 100) : "—"}
              </Td>
              <Td align="right" mono>
                {compact(totCalls)}
              </Td>
              <Td> </Td>
            </TableRow>
          </tfoot>
        </Table>
      </Card>
      <SurfaceCard rows={surfaces.rows} money={money} />
    </div>
  );
}
function BarLegend() {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      {[
        { c: "var(--accent)", en: "token share", pl: "udział w tokenach" },
        { c: "var(--warn)", en: "API-eq share", pl: "udział w API-eq" },
      ].map((x) => (
        <span
          key={x.en}
          className="mono"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-3)", color: "var(--muted)" }}
        >
          <span style={{ width: 16, height: 7, borderRadius: "var(--r-bar)", background: x.c }} />
          {t(x.en, x.pl)}
        </span>
      ))}
    </div>
  );
}
function SurfaceCard({ rows, money }: { rows: BreakdownRow[]; money: boolean }) {
  const { t } = useI18n();
  const live = rows.filter((r) => r.tokens > 0);
  if (live.length === 0) return null;
  const total = live.reduce((s, r) => s + (money ? r.usd : r.tokens), 0);
  const sorted = [...live].sort((a, b) => (money ? b.usd - a.usd : b.tokens - a.tokens));
  const max = Math.max(...sorted.map((r) => (money ? r.usd : r.tokens)), 1);
  return (
    <Card>
      <CardTitle
        title={t("Where activity comes from", "Gdzie powstaje ruch")}
        help={t(
          "A launch context is where the call was made: CLI, IDE, or agent. The same work in another context has a different cache profile and therefore a different price.",
          "Kontekst uruchomienia to miejsce wywołania: CLI, IDE, agent. Ta sama praca w innym kontekście ma inny profil cache, więc i inną cenę."
        )}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
        {sorted.map((r) => {
          const v = money ? r.usd : r.tokens;
          return (
            <div
              key={`${r.vendor}:${r.name}`}
              style={{
                display: "grid",
                gridTemplateColumns: "190px 110px 90px minmax(0, 1fr)",
                gap: 12,
                alignItems: "center",
                padding: "7px 0",
                borderBottom: "var(--rule)",
              }}
            >
              <span style={{ fontSize: "var(--fs-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>
                {surfaceName(r.name, t)}
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-4)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em"}}>
                {money ? fmtUsd(r.usd) : compact(r.tokens)}
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", color: "var(--faint)" }}>
                {total > 0 ? pct((v / total) * 100) : "—"}
              </span>
              <Bar value={(v / max) * 100} color="var(--accent)" />
            </div>
          );
        })}
      </div>
    </Card>
  );
}
