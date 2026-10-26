import { withReadSnapshot } from "../db/analysis";
import { subscriptionDeclarations } from "./capacity-equivalents";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { RateCard } from "./pricing";
import { loadAccountResolver, type AccountResolver } from "./account-resolver";
import type { CodexModelCacheHour, CodexWindowDetail, CodexWindowModelRow, WindowPriceParts } from "../shared/codex-window-detail";
import { codexLedgerReadContext, codexLedgerPendingReason, ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { rational, decimal, multiply, add, equal, type Rational } from "../db/price-ledger-exact";
import { deriveCodexLedgerGroup, type LedgerAmount, type LedgerReadGroup } from "../db/codex-price-ledger-read";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { readCodexLedgerHourSums, readCodexLedgerPieceSums, readCodexLedgerPublishedBands, type LedgerStoredGroup,
  type PublishedCodexLedgerBand } from "../db/codex-price-ledger";
import { CODEX_RESERVE_MODEL } from "./codex-window-comparison";
import { codexEventOwner } from "./codex-event-owner";
import { contextPriceOfSpan, readContextRows } from "./context-price-read";
import type { ContextPrice } from "../shared/context-price";
import { contextReadScope, originalContextApi, projectContextGroup } from "../db/codex-context-read-scope";
import type { CreditFundedSums, CreditFundedHour } from "../shared/credit-funded";

interface Bucket { calls: number; tokens: number; tokens_fresh: number; usd: number; usd_exact?: { n: string; d: string };
  context_price?: ContextPrice;
  usd_partial?: boolean; top_model: string | null; top_calls: number;
  /** Standard credits of the priced calls (the window's credit-equivalent basis); `credits_partial` when some were unpriced. */
  credits?: number; credits_partial?: boolean }
const emptyBucket = (): Bucket => ({ calls: 0, tokens: 0, tokens_fresh: 0, usd: 0, top_model: null, top_calls: 0 });

interface WindowOptions {
  account: string; homes: string[]; from: string; until: string; anchor: number | null; limitId: string;
  sessionMinutes: number; inclusiveEnd?: boolean;
  /** One project's calls (null: calls without one), by the project rules at read time; every call when absent. */
  project?: string | null;
  includeBurn?: boolean;
  filterCounter?: boolean;
  sessionOrigin?: number;
  /** Source definitions (`subscriptionDeclarations`) and mirror source homes. */
  homeToSubId?: Map<string, string>;
}

const HOUR_MS = 3_600_000;
const BURN_HOURS: number[] = [1, 6, 24, 168];
const BURN_SPAN_MS = 168 * HOUR_MS;
const declarationsOf = (options: WindowOptions) => options.homeToSubId ? subscriptionDeclarations(options.homeToSubId) : [];
/**
 * The local date SQLite gives each instant (`date(…, 'localtime')`), the key a call's day has always had. Outside a test run it is
 * the process's own zone; a test run may set another zone for the process than the system zone SQLite reads.
 */
function sqliteLocalDays(sqlite: Database, instants: readonly number[]): Map<number, string> {
  const rows = sqlite.query("SELECT CAST(value AS INTEGER) at, date(value / 1000.0, 'unixepoch', 'localtime') day FROM json_each(?)")
    .all(JSON.stringify(instants)) as Array<{ at: number; day: string }>;
  return new Map(rows.map(row => [row.at, row.day]));
}
/** The first reason of an unpriced amount, as a per-call valuation names it. */
const reasonOf = (amount: LedgerAmount): string | null => Object.keys(amount.reasons)[0] ?? null;
const zero = rational(0n);

/**
 * One stored cohort of the window: the ledger's sums of calls that share a dimension, price cohort and copy state, all
 * at instants of `[from, …)`, a span no boundary of the window cuts (its days, sessions, burn spans and account periods).
 */
interface Unit { from: number; group: LedgerStoredGroup }
/**
 * The calls of a cohort whose token counts a window cannot sum: the ledger's invalid counters, and the calls it refuses to
 * value for invalid tokens (a missing or non-integer count among them). A cohort shares its price reason, so a call of the
 * second kind makes the whole cohort invalid.
 */
const invalidCalls = (row: LedgerStoredGroup): bigint => row.api_reason === "invalid_tokens" || row.credit_reason === "invalid_tokens"
  ? BigInt(row.calls) : BigInt(row.invalid_tokens);

/**
 * The instants that split the window's calls into parts the answer counts differently: session blocks, local days, the burn
 * spans and account periods (a call's owner is the period covering its source and instant).
 */
function windowCuts(resolver: AccountResolver, options: WindowOptions, from: number, end: number, burn: { start: number; end: number } | null): number[] {
  const cuts = new Set<number>();
  const blockMs = options.sessionMinutes * 60_000, origin = options.sessionOrigin ?? from;
  for (let at = origin + Math.ceil((from - origin) / blockMs) * blockMs; at < end; at += blockMs) cuts.add(at);
  const midnight = new Date(from);
  midnight.setHours(0, 0, 0, 0);
  for (let guard = 0; guard < 400 && midnight.getTime() < end; guard++) {
    cuts.add(midnight.getTime());
    midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
  }
  if (burn) { cuts.add(burn.start); cuts.add(burn.end + 1); for (const hours of BURN_HOURS) cuts.add(burn.end - hours * HOUR_MS); }
  for (const account of resolver.accounts("codex")) for (const range of resolver.plan("codex", account).ranges) { cuts.add(range.from); cuts.add(range.until); }
  return [...cuts].filter(at => Number.isSafeInteger(at) && at > from && at < end).sort((a, b) => a - b);
}

/**
 * The window's cohorts: whole calendar hours from the stored hour sums, the hours a cut falls in (and the window's own
 * edges) read from the calls as pieces between the cuts. An hour whose stored cohort mixes valid and invalid calls is read
 * as pieces too, so every cohort's calls are counted alike.
 */
function windowUnits(sqlite: Database, options: WindowOptions, from: number, end: number, cuts: readonly number[]): Unit[] {
  const filter = { homes: options.homes } as const;
  // A cohort's project follows the rules on its pricing day (`metadataColumns`), so the selection is made on the cohorts.
  const selected = (row: { project_id: string | number | null }) => options.project === undefined
    || (options.project === null ? row.project_id === null : row.project_id !== null && String(row.project_id) === options.project);
  const fromHour = Math.floor(from / HOUR_MS), untilHour = Math.ceil(end / HOUR_MS);
  const cutHours = new Set(cuts.filter(at => at % HOUR_MS !== 0).map(at => Math.floor(at / HOUR_MS)));
  if (from % HOUR_MS !== 0) cutHours.add(fromHour);
  if (end % HOUR_MS !== 0) cutHours.add(untilHour - 1);
  const hours = readCodexLedgerHourSums(sqlite, fromHour, untilHour, filter).filter(selected);
  for (const row of hours) {
    const invalid = invalidCalls(row);
    if (invalid > 0n && invalid < BigInt(row.calls)) cutHours.add(row.hour);
  }
  const units: Unit[] = hours.filter(row => !cutHours.has(row.hour)).map(row => ({ from: row.hour * HOUR_MS, group: row }));
  const pieces: Array<[number, number]> = [];
  for (const hour of [...cutHours].sort((a, b) => a - b)) {
    const points = [Math.max(hour * HOUR_MS, from), ...cuts.filter(at => at > hour * HOUR_MS && at < (hour + 1) * HOUR_MS),
      Math.min((hour + 1) * HOUR_MS, end)];
    for (let index = 0; index + 1 < points.length; index++) if (points[index]! < points[index + 1]!) pieces.push([points[index]!, points[index + 1]!]);
  }
  for (const row of readCodexLedgerPieceSums(sqlite, pieces, filter).filter(selected)) units.push({ from: pieces[row.piece]![0], group: row });
  return units;
}

/** Exact sums of one priced part of a model row, presented once at the end. */
interface ExactParts { rates: WindowPriceParts["rates"]; rule_id: string; sources: string[]; confidence: WindowPriceParts["confidence"];
  input: Rational; cached: Rational; cache_write: Rational; output: Rational; total: Rational }
interface ModelRow { row: CodexWindowModelRow; firstMs: number; lastMs: number; order: number; api: ExactParts | null; credits: ExactParts | null;
  actualApi: Rational | null; actualCredits: Rational | null }
type PartSums = Pick<ExactParts, "input" | "cached" | "cache_write" | "output" | "total">;

/** The token-bucket breakdown of a cohort's stored base under the band that valued it; its total is the stored value. */
function priceParts(group: LedgerReadGroup, band: PublishedCodexLedgerBand | undefined, stored: Rational | null): PartSums | null {
  if (stored === null) return null;
  if (!band) throw new Error("Published window price has no coefficient snapshot");
  const multiplier = decimal(band.multiplier);
  const cost = (key: "in_uncached" | "in_cache_read" | "in_cache_write" | "out_total", tokens: bigint) =>
    multiply(rational(tokens, 1_000_000n), multiply(decimal(band.rates[key] ?? "0"), multiplier));
  const values = { input: cost("in_uncached", group.tokens.in_uncached!), cached: cost("in_cache_read", group.tokens.in_cache_read!),
    cache_write: cost("in_cache_write", group.tokens.in_cache_write_unknown!), output: cost("out_total", group.tokens.out_total!) };
  const total = [values.input, values.cached, values.cache_write, values.output].reduce(add, zero);
  if (!equal(total, stored)) throw new Error("Window token breakdown disagrees with the stored exact base");
  return { ...values, total };
}
function partsHead(band: PublishedCodexLedgerBand): Pick<ExactParts, "rates" | "rule_id" | "sources" | "confidence"> {
  const rule = JSON.parse(band.evidence) as { id: string; sources: string[]; confidence: WindowPriceParts["confidence"] };
  const rates = Object.fromEntries(Object.entries(band.rates).map(([key, value]) => [key, value == null ? null
    : ledgerPresentationNumber(multiply(decimal(value), decimal(band.multiplier)))]));
  return { rates: rates as unknown as WindowPriceParts["rates"], rule_id: rule.id, sources: rule.sources, confidence: rule.confidence };
}
const presentParts = (parts: ExactParts): WindowPriceParts => ({ rates: parts.rates, input: ledgerPresentationNumber(parts.input),
  cached: ledgerPresentationNumber(parts.cached), cache_write: ledgerPresentationNumber(parts.cache_write), output: ledgerPresentationNumber(parts.output),
  total: ledgerPresentationNumber(parts.total), rule_id: parts.rule_id, sources: parts.sources, confidence: parts.confidence });

/** The credit price at the calls' own tier, as a per-call valuation reads it. */
function actualCredits(group: LedgerReadGroup, tier: string | null): Rational | null {
  if (tier === "standard") return group.variants.credits_standard.value;
  if (tier === "fast") return group.variants.credits_fast.value;
  const extra = group.variants.extra_credits, standard = group.variants.credits_standard;
  return extra.value === null ? null : add(standard.subtotal, extra.subtotal);
}

/**
 * One window's answer from the ledger's stored sums: whole hours from the hour sums, the hours its boundaries cut from the
 * calls of those hours only. Every measure is a sum over cohorts of the stored sums; amounts stay exact until presented.
 */
function buildWindowDetail(sqlite: Database, card: RateCard, options: WindowOptions) {
  const ledger = codexLedgerReadContext(card);
  const from = Date.parse(options.from), until = Date.parse(options.until), end = options.inclusiveEnd ? until + 1 : until;
  const reason = codexLedgerPendingReason(sqlite, { ...ledger, range: { fromMs: from, toMs: until, endInclusive: options.inclusiveEnd } });
  if (reason) throw new SubscriptionFactsPending(`Codex window awaits background ledger preparation (${reason})`, "codex");
  const resolver = loadAccountResolver(sqlite, declarationsOf(options));
  const burnEnd = Math.min(Date.now(), until), burnStart = Math.max(from, burnEnd - BURN_SPAN_MS);
  const burnSpan = options.includeBurn !== false && options.homes.length && Number.isFinite(burnStart) && burnStart <= burnEnd
    ? { start: burnStart, end: burnEnd } : null;
  const units = options.homes.length ? windowUnits(sqlite, options, from, end, windowCuts(resolver, options, from, end, burnSpan)) : [];
  const bands = readCodexLedgerPublishedBands(sqlite);
  const denominators = new Map([...bands].map(([id, band]) => [id, band.coefficients.denominator]));
  const detail: CodexWindowDetail = { basis: "dated-standard-reference", rows: [], excluded_mirror_events: 0,
    excluded_counter_events: 0, unknown_speed_tokens: 0, invalid_token_events: 0 };
  const rows = new Map<string, ModelRow>();
  const cacheHours = new Map<string, CodexModelCacheHour>();
  const preview = contextReadScope(sqlite);
  let creditFunded: CreditFundedSums | null = null;
  const fundedHours = new Map<string,CreditFundedHour>();
  const fundedAmounts = new Map<string,{api:Rational;credits:Rational}>();
  let fundedApi=zero,fundedCredits=zero;
  type Surface = NonNullable<CodexWindowDetail["surfaces"]>[number] & { order: number; exact: Rational };
  const surfaces = new Map<string, Surface>();
  const byDate = new Map<string, Bucket>(), byBlock = new Map<number, Bucket>(), totals = emptyBucket();
  const modelCalls = new Map<Bucket, Map<string | null, number>>(), bucketAmounts = new Map<Bucket, Rational>();
  const bucketCredits = new Map<Bucket, Rational>();
  const unpriced = { tokens: 0, models: {} as Record<string, number> }, unpricedFirst = new Map<string, number>();
  const credits = { value: null as number | null, priced_credits: 0, unpriced_calls: 0, basis: detail.basis };
  let pricedCredits = zero;
  const burn = BURN_HOURS.map(hours => ({ label: hours === 168 ? "7d" : `${hours}h`, hours, calls: 0, tokens: 0, tokens_fresh: 0 }));
  const owner = options.account.toLowerCase(), blockMs = options.sessionMinutes * 60_000, origin = options.sessionOrigin ?? from;
  const spark = (model: string | null) => model === "gpt-5.3-codex-spark";
  // The canonical window admission (codexWindowAdapter): the other counter's model, the reserve tier, credit funding, another reset.
  const counterExcludes = (row: LedgerStoredGroup) => options.filterCounter !== false
    && ((options.limitId === "codex" ? spark(row.model) : options.limitId.includes("spark") ? !spark(row.model) : false)
      || row.model === CODEX_RESERVE_MODEL || row.billing_mode === "credits" || row.billing_mode === "business_credits"
      || options.anchor != null && row.meter_reset != null && Math.abs(row.meter_reset - options.anchor) > 120);
  function fold(bucket: Bucket, model: string | null, calls: number, tokens: number, fresh: number, api: Rational | null, credit: Rational | null) {
    bucket.calls += calls; bucket.tokens += tokens; bucket.tokens_fresh += fresh;
    bucketAmounts.set(bucket, add(bucketAmounts.get(bucket) ?? zero, api ?? zero));
    if (api === null) bucket.usd_partial = true;
    bucketCredits.set(bucket, add(bucketCredits.get(bucket) ?? zero, credit ?? zero));
    if (credit === null) bucket.credits_partial = true;
    const names = modelCalls.get(bucket) ?? new Map<string | null, number>();
    names.set(model, (names.get(model) ?? 0) + calls); modelCalls.set(bucket, names);
  }
  // Cohorts in the order of their first calls: rows, surfaces and unpriced models that tie keep their first appearance.
  const ordered = units.map(unit => ({ ...unit, firstMs: Date.parse(unit.group.first_ts), lastMs: Date.parse(unit.group.last_ts) }))
    .sort((a, b) => a.firstMs - b.firstMs || a.from - b.from);
  const days = sqliteLocalDays(sqlite, [...new Set(ordered.map(unit => unit.from))]);
  let order = 0;
  for (const { from: at, group: stored, firstMs, lastMs } of ordered) {
    // The account of the cohort's source at its instants (no period boundary falls inside a cohort).
    const account = codexEventOwner(resolver.resolve("codex", stored.source, null, new Date(at).toISOString()).account, stored);
    if (account?.toLowerCase() !== owner) continue;
    const calls = Number(stored.calls);
    if (stored.copy_state !== "canonical") { detail.excluded_mirror_events += calls; continue; }
    if (counterExcludes(stored)) {
      // Funding precedes reset exclusion in the shared window adapter; Spark belongs to another counter.
      if (preview && stored.billing_mode === "credits" && !spark(stored.model)) {
        const fundedGroup=projectContextGroup(sqlite,deriveCodexLedgerGroup(stored,denominators,ledger.policy),ledger.policy);
        const api=fundedGroup.variants.api_standard.value, credit=fundedGroup.variants.credits_standard.value;
        const tokens=invalidCalls(stored)===0n ? Number(fundedGroup.tokensReported) : 0;
        creditFunded ??= { calls:0,tokens:0,credits:0,credits_unpriced:0,api_standard:0,api_unpriced:0,
          first:stored.first_ts,last:stored.last_ts,hours:[] };
        creditFunded.calls+=calls;creditFunded.tokens+=tokens;
        fundedCredits=add(fundedCredits,credit??zero);
        fundedApi=add(fundedApi,api??zero);
        if(credit===null)creditFunded.credits_unpriced+=calls;
        if(api===null)creditFunded.api_unpriced+=calls;
        if(Date.parse(stored.first_ts)<Date.parse(creditFunded.first))creditFunded.first=stored.first_ts;
        if(Date.parse(stored.last_ts)>Date.parse(creditFunded.last))creditFunded.last=stored.last_ts;
        const hour=new Date(Math.floor(at/HOUR_MS)*HOUR_MS).toISOString();
        const values=fundedHours.get(hour)??[hour,0,0,0,0];
        values[1]+=calls;values[2]+=tokens;
        const amounts=fundedAmounts.get(hour)??{api:zero,credits:zero};
        amounts.api=add(amounts.api,api??zero);amounts.credits=add(amounts.credits,credit??zero);fundedAmounts.set(hour,amounts);
        fundedHours.set(hour,values);
      }
      detail.excluded_counter_events += calls; continue;
    }
    const group = projectContextGroup(sqlite,deriveCodexLedgerGroup(stored, denominators, ledger.policy),ledger.policy);
    const valid = invalidCalls(stored) === 0n;
    if (!valid) detail.invalid_token_events += calls;
    const tokens = valid ? Number(group.tokensReported) : 0, fresh = valid ? tokens - Number(stored.cached) : 0;
    const tier = group.tier ?? "unknown", speed = tier === "standard" || tier === "fast" ? tier : "unknown";
    if (speed === "unknown") detail.unknown_speed_tokens += tokens;
    const api = group.variants.api_standard, credit = group.variants.credits_standard, model = stored.model;
    if (api.value === null) {
      const name = model ?? "?";
      unpriced.tokens += tokens; unpriced.models[name] = (unpriced.models[name] ?? 0) + tokens;
      if (!unpricedFirst.has(name)) unpricedFirst.set(name, order);
    }
    if (credit.value === null) credits.unpriced_calls += calls;
    else pricedCredits = add(pricedCredits, credit.value);
    fold(totals, model, calls, tokens, fresh, api.value, credit.value);
    const surfaceName = stored.surface ?? "?";
    const surface = surfaces.get(surfaceName) ?? { name: surfaceName, calls: 0, tokens: 0, fresh: 0, usd: 0, usd_partial: false, order, exact: zero };
    surface.calls += calls; surface.tokens += tokens; surface.fresh += fresh; surface.exact = add(surface.exact, api.value ?? zero);
    surface.usd_partial ||= api.value === null; surfaces.set(surfaceName, surface);
    const dayKey = days.get(at)!;
    const day = byDate.get(dayKey) ?? emptyBucket(); byDate.set(dayKey, day); fold(day, model, calls, tokens, fresh, api.value, credit.value);
    const blockIndex = Math.floor((at - origin) / blockMs);
    const block = byBlock.get(blockIndex) ?? emptyBucket(); byBlock.set(blockIndex, block); fold(block, model, calls, tokens, fresh, api.value, credit.value);
    if (burnSpan && at <= burnSpan.end) for (const window of burn) if (at >= Math.max(burnSpan.start, burnSpan.end - window.hours * HOUR_MS)) {
      window.calls += calls; window.tokens += tokens; window.tokens_fresh += fresh;
    }
    const apiBand = bands.get(stored.api_band), creditBand = bands.get(stored.credit_band);
    const apiReason = reasonOf(api), creditReason = reasonOf(credit);
    const key = JSON.stringify([model, speed, apiBand?.id ?? null, apiBand?.band === "long", creditBand?.id ?? null, creditBand?.band === "long",
      apiReason, creditReason, apiBand?.id ?? null, creditBand?.id ?? null]);
    const apiParts = priceParts(group, apiBand, originalContextApi(sqlite,group,api.value)), creditParts = priceParts(group, creditBand, credit.value);
    const extraParts=preview?.bucketParts?.get(stored);
    if(apiParts && extraParts) {
      for(const part of ["input","cached","cache_write","output"] as const)apiParts[part]=add(apiParts[part],extraParts[part]);
      apiParts.total=[apiParts.input,apiParts.cached,apiParts.cache_write,apiParts.output].reduce(add,zero);
      if(api.value!==null && !equal(apiParts.total,api.value))throw new Error("Saved context bucket parts disagree with the preview total");
    }
    const actualApi = tier === "standard" ? api.value : group.variants.api_actual.value, actualCredit = actualCredits(group, group.tier);
    let entry = rows.get(key);
    if (!entry) {
      const exact = (band: PublishedCodexLedgerBand | undefined): ExactParts => ({ ...partsHead(band!), input: zero, cached: zero, cache_write: zero, output: zero, total: zero });
      entry = { row: { model: model ?? "?", speed, first: stored.first_ts, last: stored.last_ts, calls: 0, input: 0, cached: 0, cache_write: 0, output: 0,
        reasoning: 0, tokens: 0, long_context: apiBand?.band === "long", api: null, credits: null, actual_api: null, actual_credits: null,
        unpriced_reason: apiReason ?? creditReason }, firstMs, lastMs, order,
        api: apiParts && exact(apiBand), credits: creditParts && exact(creditBand), actualApi: zero, actualCredits: zero };
      rows.set(key, entry);
    }
    for (const [target, parts] of [[entry.api, apiParts], [entry.credits, creditParts]] as const) if (target && parts)
      for (const part of ["input", "cached", "cache_write", "output", "total"] as const) target[part] = add(target[part], parts[part]);
    entry.actualApi = entry.actualApi !== null && actualApi !== null ? add(entry.actualApi, actualApi) : null;
    entry.actualCredits = entry.actualCredits !== null && actualCredit !== null ? add(entry.actualCredits, actualCredit) : null;
    if (firstMs < entry.firstMs) { entry.firstMs = firstMs; entry.row.first = stored.first_ts; }
    if (lastMs > entry.lastMs) { entry.lastMs = lastMs; entry.row.last = stored.last_ts; }
    const row = entry.row;
    row.calls += calls; row.tokens += tokens;
    if (valid) {
      const input = Number(group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown!);
      row.input += input;
      row.cached += Number(stored.cached); row.output += Number(stored.output);
      // The same admitted cohorts as the model totals, retaining time before price groups collapse it.
      const hour = new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();
      const cacheKey = JSON.stringify([row.model, hour]);
      const cache = cacheHours.get(cacheKey) ?? { model: row.model, hour, calls: 0, input: 0, cached: 0 };
      cache.calls += calls; cache.input += input; cache.cached += Number(stored.cached);
      cacheHours.set(cacheKey, cache);
    }
    row.cache_write += Number(stored.writes); row.reasoning += Number(stored.reasoning);
    order++;
  }
  // Ties keep the order of first appearance (the call-by-call order of the time axis).
  detail.rows = [...rows.values()].sort((a, b) => b.row.tokens - a.row.tokens || a.order - b.order).map(entry => ({ ...entry.row,
    api: entry.api && presentParts(entry.api), credits: entry.credits && presentParts(entry.credits),
    actual_api: entry.actualApi === null ? null : ledgerPresentationNumber(entry.actualApi),
    actual_credits: entry.actualCredits === null ? null : ledgerPresentationNumber(entry.actualCredits) }));
  detail.cache_timeline = { from: new Date(from).toISOString(), until: new Date(end).toISOString(),
    hours: [...cacheHours.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.model.localeCompare(b.model)) };
  for (const [bucket, amount] of bucketCredits) bucket.credits = ledgerPresentationNumber(amount);
  for (const [bucket, amount] of bucketAmounts) {
    bucket.usd = ledgerPresentationNumber(amount);
    bucket.usd_exact = { n: String(amount.n), d: String(amount.d) };
  }
  // The most called model of each bucket; a tie goes to the model without a name, then the first name in code-unit order.
  for (const [bucket, names] of modelCalls) for (const [name, count] of names) {
    if (count > bucket.top_calls || count === bucket.top_calls && name !== bucket.top_model
      && (name === null || bucket.top_model !== null && name < bucket.top_model)) { bucket.top_calls = count; bucket.top_model = name; }
  }
  detail.surfaces = [...surfaces.values()].sort((a, b) => b.tokens - a.tokens || a.order - b.order)
    .map(({ order: _order, exact, ...surface }) => ({ ...surface, usd: ledgerPresentationNumber(exact) }));
  unpriced.models = Object.fromEntries([...unpricedFirst].sort((a, b) => a[1] - b[1]).map(([name]) => [name, unpriced.models[name]!]));
  credits.priced_credits = ledgerPresentationNumber(pricedCredits);
  credits.value = credits.unpriced_calls || !totals.calls ? null : credits.priced_credits;
  // Exact window/reading scope; totals use its jointly priced ratio (API-only calls may differ).
  // Project/day/session/model scopes have no matching stored split.
  if (options.project === undefined && options.filterCounter !== false && options.limitId === "codex" && options.anchor !== null) {
    const matches = readContextRows(sqlite, options.account, null, options.from, options.until)
      .filter(row => Math.abs(Date.parse(row.reset_ts) / 1000 - options.anchor!) <= 120
        && Date.parse(row.start_ts) <= from && Date.parse(row.end_ts) >= until)
      .map(row => contextPriceOfSpan([row], options.from, options.until, !!options.inclusiveEnd))
      .filter(price => price !== undefined);
    if (matches.length === 1) totals.context_price = matches[0];
  }
  if(creditFunded){
    creditFunded.api_standard=ledgerPresentationNumber(fundedApi);creditFunded.credits=ledgerPresentationNumber(fundedCredits);
    creditFunded.hours=[...fundedHours.values()].sort((a,b)=>a[0].localeCompare(b[0])).map(hour=>{
      const amount=fundedAmounts.get(hour[0])!;hour[3]=ledgerPresentationNumber(amount.credits);hour[4]=ledgerPresentationNumber(amount.api);return hour;
    });
  }
  return { detail, byDate, byBlock, totals, unpriced, credits, burn: options.includeBurn === false ? [] : burn,
    ...(preview?{creditFunded}: {}) };
}

/** Historical valuation is independent of the moving burn-rate clock. */
export function readCodexWindowDetail(sqlite: Database, card: RateCard, options: WindowOptions) {
  return withReadSnapshot(sqlite, () => buildWindowDetail(sqlite, card, options));
}
