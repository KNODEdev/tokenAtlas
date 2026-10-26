import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { codexPricingGaps } from "../lib/codex-pricing-gaps";
import { compact } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { TableRow, HelpDot, Table, Th, Td } from "./ui";
import { capacityPlanLabel } from "../lib/codex-capacity";

export function CodexDataIssues({ data, open }: { data: CodexAccountingReport; open: (target: DataSettingsTarget) => void }) {
  const { t } = useI18n();
  const gaps = codexPricingGaps(data);
  const plans = data.windows?.filter(w => !w.plan_detail || w.plan_detail.status !== "resolved") ?? [];
  const context = { account: data.scope.account ?? "all", since: data.scope.since, until: data.scope.until };
  return <section className="data-issues" aria-label={t("Detected gaps and corrections", "Wykryte luki i uzupełnienia")}>
    <div className="ui-toolbar data-issues-head">
      <span>{t("Detected gaps and corrections", "Wykryte luki i uzupełnienia")} · {gaps.length} {t("price intervals", "przedziałów cen")} · {plans.length} {t("cycles with unresolved plan", "cykli z nieustalonym planem")}</span>
      <HelpDot label={t("Detected gaps and corrections", "Wykryte luki i uzupełnienia")}>{t("Suggestions come from indexed requests and counters. Missing dates are separated; days without traffic do not imply missing prices. Saving a dated price recalculates recorded traffic. It cannot recreate missing requests or measured percentages.", "Propozycje wynikają z zaindeksowanych żądań i liczników. Brakujące daty są rozdzielane; dzień bez ruchu nie oznacza braku ceny. Zapis ceny z datami przelicza zapisany ruch. Nie odtworzy brakujących żądań ani pomiarów procentowych.")}</HelpDot>
      <span className="ui-spacer" />
      <button type="button" className="ui-link-button" onClick={() => open({ ...context, area: "data", issue: t("Review archive coverage and events", "Sprawdź zakres archiwum i zdarzenia") })}>{t("Archive coverage and events", "Zakres archiwum i zdarzenia")}</button>
      <button type="button" className="ui-link-button" onClick={() => open({ ...context, area: "subscriptions", issue: t("Confirm dated allowance terms", "Potwierdź warunki limitu w czasie") })}>{t("Plans and promotions", "Plany i promocje")}</button>
    </div>
    {!!gaps.length && <Table tableId="CodexDataIssues:0"><thead><TableRow header><Th columnId="c0">Model</Th><Th columnId="c1">{t("Missing period UTC", "Brakujący okres UTC")}</Th><Th columnId="c2">{t("Unit / mode", "Jednostka / tryb")}</Th><Th columnId="c3">{t("Affected requests / tokens", "Dotknięte żądania / tokeny")}</Th><Th columnId="c4">{t("Action", "Akcja")}</Th></TableRow></thead><tbody>{gaps.map(gap => <TableRow key={JSON.stringify([gap.model, gap.basis, gap.speed, gap.since])}><Td>{gap.model}</Td><Td>{gap.since} — {gap.until}</Td><Td>{gap.basis === "chatgpt_credits" ? t("credits", "kredyty") : "USD"} · {gap.speed}</Td><Td mono>{gap.events} / {compact(gap.tokens)}</Td><Td><button type="button" className="ui-link-button" onClick={() => open({ ...context, ...gap, area: "rates", issue: t("Missing rate for recorded traffic", "Brak stawki dla zapisanego ruchu") })}>{t("Complete this price", "Uzupełnij tę cenę")}</button></Td></TableRow>)}</tbody></Table>}
    {plans.map(w => <div key={w.id} className="data-issues-row">
      <span>{w.start.slice(0, 10)} → {w.end.slice(0, 10)}</span>
      <span className="data-issues-what">{capacityPlanLabel(w)}</span>
      <button type="button" className="ui-link-button" onClick={() => open({ ...context, area: "subscriptions", since: w.start.slice(0, 10), until: w.end.slice(0, 10), issue: t("Review detected plan history", "Sprawdź wykrytą historię planu") })}>{t("Review plan", "Sprawdź plan")}</button>
    </div>)}
    {data.unknown_speed_events > 0 && <p className="data-issues-note">{t("Requests without mode evidence", "Żądania bez informacji o trybie")}: {data.unknown_speed_events}. {t("A price entry does not determine whether these requests used Fast.", "Wpis cennika nie ustala, czy te żądania korzystały z Fast.")}</p>}
  </section>;
}
