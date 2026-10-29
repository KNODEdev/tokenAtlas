import { normEraKey, normEraVendor } from "./eras";
import { canonicalPeriodPlan, endOpenDeclarations, respectDeclaredEnds } from "../shared/period-end";

/**
 * Dated periods: "for subject S, from instant A until instant B, the value was V". One
 * mechanism serves both questions of docs/account-periods-model-2026-09-21.md:
 *
 *   account periods — subject: a source, value: the account logged in there;
 *   plan periods    — subject: an account, value: the plan it had.
 *
 * A source is the archive folder of one profile on one computer (`claude/EXAMPLE-MAIN`), the
 * only source identity an event knows. An event carries neither account nor plan as a stamp;
 * both resolve through these rows at read time.
 */
export type PeriodOrigin = "observed" | "declared";

export interface PeriodReading {
  provider: string;
  subject: string;
  /** ISO instant of the reading. */
  ts: string;
  value: string;
}

export interface DatedPeriod {
  provider: string;
  subject: string;
  /** Inclusive. An ISO instant, or a YYYY-MM-DD day meaning its UTC midnight. */
  from: string;
  /** Exclusive, same forms as `from`; null while the period continues. */
  until: string | null;
  value: string;
  origin: PeriodOrigin;
  firstSeen: string | null;
  lastSeen: string | null;
  readings: number;
  /** What the row rests on: a reading kind, a payment, the owner's statement. */
  evidence: string;
  /** Plan periods only: what the receipt says, in the currency's minor unit. */
  amountMinor?: number | null;
  currency?: string | null;
  /** Declared plan periods only: the renewal instant its billing cycles count from (default `from`). */
  anchor?: string | null;
  /** Declared plan periods only: 1 (monthly, default) or 12 (annual). */
  cycleMonths?: number | null;
}

/**
 * A period an index can hold: a stored one, or (plan prices only) a billing cycle inferred from readings after a declared
 * end (docs/billing-cycles-design-2026-10-08.md §3), which exists in memory only and ranks below observed rows.
 */
export type IndexedPeriod = Omit<DatedPeriod, "origin"> & { origin: PeriodOrigin | "inferred" };

export type PeriodResolution<P extends IndexedPeriod = DatedPeriod> =
  | { value: string; basis: "direct" | P["origin"]; period: P | null }
  /** `gap`: between two known periods of the subject; `uncovered`: before the first or after the last. */
  | { value: null; basis: "gap" | "uncovered"; period: null };

export const periodSubjectKey = (provider: string, subject: string) => `${normEraVendor(provider)}|${normEraKey(subject)}`;

export function periodInstant(value: string, field: string): number {
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(time)) throw new Error(`period: invalid ${field} '${value}'`);
  return time;
}

/** `until` is exclusive, so a period that still owns its last reading ends one millisecond after it. */
export const closedAfter = (lastSeen: string): string => new Date(periodInstant(lastSeen, "last reading") + 1).toISOString();

/**
 * One row per unbroken run of the same value. Readings of one value on both sides of a silence
 * (the application was off) stay one period. A different value closes the running period just
 * after its last reading and opens the next at its own first reading: the time between them
 * belongs to neither, and resolves as a gap.
 */
export function observedPeriods(readings: readonly PeriodReading[], evidence = "profile-reading"): DatedPeriod[] {
  const ordered = [...readings]
    .filter((reading) => reading.value && reading.subject)
    .sort((a, b) => periodSubjectKey(a.provider, a.subject).localeCompare(periodSubjectKey(b.provider, b.subject))
      || periodInstant(a.ts, "reading time") - periodInstant(b.ts, "reading time"));
  const periods: DatedPeriod[] = [];
  let open: DatedPeriod | null = null;
  for (const reading of ordered) {
    const same: boolean = !!open && periodSubjectKey(open.provider, open.subject) === periodSubjectKey(reading.provider, reading.subject);
    if (open && same && open.value === reading.value) {
      // One probe cycle writes several rows with one timestamp; they are one reading.
      if (open.lastSeen === reading.ts) continue;
      open.lastSeen = reading.ts;
      open.readings++;
      continue;
    }
    if (open && same) open.until = closedAfter(open.lastSeen!);
    open = {
      provider: normEraVendor(reading.provider), subject: reading.subject, from: reading.ts, until: null,
      value: reading.value, origin: "observed", firstSeen: reading.ts, lastSeen: reading.ts, readings: 1, evidence,
    };
    periods.push(open);
  }
  return periods;
}

export function validatePeriods(periods: readonly IndexedPeriod[]): string[] {
  const errors: string[] = [];
  const label = (p: IndexedPeriod) => `${p.provider}/${p.subject} ${p.value} [${p.from}, ${p.until ?? "…"})`;
  for (const period of periods) {
    try {
      const from = periodInstant(period.from, "from");
      if (period.until !== null && periodInstant(period.until, "until") <= from) errors.push(`${label(period)}: koniec nie jest późniejszy niż początek`);
    } catch (error) {
      errors.push(`${label(period)}: ${(error as Error).message}`);
    }
  }
  if (errors.length) return errors;
  // Two rows of one origin cannot both own an instant; a declared row over an observed one is the supported correction.
  for (let i = 0; i < periods.length; i++) for (let j = i + 1; j < periods.length; j++) {
    const a = periods[i]!, b = periods[j]!;
    if (a.origin !== b.origin || periodSubjectKey(a.provider, a.subject) !== periodSubjectKey(b.provider, b.subject)) continue;
    const aUntil = a.until === null ? Infinity : periodInstant(a.until, "until"), bUntil = b.until === null ? Infinity : periodInstant(b.until, "until");
    if (periodInstant(a.from, "from") < bUntil && periodInstant(b.from, "from") < aUntil) errors.push(`nakładające się okresy: ${label(a)} oraz ${label(b)}`);
  }
  return errors;
}

export interface PeriodIndex<P extends IndexedPeriod = DatedPeriod> {
  /**
   * Precedence accepted by the owner on 2026-09-21: a value recorded in the event itself (the
   * session's identity, the event's plan), then a declared period, then an observed one, then (plan prices only)
   * a cycle inferred from readings. Nothing else assigns a value.
   */
  resolve(provider: string, subject: string, ts: string, direct?: string | null): PeriodResolution<P>;
  periodsOf(provider: string, subject: string): P[];
}

export function buildPeriodIndex<P extends IndexedPeriod = DatedPeriod>(periods: readonly P[]): PeriodIndex<P> {
  const errors = validatePeriods(periods);
  if (errors.length) throw new Error(errors.join("\n"));
  interface Entry { period: P; from: number; until: number }
  const bySubject = new Map<string, Entry[]>();
  for (const period of effectiveDatedPeriods(periods)) {
    const key = periodSubjectKey(period.provider, period.subject), list = bySubject.get(key) ?? [];
    list.push({ period, from: periodInstant(period.from, "from"), until: period.until === null ? Infinity : periodInstant(period.until, "until") });
    bySubject.set(key, list);
  }
  for (const list of bySubject.values()) list.sort((a, b) => a.from - b.from);
  return {
    resolve(provider, subject, ts, direct) {
      if (direct) return { value: direct, basis: "direct", period: null };
      const entries = bySubject.get(periodSubjectKey(provider, subject)) ?? [], at = periodInstant(ts, "event time");
      for (const origin of ["declared", "observed", "inferred"] as const) {
        const found = entries.find((entry) => entry.period.origin === origin && entry.from <= at && at < entry.until);
        if (found) return { value: found.period.value, basis: origin as P["origin"], period: found.period };
      }
      const before = entries.some((entry) => entry.until <= at), after = entries.some((entry) => entry.from > at);
      return { value: null, basis: before && after ? "gap" : "uncovered", period: null };
    },
    periodsOf: (provider, subject) => (bySubject.get(periodSubjectKey(provider, subject)) ?? []).map((entry) => entry.period),
  };
}

export function effectiveDatedPeriods<P extends IndexedPeriod = DatedPeriod>(periods: readonly P[]): P[] {
  return respectDeclaredEnds(periods, p => periodSubjectKey(p.provider, p.subject), p => p.value.toLowerCase());
}

/**
 * Plan periods as every plan reader takes them: an open declared plan ends where another plan starts after it
 * (endOpenDeclarations), then declared ends close observed runs. Plan names are compared in catalog form, so a reading of
 * "default_claude_ai" does not end a declared "pro". Account periods keep effectiveDatedPeriods: there a declaration is
 * the correction of a reading.
 */
export function effectivePlanPeriods<P extends IndexedPeriod = DatedPeriod>(periods: readonly P[]): P[] {
  const plan = (p: P) => canonicalPeriodPlan(p.value).toLowerCase();
  return respectDeclaredEnds(endOpenDeclarations(periods, p => periodSubjectKey(p.provider, p.subject), plan),
    p => periodSubjectKey(p.provider, p.subject), plan);
}

/**
 * Whether an account has a plan at `at`. Null when the account has no plan history, so the caller keeps
 * its older signal; a history whose last plan has ended means the subscription is no longer active.
 * Plan names are compared in catalog form, so a declared "pro" ends an observed "default_claude_ai" run.
 */
export function planActivityAt(periods: readonly DatedPeriod[], at: string): (provider: string, subject: string) => boolean | null {
  const index = buildPeriodIndex(effectivePlanPeriods(periods).map((period) => ({ ...period, value: canonicalPeriodPlan(period.value) })));
  return (provider, subject) => index.periodsOf(provider, subject).length ? index.resolve(provider, subject, at).value !== null : null;
}

/**
 * Plan periods are the plan history of an account (docs/account-periods-model-2026-09-21.md):
 * readings feed them, the owner's declarations override them, and every report reads the plan
 * at an instant from here, never from a label stamped on a reading or an event. Plan names are
 * compared in catalog form. A damaged table yields no index, so a report sees no plan at all.
 */
export function planPeriodIndex<P extends IndexedPeriod = DatedPeriod>(periods: readonly P[] | undefined): PeriodIndex<P> | null {
  if (!periods?.length) return null;
  try {
    return buildPeriodIndex(effectivePlanPeriods(periods).map((period) => ({ ...period, value: canonicalPeriodPlan(period.value) })));
  } catch (error) {
    console.warn("[plan periods] unusable:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The part of the plan periods a prepared report depends on: effective rows only, optionally of
 * one account. A reading extending an open period (last_seen, readings) changes nothing here.
 */
export function planPeriodsShape(periods: readonly DatedPeriod[], provider?: string, subject?: string): unknown[] {
  const key = provider && subject ? periodSubjectKey(provider, subject) : null;
  return effectivePlanPeriods(periods).filter((p) => key === null || periodSubjectKey(p.provider, p.subject) === key)
    .map((p) => [p.provider, p.subject, p.origin, p.from, p.until, canonicalPeriodPlan(p.value)]);
}
