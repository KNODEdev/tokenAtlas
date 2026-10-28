import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "../db/sqlite";
import type { CodexModelCacheHour } from "../shared/codex-window-detail";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { readCodexWindowDetail } from "./codex-window-detail";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { getPublishedCodexLedgerGroup, readCodexEventRange, resolveCodexLedgerEventOwner } from "./codex-priced-events";
import { loadAccountResolver } from "./account-resolver";
import { codexLedgerReadContext, ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { readCodexLedgerPublishedBands } from "../db/codex-price-ledger";
import { markCodexLedgerCopiesDirty, processCodexLedgerBatch } from "../db/codex-ledger-producer";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { codexHomeSource } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { readModelCacheHistory } from "./model-cache-history";
import { add, decimal, multiply, rational, type Rational } from "../db/price-ledger-exact";
import { CODEX_RESERVE_MODEL } from "./codex-window-comparison";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { card, codexCallsScene as scene, openedDatabases, type SceneOptions as Options } from "./codex-window-calls.fixture";

/**
 * The window detail is built from the ledger's stored sums (whole hours, and the parts of hours its boundaries cut). This
 * reference reads the same window call by call, as the detail was computed before (codex-window-detail.ts until 06.10),
 * with amounts summed exactly: both must give the same answer for windows whose sessions, local days, burn spans and
 * account periods cut hours, with mirrors, counter exclusions, invalid calls and unpriced models among the calls.
 */
afterEach(() => { for (const db of openedDatabases.splice(0)) db.close(); setSystemTime(); });

/** The window read call by call (the previous implementation), every amount summed exactly. */
function referenceDetail(db: Database, options: Options): ReturnType<typeof readCodexWindowDetail> {
  const ledger = codexLedgerReadContext(card), config = resolveCodexAccountingConfig(card);
  const resolver = loadAccountResolver(db, options.homeToSubId ? subscriptionDeclarations(options.homeToSubId) : []);
  const bands = readCodexLedgerPublishedBands(db);
  const end = options.inclusiveEnd ? new Date(Date.parse(options.until) + 1).toISOString() : options.until;
  const where = ["l.instant_ms >= ?", `l.instant_ms ${options.inclusiveEnd ? "<=" : "<"} ?`, `e.home IN (${options.homes.map(() => "?").join(",")})`];
  const params: SQLQueryBindings[] = [Date.parse(options.from), Date.parse(options.until), ...options.homes];
  // The scene's rule gives project 7 to the calls whose place names project "seven".
  if (options.project) { where.push("e.project = ?"); params.push(options.project === "7" ? "seven" : `unknown:${options.project}`); }
  const accepted = new Set((db.query(`SELECT e.home,e.path,e.source_offset FROM codex_price_ledger_events l
    JOIN codex_price_ledger_copies c ON c.id=l.copy_id JOIN events e ON e.home IS c.home AND e.path IS c.path AND e.source_offset=l.source_offset
    WHERE ${where.join(" AND ")}`).all(...params) as Array<{ home: string; path: string; source_offset: number }>)
    .map(row => JSON.stringify([row.home, row.path, row.source_offset])));
  const calls = readCodexEventRange(db, config, options.from, end, undefined, ledger)
    .filter(event => accepted.has(JSON.stringify([event.home, event.path, event.source_offset])));
  type Bucket = { calls: number; tokens: number; tokens_fresh: number; usd: number; usd_exact?: { n: string; d: string }; usd_partial?: boolean;
    top_model: string | null; top_calls: number; credits?: number; credits_partial?: boolean };
  const empty = (): Bucket => ({ calls: 0, tokens: 0, tokens_fresh: 0, usd: 0, top_model: null, top_calls: 0 });
  const totals = empty(), byDate = new Map<string, Bucket>(), byBlock = new Map<number, Bucket>();
  const amounts = new Map<Bucket, Rational>(), counts = new Map<Bucket, Map<string, number>>(), creditAmounts = new Map<Bucket, Rational>();
  const detail = { basis: "dated-standard-reference" as const, rows: [] as unknown[], excluded_mirror_events: 0, excluded_counter_events: 0,
    unknown_speed_tokens: 0, invalid_token_events: 0, surfaces: [] as unknown[] };
  const rows = new Map<string, Record<string, unknown> & { tokens: number; exact: Record<string, Rational | null> }>();
  const surfaces = new Map<string, { name: string; calls: number; tokens: number; fresh: number; usd: Rational; usd_partial: boolean }>();
  const cacheHours = new Map<string, CodexModelCacheHour>();
  const unpriced = { tokens: 0, models: {} as Record<string, number> };
  let pricedCredits = rational(0n), unpricedCalls = 0;
  const burnEnd = Math.min(Date.now(), Date.parse(options.until)), burnStart = Math.max(Date.parse(options.from), burnEnd - 168 * 3_600_000);
  const burn = [1, 6, 24, 168].map(hours => ({ label: hours === 168 ? "7d" : `${hours}h`, hours, calls: 0, tokens: 0, tokens_fresh: 0 }));
  const fold = (bucket: Bucket, model: string | null, tokens: number, fresh: number, api: Rational | null, credit: Rational | null) => {
    bucket.calls++; bucket.tokens += tokens; bucket.tokens_fresh += fresh;
    amounts.set(bucket, add(amounts.get(bucket) ?? rational(0n), api ?? rational(0n)));
    if (api === null) bucket.usd_partial = true;
    creditAmounts.set(bucket, add(creditAmounts.get(bucket) ?? rational(0n), credit ?? rational(0n)));
    if (credit === null) bucket.credits_partial = true;
    const names = counts.get(bucket) ?? new Map<string, number>(), name = model ?? "?", count = (names.get(name) ?? 0) + 1;
    names.set(name, count); counts.set(bucket, names);
    if (count > bucket.top_calls || count === bucket.top_calls && model !== bucket.top_model
      && (model === null || bucket.top_model !== null && model < bucket.top_model)) { bucket.top_calls = count; bucket.top_model = model; }
  };
  const parts = (group: NonNullable<ReturnType<typeof getPublishedCodexLedgerGroup>>, bandId: number, value: Rational | null) => {
    if (value === null) return null;
    const band = bands.get(bandId)!, cost = (key: "in_uncached" | "in_cache_read" | "in_cache_write" | "out_total", tokens: bigint) =>
      multiply(rational(tokens, 1_000_000n), multiply(decimal(band.rates[key] ?? "0"), decimal(band.multiplier)));
    const input = cost("in_uncached", group.tokens.in_uncached!), cached = cost("in_cache_read", group.tokens.in_cache_read!),
      cache_write = cost("in_cache_write", group.tokens.in_cache_write_unknown!), output = cost("out_total", group.tokens.out_total!);
    const rule = JSON.parse(band.evidence) as { id: string; sources: string[]; confidence: string };
    return { head: { rates: Object.fromEntries(Object.entries(band.rates).map(([key, rate]) => [key, rate == null ? null
      : ledgerPresentationNumber(multiply(decimal(rate), decimal(band.multiplier)))])), rule_id: rule.id, sources: rule.sources, confidence: rule.confidence },
      values: { input, cached, cache_write, output, total: [input, cached, cache_write, output].reduce(add, rational(0n)) } };
  };
  for (const event of calls) {
    const group = getPublishedCodexLedgerGroup(event)!;
    if (resolveCodexLedgerEventOwner(resolver, event)?.toLowerCase() !== options.account.toLowerCase()) continue;
    if ((event as { copy_state?: string }).copy_state !== "canonical") { detail.excluded_mirror_events++; continue; }
    const spark = event.model === "gpt-5.3-codex-spark";
    if (options.filterCounter !== false && ((options.limitId === "codex" ? spark : options.limitId.includes("spark") ? !spark : false)
      || event.model === CODEX_RESERVE_MODEL || event.billing_mode === "credits" || event.billing_mode === "business_credits"
      || options.anchor != null && event.meter_reset != null && Math.abs(event.meter_reset - options.anchor) > 120)) { detail.excluded_counter_events++; continue; }
    const valid = [event.in_tok, event.cached_in, event.cache_write, event.out_tok].every(n => Number.isSafeInteger(n) && n >= 0)
      && event.cached_in + event.cache_write <= event.in_tok;
    const tokens = valid ? event.in_tok + event.out_tok : 0, fresh = valid ? tokens - event.cached_in : 0;
    if (!valid) detail.invalid_token_events++;
    if (valid) {
      const model = event.model ?? "?", hour = new Date(Math.floor(event.instant_ms! / 3_600_000) * 3_600_000).toISOString();
      const key = JSON.stringify([model, hour]);
      const point = cacheHours.get(key) ?? { model, hour, calls: 0, input: 0, cached: 0 };
      point.calls++; point.input += event.in_tok; point.cached += event.cached_in;
      cacheHours.set(key, point);
    }
    const tier = event.speed ?? "unknown", speed = tier === "standard" || tier === "fast" ? tier : "unknown";
    if (speed === "unknown") detail.unknown_speed_tokens += tokens;
    const api = group.variants.api_standard, credit = group.variants.credits_standard;
    if (api.value === null) { unpriced.tokens += tokens; unpriced.models[event.model ?? "?"] = (unpriced.models[event.model ?? "?"] ?? 0) + tokens; }
    if (credit.value === null) unpricedCalls++; else pricedCredits = add(pricedCredits, credit.value);
    fold(totals, event.model, tokens, fresh, api.value, credit.value);
    const surface = surfaces.get(group.stored.surface ?? "?") ?? { name: group.stored.surface ?? "?", calls: 0, tokens: 0, fresh: 0, usd: rational(0n), usd_partial: false };
    surface.calls++; surface.tokens += tokens; surface.fresh += fresh; surface.usd = add(surface.usd, api.value ?? rational(0n));
    surface.usd_partial ||= api.value === null; surfaces.set(surface.name, surface);
    const dayKey = (db.query("SELECT date(?, 'localtime') day").get(event.ts) as { day: string }).day;
    const day = byDate.get(dayKey) ?? empty(); byDate.set(dayKey, day); fold(day, event.model, tokens, fresh, api.value, credit.value);
    const index = Math.floor((event.instant_ms! - (options.sessionOrigin ?? Date.parse(options.from))) / (options.sessionMinutes * 60_000));
    const block = byBlock.get(index) ?? empty(); byBlock.set(index, block); fold(block, event.model, tokens, fresh, api.value, credit.value);
    if (options.includeBurn !== false && event.instant_ms! >= burnStart && event.instant_ms! <= burnEnd)
      for (const window of burn) if (event.instant_ms! >= burnEnd - window.hours * 3_600_000) { window.calls++; window.tokens += tokens; window.tokens_fresh += fresh; }
    const apiBand = bands.get(group.stored.api_band), creditBand = bands.get(group.stored.credit_band);
    const apiReason = Object.keys(api.reasons)[0] ?? null, creditReason = Object.keys(credit.reasons)[0] ?? null;
    const key = JSON.stringify([event.model, speed, apiBand?.id ?? null, apiBand?.band === "long", creditBand?.id ?? null, creditBand?.band === "long",
      apiReason, creditReason, apiBand?.id ?? null, creditBand?.id ?? null]);
    const apiParts = parts(group, group.stored.api_band, api.value), creditParts = parts(group, group.stored.credit_band, credit.value);
    const actualApi = tier === "standard" ? api.value : group.variants.api_actual.value;
    const actualCredits = tier === "standard" ? credit.value : tier === "fast" ? group.variants.credits_fast.value
      : group.variants.extra_credits.value === null ? null : add(credit.subtotal, group.variants.extra_credits.subtotal);
    let row = rows.get(key);
    if (!row) {
      row = { model: event.model ?? "?", speed, first: event.ts, last: event.ts, calls: 0, input: 0, cached: 0, cache_write: 0, output: 0, reasoning: 0,
        // The compared stored cohorts carry quantities, without source-counter completeness evidence.
        cache_write_complete: false,
        tokens: 0, long_context: apiBand?.band === "long", api: apiParts?.head ?? null, credits: creditParts?.head ?? null, actual_api: null, actual_credits: null,
        unpriced_reason: apiReason ?? creditReason, exact: { actual_api: rational(0n), actual_credits: rational(0n),
          ...Object.fromEntries(["input", "cached", "cache_write", "output", "total"].flatMap(part => [[`api.${part}`, rational(0n)], [`credits.${part}`, rational(0n)]])) } };
      rows.set(key, row);
    }
    for (const [prefix, priced] of [["api", apiParts], ["credits", creditParts]] as const) if (priced)
      for (const [part, value] of Object.entries(priced.values)) row.exact[`${prefix}.${part}`] = add(row.exact[`${prefix}.${part}`]!, value);
    row.exact.actual_api = row.exact.actual_api !== null && actualApi !== null ? add(row.exact.actual_api!, actualApi) : null;
    row.exact.actual_credits = row.exact.actual_credits !== null && actualCredits !== null ? add(row.exact.actual_credits!, actualCredits) : null;
    if (event.instant_ms! < Date.parse(row.first as string)) row.first = event.ts;
    if (event.instant_ms! > Date.parse(row.last as string)) row.last = event.ts;
    (row.calls as number)++; row.tokens += tokens;
    if (valid) { (row.input as number) += event.in_tok; (row.cached as number) += event.cached_in; (row.output as number) += event.out_tok; }
    (row.cache_write as number) += Math.max(0, event.cache_write || 0); (row.reasoning as number) += Number(group.tokens.reasoning_out);
  }
  const present = (value: Rational | null | undefined) => value == null ? null : ledgerPresentationNumber(value);
  detail.rows = [...rows.values()].sort((a, b) => b.tokens - a.tokens).map(({ exact, ...row }) => ({ ...row,
    api: row.api ? { rates: (row.api as Record<string, unknown>).rates, ...Object.fromEntries(["input", "cached", "cache_write", "output", "total"]
      .map(part => [part, present(exact[`api.${part}`])])), rule_id: (row.api as Record<string, unknown>).rule_id,
      sources: (row.api as Record<string, unknown>).sources, confidence: (row.api as Record<string, unknown>).confidence } : null,
    credits: row.credits ? { rates: (row.credits as Record<string, unknown>).rates, ...Object.fromEntries(["input", "cached", "cache_write", "output", "total"]
      .map(part => [part, present(exact[`credits.${part}`])])), rule_id: (row.credits as Record<string, unknown>).rule_id,
      sources: (row.credits as Record<string, unknown>).sources, confidence: (row.credits as Record<string, unknown>).confidence } : null,
    actual_api: present(exact.actual_api), actual_credits: present(exact.actual_credits) }));
  detail.surfaces = [...surfaces.values()].sort((a, b) => b.tokens - a.tokens).map(surface => ({ ...surface, usd: present(surface.usd) }));
  for (const [bucket, amount] of creditAmounts) bucket.credits = ledgerPresentationNumber(amount);
  for (const [bucket, amount] of amounts) { bucket.usd = ledgerPresentationNumber(amount); bucket.usd_exact = { n: String(amount.n), d: String(amount.d) }; }
  const credits = { value: unpricedCalls || !totals.calls ? null : ledgerPresentationNumber(pricedCredits),
    priced_credits: ledgerPresentationNumber(pricedCredits), unpriced_calls: unpricedCalls, basis: detail.basis };
  const cache_timeline = { from: new Date(options.from).toISOString(), until: new Date(end).toISOString(),
    hours: [...cacheHours.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.model.localeCompare(b.model)) };
  return { detail: { ...detail, cache_timeline }, byDate, byBlock, totals, unpriced, credits, burn: options.includeBurn === false ? [] : burn } as unknown as ReturnType<typeof readCodexWindowDetail>;
}


test("a closed window from stored sums equals the call-by-call reference", () => {
  const { db, base } = scene();
  const expected = referenceDetail(db, base);
  expect(expected.totals.calls).toBeGreaterThan(200);
  expect(expected.detail.excluded_counter_events).toBeGreaterThan(20);
  expect(expected.detail.excluded_mirror_events).toBeGreaterThan(5);
  expect(expected.detail.invalid_token_events).toBeGreaterThan(0);
  expect(expected.unpriced.tokens).toBeGreaterThan(0);
  expect(readCodexWindowDetail(db, card, base)).toEqual(expected);
});

test("an open window (burn spans ending now), its end-inclusive observation and a project filter equal the reference", () => {
  const { db, base } = scene();
  setSystemTime(new Date("2026-09-12T09:37:12.345Z"));
  for (const options of [{ ...base, until: "2026-09-17T23:17:41.250Z" }, { ...base, until: "2026-09-12T09:31:00.000Z", inclusiveEnd: true },
    { ...base, project: "7" }, { ...base, limitId: "codex_spark", anchor: null, sessionMinutes: 60 },
    { ...base, filterCounter: false, includeBurn: false, sessionOrigin: Date.parse(base.from) - 1_250, account: "other" }]) {
    expect(readCodexWindowDetail(db, card, options)).toEqual(referenceDetail(db, options));
  }
});

test("a late call and a corrected call change the stored-sum answer exactly as the reference", () => {
  const { db, base } = scene();
  db.query(`INSERT INTO events (home,path,ts,model,in_tok,cached_in,cache_write,out_tok,speed,billing_mode,plan_type,source_offset)
    VALUES ('c:/own','c:/own/late.jsonl','2026-09-11T13:13:13.000Z','gpt-6-astra',5000,100,0,50,'standard','allowance','pro',1)`).run();
  db.exec("UPDATE events SET in_tok=in_tok+777 WHERE rowid IN (SELECT rowid FROM events WHERE home='c:/own' ORDER BY ts LIMIT 3)");
  prepareCodexLedgerFixture(db, card, base.homeToSubId);
  expect(readCodexWindowDetail(db, card, base)).toEqual(referenceDetail(db, base));
});

test("cache hours reconcile to every model total and survive a readonly reopen without ledger writes", () => {
  const { db, base } = scene();
  const expected = readCodexWindowDetail(db, card, base).detail;
  const hours = expected.cache_timeline!.hours;
  for (const model of new Set(expected.rows.map(row => row.model))) {
    const sum = (rows: Array<{ input: number; cached: number }>) => rows.reduce((total, row) =>
      ({ input: total.input + row.input, cached: total.cached + row.cached }), { input: 0, cached: 0 });
    expect(sum(hours.filter(row => row.model === model))).toEqual(sum(expected.rows.filter(row => row.model === model)));
  }
  const reopened = Database.deserialize(db.serialize(), { readonly: true });
  try {
    const changes = () => (reopened.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    for (let repeat = 0; repeat < 2; repeat++) expect(readCodexWindowDetail(reopened, card, base).detail).toEqual(expected);
    expect(changes()).toBe(before);
  } finally { reopened.close(); }
});

test("an incrementally corrected cache cohort equals both a full fill and the call-by-call reference", () => {
  const { db, base } = scene();
  const before = readCodexWindowDetail(db, card, base).detail.cache_timeline;
  const copy = { home: "c:/own", path: "c:/own/session-2.jsonl" };
  db.transaction(() => {
    db.query("UPDATE events SET in_tok=in_tok+1000,cached_in=cached_in+900 WHERE home=? AND path=?").run(copy.home, copy.path);
    markCodexLedgerCopiesDirty(db, [copy]);
  }).immediate();
  const ledger = codexLedgerReadContext(card), declarations = subscriptionDeclarations(base.homeToSubId!);
  const options = { bands: ledger.policy.baseBands, policy: ledger.policy.policy, rulesRevision: ledger.rulesRevision!,
    factsRevision: readCodexLedgerState(db)!.covered, anchorOf: (home: string | null, path: string) =>
      ({ archiveId: "fixture", sourceId: home === null ? "" : codexHomeSource(home, declarations, ARCHIVE_LOGICAL_ROOT) ?? "", relativePath: path }) };
  let ready = false;
  for (let step = 0; step < 100 && !ready; step++) ready = processCodexLedgerBatch(db, options).ready;
  expect(ready).toBe(true);
  const incremental = readCodexWindowDetail(db, card, base);
  expect(incremental.detail.cache_timeline).not.toEqual(before);
  expect(incremental).toEqual(referenceDetail(db, base));
  const historyContext = { sqlite: db, rateCards: card, accounts: { subscriptions: [{ id: "acct", vendor: "codex" }] } };
  const historyRange = { account: "acct", model: "gpt-6-astra", since: "2026-09-10", until: "2026-09-13" };
  const history = readModelCacheHistory(historyContext, historyRange);
  prepareCodexLedgerFixture(db, card, base.homeToSubId);
  expect(readCodexWindowDetail(db, card, base)).toEqual(incremental);
  expect(readModelCacheHistory(historyContext, historyRange)).toEqual(history);
});
