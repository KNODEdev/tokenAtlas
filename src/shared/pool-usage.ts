import type { CreditPoolKind, CreditPoolState, CreditPoolTimeline, CreditPoolsOfRange } from "./credit-pools";
import type { CreditFundedSums } from "./credit-funded";

export type PoolUnit = "credits" | "usd";
export interface FundedPoolBucket {
  from: string; until: string;
  native: number; calls: number; tokens: number; apiUsd: number;
}
export interface FundedPoolEvidence {
  poolKey: string;
  unit: PoolUnit;
  /** Stated by the funding itself when the account has not listed the pool. */
  kind?: CreditPoolKind;
  native: number;
  nativeUnpriced: number;
  apiUnpriced: number;
  calls: number;
  tokens: number;
  apiUsd: number;
  buckets: FundedPoolBucket[];
}
export interface PoolUsage {
  key: string;
  kind: CreditPoolKind | null;
  unit: PoolUnit;
  /** Latest account facts; never filled from valued local calls. */
  state: CreditPoolState | null;
  readAt: string | null;
  timeline: CreditPoolTimeline | null;
  observedSpend: number | null;
  funded: FundedPoolEvidence | null;
}

/** Adapter for existing valued credit-funded hours; it does not infer a charge or reprice calls. */
export function codexPoolEvidence(sums: CreditFundedSums | null | undefined): FundedPoolEvidence | null {
  if (!sums) return null;
  return { poolKey: "codex:credits", unit: "credits", native: sums.credits, nativeUnpriced: sums.credits_unpriced,
    apiUnpriced: sums.api_unpriced, calls: sums.calls, tokens: sums.tokens, apiUsd: sums.api_standard,
    buckets: sums.hours.map(([from, calls, tokens, native, apiUsd]) => ({ from,
      until: new Date(Date.parse(from) + 3_600_000).toISOString(), calls, tokens, native, apiUsd })) };
}

/**
 * Claude calls billed from a promotional grant (`billing_mode = 'grant'`), valued at API Standard in the grant's dollars.
 * They belong to the account's one dollar grant; with none or several listed they keep a pool of their own.
 */
export function grantPoolEvidence(sums: CreditFundedSums | null | undefined, range: CreditPoolsOfRange | null | undefined): FundedPoolEvidence | null {
  if (!sums) return null;
  const grants = new Set([...(range?.pools ?? []), ...(range?.timelines ?? [])]
    .filter(pool => pool.kind === "grant" && pool.unit === "usd").map(pool => pool.key));
  return { poolKey: grants.size === 1 ? [...grants][0]! : "claude:grant", unit: "usd", kind: "grant",
    native: sums.api_standard, nativeUnpriced: sums.api_unpriced, apiUnpriced: sums.api_unpriced,
    calls: sums.calls, tokens: sums.tokens, apiUsd: sums.api_standard,
    buckets: sums.hours.map(([from, calls, tokens, , apiUsd]) => ({ from,
      until: new Date(Date.parse(from) + 3_600_000).toISOString(), calls, tokens, native: apiUsd, apiUsd })) };
}

/** One projection for every account pool and every consumer, independent of the provider. */
export function poolUsage(range: CreditPoolsOfRange | null | undefined, evidence?: FundedPoolEvidence | null): PoolUsage[] {
  const keys = new Set([...(range?.pools ?? []).filter(pool => pool.unit !== "resets").map(pool => pool.key),
    ...(range?.timelines ?? []).filter(pool => pool.unit !== "resets").map(pool => pool.key),
    ...(range?.flows ?? []).filter(pool => pool.unit !== "resets").map(pool => pool.key),
    ...(evidence ? [evidence.poolKey] : [])]);
  return [...keys].map(key => {
    const state = range?.pools.find(pool => pool.key === key) ?? null;
    const timeline = range?.timelines?.find(pool => pool.key === key) ?? null;
    const flow = range?.flows.find(pool => pool.key === key);
    const funded = evidence?.poolKey === key ? evidence : null;
    return { key, kind: state?.kind ?? timeline?.kind ?? funded?.kind ?? null,
      unit: (state?.unit ?? timeline?.unit ?? flow?.unit ?? funded!.unit) as PoolUnit,
      state, timeline, readAt: state ? range?.read_at ?? null : null,
      observedSpend: flow?.spent ?? null, funded };
  });
}
