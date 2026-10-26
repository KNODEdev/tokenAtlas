import { expect, test } from "bun:test";
import type { LedgerBaseBand } from "./codex-price-ledger";
import { codexLedgerBaseChanges, codexLedgerReferenceFingerprint } from "./codex-ledger-dependencies";

const base = (changes: Partial<LedgerBaseBand> = {}): LedgerBaseBand => ({ id: "base", model: "m", basis: "api_equivalent_usd",
  validFrom: "2026-01-01", band: "normal", rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "2" },
  multiplier: "1", evidence: "original", ...changes });
const scope = (changes: Partial<ReturnType<typeof codexLedgerBaseChanges>[number]> = {}): ReturnType<typeof codexLedgerBaseChanges>[number] => ({ model: "m", basis: "api_equivalent_usd",
  fromDay: "2026-01-01", untilDay: null, inputAbove: null, inputUntil: null, ...changes });

test("period splitting, IDs, provenance and exact equivalent coefficients do not change dependencies", () => {
  const before = [base()];
  const after = [base({ id: "past", validUntil: "2026-10-01", rates: { in_uncached: "1.0", in_cache_read: "0.10", out_total: "2.00" } }),
    base({ id: "later", validFrom: "2026-10-01", evidence: "new evidence" })];
  expect(codexLedgerBaseChanges(before, after)).toEqual([]);
  expect(codexLedgerReferenceFingerprint(before, "2026-04-01")).toBe(codexLedgerReferenceFingerprint(after, "2026-04-01"));
  const credit = base({ basis: "chatgpt_credits" });
  const factored = [{ ...credit, multiplier: "0.5", rates: { in_uncached: "2", in_cache_read: "0.2", out_total: "4" } }];
  expect(codexLedgerBaseChanges([credit], factored)).toEqual([]);
});

test("one changed future period is one exclusive date range instead of old/new overlapping ranges", () => {
  const before = [base()], after = [base({ validUntil: "2026-10-01" }),
    base({ id: "changed", validFrom: "2026-10-01", validUntil: "2026-12-01", rates: { ...base().rates, out_total: "3" } }),
    base({ id: "restored", validFrom: "2026-12-01" })];
  expect(codexLedgerBaseChanges(before, after)).toEqual([scope({ fromDay: "2026-10-01", untilDay: "2026-12-01" })]);
  expect(codexLedgerBaseChanges(before, after, "2026-04-01")).toEqual([]);
});

test("missing prices and cache-write evidence stay distinct from confirmed zero", () => {
  const zero = base({ rates: { in_uncached: "0", in_cache_read: "0", out_total: "0" } });
  expect(codexLedgerBaseChanges([], [zero])).toEqual([scope()]);
  expect(codexLedgerBaseChanges([zero], [])).toEqual([scope()]);
  expect(codexLedgerBaseChanges([zero], [base({ rates: { ...zero.rates, in_cache_write: "0" } })])).toEqual([scope()]);
});

test("moving an input threshold changes only its crossed inclusive token range", () => {
  const normal = base({ threshold: 10 }), long = base({ band: "long", threshold: 10,
    rates: { in_uncached: "2", in_cache_read: "0.2", out_total: "4" } });
  const after = [{ ...normal, threshold: 20 }, { ...long, threshold: 20 }];
  expect(codexLedgerBaseChanges([normal, long], after)).toEqual([scope({ inputAbove: 10, inputUntil: 20 })]);
  expect(codexLedgerBaseChanges([normal, { ...long, rates: normal.rates }],
    [base({ threshold: undefined })])).toEqual([]);
});

test("adjacent changed contexts and dates coalesce, while a priced gap stays out", () => {
  const before = [base()], rates = { in_uncached: "9", in_cache_read: "0.9", out_total: "18" };
  const after = [base({ validUntil: "2026-04-01", rates }), base({ id: "middle", validFrom: "2026-04-01", validUntil: "2026-07-01", rates }),
    base({ id: "gap", validFrom: "2026-07-01", validUntil: "2026-10-01" }), base({ id: "last", validFrom: "2026-10-01", rates })];
  expect(codexLedgerBaseChanges(before, after)).toEqual([scope({ untilDay: "2026-07-01" }), scope({ fromDay: "2026-10-01" })]);
});
