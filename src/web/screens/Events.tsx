import { Fragment, useMemo, useState } from "react";
import type { ScreenProps } from "../lib/screens";
import { api, type UsageEvent } from "../lib/api";
import { withoutBucket } from "../../projects/bucket";
import { useAsync } from "../lib/useAsync";
import { compact, full, pct, usd } from "../lib/format";
import { providerColor } from "../lib/roster";
import { useI18n } from "../lib/i18n";
import { accountFilterable, EVENT_VENDORS, eventFiltersFor, eventsRequest, type EventFilters, type EventOrder, type EventsTarget, type EventVendor } from "../lib/events-filter";
import { surfaceName } from "../lib/surfaces";
import { TOKEN_PARTS, tokenPartLabel, type TokenPart } from "../lib/token-parts";
import { TableColGroup, TableRow, Card, EmptyState, ErrorState, Field, GhostButton, HelpDot, LoadingCard, Selector, Table, Td, Th } from "../components/ui";
import { Chip, Stack } from "../components/WindowStatusCard";
import "./History.css";
import "./Events.css";
import { ConversationDrawer } from "../components/ConversationDrawer";
import type { ConversationRef } from "../../shared/conversation-course";

const PAGE_SIZE = 50;
const VENDOR_NAMES: Record<Exclude<EventVendor, "all">, string> = { codex: "Codex", claude: "Claude", opencode: "opencode", gemini: "Gemini", grok: "Grok" };
const ORDERS: { value: EventOrder; en: string; pl: string }[] = [
  { value: "ts_desc", en: "newest first", pl: "od najnowszych" },
  { value: "ts_asc", en: "oldest first", pl: "od najstarszych" },
  { value: "tokens_desc", en: "largest first", pl: "od największych" },
];

function partsOf(event: UsageEvent): { part: TokenPart; value: number; color: string }[] {
  const values: Record<TokenPart, number> = { input: event.in_uncached, cache_read: event.in_cached, cache_write: event.cache_write, output: event.out };
  return TOKEN_PARTS.map(([part, color]) => ({ part, value: Math.max(0, values[part]), color }));
}

/**
 * The bottom of the drill-down: single calls of the header subscription by default (UI audit
 * decision 14), or of the subscription, dates and model another screen opened it with.
 */
export function Events(props: ScreenProps) {
  const target = props.eventsTarget && props.eventsTarget.account === props.account ? props.eventsTarget : null;
  const initial = eventFiltersFor(props.account, props.accounts, props.project, target);
  // Another header subscription, project or target starts the filters over.
  return <EventList key={JSON.stringify(initial)} {...props} initial={initial} target={target} />;
}

function EventList({ initial, target, accounts, goto }: ScreenProps & { initial: EventFilters; target: EventsTarget | null }) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{ ref: ConversationRef; trigger: HTMLElement } | null>(null);
  const update = (patch: Partial<EventFilters>) => { setFilters(current => ({ ...current, ...patch })); setOffset(0); setOpen(null); };
  const scope = filters.account ? { account: filters.account } : filters.vendor !== "all" ? { vendor: filters.vendor } : {};
  const modelsState = useAsync(signal => api.breakdown({ dim: "model", ...scope, project_id: filters.project || undefined }, signal),
    [filters.account, filters.vendor, filters.project]);
  const projectsState = useAsync(() => api.projects(), []);
  const eventsState = useAsync(signal => api.events({ ...eventsRequest(filters, offset, PAGE_SIZE), conversation: "1" }, signal), [filters, offset]);
  const subscriptions = useMemo(() => accounts.filter(account => accountFilterable(account.vendor) && account.has_events)
    .map(account => ({ value: account.id, label: account.label ?? account.id })).sort((a, b) => a.label.localeCompare(b.label)), [accounts]);
  const models = useMemo(() => {
    const names = [...new Set((modelsState.data?.rows ?? []).map(row => row.name))];
    if (filters.model && !names.includes(filters.model)) names.push(filters.model);
    return [{ value: "", label: t("all", "wszystkie") }, ...names.sort().map(name => ({ value: name, label: name }))];
  }, [modelsState.data, filters.model, t]);
  const projects = useMemo(() => [
    { value: "", label: t("all", "wszystkie") },
    { value: "unassigned", label: t("unassigned", "nieprzypisane") },
    ...withoutBucket(projectsState.data?.projects ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(project => ({ value: project.id, label: project.name })),
  ], [projectsState.data, t]);
  const changed = JSON.stringify(filters) !== JSON.stringify(initial);
  const data = eventsState.data;
  const rows = data?.rows ?? [];
  const bySubscription = !filters.account;
  const columns = bySubscription ? 8 : 7;
  const time = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const seconds = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const orderLabel = ORDERS.find(order => order.value === filters.order)!;
  // The list stands on the paper (paper-atlas §3) without a card title repeating the screen's name;
  // the order sits with the other filters and the row definition moves into its help.
  return (
    <Card frame={false}>
      {target && <div className="events-origin" title={filters.fromTs
        ? `${t("Exactly the window", "Dokładnie okno")} [${filters.fromTs} → ${filters.untilTs ?? t("now", "teraz")}), UTC`
        : t("The list covers whole UTC days; calls just outside the window can appear at its edges.", "Lista obejmuje całe dni UTC; na brzegach mogą się pojawić wywołania tuż spoza okna.")}>
        {t("Came from", "Przyszło z")}: <b>{target.origin}</b> · <button type="button" className="ui-link-button" onClick={() => goto(target.returnScreen)}>← {t("back", "wróć")}</button>
      </div>}
      <div className="ui-toolbar events-filters">
        <Selector label={t("Subscription", "Subskrypcja")} strong={!!filters.account} value={filters.account ?? ""}
          onChange={value => update({ account: value || null, vendor: "all", model: "" })}
          options={[{ value: "", label: t("all", "wszystkie") }, ...subscriptions]} />
        {bySubscription && <Selector label={t("Provider", "Dostawca")} strong={filters.vendor !== "all"} value={filters.vendor}
          onChange={value => update({ vendor: value as EventVendor, model: "" })}
          options={EVENT_VENDORS.map(vendor => ({ value: vendor, label: vendor === "all" ? t("all", "wszyscy") : VENDOR_NAMES[vendor] }))} />}
        <Selector label="Model" strong={!!filters.model} value={filters.model} onChange={value => update({ model: value })} options={models} />
        <Selector label={t("Project", "Projekt")} strong={!!filters.project} value={filters.project} onChange={value => update({ project: value })} options={projects} />
        <Field label={t("Dates (UTC)", "Daty (UTC)")}>
          <input type="date" className="ui-date-input" aria-label={t("From (UTC)", "Od (UTC)")} value={filters.since} max={filters.until || undefined}
            onChange={event => update({ since: event.target.value, fromTs: undefined, untilTs: undefined })} />
          <span className="events-faint">→</span>
          <input type="date" className="ui-date-input" aria-label={t("Through (UTC)", "Do (UTC)")} value={filters.until} min={filters.since || undefined}
            onChange={event => update({ until: event.target.value, fromTs: undefined, untilTs: undefined })} />
        </Field>
        <Selector label={t("Order", "Kolejność")} value={filters.order} onChange={value => update({ order: value as EventOrder })}
          options={ORDERS.map(order => ({ value: order.value, label: t(order.en, order.pl) }))} />
        <HelpDot label={t("Usage events", "Zdarzenia użycia")}>{t("One row = one call; Grok: one turn of several calls.", "Jeden wiersz = jedno wywołanie; Grok: jedna tura z kilku wywołań.")}</HelpDot>
        {changed && <GhostButton onClick={() => { setFilters(initial); setOffset(0); setOpen(null); }}>{t("Reset filters", "Przywróć filtry")}</GhostButton>}
      </div>
      {eventsState.error && <ErrorState message={eventsState.error} onRetry={eventsState.reload} />}
      {!eventsState.error && !data && <LoadingCard label={t("Loading events…", "Wczytywanie zdarzeń…")} height={320} shape="table" />}
      {data && rows.length === 0 && <EmptyState title={t("No events for these filters", "Brak zdarzeń dla tych filtrów")}
        detail={t("Widen the dates or remove the model filter; the index holds only synchronized data.", "Poszerz daty albo zdejmij filtr modelu; indeks zawiera tylko zsynchronizowane dane.")} />}
      {data && rows.length > 0 && <>
        <div className="events-summary">
          {t("rows", "wiersze")} {full(offset + 1)}–{full(offset + rows.length)} · {t(orderLabel.en, orderLabel.pl)} · {t(
            "totals for the whole filter are not available: the server returns one page at a time, and a page is not summed",
            "sumy całego filtra są niedostępne: serwer zwraca po jednej stronie, a strony nie sumujemy")}
        </div>
        <Table tableId="Events:0" fixed>
          <TableColGroup>
            <col style={{ width: "13%" }} />
            {bySubscription && <col style={{ width: "11%" }} />}
            <col style={{ width: bySubscription ? "16%" : "19%" }} />
            <col style={{ width: bySubscription ? "14%" : "17%" }} />
            <col style={{ width: bySubscription ? "12%" : "14%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: bySubscription ? "13%" : "16%" }} />
          </TableColGroup>
          <thead><TableRow header>
            <Th columnId="c0">{t("Time", "Czas")}</Th>
            {bySubscription && <Th columnId="c1">{t("Subscription", "Subskrypcja")}</Th>}
            <Th columnId="c2">Model</Th>
            <Th columnId="c3">{t("Context", "Kontekst")}</Th>
            <Th columnId="c4">{t("Project", "Projekt")}</Th>
            <Th columnId="c5" align="right" title={t("Codex counts cache reads inside input, Claude records them apart: compare providers by the composition, not the total.", "Codex liczy odczyty z cache wewnątrz wejścia, Claude osobno: dostawców porównuj składem, nie sumą.")}>{t("Tokens", "Tokeny")}</Th>
            <Th columnId="c6" title={TOKEN_PARTS.map(([part]) => tokenPartLabel(part, t)).join(" · ")}>{t("Composition", "Skład")}</Th>
            <Th columnId="c7" align="right">API-eq</Th>
          </TableRow></thead>
          <tbody>
            {rows.map((event, index) => {
              const key = `${event.vendor}:${event.ts}:${offset + index}`;
              const expanded = open === key;
              const parts = partsOf(event);
              const partsSum = parts.reduce((sum, part) => sum + part.value, 0);
              const unpriced = event.usd === 0 && event.model != null && event.model in data.unpriced.models;
              const turn = event.vendor === "grok" ? /\((\d+)/.exec(event.surface ?? "")?.[1] ?? null : null;
              const generation = event.vendor === "gemini" ? /gen #(\d+)/.exec(event.surface ?? "")?.[1] ?? null : null;
              const clip = { overflow: "hidden", textOverflow: "ellipsis" } as const;
              return <Fragment key={key}>
                <TableRow className="hoverline events-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
                  <Td mono style={clip} title={`${seconds.format(new Date(event.ts))} · ${event.ts}`}>{time.format(new Date(event.ts))}</Td>
                  {bySubscription && <Td style={clip} title={event.account ?? event.vendor}>
                    <span className="events-provider"><i style={{ background: providerColor(event.vendor) }} />{event.account ?? VENDOR_NAMES[event.vendor as Exclude<EventVendor, "all">] ?? event.vendor}</span>
                  </Td>}
                  <Td style={clip} title={event.model ?? undefined}>{event.model ?? "?"}</Td>
                  <Td style={clip} title={event.surface ?? undefined}>
                    {turn != null ? <Chip tone="var(--muted)" soft="var(--raised)" title={t("An aggregated Grok turn: one row stands for several model calls.", "Zagregowana tura Groka: jeden wiersz to kilka wywołań modelu.")}>
                      {t("turn", "tura")} · {turn} {t("calls", "wywołań")}</Chip>
                      : generation != null ? <span className="events-muted">gen #{generation}</span>
                      : event.surface ? surfaceName(event.surface, t) : <span className="events-muted">—</span>}
                  </Td>
                  <Td style={clip} title={event.project ?? undefined}>{event.project ?? <span className="events-muted">—</span>}</Td>
                  <Td mono align="right" title={`${full(event.tokens)} ${t("tokens", "tokenów")}`}>{compact(event.tokens)}</Td>
                  <Td title={parts.map(part => `${tokenPartLabel(part.part, t)} ${partsSum > 0 ? pct(part.value / partsSum * 100, 1) : "—"}`).join(" · ")}>
                    <Stack parts={parts.map(part => ({ value: part.value, color: part.color }))} />
                  </Td>
                  <Td mono align="right" title={unpriced ? t("This model has no rate in the price list.", "Ten model nie ma stawki w cenniku.") : full(event.usd)}>
                    {unpriced ? <span className="events-muted">{t("no rate", "brak stawki")}</span> : usd(event.usd)}
                  </Td>
                </TableRow>
                {expanded && <TableRow className="events-detail"><Td colSpan={columns}>
                  <div className="archive-legend">
                    {parts.map(part => <span key={part.part}><i style={{ background: part.color }} />{tokenPartLabel(part.part, t)} <b>{full(part.value)}</b></span>)}
                    <span>{t("of which reasoning", "w tym rozumowanie")} <b>{full(event.reasoning)}</b></span>
                    <span>API-eq <b>{unpriced ? t("no rate", "brak stawki") : usd(event.usd)}</b></span>
                    {event.surface && <span className="events-muted">{event.surface}</span>}
                    {event.conversation && <button type="button" className="ui-link-button" onClick={click =>
                      setConversation({ ref: event.conversation!, trigger: click.currentTarget })}>{t("Conversation", "Rozmowa")} →</button>}
                  </div>
                </Td></TableRow>}
              </Fragment>;
            })}
          </tbody>
        </Table>
        <div className="events-pages">
          <span>{t("page", "strona")} {full(offset / PAGE_SIZE + 1)}</span>
          <div className="ui-toolbar">
            <GhostButton onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setOpen(null); }} disabled={offset === 0}>← {t("Previous", "Poprzednia")}</GhostButton>
            <GhostButton onClick={() => { setOffset(offset + PAGE_SIZE); setOpen(null); }} disabled={!data.has_more}>{t("Next", "Następna")} →</GhostButton>
          </div>
        </div>
      </>}
      {conversation && <ConversationDrawer conversation={conversation.ref} returnFocus={conversation.trigger} onClose={() => setConversation(null)} />}
    </Card>
  );
}
