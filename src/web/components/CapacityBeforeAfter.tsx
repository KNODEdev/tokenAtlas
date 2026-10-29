import { useEffect, useId, useMemo, useState } from "react";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { compact } from "../lib/format";
import { vendorColor } from "../lib/model-colors";
import { providerName } from "../lib/capacity-compare";
import { catalogTiers, cycleTier } from "../lib/capacity-battle";
import { capacityPlanLabel, capacityUnitFormat, deviationColor, signedDeviation, type CapacityUnit } from "../lib/codex-capacity";
import { BEFORE_AFTER_MAX_EVENTS, BEFORE_AFTER_MIN_PP, beforeAfterLayout, defaultEventIds, drawableMarkers, eligibleCycles, isPlanChange,
  isWeeklyWindow, PROJECTION_FRACTION, projectionValue, recentMedian, WEEKLY_MINUTES, type BeforeAfterCycle, type BeforeAfterEvent } from "../lib/capacity-before-after";
import { markerDisplayLabel } from "./CapacityAnnotations";
import { ChartExport } from "./ChartExport";
import { Disclosure, Field, HelpBlock, HelpDot, Selector } from "./ui";
import { useWidth } from "./WindowStatusCard";
import "./CapacityBeforeAfter.css";

const STORAGE_KEY = "tokenatlas.capacity-before-after.v1";
/** Per subscription: chosen event ids (null = the default pick), the projection and the same-price subscription ("" = none). */
interface Choice { events: string[] | null; projection: boolean | null; compare: string | null }
const NO_CHOICE: Choice = { events: null, projection: null, compare: null };
function readChoice(scope: string): Choice {
  try {
    const saved = (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Partial<Choice>>)[scope];
    return { events: Array.isArray(saved?.events) ? saved.events.filter(id => typeof id === "string") : null,
      projection: typeof saved?.projection === "boolean" ? saved.projection : null, compare: typeof saved?.compare === "string" ? saved.compare : null };
  } catch { return NO_CHOICE; }
}
function writeChoice(scope: string, choice: Choice) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Choice>;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [scope]: choice }));
  } catch { /* The choice still applies for this visit. */ }
}

// Chart geometry in CSS pixels; bars and gaps shrink together when the sheet is narrow.
const BAR = 38, INNER = 12, MARKER_GAP = 34, GROUP_GAP = 40;
const LEFT = 52, RIGHT = 8, PLOT = 300, AXIS = 44, LANE = 52, LABEL_BASE = 30;
const textWidth = (text: string, size: number, figure = false) => text.length * size * (figure ? 0.62 : 0.56);
const clip = (text: string, max = 28) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const dayTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const utc = (time: number) => Number.isFinite(time) ? new Date(time).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?";

function niceStep(max: number) {
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].map(factor => factor * power).find(step => raw <= step) ?? 10 * power);
}

/** Bar with rounded top corners, standing on the axis. */
function barPath(x: number, y: number, width: number, bottom: number) {
  const r = Math.min(3, width / 2, Math.max(0, bottom - y));
  return `M${x} ${bottom}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${bottom}Z`;
}

interface CompareOption { value: string; provider: string; label: string; plan: string; median: number | null; count: number; lowerBound: boolean; price: number | null }

function planPrice(provider: string, window: Window | undefined): number | null {
  const tier = window ? cycleTier(window) : null;
  if (!window || tier === null) return null;
  return catalogTiers(provider, (window.cycle_start ?? window.start).slice(0, 10)).find(item => item.tier === tier)?.usdPerMonth ?? null;
}

interface BeforeAfterProps {
  windows: Window[]; unit: CapacityUnit; basis: CapacityBasis; markers: TimelineMarker[]; provider: string; account: string;
  range?: { since: string; until: string };
  /** The tab is chosen: only then is the same-price comparison read. */
  active: boolean;
}

/** One measured element for the empty states and the chart, so the width keeps following the sheet. */
export function CapacityBeforeAfter(props: BeforeAfterProps) {
  const [ref, width] = useWidth(1100);
  return <div ref={ref} className="before-after"><BeforeAfterView {...props} width={width} /></div>;
}

function BeforeAfterView({ windows, unit, basis, markers, provider, account, range, active, width }: BeforeAfterProps & { width: number }) {
  const { t, locale } = useI18n();
  const id = useId(), hatchId = `before-after-hatch-${id.replace(/:/g, "")}`;
  const scope = `${provider}:${account}`;
  const [choice, setChoiceState] = useState(() => readChoice(scope));
  useEffect(() => setChoiceState(readChoice(scope)), [scope]);
  const setChoice = (patch: Partial<Choice>) => setChoiceState(current => { const next = { ...current, ...patch }; writeChoice(scope, next); return next; });
  const [eventsOpen, setEventsOpen] = useState(false);
  const unitFormat = capacityUnitFormat(unit, locale);
  const dayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", timeZone: "UTC" }), [locale]);
  const shortDay = (time: number) => Number.isFinite(time) ? dayFormat.format(time) : "?";
  const ownColor = vendorColor(provider) ?? "var(--accent)";
  const until = range?.until ?? new Date().toISOString().slice(0, 10);

  const weekly = windows.filter(isWeeklyWindow);
  const cycles = useMemo(() => eligibleCycles(weekly, unit, basis), [windows, unit, basis]);
  const candidates = useMemo(() => drawableMarkers(markers, cycles).sort((a, b) => dayTime(a.day) - dayTime(b.day)), [markers, cycles]);
  const defaults = useMemo(() => defaultEventIds(markers, cycles), [markers, cycles]);
  const chosenIds = (choice.events ?? defaults).filter(item => candidates.some(marker => marker.id === item)).slice(0, BEFORE_AFTER_MAX_EVENTS);
  const chosen = candidates.filter(marker => chosenIds.includes(marker.id));
  const layout = beforeAfterLayout(cycles, chosen);
  const latest = cycles.at(-1);
  const ownPrice = planPrice(provider, latest?.window);

  const sameWindow = useAsync(signal => !active || !cycles.length ? Promise.resolve(null)
    : api.capacityCycles({ since: new Date(dayTime(until) - 30 * 86_400_000).toISOString().slice(0, 10), until, window_minutes: WEEKLY_MINUTES }, signal),
  [active, cycles.length > 0, until]);
  const compareOptions = useMemo<CompareOption[]>(() => (sameWindow.data?.accounts ?? [])
    .filter(entry => entry.account.toLowerCase() !== account.toLowerCase() && !entry.error && !entry.unavailable && !entry.account.endsWith("::business"))
    .flatMap(entry => {
      const own = entry.windows.filter(window => window.account.toLowerCase() === entry.account.toLowerCase());
      const result = recentMedian(own, unit, until, basis);
      const newest = result.cycles.at(-1)?.window;
      if (result.value === null || !newest) return [];
      const plan = capacityPlanLabel(newest);
      return [{ value: `${entry.account}\u0000${entry.counter}`, provider: entry.provider, plan, median: result.value, count: result.count,
        lowerBound: result.lowerBound, price: planPrice(entry.provider, newest), label: `${providerName(entry.provider)} ${plan} · ${entry.account}` }];
    }), [sameWindow.data, account, unit, until, basis]);
  // Default: another provider's subscription at this one's monthly price.
  const defaultCompare = ownPrice === null ? "" : compareOptions.find(option => option.provider !== provider && option.price === ownPrice)?.value ?? "";
  const compareValue = choice.compare ?? defaultCompare;
  const compare = compareOptions.find(option => option.value === compareValue) ?? null;
  const projectionOn = choice.projection ?? chosen.some(isPlanChange);
  const projection = projectionOn ? projectionValue(cycles) : null;

  if (!weekly.length) return <p className="capacity-note" role="status">{t("Before / after compares 7-day weekly cycles. Choose the weekly counter.", "Przed i po porównuje 7-dniowe cykle tygodniowe. Wybierz licznik tygodniowy.")}</p>;
  if (!cycles.length) return <p className="capacity-note" role="status">{t("No weekly cycle with at least {0} pp of the meter in these dates. Choose a longer period.", `Brak cyklu tygodniowego z co najmniej ${BEFORE_AFTER_MIN_PP} p.p. licznika w tych datach. Wybierz dłuższy okres.`, [BEFORE_AFTER_MIN_PP])}</p>;

  // Horizontal layout in units, scaled to the sheet afterwards.
  type Placed = { x: number; value: number; fill: string; kind: "cycle" | "projection" | "other"; line1: string; line2: string; title: string; ink: boolean };
  const cycleTitle = (cycle: BeforeAfterCycle) => [
    `${utc(cycle.start)} → ${utc(cycle.end)}${cycle.end > Date.now() ? ` · ${t("running, estimate so far", "trwa, szacunek na razie")}` : ""}`,
    `${capacityPlanLabel(cycle.window)} · ${t("meter", "licznik")} +${cycle.window.observed_pp.toLocaleString(locale, { maximumFractionDigits: 1 })} ${t("pp", "p.p.")}`,
    `${cycle.lowerBound ? "≥ " : "≈ "}${unitFormat.full(cycle.value)} ${t("at 100%", "przy 100%")}${cycle.lowerBound ? ` · ${t("calls without a price: lower bound", "wywołania bez ceny: dolna granica")}` : ""}`,
  ].join("\n");
  const arrange = (groupGap: number, markerGap: number) => {
    const placed: Placed[] = [], markerAt: { x: number; event: BeforeAfterEvent }[] = [];
    let cursor = 0;
    layout.runs.forEach((run, index) => {
      if (index) cursor += groupGap;
      run.bars.forEach((bar, position) => {
        if (position) {
          const event = run.markers.get(position);
          if (event) { markerAt.push({ x: cursor + markerGap / 2, event }); cursor += markerGap; } else cursor += INNER;
        }
        placed.push({ x: cursor, value: bar.cycle.value, kind: "cycle", fill: bar.role === "before" ? "var(--pencil)" : ownColor,
          line1: shortDay(bar.cycle.start), line2: `${Math.round(bar.cycle.window.observed_pp)}%`, title: cycleTitle(bar.cycle), ink: false });
        cursor += BAR;
      });
    });
    return { placed, markerAt, cursor };
  };
  const tier = latest?.window.plan_detail?.multiplier ?? null;
  const extras: Omit<Placed, "x">[] = [];
  if (projection !== null && latest) extras.push({ value: projection, kind: "projection", fill: "var(--crit-soft)", ink: true,
    line1: `${providerName(provider)} ${tier ? `${(tier * PROJECTION_FRACTION).toLocaleString(locale)}×` : "½"}`, line2: t("if ½ of now", "gdyby ½ obecnej"),
    title: t("Projection, not a measurement: half of the latest cycle ({0}), as if the allowance were halved.", `Projekcja, nie pomiar: połowa ostatniego cyklu (${unitFormat.full(latest.value)}), gdyby limit zmniejszono o połowę.`, [unitFormat.full(latest.value)]) });
  if (compare?.median != null) extras.push({ value: compare.median, kind: "other", fill: vendorColor(compare.provider) ?? "var(--accent)", ink: true,
    line1: providerName(compare.provider), line2: compare.plan,
    title: `${compare.label}\n${t("Median of its weekly cycles that started in the last 31 days, each with at least {0} pp of the meter.", `Mediana jego cykli tygodniowych rozpoczętych w ostatnich 31 dniach, każdy z co najmniej ${BEFORE_AFTER_MIN_PP} p.p. licznika.`, [BEFORE_AFTER_MIN_PP])}${compare.lowerBound ? `\n${t("calls without a price: lower bound", "wywołania bez ceny: dolna granica")}` : ""}` });
  // The comparison group keeps room for its two-line names; only the cycles shrink on a narrow sheet.
  const slots = extras.map(extra => Math.max(BAR + 2 * INNER, textWidth(extra.line1, 12) + 16, textWidth(extra.line2, 11) + 16));
  const extrasWidth = extras.length ? GROUP_GAP + slots.reduce((sum, slot) => sum + slot, 0) : 0;
  const available = width - LEFT - RIGHT - 16;
  // A crowded sheet narrows the gaps between groups and at markers before the bars and their dates.
  const roomy = arrange(GROUP_GAP, MARKER_GAP);
  const { placed, markerAt, cursor } = (available - extrasWidth) / roomy.cursor < 0.7 ? arrange(GROUP_GAP * 0.55, MARKER_GAP * 0.65) : roomy;
  const scale = Math.min(1, Math.max(0.3, (available - extrasWidth) / Math.max(1, cursor)));
  const origin = LEFT + 8 + Math.max(0, (available - cursor * scale - extrasWidth) / 2);
  const X = (units: number) => origin + units * scale;
  const barWidth = BAR * scale;
  let slotLeft = cursor * scale + GROUP_GAP;
  extras.forEach((extra, index) => {
    placed.push({ ...extra, x: (slotLeft + slots[index]! / 2 - barWidth / 2) / scale });
    slotLeft += slots[index]!;
  });
  // Dates step down a size before neighbouring ones would touch.
  const slot = (BAR + INNER) * scale;
  const dateSize = [12, 11].find(size => slot >= textWidth("00/00", size) + 6) ?? 10;

  // Event labels: date, then two lines; a label that would overlap one on its left moves up a lane.
  const labels = markerAt.map(({ x, event }) => {
    const [primary, ...more] = event.markers;
    const [head, ...rest] = markerDisplayLabel(primary!).split(" · ");
    const second = rest.join(" · ") || (more[0] ? markerDisplayLabel(more[0]).split(" · ")[0]! : "");
    const extra = more.length - (rest.length ? 0 : 1);
    const lines = [clip(head ?? ""), clip(second) + (extra > 0 ? ` +${extra}` : "")];
    const date = shortDay(dayTime(event.day));
    const half = Math.max(textWidth(date, 13, true), ...lines.map(line => textWidth(line, 12))) / 2;
    const center = Math.min(Math.max(X(x), half + 2), width - half - 2);
    return { x: X(x), center, half, lines, date, event, lane: 0 };
  });
  const laneEnds: number[] = [];
  for (const label of labels) {
    let lane = laneEnds.findIndex(end => label.center - label.half > end + 10);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = label.center + label.half; label.lane = lane;
  }
  const lanes = laneEnds.length;
  const top = lanes ? 4 + 13 + 33 + LABEL_BASE + (lanes - 1) * LANE : 30;
  const bottom = top + PLOT, height = bottom + AXIS;
  const peak = Math.max(...placed.map(item => item.value), 1);
  const step = niceStep(peak * 1.12), max = Math.ceil(peak * 1.12 / step) * step;
  const y = (value: number) => bottom - value / max * PLOT;
  const tick = (value: number) => unit === "api_standard" ? `$${compact(value)}` : compact(value);
  // Value labels keep their full figure; one that would touch its left neighbour's label steps up a line.
  const valueText = (item: Placed) => `${item.kind === "projection" ? "~" : ""}${unitFormat.full(item.value)}`;
  const valueY: number[] = [], valueBoxes: { left: number; right: number; y: number }[] = [];
  for (const item of placed) {
    const center = X(item.x) + barWidth / 2, half = textWidth(valueText(item), 12, true) / 2;
    let at = y(item.value) - 7;
    const clash = () => valueBoxes.find(box => center - half < box.right + 3 && center + half > box.left - 3 && Math.abs(box.y - at) < 14);
    for (let box = clash(); box; box = clash()) at = box.y - 14;
    valueY.push(at); valueBoxes.push({ left: center - half, right: center + half, y: at });
  }

  const { headline } = layout;
  const headlineEvent = headline.event ? shortDay(dayTime(headline.event.day)) : null;
  const vendorLine = `${providerName(provider)} · ${latest ? capacityPlanLabel(latest.window) : ""}${ownPrice !== null ? ` · $${ownPrice.toLocaleString(locale)}${t("/mo", "/mies.")}` : ""}`;
  const eventsTitle = (event: BeforeAfterEvent) => event.markers.map(marker => `${marker.day} · ${markerDisplayLabel(marker)}${marker.note ? `\n${marker.note}` : ""}`).join("\n\n");
  const title = t("What one full 7-day allowance buys", "Ile daje jeden pełny 7-dniowy limit");

  return <>
    <div className="ui-toolbar before-after-controls">
      <Disclosure open={eventsOpen} onToggle={() => setEventsOpen(!eventsOpen)} controls={`${id}-events`}>
        {t("Events", "Wydarzenia")} · {chosen.length}/{BEFORE_AFTER_MAX_EVENTS}
      </Disclosure>
      <label className="ui-check">
        <input type="checkbox" checked={projectionOn} onChange={event => setChoice({ projection: event.target.checked })} />
        {t("Projection: ½ of now", "Projekcja: ½ obecnej")}
      </label>
      <Field label={t("Same price", "Ta sama cena")}>
        <Selector ariaLabel={t("Compare with another subscription", "Porównaj z inną subskrypcją")} value={compare ? compareValue : ""}
          onChange={value => setChoice({ compare: value })} options={[{ value: "", label: t("None", "Brak") },
            ...compareOptions.map(option => ({ value: option.value, label: option.price !== null ? `${option.label} · $${option.price.toLocaleString(locale)}` : option.label }))]} />
      </Field>
      {sameWindow.error && <span className="ui-alert" role="status">{t("Other subscriptions unavailable", "Inne subskrypcje niedostępne")}</span>}
    </div>
    {eventsOpen && <div id={`${id}-events`} className="ui-checks before-after-events" role="group" aria-label={t("Events on the chart", "Wydarzenia na wykresie")}>
      {!candidates.length && <span className="capacity-note">{t("No event in these dates has a weekly cycle on both sides.", "Żadne wydarzenie w tych datach nie ma cyklu tygodniowego po obu stronach.")}</span>}
      {candidates.map(marker => {
        const checked = chosenIds.includes(marker.id);
        return <label key={marker.id} className="ui-check" title={marker.note}>
          <input type="checkbox" checked={checked} disabled={!checked && chosenIds.length >= BEFORE_AFTER_MAX_EVENTS}
            onChange={event => setChoice({ events: event.target.checked ? [...chosenIds, marker.id] : chosenIds.filter(item => item !== marker.id) })} />
          {shortDay(dayTime(marker.day))} · {clip(markerDisplayLabel(marker), 48)}
        </label>;
      })}
    </div>}
    <ChartExport title={`${title} · ${vendorLine}`}>
      <div className="before-after-sheet">
        <div className="before-after-head">
          <div className="before-after-heading">
            <div className="before-after-scope">
              <span className="before-after-window">{t("7-day weekly limit · reset to reset", "7-dniowy limit tygodniowy · od resetu do resetu")}</span>
              <span>{vendorLine}</span>
            </div>
            <h3 className="before-after-title">{title}</h3>
            <p className="before-after-note">{t("Each bar is one weekly cycle, measured reset to reset; an early reset can end a cycle before 7 days. Values are the Cycles table's estimate at 100%.", "Każdy słupek to jeden cykl tygodniowy, mierzony od resetu do resetu; wcześniejszy reset może zakończyć cykl przed upływem 7 dni. Wartości to szacunek 100% z tabeli Cykle.")}
              <span data-capture-exclude=""><HelpDot label={t("About before / after", "O widoku przed i po")}>
                <HelpBlock>{t("Bars use the same estimate as Cycles: recorded traffic in the chosen unit ÷ weekly-meter increase × 100. Only the weekly counter is compared, and only cycles with at least {0} pp of the meter.", `Słupki to ten sam szacunek co w Cyklach: zapisany ruch w wybranej jednostce ÷ przyrost licznika tygodniowego × 100. Porównujemy tylko licznik tygodniowy i tylko cykle z co najmniej ${BEFORE_AFTER_MIN_PP} p.p. licznika.`, [BEFORE_AFTER_MIN_PP])}</HelpBlock>
                <HelpBlock>{t("Around each event: the two cycles that started before its day and the two that started on or after it. A cycle is drawn once; events between the same cycles share a marker. The last group is the two latest cycles.", "Wokół każdego wydarzenia: dwa cykle rozpoczęte przed jego dniem i dwa rozpoczęte w tym dniu lub później. Cykl jest rysowany raz; wydarzenia między tymi samymi cyklami mają wspólny znacznik. Ostatnia grupa to dwa najnowsze cykle.")}</HelpBlock>
                <HelpBlock>{t("Headline: the median of the first event's later cycles → the median of the latest cycles. The projection is half of the latest cycle, not a measurement. Another subscription shows the median of its weekly cycles from the last 31 days. Hover a bar or marker for exact UTC times, the meter increase and lower bounds (≥).", "Nagłówek: mediana cykli po pierwszym wydarzeniu → mediana najnowszych cykli. Projekcja to połowa ostatniego cyklu, nie pomiar. Inna subskrypcja pokazuje medianę swoich cykli tygodniowych z ostatnich 31 dni. Wskaż słupek lub znacznik, aby zobaczyć dokładne czasy UTC, przyrost licznika i dolne granice (≥).")}</HelpBlock>
              </HelpDot></span>
            </p>
          </div>
          <div className="before-after-headline" title={headline.event ? eventsTitle(headline.event) : undefined}>
            <span className="before-after-figure">
              {headline.after !== null && <>{unitFormat.full(headline.after)} <span className="before-after-arrow">→</span> </>}
              {headline.now !== null ? unitFormat.full(headline.now) : "—"}
            </span>
            <span className="before-after-change" style={{ color: headline.change === null ? "var(--muted)" : deviationColor(headline.change) }}>
              {headline.change !== null && headlineEvent
                ? t("{0} since {1}", `${signedDeviation(headline.change, locale)} od ${headlineEvent}`, [signedDeviation(headline.change, locale), headlineEvent])
                : t("median of the latest cycles", "mediana najnowszych cykli")}
            </span>
          </div>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" className="before-after-chart"
          aria-label={`${title} · ${t("per 100% of the 7-day limit", "na 100% limitu 7-dniowego")}`}>
          <defs>
            <pattern id={hatchId} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={7} stroke="var(--hatch)" strokeWidth={1.2} />
            </pattern>
          </defs>
          <text x={0} y={top - 10} fontSize={12} fontWeight={500} fill="var(--faint)" fontFamily="var(--font-sans)">{t("per 100% of the 7-day limit", "na 100% limitu 7-dniowego")}</text>
          {Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step).map(value => <g key={value}>
            {value > 0 && <line x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray="2 4" />}
            <text x={LEFT - 10} y={y(value) + 4} textAnchor="end" fontSize={11} fill="var(--faint)" fontFamily="var(--font-figure)">{tick(value)}</text>
          </g>)}
          <line x1={LEFT} x2={width - RIGHT} y1={bottom + 0.5} y2={bottom + 0.5} stroke="var(--line2)" />
          {/* Markers first, so bars and their value labels stay on top of the dashed lines. */}
          {labels.map(label => {
            const color = label.event.tone === "crit" ? "var(--crit)" : "var(--warn)";
            const base = top - LABEL_BASE - label.lane * LANE;
            return <g key={label.event.split} className="before-after-marker" tabIndex={0} aria-label={label.event.markers.map(markerDisplayLabel).join(", ")}>
              <title>{eventsTitle(label.event)}</title>
              <line x1={label.x} x2={label.x} y1={top - 4} y2={bottom} stroke={color} strokeWidth={1.4} strokeDasharray="5 4" />
              <circle cx={label.x} cy={top - 4} r={3.5} fill={color} />
              <text x={label.center} y={base - 33} textAnchor="middle" fontSize={13} fontWeight={600} fontFamily="var(--font-figure)" fill={color}>{label.date}</text>
              <text x={label.center} y={base - 16} textAnchor="middle" fontSize={12} fontWeight={500} fontFamily="var(--font-sans)" fill="var(--text)">{label.lines[0]}</text>
              <text x={label.center} y={base} textAnchor="middle" fontSize={12} fontFamily="var(--font-sans)" fill="var(--muted)">{label.lines[1]}</text>
            </g>;
          })}
          {placed.map((item, index) => {
            const left = X(item.x), center = left + barWidth / 2, barTop = y(item.value);
            const projected = item.kind === "projection";
            return <g key={index}>
              <title>{item.title}</title>
              {projected
                ? <path d={barPath(left + 0.8, barTop, barWidth - 1.6, bottom)} fill="var(--crit-soft)" stroke="var(--crit)" strokeWidth={1.6} strokeDasharray="5 4" />
                : <>
                  <path d={barPath(left, barTop, barWidth, bottom)} fill={item.fill} />
                  <path d={barPath(left, barTop, barWidth, bottom)} fill={`url(#${hatchId})`} />
                </>}
              <text x={center} y={valueY[index]} textAnchor="middle" fontSize={12} fontWeight={600} fontFamily="var(--font-figure)"
                fill={projected ? "var(--crit)" : "var(--text)"} stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{valueText(item)}</text>
              <text x={center} y={bottom + 18} textAnchor="middle" fontSize={item.kind === "cycle" ? dateSize : 12} fontWeight={500} fontFamily="var(--font-sans)"
                fill={item.ink ? "var(--text)" : "var(--muted)"}>{item.line1}</text>
              <text x={center} y={bottom + 34} textAnchor="middle" fontSize={item.kind === "cycle" ? Math.min(11, dateSize) : 11} fontFamily="var(--font-sans)" fill="var(--faint)">{item.line2}</text>
            </g>;
          })}
        </svg>
        <div className="before-after-legend">
          {layout.events.length > 0 && <span><i className="before-after-swatch" style={{ backgroundColor: "var(--pencil)" }} />{t("before the date", "przed datą")}</span>}
          <span><i className="before-after-swatch" style={{ backgroundColor: ownColor }} />{layout.events.length ? t("after and now", "po i obecnie") : t("latest cycles", "najnowsze cykle")}</span>
          {projection !== null && <span><i className="before-after-swatch is-projection" />{t("projection", "projekcja")} · {t("if ½ of now", "gdyby ½ obecnej")}</span>}
          {compare?.median != null && <span><i className="before-after-swatch" style={{ backgroundColor: vendorColor(compare.provider) ?? "var(--accent)" }} />{providerName(compare.provider)} {compare.plan} · {t("median of {0} weekly cycles", `mediana ${compare.count} cykli tygodniowych`, [compare.count])}</span>}
          <span className="before-after-faint">{t("% under a bar = weekly-meter increase behind the estimate", "% pod słupkiem = przyrost licznika tygodniowego za szacunkiem")}</span>
        </div>
      </div>
    </ChartExport>
  </>;
}
