import { TableGrid, TableGridRow } from "../components/DataTable";
import type { RosterCard } from "../lib/roster";
import { planValue, type TokenMix } from "../lib/planValue";
import { ALL_ACCOUNT, subscriptionName } from "../lib/roster";
import { useBreakpoint } from "../lib/useBreakpoint";
import { useI18n } from "../lib/i18n";
import { polishPlural } from "../lib/mixFormat";
import { Card, CardTitle, EmptyState, Eyebrow, KpiStrip, type KpiSpec } from "../components/ui";
import { compact, duration, full, pct, signedPp, usd } from "../lib/format";
import { subscriptionPlan } from "../lib/subscription-plan";
export interface PortfolioProps {
  cards: RosterCard[];
  onSelect: (id: string) => void;
  windowMinutes: number;
}
function sum(xs: (number | null)[]): number {
  return xs.reduce<number>((a, b) => a + (b != null && Number.isFinite(b) ? b : 0), 0);
}
type Translate = (en: string, pl: string) => string;

function countLabel(
  t: Translate,
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  return t(Math.abs(n) === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany));
}
export function Portfolio({ cards, onSelect, windowMinutes }: PortfolioProps) {
  const { t } = useI18n();
  const bp = useBreakpoint();
  const real = cards.filter((c) => c.id !== ALL_ACCOUNT);
  if (real.length === 0) {
    return (
      <EmptyState
        title={t("No declared subscriptions", "Brak zadeklarowanych subskrypcji")}
        detail={t(
          "The roster is empty - accounts.json declares no account or the server did not answer /api/roster.",
          "Roster jest pusty — accounts.json nie deklaruje żadnego konta albo serwer nie odpowiedział na /api/roster.",
        )}
      />
    );
  }
  const values = real.map(planValue).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const maxWindowValue = Math.max(0, ...values.map((v) => v.windowValue ?? 0));
  const withPercent = real.filter((c) => c.usedPercent != null);
  const meanUsed =
    withPercent.length > 0 ? sum(withPercent.map((c) => c.usedPercent)) / withPercent.length : null;
  const meanElapsed =
    withPercent.filter((c) => c.elapsedPercent != null).length > 0
      ? sum(withPercent.map((c) => c.elapsedPercent)) /
        withPercent.filter((c) => c.elapsedPercent != null).length
      : null;
  const spentUsd = sum(real.map((c) => c.usd));
  const valueUsd = sum(real.map((c) => c.usdAt100));
  const remainingUsd = sum(real.map((c) => c.remainingUsd));
  const calls = sum(real.map((c) => c.calls));
  const pricedCards = real.filter((c) => c.usdAt100 != null && c.usd != null);
  const valueUsedPercent =
    pricedCards.length > 0 && sum(pricedCards.map((c) => c.usdAt100)) > 0
      ? (sum(pricedCards.map((c) => c.usd)) / sum(pricedCards.map((c) => c.usdAt100))) * 100
      : null;
  const spentCount = real.filter((c) => c.spent).length;
  const hot = [...real]
    .filter((c) => c.paceRatio != null)
    .sort((a, b) => (b.paceRatio ?? 0) - (a.paceRatio ?? 0))[0];
  const soonest = [...real]
    .filter((c) => c.remainingHours != null)
    .sort((a, b) => (a.remainingHours ?? 0) - (b.remainingHours ?? 0))[0];
  const kpis: KpiSpec[] = [
    {
      label: t("Subscriptions", "Subskrypcje"),
      value: String(real.length),
      note: `${real.filter((c) => c.percentMeasured).length} ${countLabel(t, real.filter((c) => c.percentMeasured).length, "vendor reading", "vendor readings", "z licznika vendora", "z licznika vendora", "z licznika vendora")} · ${real.filter((c) => !c.percentMeasured).length} ${t("inferred", "wyliczone")}`,
    },
    {
      label: t("Portfolio fill", "Zapełnienie portfela"),
      value: meanUsed != null ? pct(meanUsed) : "—",
      note:
        valueUsedPercent != null
          ? `${pct(valueUsedPercent)} ${t("weighted by window value", "licząc wartością")}`
          : t("average across windows · percentages do not add up", "średnia z okien · procenty się nie sumują"),
      color: meanUsed != null && meanUsed >= 80 ? "var(--crit)" : "var(--text)",
      title: t(
        "Arithmetic average of window percentages. When window caps can be priced, the same value is also weighted by window value, so a larger subscription counts more.",
        "Średnia arytmetyczna z procentów okien. Obok, gdy da się wycenić pułapy, ta sama wielkość ważona wartością okna - większa subskrypcja waży wtedy więcej.",
      ),
    },
    {
      label: t("Portfolio pace", "Tempo portfela"),
      value: meanUsed != null && meanElapsed != null && meanElapsed > 1 ? `${(meanUsed / meanElapsed).toFixed(2)}×` : "—",
      note:
        meanUsed != null && meanElapsed != null
          ? `${signedPp(meanUsed - meanElapsed)} ${t("vs window time", "vs czas okien")}`
          : t("no reference", "brak odniesienia"),
      color:
        meanUsed != null && meanElapsed != null && meanUsed - meanElapsed > 8
          ? "var(--warn)"
          : meanUsed != null && meanElapsed != null && meanUsed - meanElapsed < -8
            ? "var(--text)"
            : "var(--text)",
    },
    {
      label: t("Exhausted", "Wyczerpane"),
      value: `${spentCount} / ${real.length}`,
      note: spentCount > 0 ? t("vendor reports rate_limit_reached", "vendor zgłasza rate_limit_reached") : t("no window is closed", "żadne okno nie jest zamknięte"),
      color: spentCount > 0 ? "var(--crit)" : "var(--text)",
    },
    {
      label: t("Total API-equivalent cost", "Koszt API-eq razem"),
      value: usd(spentUsd),
      note: valueUsd > 0 ? `${t("of", "z")} ${usd(valueUsd)} ${t("in window value", "wartości okien")}` : t("window caps unknown", "pułapy okien nieznane"),
      color: "var(--text)",
      title: t(
        "Total value of traffic priced with the API rate card across all current windows. It says what this week would cost without subscriptions, not what was paid for subscriptions.",
        "Suma wyceny ruchu cennikiem API we wszystkich bieżących oknach. Mówi, ile ten tydzień kosztowałby bez abonamentów - nie ile zapłacono za abonamenty.",
      ),
    },
    {
      label: t("Remaining value", "Zapas wartości"),
      value: remainingUsd > 0 ? usd(remainingUsd) : "—",
      note: valueUsd > 0 ? `${pct((remainingUsd / valueUsd) * 100)} ${t("of portfolio value", "wartości portfela")}` : t("cannot be calculated", "nie do policzenia"),
      color: "var(--accent)",
      title: t(
        "Reference estimate of remaining window value at configured API prices. It depends on calibration, model mix, and data coverage; it is not a guaranteed remaining quota.",
        "Szacunkowa wartość referencyjna pozostałej części okien po skonfigurowanych cenach API. Zależy od kalibracji, miksu modeli i pokrycia danych; nie jest gwarantowanym pozostałym limitem.",
      ),
    },
    {
      label: t("Fastest pace", "Najszybsze tempo"),
      value: hot?.paceRatio != null ? `${hot.paceRatio.toFixed(2)}×` : "—",
      note: hot ? hot.id : t("no data", "brak danych"),
      color: hot?.paceColor ?? "var(--text)",
    },
    {
      label: t("Soonest reset", "Najbliższy reset"),
      value: soonest?.remainingHours != null ? duration(soonest.remainingHours) : "—",
      note: soonest ? soonest.id : t("no reset anchors", "brak kotwic resetu"),
    },
  ];
  const ranked = [...real].sort((a, b) => {
    if (a.spent !== b.spent) return a.spent ? -1 : 1;
    return (b.paceRatio ?? -1) - (a.paceRatio ?? -1);
  });
  const maxUsd = Math.max(1, ...real.map((c) => c.usd ?? 0));
  return (
    <>
      <KpiStrip items={kpis} columns={4} />
      <Card>
        <CardTitle
          title={t("All subscriptions on one scale", "Wszystkie subskrypcje na jednej skali")}
          sub={`${t("window", "okno")} ${Math.round(windowMinutes / 60)}h · ${t("sorted by pace", "sortowane po tempie")}`}
          help={t("Fill compared with the elapsed part of the window. Click a row to switch account.", "Wypełnienie w porównaniu z upływem okna. Kliknij wiersz, aby przełączyć konto.")}
        />
        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <TableGrid tableId="Portfolio:subscriptions"><div style={{ minWidth: 820 }}>
            <TableGridRow header
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns: ROW_COLS,
                gap: 10,
                padding: "0 6px var(--s-3)",
                borderBottom: "1px solid var(--line2)",
                fontSize: "var(--fs-3)",
                color: "var(--muted)",
              }}
            >
              <span>{t("subscription", "subskrypcja")}</span>
              <span style={{ textAlign: "right" }}>{t("used", "zużyte")}</span>
              <span>{t("vs elapsed window", "vs upływ okna")}</span>
              <span style={{ textAlign: "right" }}>{t("pace", "tempo")}</span>
              <span style={{ textAlign: "right" }}>{t("proj.", "proj.")}</span>
              <span style={{ textAlign: "right" }}>{t("reset", "reset")}</span>
              <span style={{ textAlign: "right" }}>{t("tokens", "tokeny")}</span>
              <span style={{ textAlign: "right" }}>API-eq</span>
              <span style={{ textAlign: "right" }}>{t("remaining $", "zapas $")}</span>
            </TableGridRow>
            {ranked.map((c) => (
              <TableGridRow as="button"
                key={c.id}
                onClick={() => onSelect(c.id)}
                className="hoverline"
                title={c.noteLong}
                style={{
                  display: "grid",
                  gridTemplateColumns: ROW_COLS,
                  gap: 10,
                  alignItems: "center",
                  width: "100%",
                  padding: "8px 6px",
                  border: "none",
                  borderBottom: "var(--rule)",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  color: "var(--text)",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "var(--r-dot)", background: c.color, flex: "0 0 7px" }} />
                  <span className="mono" style={{ fontSize: "var(--fs-4)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {subscriptionName(c)}
                  </span>
                  {c.plan && (
                    <span
                      className="mono"
                      style={{
                        fontSize: "var(--fs-2)",
                        padding: "1px 5px",
                        borderRadius: "var(--r-chip)",
                        border: "1px solid var(--line2)",
                        color: "var(--muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {subscriptionPlan(c.vendor, c.plan)}
                    </span>
                  )}
                  {!c.percentMeasured && (
                    <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }} title={c.noteLong}>
                      inf.
                    </span>
                  )}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--fs-5)",
                    fontWeight: 500,
                    fontFamily: "var(--font-figure)",
                    letterSpacing: "-0.02em",
                    textAlign: "right",
                    color: c.spent ? "var(--crit)" : "var(--text)",
                  }}
                >
                  {c.usedPercent != null ? pct(c.usedPercent) : "—"}
                </span>
                <span
                  style={{
                    position: "relative",
                    display: "block",
                    height: 10,
                    background: "var(--sunk)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-bar)",
                    overflow: "hidden",
                  }}
                >
                  {c.usedPercent != null && (
                    <span
                      style={{
                        position: "absolute",
                        inset: `0 ${100 - Math.min(100, c.usedPercent)}% 0 0`,
                        background: c.spent ? "var(--crit)" : c.color,
                        display: "block",
                      }}
                    />
                  )}
                  {c.elapsedPercent != null && (
                    <span
                      title={`${pct(c.elapsedPercent)} ${t("of the window has elapsed", "czasu okna minęło")}`}
                      style={{
                        position: "absolute",
                        left: `${Math.min(100, c.elapsedPercent)}%`,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: "var(--text)",
                        display: "block",
                      }}
                    />
                  )}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-3)", fontWeight: 500, fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: c.paceColor }}>
                  {c.paceRatio != null ? `${c.paceRatio.toFixed(2)}×` : "—"}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--fs-3)",
                    fontFamily: "var(--font-figure)",
                    textAlign: "right",
                    color:
                      c.projectedEndPercent != null && c.projectedEndPercent >= 100 ? "var(--crit)" : "var(--muted)",
                  }}
                >
                  {c.projectedEndPercent != null ? pct(c.projectedEndPercent) : "—"}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-3)", textAlign: "right", color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {c.remainingHours != null ? duration(c.remainingHours) : "—"}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--faint)" }}
                  title={
                    c.tokensTotal != null
                      ? `${full(c.tokensTotal)} ${t("gross", "brutto")}${c.tokensFresh != null ? `, ${full(c.tokensFresh)} ${t("excluding cache", "bez cache")}` : ""}. ${t("Not comparable across vendors.", "Nieporównywalne między vendorami.")}`
                      : undefined
                  }
                >
                  {c.tokensTotal != null ? compact(c.tokensTotal) : "—"}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--ok)" }}>
                  {usd(c.usd)}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--accent)" }}>
                  {c.remainingUsd != null ? usd(c.remainingUsd) : "—"}
                </span>
              </TableGridRow>
            ))}
          </div></TableGrid>
        </div>
        <div className="mono" style={{ display: "flex", gap: 14, marginTop: 8, fontSize: "var(--fs-2)", color: "var(--faint)", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 2, height: 9, background: "var(--text)" }} />
            {t("elapsed window", "upływ okna")}
          </span>
          <span style={{ marginLeft: "auto" }}>
            {t("the token column is comparable ONLY vertically within one vendor", "kolumna tokenów jest porównywalna TYLKO w pionie w obrębie jednego vendora")}
          </span>
        </div>
      </Card>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: bp === "desktop" ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)",
          gap: "var(--s-8)",
        }}
      >
        <Card>
          <CardTitle
            title={t("Where value remains", "Gdzie jest zapas")}
            help={t("How much of each window remains and what it is worth: the order in which to reach for it.", "Ile okna zostało i ile to warte: kolejność, w której warto sięgać.")}
          />
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
            {[...real]
              .sort((a, b) => (b.remainingUsd ?? -1) - (a.remainingUsd ?? -1))
              .map((c) => {
                const left = c.usedPercent != null ? Math.max(0, 100 - c.usedPercent) : null;
                return (
                  <div
                    key={c.id}
                    className="mono"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) 46px minmax(0,1.1fr) 70px",
                      gap: 9,
                      alignItems: "center",
                      padding: "7px 2px",
                      borderBottom: "var(--rule)",
                      opacity: c.spent ? 0.5 : 1,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "var(--r-dot)", background: c.color, flex: "0 0 6px" }} />
                      <span style={{ fontSize: "var(--fs-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {subscriptionName(c)}
                      </span>
                    </span>
                    <span style={{ fontSize: "var(--fs-3)", fontWeight: 500, fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: c.spent ? "var(--crit)" : "var(--ok)" }}>
                      {c.spent ? "0%" : left != null ? pct(left) : "—"}
                    </span>
                    <span
                      style={{
                        display: "block",
                        height: 8,
                        background: "var(--sunk)",
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-bar)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          height: "100%",
                          width: `${c.spent ? 0 : left ?? 0}%`,
                          background: "var(--ok)",
                        }}
                      />
                    </span>
                    <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--accent)" }}>
                      {c.spent ? t("exhausted", "wyczerpane") : c.remainingUsd != null ? usd(c.remainingUsd) : "—"}
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {t("Dollar value remaining is the window cap minus spent, at API prices. For accounts without a priced cap it is empty. The percentage remains, but the price does not.", "Zapas w dolarach to pułap okna minus wydane, po cenach API. Dla kont bez wycenionego pułapu jest pusty — procent zostaje, wycena nie.")}
          </div>
        </Card>
        <Card>
          <CardTitle title={t("Portfolio distribution", "Rozkład portfela")} help={t("Whose week it was: cost and calls.", "Czyj to był tydzień: koszt i wywołania.")} />
          <div style={{ marginTop: 12 }}>
            <Eyebrow>{t("API-equivalent cost", "Koszt API-eq")}</Eyebrow>
            <StackedShare
              parts={real.map((c) => ({ id: c.id, color: c.color, value: c.usd ?? 0 }))}
              total={spentUsd}
              fmt={(v) => usd(v)}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <Eyebrow>{t("Calls", "Wywołania")}</Eyebrow>
            <StackedShare
              parts={real.map((c) => ({ id: c.id, color: c.color, value: c.calls ?? 0 }))}
              total={calls}
              fmt={(v) => full(v)}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <Eyebrow>{t("Cost vs remaining value, per subscription", "Koszt vs zapas, per subskrypcja")}</Eyebrow>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {[...real]
                .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
                .map((c) => (
                  <div
                    key={c.id}
                    className="mono"
                    style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr) 62px", gap: 8, alignItems: "center" }}
                  >
                    <span style={{ fontSize: "var(--fs-3)", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.id}
                    </span>
                    <span
                      style={{
                        display: "block",
                        height: 8,
                        background: "var(--sunk)",
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-bar)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{ display: "block", height: "100%", width: `${((c.usd ?? 0) / maxUsd) * 100}%`, background: c.color }}
                      />
                    </span>
                    <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--text)" }}>{usd(c.usd)}</span>
                  </div>
                ))}
            </div>
          </div>
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {t("Dollars are the only quantity that can be summed here: the same rate card is applied to every vendor's traffic. Percentages describe different windows, and gross tokens are counted differently by each vendor.", "Dolary są jedyną wielkością, którą można tu zsumować: to ten sam cennik zastosowany do ruchu każdego vendora. Procenty opisują różne okna, a tokeny brutto liczy się u każdego inaczej.")}
          </div>
        </Card>
      </section>
      <Card>
        <CardTitle
          title={t("What the subscription provides", "Co daje abonament")}
          help={t("Point rate and window value: how much API-priced work stands behind one allowance point.", "Kurs punktu i wartość okna: ile pracy w cenach API stoi za jednym punktem limitu.")}
        />
        <TableGrid tableId="Portfolio:value"><div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
          <TableGridRow header
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: VALUE_COLS,
              gap: 9,
              padding: "0 2px var(--s-3)",
              borderBottom: "1px solid var(--line2)",
              fontSize: "var(--fs-3)",
              color: "var(--muted)",
            }}
          >
            <span>{t("subscription", "subskrypcja")}</span>
            <span style={{ textAlign: "right" }}>{t("point rate", "kurs punktu")}</span>
            <span>{t("window value at this rate", "wartość okna w tym kursie")}</span>
            <span style={{ textAlign: "right" }}>{t("full window", "całe okno")}</span>
            <span style={{ textAlign: "right" }}>{t("worst", "najgorsze")}</span>
            <span style={{ textAlign: "right" }}>{t("best", "najlepsze")}</span>
            <span style={{ textAlign: "right" }}>{t("windows", "okien")}</span>
          </TableGridRow>
          {values.map((v) => (
            <TableGridRow as="button"
              key={v.id}
              onClick={() => onSelect(v.id)}
              className="hoverline mono"
              title={v.note}
              style={{
                display: "grid",
                gridTemplateColumns: VALUE_COLS,
                gap: 9,
                alignItems: "center",
                width: "100%",
                padding: "8px 2px",
                border: "none",
                borderBottom: "var(--rule)",
                background: "transparent",
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
                color: "var(--text)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: "var(--r-dot)", background: v.color, flex: "0 0 6px" }} />
                <span style={{ fontSize: "var(--fs-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.id}
                  {v.plan ? <span style={{ color: "var(--faint)" }}> · {subscriptionPlan(v.group, v.plan)}</span> : null}
                </span>
              </span>
              <span style={{ fontSize: "var(--fs-4)", fontWeight: 500, fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right" }}>
                {v.rate != null ? `${usd(v.rate)}` : "—"}
              </span>
              <span
                style={{
                  display: "block",
                  height: 8,
                  background: "var(--sunk)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-bar)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${maxWindowValue > 0 ? ((v.windowValue ?? 0) / maxWindowValue) * 100 : 0}%`,
                    background: v.basis === "measured" ? v.color : "var(--line2)",
                  }}
                />
              </span>
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--accent)" }}>
                {v.windowValue != null ? usd(v.windowValue) : "—"}
              </span>
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--muted)" }}>
                {v.worst ? usd(v.worst.rate) : "—"}
              </span>
              <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--muted)" }}>
                {v.best ? usd(v.best.rate) : "—"}
              </span>
              <span style={{ fontSize: "var(--fs-3)", textAlign: "right", color: v.basis === "measured" ? "var(--muted)" : "var(--faint)" }}>
                {v.basis === "measured"
                  ? v.windows
                  : v.basis === "single"
                    ? v.windows === 1
                      ? `1 ${t("window", "okno")}`
                      : `1 ${t("reading", "odczyt")}`
                    : "—"}
              </span>
              {v.tokens && v.tokensPerWindow != null && (
                <span style={{ gridColumn: "1 / -1", display: "block", marginTop: 7 }}>
                  <TokenMixBar mix={v.tokens} total={v.tokensPerWindow} />
                </span>
              )}
            </TableGridRow>
          ))}
        </div></TableGrid>
        <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
          {t(`The point rate uses the API RATE CARD, not the subscription price: it says what the same traffic would cost without a subscription. It rises with the prices of the models used, so a 'better week' here means 'more expensive work per point', not 'more work completed'. Rows with '1 reading' use one calibration (Claude, Grok, GLM), while '1 window' uses the only window the index has for that account; best/worst spread is empty because there is nothing to measure. Windows where the gauge and index do not cover the same time are excluded from the median - the rate is their quotient, so one such window could show $0.03 or $232 per point.`, `Kurs punktu to ceny CENNIKA API, nie cena abonamentu: mówi, ile kosztowałby ten sam ruch bez subskrypcji. Rośnie razem z ceną używanych modeli, więc „lepszy tydzień" znaczy tu „droższa praca na punkt", a nie „więcej zrobione". Wiersze z „1 odczyt" mają kurs z jednej kalibracji (Claude, grok, GLM), a z „1 okno" - z jedynego okna, jakie indeks dla tego konta ma; rozrzut najlepszy/najgorszy jest dla nich pusty, bo nie ma z czego go policzyć. Okna, w których gauge i indeks nie pokrywają tego samego czasu, nie wchodzą do mediany wcale - kurs jest ich ilorazem, więc jedno takie okno potrafiło pokazać $0.03 albo $232 na punkt.`)}
        </div>
      </Card>
    </>
  );
}
const VALUE_COLS =
  "minmax(140px,1.1fr) 74px minmax(90px,1.2fr) 78px 66px 66px 60px";
const ROW_COLS =
  "minmax(150px,1.1fr) 58px minmax(120px,1.4fr) 56px 52px 68px 66px 68px 68px";
function TokenMixBar({ mix, total }: { mix: TokenMix; total: number }) {
  const { t } = useI18n();
  const parts = [
    { key: "in", label: t("input", "wejście"), value: mix.inFresh, color: "var(--accent)" },
    { key: "cache", label: "cache", value: mix.cachedIn, color: "var(--line2)" },
    { key: "write", label: t("cache write", "zapis"), value: mix.cacheWrite, color: "var(--violet)" },
    { key: "out", label: t("output", "wyjście"), value: mix.out, color: "var(--ok)" },
  ];
  const sum = parts.reduce((a, x) => a + x.value, 0);
  if (sum <= 0) return null;
  return (
    <>
      <span style={{ display: "flex", height: 6, borderRadius: "var(--r-bar)", overflow: "hidden", border: "1px solid var(--line)" }}>
        {parts.map((x) => (
          <span key={x.key} style={{ width: `${(x.value / sum) * 100}%`, background: x.color, display: "block" }} />
        ))}
      </span>
      <span
        className="mono"
        style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4, fontSize: "var(--fs-2)", color: "var(--faint)" }}
      >
        <span style={{ color: "var(--muted)" }}>{compact(total)} {t("gross", "brutto")}</span>
        {parts.map((x) => (
          <span key={x.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "var(--r-bar)", background: x.color, display: "block" }} />
            {x.label} {compact(x.value)}
          </span>
        ))}
        {mix.reasoning > 0 && <span>{t("including reasoning", "w tym rozumowanie")} {compact(mix.reasoning)}</span>}
      </span>
    </>
  );
}
function StackedShare({
  parts,
  total,
  fmt,
}: {
  parts: { id: string; color: string; value: number }[];
  total: number;
  fmt: (v: number) => string;
}) {
  const { t } = useI18n();
  const shown = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  if (total <= 0 || shown.length === 0) {
    return (
      <div className="mono" style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--faint)" }}>
        {t("No traffic in current windows.", "Brak ruchu w bieżących oknach.")}
      </div>
    );
  }
  return (
    <>
      <div
        style={{
          display: "flex",
          height: 12,
          marginTop: 6,
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
          border: "1px solid var(--line)",
          background: "var(--sunk)",
        }}
      >
        {shown.map((p) => (
          <div
            key={p.id}
            title={`${p.id}: ${fmt(p.value)} · ${pct((p.value / total) * 100, 1)}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color, minWidth: 2 }}
          />
        ))}
      </div>
      <div
        className="mono"
        style={{ display: "flex", flexWrap: "wrap", gap: "3px 12px", marginTop: 5, fontSize: "var(--fs-2)", color: "var(--muted)" }}
      >
        {shown.map((p) => (
          <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "var(--r-bar)", background: p.color }} />
            {p.id} <span style={{ color: "var(--text)" }}>{pct((p.value / total) * 100, 0)}</span>
            <span style={{ color: "var(--faint)" }}>{fmt(p.value)}</span>
          </span>
        ))}
      </div>
    </>
  );
}
