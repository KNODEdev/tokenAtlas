import type { Database } from "bun:sqlite";
import { hasFxRates, readFxRates, storeFxRates, type FxRate } from "../db/fx-rates";
import { hasBillingCycles, markBillingCyclesDirty } from "../db/billing-cycles";

/**
 * Exchange rates for payments in other currencies than USD (user decision 18.10): the NBP table A mid rate of the last
 * business day before the payment day, fetched once and stored in `fx_rates` (db/fx-rates.ts). A billing cycle whose
 * payment has no stored rate is flagged `fx_rate_missing` by the producer; this job reads those flags, fetches the rates off
 * the writer (the request runs between turns, never on a screen read) and stores them in a later turn, marking the cycles
 * of the accounts paid that day. Without network the flag stays and the job tries again later; no amount becomes 0.
 */
export const NBP_SOURCE = "nbp-a";
const NBP_URL = "https://api.nbp.pl/api/exchangerates/rates/a";
/** Days looked back for the last table before a payment (holidays and long weekends). */
const LOOKBACK_DAYS = 14;
/** NBP serves at most 93 days per request. */
const MAX_SPAN_DAYS = 80;
const RETRY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export interface FxNeed { currency: string; day: string }
type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const shift = (onDay: string, days: number) => new Date(Date.parse(`${onDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const needKey = (need: FxNeed) => `${need.currency}|${need.day}`;

/** The rates the stored cycles wait for: their payment currency and USD on each payment day, minus the stored ones. */
export function fxRateNeeds(db: Database): FxNeed[] {
  if (!hasBillingCycles(db) || !hasFxRates(db)) return [];
  const rows = db.query(`SELECT DISTINCT json_extract(detail, '$.fx.currency') AS currency, json_extract(detail, '$.fx.day') AS day
    FROM billing_cycles WHERE flags LIKE '%"fx_rate_missing"%'`).all() as Array<{ currency: string | null; day: string | null }>;
  const stored = readFxRates(db), needs = new Map<string, FxNeed>();
  for (const row of rows) {
    if (!row.currency || !row.day || !/^[A-Z]{3}$/.test(row.currency)) continue;
    for (const currency of row.currency === "PLN" ? ["USD"] : ["USD", row.currency]) {
      const need = { currency, day: row.day };
      if (!stored.has(needKey(need))) needs.set(needKey(need), need);
    }
  }
  return [...needs.values()].sort((a, b) => needKey(a).localeCompare(needKey(b)));
}

/** NBP table A rows of one currency in a day range, as `{ no, effectiveDate, mid }`; an empty range answers 404. */
async function nbpRange(fetchImpl: FetchLike, currency: string, from: string, until: string): Promise<Array<{ no: string; effectiveDate: string; mid: number }>> {
  const response = await fetchImpl(`${NBP_URL}/${currency.toLowerCase()}/${from}/${until}/?format=json`,
    { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`NBP ${currency} ${from}..${until}: HTTP ${response.status}`);
  const body = await response.json() as { rates?: Array<{ no?: unknown; effectiveDate?: unknown; mid?: unknown }> };
  return (body.rates ?? []).filter((rate) => typeof rate.effectiveDate === "string" && typeof rate.mid === "number" && rate.mid > 0)
    .map((rate) => ({ no: String(rate.no ?? ""), effectiveDate: rate.effectiveDate as string, mid: rate.mid as number }));
}

/**
 * The rates of the needed payment days: per currency, the days are fetched in ranges of at most 80 days (plus the look-back),
 * and each day takes the last table published before it. A day without such a table stays unresolved.
 */
export async function fetchNbpRates(needs: readonly FxNeed[], fetchImpl: FetchLike = fetch as unknown as FetchLike,
  onError: (error: unknown) => void = (error) => { throw error; }): Promise<FxRate[]> {
  const byCurrency = new Map<string, string[]>();
  for (const need of needs) byCurrency.set(need.currency, [...(byCurrency.get(need.currency) ?? []), need.day]);
  const rates: FxRate[] = [];
  for (const [currency, days] of byCurrency) {
    const sorted = [...new Set(days)].sort();
    for (let first = 0; first < sorted.length;) {
      let last = first;
      while (last + 1 < sorted.length && Date.parse(sorted[last + 1]!) - Date.parse(sorted[first]!) <= MAX_SPAN_DAYS * DAY_MS) last++;
      // A failed range is reported and skipped: the other ranges and currencies still resolve.
      let tables: Awaited<ReturnType<typeof nbpRange>> = [];
      try { tables = await nbpRange(fetchImpl, currency, shift(sorted[first]!, -LOOKBACK_DAYS), shift(sorted[last]!, -1)); }
      catch (error) { onError(error); }
      for (const onDay of sorted.slice(first, last + 1)) {
        const table = tables.filter((row) => row.effectiveDate < onDay).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).at(-1);
        if (table) rates.push({ currency, forDay: onDay, plnPerUnit: table.mid, effectiveDay: table.effectiveDate, source: NBP_SOURCE, tableNo: table.no || null });
      }
      first = last + 1;
    }
  }
  return rates;
}

/** Fetches in flight and their results, kept by this process between turns; nothing here is a published result. */
const state = { inFlight: false, fetched: [] as FxRate[], retryAt: new Map<string, number>(), lastError: null as string | null };

export interface FxRatesOptions {
  canWrite: () => boolean;
  now?: number;
  fetchImpl?: FetchLike;
  /** False: never start a request (tests, `TOKENATLAS_FX_FETCH=0`). */
  network?: boolean;
}
export interface FxRatesTurn { stored: number; waiting: number; fetching: boolean; error: string | null }

/** One turn: store what arrived (marking the cycles paid on those days), then start a request for what is still missing. */
export function advanceFxRates(db: Database, options: FxRatesOptions): FxRatesTurn | null {
  if (!hasFxRates(db) || !hasBillingCycles(db)) return null;
  const now = options.now ?? Date.now();
  let stored = 0;
  if (state.fetched.length && options.canWrite()) {
    const arrived = state.fetched;
    state.fetched = [];
    // A failed write (a locked database) keeps the rates for the next turn instead of waiting for the retry time.
    try { db.transaction(() => {
      const added = storeFxRates(db, arrived, now);
      stored = added.length;
      const days = new Set(added.map((rate) => rate.forDay));
      if (!days.size) return;
      const paid = db.query(`SELECT provider, account, json_extract(detail, '$.fx.day') AS day FROM billing_cycles WHERE flags LIKE '%"fx_rate_missing"%'`)
        .all() as Array<{ provider: string; account: string; day: string | null }>;
      for (const row of paid) if (row.day && days.has(row.day)) markBillingCyclesDirty(db, row.provider, row.account, Date.parse(`${row.day}T00:00:00Z`));
    }).immediate(); }
    catch (error) { state.fetched.unshift(...arrived); throw error; }
  }
  const needs = fxRateNeeds(db).filter((need) => (state.retryAt.get(needKey(need)) ?? 0) <= now);
  const network = options.network ?? process.env.TOKENATLAS_FX_FETCH !== "0";
  if (needs.length && network && !state.inFlight) {
    state.inFlight = true;
    // A day the request does not resolve (or a failure) waits before it is asked again.
    for (const need of needs) state.retryAt.set(needKey(need), now + RETRY_MS);
    let failed: string | null = null;
    void fetchNbpRates(needs, options.fetchImpl, (error) => { failed ??= error instanceof Error ? error.message : String(error); })
      .then((rates) => { state.fetched.push(...rates); state.lastError = failed; })
      .finally(() => { state.inFlight = false; });
  }
  return { stored, waiting: needs.length, fetching: state.inFlight, error: state.lastError };
}

/** Test hook: forget fetches in flight, results and retry times. */
export function resetFxRatesState(): void {
  state.inFlight = false; state.fetched = []; state.retryAt.clear(); state.lastError = null;
}
/** Test hook: wait until the request started by the last turn has settled. */
export async function settleFxRates(): Promise<void> {
  while (state.inFlight) await new Promise((resolve) => setTimeout(resolve, 1));
}
