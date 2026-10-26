import type { Database } from "./sqlite";
import { readCodexLedgerBucketGroups, requireCodexLedgerReady, type LedgerStoredGroup } from "./codex-price-ledger";
import { CODEX_LEDGER_VARIANTS, deriveCodexLedgerGroup, emptyLedgerAmount, mergeLedgerAmounts,
  readCodexLedgerSeries, type LedgerAmount, type LedgerTierPolicy, type LedgerVariant } from "./codex-price-ledger-read";
import { serializeRational } from "./price-ledger-exact";

export interface CodexUsageSeriesRequest {
  fromMs: number; toMs: number; grain: "minute" | "hour";
  models?: readonly (string | null)[]; sources?: readonly string[];
  /** UTC bins are unambiguous; this zone changes labels only, including repeated DST hours. */
  timeZone?: string;
}
export interface CodexUsageSeriesBucket {
  fromMs: number; toMs: number; label: string; calls: bigint; tokens: bigint;
  variants: Record<LedgerVariant, LedgerAmount>;
}
function checkedBounds(fromMs: number, toMs: number): void {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs)
    throw new Error("Expected an increasing exact millisecond interval");
}
const emptyVariants = () => Object.fromEntries(CODEX_LEDGER_VARIANTS.map(variant => [variant, emptyLedgerAmount()])) as Record<LedgerVariant, LedgerAmount>;
function admitted(row: LedgerStoredGroup, request: Pick<CodexUsageSeriesRequest, "models" | "sources">): boolean {
  return (!request.models || request.models.includes(row.model)) && (!request.sources || row.source !== null && request.sources.includes(row.source));
}
/** Chart bins and model/source admission over stored bases of canonical calls (copies were resolved at build). */
export function codexUsageSeries(db: Database, policy: LedgerTierPolicy, request: CodexUsageSeriesRequest): CodexUsageSeriesBucket[] {
  checkedBounds(request.fromMs, request.toMs);
  const bucketMs = request.grain === "minute" ? 60_000 : request.grain === "hour" ? 3_600_000 : 0;
  if (!bucketMs || Math.ceil((request.toMs - request.fromMs) / bucketMs) + 1 > 10_000)
    throw new Error("Requested series exceeds the chart bucket limit");
  const range = { fromMs: request.fromMs, toMs: request.toMs, dependencyModels: request.models };
  requireCodexLedgerReady(db, range);
  const bands = db.query("SELECT id,CAST(denominator AS TEXT) denominator FROM codex_price_ledger_bands").all() as { id: number; denominator: string }[];
  const denominators = new Map(bands.map(row => [row.id, BigInt(row.denominator)]));
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: request.timeZone ?? "Europe/Warsaw", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" });
  const buckets = new Map<number, CodexUsageSeriesBucket>();
  for (const entry of readCodexLedgerBucketGroups(db, range, bucketMs)) {
    if (entry.group.copy_state !== "canonical" || !admitted(entry.group, request)) continue;
    const contribution = deriveCodexLedgerGroup(entry.group, denominators, policy);
    let bucket = buckets.get(entry.bucketStartMs);
    if (!bucket) {
      bucket = { fromMs: Math.max(request.fromMs, entry.bucketStartMs), toMs: Math.min(request.toMs, entry.bucketStartMs + bucketMs),
        label: formatter.format(entry.bucketStartMs), calls: 0n, tokens: 0n, variants: emptyVariants() };
      buckets.set(entry.bucketStartMs, bucket);
    }
    bucket.calls += contribution.calls; bucket.tokens += contribution.tokensReported;
    for (const variant of CODEX_LEDGER_VARIANTS) bucket.variants[variant] = mergeLedgerAmounts(bucket.variants[variant], contribution.variants[variant]);
  }
  return [...buckets.values()].sort((a, b) => a.fromMs - b.fromMs);
}
/** Original percentage observations are inputs; the corresponding usage interval is (start,end]. */
export function codexReadings(db: Database, policy: LedgerTierPolicy, request: {
  startMs: number; endMs: number; models?: readonly (string | null)[]; sources?: readonly string[];
}): { calls: bigint; tokens: bigint; variants: Record<LedgerVariant, LedgerAmount> } {
  checkedBounds(request.startMs, request.endMs);
  const result = { calls: 0n, tokens: 0n, variants: emptyVariants() };
  for (const group of readCodexLedgerSeries(db, policy, { range: { fromMs: request.startMs, toMs: request.endMs,
    startInclusive: false, endInclusive: true, dependencyModels: request.models } })) {
    if (!group.selected || !admitted(group.stored, request)) continue;
    result.calls += group.calls; result.tokens += group.tokensReported;
    for (const variant of CODEX_LEDGER_VARIANTS) result.variants[variant] = mergeLedgerAmounts(result.variants[variant], group.variants[variant]);
  }
  return result;
}
/** Exact JSON transport accompanies decimal presentation, including nonterminating tier factors. */
export function serializeCodexLedgerAmount(amount: LedgerAmount) {
  return { value: amount.value === null ? null : serializeRational(amount.value), subtotal: serializeRational(amount.subtotal),
    pricedSubtotal: serializeRational(amount.pricedSubtotal), pricedEvents: String(amount.pricedEvents), unpricedEvents: String(amount.unpricedEvents),
    pricedTokens: String(amount.pricedTokens), unpricedTokens: String(amount.unpricedTokens), reasons: Object.fromEntries(Object.entries(amount.reasons)
      .map(([reason, count]) => [reason, { events: String(count.events), tokens: String(count.tokens) }])) };
}
