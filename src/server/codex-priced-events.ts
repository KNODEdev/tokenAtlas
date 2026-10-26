import type { Database } from "bun:sqlite";
import { attachCodexValuation, type CodexAccountingConfig, type CodexAccountingEvent,
  type CodexEventValuation, type CodexEventPrice } from "./codex-accounting-pricing";
import { readCodexLedgerEventCohorts, readCodexLedgerEventGroups, readPublishedCodexLedgerContext, ledgerPresentationNumber,
  type CodexEventFilter, type CodexLedgerReadContext } from "../db/codex-ledger-adapters";
import type { LedgerCohortSpec } from "../db/codex-price-ledger";
import { add, subtract, divide, multiply, rational } from "../db/price-ledger-exact";
import type { LedgerReadGroup, LedgerAmount } from "../db/codex-price-ledger-read";
import type { CodexBillingBasis } from "../shared/codex-accounting";
import { codexReferenceValuation, type CodexLedgerReferenceValue, type CodexReferenceCall } from "../db/codex-ledger-reference";
import type { AccountResolver } from "./account-resolver";
import { codexEventOwner } from "./codex-event-owner";
import { codexContextThresholds, codexLedgerContextProjection } from "../db/codex-ledger-context";

export type RegisteredCodexEvent = CodexAccountingEvent & {
  id: number | null; source_offset: number | null; home: string | null; path: string | null;
  source: string | null; instant_ms: number | null;
  account: string | null; project_id: string | null; subject: string | null; nested?: string | null;
};
/** Ownership follows accepted source/time evidence; original timestamp text is never restamped. */
export function resolveCodexLedgerEventOwner(resolver: AccountResolver,
  event: Pick<RegisteredCodexEvent,"source"|"instant_ms"|"billing_mode">): string | null {
  const owner = event.instant_ms !== null && Number.isSafeInteger(event.instant_ms)
    ? resolver.resolve("codex",event.source,null,new Date(event.instant_ms).toISOString()).account : null;
  return codexEventOwner(owner,event);
}
const published = Symbol("published-codex-ledger-group");
const publishedPolicy = Symbol("published-codex-ledger-policy");
const publishedReference = Symbol("published-codex-ledger-reference");
const contextInput = Symbol("published-codex-context-input");
type Published = CodexAccountingEvent & { [published]?: LedgerReadGroup; [publishedPolicy]?: CodexLedgerReadContext;
  [publishedReference]?: { day: string; value: CodexLedgerReferenceValue }; [contextInput]?: unknown };
export function publishedCodexContext(event: CodexAccountingEvent) {
  const stored = event as Published;
  return stored[published] && stored[publishedPolicy]
    ? codexLedgerContextProjection(stored[publishedPolicy]!.policy, stored[published]!, stored[contextInput]) : null;
}
export const getPublishedCodexLedgerGroup = (event: CodexAccountingEvent): LedgerReadGroup | undefined => (event as Published)[published];
const amountNumber = (amount: LedgerAmount): number | null => amount.value === null ? null : ledgerPresentationNumber(amount.value);
const issue = (amount: LedgerAmount): CodexEventPrice["reason"] =>
  (Object.keys(amount.reasons)[0] ?? null) as CodexEventPrice["reason"];
function groupOf(event: CodexAccountingEvent): LedgerReadGroup {
  const group = (event as Published)[published];
  if (!group) throw new Error("Codex counter-edge event has no published ledger valuation");
  return group;
}
function actualCredit(group: LedgerReadGroup): LedgerAmount {
  const extra = group.variants.extra_credits, standard = group.variants.credits_standard;
  if (extra.value === null) return extra;
  const value = add(standard.subtotal, extra.subtotal);
  return { ...extra, value, subtotal: value, pricedSubtotal: value };
}
export function pricePublishedCodexEvent(_config: CodexAccountingConfig, event: CodexAccountingEvent,
  basis: CodexBillingBasis, referenceDay?: string): CodexEventPrice {
  const group = groupOf(event);
  if (referenceDay !== undefined && basis === "api_equivalent_usd" && event.speed === "standard") {
    const reference = (event as Published)[publishedReference];
    if (reference?.day === referenceDay) return { amount: reference.value.amount === null ? null : ledgerPresentationNumber(reference.value.amount),
      reason: reference.value.reason as CodexEventPrice["reason"], rule_id: reference.value.ruleId, long_context: reference.value.longContext };
    if (referenceDay !== group.stored.day) throw new Error("Codex call was read without its reference-day valuation");
  } else if (referenceDay !== undefined && referenceDay !== group.stored.day) {
    throw new Error("Unsupported reference-date basis or tier");
  }
  let amount: LedgerAmount;
  if (basis === "chatgpt_credits") amount = event.speed === "standard" ? group.variants.credits_standard
    : event.speed === "fast" ? group.variants.credits_fast : actualCredit(group);
  else if (event.speed === "fast" && group.tier !== "fast") {
    const factor = (event as Published)[publishedPolicy]?.policy.multiplier(event.model, "api_equivalent_usd", "fast", event.ts.slice(0, 10));
    const base = group.variants.api_standard;
    const value = base.value !== null && factor ? multiply(base.value, factor) : null;
    amount = value !== null ? { ...base, value, subtotal: value, pricedSubtotal: value } : { ...base,
      value: null, subtotal: rational(0n), pricedSubtotal: rational(0n), pricedEvents: 0n, pricedTokens: 0n,
      unpricedEvents: group.calls, unpricedTokens: group.tokensReported,
      reasons: base.value === null ? base.reasons : { missing_rate: { events: group.calls, tokens: group.tokensReported } } };
  } else amount = event.speed === "standard" ? group.variants.api_standard : group.variants.api_actual;
  return { amount: amountNumber(amount), reason: issue(amount), rule_id: null, long_context: false };
}
type NormalizedCodexEvent = Readonly<{ credits: number | null; standard_credits: number | null; extra_credits: number | null;
  standard_api_usd: number | null; normalized_usd: number | null; multiplier: number | null;
  reason: CodexEventPrice["reason"]; rule_ids: readonly string[] }>;
/**
 * The result depends only on the published group and the tier, and its exact arithmetic is costly: a window
 * producer values each call once per window and statistic, so results are kept with the group (read-only).
 */
const normalizedByGroup = new WeakMap<LedgerReadGroup, Map<string, NormalizedCodexEvent>>();
export function normalizePublishedCodexEvent(_config: CodexAccountingConfig, event: CodexAccountingEvent): NormalizedCodexEvent {
  return normalizePublishedCodexTier(event, event.speed);
}
/** `normalizePublishedCodexEvent` of the event as if recorded at `speed`, without copying the event. */
export function normalizePublishedCodexTier(event: CodexAccountingEvent, speed: string | null | undefined): NormalizedCodexEvent {
  const group = groupOf(event), tier = speed === "standard" || speed === "fast" ? speed : "actual";
  let known = normalizedByGroup.get(group);
  const found = known?.get(tier);
  if (found) return found;
  const standard = group.variants.credits_standard, api = group.variants.api_standard;
  const actual = tier === "standard" ? standard : tier === "fast" ? group.variants.credits_fast : actualCredit(group);
  const burden = actual.value !== null && standard.value !== null
    ? standard.value.n === 0n && actual.value.n === 0n ? rational(1n) : standard.value.n !== 0n ? divide(actual.value, standard.value) : null : null;
  const result: NormalizedCodexEvent = Object.freeze({ credits: amountNumber(actual), standard_credits: amountNumber(standard),
    extra_credits: actual.value !== null && standard.value !== null ? ledgerPresentationNumber(subtract(actual.value, standard.value)) : null,
    standard_api_usd: amountNumber(api), normalized_usd: burden !== null && api.value !== null ? ledgerPresentationNumber(multiply(api.value, burden)) : null,
    multiplier: burden === null ? null : ledgerPresentationNumber(burden),
    reason: issue(actual) ?? issue(standard) ?? issue(api), rule_ids: Object.freeze([] as string[]) });
  if (!known) normalizedByGroup.set(group, known = new Map());
  known.set(tier, result);
  return result;
}
/** Read stored per-event bases only for bounded counter edges and audit details. */
export function readCodexEventRange(db: Database, config: CodexAccountingConfig, from: string, untilExclusive: string,
  account?: (event: RegisteredCodexEvent) => string | null, ledger?: CodexLedgerReadContext, filter?: CodexEventFilter): RegisteredCodexEvent[] {
  const current = ledger ?? readPublishedCodexLedgerContext(db);
  const rows = readCodexLedgerEventGroups(db, from, untilExclusive, current, filter);
  const reference = current.referenceDay ? codexReferenceValuation(current.policy.baseBands, current.referenceDay) : null;
  return rows.map(({ event: raw, group }) => publishedEvent(config, current, raw, group,
    reference ? reference(raw as unknown as CodexReferenceCall) : null, account));
}
/**
 * The canonical calls of `[from, until)` in exact cohorts (`readCodexLedgerCohorts`): each is one event carrying
 * `calls`, the summed token fields, the cohort's published valuation and, with the read's reference day, its
 * valuation at that day (linear in the summed buckets: a cohort's calls share their model, reason and context band).
 */
export function readCodexWindowCohorts(db: Database, config: CodexAccountingConfig, spec: Omit<LedgerCohortSpec, "referenceThresholds">,
  account: (event: RegisteredCodexEvent) => string | null, ledger?: CodexLedgerReadContext): Array<RegisteredCodexEvent & { calls: number }> {
  const current = ledger ?? readPublishedCodexLedgerContext(db);
  const day = current.referenceDay;
  const reference = day !== undefined ? codexReferenceValuation(current.policy.baseBands, day) : null;
  // Every context threshold of the reference bands splits cohorts, so each band admits a cohort's calls alike.
  const thresholds = [...new Set([...codexContextThresholds(current.policy),
    ...(day !== undefined ? current.policy.baseBands.flatMap(band => band.threshold === undefined ? [] : [band.threshold]) : [])])];
  return readCodexLedgerEventCohorts(db, { ...spec, referenceThresholds: thresholds }, current).map(({ event: row, group }) => {
    const calls = Number(row.calls);
    const raw = { id: row.first_id, ts: row.first_ts, last_ts: row.last_ts, day: row.day, instant_ms: row.first_ms, copy_state: row.copy_state,
      home: row.home, path: null, source: row.source, model: row.model, service_tier: row.service_tier, subject: row.subject,
      billing_mode: row.billing_mode, surface: row.surface, nested: row.nested, plan_type: row.plan_type, meter_reset: row.meter_reset,
      repo: row.repo, project: row.project, in_tok: row.in_tok, cached_in: row.cached_in, cache_write: row.cache_write, out_tok: row.out_tok,
      reasoning_out: null, calls, context_input: row.band_in_tok };
    const value = reference ? reference({ model: row.model, in_tok: row.band_in_tok, uncached: Number(row.uncached), cached: Number(row.cached),
      writes: Number(row.writes), output: Number(row.output), common_reason: row.common_reason }) : null;
    return publishedEvent(config, current, raw, group, value, account) as RegisteredCodexEvent & { calls: number };
  });
}
/** A stored call (or cohort of calls) with its published valuation attached, as the window and accounting readers use it. */
function publishedEvent(config: CodexAccountingConfig, current: CodexLedgerReadContext, raw: Record<string, unknown>, group: LedgerReadGroup,
  reference: CodexLedgerReferenceValue | null, account?: (event: RegisteredCodexEvent) => string | null): RegisteredCodexEvent {
  const event = { ...raw, speed: group.tier ?? "unknown", account: null, account_id: null,
    project_id: typeof raw.subject === "string" && raw.subject.startsWith("p:") ? raw.subject.slice(2) : null,
    [published]: group, [publishedPolicy]: current, [contextInput]: raw.context_input ?? raw.in_tok,
    ...(current.referenceDay ? { [publishedReference]: { day: current.referenceDay, value: reference! } } : {}) } as unknown as RegisteredCodexEvent;
  if (account) event.account = account(event);
  // Existing comparison helpers can reuse these values when they explicitly request Standard/Fast. They are
  // computed on first use: these three prices read only the group and the tier, the fourth the model and day as read.
  const model = event.model, day = event.ts.slice(0, 10);
  const atTier = (speed: string) => ({ speed, [published]: group }) as unknown as CodexAccountingEvent;
  attachCodexValuation(config, event, () => [
    pricePublishedCodexEvent(config, atTier("standard"), "chatgpt_credits"),
    pricePublishedCodexEvent(config, atTier("fast"), "chatgpt_credits"),
    pricePublishedCodexEvent(config, atTier("standard"), "api_equivalent_usd"),
    (() => {
      const factor = current.policy.multiplier(model, "api_equivalent_usd", "fast", day);
      const base = group.variants.api_standard;
      return { amount: base.value !== null && factor ? ledgerPresentationNumber({
        n: base.value.n * factor.n, d: base.value.d * factor.d }) : null,
        reason: base.value === null ? issue(base) : factor ? null : "missing_rate", rule_id: null, long_context: false };
    })(),
  ] as CodexEventValuation);
  return event;
}
export function readCodexPricedDay(db: Database, config: CodexAccountingConfig, day: string,
  ledger?: CodexLedgerReadContext): RegisteredCodexEvent[] {
  const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
  return readCodexEventRange(db, config, day, next, undefined, ledger);
}
