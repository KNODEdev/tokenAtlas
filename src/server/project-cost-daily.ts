import { isReadonlyConnection, type Database } from "../db/sqlite";
import type { ProjectCostDailyAggregate, DailyBucket, DailyUnpriced, DailyTokenCalls, ModelSlice, TokenTypeBreakdown } from "./project-cost-contracts";
import { ACCOUNT_PERIODS, loadPeriods } from "../db/period-store";
import { codexLedgerFactsPending } from "../db/read-freshness";
import { usageLedgerClock } from "./usage-ledger-producer";
import { projectRulesStamp } from "../projects/rules-now";
import type { RateCard } from "./pricing";
import type { Rational } from "../db/price-ledger-exact";
import { codexLedgerApiTokenAmounts, ledgerPresentationNumber, codexLedgerReadContext, codexLedgerPendingReason, codexLedgerReadStamp } from "../db/codex-ledger-adapters";
import { rational, add } from "../db/price-ledger-exact";
import { readLedgerSums, requireUsageLedgerSums, sumTokens } from "./ledger-sums";
import { addModels, addTypes, zeroTypes } from "./project-cost-values";
import { readProjectCodexRows, codexPlanRow } from "./project-cost-codex";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { analysisHash } from "../db/analysis";
import { ratesWithoutAuthoritativeCodexPolicy } from "./codex-ledger-report-dependencies";
import { tableExists } from "./project-cost-schema";
import { contextReadScope } from "../db/codex-context-read-scope";

const projectCostMemo = new WeakMap<Database, { key: string; value: ProjectCostDailyAggregate }>();

function indexStamp(sqlite: Database): string | null {
  try {
    // Incomplete publication may change rows between head revisions. Read through it without a memo.
    if (codexLedgerFactsPending(sqlite)) return null;
    for (const provider of ["glm", "gemini"] as const) requireUsageLedgerSums(sqlite, provider);
    const states = sqlite.query(`SELECT provider,version,status,covered,rules_digest,revision,published_revision
      FROM usage_ledger_state WHERE provider IN ('codex','glm','gemini') ORDER BY provider`).all() as Array<{ status: string }>;
    if (states.some(state => state.status !== "ready")) return null;
    const clocks = sqlite.query(`SELECT source,revision FROM analysis_source_revisions
      WHERE bucket='*' AND source IN (?,?) ORDER BY source`).all(usageLedgerClock("glm"), usageLedgerClock("gemini"));
    // Window/capacity/probe publications do not change these traffic sums. Ownership and project rules do.
    return analysisHash([states, clocks, loadPeriods(sqlite, ACCOUNT_PERIODS), projectRulesStamp(sqlite)]);
  } catch {
    return null;
  }
}

function homeMapStamp(homeToSubId: Map<string, string>): string {
  return JSON.stringify(
    Array.from(homeToSubId.entries()).sort(([aHome, aSub], [bHome, bSub]) =>
      aHome === bHome ? aSub.localeCompare(bSub) : aHome.localeCompare(bHome)
    )
  );
}

function buildDailyAggregate(
  sqlite: Database,
  rateCards: RateCard,
  homeToSubId: Map<string, string>,
  range: {since?:string;until?:string} = {}
): ProjectCostDailyAggregate {
  const since=range.since,last=range.until;
  const buckets = new Map<string, Map<string, Map<string, DailyBucket>>>();
  const bucketOrder: DailyBucket[] = [];
  const unpriced = new Map<string, Map<string, DailyUnpriced>>();
  const unpricedOrder: DailyUnpriced[] = [];
  const geminiByDay = new Map<string, DailyTokenCalls>();
  const tmpByDay = new Map<string, DailyTokenCalls>();
  const unassignedByDay = new Map<string, DailyTokenCalls>();
  const daysBySub = new Map<string, Set<string>>();
  const addBucket = (
    day: string,
    subId: string,
    vendor: string,
    basis: "rate-card" | "vendor",
    subject: string | null,
    usd: number,
    calls: number,
    tokens: number,
    tt: TokenTypeBreakdown,
    tu: TokenTypeBreakdown | null,
    models: Record<string, ModelSlice>
  ) => {
    if (!Number.isFinite(usd)) return;
    const key = subject ?? "";
    const subjects = buckets.get(subId) ?? new Map<string, Map<string, DailyBucket>>();
    const days = subjects.get(key) ?? new Map<string, DailyBucket>();
    const current = days.get(day);
    if (current) {
      current.api_usd += usd;
      current.calls += calls;
      current.tokens += tokens;
      addTypes(current.tt, tt);
      if (tu) {
        if (!current.tu) current.tu = zeroTypes();
        addTypes(current.tu, tu);
      }
      addModels(current.models ??= {}, models);
    } else {
      const created = { day, subId, subject: key, vendor, basis, api_usd: usd, calls, tokens, tt, tu, models };
      days.set(day, created);
      bucketOrder.push(created);
    }
    subjects.set(key, days);
    buckets.set(subId, subjects);
  };
  const addTokenCalls = (
    target: Map<string, DailyTokenCalls>,
    day: string,
    tokens: number,
    calls: number
  ) => {
    const current = target.get(day) ?? { day, tokens: 0, calls: 0 };
    current.tokens += tokens;
    current.calls += calls;
    target.set(day, current);
  };
  const markDay = (subId: string, day: string) => {
    const days = daysBySub.get(subId) ?? new Set<string>();
    days.add(day);
    daysBySub.set(subId, days);
  };
  const markUnpriced = (day: string, model: string | null, tokens: number, calls: number) => {
    if (!tokens) return;
    const key = model || "?";
    const days = unpriced.get(key) ?? new Map<string, DailyUnpriced>();
    const current = days.get(day);
    if (current) {
      current.tokens += tokens;
      current.calls += calls;
    } else {
      const created = { model: key, day, tokens, calls };
      days.set(day, created);
      unpricedOrder.push(created);
    }
    unpriced.set(key, days);
  };
  const codex = readProjectCodexRows(sqlite, rateCards, range);
  if (codex) {
    const { rows, ledger } = codex;
    const exactBuckets = new Map<string, { day:string; subId:string; subject:string|null; amount:Rational; calls:number; tokens:number;
      tt:TokenTypeBreakdown; tu:Record<keyof TokenTypeBreakdown,Rational>;
      models:Map<string,{amount:Rational;calls:number;tokens:number}> }>();
    for (const { group, account } of rows) {
      const planned = codexPlanRow(group, account);
      if (!planned) continue;
      const row = group.stored, subId = planned.subId;
      markDay(subId, row.day);
      const rowTok = Number(group.tokensReported), calls = Number(group.calls);
      const value = planned.value;
      if (value === null) {
        markUnpriced(row.day, row.model, rowTok, calls); continue;
      }
      if (row.subject === "p:_tmp") addTokenCalls(tmpByDay, row.day, rowTok, calls);
      else if (!row.subject) addTokenCalls(unassignedByDay, row.day, rowTok, calls);
      const typed = codexLedgerApiTokenAmounts(sqlite, group, ledger)!;
      const key = JSON.stringify([row.day,subId,row.subject]);
      const sum = exactBuckets.get(key) ?? { day:row.day,subId,subject:row.subject,amount:rational(0n),calls:0,tokens:0,
        tt:zeroTypes(),tu:{in_uncached:rational(0n),cache_read:rational(0n),cache_write:rational(0n),out:rational(0n)},models:new Map() };
      sum.amount = add(sum.amount,value); sum.calls += calls; sum.tokens += rowTok;
      const modelSum = sum.models.get(row.model || "?") ?? { amount:rational(0n),calls:0,tokens:0 };
      modelSum.amount = add(modelSum.amount,value); modelSum.calls += calls; modelSum.tokens += rowTok;
      sum.models.set(row.model || "?",modelSum);
      const counts = { in_uncached:Number(group.tokens.in_uncached),cache_read:Number(group.tokens.in_cache_read),
        cache_write:Number(group.tokens.in_cache_write_unknown),out:Number(group.tokens.out_total) };
      addTypes(sum.tt,counts);
      for (const part of ["in_uncached","cache_read","cache_write","out"] as const) sum.tu[part] = add(sum.tu[part],typed[part]);
      exactBuckets.set(key,sum);
    }
    for (const sum of exactBuckets.values()) addBucket(sum.day,sum.subId,"codex","rate-card",sum.subject,
      ledgerPresentationNumber(sum.amount),sum.calls,sum.tokens,sum.tt,
      {in_uncached:ledgerPresentationNumber(sum.tu.in_uncached),cache_read:ledgerPresentationNumber(sum.tu.cache_read),
        cache_write:ledgerPresentationNumber(sum.tu.cache_write),out:ledgerPresentationNumber(sum.tu.out)},
      Object.fromEntries([...sum.models].map(([model,part])=>[model,{tokens:part.tokens,calls:part.calls,api_usd:ledgerPresentationNumber(part.amount)}])));
  }
  // Claude's traffic comes from the shared, account-scoped fact index and the registered
  // valuations in claude-project-usage, so duplicate copies of one call are never priced twice.
  // OpenCode traffic outside the GLM plan and Gemini traffic stay visible as unpriced or unattributed evidence.
  const sums = readLedgerSums(sqlite, { vendors: ["opencode", "gemini"], grain: "day",
    ...(since ? { since } : {}), ...(last ? { until: last } : {}) });
  const otherProviders = new Map<string, { day: string; model: string | null; tokens: number; calls: number }>();
  for (const row of sums) {
    if (row.vendor === "gemini") { addTokenCalls(geminiByDay, row.day, sumTokens(row).gross, row.calls); continue; }
    // Z.ai rows are canonical subscription facts (provider project usage); this keeps only other providers' evidence.
    if (row.rate_vendor === null || row.rate_vendor === "zai") continue;
    const key = JSON.stringify([row.day, row.model]), group = otherProviders.get(key) ?? { day: row.day, model: row.model, tokens: 0, calls: 0 };
    group.tokens += sumTokens(row).gross; group.calls += row.calls;
    otherProviders.set(key, group);
  }
  for (const group of otherProviders.values()) {
    markDay("opencode", group.day);
    markUnpriced(group.day, group.model, group.tokens, group.calls);
  }
  return {
    buckets,
    bucketOrder,
    unpriced,
    unpricedOrder,
    geminiByDay,
    tmpByDay,
    unassignedByDay,
    daysBySub,
  };
}

export function dailyAggregate(
  sqlite: Database,
  rateCards: RateCard,
  homeToSubId: Map<string, string>,
  range: { since?: string; until?: string } = {}
): ProjectCostDailyAggregate {
  const hasCodex = !!readCodexLedgerState(sqlite) || tableExists(sqlite,"events") && !!sqlite.query("SELECT 1 FROM events LIMIT 1").get();
  const ledger = hasCodex ? codexLedgerReadContext(rateCards) : undefined;
  const nativeRange={...range,dependencyBases:['api_equivalent_usd'] as const};
  if (ledger) { const pending=codexLedgerPendingReason(sqlite,{...ledger,range:nativeRange}); if(pending) throw new SubscriptionFactsPending(`Codex project costs are awaiting background preparation (${pending})`,"codex"); }
  // Worker messages recreate the home map. Its content is a dependency; its object identity is not.
  // Writer transactions must never leave an uncommitted result here after rollback.
  if (contextReadScope(sqlite) || !isReadonlyConnection(sqlite)) return buildDailyAggregate(sqlite, rateCards, homeToSubId, range);
  const revision = indexStamp(sqlite);
  if (revision === null) return buildDailyAggregate(sqlite, rateCards, homeToSubId, range);
  const key = analysisHash([revision,homeMapStamp(homeToSubId),range,ratesWithoutAuthoritativeCodexPolicy(rateCards),
    ledger?codexLedgerReadStamp(sqlite,ledger,nativeRange):null]);
  const hit = projectCostMemo.get(sqlite);
  if (hit?.key === key) return hit.value;
  const value = buildDailyAggregate(sqlite, rateCards, homeToSubId, range);
  projectCostMemo.set(sqlite, { key, value });
  return value;
}
