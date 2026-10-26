import { createHash } from "node:crypto";
import type { LedgerBaseBand } from "./codex-price-ledger";
import { compileNanoRates, NANO_BUCKETS, rational } from "./price-ledger-exact";
import { inContextBand } from "../shared/context-tier";

export interface CodexLedgerBaseScope {
  model: string;
  basis: LedgerBaseBand["basis"];
  fromDay: string;
  untilDay: string | null;
  inputAbove: number | null;
  inputUntil: number | null;
}
interface CompiledBand { band: LedgerBaseBand; value: string }
const maximumInput = Number.MAX_SAFE_INTEGER;
const subject = (band: LedgerBaseBand) => JSON.stringify([band.model, band.basis]);

function compile(bands: readonly LedgerBaseBand[]): CompiledBand[] {
  return bands.map(band => {
    const rates = compileNanoRates(band.rates, band.multiplier);
    // A shared denominator's spelling is not a dependency; each coefficient is canonical.
    const value = JSON.stringify(NANO_BUCKETS.map(bucket => {
      const rate = rates.buckets[bucket];
      if (rate === null) return null;
      const coefficient = rational(rate.whole * rates.denominator + rate.remainder, rates.denominator);
      return [String(coefficient.n), String(coefficient.d)];
    }));
    return { band, value };
  });
}
const active = (bands: readonly CompiledBand[], day: string) => bands.filter(({ band }) =>
  band.validFrom <= day && (!band.validUntil || day < band.validUntil));
function inputCuts(bands: readonly CompiledBand[]): number[] {
  return [...new Set(bands.flatMap(({ band }) => band.threshold === undefined || band.threshold >= maximumInput
    ? [] : [band.threshold]))].sort((a, b) => a - b);
}
function valueAt(bands: readonly CompiledBand[], inputAbove: number | null): string | null {
  const input = inputAbove === null ? 0 : inputAbove + 1;
  const matched = bands.filter(({ band }) => inContextBand(band.band, band.threshold, input));
  if (matched.length > 1) throw new Error("Overlapping effective Codex base coefficients");
  return matched[0]?.value ?? null;
}
function subjects(before: readonly CompiledBand[], after: readonly CompiledBand[]) {
  return [...new Set([...before, ...after].map(({ band }) => subject(band)))].sort();
}

/** Exact changed date/context ranges, independent of declaration IDs and provenance. */
export function codexLedgerBaseChanges(previous: readonly LedgerBaseBand[], next: readonly LedgerBaseBand[],
  referenceDay?: string): CodexLedgerBaseScope[] {
  const before = compile(previous), after = compile(next), output: CodexLedgerBaseScope[] = [];
  for (const key of subjects(before, after)) {
    const left = before.filter(({ band }) => subject(band) === key), right = after.filter(({ band }) => subject(band) === key);
    const { model, basis } = (left[0] ?? right[0])!.band;
    const dates = referenceDay ? [referenceDay] : [...new Set([...left, ...right].flatMap(({ band }) =>
      [band.validFrom, ...(band.validUntil ? [band.validUntil] : [])]))].sort();
    const recent = new Map<string, CodexLedgerBaseScope>();
    for (let index = 0; index < dates.length; index++) {
      const fromDay = dates[index]!, untilDay = dates[index + 1] ?? null;
      const oldBands = active(left, fromDay), newBands = active(right, fromDay);
      const cuts: Array<number | null> = [null, ...inputCuts([...oldBands, ...newBands]), null];
      const changed: CodexLedgerBaseScope[] = [];
      for (let cut = 0; cut < cuts.length - 1; cut++) {
        const inputAbove = cuts[cut]!, inputUntil = cuts[cut + 1]!;
        if (valueAt(oldBands, inputAbove) === valueAt(newBands, inputAbove)) continue;
        const last = changed.at(-1);
        if (last && last.inputUntil === inputAbove) last.inputUntil = inputUntil;
        else changed.push({ model, basis, fromDay, untilDay, inputAbove, inputUntil });
      }
      for (const scope of changed) {
        const context = JSON.stringify([scope.inputAbove, scope.inputUntil]), prior = recent.get(context);
        if (prior && prior.untilDay === fromDay) prior.untilDay = untilDay;
        else { output.push(scope); recent.set(context, scope); }
      }
    }
  }
  return output;
}

/** A reference day depends only on the effective coefficients at that date. */
export function codexLedgerReferenceFingerprint(bands: readonly LedgerBaseBand[], day: string): string {
  const compiled = compile(bands), values: unknown[] = [];
  for (const key of subjects(compiled, [])) {
    const matching = active(compiled.filter(({ band }) => subject(band) === key), day);
    if (!matching.length) continue;
    const cuts: Array<number | null> = [null, ...inputCuts(matching), null];
    const contexts: Array<{ inputAbove: number | null; inputUntil: number | null; value: string | null }> = [];
    for (let index = 0; index < cuts.length - 1; index++) {
      const inputAbove = cuts[index]!, inputUntil = cuts[index + 1]!, value = valueAt(matching, inputAbove);
      const last = contexts.at(-1);
      if (last && last.value === value) last.inputUntil = inputUntil;
      else contexts.push({ inputAbove, inputUntil, value });
    }
    values.push([key, contexts]);
  }
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
