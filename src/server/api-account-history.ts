import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import { ApiCodexMoney, apiCodexLedgerIsPending, ExactParts, apiCodexOwnedDaySums, roundApiCodexUsd } from "./api-codex-ledger";
import { rational, add as addExact, decimal } from "../db/price-ledger-exact";
import { preparingDataResponse } from "./preparing-response";
import { accountHistoryBucket, readClaudeAccountHistory } from "./claude-account-history";
import { SubscriptionUsageUnavailable, subscriptionUsageUnavailableResponse } from "./subscription-usage";
import { readLedgerUsage } from "./ledger-sums";
import type { AppContext } from "./app-context-types";
import { parseCommonDateParams } from "./api-request-params";
import { UnpricedCollector, round2 } from "./api-report-values";
import { accountResolverOf, distinctSubscriptions } from "./account-scope";

interface AccountHistorySlice {
  tokens: number;
  calls: number;
  usd: number | null;
  priced_usd?: number;
  api_quality?: { complete: false; conflicts: number; unpriced_events: number };
}

interface AccountHistoryPoint extends AccountHistorySlice {
  bucket: string;
  split: Record<string, AccountHistorySlice>;
}

interface AccountHistoryRow extends AccountHistorySlice {
  id: string;
  vendor: string;
  first_ts: string | null;
  last_ts: string | null;
}

export function handleAccountHistory(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleAccountHistoryBody(ctx, url, json), contextRequested(url));
}
function handleAccountHistoryBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) return json({ error: dateParams.error }, { status: 400 });
  const { since, until } = dateParams;
  const group = url.searchParams.get("group") || "week";
  if (!["day", "week", "month"].includes(group)) {
    return json(
      { error: `Invalid 'group' parameter: '${group}'. Allowed: day, week, month.` },
      { status: 400 }
    );
  }
  const unpriced = new UnpricedCollector();
  const points = new Map<string, AccountHistoryPoint>();
  const perAccount = new Map<string, AccountHistoryRow>();
  const codexAmounts = new ApiCodexMoney();
  let legacyTotalAmount = rational(0n);
  const merge = (target: AccountHistorySlice, source: { tokens: number; calls: number; usd: number },
    quality?: { conflicts: number; unpriced_events: number }) => {
    codexAmounts.addLegacy(target,source.usd);
    target.tokens += source.tokens;
    target.calls += source.calls;
    const priorPriced = target.priced_usd ?? target.usd ?? 0;
    if (target.usd === null || quality && (quality.conflicts > 0 || quality.unpriced_events > 0)) {
      target.usd = null;
      target.priced_usd = priorPriced + source.usd;
      target.api_quality = { complete: false,
        conflicts: (target.api_quality?.conflicts ?? 0) + (quality?.conflicts ?? 0),
        unpriced_events: (target.api_quality?.unpriced_events ?? 0) + (quality?.unpriced_events ?? 0) };
    } else target.usd += source.usd;
  };
  const add = (
    bucketKey: string,
    accountId: string,
    vendor: string,
    s: { tokens: number; calls: number; usd: number },
    span: { first: string | null; last: string | null },
    quality?: { conflicts: number; unpriced_events: number }
  ) => {
    legacyTotalAmount = addExact(legacyTotalAmount,decimal(s.usd));
    let p = points.get(bucketKey);
    if (!p) {
      p = { bucket: bucketKey, tokens: 0, calls: 0, usd: 0, split: {} };
      points.set(bucketKey, p);
    }
    merge(p, s, quality);
    const cur = p.split[accountId] ?? { tokens: 0, calls: 0, usd: 0 };
    merge(cur, s, quality);
    p.split[accountId] = cur;
    let row = perAccount.get(accountId);
    if (!row) {
      row = { id: accountId, vendor, tokens: 0, calls: 0, usd: 0, first_ts: null, last_ts: null };
      perAccount.set(accountId, row);
    }
    merge(row, s, quality);
    if (span.first && (!row.first_ts || span.first < row.first_ts)) row.first_ts = span.first;
    if (span.last && (!row.last_ts || span.last > row.last_ts)) row.last_ts = span.last;
  };
  if (apiCodexLedgerIsPending(ctx,{since,until,dependencyBases:["api_equivalent_usd"]})) return preparingDataResponse();
  // Codex: owned day sums, gathered per bucket and account (in the order their calls first appear) before they
  // are merged, so exact money is added once per bucket and account, not per stored group.
  const codexTotal = new ExactParts();
  const codexSlices = new Map<string, { bucket: string; id: string; tokens: number; calls: number; unpricedEvents: number;
    usd: ExactParts; first: string | null; last: string | null }>();
  for (const row of apiCodexOwnedDaySums(ctx, { since, until }, accountResolverOf(ctx))) {
    const id = row.account ?? "codex-unassigned", bucket = accountHistoryBucket(row.day, group), key = `${bucket}\u0000${id}`;
    if (row.unpricedTokens) unpriced.add(row.model, Number(row.unpricedTokens));
    const slice = codexSlices.get(key) ?? { bucket, id, tokens: 0, calls: 0, unpricedEvents: 0, usd: new ExactParts(), first: null, last: null };
    slice.tokens += Number(row.tokens); slice.calls += Number(row.calls); slice.unpricedEvents += Number(row.unpricedEvents);
    slice.usd.add(row.usd); codexTotal.add(row.usd);
    if (row.first_ts && (!slice.first || row.first_ts < slice.first)) slice.first = row.first_ts;
    if (row.last_ts && (!slice.last || row.last_ts > slice.last)) slice.last = row.last_ts;
    codexSlices.set(key, slice);
  }
  for (const slice of codexSlices.values()) {
    add(slice.bucket, slice.id, "codex", { tokens: slice.tokens, calls: slice.calls, usd: 0 }, { first: slice.first, last: slice.last },
      { conflicts: 0, unpriced_events: slice.unpricedEvents });
    const usd = slice.usd.total(), point = points.get(slice.bucket)!;
    for (const target of [point, point.split[slice.id]!, perAccount.get(slice.id)!]) codexAmounts.add(target, usd);
  }
  const codexTotalAmount = codexTotal.total();
  codexAmounts.finish();
  try {
    const knownClaude = distinctSubscriptions(ctx).some(account => account.vendor === "claude" || account.vendor === "anthropic");
    for (const row of readClaudeAccountHistory(ctx.sqlite, accountResolverOf(ctx), ctx.rateCards, { since, until }, group, knownClaude)) {
      if (row.unpricedTokens > 0) unpriced.add(row.model, row.unpricedTokens);
      add(row.bucket, row.account, "claude", { tokens: row.tokens, calls: row.calls, usd: row.pricedUsd },
        { first: row.first, last: row.last }, { conflicts: row.conflicts, unpriced_events: row.unpricedEvents });
    }
  } catch (error) {
    if (error instanceof SubscriptionUsageUnavailable) return subscriptionUsageUnavailableResponse(error);
    throw error;
  }
  // Gemini, OpenCode and Grok from the usage ledger, each call once: Gemini at its stored valuation
  // under its profile, OpenCode and Grok at the money they recorded, one row per provider.
  for (const vendor of ["gemini", "opencode", "grok"] as const) {
    for (const row of readLedgerUsage(ctx.sqlite, vendor, { since, until, ...(vendor === "gemini" ? { card: ctx.rateCards } : {}) })) {
      if (vendor === "gemini") unpriced.add(row.model, row.unpriced_tokens);
      const tokens = vendor === "gemini" ? row.uncached + row.cache_read + row.out
        // OpenCode's output includes its reasoning, which the history never counted twice.
        : vendor === "opencode" ? row.uncached + row.cache_read + row.write_unknown + row.out - row.thinking
        : row.uncached + row.cache_read + row.write_unknown + row.out;
      add(accountHistoryBucket(row.day, group), vendor === "gemini" ? row.home ?? "gemini" : vendor, vendor,
        { tokens, calls: row.calls, usd: vendor === "gemini" ? Number(row.priced_usd) : row.reported_usd ?? 0 },
        { first: row.first_ts, last: row.last_ts });
    }
  }
  const sorted = [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  for (const p of sorted) {
    if (p.usd !== null) p.usd = codexAmounts.rounded(p) ?? round2(p.usd);
    if (p.priced_usd !== undefined) p.priced_usd = codexAmounts.rounded(p) ?? round2(p.priced_usd);
    for (const slice of Object.values(p.split)) {
      if (slice.usd !== null) slice.usd = codexAmounts.rounded(slice) ?? round2(slice.usd);
      if (slice.priced_usd !== undefined) slice.priced_usd = codexAmounts.rounded(slice) ?? round2(slice.priced_usd);
    }
  }
  const accounts = [...perAccount.values()]
    .map((a) => ({ ...a, usd: a.usd === null ? null : codexAmounts.rounded(a) ?? round2(a.usd),
      ...(a.priced_usd === undefined ? {} : { priced_usd: codexAmounts.rounded(a) ?? round2(a.priced_usd) }) }))
    .sort((a, b) => b.tokens - a.tokens);
  const totalPriced = codexAmounts.hasAmounts ? roundApiCodexUsd(addExact(codexTotalAmount,legacyTotalAmount))
    : round2([...perAccount.values()].reduce((sum,row)=>sum+(row.priced_usd ?? row.usd ?? 0),0));
  const totalComplete = accounts.every(a => a.usd !== null);
  const totalQuality = accounts.reduce((sum, a) => ({ conflicts: sum.conflicts + (a.api_quality?.conflicts ?? 0),
    unpriced_events: sum.unpriced_events + (a.api_quality?.unpriced_events ?? 0) }),
  { conflicts: 0, unpriced_events: 0 });
  return json({
    group,
    since: since ?? null,
    until: until ?? null,
    accounts,
    points: sorted,
    totals: {
      tokens: accounts.reduce((s, a) => s + a.tokens, 0),
      calls: accounts.reduce((s, a) => s + a.calls, 0),
      usd: totalComplete ? totalPriced : null,
      ...(!totalComplete ? { priced_usd: totalPriced, api_quality: { complete: false, ...totalQuality } } : {}),
    },
    unpriced,
    notes: [
      "Dolary sa API-eq: ile ten ruch kosztowalby po cenniku API, nie ile zaplacono za abonamenty.",
      "Procenty limitu nie wystepuja i wystapic nie moga - sa ulamkami roznych calosci, wiec sie nie sumuja.",
      "Brak kubelka dla subskrypcji znaczy zero ruchu w tym okresie, a nie brak danych; zakres kazdego konta jest w accounts[].first_ts/last_ts.",
      "opencode i grok sa zbierane per maszyna, nie per profil - stad jeden wiersz na vendora.",
    ],
  });
}
