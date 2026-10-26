import type { Database } from "bun:sqlite";
import type { AccountResolver } from "./account-resolver";
import type { CodexEventFilter, CodexLedgerReadContext } from "../db/codex-ledger-adapters";
import { normEraKey } from "./eras";
import type { CodexAccountingConfig } from "./codex-accounting-pricing";
import type { CalibrationEvent } from "./codex-calibration";
import { readCodexWindowCohorts, resolveCodexLedgerEventOwner, readCodexEventRange } from "./codex-priced-events";
import type { WindowCuts, ReferencePlan, WindowEventReader, CachedWindowEventReader } from "./window-usage-contracts";
import type { RateCard } from "./pricing";
import type { LedgerEvent } from "../db/usage-ledger-events";
import { prepareCodexPricing, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { usageLedgerProviderOf } from "../db/usage-ledger-read";
import { usageLedgerEventsFor } from "../db/usage-ledger-events";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";

/**
 * Where and when calls can belong to `owner`: the ranges of the account's read plan (exactly the instants its
 * periods give it, per source) with the ledger's spellings of each source. A business pool (`::business`) is its
 * account's calls in business credits. Undefined reads every source (the pool of calls no period owns).
 */
function codexOwnedRanges(db: Database, resolver: AccountResolver, owner: string): CodexEventFilter["owned"] {
  const account = owner.replace(/::business$/, "");
  if (account === "codex-unassigned") return undefined;
  const spellings = new Map<string, string[]>();
  for (const { source } of db.query("SELECT DISTINCT source FROM codex_price_ledger_copies WHERE source IS NOT NULL").all() as Array<{ source: string }>) {
    const key = normEraKey(source);
    spellings.set(key, [...spellings.get(key) ?? [], source]);
  }
  return resolver.plan("codex", account).ranges.map(range => ({ sources: spellings.get(range.source) ?? [], from: range.from, until: range.until }))
    .filter(range => range.sources.length);
}

/** The account's canonical calls of `[start, end)` in cohorts that span none of `cuts` nor a bound of its own ranges. */
function codexCohorts(db: Database, resolver: AccountResolver, config: CodexAccountingConfig, ledger: CodexLedgerReadContext,
  owned: CodexEventFilter["owned"], account: string, start: string, end: string, cuts: WindowCuts): CalibrationEvent[] | null {
  if (!owned) return null;
  const owner = account.toLowerCase();
  return readCodexWindowCohorts(db, config, { from: Date.parse(start), until: Date.parse(end), owned,
    cuts: [...cuts.instants, ...owned.flatMap(range => [range.from, range.until])], activity: cuts.activity },
  event => resolveCodexLedgerEventOwner(resolver, event), ledger)
    .filter(event => event.account?.toLowerCase() === owner)
    .map(event => event.account === owner ? event : Object.assign(event, { account: owner }));
}

/**
 * With `referenceDay` (or the producer's `reference` plan) each Codex call also carries its valuation
 * at that day's prices.
 */
export function windowEventReader(db: Database, rateCards: RateCard, resolver: AccountResolver, referenceDay?: string,
  reference?: ReferencePlan): WindowEventReader & {
    codexAll(start:string,end:string):import('./codex-priced-events').RegisteredCodexEvent[];
    ledgerAll(provider:string,start:string,end:string):LedgerEvent[];
  } {
  let codex: { config: CodexAccountingConfig; ledger: CodexLedgerReadContext } | undefined;
  referenceDay ??= reference?.("codex")?.day;
  return {
    ...(reference ? { reference } : {}),
    codexAll(start,end) {
      codex ??= {config:prepareCodexPricing(resolveCodexAccountingConfig(rateCards)),ledger:{...codexLedgerReadContext(rateCards),...(referenceDay!==undefined?{referenceDay}:{})}};
      return readCodexEventRange(db,codex.config,start,end,event=>resolveCodexLedgerEventOwner(resolver,event),codex.ledger,{canonical:true});
    },
    ledgerAll(provider,start,end) {
      return usageLedgerProviderOf(provider)?usageLedgerEventsFor(db,provider,rateCards).load(start,end,undefined,undefined,undefined,true):[];
    },
    codex(account, start, end) {
      codex ??= { config: prepareCodexPricing(resolveCodexAccountingConfig(rateCards)),
        ledger: { ...codexLedgerReadContext(rateCards), ...(referenceDay !== undefined ? { referenceDay } : {}) } };
      const owner = account.toLowerCase();
      return readCodexEventRange(db, codex.config, start, end, event => resolveCodexLedgerEventOwner(resolver, event), codex.ledger,
        { owned: codexOwnedRanges(db, resolver, owner), canonical: true })
        .filter(event => (event as { copy_state?: unknown }).copy_state === "canonical" && event.account?.toLowerCase() === owner)
        .map(event => Object.assign(event, { account: owner }));
    },
    codexCohorts(account, start, end, cuts) {
      codex ??= { config: prepareCodexPricing(resolveCodexAccountingConfig(rateCards)),
        ledger: { ...codexLedgerReadContext(rateCards), ...(referenceDay !== undefined ? { referenceDay } : {}) } };
      return codexCohorts(db, resolver, codex.config, codex.ledger, codexOwnedRanges(db, resolver, account.toLowerCase()), account, start, end, cuts);
    },
    ledger(provider, account, start, end) {
      // A provider without a usage ledger has windows without tokens.
      if (!usageLedgerProviderOf(provider)) return [];
      const owner = account.toLowerCase();
      return usageLedgerEventsFor(db, provider, rateCards, resolver.plan(provider, owner)).load(start, end)
        .map(event => Object.assign(event, { account: owner }));
    },
  };
}

const DAY_MS = 86_400_000;

/**
 * Events the producer keeps loaded; whole days are evicted, least recently used first. A Codex call weighs
 * about four kilobytes here. On the full reference (first fill, two runs side by side on one machine):
 * 100 000 read 1.2 times the ledger, peak RSS 4.3 GB; 50 000 read 1.7 times, peak RSS 2.5 GB, 16 % longer.
 * The peak is mostly garbage of days read again, so a smaller limit keeps the worker well under 3 GB.
 */
const CACHED_EVENTS = 50_000;

/**
 * Ledger events of whole UTC days, kept by the producer between windows and turns of one connection, so
 * the windows of every account and counter read a day once instead of querying the ledger per window.
 * Windows are taken in time order, so the days a window needs are mostly the ones its predecessors loaded.
 * `fingerprint` names the inputs the loaded events depend on besides the ledger rows (rate cards and
 * identity declarations); a provider's days are dropped whenever a writer reports a change of its
 * ledger, ownership or periods (see `advanceWindowUsage`).
 */
export class WindowEventDays {
  private readonly days = new Map<string, { provider: string; events: unknown[] }>();
  private size = 0;
  /** Ledger events loaded so far. */
  loaded = 0;
  constructor(readonly fingerprint: string) {}
  /** `part` names a subset of the provider's day (Codex: one account's sources). */
  get<Event>(provider: string, day: number, load: () => Event[], part = ""): Event[] {
    const key = `${provider}\u0000${part}\u0000${day}`, found = this.days.get(key);
    if (found) { this.days.delete(key); this.days.set(key, found); return found.events as Event[]; }
    const events = load();
    this.loaded += events.length;
    this.days.set(key, { provider, events }); this.size += events.length;
    for (const [oldest, entry] of this.days) {
      if (this.size <= CACHED_EVENTS || oldest === key) break;
      this.days.delete(oldest); this.size -= entry.events.length;
    }
    return events;
  }
  drop(provider: string): void {
    for (const [key, entry] of this.days) if (entry.provider === provider) { this.days.delete(key); this.size -= entry.events.length; }
  }
}

/**
 * The events `windowEventReader` returns (same filter, order and owner) and the traffic `unownedTraffic`
 * counts, read through whole cached days: a range is the union of the days it touches, cut to its exact
 * bounds. Events are shared between the windows that read them: a window computation never changes an event,
 * and each window is computed from its read before the next read.
 */
export function cachedWindowEventReader(db: Database, rateCards: RateCard, resolver: AccountResolver, days: WindowEventDays,
  reference?: ReferencePlan): CachedWindowEventReader {
  let codex: { config: CodexAccountingConfig; ledger: CodexLedgerReadContext } | undefined;
  const referenceDay = reference?.("codex")?.day;
  const ownerRanges = new Map<string, CodexEventFilter["owned"]>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const dayStarts = (from: number, until: number) => {
    const out: number[] = [];
    for (let day = Math.floor(from / DAY_MS) * DAY_MS; day < until; day += DAY_MS) out.push(day);
    return out;
  };
  /** Eligible canonical usage-ledger events of every account with a recorded text instant in `[start, end)`. */
  function* ledgerRange(provider: string, start: string, end: string): Generator<LedgerEvent> {
    const lower = iso(Date.parse(start)), upper = iso(Date.parse(end));
    // The usage ledger cuts a range by the recorded text instant, so the days are text ranges too.
    for (const day of dayStarts(Date.parse(lower.slice(0, 10)), Date.parse(upper))) {
      const events = days.get(provider, day, () => usageLedgerEventsFor(db, provider, rateCards, null).load(iso(day), iso(day + DAY_MS)));
      for (const event of events) if (event.ts >= lower && event.ts < upper) yield event;
    }
  }
  return {
    ...(reference ? { reference } : {}),
    codex(account, start, end) {
      codex ??= { config: prepareCodexPricing(resolveCodexAccountingConfig(rateCards)),
        ledger: { ...codexLedgerReadContext(rateCards), ...(referenceDay !== undefined ? { referenceDay } : {}) } };
      const { config, ledger } = codex;
      const owner = account.toLowerCase(), from = Date.parse(start), until = Date.parse(end);
      let owned = ownerRanges.get(owner);
      if (!ownerRanges.has(owner)) ownerRanges.set(owner, owned = codexOwnedRanges(db, resolver, owner));
      const out: CalibrationEvent[] = [];
      // A range read cuts by the numeric instant, as the days do,
      for (const day of dayStarts(from, until)) {
        const events = days.get("codex", day, () => readCodexEventRange(db, config, iso(day), iso(day + DAY_MS),
          event => resolveCodexLedgerEventOwner(resolver, event), ledger, { owned, canonical: true }), owned ? owner.replace(/::business$/, "") : "");
        for (const event of events) if (event.instant_ms! >= from && event.instant_ms! < until
          && (event as { copy_state?: unknown }).copy_state === "canonical" && event.account?.toLowerCase() === owner)
          out.push(event.account === owner ? event : { ...event, account: owner });
      }
      // and orders it by the recorded text instant, then id.
      return out.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : Number((a as { id?: unknown }).id) - Number((b as { id?: unknown }).id));
    },
    codexCohorts(account, start, end, cuts) {
      codex ??= { config: prepareCodexPricing(resolveCodexAccountingConfig(rateCards)),
        ledger: { ...codexLedgerReadContext(rateCards), ...(referenceDay !== undefined ? { referenceDay } : {}) } };
      const owner = account.toLowerCase();
      if (!ownerRanges.has(owner)) ownerRanges.set(owner, codexOwnedRanges(db, resolver, owner));
      return codexCohorts(db, resolver, codex.config, codex.ledger, ownerRanges.get(owner), account, start, end, cuts);
    },
    ledger(provider, account, start, end) {
      if (!usageLedgerProviderOf(provider)) return [];
      const owner = account.toLowerCase(), plan = resolver.plan(provider, owner), out: LedgerEvent[] = [];
      // A window is computed from its events before the next range is read, so naming the owner on the shared
      // event serves this read whatever another account's read named before.
      for (const event of ledgerRange(provider, start, end))
        if (plan.owns(event.source, event.account_key, event.ts)) { event.account = owner; out.push(event); }
      return out;
    },
    unowned(provider, start, end) {
      let events = 0, tokens = 0;
      if (!usageLedgerProviderOf(provider)) return { events, tokens };
      for (const event of ledgerRange(provider, start, end)) {
        if (resolver.resolve(provider, event.source, event.account_key, event.ts).account !== null) continue;
        events++; tokens += TOKEN_BUCKETS.reduce((sum, bucket) => sum + event.quantities[bucket], 0);
      }
      return { events, tokens };
    },
  };
}
