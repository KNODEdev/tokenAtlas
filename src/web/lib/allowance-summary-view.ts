import type { AllowanceCandidate, AllowanceRatio, AllowanceUnit } from "../../shared/allowance-summary";

/** Value → Summary (UR-014 REQ-061): the reader's choice, its defaults and the range it reads. */
export const ALLOWANCE_CHOICE_KEY = "tokenatlas.allowance-summary.v1";
export const ALLOWANCE_RANGES = [3, 6, 12] as const;
export type AllowanceRange = typeof ALLOWANCE_RANGES[number];
export interface AllowanceChoice { a: string | null; b: string | null; months: AllowanceRange; unit: AllowanceUnit }
export const DEFAULT_CHOICE: AllowanceChoice = { a: null, b: null, months: 3, unit: "api_standard" };

export function readAllowanceChoice(storage: Storage | null = browserStorage()): AllowanceChoice {
  try {
    const parsed = JSON.parse(storage?.getItem(ALLOWANCE_CHOICE_KEY) ?? "null") as Partial<AllowanceChoice> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_CHOICE;
    return { a: typeof parsed.a === "string" ? parsed.a : null, b: typeof parsed.b === "string" ? parsed.b : null,
      months: ALLOWANCE_RANGES.includes(parsed.months as AllowanceRange) ? parsed.months as AllowanceRange : 3,
      unit: parsed.unit === "tokens" ? "tokens" : "api_standard" };
  } catch { return DEFAULT_CHOICE; }
}
export function writeAllowanceChoice(choice: AllowanceChoice, storage: Storage | null = browserStorage()): void {
  try { storage?.setItem(ALLOWANCE_CHOICE_KEY, JSON.stringify(choice)); } catch { /* The choice still applies for this visit. */ }
}
function browserStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/**
 * Whom to compare when nothing usable is remembered: A is the active subscription with the highest known monthly price
 * (ties: more recent cycles, then account id); B another provider's active one at the same price. Unknown prices are
 * never a default but can be chosen by hand; a remembered side that is no longer listed falls back to the default.
 */
export function allowanceDefaults(candidates: readonly AllowanceCandidate[], remembered: Pick<AllowanceChoice, "a" | "b">): { a: string | null; b: string | null } {
  const listed = new Set(candidates.map(candidate => candidate.account));
  const active = candidates.filter(candidate => candidate.recent_cycles > 0 && candidate.usd_per_month !== null)
    .sort((x, y) => y.usd_per_month! - x.usd_per_month! || y.recent_cycles - x.recent_cycles || x.account.localeCompare(y.account));
  const top = active[0];
  const a = remembered.a && listed.has(remembered.a) ? remembered.a : top?.account ?? null;
  const first = candidates.find(candidate => candidate.account === a);
  const peer = first && active.find(candidate => candidate.provider !== first.provider && candidate.usd_per_month === first.usd_per_month);
  // An empty remembered B ("none") is a choice too; only a vanished account falls back.
  const b = remembered.b !== null && remembered.b !== undefined
    ? remembered.b === "" || listed.has(remembered.b) && remembered.b !== a ? remembered.b : peer?.account ?? null
    : peer?.account ?? null;
  return { a, b: b === "" ? null : b };
}

/** The last `months` calendar months up to today, UTC: 3 in late October is August 1 – today. */
export function allowanceRange(months: AllowanceRange, now = Date.now()): { since: string; until: string } {
  const today = new Date(now);
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1));
  return { since: since.toISOString().slice(0, 10), until: today.toISOString().slice(0, 10) };
}

/** "≤ 2.24×", "≈ 2.24×" or "2.24×": a ratio with its marking (owner decision 2026-10-31). */
export function ratioText(ratio: Pick<AllowanceRatio, "ratio" | "relation" | "approximate">, locale: string): string {
  if (ratio.ratio === null) return "";
  const value = ratio.ratio.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${ratio.approximate ? "≈ " : ratio.relation ? `${ratio.relation} ` : ""}${value}×`;
}
/** A ratio is called out when the plans differ by more than 30% either way, unless it is only approximate. */
export const ratioTone = (ratio: Pick<AllowanceRatio, "ratio" | "approximate">) =>
  ratio.ratio === null || ratio.approximate ? "var(--muted)" : ratio.ratio > 1.3 || ratio.ratio < 1 / 1.3 ? "var(--crit)" : "var(--accent)";

/** "October", "Oct 2026" when the range spans years, in the reader's language. */
export function monthLabel(month: string, locale: string, withYear = false): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: withYear ? "short" : "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
}

/** "1 cycle", "3 cykle", "5 cykli": Polish counts take three forms. */
export function cyclesText(n: number, t: (en: string, pl: string, values?: Array<string | number>) => string): string {
  const tens = n % 100, ones = n % 10;
  const pl = n === 1 ? "cykl" : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? "cykle" : "cykli";
  return t(n === 1 ? "{0} cycle" : "{0} cycles", `${n} ${pl}`, [n]);
}
