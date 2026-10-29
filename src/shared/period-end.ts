interface PeriodBounds {
  from: string;
  until: string | null;
  origin: "observed" | "declared" | "inferred";
}

const PLAN_ALIASES: Record<string, string> = {
  default_claude_ai: "pro", default_claude_max_5x: "max-5x", default_claude_max_20x: "max-20x",
};
export const canonicalPeriodPlan = (value: string): string => PLAN_ALIASES[value] ?? value;
/** Free is an intrinsic offer with its own counters; it is distinct from no subscription. */
export const isFreePlan = (value: string | null | undefined): boolean =>
  typeof value === "string" && ["free", "codex-free"].includes(canonicalPeriodPlan(value.trim()).toLowerCase());

/**
 * Reserved plan-period value for a stretch the owner declares without any paid plan (e.g. after a
 * refund). Built in for every provider, never a catalog plan: priced at exactly $0/month and carrying
 * no limits, so capacity treats it as "no limits known". Only declarations write it, never readings.
 */
export const NO_PLAN = "none";
/** Exactly the reserved value; spellings like "None" are not it (the declarations reader refuses them). */
export const isNoPlan = (value: string | null | undefined): boolean => value === NO_PLAN;
/** Any spelling of the reserved value, to point a hand-edited file at the exact one. */
export const looksLikeNoPlan = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === NO_PLAN;

/**
 * One plan at a time (owner rule 29.10): a new plan ends the previous one. An open declared row therefore ends where a
 * row of another value starts after it, so a statement without an end cannot hide a later reading of a new plan.
 */
export function endOpenDeclarations<T extends PeriodBounds>(rows: readonly T[], subject: (row: T) => string, value: (row: T) => string): T[] {
  return rows.map(row => {
    if (row.origin !== "declared" || row.until !== null) return row;
    const from = Date.parse(row.from);
    let until = Infinity;
    for (const other of rows) {
      if (other === row || other.origin === "inferred" || subject(other) !== subject(row) || value(other) === value(row)) continue;
      const start = Date.parse(other.from);
      if (start > from && start < until) until = start;
    }
    return until === Infinity ? row : { ...row, until: new Date(until).toISOString() };
  });
}

/** A declared end closes the overlapping observed run of the same value, without erasing evidence. */
export function respectDeclaredEnds<T extends PeriodBounds>(rows: readonly T[], subject: (row: T) => string, value: (row: T) => string): T[] {
  return rows.map(row => {
    if (row.origin === "declared") return row;
    let until = row.until;
    for (const declared of rows) {
      if (declared.origin !== "declared" || declared.until === null
        || subject(declared) !== subject(row) || value(declared) !== value(row)) continue;
      if (Date.parse(row.from) >= Date.parse(declared.until)
        || Date.parse(declared.from) >= (row.until === null ? Infinity : Date.parse(row.until))) continue;
      if (until === null || Date.parse(declared.until) < Date.parse(until)) until = declared.until;
    }
    return until === row.until ? row : { ...row, until };
  });
}
