import type { BillingCycle, BillingCycleResetBonus, BillingCyclesAccount } from "../../src/shared/billing-cycles";
import { resolvePlanFacts, type PlansCatalog } from "../../src/shared/plan-catalog";

/**
 * Monthly (billing-cycle) capacity with resets by kind, and the change points of the weekly capacity per plan. Billing figures are the
 * application's stored ones (`billing_cycles`, window end causes, point values), read and renamed, never recomputed; the only new arithmetic
 * is presentation: splitting the stored total by cause, and the median/min/max of the stored per-window values. Missing stays null with a reason.
 */
const round = (value: number, digits = 2) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const day = (iso: string) => iso.slice(0, 10);

const bonus = (b: BillingCycleResetBonus | undefined) => ({ count: b?.count ?? 0, carried: b?.carried ?? 0, windows: round(b?.windows ?? 0, 3), apiUsd: finite(b?.api_usd) ? round(b!.api_usd!, 2) : null });
const sum = (items: Array<{ windows: number }>) => round(items.reduce((total, item) => total + item.windows, 0), 3);

export type EarlyResetKind = "automatic" | "banked" | "other";
const kindOf = (cause: string | null): EarlyResetKind | null =>
  cause === "provider" || cause === "provider_probable" ? "automatic" : cause === "banked" ? "banked" : cause === "single" || cause === "unknown" ? "other" : null;

/** Why a cycle has no capacity figure, from the application's own flags. */
const missingReason = (cycle: BillingCycle) => cycle.flags.includes("no_windows") ? "no_windows" : cycle.flags.includes("capacity_uncalibrated") ? "uncalibrated" : "no_capacity";

export function publicBillingCycle(cycle: BillingCycle, catalog: PlansCatalog, provider: string, promo: boolean) {
  const resets = cycle.resets ?? {};
  const automatic = [bonus(resets.provider), bonus(resets.provider_probable)];
  const banked = bonus(resets.banked), other = [bonus(resets.single), bonus(resets.unknown)];
  const total = round(cycle.windows.share + cycle.windows.idle, 3);
  const automaticWindows = sum(automatic), bankedWindows = banked.windows, otherWindows = sum(other);
  const capacity = cycle.capacity_usd;
  const money = (list: Array<{ apiUsd: number | null }>) => round(list.reduce((t, item) => t + (item.apiUsd ?? 0), 0), 0);
  const split = capacity === null ? null : (() => {
    const auto = money(automatic), bank = banked.apiUsd ?? 0, oth = money(other);
    return { total: round(capacity, 0), base: round(capacity - auto - bank - oth, 0), automatic: auto, banked: bank, other: oth };
  })();
  // Whole windows of the cycle with their stored share of its capacity: the spread of what one window was worth in this month.
  const whole = (cycle.main_windows ?? []).filter(window => window.share >= 0.9 && finite(window.capacity_share));
  const values = capacity === null ? [] : whole.map(window => capacity * window.capacity_share! / window.share);
  const used = cycle.used_pp;
  const early: Record<EarlyResetKind, { n: number; usedPct: number[] }> = { automatic: { n: 0, usedPct: [] }, banked: { n: 0, usedPct: [] }, other: { n: 0, usedPct: [] } };
  for (const window of cycle.main_windows ?? []) {
    const kind = kindOf(window.cause);
    if (!kind) continue;
    early[kind].n++;
    // The meter's rise in the window that the reset ended: derived from stored readings, not announced by the provider.
    if (finite(window.used_pp)) early[kind].usedPct.push(round(window.used_pp, 0));
  }
  const percent = (windows: number) => used !== null && windows > 0 ? round(used / windows, 1) : null;
  return {
    start: cycle.start, end: cycle.end, plan: resolvePlanFacts(catalog, provider, cycle.plan, day(cycle.start)).display_label,
    priceUsd: cycle.price.usd ?? null, current: cycle.current, partial: cycle.shortened, promo,
    windows: { total, scheduled: round(total - automaticWindows - bankedWindows - otherWindows, 3), idle: round(cycle.windows.idle, 3),
      automatic: { count: automatic.reduce((t, item) => t + item.count, 0), windows: automaticWindows }, banked: { count: banked.count, windows: bankedWindows },
      other: { count: other.reduce((t, item) => t + item.count, 0), windows: otherWindows } },
    capacityUsd: split, capacityReason: split ? null : missingReason(cycle),
    perWindowUsd: values.length ? { min: round(Math.min(...values), 0), median: round(median(values), 0), max: round(Math.max(...values), 0), n: values.length } : null,
    usedApiUsd: finite(cycle.api_usd) ? round(cycle.api_usd, 0) : null, usedPct: cycle.used_pct,
    usedPctWithoutBanked: percent(total - bankedWindows), usedPctWithoutAutomatic: percent(total - automaticWindows),
    usedPctWithoutEarly: percent(total - bankedWindows - automaticWindows - otherWindows),
    // Used % of the old window at the moment of an early reset (what the reset discarded is the rest); derived from stored readings.
    earlyResets: { automatic: early.automatic, banked: early.banked, other: early.other },
    // Current cycle: the share of the minimal projected capacity used so far (a ceiling of use), and how much of the cycle's time has passed.
    projectionUsedPct: cycle.projection?.used_pct ?? null,
    flags: cycle.flags,
  };
}
export type BillingCycleRecord = ReturnType<typeof publicBillingCycle>;

export interface BillingInput { accounts: BillingCyclesAccount[]; detail: Map<string, BillingCycle[]> }
/** Subscriptions are labelled with the same letters as the weekly capacity history; an account it lacks continues the alphabet. */
export function publicBilling(input: BillingInput, labelOf: (provider: string, account: string) => string | null, catalog: PlansCatalog, promoOn: (label: string | null, start: string, end: string) => boolean) {
  const used = new Map<string, Set<string>>();
  const out: Array<{ id: string; provider: string; label: string; cycles: BillingCycleRecord[] }> = [];
  for (const account of input.accounts) {
    const detail = new Map((input.detail.get(`${account.provider}|${account.account}`) ?? []).map(cycle => [cycle.start, cycle]));
    const cycles = account.cycles.filter(cycle => cycle.windows.touched > 0 || cycle.capacity_usd !== null);
    if (!cycles.length) continue;
    let label = labelOf(account.provider, account.account);
    const taken = used.get(account.provider) ?? new Set<string>();
    if (!label) { let n = 0; do { label = `${String.fromCharCode(65 + n % 26)}${n >= 26 ? "2" : ""}`; n++; } while (taken.has(label)); label = `${label}*`; }
    taken.add(label); used.set(account.provider, taken);
    out.push({ id: `${account.provider}-${label}`, provider: account.provider, label,
      cycles: cycles.map(cycle => publicBillingCycle(detail.get(cycle.start) ?? cycle, catalog, account.provider, promoOn(labelOf(account.provider, account.account), cycle.start, cycle.end))) });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

/** What early resets of each kind discarded: the old window's used % at the reset, over every cycle. Null when no reading was stored. */
export function resetUse(subscriptions: ReturnType<typeof publicBilling>) {
  const kinds = ["automatic", "banked", "other"] as const;
  return Object.fromEntries(kinds.map(kind => {
    const values = subscriptions.flatMap(item => item.cycles.flatMap(cycle => cycle.earlyResets[kind].usedPct));
    const count = subscriptions.reduce((t, item) => t + item.cycles.reduce((c, cycle) => c + cycle.earlyResets[kind].n, 0), 0);
    return [kind, { resets: count, withReading: values.length, medianUsedPct: values.length ? round(median(values), 0) : null,
      minUsedPct: values.length ? Math.min(...values) : null, maxUsedPct: values.length ? Math.max(...values) : null,
      reason: values.length ? null : "no_stored_readings" }];
  })) as Record<EarlyResetKind, { resets: number; withReading: number; medianUsedPct: number | null; minUsedPct: number | null; maxUsedPct: number | null; reason: string | null }>;
}

/* ---------------------------------------------------------------------------------------------------------- */
/* Change points of the weekly capacity                                                                         */
/* ---------------------------------------------------------------------------------------------------------- */

export interface WeeklyCycle { start: string; end: string; plan: string | null; observedPp: number | null; capacityUsd: number | null; lowerBound: boolean; promotionFactor: number | null }
export interface WeeklySubscription { provider: string; label: string; cycles: WeeklyCycle[] }
export const SHIFT_MIN = 0.15, SIDE_MIN = 2, SIDE_MAX = 4, MIN_PP = 10;
const level = (values: number[]) => ({ median: round(median(values), 0), min: round(Math.min(...values), 0), max: round(Math.max(...values), 0), n: values.length });

interface Point { end: number; endIso: string; value: number; lowerBound: boolean; label: string }

/**
 * A level shift: the median of the nearest up-to-4 cycles after a point differs from that before it by at least 15%, at least two cycles on
 * each side, and the two cycles nearest the point on each side already lie on their own side of the midpoint, so the step holds. Cycles of one
 * plan only (a plan change is its own event), promotion cycles and duplicates are already out of the input.
 */
export function levelShifts(points: Point[]) {
  const sorted = [...points].sort((a, b) => a.end - b.end);
  const found: Array<{ index: number; before: Point[]; after: Point[]; change: number }> = [];
  for (let i = SIDE_MIN; i <= sorted.length - SIDE_MIN; i++) {
    const before = sorted.slice(Math.max(0, i - SIDE_MAX), i), after = sorted.slice(i, i + SIDE_MAX);
    const mb = median(before.map(p => p.value)), ma = median(after.map(p => p.value)), change = ma / mb - 1;
    if (Math.abs(change) < SHIFT_MIN) continue;
    const mid = (mb + ma) / 2, up = change > 0;
    const onSide = (p: Point, side: "before" | "after") => (side === "after") === up ? p.value > mid : p.value < mid;
    if (!before.slice(-SIDE_MIN).every(p => onSide(p, "before")) || !after.slice(0, SIDE_MIN).every(p => onSide(p, "after"))) continue;
    found.push({ index: i, before, after, change });
  }
  // One event per step: of candidates within a few cycles of each other keep the largest.
  const kept: typeof found = [];
  for (const candidate of found) {
    const last = kept.at(-1);
    if (last && candidate.index - last.index <= SIDE_MAX) { if (Math.abs(candidate.change) > Math.abs(last.change)) kept[kept.length - 1] = candidate; } else kept.push(candidate);
  }
  return { sorted, events: kept };
}

export type ChangeKind = "level_shift" | "promotion_start" | "promotion_end" | "plan_change";
export interface ChangeEvent {
  kind: ChangeKind; date: string; provider: string; plan: string; toPlan?: string;
  before: ReturnType<typeof level> | null; after: ReturnType<typeof level> | null; changePct: number | null;
  subscriptions: number; lowerBound: boolean; note?: string;
}
const DAY = 86_400_000;

export function changeEvents(subscriptions: WeeklySubscription[]): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  const providers = [...new Set(subscriptions.map(item => item.provider))];
  for (const provider of providers) {
    const own = subscriptions.filter(item => item.provider === provider);
    const usable = (item: WeeklySubscription, promo: boolean) => item.cycles.filter(c => c.capacityUsd !== null && c.plan !== null && (c.observedPp ?? 0) >= MIN_PP && (promo ? c.promotionFactor !== null : c.promotionFactor === null));
    const point = (c: WeeklyCycle, label: string): Point => ({ end: Date.parse(c.end), endIso: c.end, value: c.capacityUsd!, lowerBound: c.lowerBound, label });
    for (const plan of [...new Set(own.flatMap(item => item.cycles.map(c => c.plan)).filter((p): p is string => p !== null))]) {
      const promoPoints = own.flatMap(item => usable(item, true).filter(c => c.plan === plan).map(c => point(c, item.label)));
      const plain = own.flatMap(item => usable(item, false).filter(c => c.plan === plan).map(c => point(c, item.label)));
      // Promotion edges are their own events: the first and last cycle that carried a promotion factor.
      const firstPromo = promoPoints.sort((a, b) => a.end - b.end)[0], lastPromo = promoPoints.at(-1);
      const promoStart = firstPromo ? Date.parse(own.flatMap(item => item.cycles).filter(c => c.plan === plan && c.promotionFactor !== null).map(c => c.start).sort()[0]!) : null;
      if (promoPoints.length) {
        const after = plain.filter(p => p.end > lastPromo!.end).slice(0, SIDE_MAX), before = plain.filter(p => p.end < promoStart!).slice(-SIDE_MAX);
        const promoLevel = level(promoPoints.map(p => p.value));
        events.push({ kind: "promotion_end", date: day(lastPromo!.endIso), provider, plan, before: promoLevel, after: after.length ? level(after.map(p => p.value)) : null,
          changePct: after.length ? round(median(after.map(p => p.value)) / promoLevel.median - 1, 3) : null, subscriptions: new Set(promoPoints.map(p => p.label)).size,
          lowerBound: promoPoints.some(p => p.lowerBound) || after.some(p => p.lowerBound), note: "the capacity measured under a declared promotion carries its bonus" });
        void before;
      }
      const { sorted, events: shifts } = levelShifts(plain);
      for (const shift of shifts) {
        const boundary = sorted[shift.index]!.end;
        // A step that coincides with a promotion edge belongs to that promotion event, not to a provider change.
        if (promoPoints.length && [promoStart!, lastPromo!.end].some(edge => Math.abs(edge - boundary) <= 10 * DAY)) continue;
        const date = day(new Date(Date.parse(sorted[shift.index - 1]!.endIso) + (boundary - Date.parse(sorted[shift.index - 1]!.endIso)) / 2).toISOString());
        // How many subscriptions show the same step: their own medians around the date move the same way by at least 15%.
        const shows = own.filter(item => {
          const cycles = usable(item, false).filter(c => c.plan === plan).map(c => point(c, item.label)).sort((a, b) => a.end - b.end);
          const b = cycles.filter(p => p.end <= boundary).slice(-SIDE_MAX), a = cycles.filter(p => p.end > boundary).slice(0, SIDE_MAX);
          return b.length >= 1 && a.length >= 1 && (b.length + a.length) >= 3 && Math.sign(median(a.map(p => p.value)) / median(b.map(p => p.value)) - 1) === Math.sign(shift.change)
            && Math.abs(median(a.map(p => p.value)) / median(b.map(p => p.value)) - 1) >= SHIFT_MIN;
        }).length;
        events.push({ kind: "level_shift", date, provider, plan, before: level(shift.before.map(p => p.value)), after: level(shift.after.map(p => p.value)),
          changePct: round(shift.change, 3), subscriptions: shows, lowerBound: [...shift.before, ...shift.after].some(p => p.lowerBound) });
      }
    }
    // A plan change of one subscription: where its next cycle has another plan.
    for (const item of own) {
      const cycles = item.cycles.filter(c => c.capacityUsd !== null && c.plan !== null).sort((a, b) => a.start.localeCompare(b.start));
      cycles.forEach((cycle, index) => {
        const next = cycles[index + 1];
        // Free-tier flips are not provider changes; only moves between paid plans are listed.
        if (next && next.plan !== cycle.plan && cycle.plan !== "Free" && next.plan !== "Free" && Date.parse(next.start) - Date.parse(cycle.end) < 21 * DAY)
          events.push({ kind: "plan_change", date: day(next.start), provider, plan: cycle.plan!, toPlan: next.plan!, before: null, after: null, changePct: null, subscriptions: 1, lowerBound: false });
      });
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
