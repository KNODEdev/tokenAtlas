import { useMemo, useState } from "react";
import type { ConversationCall, ConversationCourse, ConversationRef } from "../../shared/conversation-course";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useContextPreview } from "../lib/context-premium";
import { conversationApiValue, conversationCacheShare, conversationInput, conversationSummary } from "../lib/conversation-course";
import { useI18n } from "../lib/i18n";
import { compact, full, pct } from "../lib/format";
import { TOKEN_PARTS, tokenPartLabel } from "../lib/token-parts";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { ErrorState, Fact, Facts, GhostButton, HelpDot, LoadingCard } from "./ui";
import { useWidth } from "./WindowStatusCard";
import { ChartExport } from "./ChartExport";
import "./ConversationDrawer.css";

const PAGE_SIZE = 200;
const METRICS = ["input", "cache", "api"] as const;
type CourseMetric = typeof METRICS[number];
const courseValue = (call: ConversationCall, metric: CourseMetric, context: boolean) => metric === "api"
  ? conversationApiValue(call, context) : metric === "cache" ? conversationCacheShare(call) : conversationInput(call);
const preciseUsd = (value: number, locale: string) => "$" + value.toLocaleString(locale,
  { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const tickStyle = { fontFamily: "var(--font-figure)", fontSize: "var(--fs-2)", fill: "var(--muted)" };

export function ConversationDrawer({ conversation, returnFocus, onClose }: {
  conversation: ConversationRef; returnFocus: HTMLElement | null; onClose: () => void;
}) {
  const { t } = useI18n();
  const context = useContextPreview();
  const state = useAsync(signal => api.conversationCourse(conversation, signal), [conversation.vendor, conversation.reference_id]);
  const preview = useAsync(signal => context && conversation.vendor === "codex"
    ? api.conversationCourse({ ...conversation, context: "1" }, signal) : Promise.resolve(null),
    [conversation.vendor, conversation.reference_id, context]);
  const data = context ? preview.data ?? state.data : state.data;
  return <AccountPeriodDrawer title={t("Conversation", "Rozmowa")} subtitle={conversation.vendor}
    busy={false} onClose={onClose} returnFocus={returnFocus} className="ui-detail-drawer" closeLabel={t("Close conversation", "Zamknij rozmowę")}>
    {state.loading && !state.data && <LoadingCard />}
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {context && preview.error && <ErrorState message={preview.error} onRetry={preview.reload} />}
    {data && <ConversationCourseView key={`${conversation.vendor}:${conversation.reference_id}`} course={data} context={context} />}
  </AccountPeriodDrawer>;
}

export function ConversationCourseView({ course, context = false }: { course: ConversationCourse; context?: boolean }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(0);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const summary = useMemo(() => conversationSummary(course, context), [course, context]);
  const shownPage = Math.min(page, Math.max(0, Math.ceil(course.calls.length / PAGE_SIZE) - 1));
  const offset = shownPage * PAGE_SIZE, calls = course.calls.slice(offset, offset + PAGE_SIZE);
  const label = course.unit === "turn" ? t("Turn", "Tura") : course.unit === "generation" ? t("Generation", "Generacja") : t("Call", "Wywołanie");
  const missing = t("no data", "brak danych");
  const pair = (values: readonly (number | null)[], format: (n: number) => string) => values.map(value => value === null ? missing : format(value)).join(" → ");
  const missingPrices = course.calls.filter(call => call.api_usd === null).length;
  const missingContext = context && course.vendor === "codex" && course.calls.some(call => !call.context_price);
  return <section className="conversation-course">
    <ChartExport title={t("Conversation course", "Przebieg rozmowy")}>
      <div className="ui-toolbar">
        <h3>{t("Conversation course", "Przebieg rozmowy")}</h3>
        <HelpDot label={t("Conversation course", "Przebieg rozmowy")}>
          {t("All recorded entries in this conversation, across the list's date and model filters. Input includes tools and other context. API value is the shared stored valuation, not a subscription charge or limit percentage. The figures compare medians of the first and last five entries; at least ten are required. Cache share is cache-read tokens divided by all input tokens. Neither growth nor cache share measures work quality.",
            "Wszystkie zapisane wpisy tej rozmowy, również poza filtrem dat i modelu listy. Wejście obejmuje narzędzia i inne materiały kontekstu. Wartość API pochodzi ze wspólnej zapisanej wyceny; nie jest opłatą za abonament ani procentem limitu. Liczby porównują mediany pierwszych i ostatnich pięciu wpisów; potrzeba co najmniej dziesięciu. Udział cache to tokeny odczytu cache podzielone przez całe wejście. Wzrost i udział cache nie mierzą jakości pracy.")}
          {course.unit === "turn" && t(" Grok records aggregated turns, not individual calls.", " Grok zapisuje zagregowane tury, nie pojedyncze wywołania.")}
          {course.unit === "generation" && t(" Gemini follows the recorded generation order, not conversation timestamps.", " Gemini zachowuje zapisaną kolejność generacji, nie daty całych rozmów.")}
          {course.basis === "source_file" && t(" No conversation identifier is recorded: this view covers one source file.", " Brak identyfikatora rozmowy: widok obejmuje jeden plik źródłowy.")}
          {` · ${course.identity}`}
        </HelpDot>
      </div>
      {summary && <Facts>
        <Fact label={t("Input · start → end", "Wejście · początek → koniec")} value={pair(summary.input, compact)} />
        <Fact label={t("Cache · whole conversation", "Cache · cała rozmowa")} value={summary.cacheShare === null ? missing : pct(summary.cacheShare, 1)} />
        <Fact label={`API / ${label.toLowerCase()}`} value={pair(summary.api, value => preciseUsd(value, locale))} />
      </Facts>}
      {(course.truncated || course.excluded > 0 || course.approximate_order || missingPrices > 0 || missingContext) && <div className="ui-toolbar" role="status">
        {course.truncated && <span className="ui-missing">{t("Partial conversation", "Fragment rozmowy")} · {full(course.calls.length)}</span>}
        {course.excluded > 0 && <span className="ui-missing">{t("Excluded entries", "Pominięte wpisy")} · {full(course.excluded)}</span>}
        {course.approximate_order && <span className="ui-missing">{t("Approximate order", "Przybliżona kolejność")}</span>}
        {missingPrices > 0 && <span className="ui-missing">{t("Missing API value", "Brak wyceny API")} · {full(missingPrices)}</span>}
        {missingContext && <span className="ui-missing">{t("Context preview incomplete", "Podgląd kontekstu niepełny")}</span>}
      </div>}
      {calls.length ? <div onMouseLeave={() => setActiveKey(null)}>
        {METRICS.map(metric => <CoursePlot key={metric} calls={calls} allCalls={course.calls} offset={offset}
          metric={metric} context={context} label={label} activeKey={activeKey} onActive={setActiveKey} />)}
      </div>
        : <p className="ui-missing">{t("No recorded entries", "Brak zapisanych wpisów")}</p>}
    </ChartExport>
    {course.calls.length > PAGE_SIZE && <div className="ui-toolbar">
      <GhostButton disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>← {t("Previous", "Poprzednia")}</GhostButton>
      <span className="ui-figure">{offset + 1}–{offset + calls.length} / {full(course.calls.length)}</span>
      <GhostButton disabled={offset + PAGE_SIZE >= course.calls.length} onClick={() => setPage(shownPage + 1)}>{t("Next", "Następna")} →</GhostButton>
    </div>}
  </section>;
}

function CoursePlot({ calls, allCalls, offset, metric, context, label, activeKey, onActive }: {
  calls: ConversationCall[]; allCalls: ConversationCall[]; offset: number; metric: CourseMetric; context: boolean; label: string;
  activeKey: string | null; onActive: (key: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const [ref, measured] = useWidth(760), width = Math.max(measured, 400);
  const left = 84, right = width - 12, top = 10, bottom = 116;
  const valueOf = (call: ConversationCall) => courseValue(call, metric, context);
  const max = metric === "cache" ? 100 : Math.max(...allCalls.map(call => valueOf(call) ?? 0), metric === "api" ? 0.000001 : 1);
  const format = (value: number) => metric === "api" ? preciseUsd(value, locale) : metric === "cache" ? pct(value, 1) : compact(value);
  const title = metric === "input" ? t("Input size · tokens", "Wielkość wejścia · tokeny")
    : metric === "cache" ? t("Cache read · % of input", "Odczyt z cache · % wejścia") : t("API value", "Wartość API");
  const selectedIndex = calls.findIndex(call => call.key === activeKey);
  const selectedValue = selectedIndex < 0 ? null : valueOf(calls[selectedIndex]!);
  const step = (right - left) / calls.length, bar = Math.min(32, step * 0.8);
  const y = (value: number) => bottom - value / max * (bottom - top);
  return <section ref={ref}>
    <div className="ui-toolbar">
      <h4 style={{ margin: 0, fontSize: "var(--fs-5)" }}>{title}</h4>
      {metric === "cache" && <HelpDot label={title}>{t("Each point is cache-read tokens divided by all input tokens of that entry, including cache writes. The axis is always 0–100%. Missing input or zero input leaves a gap; it is not 0% cache.",
        "Każdy punkt to tokeny odczytu cache podzielone przez całe wejście tego wpisu, łącznie z zapisem cache. Oś zawsze obejmuje 0–100%. Brak wejścia lub zerowe wejście pozostawia lukę; nie oznacza 0% cache.")}</HelpDot>}
      {selectedIndex >= 0 && <span className="ui-figure">{label} {offset + selectedIndex + 1} · {selectedValue === null ? t("no data", "brak danych") : format(selectedValue)}</span>}
    </div>
    <svg viewBox={`0 0 ${width} 154`} width="100%" role="group" aria-label={title}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1={left} x2={right} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={left - 6} y={y(max * fraction) + 4} textAnchor="end" style={tickStyle}>{format(max * fraction)}</text>
      </g>)}
      {calls.map((call, index) => {
        const value = valueOf(call), x = left + step * (index + 0.5) - bar / 2;
        const previous = index > 0 ? valueOf(calls[index - 1]!) : null;
        const cache = conversationCacheShare(call);
        const description = [`${label} ${offset + index + 1}`, call.ts, call.model ?? t("unknown model", "nieznany model"),
          ...TOKEN_PARTS.map(([part]) => `${tokenPartLabel(part, t)}: ${call.tokens ? full(call.tokens[part]) : t("no data", "brak danych")}`),
          `${t("Cache-read share", "Udział odczytu cache")}: ${cache === null ? t("no data", "brak danych") : pct(cache, 1)}`,
          `API-eq: ${conversationApiValue(call, context) === null ? t("no rate", "brak stawki") : preciseUsd(conversationApiValue(call, context)!, locale)}`].join(" · ");
        return <g key={call.key} tabIndex={0} aria-label={description} onMouseEnter={() => onActive(call.key)}
          onFocus={() => onActive(call.key)} onBlur={() => onActive(null)}>
          <title>{description}</title>
          <rect x={left + step * index} y={top} width={step} height={bottom - top}
            fill={activeKey === call.key ? "var(--accent-soft)" : "transparent"} />
          {value === null ? <text x={x + bar / 2} y={bottom - 4} textAnchor="middle" style={tickStyle}>?</text>
            : metric === "cache" ? <>
              {previous !== null && <line x1={x + bar / 2 - step} x2={x + bar / 2} y1={y(previous)} y2={y(value)}
                stroke="var(--violet)" strokeWidth={1.75} strokeLinecap="round" />}
              <circle cx={x + bar / 2} cy={y(value)} r={activeKey === call.key ? 3 : 1.75} fill="var(--violet)" />
            </>
            : value === 0 ? <line x1={x} x2={x + bar} y1={bottom} y2={bottom} stroke="var(--accent)" strokeWidth={2} />
              : <rect x={x} y={y(value)} width={bar} height={bottom - y(value)} fill="var(--accent)" />}
          {(index === 0 || index === calls.length - 1 || index % Math.max(1, Math.ceil(calls.length / 8)) === 0) &&
            <text x={x + bar / 2} y={bottom + 18} textAnchor="middle" style={tickStyle}>{offset + index + 1}</text>}
        </g>;
      })}
      <text x={(left + right) / 2} y={151} textAnchor="middle" style={tickStyle}>{label}</text>
    </svg>
  </section>;
}
