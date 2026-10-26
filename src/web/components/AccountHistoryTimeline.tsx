import { ChartExport } from "./ChartExport";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { PeriodSource, PlanPeriodRow } from "../../shared/account-periods";
import { api } from "../lib/api";
import { dayTime, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { useAsync } from "../lib/useAsync";
import type { RailWindow } from "../lib/windows";
import { effectivePeriodRows, formatStamp, planDisplay, type SourceTimeline } from "./AccountPeriodGroups";
import type { TimelineRow } from "./AccountPeriodsSettings";
import { subscriptionPlan } from "../lib/subscription-plan";
import { formatPlanLabel } from "../../shared/plan-label";
import type { BillingCycle } from "../../shared/billing-cycles";
import { CycleLaneMarks, cycleBasis, cycleFigures, cycleMarks, cycleMoney, cyclePrice, cycleUsd } from "./BillingCycles";
import { DataTable, TableRow, DetailTabs, HelpDot, type DetailTab } from "./ui";

const DAY = 86_400_000;
/** Timeline ranges in days; 0 is the whole history. */
const RANGES = [...TIME_RANGE_DAYS, 0];
const HOUR = 3_600_000;
const EDGE_PX = 8;
export const planName = (value: string, provider?: string, day?: string) => subscriptionPlan(provider ?? "", value, day) ?? value;
const end = (value: string | null) => value === null ? Infinity : Date.parse(value);
const iso = (ms: number) => new Date(ms).toISOString();
const originalKey = (row: PlanPeriodRow) => `${row.provider}|${row.account}|${row.id}`;
/** The one catalog tier of a segment; records that disagree give none. */
function segmentTier(segment: PlanSegment): { label: string; multiplier: number | null } | null {
  const tiers = [...new Map(segment.records.map((row) => [JSON.stringify(row.tier ?? null), row.tier ?? null])).values()];
  return tiers.length === 1 ? tiers[0]! : null;
}
/** Same colours as the capacity charts: ×1 green, ×5 blue, ×20 violet. */
const tierClass = (tier: { multiplier: number | null } | null) =>
  tier?.multiplier === 1 || tier?.multiplier === 5 || tier?.multiplier === 20 ? ` is-tier-${tier.multiplier}` : "";

/** Aliases retain their own declaration precedence. Conflicting aliases are shown, never guessed. */
export function effectivePlanRows(plans: PlanPeriodRow[]) {
  return [...new Set(plans.map((row) => row.account))].flatMap((account) => effectivePeriodRows(plans.filter((row) => row.account === account)));
}
export interface PlanSegment { from: number; until: number; label: string | null; conflict: boolean; records: PlanPeriodRow[] }
/** A plan stretch with its billing cycles and the declared periods that have no cycle yet; a loose cycle has no stretch. */
interface PlanGroup { key: string; segment: PlanSegment | null; cycles: BillingCycle[]; pending: PlanPeriodRow[]; from: number; until: number | null }
export function planSegments(plans: PlanPeriodRow[], from: number, until: number): PlanSegment[] {
  const rows = effectivePlanRows(plans);
  const bounds = [...new Set([from, until, ...rows.flatMap((row) => [Date.parse(row.from), end(row.until)])])]
    .filter((value) => value >= from && value <= until).sort((a, b) => a - b);
  const result: PlanSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!, stop = bounds[i + 1]!;
    const records = rows.filter((row) => Date.parse(row.from) <= start && start < end(row.until)).map((row) => row.row);
    const labels = [...new Set(records.map((row) => planDisplay(row.plan)))].sort();
    const label = labels.length ? labels.join(" / ") : null;
    const prior = result[result.length - 1];
    if (prior && prior.label === label && prior.until === start) {
      prior.until = stop;
      prior.records = [...new Map([...prior.records, ...records].map((row) => [originalKey(row), row])).values()];
    } else result.push({ from: start, until: stop, label, conflict: labels.length > 1, records });
  }
  return result;
}

/** Plan-less stretches between two known plans: a lapse, not the time before the first or after the last plan. */
export function planBreaks(plans: PlanPeriodRow[], now: number): { from: number; until: number }[] {
  const starts = plans.map((row) => Date.parse(row.from)).filter(Number.isFinite);
  if (!starts.length) return [];
  const segments = planSegments(plans, Math.min(...starts), now);
  return segments.filter((segment, index) => segment.label === null && index > 0 && index < segments.length - 1
    && segments[index - 1]!.label !== null && segments[index + 1]!.label !== null)
    .map(({ from, until }) => ({ from, until }));
}

const STRIP_DAYS = 90;
/** The last 90 days of an account's plans in the multiplier colours, for the account list (UI audit, Settings). */
export function PlanStrip({ plans, provider, now }: { plans: PlanPeriodRow[]; provider: string; now: number }) {
  const { t } = useI18n();
  const from = now - STRIP_DAYS * DAY;
  const segments = planSegments(plans, from, now);
  const day = (ms: number) => new Date(ms).toLocaleDateString(t("en-GB", "pl-PL"), { day: "2-digit", month: "2-digit" });
  return <span className="account-periods-strip" aria-label={t("Plans in the last 90 days", "Plany z ostatnich 90 dni")}>
    {segments.map((segment) => <i key={segment.from} style={{ width: `${100 * (segment.until - segment.from) / (now - from)}%` }}
      className={segment.label === null ? "is-unknown" : segment.conflict ? "is-conflict" : `is-plan${tierClass(segmentTier(segment))}`}
      title={`${segment.label === null ? t("no plan", "bez planu") : segment.conflict ? t("Conflicting readings", "Sprzeczne odczyty") : planName(segment.label, provider)} · ${day(segment.from)} → ${day(segment.until)}`} />)}
  </span>;
}

export interface PlanPeriodSelection {
  provider: string; account: string; aliases: string[];
  from: string; until: string | null; records: PlanPeriodRow[];
}
/** A bar dragged on the chart: which edge moved, by how much, and where an open-ended bar was drawn to end. */
export interface PeriodShift { mode: "move" | "start" | "end"; delta: number; end: number }
/** Applies a drag to a stored period; an ongoing period stays ongoing unless its end itself was dragged. */
export function shiftPeriod(from: string, until: string | null, shift: PeriodShift): { from: string; until: string | null } {
  return {
    from: shift.mode === "end" ? from : iso(Date.parse(from) + shift.delta),
    until: shift.mode === "start" ? until
      : until === null ? (shift.mode === "end" ? iso(shift.end + shift.delta) : null)
      : iso(Date.parse(until) + shift.delta),
  };
}
/** `released` keeps a finished drag drawn at its new place until the change it started settles. */
interface Drag { key: string; mode: PeriodShift["mode"]; x: number; left: number; msPerPx: number; min: number; max: number; delta: number; moved: boolean; released?: boolean }

/** A tab the caller adds after the history tables in the switcher under the chart (Settings: the account's settings). */
export type { DetailTab } from "./ui";

/** Without a shift the callbacks open the editor; with one they apply the dragged dates. */
export function AccountHistoryTimeline({ plans, timelines, provider, account, aliases, onPlanPeriod, onSourcePeriod, editing, priceGaps = [], cycles = [], cyclesStale = false, cyclesPendingFrom = null, onCycle,
  sections = [], detail: detailProp, onDetail, reveal = false, onRevealed }: {
  plans: PlanPeriodRow[]; timelines: SourceTimeline[]; provider: string; account: string; aliases: string[];
  onPlanPeriod: (selection: PlanPeriodSelection, shift?: PeriodShift) => void;
  onSourcePeriod: (source: PeriodSource, row: TimelineRow, shift?: PeriodShift) => void;
  editing: boolean;
  /** Settings only: stretches of traffic without a plan price (they blank the plan cost in Projects), with the priced account. */
  priceGaps?: Array<{ account: string; from: string; until: string }>;
  /** Settings only: the account's billing cycles (docs/billing-cycles-design-2026-10-08.md §7) and their editor. */
  cycles?: BillingCycle[];
  cyclesStale?: boolean;
  /** The start a just-saved edit recalculates from; null when the cycles are only refreshing in the background. */
  cyclesPendingFrom?: string | null;
  onCycle?: (cycle: BillingCycle, confirm?: boolean) => void;
  /** Tabs after the history tables in the switcher under the chart. */
  sections?: DetailTab[];
  /** The switcher's open tab when the caller keeps it (null: the first one); `onDetail` reports a choice. */
  detail?: string | null;
  onDetail?: (key: string) => void;
  /** Brings the switcher into view once (a link asked for one of its tabs); `onRevealed` clears the request. */
  reveal?: boolean;
  onRevealed?: () => void;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(0);
  const [tab, setTab] = useState<"periods" | "windows">("periods");
  // Read only while the tab is open; the rail endpoint serves the same windows as the Overview.
  const limitWindows = useAsync((signal) => tab === "windows" ? api.windows({ account }, signal) : Promise.resolve(null), [tab, account]);
  const [now] = useState(Date.now);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** A bar clicked without dragging marks its row in the table below, and the other way round. */
  const [selected, setSelected] = useState<string | null>(null);
  /** A table row under the pointer outlines its bar on the chart. */
  const [hovered, setHovered] = useState<string | null>(null);
  /** Plans whose cycles the owner folded away in the subscription table; every plan starts unfolded. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  // The switcher under the chart shows one table at a time; a bar clicked on the chart opens its table.
  const [ownDetail, setOwnDetail] = useState<string | null>(null);
  const detail = detailProp !== undefined ? detailProp : ownDetail;
  const chooseDetail = (key: string) => { setOwnDetail(key); onDetail?.(key); };
  const details = useRef<HTMLDivElement>(null);
  const tableRows = useRef(new Map<string, HTMLTableRowElement>());
  const rowRef = (key: string) => (node: HTMLTableRowElement | null) => {
    if (node) tableRows.current.set(key, node); else tableRows.current.delete(key);
  };
  useEffect(() => { if (selected) chooseDetail(selected.startsWith("plan|") || selected.startsWith("cycle|") ? "subscription" : "computers"); }, [selected]);
  useEffect(() => { if (selected) tableRows.current.get(selected)?.scrollIntoView?.({ block: "nearest" }); }, [selected, detail]);
  useEffect(() => {
    if (!reveal) return;
    details.current?.scrollIntoView?.({ block: "start" });
    onRevealed?.();
  }, [reveal]);
  // The parent marks the card busy in the same update as the release, so this waits for the save or the editor.
  useEffect(() => { if (!editing && drag?.released) setDrag(null); }, [editing, drag]);
  // A price gap can start before any period (traffic before the first plan), so the chart reaches it too.
  const starts = [...plans.map((row) => Date.parse(row.from)), ...timelines.flatMap(({ rows }) => rows.map((row) => Date.parse(row.from))),
    ...priceGaps.map((gap) => Date.parse(gap.from))].filter(Number.isFinite);
  const ends = [...plans.map((row) => row.until ? Date.parse(row.until) : now), ...timelines.flatMap(({ rows }) => rows.map((row) => row.until ? Date.parse(row.until) : now))].filter(Number.isFinite);
  const until = Math.max(now, ...ends, ...starts) + 1;
  const from = zoom ? until - zoom * DAY : Math.min(until - DAY, ...starts);
  // Segments come from the whole history so a zoomed chart never hands a clipped start to an edit.
  const allSegments = planSegments(plans, Math.min(until - DAY, ...starts), until);
  const segments = allSegments.filter((segment) => segment.until > from);
  const position = (key: string, start: number, stop: number) => {
    if (drag?.key === key && drag.moved) {
      if (drag.mode !== "end") start += drag.delta;
      if (drag.mode !== "start") stop += drag.delta;
    }
    return { left: `${100 * (Math.max(start, from) - from) / (until - from)}%`, width: `${100 * Math.max(0, Math.min(stop, until) - Math.max(start, from)) / (until - from)}%` };
  };
  // Every date here is on this computer's clock, as the editor's fields are.
  const shortDate = (value: number) => new Date(value).toLocaleDateString(t("en-GB", "pl-PL"), { day: "numeric", month: "short", year: zoom && zoom < 180 ? undefined : "numeric" });
  const dayMonth = (value: string) => new Date(Date.parse(value)).toLocaleDateString(t("en-GB", "pl-PL"), { day: "2-digit", month: "2-digit" });
  const sourceTitle = (row: TimelineRow) => `${formatStamp(row.from)} → ${row.until ? formatStamp(row.until) : t("now", "teraz")}`;
  const basis = (row: TimelineRow) => row.period?.origin === "declared" ? t("Your declaration", "Twój wpis") : t("From readings", "Z odczytów");
  const marked = (key: string) => `${selected === key ? " is-selected" : ""}${hovered === key ? " is-hovered" : ""}`;
  const hover = (key: string) => ({ onMouseEnter: () => setHovered(key), onMouseLeave: () => setHovered((current) => current === key ? null : current) });
  /** Days with one decimal; an ongoing period counts until now. */
  const locale = t("en-GB", "pl-PL");
  const days = (start: number, stop: number) => (Math.round((stop - start) / DAY * 10) / 10).toLocaleString(t("en-GB", "pl-PL"), { maximumFractionDigits: 1 });
  /**
   * Dragging the body moves a period and dragging an edge resizes it; the release applies the change.
   * A click without a drag selects `pick`'s key at the pointer's time (a billing cycle inside the plan), or else the bar.
   */
  const dragProps = (key: string, start: number, stop: number, commit: (shift: PeriodShift) => void, pick?: (at: number) => string | null) => editing ? {} : {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.button !== 0) return;
      const box = event.currentTarget.getBoundingClientRect();
      const trackBox = event.currentTarget.parentElement?.getBoundingClientRect();
      const track = trackBox?.width ?? 0;
      if (!track) return;
      const x = event.clientX - box.left;
      const mode = x <= EDGE_PX ? "start" : x >= box.width - EDGE_PX ? "end" : "move";
      const span = stop - start;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ key, mode, x: event.clientX, left: trackBox?.left ?? NaN, msPerPx: (until - from) / track, delta: 0, moved: false,
        min: mode === "end" ? HOUR - span : -Infinity, max: mode === "start" ? span - HOUR : Infinity });
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (drag?.key !== key || drag.released) return;
      const pixels = event.clientX - drag.x;
      const delta = Math.min(drag.max, Math.max(drag.min, Math.round(pixels * drag.msPerPx / HOUR) * HOUR));
      setDrag({ ...drag, delta, moved: drag.moved || Math.abs(pixels) > 3 });
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (drag?.key !== key || drag.released) return;
      if (!drag.moved || drag.delta === 0) {
        setDrag(null);
        if (!drag.moved) setSelected(pick?.(from + ((event?.clientX ?? NaN) - drag.left) * drag.msPerPx) ?? key);
        return;
      }
      setDrag({ ...drag, released: true });
      commit({ mode: drag.mode, delta: drag.delta, end: stop });
    },
    onPointerCancel() { if (!drag?.released) setDrag(null); },
  };
  /** The editor opens only from this button, so pressing it never starts a drag. */
  const editButton = (label: string, open: () => void) => <button type="button" className="account-history-edit" disabled={editing}
    aria-label={`${t("Edit", "Edytuj")}: ${label}`} title={t("Edit period", "Edytuj okres")}
    onPointerDown={(event) => event.stopPropagation()} onClick={open}>✎</button>;
  const planSelection = (segment: PlanSegment): PlanPeriodSelection => ({
    provider, account, aliases, from: iso(segment.from),
    until: segment.until === until && until <= now + 1 ? null : iso(segment.until), records: segment.records,
  });
  const visible = (row: TimelineRow) => Date.parse(row.from) < until && end(row.until) > from;
  const assignments = timelines.flatMap(({ source, rows }) => rows.filter(visible).map((row) => ({ source, row })))
    .sort((a, b) => Date.parse(b.row.from) - Date.parse(a.row.from));
  const withCycles = cycles.length > 0 && !!onCycle;
  const cycleAt = (at: number) => {
    const cycle = onCycle ? cycles.find((candidate) => Date.parse(candidate.start) <= at && at < Date.parse(candidate.end)) : undefined;
    return cycle ? `cycle|${cycle.start}` : null;
  };
  const planAt = (at: number) => {
    const segment = segments.find((candidate) => candidate.from <= at && at < candidate.until);
    return segment?.label && !segment.conflict ? planName(segment.label, provider) : null;
  };
  /**
   * The subscription table: each plan stretch with the billing cycles it holds, newest first. A cycle belongs to the stretch
   * it starts in; an inferred one past the declared end, to the stretch its run began in. A declared period that has no cycle
   * yet stands in for it, so a plan with cycles reads from its first cycle's start to its last one's end.
   */
  const groups: PlanGroup[] = (() => {
    const stretches = allSegments.filter((segment) => segment.label !== null);
    const within = (at: number) => stretches.find((segment) => segment.from <= at && at < segment.until);
    const owned = new Map<PlanSegment, BillingCycle[]>();
    const loose: BillingCycle[] = [];
    for (const cycle of withCycles ? [...cycles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) : []) {
      const segment = within(Date.parse(cycle.start)) ?? within(Date.parse(cycle.run.from));
      if (segment) owned.set(segment, [...owned.get(segment) ?? [], cycle]); else loose.push(cycle);
    }
    const result = stretches.map((segment): PlanGroup => {
      const own = owned.get(segment) ?? [];
      const last = own.at(-1);
      const pending = last ? segment.records.filter((row) => row.origin === "declared" && Date.parse(row.from) >= Date.parse(last.end)) : [];
      const stop = Math.max(...own.map((cycle) => Date.parse(cycle.end)), ...pending.map((row) => end(row.until)));
      return { key: `plan|${segment.from}`, segment, cycles: own, pending,
        from: last ? Date.parse(own[0]!.start) : segment.from,
        until: last ? (stop === Infinity ? null : stop) : planSelection(segment).until ? segment.until : null };
    });
    // A cycle outside every plan stretch still gets its row (inference needs a reading of the plan, so none in practice).
    result.push(...loose.map((cycle): PlanGroup => ({ key: `cycle|${cycle.start}`, segment: null, cycles: [cycle], pending: [],
      from: Date.parse(cycle.start), until: Date.parse(cycle.end) })));
    return result.filter((group) => (group.until ?? now) > from).sort((a, b) => b.from - a.from);
  })();
  // A cycle picked on the chart unfolds its plan.
  useEffect(() => {
    const owner = selected?.startsWith("cycle|") ? groups.find((group) => group.cycles.some((cycle) => `cycle|${cycle.start}` === selected)) : undefined;
    if (owner && folded.has(owner.key)) setFolded((current) => { const next = new Set(current); next.delete(owner.key); return next; });
  }, [selected]);
  /**
   * What a plan cost: the price of its latest full cycle with a payment (a voided or prorated last one says little about the
   * plan's price; without one, its latest cycle), and the sum of its cycles' payments (receipts and their repetitions, never
   * catalog prices) in USD at the NBP rate of each payment, as paid in the tooltip. Without cycles (a view without them) the
   * declared amounts of its records.
   */
  const groupPayments = (group: PlanGroup) => {
    const inside = group.cycles;
    const byCurrency = (rows: Array<{ amount: number; currency: string | null }>) => {
      const sums = new Map<string, number>();
      for (const row of rows) sums.set(row.currency ?? "", (sums.get(row.currency ?? "") ?? 0) + row.amount);
      return [...sums].map(([currency, amount]) => cycleMoney(Math.round(amount * 100) / 100, currency || null, locale)).join(" + ");
    };
    if (!inside.length) {
      const declared = (group.segment?.records ?? []).filter((row) => row.origin === "declared" && row.amountMinor != null)
        .map((row) => ({ amount: row.amountMinor! / 100, currency: row.currency ?? null }));
      return { perCycle: { text: "—", title: undefined }, total: { text: declared.length ? byCurrency(declared) : "—", title: undefined } };
    }
    const last = inside.findLast((cycle) => !cycle.shortened && (cycle.price.amount ?? 0) > 0
      && (cycle.price.source === "declared" || cycle.price.source === "repeated")) ?? inside.at(-1)!;
    const cyclesText = (count: number) => `${count} ${count === 1 ? t("cycle", "cykl")
      : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? t("cycles", "cykle") : t("cycles", "cykli")}`;
    const paid = inside.filter((cycle) => cycle.price.amount !== null && (cycle.price.source === "declared" || cycle.price.source === "repeated"));
    const usd = paid.map(cycleUsd), known = usd.every((value) => value !== null);
    const repeated = paid.filter((cycle) => cycle.price.source === "repeated").length;
    const asPaid = byCurrency(paid.map((cycle) => ({ amount: cycle.price.amount!, currency: cycle.price.currency })));
    const total = !paid.length ? { text: "—", title: undefined }
      : known ? { text: cycleMoney(Math.round(usd.reduce<number>((sum, value) => sum + (value ?? 0), 0) * 100) / 100, "USD", locale),
        title: [asPaid, cyclesText(paid.length), repeated ? `${t("repeated", "powtórzone")}: ${repeated}` : null,
          t("NBP rate of each payment", "kurs NBP każdej płatności")].filter(Boolean).join(" · ") }
      : { text: asPaid, title: t("NBP rate pending", "kurs NBP w drodze") };
    const lastUsd = cycleUsd(last);
    return { total, perCycle: { text: cyclePrice(last, t, locale),
      title: lastUsd !== null && last.price.currency !== "USD" ? `≈ ${cycleMoney(lastUsd, "USD", locale)}` : undefined } };
  };
  const stamp = (ms: number | null) => ms === null ? t("now", "teraz") : formatStamp(iso(ms));
  const ongoing = (cycle: BillingCycle) => `${cycle.current ? ` · ${t("ongoing", "trwa")}` : ""}${cycleMarks(cycle) ? ` ${cycleMarks(cycle)}` : ""}`;
  const recalculating = (cycle: BillingCycle) => cyclesStale && cyclesPendingFrom !== null && Date.parse(cycle.end) > Date.parse(cyclesPendingFrom);
  const rowClass = (...names: Array<string | false>) => names.filter(Boolean).join(" ") || undefined;
  /** A cycle's cells from Price on: price, USD, windows, use, API value against capacity and one window point. */
  const cycleCells = (cycle: BillingCycle) => {
    const figures = cycleFigures(cycle, t, locale);
    return <>
      <td className="mono" title={figures.priceTitle}>{figures.price}</td>
      <td className="mono" title={figures.priceTitle}>{figures.usd}</td>
      <td className="mono" title={figures.windowsTitle}>{figures.windows}</td>
      <td className="mono" title={figures.usedTitle}>{figures.used}</td>
      <td className="mono">{figures.api}</td>
      <td className="mono">{figures.point}</td>
    </>;
  };
  /** ✎ edits the cycle, "Confirm" accepts an inferred one; neither bubbles to the row. */
  const cycleActions = (cycle: BillingCycle) => {
    const act = (confirm?: boolean) => (event?: { stopPropagation(): void }) => { event?.stopPropagation(); setSelected(`cycle|${cycle.start}`); onCycle!(cycle, confirm); };
    return <td className="account-history-cycle-actions">
      <button type="button" className="account-history-edit" disabled={editing} title={t("Edit cycle", "Edytuj cykl")}
        aria-label={`${t("Edit", "Edytuj")}: ${t("cycle", "cykl")} ${formatStamp(cycle.start)} – ${formatStamp(cycle.end)}`} onClick={act()}>✎</button>
      {cycle.basis === "inferred" && <button type="button" disabled={editing} onClick={act(true)}>{t("Confirm", "Potwierdź")}</button>}
    </td>;
  };
  const subscriptionRows = groups.flatMap((group) => {
    const { segment } = group;
    const tier = segment && !segment.conflict ? segmentTier(segment) : null;
    // A plan of one cycle is that cycle: one row carries both.
    const single = group.cycles.length === 1 && !group.pending.length ? group.cycles[0]! : null;
    const nested = single ? [] : group.cycles;
    const open = !folded.has(group.key);
    const keys = [...new Set([group.key, ...single ? [`cycle|${single.start}`] : []])];
    const marked = selected ? keys.includes(selected) : !!single?.current;
    const { perCycle, total } = groupPayments(group);
    const name = !segment ? planName(group.cycles[0]!.plan, provider, group.cycles[0]!.start) : segment.conflict ? t("Conflicting readings", "Sprzeczne odczyty")
      : tier ? formatPlanLabel(tier.label, tier.multiplier) : planName(segment.label!, provider, iso(segment.from));
    const choose = segment ? () => { setSelected(group.key); onPlanPeriod(planSelection(segment)); } : () => { setSelected(group.key); onCycle?.(single!); };
    const fold = nested.length + group.pending.length === 0 ? <span className="account-history-fold" aria-hidden="true" /> : <button type="button" className="ui-disclosure account-history-fold" aria-expanded={open}
      aria-label={open ? t("Hide cycles", "Zwiń cykle") : t("Show cycles", "Pokaż cykle")}
      onClick={(event?: { stopPropagation(): void }) => { event?.stopPropagation(); setFolded((current) => { const next = new Set(current); if (open) next.add(group.key); else next.delete(group.key); return next; }); }}>{open ? "▾" : "▸"}</button>;
    const rows = [<TableRow key={group.key} ref={(node) => keys.forEach((key) => rowRef(key)(node))} {...hover(group.key)}
      className={rowClass("is-plan", marked && "is-selected", !!single && recalculating(single) && "is-pending")} {...single ? { "data-cycle-row": single.start } : {}}
      onClick={editing ? undefined : choose}>
      <td>{fold}<button type="button" disabled={editing}>{name}</button>{single ? ongoing(single) : ""}</td>
      <td className="mono"><span className={`account-history-tier${tierClass(tier)}`}>{tier?.multiplier != null ? `×${tier.multiplier}` : "—"}</span></td>
      <td className="mono">{stamp(group.from)}</td>
      <td className="mono">{stamp(group.until)}</td>
      <td className="mono">{days(group.from, group.until ?? now)}</td>
      {single ? cycleCells(single) : <>
        <td className="mono" title={perCycle.title}>{perCycle.text}</td>
        <td className="mono" title={total.title}>{total.text}</td>
        {withCycles && <><td /><td /><td /><td /></>}
      </>}
      <td>{!segment ? cycleBasis(single!, t) : segment.records.some((row) => row.origin === "declared") ? t("Your declaration", "Twój wpis") : t("From readings", "Z odczytów")}</td>
      {withCycles && (single ? cycleActions(single) : <td />)}
    </TableRow>];
    if (!open) return rows;
    for (const row of group.pending) rows.push(<TableRow key={`pending|${row.id}`} className="is-cycle"
      onClick={editing ? undefined : () => { setSelected(group.key); onPlanPeriod({ provider, account: row.account, aliases, from: row.from, until: row.until, records: [row] }); }}>
      <td>{t("cycle", "cykl")} · {Date.parse(row.from) > now ? t("upcoming", "nadchodzi") : t("being calculated", "w przeliczeniu")}</td>
      <td />
      <td className="mono">{stamp(Date.parse(row.from))}</td>
      <td className="mono">{row.until ? stamp(Date.parse(row.until)) : "—"}</td>
      <td className="mono">{row.until ? days(Date.parse(row.from), Date.parse(row.until)) : "—"}</td>
      <td className="mono">{row.amountMinor == null ? "—" : cycleMoney(row.amountMinor / 100, row.currency ?? null, locale)}</td>
      <td className="mono">—</td><td /><td /><td /><td />
      <td>{t("Your declaration", "Twój wpis")}</td>
      <td />
    </TableRow>);
    rows.push(...[...nested].reverse().map((cycle) => {
      const key = `cycle|${cycle.start}`;
      return <TableRow key={key} ref={rowRef(key)} {...hover(key)} data-cycle-row={cycle.start}
        className={rowClass("is-cycle", (selected ? selected === key : cycle.current) && "is-selected", recalculating(cycle) && "is-pending")}
        onClick={editing ? undefined : () => { setSelected(key); onCycle!(cycle); }}>
        <td>{t("cycle", "cykl")}{ongoing(cycle)}</td>
        <td />
        <td className="mono">{formatStamp(cycle.start)}</td>
        <td className="mono">{formatStamp(cycle.end)}</td>
        <td className="mono">{days(Date.parse(cycle.start), Date.parse(cycle.end))}</td>
        {cycleCells(cycle)}
        <td>{cycleBasis(cycle, t)}</td>
        {cycleActions(cycle)}
      </TableRow>;
    }));
    return rows;
  });
  // History tables mirror the periods chart; the limit windows chart carries its own table.
  const historyTabs: DetailTab[] = tab !== "periods" ? [] : [
    ...(groups.length > 0 ? [{ key: "subscription", label: t("Subscription", "Abonament"), badge: groups.length, render: () => <div data-billing-cycles>
      {withCycles && cyclesStale && <p className="account-periods-note ui-loading-status" role="status">
        <span className="ui-loading-spinner" aria-hidden="true" />
        {cyclesPendingFrom
          ? `${t("Recalculating cycles from", "Przeliczam cykle od")} ${dayMonth(cyclesPendingFrom)}…`
          : t("Cycles are updating in the background.", "Cykle aktualizują się w tle.")}
      </p>}
      <DataTable tableId="AccountHistoryTimeline:subscription" className="account-history-assignments account-history-cycles account-history-subscription" aria-label={t("Subscription", "Abonament")}>
        <thead><TableRow header><th data-column-id="c0">{t("Plan", "Plan")}</th><th data-column-id="c1">{t("Multiplier", "Mnożnik")}</th>
          <th data-column-id="c2">{t("From", "Od")}</th><th data-column-id="c3">{t("Until", "Do")}</th><th data-column-id="c4">{t("Days", "Dni")}</th>
          <th data-column-id="c5">{t("Price", "Cena")}<HelpDot label={t("Price", "Cena")}>{t(
            "A cycle: the receipt as written; “rep.” the last full-cycle payment repeated for a later cycle; “cat.” the catalog price where nothing was paid. A plan: the price of its latest full paid cycle.",
            "Cykl: kwota z dowodu płatności; „powt.” ostatnia płatność za pełny cykl powtórzona w kolejnym cyklu; „kat.” cena z cennika tam, gdzie nic nie zapłacono. Plan: cena jego ostatniego pełnego opłaconego cyklu.")}</HelpDot></th>
          <th data-column-id="c6">USD<HelpDot label="USD">{t(
            "A cycle: its price in USD at the NBP table A mid rate of the last business day before the payment. A plan: the sum of its paid cycles in USD.",
            "Cykl: jego cena w USD po średnim kursie NBP (tabela A) z ostatniego dnia roboczego przed płatnością. Plan: suma jego opłaconych cykli w USD.")}</HelpDot></th>
          {withCycles && <>
            <th data-column-id="c7">{t("Windows", "Okna")}</th><th data-column-id="c8">{t("Used", "Zużyto")}</th>
            <th data-column-id="c9">{t("API$ / capacity", "API$ / pojemność")}<HelpDot label={t("API$ / capacity", "API$ / pojemność")}>{t(
              "Capacity in API$ needs a stored calibration and is not shown yet.", "Pojemność w API$ wymaga zapisanej kalibracji i nie jest jeszcze pokazywana.")}</HelpDot></th>
            <th data-column-id="c10">{t("1 window point", "1 pkt okna")}</th>
          </>}
          <th data-column-id="c11">{t("Basis", "Podstawa")}</th>
          {withCycles && <th data-column-id="c12">{t("Action", "Akcja")}<HelpDot label={t("Action", "Akcja")}>{t(
            "To record a cancellation, add a “No subscription” period from its end — readings then no longer extend the plan.",
            "Rezygnację zapisz jako okres „Brak abonamentu” od dnia końca — wtedy odczyty nie przedłużą planu.")}</HelpDot></th>}
        </TableRow></thead>
        <tbody>{subscriptionRows}</tbody>
      </DataTable>
    </div> }] : []),
    ...(assignments.length > 0 ? [{ key: "computers", label: t("Computers", "Komputery"), badge: assignments.length, render: () => <DataTable tableId="AccountHistoryTimeline:1" className="account-history-assignments" aria-label={t("Assignments in this range", "Przypisania w tym zakresie")}>
            <thead><TableRow header><th data-column-id="c0">{t("Computer", "Komputer")}</th><th data-column-id="c1">{t("Profile", "Profil")}</th><th data-column-id="c2">{t("From", "Od")}</th><th data-column-id="c3">{t("Until", "Do")}</th><th data-column-id="c4">{t("Days", "Dni")}</th><th data-column-id="c5">{t("Basis", "Podstawa")}</th></TableRow></thead>
            {/* The whole row opens the editor; the button carries focus and Enter, and its click bubbles to the row. */}
            <tbody>{assignments.map(({ source, row }) => <TableRow key={row.key} ref={rowRef(row.key)} className={selected === row.key ? "is-selected" : undefined} {...hover(row.key)}
              onClick={editing ? undefined : () => { setSelected(row.key); onSourcePeriod(source, row); }}>
              <td><button type="button" disabled={editing}>{source.machine ?? source.key}</button></td>
              <td>{source.profile ?? "—"}</td>
              <td className="mono">{formatStamp(row.from)}</td>
              <td className="mono">{row.until ? formatStamp(row.until) : t("now", "teraz")}</td>
              <td className="mono">{days(Date.parse(row.from), row.until ? Date.parse(row.until) : now)}</td>
              <td>{basis(row)}</td>
            </TableRow>)}</tbody>
          </DataTable> }] : []),
  ];
  const keys = [...historyTabs, ...sections].map((item) => item.key);
  const active = detail && keys.includes(detail) ? detail : keys[0] ?? null;
  return <div className="account-history-timeline">
    <div className="account-history-timeline-tools">
      <div className="ui-tabs" role="tablist" aria-label={t("History view", "Widok historii")}>
        <button type="button" role="tab" className="ui-tab" aria-selected={tab === "periods"} onClick={() => setTab("periods")}>{t("Periods", "Okresy")}</button>
        <button type="button" role="tab" className="ui-tab" aria-selected={tab === "windows"} onClick={() => setTab("windows")}>{t("Limit windows", "Okna limitu")}</button>
      </div>
      <div className="ui-tabs" data-variant="switch" aria-label={t("Timeline range", "Zakres osi czasu")}>{RANGES.map((days) => <button type="button" key={days}
        className="mono ui-tab" disabled={editing} aria-pressed={zoom === days} onClick={() => setZoom(days)}>
        {days ? timeRangeLabel(days, t) : t("All history", "Cała historia")}</button>)}</div>
    </div>
    <ChartExport title={t("Account history", "Historia konta")}><div className="account-history-chart">
      <div className="account-history-axis"><span>{t("Period", "Okres")}</span><div>{[0, 1, 2, 3, 4].map((index) => <span key={index}>{shortDate(from + (until - from) * index / 4)}</span>)}</div></div>
      <div className="account-history-lane"><strong>{t("Account plan", "Plan konta")}</strong><div className="account-history-track">
        {segments.map((segment) => {
          const key = `plan|${segment.from}`;
          const draggable = segment.records.length > 0 && !editing;
          return <div key={key}
            className={`account-history-bar ${segment.label === null ? "is-unknown" : segment.conflict ? "is-conflict" : `is-plan${tierClass(segmentTier(segment))}`}${draggable ? " is-draggable" : ""}${marked(key)}`}
            style={position(key, segment.from, segment.until)} title={`${segment.label ? segment.records.map((row) => planName(row.plan, row.provider)).filter((value, index, all) => all.indexOf(value) === index).join(" / ") : t("Plan not established", "Plan nieustalony")} · ${shortDate(segment.from)} → ${shortDate(segment.until)}`}
            {...(draggable ? dragProps(key, segment.from, segment.until, (shift) => onPlanPeriod(planSelection(segment), shift), cycleAt) : {})}>
            <span>{segment.conflict ? t("Conflicting readings", "Sprzeczne odczyty") : segment.label ? planName(segment.label, provider) : ""}</span>
            {editButton(`${segment.label ? planName(segment.label, provider) : t("Plan not established", "Plan nieustalony")}, ${shortDate(segment.from)} – ${shortDate(segment.until)}`,
              () => onPlanPeriod(planSelection(segment)))}
          </div>;
        })}
        {/* Billing cycles: thin dividers with the price and use of each cycle, over the plan bars. */}
        {cycles.length > 0 && <CycleLaneMarks cycles={cycles} provider={provider} from={from} until={until} position={position} marked={marked}
          {...(onCycle && !editing ? { onSelect: setSelected } : {})} />}
        {/* Drawn over the plan bars: these days have no plan price, so the account's plan cost is unknown. */}
        {priceGaps.filter((gap) => Date.parse(gap.until) > from && Date.parse(gap.from) < until).map((gap) => {
          const key = `price|${gap.account}|${gap.from}`, start = Date.parse(gap.from), stop = Date.parse(gap.until);
          return <div key={key} className="account-history-bar is-unknown is-unpriced" style={position(key, start, stop)}
            title={`${t("No price (blocks the plan cost)", "Brak ceny (blokuje wycenę)")} · ${shortDate(start)} → ${shortDate(stop)}`}>
            <span>{t("no price", "brak ceny")}</span>
            {editButton(`${t("no plan price", "brak ceny planu")}, ${shortDate(start)} – ${shortDate(stop)}`,
              () => onPlanPeriod({ provider, account: gap.account, aliases, from: gap.from, until: gap.until, records: [] }))}
          </div>;
        })}
      </div></div>
      {tab === "windows" && <LimitWindowLanes windows={limitWindows.data?.windows ?? null} error={limitWindows.error}
        from={from} until={until} zoom={zoom} position={position} planAt={planAt} />}
      {tab === "periods" && timelines.map(({ source, rows }) => <div className="account-history-lane" key={source.key}>
        <span title={[source.machine ?? source.key, source.profile].filter(Boolean).join(" · ")}><strong>{source.machine ?? source.key}</strong>{source.profile && <small>{source.profile}</small>}</span>
        <div className="account-history-track">{rows.filter(visible).map((row) => {
          const stop = Math.min(end(row.until), until);
          // The outline carries the basis (solid: your declaration, dashed: readings); the label, the dates.
          return <div key={row.key} className={`account-history-bar is-source${row.period?.origin === "declared" ? " is-declared" : ""}${editing ? "" : " is-draggable"}${marked(row.key)}`}
            style={position(row.key, Date.parse(row.from), stop)} title={`${sourceTitle(row)} · ${basis(row)}`}
            {...dragProps(row.key, Date.parse(row.from), stop, (shift) => onSourcePeriod(source, row, shift))}>
            <span>{dayMonth(row.from)} → {row.until ? dayMonth(row.until) : t("now", "teraz")}</span>
            {editButton(`${source.machine ?? source.key} ${source.profile ?? ""}, ${sourceTitle(row)}`, () => onSourcePeriod(source, row))}
          </div>;
        })}</div>
      </div>)}
    </div></ChartExport>
    {tab === "periods" && (timelines.length > 0 || priceGaps.length > 0 || cycles.length > 0) && <div className="account-history-legend">
      <span><i className="is-declared" />{t("your declaration", "Twój wpis")}</span>
      <span><i className="is-observed" />{t("from readings", "z odczytów")}</span>
      <span><i className="is-empty" />{t("plan not established", "plan nieustalony")}</span>
      {priceGaps.length > 0 && <span><i className="is-unpriced" />{t("no price (blocks the plan cost)", "brak ceny (blokuje wycenę)")}</span>}
      {cycles.length > 0 && <span><i className="is-cycle" />{t("billing cycle", "cykl")}</span>}
      {cycles.some((cycle) => cycle.basis === "inferred") && <span>? {t("inferred from readings", "przyjęte z odczytów")}</span>}
      {cycles.some((cycle) => cycle.anchor_uncertain) && <span>≈ {t("payment date uncertain", "data płatności niepewna")}</span>}
    </div>}
    {keys.length > 0 && <DetailTabs panelRef={details} label={t("Details", "Szczegóły")} active={active} onChange={chooseDetail}
      groups={[{ label: t("History", "Historia"), tabs: historyTabs }, { label: t("Account settings", "Ustawienia konta"), tabs: sections }]} />}
  </div>;
}

const usageTone = (value: number) => value >= 90 ? "var(--crit)" : value >= 70 ? "var(--warn)" : "var(--ok)";

/**
 * The account's limit windows on the plan axis: one lane per counter length (5h only on the 30-day
 * range, where its bars are wide enough to read), one per sub-limit, and ↓ where a plan change
 * dropped the meter without moving the reset. The table lists the longest counter's windows.
 */
function LimitWindowLanes({ windows, error, from, until, zoom, position, planAt }: {
  windows: RailWindow[] | null; error: string | null; from: number; until: number; zoom: number;
  position: (key: string, start: number, stop: number) => CSSProperties;
  planAt: (at: number) => string | null;
}) {
  const { t } = useI18n();
  if (error) return <p className="account-periods-note">{t("Limit windows could not be read", "Nie udało się odczytać okien limitu")}: {error}</p>;
  if (!windows) return <p className="account-periods-note">{t("Loading limit windows…", "Wczytywanie okien limitu…")}</p>;
  const span = (window: RailWindow) => {
    const start = window.startIso ? Date.parse(window.startIso) : NaN, stop = window.resetIso ? Date.parse(window.resetIso) : NaN;
    return Number.isFinite(start) && Number.isFinite(stop) && stop > from && start < until ? { start, stop } : null;
  };
  const main = windows.filter((window) => window.scope == null && window.windowHours != null && span(window));
  const lengths = [...new Set(main.map((window) => window.windowHours!))].sort((a, b) => b - a).filter((hours) => hours >= 24 || (zoom > 0 && zoom <= 30));
  if (lengths.length === 0) return <p className="account-periods-note">{t("No limit windows in this range.", "Brak okien limitu w tym zakresie.")}</p>;
  const bar = (key: string, window: RailWindow, used: number | null, title: string) => {
    const { start, stop } = span(window)!;
    return <div key={key} className={`account-history-window${window.isCurrent ? " is-current" : ""}${used == null ? " is-empty" : ""}`}
      style={position(key, start, Math.min(stop, until))} title={title}>
      {used != null && <i style={{ height: `${Math.max(2, Math.min(100, used))}%`, background: `color-mix(in oklab, ${usageTone(used)} 45%, transparent)` }} />}
      {used != null && <span className="mono">{pct(used)}</span>}
    </div>;
  };
  const drops = (rows: RailWindow[]) => rows.filter((window) => window.counterSegment?.endDrop && window.resetIso).map((window) => {
    const at = Date.parse(window.resetIso!), drop = window.counterSegment!.endDrop!;
    if (at < from || at > until) return null;
    return <div key={`drop|${window.key}`} className="account-history-drop" style={{ left: `${100 * (at - from) / (until - from)}%` }}
      title={`${dayTime(window.resetIso)} · ${t("counter fell", "licznik spadł")} ${drop.before}% → ${drop.after}% ${t("without a reset (plan change)", "bez resetu (zmiana planu)")}`} />;
  });
  const describe = (window: RailWindow, used: number | null) =>
    `${dayTime(window.startIso)} → ${dayTime(window.resetIso)} · ${used == null ? t("no % reported", "konto nie podało %") : pct(used)}`;
  const table = main.filter((window) => window.windowHours === lengths[0]).sort((a, b) => Date.parse(b.startIso!) - Date.parse(a.startIso!));
  const sublimitLabels = [...new Set(table.flatMap((window) => window.sublimits.map((sub) => sub.label)))];
  const usedCell = (used: number | null) => used == null ? "—" : <strong style={{ color: usageTone(used) }}>{pct(used)}</strong>;
  return <>
    {lengths.map((hours) => {
      const rows = main.filter((window) => window.windowHours === hours);
      const labels = [...new Set(rows.flatMap((window) => window.sublimits.map((sub) => sub.label)))];
      return [
        <div className="account-history-lane" key={`lane|${hours}`}>
          <span><strong>{t("Window", "Okno")} {rows[0]!.label}</strong><small>{t("all models", "wszystkie modele")}</small></span>
          <div className="account-history-track">
            {rows.map((window) => bar(`window|${window.key}`, window, window.usedPercent, describe(window, window.usedPercent)))}
            {drops(rows)}
          </div>
        </div>,
        ...labels.map((label) => <div className="account-history-lane" key={`lane|${hours}|${label}`}>
          <span title={label}><strong>↳ {label}</strong><small>{t("sub-limit", "podlimit")} {rows[0]!.label}</small></span>
          <div className="account-history-track">
            {rows.map((window) => {
              const used = window.sublimits.find((candidate) => candidate.label === label)?.usedPercent ?? null;
              return bar(`window|${window.key}|${label}`, window, used, describe(window, used));
            })}
            {drops(rows)}
          </div>
        </div>),
      ];
    })}
    <div className="account-history-legend">
      <span><i style={{ background: "color-mix(in oklab, var(--ok) 45%, transparent)" }} />{t("below 70%", "poniżej 70%")}</span>
      <span><i style={{ background: "color-mix(in oklab, var(--warn) 45%, transparent)" }} />70–90%</span>
      <span><i style={{ background: "color-mix(in oklab, var(--crit) 45%, transparent)" }} />{t("90% and more", "90% i więcej")}</span>
      <span><i className="is-empty" />{t("no % reported", "konto nie podało %")}</span>
      <span className="is-drop">↓ {t("counter drop without a reset (plan change)", "spadek licznika bez zmiany resetu (zmiana planu)")}</span>
      {(zoom === 0 || zoom > 30) && <span>{t("5h windows: up to 30-day range", "okna 5h: zakres do 30 dni")}</span>}
    </div>
    <DataTable tableId="AccountHistoryTimeline:2" className="account-history-assignments account-history-windows" aria-label={t("Limit windows in this range", "Okna limitu w tym zakresie")}>
      <thead><TableRow header><th data-column-id="c0">{t("Window", "Okno")}</th><th data-column-id="c1">{t("From", "Od")}</th><th data-column-id="c2">{t("Until", "Do")}</th><th data-column-id="c3">{t("Plan", "Plan")}</th><th data-column-id="c4">{t("Used", "Zużycie")}</th>
        {sublimitLabels.map((label) => <th data-column-id={`counter:${label}`} key={label}>{label}</th>)}<th data-column-id="c6">{t("End", "Koniec")}</th></TableRow></thead>
      <tbody>{table.map((window) => {
        const drop = window.counterSegment?.endDrop;
        return <TableRow key={window.key} className={window.isCurrent ? "is-selected" : undefined}>
          <td className="mono">{window.label}{window.isCurrent ? ` · ${t("current", "trwa")}` : ""}</td>
          <td className="mono">{dayTime(window.startIso)}</td>
          <td className="mono">{dayTime(window.resetIso)}</td>
          <td>{planAt(Date.parse(window.startIso!)) ?? "—"}</td>
          <td className="mono">{usedCell(window.usedPercent)}</td>
          {sublimitLabels.map((label) => <td key={label} className="mono">{usedCell(window.sublimits.find((sub) => sub.label === label)?.usedPercent ?? null)}</td>)}
          <td>{drop ? <span className="account-history-drop-label">↓ {t("counter fell", "licznik spadł")} {drop.before}% → {drop.after}% · {t("plan change", "zmiana planu")}</span>
            : window.isCurrent ? t("runs until the reset", "trwa do resetu") : t("reset", "reset")}</td>
        </TableRow>;
      })}</tbody>
    </DataTable>
  </>;
}
