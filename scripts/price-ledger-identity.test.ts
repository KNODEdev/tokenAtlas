import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { basePriceInputRevision, reconcileLedgerObservations, type LedgerObservation, type BasePriceInputs } from "./lib/price-ledger-identity";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const observation = (offset: bigint, digest = "same record"): LedgerObservation => ({ sourceOffset: offset,
  providerThreadId: null, providerResponseId: null, accountingRecordDigest: hash(digest), pricingInputRevision: hash("base") });

test("rowid/locator rewrite and an identical retry retain each distinct legacy observation", () => {
  const old = [{ ...observation(20n), id: "first", copyId: "permanent-copy" }, { ...observation(70n), id: "second", copyId: "permanent-copy" }];
  const next = [observation(30n), observation(90n), observation(130n, "late D+30")];
  const proof = old.map((entry, index) => ({ previousId: entry.id, nextSourceOffset: next[index]!.sourceOffset,
    evidenceSha256: hash("verified archive rewrite preserving the accounting order") }));
  const result = reconcileLedgerObservations("permanent-copy", old, next, proof);
  expect(result.ready).toBe(true);
  expect(result.preservedSequence).toBe(true);
  expect(result.entries.map(entry => entry.id).slice(0, 2)).toEqual(["first", "second"]);
  expect(result.entries.map(entry => entry.baseChanged)).toEqual([false, false, true]);
  expect(new Set(result.entries.map(entry => entry.id)).size).toBe(3);
  const retry = reconcileLedgerObservations("permanent-copy", result.entries, next, result.entries.map(entry => ({
    previousId: entry.id, nextSourceOffset: entry.sourceOffset, evidenceSha256: hash("unchanged source digest") })));
  expect(retry.entries.map(entry => entry.id)).toEqual(result.entries.map(entry => entry.id));
  expect(retry.entries.every(entry => !entry.baseChanged)).toBe(true);
  expect(() => reconcileLedgerObservations("other-copy", old, next)).toThrow("another physical copy");
});

test("known provider request correction changes only its base revision", () => {
  const known = { ...observation(1n), id: "request", copyId: "copy", providerThreadId: "thread", providerResponseId: "response" };
  const corrected = { ...known, sourceOffset: 500n, accountingRecordDigest: hash("corrected tokens"), pricingInputRevision: hash("corrected base") };
  const result = reconcileLedgerObservations("copy", [known], [corrected]);
  expect(result.ready).toBe(true);
  expect(result.entries[0]!.id).toBe("request");
  expect(result.entries[0]!.baseChanged).toBe(true);
  expect(result.entries[0]!.newObservation).toBe(false);
});

test("unproved legacy correction/reordering remains unresolved and cannot erase old history", () => {
  const old = [{ ...observation(10n, "A"), id: "a", copyId: "copy" }, { ...observation(20n, "B"), id: "b", copyId: "copy" }];
  const result = reconcileLedgerObservations("copy", old, [observation(10n, "B"), observation(20n, "A")]);
  expect(result.ready).toBe(false);
  expect(result.unmatchedPrior).toEqual(["a", "b"]);
  expect(result.entries.every(entry => entry.newObservation)).toBe(true);
  expect(() => reconcileLedgerObservations("copy", [], [observation(1n), observation(1n)])).toThrow("duplicate");
  expect(() => reconcileLedgerObservations("copy", [], [observation(2n), observation(1n)])).toThrow("ordered");
  expect(() => reconcileLedgerObservations("copy", [], [observation(9_223_372_036_854_775_808n)])).toThrow("unrepresentable");
  expect(() => reconcileLedgerObservations("copy", [], [{ ...observation(1n), sourceOffset: 1 as unknown as bigint }])).toThrow("unrepresentable");
  const provider = { ...observation(1n), providerThreadId: "t", providerResponseId: "r" };
  expect(() => reconcileLedgerObservations("copy", [], [provider, { ...provider, sourceOffset: 2n }])).toThrow("conflict");
});

test("base semantic stamp ignores tier, funding, account, rowid and locator, but tracks facts/version", () => {
  const input: BasePriceInputs = { model: "m", ts: "2026-09-30T01:00:00Z", in_tok: 10, cached_in: 3,
    cache_write: 0, out_tok: 2, cache_write_status: "missing", usage_status: "valid" };
  const initial = basePriceInputRevision("api-standard", "v1", input);
  expect(basePriceInputRevision("api-standard", "v1", { ...input, in_tok: 10n, cached_in: 3n, cache_write: 0n, out_tok: 2n })).toBe(initial);
  expect(basePriceInputRevision("api-standard", "v1", { ...input, in_tok: null })).not.toBe(
    basePriceInputRevision("api-standard", "v1", { ...input, in_tok: 0 }));
  expect(basePriceInputRevision("api-standard", "v1", { ...input, id: 123, path: "moved", account: "new", speed: "ultrafast", billing_mode: "credits" } as BasePriceInputs)).toBe(initial);
  expect(basePriceInputRevision("api-standard", "v1", { ...input, in_tok: 11 })).not.toBe(initial);
  expect(basePriceInputRevision("api-standard", "v2", input)).not.toBe(initial);
  expect(basePriceInputRevision("credit-standard", "v1", input)).not.toBe(initial);
  expect(basePriceInputRevision("api-standard", "v1", { ...input, in_tok: Number.NaN })).not.toBe(
    basePriceInputRevision("api-standard", "v1", { ...input, in_tok: Infinity }));
});

test("an inserted identical legacy record cannot hijack established contextual identities", () => {
  const old = [{ ...observation(10n), id: "first", copyId: "copy", pricingInputRevision: hash("context A") },
    { ...observation(20n), id: "second", copyId: "copy", pricingInputRevision: hash("context B") }];
  const next = [{ ...observation(10n), pricingInputRevision: hash("inserted context") },
    { ...old[0]!, sourceOffset: 20n }, { ...old[1]!, sourceOffset: 30n }];
  const result = reconcileLedgerObservations("copy", old, next);
  expect(result.ready).toBe(false);
  expect(result.preservedSequence).toBe(false);
  expect(result.unmatchedPrior).toEqual(["first", "second"]);
  const retry = reconcileLedgerObservations("copy", old, old);
  expect(retry.ready).toBe(true);
  expect(retry.entries.every(entry => !entry.baseChanged)).toBe(true);
  expect(() => reconcileLedgerObservations("copy", old, old, [
    { previousId: "second", nextSourceOffset: 10n, evidenceSha256: hash("conflicting proof") },
    { previousId: "first", nextSourceOffset: 20n, evidenceSha256: hash("conflicting proof") },
  ])).toThrow("contradicts the unchanged");
});

test("removing provider evidence cannot downgrade an accepted keyed observation", () => {
  const old = { ...observation(10n), id: "keyed", copyId: "copy", providerThreadId: "thread", providerResponseId: "response" };
  const result = reconcileLedgerObservations("copy", [old], [{ ...old, providerThreadId: null, providerResponseId: null }]);
  expect(result.ready).toBe(false);
  expect(result.unmatchedPrior).toEqual(["keyed"]);
  expect(() => reconcileLedgerObservations("copy", [old], [old], [{ previousId: "keyed", nextSourceOffset: 10n,
    evidenceSha256: "not evidence" }])).toThrow("Invalid verified");
});
