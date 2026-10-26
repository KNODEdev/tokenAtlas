import type { TokenTypeBreakdown } from "./project-cost-contracts";
import { round2 } from "./pricing";

const DAYS_PER_MONTH = 30.44;

export function zeroTypes(): TokenTypeBreakdown {
  return { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 };
}

export function addTypes(target: TokenTypeBreakdown, src: TokenTypeBreakdown): void {
  target.in_uncached += src.in_uncached;
  target.cache_read += src.cache_read;
  target.cache_write += src.cache_write;
  target.out += src.out;
}

export function roundTypes(t: TokenTypeBreakdown, digits: 2 | 4): TokenTypeBreakdown {
  const f = digits === 2 ? 100 : 10000;
  const r = (n: number) => Math.round(n * f) / f;
  return { in_uncached: r(t.in_uncached), cache_read: r(t.cache_read), cache_write: r(t.cache_write), out: r(t.out) };
}

export function aggregateBilled(values: Iterable<number | null>): {
  billed_usd: number | null;
  billed_complete: boolean;
} {
  let complete = true;
  let seenNumeric = false;
  let sum = 0;
  let seen = false;
  for (const v of values) {
    seen = true;
    if (v == null) {
      complete = false;
      continue;
    }
    seenNumeric = true;
    sum += v;
  }
  if (!seen) return { billed_usd: 0, billed_complete: true };
  return { billed_usd: seenNumeric ? round2(sum) : null, billed_complete: complete };
}

export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

export function daySelected(day: string, opts: { since?: string; until?: string }): boolean {
  return (!opts.since || day >= opts.since) && (!opts.until || day <= opts.until);
}
