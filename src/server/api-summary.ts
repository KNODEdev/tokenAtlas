import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import type { Rational } from "../db/price-ledger-exact";
import { ApiCodexMoney, roundApiCodexUsdWithLegacy, roundApiCodexUsd, apiCodexLedgerIsPending, apiCodexBucket, apiCodexLedgerRows, apiHasCodexHistory, apiCodexTokenReader } from "./api-codex-ledger";
import type { UnpricedResult } from "./api-report-values";
import { round2, UnpricedCollector } from "./api-report-values";
import { preparingDataResponse } from "./preparing-response";
import { rational, add as addExact, decimal, subtract } from "../db/price-ledger-exact";
import { projectMatcher, readPricedLedgerDays, readLedgerUsage, readLedgerBucketCosts } from "./ledger-sums";
import type { AppContext } from "./app-context-types";
import { parseCommonDateParams, parseInstantParams, isValidDateString } from "./api-request-params";
import { accountResolverOf, resolveAccountScope, knownAccountIds, normPath, distinctSubscriptions } from "./account-scope";
import type { LedgerUsageRow } from "./ledger-sums";
import { loadProjects } from "../projects/remap";
import type { AccountScope } from "./account-scope";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { buildLeverage } from "./leverage";
import { SubscriptionUsageUnavailable, subscriptionUsageUnavailableResponse } from "./subscription-usage";

interface SummaryBucket {
    bucket: string;
    claude?: {
      calls: number;
      usd: number;
      tokens: {
        in_uncached: number;
        in_cache_read: number;
        in_cache_write: number;
        cache_write_5m: number;
        cache_write_1h: number;
        out_total: number;
        out_thinking: number;
        total: number;
      };
    };
    codex?: {
      calls: number;
      usd: number;
      tokens: {
        in_tok: number;
        cached_in: number;
        cache_write: number;
        out_tok: number;
        reasoning_out: number;
        fresh_in: number;
        total: number;
      };
    };
    calls: number;
    usd: number;
    tokens: {
      total: number;
    };
  }

type SummaryFacts={buckets:SummaryBucket[];unpriced:UnpricedResult;codexSubtotal?:Rational;codexMoney?:ApiCodexMoney};

function finishSummary(group:string,vendor:string,{buckets,unpriced,codexSubtotal,codexMoney}:SummaryFacts) {
  let totalCalls = 0;
  let totalUsd = 0;
  let claudeTotalUsd = 0;
  let codexTotalUsd = 0;
  let claudeTotalCalls = 0;
  let codexTotalCalls = 0;
  for (const b of buckets) {
    totalUsd += b.usd;
    b.usd = codexMoney?.rounded(b) ?? round2(b.usd);
    if (b.claude) {
      claudeTotalUsd += b.claude.usd;
      b.claude.usd = round2(b.claude.usd);
      claudeTotalCalls += b.claude.calls;
    }
    if (b.codex) {
      codexTotalUsd += b.codex.usd;
      b.codex.usd = codexMoney?.rounded(b.codex) ?? round2(b.codex.usd);
      codexTotalCalls += b.codex.calls;
    }
    totalCalls += b.calls;
  }
  return {
    group,
    vendor,
    buckets,
    totals: {
      calls: totalCalls,
      usd: codexSubtotal === undefined ? round2(totalUsd) : roundApiCodexUsdWithLegacy(codexSubtotal,claudeTotalUsd),
      claude: vendor !== "codex" ? { calls: claudeTotalCalls, usd: round2(claudeTotalUsd) } : undefined,
      codex: vendor !== "claude" ? { calls: codexTotalCalls, usd: codexSubtotal === undefined ? round2(codexTotalUsd) : roundApiCodexUsd(codexSubtotal) } : undefined,
    },
    unpriced,
  };
}

export function handleSummary(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleSummaryBody(ctx, url, json), contextRequested(url));
}
function handleSummaryBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const group = url.searchParams.get("group") || "day";
  const vendor = url.searchParams.get("vendor") || "both";
  if (!["day", "week", "month"].includes(group)) {
    return json(
      { error: `Invalid 'group' parameter: '${group}'. Allowed: day, week, month.` },
      { status: 400 }
    );
  }
  if (!["claude", "codex", "both"].includes(vendor)) {
    return json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, both.` },
      { status: 400 }
    );
  }
  if (vendor !== "claude" && apiCodexLedgerIsPending(ctx, { since, until, dependencyBases: ["api_equivalent_usd"] })) return preparingDataResponse();
  const unpriced = new UnpricedCollector();
  let codexAmount = rational(0n);
  const codexMoney = new ApiCodexMoney();
  const bucketMap = new Map<string, SummaryBucket>();
  function getOrCreateBucket(b: string): SummaryBucket {
    let entry = bucketMap.get(b);
    if (!entry) {
      entry = {
        bucket: b,
        calls: 0,
        usd: 0,
        tokens: { total: 0 },
      };
      bucketMap.set(b, entry);
    }
    return entry;
  }
  if (vendor === "claude" || vendor === "both") {
    // Claude day sums and their actual-mode valuations come from the shared usage ledger.
    const project = projectMatcher(url);
    for (const row of readPricedLedgerDays(ctx.sqlite, "claude", ctx.rateCards, { since, until })) {
      if (project && !project(row)) continue;
      const in_cache_write = row.write_5m + row.write_1h + row.write_unknown;
      const rowTokens = row.uncached + row.cache_read + in_cache_write + row.out;
      const rowUsd = Number(row.priced_usd);
      if (row.unpriced_tokens) unpriced.add(row.model, row.unpriced_tokens);
      const b = getOrCreateBucket(apiCodexBucket(ctx.sqlite, row.day, group));
      b.claude ??= { calls: 0, usd: 0, tokens: { in_uncached: 0, in_cache_read: 0, in_cache_write: 0, cache_write_5m: 0,
        cache_write_1h: 0, out_total: 0, out_thinking: 0, total: 0 } };
      b.claude.calls += row.calls;
      b.claude.usd += rowUsd;
      b.claude.tokens.in_uncached += row.uncached;
      b.claude.tokens.in_cache_read += row.cache_read;
      b.claude.tokens.in_cache_write += in_cache_write;
      b.claude.tokens.cache_write_5m += row.write_5m;
      b.claude.tokens.cache_write_1h += row.write_1h;
      b.claude.tokens.out_total += row.out;
      b.claude.tokens.out_thinking += row.thinking;
      b.claude.tokens.total += rowTokens;
      b.calls += row.calls;
      b.usd += rowUsd;
      b.tokens.total += rowTokens;
    }
  }
  if (vendor === "codex" || vendor === "both") {
    for (const row of apiCodexLedgerRows(ctx, { since, until }, url, accountResolverOf(ctx))) {
      const in_tok = row.in_tok, cached_in = row.cached_in, cache_write = row.cache_write;
      const out_tok = row.out_tok, reasoning_out = row.reasoning_out;
      const fresh_in = in_tok - cached_in - cache_write, rowTokens = in_tok + out_tok;
      if (row.unpriced) unpriced.add(row.model, row.unpriced);
      codexAmount = addExact(codexAmount,row.usd);
      const rowBucket = apiCodexBucket(ctx.sqlite, row.day, group);
        const b = getOrCreateBucket(rowBucket);
        if (!b.codex) {
          b.codex = {
            calls: 0,
            usd: 0,
            tokens: {
              in_tok: 0,
              cached_in: 0,
              cache_write: 0,
              out_tok: 0,
              reasoning_out: 0,
              fresh_in: 0,
              total: 0,
            },
          };
        }
        b.codex.calls += row.calls;
        codexMoney.add(b.codex, row.usd);
        b.codex.tokens.in_tok += in_tok;
        b.codex.tokens.cached_in += cached_in;
        b.codex.tokens.cache_write += cache_write;
        b.codex.tokens.out_tok += out_tok;
        b.codex.tokens.reasoning_out += reasoning_out;
        b.codex.tokens.fresh_in += fresh_in;
        b.codex.tokens.total += rowTokens;
        b.calls += row.calls;
        codexMoney.add(b, row.usd);
        b.tokens.total += rowTokens;
    }
    codexMoney.finish();
  }
  const buckets = Array.from(bucketMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const facts={buckets,unpriced:unpriced.toJSON(),codexSubtotal:codexMoney.hasAmounts ? codexAmount : undefined,
    codexMoney:codexMoney.hasAmounts ? codexMoney : undefined};
  return json(finishSummary(group,vendor,facts));
}

export function handleBreakdown(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleBreakdownBody(ctx, url, json), contextRequested(url));
}
function handleBreakdownBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const instantParams = parseInstantParams(url);
  if (instantParams.error) {
    return json({ error: instantParams.error }, { status: 400 });
  }
  const { since_ts, until_ts } = instantParams;
  const dim = url.searchParams.get("dim");
  if (!dim || !["model", "project", "raw_project", "store", "account", "surface"].includes(dim)) {
    return json(
      { error: `Invalid 'dim' parameter: '${dim}'. Allowed: model, project, raw_project, store, account, surface.` },
      { status: 400 }
    );
  }
  const vendor = url.searchParams.get("vendor") || "all";
  if (!["claude", "codex", "opencode", "grok", "gemini", "both", "all"].includes(vendor)) {
    return json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, opencode, grok, gemini, both, all.` },
      { status: 400 }
    );
  }
  const accountParam = url.searchParams.get("account") || undefined;
  let scope: AccountScope | null = null;
  if (accountParam) {
    scope = resolveAccountScope(ctx, accountParam);
    if (!scope) {
      return json(
        {
          error: `Unknown 'account' parameter: '${accountParam}'. Known: ${knownAccountIds(ctx).join(", ")}.`,
        },
        { status: 400 }
      );
    }
    if (url.searchParams.get("vendor") && vendor !== scope.vendor) {
      return json(
        {
          error: `'vendor=${vendor}' contradicts 'account=${scope.id}', which is a ${scope.vendor} subscription.`,
        },
        { status: 400 }
      );
    }
  }
  const effVendor = scope ? scope.vendor : vendor;
  if (["codex","both","all"].includes(effVendor) && apiCodexLedgerIsPending(ctx, { since, until,
    fromMs: since_ts ? Date.parse(since_ts) : undefined, toMs: until_ts ? Date.parse(until_ts) : undefined,
    dependencyBases: ["api_equivalent_usd"] })) return preparingDataResponse();
  const unpriced = new UnpricedCollector();
  interface BreakdownRow {
    name: string;
    vendor: string;
    calls: number;
    usd: number;
    tokens: number;
    token_details: Record<string, number>;
  }
  let codexAmount = rational(0n);
  const codexMoney = new ApiCodexMoney();
  const rowMap = new Map<string, BreakdownRow>();
  function getOrCreateRow(name: string, rowVendor: string): BreakdownRow {
    const key = `${rowVendor}::${name}`;
    let row = rowMap.get(key);
    if (!row) {
      row = {
        name,
        vendor: rowVendor,
        calls: 0,
        usd: 0,
        tokens: 0,
        token_details: {},
      };
      rowMap.set(key, row);
    }
    return row;
  }
  if ((effVendor === "codex" || effVendor === "both" || effVendor === "all") && dim !== "store") {
    for (const row of apiCodexLedgerRows(ctx, { since, until,
      ...(since_ts ? { fromMs: Date.parse(since_ts) } : {}), ...(until_ts ? { toMs: Date.parse(until_ts) } : {}) }, url, accountResolverOf(ctx))) {
      if (scope && (row.account?.toLowerCase() !== scope.id.toLowerCase()
        || scope.homes.length && (!row.home || !scope.homes.includes(normPath(row.home))))) continue;
      const stored = row.group.stored;
      const name = String((dim === "account" ? row.account : dim === "project" ? stored.project_id
        : dim === "raw_project" ? stored.project : dim === "surface" ? stored.surface : stored.model) ?? "-");
      const in_tok = row.in_tok, cached_in = row.cached_in, cache_write = row.cache_write;
      const out_tok = row.out_tok, reasoning_out = row.reasoning_out;
      const fresh_in = in_tok - cached_in - cache_write, rowTokens = in_tok + out_tok;
      if (row.unpriced) unpriced.add(row.model, row.unpriced);
        codexAmount = addExact(codexAmount,row.usd);
      const r = getOrCreateRow(name, "codex");
        r.calls += row.calls;
        codexMoney.add(r, row.usd);
        r.tokens += rowTokens;
        r.token_details.in_tok = (r.token_details.in_tok || 0) + in_tok;
        r.token_details.cached_in = (r.token_details.cached_in || 0) + cached_in;
        r.token_details.fresh_in = (r.token_details.fresh_in || 0) + fresh_in;
        r.token_details.cache_write = (r.token_details.cache_write || 0) + cache_write;
        r.token_details.out_tok = (r.token_details.out_tok || 0) + out_tok;
        r.token_details.reasoning_out = (r.token_details.reasoning_out || 0) + reasoning_out;
    }
    codexMoney.finish();
  }
  // Claude, OpenCode, Grok and Gemini from the usage ledger: each call once (its canonical copy).
  // Claude and Gemini show the stored API valuation; OpenCode and Grok the money they recorded themselves.
  const matcher = projectMatcher(url);
  const groupName = (row: LedgerUsageRow) => (dim === "project" ? row.project_id : dim === "raw_project" ? row.project
    : dim === "store" || dim === "account" ? row.home : row.model) ?? "-";
  const sharedVendors = (["claude", "opencode", "grok", "gemini"] as const).filter(candidate => dim !== "surface"
    && (effVendor === "all" || effVendor === candidate || effVendor === "both" && candidate === "claude"));
  for (const sharedVendor of sharedVendors) {
    const valued = sharedVendor === "claude" || sharedVendor === "gemini";
    for (const row of readLedgerUsage(ctx.sqlite, sharedVendor, { since, until, sinceTs: since_ts, untilTs: until_ts,
      ...(valued ? { card: ctx.rateCards } : {}) })) {
      if (matcher && !matcher(row)) continue;
      // The GLM subscription covers the calls of its own providers only.
      if (sharedVendor === "opencode" && scope?.id === "glm" && row.rate_vendor !== null) continue;
      const r = getOrCreateRow(groupName(row), sharedVendor), writes = row.write_5m + row.write_1h + row.write_unknown;
      const d = r.token_details, bump = (key: string, value: number) => { d[key] = (d[key] || 0) + value; };
      r.calls += row.calls;
      if (valued) { r.usd += Number(row.priced_usd); unpriced.add(row.model, row.unpriced_tokens); }
      else r.usd += row.reported_usd ?? 0;
      if (sharedVendor === "claude") {
        r.tokens += row.uncached + row.cache_read + writes + row.out;
        bump("in_uncached", row.uncached); bump("in_cache_read", row.cache_read); bump("in_cache_write", writes);
        bump("cache_write_5m", row.write_5m); bump("cache_write_1h", row.write_1h); bump("out_total", row.out);
      } else if (sharedVendor === "opencode") {
        // OpenCode's output total includes its reasoning; the view shows visible output and reasoning apart.
        const visible = row.out - row.thinking;
        r.tokens += row.uncached + row.cache_read + row.write_unknown + visible;
        bump("in_uncached", row.uncached); bump("in_cache_read", row.cache_read); bump("in_cache_write", row.write_unknown);
        bump("out_total", visible); bump("out_thinking", row.thinking);
      } else if (sharedVendor === "grok") {
        r.tokens += row.uncached + row.cache_read + row.out;
        bump("in_uncached", row.uncached); bump("in_cache_read", row.cache_read); bump("in_cache_write", row.write_unknown);
        bump("out_total", row.out); bump("out_thinking", row.thinking); bump("fresh_in", row.uncached);
      } else {
        r.tokens += row.uncached + row.cache_read + row.out;
        bump("in_uncached", row.uncached); bump("in_cache_read", row.cache_read); bump("out_total", row.out);
        bump("out_thinking", row.thinking); bump("fresh_in", row.uncached);
      }
    }
  }
  const projectNames = new Map(loadProjects().projects.map((p) => [p.id, p.name]));
  const legacyTotalUsd = [...rowMap.values()].filter(row=>row.vendor !== "codex").reduce((sum,row)=>sum+row.usd,0);
  const rows = Array.from(rowMap.values())
    .map((r) =>
      dim === "project"
        ? {
            ...r,
            usd: codexMoney.rounded(r) ?? round2(r.usd),
            project_id: r.name === "-" ? null : r.name,
            name: r.name === "-" ? "unassigned" : projectNames.get(r.name) ?? r.name,
          }
        : { ...r, usd: codexMoney.rounded(r) ?? round2(r.usd) },
    )
    .sort((a, b) => b.usd - a.usd);
  let totalCalls = 0;
  let totalUsd = 0;
  let totalTokens = 0;
  for (const r of rows) {
    totalCalls += r.calls;
    totalUsd += r.usd;
    totalTokens += r.tokens;
  }
  return json({
    dim,
    vendor: effVendor,
    account: scope ? scope.id : null,
    scope: {
      since: since ?? null,
      until: until ?? null,
      since_ts: since_ts ?? null,
      until_ts: until_ts ?? null,
      homes: scope ? scope.homes : [],
    },
    rows,
    totals: {
      calls: totalCalls,
      usd: codexMoney.hasAmounts ? roundApiCodexUsdWithLegacy(codexAmount,legacyTotalUsd) : round2(legacyTotalUsd),
      tokens: totalTokens,
    },
    unpriced: unpriced.toJSON(),
  });
}

export function handleCompare(ctx: AppContext, url: URL): Response {
  const a_since = url.searchParams.get("a_since") || undefined;
  const a_until = url.searchParams.get("a_until") || undefined;
  const b_since = url.searchParams.get("b_since") || undefined;
  const b_until = url.searchParams.get("b_until") || undefined;
  for (const [key, val] of [
    ["a_since", a_since],
    ["a_until", a_until],
    ["b_since", b_since],
    ["b_until", b_until],
  ] as const) {
    if (val !== undefined && !isValidDateString(val)) {
      return Response.json(
        { error: `Invalid '${key}' date parameter: '${val}'. Expected format YYYY-MM-DD.` },
        { status: 400 }
      );
    }
  }
  const vendor = url.searchParams.get("vendor") || "both";
  if (!["claude", "codex", "both"].includes(vendor)) {
    return Response.json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, both.` },
      { status: 400 }
    );
  }
  const unpriced = new UnpricedCollector();
  if (vendor !== "claude" && (apiCodexLedgerIsPending(ctx, { since: a_since, until: a_until, dependencyBases: ["api_equivalent_usd"] })
    || apiCodexLedgerIsPending(ctx, { since: b_since, until: b_until, dependencyBases: ["api_equivalent_usd"] }))) return preparingDataResponse();
  function queryWindow(since?: string, until?: string) {
    let calls = 0;
    let usd = 0;
    let tokens = 0;
    let claudeCalls = 0;
    let claudeUsd = 0;
    let claudeTokens = 0;
    let codexCalls = 0;
    let codexUsd = 0;
    let codexTokens = 0;
    let codexAmount = rational(0n);
    if (vendor === "claude" || vendor === "both") {
      // Each call once, at its stored valuation (fast mode at its own rates).
      for (const row of readLedgerUsage(ctx.sqlite, "claude", { since, until, card: ctx.rateCards })) {
        const rowTokens = row.uncached + row.cache_read + row.write_5m + row.write_1h + row.write_unknown + row.out;
        const rowUsd = Number(row.priced_usd);
        unpriced.add(row.model, row.unpriced_tokens);
        claudeCalls += row.calls;
        claudeUsd += rowUsd;
        claudeTokens += rowTokens;
        calls += row.calls;
        usd += rowUsd;
        tokens += rowTokens;
      }
    }
    if (vendor === "codex" || vendor === "both") {
      for (const row of apiCodexLedgerRows(ctx, { since, until }, undefined, accountResolverOf(ctx))) {
        if (row.unpriced) unpriced.add(row.model, row.unpriced);
        codexCalls += row.calls; codexTokens += row.in_tok + row.out_tok;
        codexAmount = addExact(codexAmount, row.usd);
      }
      codexUsd = ledgerPresentationNumber(codexAmount);
      calls += codexCalls; tokens += codexTokens; usd += codexUsd;
    }
    return {
      calls,
      usd: vendor === "claude" ? round2(usd) : roundApiCodexUsdWithLegacy(codexAmount,claudeUsd),
      exactUsd: addExact(codexAmount,decimal(claudeUsd)),
      tokens,
      claude: vendor !== "codex" ? { calls: claudeCalls, usd: round2(claudeUsd), tokens: claudeTokens } : undefined,
      codex: vendor !== "claude" ? { calls: codexCalls, usd: roundApiCodexUsd(codexAmount), tokens: codexTokens } : undefined,
    };
  }
  const { exactUsd: exactA, ...windowA } = queryWindow(a_since, a_until);
  const { exactUsd: exactB, ...windowB } = queryWindow(b_since, b_until);
  const deltaCalls = windowB.calls - windowA.calls;
  const deltaUsd = vendor === "claude" ? round2(windowB.usd - windowA.usd) : roundApiCodexUsd(subtract(exactB,exactA));
  const deltaTokens = windowB.tokens - windowA.tokens;
  const pctDeltaCalls = windowA.calls !== 0 ? round2((deltaCalls / windowA.calls) * 100) : null;
  const pctDeltaUsd = windowA.usd !== 0 ? round2((deltaUsd / windowA.usd) * 100) : null;
  const pctDeltaTokens = windowA.tokens !== 0 ? round2((deltaTokens / windowA.tokens) * 100) : null;
  return Response.json({
    vendor,
    window_a: {
      since: a_since || null,
      until: a_until || null,
      ...windowA,
    },
    window_b: {
      since: b_since || null,
      until: b_until || null,
      ...windowB,
    },
    delta: {
      calls: deltaCalls,
      pct_calls: pctDeltaCalls,
      usd: deltaUsd,
      pct_usd: pctDeltaUsd,
      tokens: deltaTokens,
      pct_tokens: pctDeltaTokens,
    },
    unpriced: unpriced.toJSON(),
  });
}

export function handleCache(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const vendor = url.searchParams.get("vendor") || "both";
  if (!["claude", "codex", "both"].includes(vendor)) {
    return Response.json(
      { error: `Invalid 'vendor' parameter: '${vendor}'. Allowed: claude, codex, both.` },
      { status: 400 }
    );
  }
  if (vendor !== "claude" && apiCodexLedgerIsPending(ctx, { since, until, dependencyBases: ["api_equivalent_usd"] })) return preparingDataResponse();
  const unpriced = new UnpricedCollector();
  let claudeData: Record<string, unknown> | undefined;
  if (vendor === "claude" || vendor === "both") {
    let tok_in_uncached = 0;
    let tok_in_cache_read = 0;
    let tok_cache_write_5m = 0;
    let tok_cache_write_1h = 0;
    let tok_in_cache_write = 0;
    let tok_out_total = 0;
    let usd_in_uncached = 0;
    let usd_in_cache_read = 0;
    let usd_cache_write_5m = 0;
    let usd_cache_write_1h = 0;
    let usd_in_cache_write = 0;
    let usd_out_total = 0;
    let usd_hypothetical_uncached = 0;
    const project = url.searchParams.get("project_id");
    // Each call once; its buckets valued at the rates the ledger stored for it.
    for (const row of readLedgerBucketCosts(ctx.sqlite, "claude", ctx.rateCards, { since, until,
      ...(project ? { projectId: project === "unassigned" ? null : project } : {}) })) {
      const writes = row.tokens.write_5m + row.tokens.write_1h + row.tokens.write_unknown;
      tok_in_uncached += row.tokens.uncached;
      tok_in_cache_read += row.tokens.cache_read;
      tok_in_cache_write += writes;
      tok_cache_write_5m += row.tokens.write_5m;
      tok_cache_write_1h += row.tokens.write_1h;
      tok_out_total += row.tokens.out;
      unpriced.add(row.model, row.unpriced_tokens);
      usd_in_uncached += Number(row.costs.uncached);
      usd_in_cache_read += Number(row.costs.cache_read);
      usd_cache_write_5m += Number(row.costs.write_5m);
      usd_cache_write_1h += Number(row.costs.write_1h);
      usd_in_cache_write += Number(row.costs.write_5m) + Number(row.costs.write_1h) + Number(row.costs.write_unknown);
      usd_out_total += Number(row.costs.out);
      usd_hypothetical_uncached += Number(row.costs.hypothetical_uncached);
    }
    const totalInputTokens = tok_in_uncached + tok_in_cache_read + tok_in_cache_write;
    const cacheHitRatePct = totalInputTokens > 0 ? round2((tok_in_cache_read / totalInputTokens) * 100) : 0;
    const costSavingsUsd = round2(usd_hypothetical_uncached - usd_in_cache_read);
    claudeData = {
      tokens: {
        in_uncached: tok_in_uncached,
        in_cache_read: tok_in_cache_read,
        cache_write_5m: tok_cache_write_5m,
        cache_write_1h: tok_cache_write_1h,
        in_cache_write: tok_in_cache_write,
        out_total: tok_out_total,
        total_input: totalInputTokens,
        total: totalInputTokens + tok_out_total,
      },
      usd: {
        in_uncached: round2(usd_in_uncached),
        in_cache_read: round2(usd_in_cache_read),
        cache_write_5m: round2(usd_cache_write_5m),
        cache_write_1h: round2(usd_cache_write_1h),
        in_cache_write: round2(usd_in_cache_write),
        out_total: round2(usd_out_total),
        total: round2(usd_in_uncached + usd_in_cache_read + usd_in_cache_write + usd_out_total),
      },
      cache_hit_rate_pct: cacheHitRatePct,
      cost_savings_usd: costSavingsUsd,
    };
  }
  let codexData: Record<string, unknown> | undefined;
  if (vendor === "codex" || vendor === "both") {
    let tok_in_tok = 0, tok_cached_in = 0, tok_fresh_in = 0, tok_cache_write = 0, tok_out_tok = 0;
    let freshAmount = rational(0n), cachedAmount = rational(0n), writeAmount = rational(0n), outAmount = rational(0n), hypotheticalAmount = rational(0n);
    const projectTokens = apiHasCodexHistory(ctx) ? apiCodexTokenReader(ctx, { since, until }) : null;
    for (const row of apiCodexLedgerRows(ctx, { since, until }, url, accountResolverOf(ctx))) {
      tok_in_tok += row.in_tok; tok_cached_in += row.cached_in; tok_fresh_in += row.in_tok - row.cached_in - row.cache_write;
      tok_cache_write += row.cache_write; tok_out_tok += row.out_tok;
      if (row.unpriced) unpriced.add(row.model, row.unpriced);
      const parts = projectTokens?.(row.group);
      if (!parts) continue;
      freshAmount = addExact(freshAmount, parts.in_uncached); cachedAmount = addExact(cachedAmount, parts.cache_read);
      writeAmount = addExact(writeAmount, parts.cache_write); outAmount = addExact(outAmount, parts.out);
      hypotheticalAmount = addExact(hypotheticalAmount, parts.hypothetical);
    }
    const cacheHitRatePct = tok_in_tok > 0 ? round2((tok_cached_in / tok_in_tok) * 100) : 0;
    const costSavingsUsd = roundApiCodexUsd(subtract(hypotheticalAmount,cachedAmount));
    codexData = {
      tokens: {
        fresh_in: tok_fresh_in,
        cached_in: tok_cached_in,
        cache_write: tok_cache_write,
        in_tok: tok_in_tok,
        out_tok: tok_out_tok,
        total_input: tok_in_tok,
        total: tok_in_tok + tok_out_tok,
      },
      usd: {
        fresh_in: roundApiCodexUsd(freshAmount),
        cached_in: roundApiCodexUsd(cachedAmount),
        cache_write: roundApiCodexUsd(writeAmount),
        out_tok: roundApiCodexUsd(outAmount),
        total: roundApiCodexUsd(addExact(addExact(freshAmount,cachedAmount),addExact(writeAmount,outAmount))),
      },
      cache_hit_rate_pct: cacheHitRatePct,
      cost_savings_usd: costSavingsUsd,
    };
  }
  return Response.json({
    claude: claudeData,
    codex: codexData,
    unpriced: unpriced.toJSON(),
  });
}

export function handleLeverage(ctx: AppContext, url: URL): Response {
  const dates = parseCommonDateParams(url);
  if (dates.error) return Response.json({ error: dates.error }, { status: 400 });
  try {
    return Response.json(buildLeverage({
      sqlite: ctx.sqlite, resolver: accountResolverOf(ctx), accounts: distinctSubscriptions(ctx),
      declarations: ctx.accounts.sources, homeToSubId: ctx.homeToSubId,
      rateCards: ctx.rateCards, plansCatalog: ctx.plansCatalog,
    }, dates), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof SubscriptionUsageUnavailable)) throw error;
    return subscriptionUsageUnavailableResponse(error);
  }
}
