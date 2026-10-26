import type { RosterCard } from "../lib/roster";
import type { AccountCapabilities, GlmWindow } from "../lib/api";
import { TableRow, Card, CardTitle, Eyebrow, KpiStrip, Table, Td, Th, type KpiSpec } from "../components/ui";
import { compact, dayTime, duration, full, pct, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { MissingSection, missingVendorSections, vendorKpis, VENDOR_KPI_COLUMNS, type VendorOverviewSections } from "./VendorOverview";
export interface GlmOverviewProps {
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
export function glmSections({ card }: GlmOverviewProps): VendorOverviewSections {
  const g = card.glm;
  if (!g || g.windows.length === 0) {
    return missingVendorSections(
      translate("No GLM counter reading", "Brak odczytu licznika GLM"),
      translate(
        "The plan counter is read from the account (GET /api/monitor/usage/quota/limit) using the key used by opencode. Empty means the probe has not answered yet or the z.ai key disappeared from configuration.",
        "Licznik planu czyta się z konta (GET /api/monitor/usage/quota/limit) kluczem, którego używa opencode. Pusto znaczy, że probe jeszcze nie odpowiedział albo klucz z.ai zniknął z konfiguracji.",
      ),
    );
  }
  const head = g.windows.find((w) => w.kind === g.headline_kind) ?? g.windows[0]!;
  const sp = head.spend;
  const kpis: KpiSpec[] = vendorKpis(
    {
      Remaining: {
        value: pct(Math.max(0, 100 - head.percent), head.percent > 99 ? 2 : 1),
        note: `${fmtCredits(head.remaining)} ${translate("of", "z")} ${fmtCredits(head.allowance)} ${translate("credits · READING", "kredytów · ODCZYT")}`,
        color: head.percent >= 90 ? "var(--crit)" : head.percent >= 60 ? "var(--warn)" : "var(--glm)",
        title:
          translate(
            "Both numbers arrive in the same account response: window allowance ({0}) and usage ({1}). This is the only percentage in this app whose denominator is neither declared nor derived.",
            `Obie liczby przychodzą w tej samej odpowiedzi konta: przydział okna (${fmtCredits(head.allowance)}) i zużycie (${fmtCredits(head.used)}). To jedyny procent w tej aplikacji, którego mianownik nie jest ani deklarowany, ani wyprowadzany.`, [fmtCredits(head.allowance), fmtCredits(head.used)],
          ) +
          (head.vendor_percent != null && Math.abs(head.vendor_percent - head.percent) >= 0.5
            ? translate(
                " The vendor reports a rounded {0}% usage next to it - this is the exact ratio here.",
                ` Vendor podaje obok zaokrąglone ${localizedNumber(head.vendor_percent, 2)}% zużycia — tu stoi dokładny iloraz.`, [localizedNumber(head.vendor_percent, 2)],
              )
            : ""),
      },
      "Czas okna": {
        value: head.label,
        note: head.reset_at
          ? `${translate("reset", "reset")} ${dayTime(head.reset_at)}`
          : translate("reset is not dated yet", "reset nie jest jeszcze datowany"),
        title: head.reset_at
          ? translate(
              "Window {0} resets at {1} - the date comes from the vendor, not from our calculation.",
              `Reset okna ${head.label} o ${dayTime(head.reset_at)} — data od vendora, nie z naszego liczenia.`, [head.label, dayTime(head.reset_at)],
            )
          : translate(
              "The vendor dates a reset only after the first usage in the window, so an untouched window has no date.",
              "Vendor datuje reset dopiero od pierwszego zużycia w oknie, więc nietknięte okno nie ma daty.",
            ),
      },
      ...(sp
        ? {
            "Koszt API-eq": {
              value: usd(sp.usd),
              note: translate("without a subscription", "gdyby nie abonament"),
              color: "var(--text)",
              title: translate(
                "The z.ai list price is applied to measured tokens. The plan returns no price (cost in opencode is always 0), so this says what the traffic would cost without a subscription - not what was charged to the subscription.",
                "Cennik listowy z.ai zastosowany do zmierzonych tokenów. Plan nie zwraca żadnej ceny (cost w opencode jest zawsze 0), więc ta liczba mówi, ile ten ruch kosztowałby bez abonamentu — nie ile z abonamentu zeszło.",
              ),
            },
          }
        : {}),
    },
    [
      {
        label: `${translate("Window", "Okno")} ${head.label}`,
        value: pct(head.percent, head.percent < 10 ? 2 : 1),
        note: `${fmtCredits(head.used)} ${translate("credits used", "kredytów zużytych")}`,
        color: head.percent >= 90 ? "var(--crit)" : head.percent >= 60 ? "var(--warn)" : "var(--glm)",
        title: translate(
          "The same pair of numbers as in Remaining, shown from the usage side - the plan counter is in credits, not tokens.",
          "Ta sama para liczb co w „Remaining”, tylko od strony zużycia — bo licznik planu jest w kredytach, nie w tokenach.",
        ),
      },
      ...(sp
        ? [
            {
              label: translate("Tokens in window", "Tokeny w oknie"),
              value: compact(sp.gross),
              note: `${localizedNumber(sp.calls)} ${translate("calls · from the opencode database", "wywołań · z bazy opencode")}`,
              color: "var(--text)",
              title: translate(
                "{0} tokens in {1} calls ({2} sessions). This is a second measure of the same work - the plan limit is in credits, so these tokens are not the denominator of the adjacent percentage.",
                `${full(sp.gross)} tokenów w ${localizedNumber(sp.calls)} wywołaniach (${localizedNumber(sp.sessions)} sesji). To DRUGA miara tej samej pracy — limit planu jest w kredytach, więc te tokeny nie są mianownikiem procentu obok.`, [full(sp.gross), localizedNumber(sp.calls), localizedNumber(sp.sessions)],
              ),
            } as KpiSpec,
          ]
        : []),
      ...(head.credits_per_mtok != null
        ? [
            {
              label: translate("Credit rate", "Kurs kredytu"),
              value: localizedNumber(head.credits_per_mtok, 2),
              note: translate("credits / million tokens", "kredytów / mln tokenów"),
              color: "var(--violet)",
              title: translate(
                "Observation from this window, not a constant: this many credits were spent per million indexed tokens. The vendor weights credits by model and token type and publishes no conversion, so this rate changes with the traffic mix.",
                "OBSERWACJA z tego okna, nie stała: tyle kredytów zeszło na milion zaindeksowanych tokenów. Vendor waży kredyty per model i typ tokena i nie publikuje przelicznika, więc ten kurs zmienia się razem ze składem ruchu.",
              ),
            } as KpiSpec,
          ]
        : []),
    ]
  );
  return {
    planWindows: (
      <>
        <KpiStrip items={kpis} columns={VENDOR_KPI_COLUMNS} />
        <Card>
          <CardTitle
            title={translate("Both plan windows", "Oba okna planu")}
            help={translate("Exhausting either one stops work.", "Wyczerpanie któregokolwiek zatrzymuje pracę.")}
          />
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
            {g.windows.map((w) => (
              <WindowRow key={w.kind} w={w} />
            ))}
          </div>
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {translate(
              "The thinner marker on the bar is elapsed window time - how much of its duration has passed. Usage to the left of the marker means the plan is moving more slowly than the clock.",
              "Cieńszy znacznik na pasku to upływ okna — ile z jego czasu minęło. Zużycie po lewej stronie znacznika znaczy, że plan idzie wolniej niż zegar.",
            )}
          </div>
        </Card>
        <Card>
          <CardTitle title={translate("Plan", "Plan")} />
          <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
            {translate("level", "poziom")}: <b style={{ color: "var(--text)" }}>{g.level ?? "—"}</b>
            <br />
            {g.windows.map((w) => (
              <span key={w.kind}>
                {translate("window", "okno")} {w.label}: <b style={{ color: "var(--text)" }}>{fmtCredits(w.allowance)}</b>{" "}
                {translate("credits", "kredytów")}
                <br />
              </span>
            ))}
          </div>
          <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
            {translate(
              "Allowances come from the reading, not configuration - a plan change appears here without an entry in any file.",
              "Przydziały przychodzą z odczytu, nie z konfiguracji — zmiana planu odbije się tu sama, bez wpisu w żadnym pliku.",
            )}
          </div>
        </Card>
      </>
    ),
    models:
      sp && sp.models.length > 0 ? (
        <Card>
          <div style={{ overflowX: "auto" }}>
            <Table tableId="GlmSections:0">
              <thead>
                <TableRow header>
                  <Th columnId="c0">{translate("model", "model")}</Th>
                  <Th columnId="c1" align="right">{translate("calls", "wywołania")}</Th>
                  <Th columnId="c2" align="right">{translate("input", "wejście")}</Th>
                  <Th columnId="c3" align="right">{translate("cache", "cache")}</Th>
                  <Th columnId="c4" align="right">{translate("output", "wyjście")}</Th>
                  <Th columnId="c5" align="right">{translate("API-equivalent", "API-eq")}</Th>
                </TableRow>
              </thead>
              <tbody>
                {sp.models.map((m) => (
                  <TableRow key={m.model}>
                    <Td mono>{m.model}</Td>
                    <Td align="right" mono>{localizedNumber(m.calls)}</Td>
                    <Td align="right" mono title={full(m.in_tok)}>{compact(m.in_tok)}</Td>
                    <Td align="right" mono title={full(m.cache_read)}>{compact(m.cache_read)}</Td>
                    <Td align="right" mono title={full(m.out_tok + m.reasoning)}>{compact(m.out_tok + m.reasoning)}</Td>
                    <Td align="right" mono><span style={{ color: "var(--text)" }}>{usd(m.usd)}</span></Td>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </div>
          {sp.unpriced_tokens > 0 && (
            <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-2)", color: "var(--warn)", lineHeight: 1.55 }}>
              {translate(
                "{0} tokens have no rate in rate-cards.json - their cost is excluded from the total above, so the API-equivalent value is understated.",
                `${compact(sp.unpriced_tokens)} tokenów bez stawki w rate-cards.json — ich koszt nie jest w sumie powyżej, więc wartość API-eq jest zaniżona.`, [compact(sp.unpriced_tokens)],
              )}
            </div>
          )}
        </Card>
      ) : (
        <MissingSection
          title={translate("No model breakdown in this window", "Brak modeli w tym oknie")}
          detail={translate(
            "The credit counter answered, but the opencode index has no model breakdown for this period. This is missing data, not zero.",
            "Licznik kredytów odpowiedział, ale indeks opencode nie ma modelowego rozbicia ruchu dla tego odcinka. To brak danych, nie zero.",
          )}
        />
      ),
    traffic: (
      <MissingSection
        title={translate("The vendor does not provide traffic composition", "Vendor nie podaje składu ruchu")}
        detail={translate(
          "The z.ai limit response contains credits, allowance, and reset, but does not split traffic into input, cache, and output. Available token fields remain with the models as a second indexed measure.",
          "Odpowiedź limitu z.ai zawiera kredyty, przydział i reset, ale nie rozdziela ruchu na input, cache i output. Dostępne pola tokenowe pozostają przy modelach jako druga, indeksowa miara.",
        )}
      />
    ),
    provenance: (
      <Card>
        <CardTitle title={translate("Where this percentage comes from", "Skąd ten procent")} />
        <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
          <span style={{ color: "var(--text)" }}>GET /api/monitor/usage/quota/limit</span>{" "}
          {translate(
            "account reading with the same key used by opencode. It consumes no tokens, does not run inference, and answers for an account idle for a week. Last reading:",
            "— odczyt konta tym samym kluczem, którego używa opencode. Nie zużywa tokenów, nie uruchamia inferencji i odpowiada dla konta bezczynnego od tygodnia. Ostatni odczyt:",
          )}{" "}
          <span style={{ color: "var(--text)" }}>
            {head.measured_age_minutes < 1
              ? translate("just now", "przed chwilą")
              : `${localizedNumber(head.measured_age_minutes)} ${translate("min ago", "min temu")}`}
          </span>.
        </div>
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "var(--rule)" }}>
          <Eyebrow>{translate("What this number does not know", "Czego ta liczba nie wie")}</Eyebrow>
          <ul className="mono" style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.6 }}>
            {g.caveats.map((c, i) => (
              <li key={i} style={{ marginBottom: 5 }}>{c}</li>
            ))}
          </ul>
        </div>
      </Card>
    ),
    subs: {
      models:
        sp && sp.models.length > 0
          ? `${head.label} · ${translate("tokens from the opencode database", "tokeny z bazy opencode")}`
          : undefined,
    },
    calibration: (
      <MissingSection
        title={translate("Calibration is not needed", "Kalibracja nie jest potrzebna")}
        detail={translate(
          "z.ai provides both sides of the ratio: {0} of {1} credits. The percentage is the exact account-reading ratio, while the observed credits-per-million-tokens rate only describes this window's mix.",
          `z.ai podaje obie strony ułamka: ${fmtCredits(head.used)} z ${fmtCredits(head.allowance)} kredytów. Procent jest dokładnym ilorazem odczytu konta, a obserwowany kurs kredytów na milion tokenów pozostaje tylko opisem miksu tego okna.`, [fmtCredits(head.used), fmtCredits(head.allowance)],
        )}
      />
    ),
  };
}
function fmtCredits(n: number | null): string {
  if (n == null) return "—";
  return n >= 1000 ? compact(n) : localizedNumber(Math.round(n * 100) / 100);
}
function WindowRow({ w }: { w: GlmWindow }) {
  const { t } = useI18n();
  const color = w.percent >= 90 ? "var(--crit)" : w.percent >= 60 ? "var(--warn)" : "var(--glm)";
  return (
    <div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-3)", marginBottom: 4 }}>
        <span style={{ color: "var(--muted)" }}>
          {t("window", "okno")} <b style={{ color: "var(--text)" }}>{w.label}</b>
          {w.reset_at ? ` · ${t("reset", "reset")} ${dayTime(w.reset_at)}` : ""}
        </span>
        <span style={{ color: "var(--muted)" }} title={`${fmtCredits(w.used)} ${t("of", "z")} ${fmtCredits(w.allowance)} ${t("credits", "kredytów")}`}>
          <b style={{ color: "var(--text)" }}>{pct(w.percent, w.percent < 10 ? 2 : 1)}</b>
          {w.remaining_hours != null ? ` · ${t("left", "zostało")} ${duration(w.remaining_hours)}` : ""}
        </span>
      </div>
      <div
        style={{
          position: "relative",
          height: 10,
          background: "var(--sunk)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
        }}
      >
        <div style={{ height: "100%", width: `${Math.min(100, w.percent)}%`, background: color }} />
        {w.elapsed_percent != null && (
          <div
            title={`${pct(w.elapsed_percent, 0)} ${t("of window time elapsed", "okna minęło")}`}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${Math.min(100, w.elapsed_percent)}%`,
              width: 2,
              background: "var(--text)",
              opacity: 0.55,
            }}
          />
        )}
      </div>
      {w.note && (
        <div className="mono" style={{ marginTop: 4, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
          {w.note}
        </div>
      )}
      {w.note == null && w.pp_ahead != null && (
        <div className="mono" style={{ marginTop: 4, fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
          {w.pp_ahead >= 0
            ? `${localizedNumber(w.pp_ahead, 1)} ${t("pp ahead of the clock - at this pace the window ends before reset", "pkt przed zegarem — przy tym tempie okno skończy się przed resetem")}`
            : `${localizedNumber(Math.abs(w.pp_ahead), 1)} ${t("pp behind the clock - the pace fits within the window", "pkt za zegarem — tempo mieści się w oknie")}`}
        </div>
      )}
    </div>
  );
}
