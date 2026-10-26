import { medianOf, round4 } from "./capacity-equivalents";
import { TOKEN_TYPES } from "./plans-catalog";
import type { AdmittedSample, TokenQuantities, Quantity, CalibrationStatus } from "./plan-capacity-contracts";
import { tokenTotal, absent, present, sumPresent } from "./plan-capacity-quantities";
import { CONSISTENCY_RELATIVE_MAX, HOUR_MS } from "./plan-capacity-contracts";

export function relativeDeviation(xs: number[]): number | null {
  const med = medianOf(xs);
  if (med == null) return null;
  if (med === 0) return xs.every((x) => x === 0) ? 0 : Number.POSITIVE_INFINITY;
  let max = 0;
  for (const x of xs) {
    const rel = Math.abs(x - med) / Math.abs(med);
    if (rel > max) max = rel;
  }
  return max;
}

export function cohortSpread(samples: AdmittedSample[]): { spread: number | null; consistent: boolean } {
  if (samples.length === 0) return { spread: null, consistent: false };
  const totals: number[] = [];
  for (const s of samples) {
    const tot = tokenTotal(s.tokens_per_1pct);
    if (tot == null) return { spread: null, consistent: false };
    totals.push(tot);
  }
  let spread = relativeDeviation(totals);
  for (const t of TOKEN_TYPES) {
    const xs: number[] = [];
    for (const s of samples) {
      const q = s.tokens_per_1pct[t];
      if (q.absent == null) xs.push(q.value);
    }
    if (xs.length < 2) continue;
    const rel = relativeDeviation(xs);
    if (rel == null) continue;
    if (spread == null || rel > spread) spread = rel;
  }
  if (spread == null) return { spread: null, consistent: false };
  return { spread, consistent: spread <= CONSISTENCY_RELATIVE_MAX };
}

export function medianTokenVector(samples: AdmittedSample[]): TokenQuantities {
  const out = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) {
    const xs: number[] = [];
    let missing = false;
    for (const s of samples) {
      const q = s.tokens_per_1pct[t];
      if (q.absent != null) {
        missing = true;
        break;
      }
      xs.push(q.value);
    }
    if (missing) {
      out[t] = absent("missing_counter");
      continue;
    }
    const med = medianOf(xs);
    out[t] = med == null ? absent("missing_counter") : present(round4(med));
  }
  return out;
}

export function medianApi(samples: AdmittedSample[]): { usd: Quantity; byType: TokenQuantities } {
  const byType = {} as TokenQuantities;
  for (const t of TOKEN_TYPES) {
    const xs: number[] = [];
    let missingRate = false;
    let missingCounter = false;
    for (const s of samples) {
      const q = s.api_by_type[t];
      if (q.absent === "missing_rate") {
        missingRate = true;
        break;
      }
      if (q.absent != null) {
        missingCounter = true;
        break;
      }
      xs.push(q.value);
    }
    if (missingRate) {
      byType[t] = absent("missing_rate");
      continue;
    }
    if (missingCounter) {
      byType[t] = absent("missing_counter");
      continue;
    }
    const med = medianOf(xs);
    byType[t] = med == null ? absent("missing_counter") : present(round4(med));
  }
  return { usd: sumPresent(byType), byType };
}

export function spanHoursOf(samples: AdmittedSample[]): number | null {
  if (samples.length === 0) return null;
  let min = samples[0]!.start_ts;
  let max = samples[0]!.end_ts;
  for (const s of samples) {
    if (s.start_ts < min) min = s.start_ts;
    if (s.end_ts > max) max = s.end_ts;
  }
  const ms = Date.parse(max) - Date.parse(min);
  return Number.isFinite(ms) ? ms / HOUR_MS : null;
}

export function cadencePolicy(samples: AdmittedSample[]): { cadenceHours: number | null; mixed: boolean } {
  const distinct = [
    ...new Set(samples.map((s) => s.cadence_hours).filter((n) => n > 0)),
  ].sort((a, b) => a - b);
  if (distinct.length === 0) return { cadenceHours: null, mixed: false };
  if (distinct.length === 1) return { cadenceHours: distinct[0]!, mixed: false };
  return { cadenceHours: distinct[distinct.length - 1]!, mixed: true };
}

export function statusOf(args: {
  accepted: number;
  spanHours: number | null;
  cadenceHours: number | null;
  consistent: boolean;
  mixedCadence: boolean;
  completeVector: boolean;
}): { status: CalibrationStatus; reason: string } {
  if (args.accepted === 0) return { status: "none", reason: "no_accepted_windows" };
  const fullCadence =
    args.spanHours != null && args.cadenceHours != null && args.spanHours + 1e-9 >= args.cadenceHours;
  if (
    args.accepted >= 2 &&
    fullCadence &&
    args.consistent &&
    !args.mixedCadence &&
    args.completeVector
  ) {
    return { status: "reliable", reason: "two_independent_windows_full_cadence_within_10pct" };
  }
  const bits: string[] = [];
  if (args.accepted < 2) bits.push("insufficient_windows");
  if (!fullCadence) bits.push("cadence_span_short");
  if (!args.consistent) bits.push("inconsistent_gt_10pct");
  if (args.mixedCadence) bits.push("mixed_cadence");
  if (!args.completeVector) bits.push("missing_counter");
  return { status: "working", reason: bits.join(",") || "working" };
}

export function apiStatusOf(
  tokenStatus: CalibrationStatus,
  valuedCount: number,
  acceptedCount: number,
  usdConsistent: boolean
): { status: CalibrationStatus; reason: string } {
  if (acceptedCount === 0) return { status: "none", reason: "no_accepted_windows" };
  if (valuedCount === 0) return { status: "none", reason: "missing_rate" };
  if (tokenStatus === "reliable" && valuedCount === acceptedCount && usdConsistent) {
    return { status: "reliable", reason: "valued_reliable_vector" };
  }
  const bits: string[] = [];
  if (valuedCount < acceptedCount) bits.push("missing_rate");
  if (tokenStatus !== "reliable") bits.push(tokenStatus);
  if (!usdConsistent) bits.push("inconsistent_gt_10pct");
  return { status: "working", reason: bits.join(",") || "working" };
}
