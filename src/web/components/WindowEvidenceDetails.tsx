import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { assessWindowQuality, type QualityReason, type WindowQuality } from "../../shared/subscription-quality";
import type { DataSettingsTarget } from "../lib/data-settings";
import { useI18n } from "../lib/i18n";
import { compact } from "../lib/format";
import { privateText } from "../lib/privacy";
import { TableRow, HelpBlock, HelpDot, Table, Th, Td } from "./ui";
import { Chip } from "./WindowStatusCard";
import "./WindowEvidenceDetails.css";

const labels: Record<WindowQuality | QualityReason, [string, string]> = {
  manual_measurement: ["Manually entered percentage readings", "Procenty wpisane ręcznie"],
  approximate_time: ["Estimate using recorded conversation/file dates", "Przybliżenie według zapisanych dat rozmowy/pliku"],
  comparable: ["Comparable measurements", "Porównywalne pomiary"], partial: ["Partial evidence", "Częściowe dane"], insufficient: ["Insufficient evidence", "Niewystarczające dane"],
  no_traffic: ["No matched token traffic", "Brak dopasowanego ruchu tokenowego"], small_meter_change: ["Small meter increase", "Mały przyrost licznika"],
  no_prices: ["No priced traffic", "Brak wycenionego ruchu"], unknown_plan: ["Plan or multiplier unconfirmed", "Plan lub mnożnik niepotwierdzony"],
  inferred_zero: ["Initial zero inferred from reset", "Początkowe zero wywnioskowane z resetu"], uncertain_reset: ["Next reset uncertain", "Kolejny reset niepewny"],
  meter_gap: ["More than 30 minutes between readings", "Ponad 30 minut między odczytami"], partial_prices: ["Some traffic has no price", "Część ruchu bez ceny"],
  unknown_mode: ["Some billing modes unknown", "Część trybów naliczania nieznana"], source_without_traffic: ["Declared source without recorded traffic", "Zadeklarowane źródło bez zapisanego ruchu"],
  mismatched_counter: ["Traffic with mismatched plan or reset excluded", "Pominięto ruch z innym planem lub resetem"], evidence_unavailable: ["Source evidence unavailable", "Brak danych o źródłach pomiaru"],
  source_identity_unresolved: ["Account traffic cannot identify individual computers", "Ruch konta nie identyfikuje poszczególnych komputerów"], conditional_code_estimate: ["Code capacity is a conditional account estimate", "Pojemność Code jest warunkowym szacunkiem konta"],
  share_never_reported: ["No Code share from the provider: local traffic taken as the whole meter", "Dostawca nie podał udziału Code: ruch lokalny przyjęty jako cały licznik"], imprecise_time: ["Own-counter traffic with imprecise timestamps excluded", "Pominięto ruch tego licznika z niedokładnym czasem"],
};

/** Quality status as a traffic-light tone; the reasons stay neutral so a cycle is not a wall of warnings. */
export const QUALITY_TONE: Record<WindowQuality, string> = { comparable: "var(--ok)", partial: "var(--warn)", insufficient: "var(--crit)" };

export function qualityLabel(key: WindowQuality | QualityReason, t: (en: string, pl: string) => string): string {
  return t(...labels[key]);
}

export function WindowQualityLabel({ window }: { window: CodexComparisonWindow }) {
  const { t } = useI18n();
  const quality = assessWindowQuality(window);
  return <span className="window-quality" data-quality={quality.status} title={quality.reasons.map(r => t(...labels[r])).join(" · ")}>{window.manual_measurement && `${t("Manual reading", "Pomiar ręczny")} · `}{window.manual_measurement?.approximate_time && `${t("Approximate dates", "Przybliżone daty")} · `}{t(...labels[quality.status])}</span>;
}

/** The evidence behind one cycle, as status chips, a small data table and short fact lines. */
export function WindowEvidenceDetails({ window: w, open, unfolded = false }: { window: CodexComparisonWindow; open?: (target: DataSettingsTarget) => void; unfolded?: boolean }) {
  const { t, locale } = useI18n();
  const Disclosure = unfolded ? "section" : "details";
  const DisclosureTitle = unfolded ? "h4" : "summary";
  const EvidenceNote = unfolded ? HelpDot : "p";
  const q = assessWindowQuality(w), e = w.evidence;
  const total = w.cycle_usage ?? w.usage;
  const date = (ts: string) => ts.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "").replace(/Z$/, "");
  const name = (source: string) => privateText(source.split(/[\\/]/).at(-1) ?? source);
  const context = { account: w.account, since: (w.cycle_start ?? w.start).slice(0, 10), until: (w.cycle_end ?? w.reset).slice(0, 10) };
  const sensitivity = q.rounding.lower_pp > 0 && w.usage.events > w.usage.unpriced_events
    ? [w.usage.api_standard * 100 / q.rounding.upper_pp, w.usage.api_standard * 100 / q.rounding.lower_pp] : null;
  const usd = (value: number) => value.toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const reasons = q.reasons.filter(reason => reason !== "manual_measurement" && reason !== "approximate_time");
  const excluded = e ? [
    [t("other counter", "inny licznik"), e.excluded_events.counter], [t("imprecise time", "niedokładny czas"), e.excluded_events.imprecise_time ?? 0],
    [t("other funding", "inne finansowanie"), e.excluded_events.funding ?? 0], [t("plan mismatch", "inny plan"), e.excluded_events.plan], [t("reset mismatch", "inny reset"), e.excluded_events.reset],
  ] as const : [];
  return <section className="evidence" aria-label={t("Cycle evidence", "Podstawy pomiaru cyklu")}>
    <div className="evidence-chips">
      <Chip tone={QUALITY_TONE[q.status]} title={q.reasons.map(r => t(...labels[r])).join(" · ")}>{t(...labels[q.status])}</Chip>
      {w.manual_measurement && <Chip tone="var(--accent)">{t("Manual reading", "Pomiar ręczny")}</Chip>}
      {w.manual_measurement?.approximate_time && <Chip tone="var(--warn)">{t("Approximate dates", "Przybliżone daty")}</Chip>}
      {reasons.map(reason => <Chip key={reason} tone="var(--muted)">{t(...labels[reason])}</Chip>)}
      <HelpDot label={t("Comparison eligibility", "Warunki porównywalności")}>
        <HelpBlock>{t("Comparison eligibility requires at least 10 pp, a known plan, priced traffic, known relevant modes, observed endpoints and gaps no longer than 30 minutes. This is an explicit analysis policy, not proof of complete logs or an unchanged subscription budget.", "Do porównywalnych pomiarów wymagamy co najmniej 10 p.p., znanego planu, wycenionego ruchu, znanych istotnych trybów, odczytanych granic i przerw do 30 minut. To jawna reguła analizy, nie dowód pełnych logów ani stałego budżetu abonamentu.")}</HelpBlock>
        <HelpBlock>{t("Archive completeness remains unconfirmed. Unattributed traffic cannot be assigned to this cycle without evidence. No traffic from a declared computer may mean inactivity or missing logs.", "Kompletność archiwum pozostaje niepotwierdzona. Ruchu bez właściciela nie można przypisać do tego cyklu bez dowodu. Brak ruchu z zadeklarowanego komputera może oznaczać bezczynność albo brak logów.")}</HelpBlock>
      </HelpDot>
    </div>
    {w.manual_measurement?.note && <p className="evidence-note">{w.manual_measurement.note}</p>}
    <div className="evidence-grid">
      <Table tableId="WindowEvidenceDetails:0"><thead><TableRow header><Th columnId="c0">{t("Traffic", "Ruch")}</Th><Th columnId="c1" align="right">{t("Requests", "Żądania")}</Th><Th columnId="c2" align="right">{t("Tokens", "Tokeny")}</Th></TableRow></thead><tbody>
        <TableRow><Td>{t("Recorded in cycle", "Zapisane w cyklu")}</Td><Td mono align="right">{total.events.toLocaleString(locale)}</Td><Td mono align="right">{compact(total.tokens)}</Td></TableRow>
        <TableRow><Td>{t("Matched to meter increase", "Dopasowane do przyrostu licznika")}</Td><Td mono align="right">{w.usage.events.toLocaleString(locale)}</Td><Td mono align="right">{compact(w.usage.tokens)}</Td></TableRow>
        <TableRow><Td>{t("Outside measured interval", "Poza zmierzonym przedziałem")}</Td><Td mono align="right">{Math.max(0, total.events - w.usage.events).toLocaleString(locale)}</Td><Td mono align="right">{compact(Math.max(0, total.tokens - w.usage.tokens))}</Td></TableRow>
        <TableRow><Td>{t("Without price inside measured interval", "Bez ceny w zmierzonym przedziale")}</Td><Td mono align="right">{w.usage.unpriced_events.toLocaleString(locale)}</Td><Td mono align="right">{compact(Math.max(0, w.usage.tokens - w.usage.priced_tokens))}</Td></TableRow>
      </tbody></Table>
      <dl className="evidence-facts">
        <dt>{t("Meter sample", "Próbka licznika")}</dt>
        <dd className="mono">{date(w.start)} → {date(w.end)} UTC · {w.start_percent}% → {w.end_percent}%
          {w.start_basis === "reset" && (w.first_probe?.percent ?? 0) > 0 && <span className="evidence-faint"> · {t("first actual reading", "pierwszy rzeczywisty odczyt")} {w.first_probe!.percent}% {date(w.first_probe!.ts)}</span>}</dd>
        <dt>{t("Rounding ±1 pp", "Zaokrąglenie ±1 p.p.")}</dt>
        <dd className="mono">{q.rounding.lower_pp}–{q.rounding.upper_pp} {t("pp", "p.p.")}{sensitivity && <> → API / 100%: {sensitivity.map(usd).join(" – ")}</>}
          <HelpDot label={t("Rounding scenario", "Scenariusz zaokrąglenia")}>{t("Each boundary reading may be off by ±1 pp. This is not a confidence interval or a documented provider rounding rule. Missing traffic, inferred zero and meter delay can exceed this scenario.", "Każdy odczyt graniczny może różnić się o ±1 p.p. To nie jest przedział ufności ani udokumentowana reguła zaokrąglania dostawcy. Brak ruchu, wywnioskowane zero i opóźnienia licznika mogą wykraczać poza ten scenariusz.")}</HelpDot></dd>
        {e && <><dt>{t("Excluded events", "Pominięte zdarzenia")}</dt>
          <dd className="mono">{excluded.map(([label, count], index) => <span key={label} className={count ? undefined : "evidence-faint"}>{index > 0 && " · "}{label} {count}</span>)}</dd></>}
      </dl>
    </div>
    {e && <>
      {!!e.sources.length && <Table tableId="WindowEvidenceDetails:1"><thead><TableRow header><Th columnId="c0">{t("Recorded source", "Zapisane źródło")}</Th><Th columnId="c1">{t("First → last traffic UTC", "Pierwszy → ostatni ruch UTC")}</Th><Th columnId="c2" align="right">{t("Cycle requests / tokens", "Żądania / tokeny cyklu")}</Th><Th columnId="c3" align="right">{t("Matched", "Dopasowane")}</Th></TableRow></thead>
        <tbody>{e.sources.map(source => <TableRow key={source.name}><Td>{name(source.name)}</Td><Td mono>{date(source.first)} → {date(source.last)}</Td><Td mono align="right">{source.events} / {compact(source.tokens)}</Td><Td mono align="right">{source.paired_events} / {compact(source.paired_tokens)}</Td></TableRow>)}</tbody></Table>}
      {e.declared_sources.length ? <ul className="evidence-declared">{e.declared_sources.map(source => <li key={JSON.stringify(source)}>
        <span className="mono">{name(source.name)}</span> <span className="evidence-faint mono">{source.from ? date(source.from) : "…"} → {source.until ? date(source.until) : "…"}</span>
        {" · "}{source.observed === null ? t("account traffic observed; physical source unresolved", "ruch konta zapisany; źródło fizyczne nieustalone") : source.observed ? t("traffic recorded", "ruch zapisany") : t("no eligible traffic recorded; source completeness unknown", "brak zapisanego ruchu tego licznika; kompletność źródła nieznana")}</li>)}</ul>
        : <p className="evidence-faint">{t("No expected source list is available for this cycle.", "Brak listy oczekiwanych źródeł dla tego cyklu.")}</p>}
      <div className="evidence-disclosures">
        {e.imports ? <Disclosure className="capacity-detail"><DisclosureTitle>{t("Stored provider import attempts", "Zapisane próby importu dostawcy")} · {e.imports.related_count}</DisclosureTitle>
          <EvidenceNote>{t("Provider-wide evidence: a run during this cycle or an import whose changed timestamp range overlaps it. It does not identify every source or certify completeness. Historical synchronization gaps remain unknown.", "Dane dla całego dostawcy: uruchomienie w czasie cyklu albo import ze zmienionym zakresem dat obejmującym cykl. Nie identyfikują każdego źródła i nie potwierdzają kompletności. Historyczne przerwy synchronizacji pozostają nieustalone.")}</EvidenceNote>
          <EvidenceNote>{t("Inspected stored runs", "Sprawdzone zapisane uruchomienia")}: {e.imports.inspected_runs}/{e.imports.stored_runs} · {t("unreadable results", "nieczytelne wyniki")}: {e.imports.unreadable_runs}. {t("Showing up to 10 related attempts from the latest 200 stored runs.", "Pokazano do 10 powiązanych prób z ostatnich 200 zapisanych uruchomień.")}</EvidenceNote>
          <Table tableId="WindowEvidenceDetails:2"><thead><TableRow header><Th columnId="c0">UTC</Th><Th columnId="c1">{t("Status", "Stan")}</Th><Th columnId="c2">{t("Evidence", "Powiązanie")}</Th><Th columnId="c3">{t("Errors / warnings", "Błędy / ostrzeżenia")}</Th></TableRow></thead><tbody>{e.imports.related.map(run => <TableRow key={run.id}><Td mono>{date(run.started)}</Td><Td>{run.status}</Td><Td>{run.relation === "changed_range" ? t("changed data dates", "daty zmienionych danych") : t("execution time only", "tylko czas uruchomienia")}</Td><Td>{run.has_error ? t("reported error", "zgłoszony błąd") : t("no error reported", "nie zgłoszono błędu")} / {run.warnings}</Td></TableRow>)}</tbody></Table>
        </Disclosure> : <p className="evidence-faint">{t("No persisted import history is available for this report.", "Brak trwałej historii importów dostępnej dla tego raportu.")}</p>}
        <Disclosure className="capacity-detail"><DisclosureTitle>{t("Gaps between meter readings over 5 minutes", "Przerwy między odczytami ponad 5 minut")} · {e.meter_gaps.length}</DisclosureTitle>
          <EvidenceNote>{t("A gap between observations does not itself prove missing requests. Historical synchronization uptime is not established by token timestamps.", "Przerwa między odczytami sama nie dowodzi brakujących żądań. Znaczniki tokenów nie ustalają historycznej ciągłości synchronizacji.")}</EvidenceNote>
          <Table tableId="WindowEvidenceDetails:3"><thead><TableRow header><Th columnId="c0">UTC</Th><Th columnId="c1" align="right">min</Th></TableRow></thead><tbody>{e.meter_gaps.map((gap, i) => <TableRow key={i}><Td mono>{date(gap.from)} → {date(gap.to)}</Td><Td mono align="right">{gap.minutes.toLocaleString(locale, { maximumFractionDigits: 1 })}</Td></TableRow>)}</tbody></Table>
        </Disclosure>
      </div>
    </>}
    {open && <div className="ui-toolbar evidence-actions">
      <button type="button" className="ui-link-button" onClick={() => open({ ...context, area: "data", issue: t("Review sources and meter gaps for this cycle", "Sprawdź źródła i luki pomiarów tego cyklu") })}>{t("Complete cycle data", "Uzupełnij dane cyklu")}</button>
      <button type="button" className="ui-link-button" onClick={() => open({ ...context, area: "subscriptions", issue: t("Confirm the plan and allowance terms for this cycle", "Potwierdź plan i warunki limitu tego cyklu") })}>{t("Confirm cycle plan", "Potwierdź plan cyklu")}</button>
    </div>}
  </section>;
}
