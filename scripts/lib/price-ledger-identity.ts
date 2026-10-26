import { createHash, randomUUID } from "node:crypto";

// P0 contract: the future publisher persists these IDs; paths/rowids are only locators.
export interface LedgerObservation {
  sourceOffset: bigint;
  providerThreadId: string | null;
  providerResponseId: string | null;
  accountingRecordDigest: string;
  pricingInputRevision: string;
}
export interface BoundLedgerObservation extends LedgerObservation { id: string; copyId: string }
/** Supplied by a source reconciliation that proves correspondence, not by price/vector equality. */
export interface VerifiedObservationMatch { previousId: string; nextSourceOffset: bigint; evidenceSha256: string }
const providerKey = (entry: LedgerObservation): string | null => entry.providerThreadId && entry.providerResponseId
  ? JSON.stringify([entry.providerThreadId, entry.providerResponseId]) : null;
function validate(entries: readonly LedgerObservation[]): void {
  const offsets = new Set<bigint>(), providerKeys = new Set<string>();
  let previousOffset = -1n;
  for (const entry of entries) {
    if (typeof entry.sourceOffset !== "bigint" || entry.sourceOffset < 0n || entry.sourceOffset > 9_223_372_036_854_775_807n
      || offsets.has(entry.sourceOffset)) throw new Error("Missing/duplicate or unrepresentable physical observation offset");
    if (entry.sourceOffset < previousOffset) throw new Error("Observations must be ordered by physical source offset");
    previousOffset = entry.sourceOffset;
    if (!/^[a-f0-9]{64}$/.test(entry.accountingRecordDigest) || !/^[a-f0-9]{64}$/.test(entry.pricingInputRevision)) {
      throw new Error("Observation evidence must be a SHA-256 digest");
    }
    offsets.add(entry.sourceOffset);
    const key = providerKey(entry);
    if (key && providerKeys.has(key)) throw new Error("Repeated provider request needs conflict reconciliation before binding");
    if (key) providerKeys.add(key);
  }
}
/** Input arrays describe ONE previously verified physical copy, ordered by accounting observation. */
export function reconcileLedgerObservations(copyId: string, previous: readonly BoundLedgerObservation[], next: readonly LedgerObservation[],
  verifiedMatches: readonly VerifiedObservationMatch[] = []) {
  if (!copyId.trim()) throw new Error("Persistent copy ID is required");
  validate(previous); validate(next);
  if (previous.some(entry => entry.copyId !== copyId)) throw new Error("Previous observation belongs to another physical copy");
  const oldIds = new Set(previous.map(entry => entry.id));
  if (oldIds.size !== previous.length || previous.some(entry => !entry.id.trim())) throw new Error("Invalid permanent observation IDs");
  const byProvider = new Map(previous.flatMap(entry => {
    const key = providerKey(entry); return key ? [[key, entry] as const] : [];
  }));
  const byOffset = new Map(previous.map(entry => [entry.sourceOffset, entry]));
  const previousById = new Map(previous.map(entry => [entry.id, entry]));
  const nextByOffset = new Map(next.map(entry => [entry.sourceOffset, entry]));
  const proved = new Map<bigint, BoundLedgerObservation>(), provedIds = new Set<string>();
  for (const proof of verifiedMatches) {
    const before = previousById.get(proof.previousId), after = nextByOffset.get(proof.nextSourceOffset);
    if (!before || !after || !/^[a-f0-9]{64}$/.test(proof.evidenceSha256) || proved.has(proof.nextSourceOffset)
      || provedIds.has(proof.previousId) || before.accountingRecordDigest !== after.accountingRecordDigest
      || providerKey(before) !== providerKey(after)) throw new Error("Invalid verified observation correspondence");
    proved.set(proof.nextSourceOffset, before); provedIds.add(proof.previousId);
  }
  const repeatedDigests = new Set<string>();
  for (const observations of [previous, next]) {
    const counts = new Map<string, number>();
    for (const entry of observations) if (!providerKey(entry)) {
      const count = (counts.get(entry.accountingRecordDigest) ?? 0) + 1;
      counts.set(entry.accountingRecordDigest, count);
      if (count > 1) repeatedDigests.add(entry.accountingRecordDigest);
    }
  }
  // Whole preserved sequence/prefix proves ordering even when several legacy requests are identical.
  const prefix = previous.length <= next.length && previous.every((entry, index) =>
    entry.accountingRecordDigest === next[index]!.accountingRecordDigest && providerKey(entry) === providerKey(next[index]!));
  const unchanged = previous.length === next.length && previous.every((entry, index) =>
    entry.sourceOffset === next[index]!.sourceOffset && entry.accountingRecordDigest === next[index]!.accountingRecordDigest
    && entry.pricingInputRevision === next[index]!.pricingInputRevision && entry.providerThreadId === next[index]!.providerThreadId
    && entry.providerResponseId === next[index]!.providerResponseId);
  if (unchanged && verifiedMatches.some(proof => byOffset.get(proof.nextSourceOffset)?.id !== proof.previousId)) {
    throw new Error("Verified proof contradicts the unchanged accepted snapshot");
  }
  const used = new Set<string>();
  const entries = next.map((entry, index) => {
    const key = providerKey(entry), sameOffset = byOffset.get(entry.sourceOffset);
    const ambiguous = !key && repeatedDigests.has(entry.accountingRecordDigest);
    const known = proved.get(entry.sourceOffset) ?? (unchanged ? previous[index] : key ? byProvider.get(key) : ambiguous ? undefined
      : prefix ? previous[index] : sameOffset?.accountingRecordDigest === entry.accountingRecordDigest && !providerKey(sameOffset) ? sameOffset : undefined);
    if (known && used.has(known.id)) throw new Error("One permanent observation cannot bind twice");
    const id = known?.id ?? randomUUID();
    used.add(id);
    return { ...entry, id, copyId, newObservation: !known,
      baseChanged: !known || known.pricingInputRevision !== entry.pricingInputRevision };
  });
  const unmatchedPrior = previous.filter(entry => !used.has(entry.id)).map(entry => entry.id);
  // This is evidence to resolve, never authority to delete retained history.
  return { entries, unmatchedPrior, ready: unmatchedPrior.length === 0,
    preservedSequence: prefix && unmatchedPrior.length === 0 && previous.every((entry, index) => entries[index]!.id === entry.id) };
}

const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_, item) =>
  typeof item === "bigint" ? ["integer", item.toString()] : item)).digest("hex");
export interface BasePriceInputs {
  model: string | null; ts: string; in_tok: number | bigint | null; cached_in: number | bigint | null;
  cache_write: number | bigint | null; out_tok: number | bigint | null;
  cache_write_status: string | null; usage_status: string | null;
}
/** Rule revision is separate; identity, account, tier and locator do not reprice an unchanged base. */
export function basePriceInputRevision(componentId: string, algorithmVersion: string, event: BasePriceInputs): string {
  if (!componentId.trim() || !algorithmVersion.trim()) throw new Error("Component and algorithm version are required");
  const number = (value: number | bigint | null) => value === null ? ["missing"]
    : typeof value === "bigint" ? ["integer", value.toString()]
    : Number.isSafeInteger(value) ? ["integer", BigInt(value).toString()]
    : [Number.isFinite(value) ? "noninteger-or-unsafe-number" : "nonfinite", String(value)];
  return revision([componentId, algorithmVersion, event.model, event.ts, number(event.in_tok), number(event.cached_in),
    number(event.cache_write), number(event.out_tok), event.cache_write_status, event.usage_status]);
}
