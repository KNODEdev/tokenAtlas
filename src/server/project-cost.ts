import { withContextPreview } from "./codex-context-preview";
import type { Database } from "../db/sqlite";
import type { RateCard } from "./pricing";
import type { PlansCatalog } from "./plans-catalog";
import type { EraIndex } from "./eras";
import { loadAccountResolver } from "./account-resolver";
import { storedProjectUsage } from "./stored-project-usage";
import type { ProjectUsage } from "./stored-project-usage";
import { hasProjectPlan } from "../db/project-plan";
import { historicalProjectWeeks } from "./project-plan";
import { buildSubscriptionCapacities, computeSeatTime, computeEquivalentsAndProvenance, round4 } from "./capacity-equivalents";
import { codexSubjectNormalized } from "./codex-accounting";
import { planLabelOf } from "./plans";
import { round2 } from "./pricing";
import type { ProjectCostResponse, Bucket, ModelSlice, TokenTypeBreakdown, SubscriptionSpend, SubjectCost, ProjectCostCoverage } from "./project-cost-contracts";
import { dailyAggregate } from "./project-cost-daily";
import { addModels, zeroTypes, addTypes, daySelected, daysBetween, roundTypes, aggregateBilled } from "./project-cost-values";
import type { AccountEvidence, ConflictEvidence } from "./project-cost-evidence";
import { subscriptionSpans, planPricingInputs, subscriptionPlanPricing } from "./project-cost-plan-pricing";
import { tableExists } from "./project-cost-schema";
import { accountEvidenceNote, conflictNote } from "./project-cost-evidence";
import { assertCodexProjectReady } from "./project-cost-codex";
import { planGapReason, type BillingUnavailableReason } from "../shared/plan-price-coverage";
import { allocatePlanPeriods, readPlanPeriodsUsage } from "./project-cost-periods";
import type { ProjectPlanPeriod } from "../shared/project-plan-periods";
import { planCostOf } from "./plans";

interface ProjectCostInputs {
  claude?: ProjectUsage;
  otherProviders?: ProjectUsage[];
}

function computeProjectCost(
  sqlite: Database,
  rateCards: RateCard,
  homeToSubId: Map<string, string>,
  opts: { since?: string; until?: string; plansCatalog?: PlansCatalog; eras?: EraIndex; contextPreview?: boolean;
    declarations?: readonly import("./account-resolver").IdentityDeclaration[] },
  inputs: ProjectCostInputs
): ProjectCostResponse {
  const aggregate = dailyAggregate(sqlite, rateCards, homeToSubId, opts);
  // Stored day sums per verified account and subject (stored-project-usage.ts). A ledger still being prepared
  // raises SubscriptionFactsPending here: the background producer prepares it, this read never reprices.
  const resolver = loadAccountResolver(sqlite, opts.declarations ?? []);
  const claude = inputs.claude ??= storedProjectUsage(sqlite, "claude", rateCards, { since: opts.since, until: opts.until, resolver });
  const providerUsage = inputs.otherProviders ??= (["grok", "glm"] as const).map((provider) =>
    storedProjectUsage(sqlite, provider, rateCards, { since: opts.since, until: opts.until, resolver }));
  const bySub = new Map<string, Map<string, Bucket>>();
  const subMeta = new Map<string, { vendor: string; basis: "rate-card" | "vendor" }>();
  const unpricedModels = new Map<string, number>();
  let unpricedTokens = 0;
  let unpricedCalls = 0;
  let tmpTokens = 0;
  let unassignedTokens = 0;
  let unassignedCalls = 0;
  let geminiTokens = 0;
  let geminiCalls = 0;
  /** Subscription id -> why its bill cannot be allocated across its subjects. */
  const unallocatable = new Map<string, string>();
  for (const account of aggregate.incompleteSubscriptions ?? []) unallocatable.set(account, "missing_rate");
  const add = (
    subId: string,
    vendor: string,
    basis: "rate-card" | "vendor",
    subject: string | null,
    usd: number,
    calls: number,
    tokens: number,
    tt: TokenTypeBreakdown,
    tu: TokenTypeBreakdown | null,
    models: Record<string, ModelSlice> | undefined
  ) => {
    if (!Number.isFinite(usd)) return;
    if (!subMeta.has(subId)) subMeta.set(subId, { vendor, basis });
    const inner = bySub.get(subId) ?? new Map<string, Bucket>();
    const key = subject ?? "";
    const cur = inner.get(key) ?? { api_usd: 0, calls: 0, tokens: 0, tt: zeroTypes(), tu: null };
    cur.api_usd += usd;
    cur.calls += calls;
    cur.tokens += tokens;
    addTypes(cur.tt, tt);
    if (tu) {
      if (!cur.tu) cur.tu = zeroTypes();
      addTypes(cur.tu, tu);
    }
    addModels(cur.models ??= {}, models);
    inner.set(key, cur);
    bySub.set(subId, inner);
  };
  const markUnpriced = (model: string, tokens: number, calls: number) => {
    if (!tokens) return;
    unpricedModels.set(model, (unpricedModels.get(model) || 0) + tokens);
    unpricedTokens += tokens;
    unpricedCalls += calls;
  };
  for (const bucket of aggregate.bucketOrder) {
    if (!daySelected(bucket.day, opts)) continue;
    add(
      bucket.subId,
      bucket.vendor,
      bucket.basis,
      bucket.subject,
      bucket.api_usd,
      bucket.calls,
      bucket.tokens,
      bucket.tt,
      bucket.tu,
      bucket.models
    );
  }
  for (const item of aggregate.unpricedOrder) {
    if (daySelected(item.day, opts)) markUnpriced(item.model, item.tokens, item.calls);
  }
  // Each verified account is its own subscription; nothing is filed under a shared
  // 'claude' bucket, and its already day-selected sums are added, not recomputed.
  for (const group of claude.groups) {
    add(group.account, "claude", "rate-card", group.subject, group.api_usd, group.calls, group.tokens,
      group.tokens_by_type, group.api_usd_by_type, group.models);
    if (group.subject === "p:_tmp") tmpTokens += group.tokens;
    else if (!group.subject) {
      unassignedTokens += group.tokens;
      unassignedCalls += group.calls;
    }
  }
  for (const item of claude.unpriced) {
    // A call priced at nothing is still a call: zero-token evidence stays visible.
    unpricedModels.set(item.model, (unpricedModels.get(item.model) || 0) + item.tokens);
    unpricedTokens += item.tokens;
    unpricedCalls += item.calls;
    // The account cannot account for all of its own traffic, so its known fee cannot be
    // split over the priced part as if that part were the whole subscription.
    unallocatable.set(item.account, item.reason);
  }
  // Excluded conflicting calls are the same problem seen from the other side: part of this
  // account's traffic is missing from the api_usd weights entirely, so the weights do not
  // describe the whole subscription. The existing mechanism withholds the split; the fee
  // itself and every known amount stay published. Their tokens and calls are added NOWHERE:
  // they are unknown, and the copies disagree about which project made them.
  for (const item of claude.conflicts) {
    const reason = `conflicting_facts:${item.identities}`;
    const known = unallocatable.get(item.account);
    unallocatable.set(item.account, known ? `${known}, ${reason}` : reason);
  }
  for (const usage of providerUsage) {
    for (const account of usage.accounts) {
      if (!bySub.has(account)) bySub.set(account, new Map());
      if (!subMeta.has(account)) subMeta.set(account, { vendor: usage.provider, basis: "rate-card" });
    }
    for (const group of usage.groups) {
      add(group.account, usage.provider, "rate-card", group.subject, group.api_usd, group.calls, group.tokens,
        group.tokens_by_type, group.api_usd_by_type, group.models);
      if (group.subject === "p:_tmp") tmpTokens += group.tokens;
      else if (!group.subject) {
        unassignedTokens += group.tokens;
        unassignedCalls += group.calls;
      }
    }
    for (const item of usage.unpriced) {
      unpricedModels.set(item.model, (unpricedModels.get(item.model) || 0) + item.tokens);
      unpricedTokens += item.tokens;
      unpricedCalls += item.calls;
      const known = unallocatable.get(item.account);
      unallocatable.set(item.account, known ? `${known}, ${item.reason}` : item.reason);
    }
    for (const item of usage.conflicts) {
      const reason = `conflicting_facts:${item.identities}`;
      const known = unallocatable.get(item.account);
      unallocatable.set(item.account, known ? `${known}, ${reason}` : reason);
    }
  }
  const incompleteAccounts = new Set<string>([
    ...claude.unpriced.map((item) => item.account),
    ...claude.conflicts.map((item) => item.account),
    ...providerUsage.flatMap((usage) => usage.unpriced.map((item) => item.account)),
    ...providerUsage.flatMap((usage) => usage.conflicts.map((item) => item.account)),
  ]);
  const accountEvidence: AccountEvidence[] = [
    ...claude.evidence.map((item) => ({ vendor: "claude", ...item })),
    ...providerUsage.flatMap((usage) => usage.evidence.map((item) => ({ vendor: usage.provider, ...item }))),
  ];
  const evidenceTokens = accountEvidence.reduce((acc, item) => acc + item.tokens, 0);
  const evidenceCalls = accountEvidence.reduce((acc, item) => acc + item.calls, 0);
  unassignedTokens += evidenceTokens;
  unassignedCalls += evidenceCalls;
  for (const item of aggregate.tmpByDay.values()) {
    if (daySelected(item.day, opts)) tmpTokens += item.tokens;
  }
  for (const item of aggregate.unassignedByDay.values()) {
    if (!daySelected(item.day, opts)) continue;
    unassignedTokens += item.tokens;
    unassignedCalls += item.calls;
  }
  for (const item of aggregate.geminiByDay.values()) {
    if (!daySelected(item.day, opts)) continue;
    geminiTokens += item.tokens;
    geminiCalls += item.calls;
  }
  const span = subscriptionSpans(aggregate.daysBySub, [claude, ...providerUsage], opts);
  const selectedPeriod = resolveSelectedPeriod(opts, span);
  const storedWeeks=hasProjectPlan(sqlite)?historicalProjectWeeks(sqlite,selectedPeriod):null;
  const capacities = buildSubscriptionCapacities(sqlite, rateCards, homeToSubId, {
    period: selectedPeriod,
    eras: opts.eras,
    // The shared Claude estimate belongs to one account and one exact period; the
    // accounts this report actually used are the only ones it may be built for.
    claudeAccounts: claude.accounts,
    // Only the accounts whose traffic this report accepted are read back below, so no
    // unrelated vendor is measured here - and an empty report measures nothing at all.
    subscriptions: [...bySub.keys()],
  });
  const normalized = new Map<string, number | null>();
  if (selectedPeriod.since && selectedPeriod.until && tableExists(sqlite, "events")) {
    for (const row of codexSubjectNormalized(sqlite, rateCards, { since: selectedPeriod.since, until: selectedPeriod.until }, homeToSubId)) {
      if (!row.account) continue;
      normalized.set(JSON.stringify([row.account, row.subject ?? ""]), row.normalized_usd.value);
      const prev = normalized.get(row.account);
      normalized.set(row.account, prev === null || row.normalized_usd.value === null ? null : (prev ?? 0) + row.normalized_usd.value);
    }
  }
  // Capacity equivalents divide by a Standard capacity, so their numerator is the
  // Standard value of exactly this account's and subject's traffic. Actual-mode
  // dollars (Fast included) stay in api_usd and are never used for that division.
  for (const group of claude.groups) {
    normalized.set(JSON.stringify([group.account, group.subject ?? ""]), group.standard_usd);
    const prev = normalized.get(group.account);
    normalized.set(group.account,
      prev === null || group.standard_usd === null ? null : (prev ?? 0) + group.standard_usd);
  }
  for (const group of providerUsage.flatMap((usage) => usage.groups)) {
    normalized.set(JSON.stringify([group.account, group.subject ?? ""]), group.api_usd);
    normalized.set(group.account, (normalized.get(group.account) ?? 0) + group.api_usd);
  }
  const subscriptions: SubscriptionSpend[] = [];
  const subjects = new Map<string, SubjectCost>();
  let unassignedApi = 0;
  let totalPaid = 0;
  let totalApi = 0;
  const subTotals = new Map<string, { api_usd: number; paid_usd: number | null }>();
  const monthlyBySub = new Map<string, number | null>();
  const unavailableBySub = new Map<string, BillingUnavailableReason[]>();
  const periodsBySub = new Map<string, Map<string, ProjectPlanPeriod[]>>();
  // Plan history comes from the account periods, each plan priced by its Plans catalog version.
  const pricingInputs = planPricingInputs(sqlite, opts.plansCatalog);
  for (const [subId, inner] of bySub) {
    const meta = subMeta.get(subId) ?? { vendor: subId, basis: "rate-card" as const };
    const subCap = capacities.get(subId);
    const known = span.get(subId) ?? null;
    const s = known ?? { first: null, last: null };
    const days = known ? daysBetween(known.first, known.last) + 1 : 0;
    const { declared: declaredMonthly, stretches, periods, gaps, paid, monthly } =
      subscriptionPlanPricing(sqlite, rateCards, pricingInputs, { id: subId, vendor: meta.vendor }, known, resolver);
    const sharedUsage = [claude, ...providerUsage].find(usage => usage.provider === meta.vendor);
    const periodRows = meta.vendor === "codex" ? aggregate.periodRows?.get(subId)
      : sharedUsage?.conflicts.some(conflict => conflict.account === subId) ? undefined : sharedUsage?.period_rows?.get(subId);
    const periodUsage = stretches.length > 1 ? readPlanPeriodsUsage(sqlite, rateCards, resolver, { id: subId, vendor: meta.vendor }, stretches, periodRows) : [];
    periodsBySub.set(subId, allocatePlanPeriods(stretches, [...new Set([...inner.keys(), ""])], (_, index) =>
      stretches.length === 1
        ? { groups: inner, incomplete: unallocatable.has(subId) }
        : periodUsage[index]!));
    monthlyBySub.set(subId, monthly);
    const reasons = new Set(gaps.map(planGapReason));
    if (periods.length === 0) reasons.add("no_pricing_span");
    if (unallocatable.has(subId)) reasons.add("usage_incomplete");
    unavailableBySub.set(subId, [...reasons]);
    let subApi = 0;
    let attributed = 0;
    for (const [key, b] of inner) {
      subApi += b.api_usd;
      if (key !== "") attributed += b.api_usd;
    }
    totalApi += subApi;
    totalPaid += paid ?? planCostOf(periods.filter(period => period.usd_per_month !== null)) ?? 0;
    subTotals.set(subId, { api_usd: subApi, paid_usd: paid });
    for (const [key, b] of inner) {
      if (key === "") {
        unassignedApi += b.api_usd;
        continue;
      }
      const kind = key.startsWith("p:") ? "project" : "repo";
      const row =
        subjects.get(key) ??
        ({
          subject: key,
          kind,
          id: key.slice(2),
          tokens: 0,
          api_usd: 0,
          billed_usd: 0,
          billed_complete: true,
          share_of_priced_spend_pct: null,
          priced_spend_usd: 0,
          calls: 0,
          by_sub: {},
          subscriptions: {},
        } as SubjectCost);
      row.tokens += b.tokens;
      row.api_usd += b.api_usd;
      row.calls += b.calls;
      row.by_sub[subId] = (row.by_sub[subId] ?? 0) + b.api_usd;
      addModels(row.models ??= {}, b.models);
      subjects.set(key, row);
    }
    const subSeat = computeSeatTime(paid ?? 0, monthly);
    const { provenance: subProv } = computeEquivalentsAndProvenance(subApi, subCap, selectedPeriod, normalized.get(subId));
    subscriptions.push({
      id: subId,
      vendor: meta.vendor,
      // Canonical fact consumers can prove per-account price coverage.
      ...(["claude", "grok", "glm"].includes(meta.vendor)
        ? { api_complete: !incompleteAccounts.has(subId) }
        : {}),
      plan: planLabelOf(periods),
      usd_per_month: monthly,
      usd_per_month_declared: declaredMonthly,
      plan_periods: periods,
      price_gaps: gaps,
      api_usd: round2(subApi),
      attributed_usd: round2(attributed),
      first_day: s.first,
      last_day: s.last,
      days,
      paid_usd: paid,
      basis: meta.basis,
      seat_time: subSeat,
      capacity: subCap
        ? {
            usd_per_point: subCap.usd_per_point,
            weekly_window_value_usd: subCap.weekly_window_value_usd,
            session_window_value_usd: subCap.session_window_value_usd,
            window_hours: subCap.window_hours,
            session_hours: subCap.session_hours,
          }
        : undefined,
      provenance: subProv,
    });
  }
  for (const row of subjects.values()) {
    row.subscriptions = {};
  }
  let unassignedBilledAllocated = 0;
  let unassignedBilledComplete = true;
  for (const [subId, inner] of bySub) {
    const subTot = subTotals.get(subId) ?? { api_usd: 0, paid_usd: null };
    const subCap = capacities.get(subId);
    const monthly = monthlyBySub.get(subId) ?? null;
    // Missing prices or traffic withhold only the affected dated allocations.
    const dated = periodsBySub.get(subId);
    const unassignedPeriods = dated?.get("") ?? [];
    if (!inner.has("")) {
      const unassigned = aggregateBilled(unassignedPeriods.map(period => period.billed_usd));
      unassignedBilledAllocated += unassigned.billed_usd ?? 0;
      if (!unassigned.billed_complete) unassignedBilledComplete = false;
    }
    inner.forEach((b, key) => {
      const planPeriods = dated?.get(key) ?? [];
      const bill = planPeriods.length ? aggregateBilled(planPeriods.map(period => period.billed_usd))
        : { billed_usd: dated?.get(key)?.length ? 0 : null, billed_complete: !!dated?.get(key)?.length };
      const billed = bill.billed_usd;
      const share = subTot.api_usd > 0 ? b.api_usd / subTot.api_usd : 0;
      if (key === "") {
        unassignedBilledAllocated += billed ?? 0;
        if (!bill.billed_complete) unassignedBilledComplete = false;
        return;
      }
      if (b.api_usd <= 0 && billed === 0 && b.calls === 0) return;
      const row = subjects.get(key);
      if (!row) return;
      const { equivalents, provenance } = computeEquivalentsAndProvenance(
        b.api_usd,
        subCap,
        selectedPeriod,
        normalized.get(JSON.stringify([subId, key]))
      );
      if(storedWeeks && (subCap?.vendor==='claude'||subCap?.vendor==='codex')){
        const weekly=storedWeeks.get(JSON.stringify([subId,key]));
        equivalents.weekly_cycles=weekly==null?{value:null,absent:'period_uncovered'}:{value:weekly,absent:null};
      }
      const fullUse =
        equivalents.monthly_subscriptions.absent == null && monthly != null
          ? round2(equivalents.monthly_subscriptions.value * monthly)
          : null;
      row.subscriptions[subId] = {
        tokens: b.tokens,
        api_usd: round2(b.api_usd),
        tokens_by_type: b.tt,
        usd_by_type: b.tu ? roundTypes(b.tu, 4) : null,
        billed_usd: billed,
        billed_complete: bill.billed_complete,
        plan_periods: planPeriods,
        billing_unavailable_reasons: bill.billed_complete ? [] : planPeriods.length
          ? [...new Set(planPeriods.flatMap(period => period.billing_unavailable_reasons))] : unavailableBySub.get(subId) ?? [],
        share: round4(share),
        calls: b.calls,
        seat_time: billed == null ? null : computeSeatTime(billed, monthly),
        equivalents,
        cost_at_full_use_usd: fullUse,
        provenance,
      };
    });
  }
  let billedRounded = 0;
  const pricedSpend = round2(totalPaid);
  for (const row of subjects.values()) {
    const billedAgg = aggregateBilled(Object.values(row.subscriptions).map((s) => s.billed_usd));
    row.api_usd = round2(row.api_usd);
    row.billed_usd = billedAgg.billed_usd;
    row.billed_complete = billedAgg.billed_complete;
    if (Object.values(row.subscriptions).some(slice => slice.billed_complete === false)) row.billed_complete = false;
    row.priced_spend_usd = pricedSpend;
    row.share_of_priced_spend_pct =
      row.billed_usd == null || pricedSpend <= 0 ? null : round4((row.billed_usd / pricedSpend) * 100);
    billedRounded += row.billed_usd ?? 0;
    for (const k of Object.keys(row.by_sub)) row.by_sub[k] = round2(row.by_sub[k] ?? 0);
    for (const slice of Object.values(row.models ?? {})) slice.api_usd = round2(slice.api_usd);
  }
  billedRounded = round2(billedRounded);
  subscriptions.sort((a, b) => b.api_usd - a.api_usd);
  const list = Array.from(subjects.values()).sort((a, b) => {
    const ba = a.billed_usd;
    const bb = b.billed_usd;
    if (ba == null && bb == null) return b.api_usd - a.api_usd;
    if (ba == null) return 1;
    if (bb == null) return -1;
    return bb - ba || b.api_usd - a.api_usd;
  });
  const priceless = subscriptions.filter((s) => s.paid_usd == null).map((s) => s.id);
  const notes: string[] = [
    "billed_usd to suma udzialow w koszcie kazdego datowanego okresu planu; udzial ruchu i cena dotycza tego samego okresu. billed_complete=false oznacza sume znanych czesci. api_usd to ekwiwalent cennika API.",
    "Mianownikiem udzialu jest CALY ruch subskrypcji, wiec udzialy projektow nie sumuja sie do rachunku. Reszta stoi w unassigned_billed_usd.",
    "gemini nie jest reprezentowany: gemini_events wiezie nazwe workspace'u, nie katalog roboczy, wiec zadne zdarzenie nie ma przypisania do projektu.",
    "Koszt cyklu jest proporcjonalny do jego rzeczywistego czasu; poza cyklami obowiazuje datowana cena planu * dni / 30.44.",
  ];
  const withHistory = subscriptions.filter((s) => s.plan_periods.some((p) => p.source !== "rate-card"));
  if (withHistory.length > 0) {
    notes.push(
      `Plan z okresow kont (cena z katalogu Planow) obowiazuje dla: ${withHistory
        .map((s) => `${s.id} (${s.plan ?? "?"})`)
        .join(", ")}. Luki historii pozostaja nieznane; rate-cards.json jest uzywany tylko bez zadnej datowanej historii konta.`
    );
  }
  if (priceless.length > 0) {
    notes.push(
      `Bez pelnej ceny planu: ${priceless.join(", ")}. Znane okresy pozostaja w koszcie; nieznane czesci sa jawne w plan_periods.`
    );
  }
  const tmpRow = subjects.get("p:_tmp");
  const tmpApi = tmpRow ? round2(tmpRow.api_usd) : 0;
  const tmpBilled = tmpRow?.billed_usd != null ? tmpRow.billed_usd : 0;
  const unassignedApiRounded = round2(unassignedApi);
  const unassignedBilled = round2(unassignedBilledAllocated);
  const covTotalsApi = round2(tmpApi + unassignedApiRounded);
  const covTotalsBilled = round2(tmpBilled + unassignedBilled);
  const coverage: ProjectCostCoverage = {
    tmp_bucket: {
      tokens: tmpTokens,
      calls: tmpRow?.calls ?? 0,
      api_usd: tmpApi,
      billed_usd: tmpBilled,
      note: "worek _TMP (szum/scratch nieprzypisany do wlasciwego projektu)",
    },
    unassigned: {
      tokens: unassignedTokens,
      calls: unassignedCalls,
      // Once rows nobody can own are in this counter, its money is no longer complete.
      // The known part stays in totals.unassigned_api_usd / unassigned_billed_usd.
      api_usd: accountEvidence.length > 0 ? null : unassignedApiRounded,
      billed_usd: accountEvidence.length > 0 || !unassignedBilledComplete ? null : unassignedBilled,
      note: accountEvidence.length > 0
        ? `ruch bez przypisania do projektu ani repo oraz wiersze bez potwierdzonego konta. ${accountEvidenceNote(accountEvidence)} Znana czesc kwot stoi w totals.unassigned_api_usd.`
        : "ruch bez przypisania do projektu ani repo",
    },
    unpriced: {
      tokens: unpricedTokens,
      calls: unpricedCalls,
      models: Object.fromEntries(unpricedModels),
      api_usd: null,
      billed_usd: null,
      note: "modele bez stawek w cenniku (wylaczone z api_usd)",
    },
    unattributable: {
      vendor: "gemini",
      tokens: geminiTokens,
      calls: geminiCalls,
      api_usd: null,
      billed_usd: null,
      note: "Antigravity/gemini wozi nazwe workspace'u, brak katalogu roboczego (nieprzypisywalne)",
    },
    totals: {
      // Unverified rows are already inside unassignedTokens/Calls; counted once.
      tokens: tmpTokens + unassignedTokens + unpricedTokens + geminiTokens,
      calls: (tmpRow?.calls ?? 0) + unassignedCalls + unpricedCalls + geminiCalls,
      // Subtotals of the dollars that are known; the missing ones are named per item.
      api_usd: covTotalsApi,
      billed_usd: covTotalsBilled,
    },
  };
  // "No rate in the price list" is not the only way a price can be missing.
  const claudeModeGaps = claude.unpriced.filter((item) => item.reason !== "missing_rate");
  if (claudeModeGaps.length > 0) {
    notes.push(
      `Claude bez wyceny mimo obecnego modelu: ${claudeModeGaps
        .map((item) => `${item.model} (${item.reason}, ${item.tokens} tok., ${item.calls} wyw.)`)
        .join(", ")}. Nieznanego trybu nie zamieniamy na Standard ani Fast.`
    );
  }
  if (unallocatable.size > 0) {
    notes.push(
      `Rachunek nie jest dzielony na projekty dla: ${[...unallocatable]
        .map(([id, reason]) => `${id} (${reason})`)
        .join(", ")}. Czesc ruchu tych kont nie ma znanej ceny actual${claude.conflicts.length > 0
          ? " albo zostala wykluczona jako sprzeczne kopie tego samego wywolania" : ""
        }, wiec udzialy api_usd nie opisuja calego abonamentu; paid_usd i api_usd pozostaja podane.`
    );
  }
  // Rows without a verified account keep their observed tokens and calls, with no money
  // and a named reason. This item is a named SUBSET of coverage.unassigned, where the
  // same tokens and calls are already counted once; it is not their only home.
  if (accountEvidence.length > 0) {
    const vendors = [...new Set(accountEvidence.map((item) => item.vendor))];
    coverage.unverified_account = {
      vendor: vendors.join(","),
      tokens: evidenceTokens,
      calls: evidenceCalls,
      api_usd: null,
      billed_usd: null,
      reasons: [...new Set(accountEvidence.map((item) => item.reason))],
      note: `${accountEvidenceNote(accountEvidence)} Podzbior coverage.unassigned.`,
    };
    notes.push(accountEvidenceNote(accountEvidence));
  }
  const allConflicts: ConflictEvidence[] = [
    ...claude.conflicts.map((item) => ({ provider: "claude", ...item })),
    ...providerUsage.flatMap((usage) => usage.conflicts.map((item) => ({ provider: usage.provider, ...item }))),
  ];
  if (allConflicts.length > 0) {
    const identities = allConflicts.reduce((acc, item) => acc + item.identities, 0);
    const vendors = [...new Set(allConflicts.map((item) => item.provider))];
    coverage.conflicting_usage = {
      vendor: vendors.join(","),
      identities,
      accounts: allConflicts.map((item) => ({
        ...(vendors.length > 1 ? { provider: item.provider } : {}),
        account: item.account,
        identities: item.identities,
      })),
      tokens: null,
      api_usd: null,
      billed_usd: null,
      note: conflictNote(allConflicts),
    };
    notes.push(conflictNote(allConflicts));
  }
  const nonTmpSubjects = Array.from(subjects.values()).filter((s) => s.subject !== "p:_tmp");
  const nonTmpTokens = nonTmpSubjects.reduce((acc, s) => acc + s.tokens, 0);
  const nonTmpCalls = nonTmpSubjects.reduce((acc, s) => acc + s.calls, 0);
  const totalPeriodTokens = nonTmpTokens + coverage.totals.tokens;
  const totalPeriodCalls = nonTmpCalls + coverage.totals.calls;
  // Subject amounts are rounded for display; sum the original account amounts once.
  const totalPeriodApi = round2(totalApi);
  // A new flag may never present an already published gap as complete: unpriced models of any
  // vendor, traffic no vendor can attribute, rows without a verified account and Claude calls
  // excluded as conflicting copies all leave totals.api_usd a subtotal of the known part.
  const apiComplete = unpricedTokens === 0 && unpricedCalls === 0
    && geminiTokens === 0 && geminiCalls === 0
    && coverage.unverified_account === undefined && coverage.conflicting_usage === undefined;
  return {
    since: opts.since ?? null,
    until: opts.until ?? null,
    subscriptions,
    subjects: list,
    totals: {
      tokens: totalPeriodTokens,
      calls: totalPeriodCalls,
      api_usd: totalPeriodApi,
      paid_usd: round2(totalPaid),
      billed_usd: billedRounded,
      unassigned_billed_usd: unassignedBilled,
      unassigned_api_usd: unassignedApiRounded,
      non_tmp_tokens: nonTmpTokens,
      api_complete: apiComplete,
    },
    unpriced: { tokens: unpricedTokens, models: Object.fromEntries(unpricedModels) },
    coverage,
    notes,
  };
}

function resolveSelectedPeriod(
  opts: { since?: string; until?: string },
  span: Map<string, { first: string | null; last: string | null }>
): { since: string | null; until: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const s of span.values()) {
    if (s.first && (!first || s.first < first)) first = s.first;
    if (s.last && (!last || s.last > last)) last = s.last;
  }
  return {
    since: opts.since ?? first,
    until: opts.until ?? last,
  };
}

export type ProjectCostOptions = Pick<Parameters<typeof computeProjectCost>[3], "since" | "until">;

type ProjectCostArgs = [sqlite: Database, rateCards: RateCard, homeToSubId: Map<string, string>,
  options: Parameters<typeof computeProjectCost>[3]];
export function buildProjectCost(...args: ProjectCostArgs):ProjectCostResponse {
  const [sqlite, rates, , options] = args;
  assertCodexProjectReady(sqlite, rates, options);
  const { contextPreview = false, ...storedOptions } = options;
  args[3] = storedOptions;
  // Only Codex money changes in this paired snapshot. Other providers keep the same prepared inputs.
  const inputs: ProjectCostInputs = {};
  const result = withContextPreview(sqlite, () => computeProjectCost(...args, inputs), contextPreview);
  if (result.context_preview) {
    // Capacity observations and token-bucket dollar splits need their own prepared context measures (plan phases 3–4).
    const original = new Map(result.subjects.map(subject => [subject.subject, subject]));
    for (const subject of result.context_preview.subjects) {
      const before = original.get(subject.subject);
      if (!before) continue;
      for (const [account, slice] of Object.entries(subject.subscriptions)) {
        const previous = before.subscriptions[account];
        if (previous) Object.assign(slice, { equivalents: previous.equivalents, seat_time: previous.seat_time,
          cost_at_full_use_usd: previous.cost_at_full_use_usd, usd_by_type: previous.usd_by_type });
      }
    }
  }
  return result;
}

export type { TokenTypeBreakdown, SubjectSubscriptionSlice, SubjectCost, SubscriptionSpend, CoverageItem, ProjectCostCoverage, ProjectCostResponse } from "./project-cost-contracts";
export { planPricingInputs, pricedPlanIndex, pricedCycleIndex, subscriptionPlanPricing, subscriptionFirstCallOn, projectPlanSubscriptions } from "./project-cost-plan-pricing";
export type { PlanPricingInputs, SubscriptionPlanPricing, PlanPricedSubscription } from "./project-cost-plan-pricing";
export { projectCapacityConfiguration } from "./project-cost-configuration";
