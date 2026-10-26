import type { RosterCard } from "../lib/roster";
import type { AccountCapabilities } from "../lib/api";
import { TableRow, Card, CardTitle, Eyebrow, KpiStrip, Table, Td, Th, type KpiSpec } from "../components/ui";
import { compact, dayTime, duration, full, pct, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { modelColors } from "../lib/model-colors";
import { MissingSection, missingVendorSections, vendorKpis, VENDOR_KPI_COLUMNS, type VendorOverviewSections } from "./VendorOverview";
export interface GrokOverviewProps {
  card: RosterCard;
  capabilities: AccountCapabilities | null;
}
function localizedNumber(value: number, fractionDigits?: number): string {
  const options = fractionDigits == null
    ? undefined
    : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits };
  return value
    .toLocaleString(getLocale(), options)
    .replace(/\u00a0/g, " ");
}
function confidenceLabel(value: string): string {
  switch (value) {
    case "high":
      return translate("high", "wysoka");
    case "medium":
      return translate("medium", "średnia");
    case "low":
      return translate("low", "niska");
    case "none":
      return translate("none", "brak");
    default:
      return value;
  }
}
export function grokSections({ card }: GrokOverviewProps): VendorOverviewSections {
  const w = card.grok;
  if (!w || w.spend.turns === 0) {
    return missingVendorSections(
      translate("No Grok turns in this window", "Brak tur groka w tym oknie"),
      translate(
        "Grok CLI usage is indexed from ~/.grok/sessions/**/updates.jsonl. An empty window means nothing ran through the CLI or ingest has not seen these sessions yet.",
        "Zużycie grok CLI jest indeksowane z ~/.grok/sessions/**/updates.jsonl. Puste okno znaczy, że nic przez CLI nie leciało albo ingest jeszcze nie widział tych sesji.",
      ),
    );
  }
  const s = w.spend;
  const cacheRate = s.gross > 0 ? (s.cached / Math.max(1, s.gross - s.out)) * 100 : null;
  const perTurn = s.turns > 0 ? s.calls / s.turns : 0;
  const maxTokens = Math.max(1, ...w.models.map((m) => m.tokens));
  const modelFills = modelColors(w.models.map((m) => m.model), "xai");
  const limit = w.limit ?? null;
  const cal = limit?.calibration ?? null;
  const usedPercent = limit?.current?.percent_est ?? null;
  const refusalUsd = limit?.observations.find((o) => o.ts === cal?.source_ts)?.spend.usd ?? null;
  const windowDays = w.window_hours / 24;
  const burnPerDay = windowDays > 0.1 ? s.usd / windowDays : null;
  const kpis: KpiSpec[] = vendorKpis(
    {
      ...(cal && usedPercent != null
        ? {
            Remaining: {
              value: pct(Math.max(0, 100 - usedPercent)),
              note: `${translate("scale from reading", "skala z odczytu")} · $${localizedNumber(cal.usd_per_point, 2)}/${translate("point", "pkt")}`,
              color: usedPercent >= 100 ? "var(--crit)" : usedPercent >= 80 ? "var(--warn)" : "var(--text)",
              title: translate(
                "Computed percentage, not read directly: the scale comes from an observation on {0} (${1}/point), when the account refused work at ${2} of indexed usage. The pool is shared with grok.com chat, so this is a lower bound for the point cost.",
                `Procent WYLICZONY, nie odczytany: skalę ustawia obserwacja z ${dayTime(cal.source_ts)} ($${localizedNumber(cal.usd_per_point, 2)}/pkt dokładnie), kiedy konto odmówiło pracy przy $${refusalUsd == null ? "?" : localizedNumber(refusalUsd, 2)} zaindeksowanego zużycia. Pool dzieli się z czatem grok.com, więc to jest dolne ograniczenie kosztu punktu.`, [dayTime(cal.source_ts), localizedNumber(cal.usd_per_point, 2), refusalUsd == null ? "?" : localizedNumber(refusalUsd, 2)],
              ),
            },
          }
        : {
            Remaining: {
              value: "—",
              note: translate("the vendor does not publish a counter", "vendor nie publikuje licznika"),
              absent: true,
              title: translate(
                "xAI publishes neither a cap nor percentage usage. Until the account refuses work at a known usage level (grok-gauge.json), there is no scale on which to express this.",
                "xAI nie podaje ani pułapu, ani zużycia w procentach. Dopóki konto nie odmówi pracy przy znanym zużyciu (grok-gauge.json), nie ma skali, na której dałoby się to wyrazić.",
              ),
            },
          }),
      "Avg burn": {
        value: burnPerDay != null ? `${usd(burnPerDay)}/d` : "—",
        note: `${localizedNumber(Math.round(windowDays))}d ${translate("rolling window", "okna kroczącego")}`,
        title: translate(
          "Average over the entire rolling window, not from reset: xAI does not say when the week began, so the denominator is the window length, not the time elapsed within it.",
          "Średnia z CAŁEGO okna kroczącego, nie od resetu: xAI nie mówi, kiedy tydzień się zaczął, więc mianownikiem jest długość okna, a nie czas, który w nim minął.",
        ),
      },
      "Czas okna": {
        value: `${localizedNumber(Math.round(windowDays))}d`,
        note: translate("rolling, not from reset", "kroczące, nie od resetu"),
        color: "var(--warn)",
        title: translate(
          "xAI does not say when the week began, so the window is counted backward from now. This is not a cycle and must not be drawn as one.",
          "xAI nie mówi, kiedy tydzień się zaczął, więc okno jest liczone wstecz od teraz. To NIE jest cykl i nie wolno go tak rysować.",
        ),
      },
      "Koszt API-eq": {
        value: usd(s.usd),
        note: cal
          ? `${translate("from", "z")} $${localizedNumber(cal.window_value_usd, 2)} ${translate("window value", "wartości okna")}`
          : translate("vendor valuation · no percentage counter", "wycena vendora · brak licznika %"),
        color: "var(--text)",
        title: translate(
          "xAI's own price for this traffic (costUsdTicks), not our API rate card applied to tokens.{0}",
          `Własna cena xAI za ten ruch (costUsdTicks), nie nasz cennik API zastosowany do tokenów.${cal ? " Wartość okna to 100 punktów po cenie z kalibracji — dolna granica, bo ruchu z grok.com w niej nie widać." : " Tego vendora nie da się wyrazić w procentach tygodnia — nie publikuje żadnego limitu."}`, [cal ? " The window value is 100 points at the calibrated price - a lower bound because grok.com traffic is not visible here." : " This vendor cannot be expressed as a percentage of the week because it publishes no limit."],
        ),
      },
      "Cache rate": {
        value: cacheRate != null ? pct(cacheRate, 1) : "—",
        note: `${compact(s.cached)} ${translate("from cache", "z cache")}`,
        color: "var(--violet)",
        title: translate(
          "Share of cache reads in input (cached / in). A high cache share fills the gross column without increasing actual work.",
          "Udział odczytów z cache w inpucie (cached / in). Wysoki cache napełnia kolumnę brutto, nie zwiększając realnej pracy.",
        ),
      },
    },
    [
      {
        label: translate("Gross tokens", "Tokeny brutto"),
        value: compact(s.gross),
        note: `${compact(s.fresh)} ${translate("without cache", "bez cache")}`,
        title: translate(
          "{0} gross. Cache reads count INSIDE input, as with Codex - so this number is comparable with Codex and not with Claude.",
          `${full(s.gross)} brutto. Odczyty z cache liczą się WEWNĄTRZ inputu, tak jak u Codeksa — więc ta liczba jest porównywalna z Codeksem i NIE z Claude'em.`, [full(s.gross)],
        ),
      },
      {
        label: translate("Turns", "Tury"),
        value: full(s.turns),
        note: `${full(s.calls)} ${translate("calls", "wywołań")} · ${localizedNumber(Math.round(perTurn))}× ${translate("per turn", "na turę")}`,
        title: translate(
          "The vendor reports usage once per prompt. One turn contains dozens of model calls, so the number of index rows and the number of calls are completely different quantities.",
          "Vendor raportuje zużycie raz na prompt. Jedna tura to kilkadziesiąt wywołań modelu, więc liczba wierszy w indeksie i liczba wywołań to dwie zupełnie różne wielkości.",
        ),
      },
      {
        label: translate("Output", "Wyjście"),
        value: compact(s.out),
        note: `${compact(s.reasoning)} ${translate("reasoning", "rozumowania")}`,
      },
      {
        label: translate("Last turn", "Ostatnia tura"),
        value: w.age_hours != null ? duration(w.age_hours) : "—",
        note: w.last_ts ? dayTime(w.last_ts) : translate("ago", "temu"),
        color: w.age_hours != null && w.age_hours > 48 ? "var(--faint)" : "var(--text)",
      },
      {
        label: translate("Models", "Modele"),
        value: localizedNumber(w.models.length),
        note: w.models[0]?.model ?? "—",
      },
    ]
  );
  const warning = (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ width: 4, alignSelf: "stretch", borderRadius: "var(--r-bar)", background: "var(--warn)", flex: "0 0 4px" }} />
        <div>
          <div style={{ fontSize: "var(--fs-5)", fontWeight: 600, color: "var(--warn)" }}>
            {cal
              ? translate("This percentage is COMPUTED from one reading", "Procent stąd jest WYLICZONY z jednego odczytu")
              : translate("This is a lower bound, not weekly usage", "To jest dolne ograniczenie, nie zużycie tygodnia")}
          </div>
          <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.55, marginTop: 3 }}>
            {translate(
              "xAI publishes no limit counter, and the weekly subscription pool is shared with ",
              "xAI nie publikuje żadnego licznika limitu, a tygodniowy pool subskrypcji jest dzielony z ",
            )}
            <b>{translate("grok.com chat and media generation", "czatem grok.com i generowaniem mediów")}</b>
            {translate(
              ", which leave no trace on this machine. Only CLI work is visible. ",
              ", które nie zostawiają na tej maszynie śladu. Widać tu wyłącznie pracę przez CLI. ",
            )}
            {cal ? (
              <>
                {translate("The scale comes from one event: the account ", "Skalę daje jedno zdarzenie: konto ")}
                <b>{translate("refused work", "odmówiło pracy")}</b>
                {translate(
                  ", meaning the pool was consumed at 100%. Usage from the window ending then prices the point at ",
                  ", czyli pool był zjedzony w 100%. Zużycie z okna kończącego się w tamtej chwili wycenia punkt na ",
                )}
                <b className="mono">${localizedNumber(cal.usd_per_point, 2)}</b>
                {translate(" - this is a lower bound.", " — i to jest dolna granica.")}
              </>
            ) : (
              <>{translate("There is no cap, so there is no percentage.", "Nie ma pułapu, więc nie ma procentu.")}</>
            )}{" "}
            {translate(
              "There is no reset anchor, so the window is rolling - {0} days back from now.",
              `Nie ma kotwicy resetu, więc okno jest kroczące — ${localizedNumber(Math.round(w.window_hours / 24))} dni wstecz od teraz.`, [localizedNumber(Math.round(w.window_hours / 24))],
            )}
          </div>
          {limit != null && limit.caveats.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: "var(--fs-3)", color: "var(--faint)", lineHeight: 1.5 }}>
              {limit.caveats.map((c, i) => <li key={i} style={{ marginBottom: 3 }}>{c}</li>)}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
  return {
    planWindows: (
      <>
        <KpiStrip items={kpis} columns={VENDOR_KPI_COLUMNS} />
        <MissingSection
          title={translate("No reset anchor", "Brak kotwicy resetu")}
          detail={translate(
            "xAI does not provide the start or reset of the week. This view covers one rolling window: {0} days back from now; a cycle list would be invented.",
            `xAI nie podaje początku ani resetu tygodnia. Widok obejmuje jedno okno kroczące: ${localizedNumber(Math.round(w.window_hours / 24))} dni wstecz od teraz; lista cykli byłaby zmyślona.`, [localizedNumber(Math.round(w.window_hours / 24))],
          )}
        />
      </>
    ),
    models: (
      <Card>
        <div>
          <Table tableId="GrokSections:0">
            <thead>
                <TableRow header>
                  <Th columnId="c0">{translate("model", "model")}</Th>
                  <Th columnId="c1" align="right">{translate("turns", "tury")}</Th>
                  <Th columnId="c2" align="right">{translate("calls", "wywołania")}</Th>
                  <Th columnId="c3">{translate("share", "udział")}</Th>
                  <Th columnId="c4" align="right">{translate("without cache", "bez cache")}</Th>
                  <Th columnId="c5" align="right">{translate("cost", "koszt")}</Th>
              </TableRow>
            </thead>
            <tbody>
              {w.models.map((m, i) => (
                <TableRow key={m.model}>
                  <Td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "var(--r-bar)", background: modelFills[i] }} />
                      <span className="mono">{m.model}</span>
                    </span>
                  </Td>
                  <Td align="right" mono>{full(m.turns)}</Td>
                  <Td align="right" mono>{full(m.calls)}</Td>
                  <Td>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 120 }}>
                      <div style={{ flex: 1, height: 6, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
                        <div style={{ width: `${(m.tokens / maxTokens) * 100}%`, height: "100%", background: modelFills[i] }} />
                      </div>
                      <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", width: 46, textAlign: "right" }}>{compact(m.tokens)}</span>
                    </div>
                  </Td>
                  <Td align="right" mono>{compact(m.fresh)}</Td>
                  <Td align="right" mono><span style={{ color: "var(--text)" }}>{usd(m.usd)}</span></Td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        </div>
        <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
          {translate(
            "The calls column is the vendor's own counter (modelCalls), not the number of rows - one turn averages {0} calls.",
            `Kolumna „wywołania” to własny licznik vendora (modelCalls), nie liczba wierszy — jedna tura to średnio ${localizedNumber(Math.round(perTurn))} wywołań.`, [localizedNumber(Math.round(perTurn))],
          )}
        </div>
      </Card>
    ),
    traffic: (
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SplitRow label={translate("fresh input", "input świeży")} value={Math.max(0, s.gross - s.out - s.cached)} total={s.gross} color="var(--accent)" />
          <SplitRow label={translate("cached input", "input z cache")} value={s.cached} total={s.gross} color="var(--violet)" />
          <SplitRow label={translate("output", "output")} value={s.out} total={s.gross} color="var(--ok)" />
        </div>
        <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
          {translate(
            "The vendor counts cache reads inside input: totalTokens = input + output, and cache does not appear in this sum. Fresh input is calculated by subtraction.",
            "Vendor liczy odczyty cache wewnątrz inputu: totalTokens = input + output, a cache nie występuje w tej sumie. Świeży input to odejmowanie.",
          )}
        </div>
      </Card>
    ),
    provenance: (
      <>
        {warning}
        <Card>
          <CardTitle title={translate("Where these dollars come from", "Skąd te dolary")} />
          <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
            {translate("This is ", "To ")}
            <span style={{ color: "var(--text)" }}>{translate("xAI's own valuation", "własna wycena xAI")}</span>{" "}
            {translate(
              "(costUsdTicks), not our rate card applied to tokens as in the API-equivalent columns elsewhere in the app. It is more reliable because we do not guess rates.",
              "(costUsdTicks), a nie nasz cennik zastosowany do tokenów jak w kolumnach „API-eq” reszty aplikacji. Dlatego jest wiarygodniejsza: nie zgadujemy stawek.",
            )}
          </div>
          <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
            {translate("The only unknown is the tick scale. Assumed:", "Jedyną niewiadomą jest skala ticka. Przyjęte:")} {" "}
            <b style={{ color: "var(--text)" }}>{w.ticks_per_usd.toExponential()} {translate("ticks / $", "ticków / $")}</b>. {translate(
              "The vendor does not document it - it is pinned by evidence because pricing the same traffic with the rate card lands in a range that contains this value and excludes the neighboring order of magnitude. Ticks are raw in the database, so changing this constant requires a redeploy, not re-ingest.",
              "Vendor jej nie dokumentuje — została przypięta wiarygodnością, bo wycena tego samego ruchu z cennika ląduje w przedziale, który zawiera tę wartość i wyklucza sąsiednią o rząd wielkości. Ticki są w bazie surowe, więc poprawka tej stałej to redeploy, nie re-ingest.",
            )}
          </div>
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "var(--rule)" }}>
            <Eyebrow>{translate("Window", "Okno")}</Eyebrow>
            <div className="mono" style={{ marginTop: 4, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
              {dayTime(w.since_ts)} → {dayTime(w.until_ts)}<br />
              {translate("first indexed turn:", "pierwsza tura w indeksie:")} {w.first_ts ? dayTime(w.first_ts) : "—"}
            </div>
          </div>
        </Card>
      </>
    ),
      subs: {
        models: (
          <>
            {localizedNumber(w.models.length)} {w.models.length === 1 ? translate("model", "model") : translate("models", "modeli")} · {translate("gross, vendor valuation", "brutto, wycena vendora")} · {compact(s.gross)} ·{" "}
            <span style={{ color: "var(--text)" }}>{usd(s.usd)}</span>
          </>
        ),
        traffic: translate("where the tokens actually went", "gdzie faktycznie poszły tokeny"),
      },
      calibration: cal ? (
        <Card>
          <CardTitle title={translate("$ / point scale", "Skala $ / punkt")} help={translate("Observed when work was refused; not an xAI counter.", "Obserwacja przy odmowie pracy, nie licznik xAI.")} />
          <div className="mono" style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7, fontSize: "var(--fs-4)" }}>
            <Line label={translate("Point cost", "Koszt punktu")} value={usd(cal.usd_per_point)} />
            <Line label={translate("Value of 100 points", "Wartość 100 punktów")} value={usd(cal.window_value_usd)} />
            <Line label={translate("Visible share", "Widoczny udział")} value={pct(cal.visible_share * 100, 0)} />
            <Line label={translate("Source", "Źródło")} value={dayTime(cal.source_ts)} />
            <Line label={translate("Confidence", "Pewność")} value={confidenceLabel(cal.confidence)} />
          </div>
        <div style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.55 }}>{cal.reason}</div>
      </Card>
      ) : (
      <MissingSection
        title={translate("No $ / point calibration", "Brak kalibracji $ / punkt")}
        detail={translate(
          "xAI publishes neither a percentage nor a reset anchor. Until grok-gauge.json contains an observation at refusal, the dollars remain the vendor's valuation without conversion to points.",
          "xAI nie publikuje procentu ani kotwicy resetu. Dopóki grok-gauge.json nie zawiera obserwacji przy odmowie pracy, dolary pozostają wyceną vendora bez przeliczenia na punkty.",
        )}
      />
    ),
  };
}
function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
function SplitRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const { t } = useI18n();
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-3)", marginBottom: 3 }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color: "var(--muted)" }} title={`${full(value)} ${t("tokens", "tokenów")}`}>
          <b style={{ color: "var(--text)" }}>{compact(value)}</b> · {pct(share, 1)}
        </span>
      </div>
      <div style={{ height: 8, background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${share}%`, background: color }} />
      </div>
    </div>
  );
}
