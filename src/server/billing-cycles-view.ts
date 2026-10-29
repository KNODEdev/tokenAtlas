import {withFinalContext} from "./codex-context-final-read";
import type { Database } from "bun:sqlite";
import { normEraKey, normEraVendor } from "./eras";
import { hasBillingCycles } from "../db/billing-cycles";
import { billingCyclesPending, type CycleDetail, type StoredCycleRow } from "./billing-cycle-producer";
import type { BillingCycle, BillingCyclesAccount, BillingCyclesView } from "../shared/billing-cycles";
import { billingContextPrice, readContextRows } from "./context-price-read";
import { matchingContextPrice } from "../shared/context-price";
import { withReadSnapshot } from "../db/analysis";

/**
 * `GET /api/billing-cycles` (docs/billing-cycles-design-2026-10-08.md §6): one SELECT of the stored cycles, divided into
 * percentages for presentation. Nothing is derived or priced here; rows the producer still has to update are returned as
 * they are with `stale: true` and the reason in `pending`, and an account it has not filled yet has no cycles and `stale: true`.
 */
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const pct = (used: number | null, windows: number | null) => used === null || !windows ? null : round(used / windows, 1);

/** `windows`: include the cycle's main-counter windows (the view of one account only; the unfiltered view stays light). */
export function billingCycleOf(row: StoredCycleRow, windows = false): BillingCycle {
  const detail = JSON.parse(row.detail) as CycleDetail;
  const capacity = row.windows_share + row.idle_share;
  const amount = row.amount_minor === null ? null : row.amount_minor / 100;
  return {
    start: row.start_ts, end: row.end_ts, plan: row.plan, basis: row.basis as BillingCycle["basis"], anchor_uncertain: row.anchor_uncertain === 1,
    cycle_months: row.cycle_months, shortened: detail.shortened, current: row.is_current === 1,
    price: { amount, currency: row.currency, source: row.price_source as BillingCycle["price"]["source"],
      usd: detail.price_usd ?? (row.currency === "USD" ? amount : null), fx: detail.fx ?? null }, catalog_usd: row.catalog_usd,
    windows: { share: round(row.windows_share, 4), idle: round(row.idle_share, 4), touched: row.windows_touched,
      observed_share: row.observed_share === null ? null : round(row.observed_share, 4) },
    used_pp: row.used_pp === null ? null : round(row.used_pp, 2), used_pct: pct(row.used_pp, capacity),
    api_usd: row.api_usd === null ? null : round(row.api_usd, 2), capacity_usd: row.capacity_usd,
    capacity: detail.capacity ?? null, used_units: detail.used_units ?? null, resets: detail.resets ?? null,
    banked_granted: detail.banked_granted ?? null,
    to_date: detail.to_date === null ? null : { windows: round(detail.to_date, 4), used_pct: pct(row.used_pp, detail.to_date) },
    projection: detail.projection === null ? null : { windows_min: round(detail.projection, 4), used_pct: pct(row.used_pp, detail.projection) },
    per_window_point: amount === null || capacity <= 0 ? null : round(amount / (capacity * 100), 4),
    unmetered: detail.unmetered && { windows: round(detail.unmetered.windows, 4), api_usd: detail.unmetered.api_usd === null ? null : round(detail.unmetered.api_usd, 2) },
    others: detail.others.map((other) => ({ counter: other.counter, windows: round(other.windows, 4), used_pp: other.used_pp === null ? null : round(other.used_pp, 2),
      used_pct: pct(other.used_pp, other.windows + other.idle) })),
    flags: JSON.parse(row.flags) as string[], run: detail.run, declared_from: detail.declared_from,
    ...(windows ? { main_windows: (detail.main_windows ?? null) && detail.main_windows!.map((window) => ({ ...window,
      used_pp: window.used_pp === null ? null : round(window.used_pp, 2), share: round(window.share, 4),
      capacity_share: window.capacity_share === null ? null : round(window.capacity_share, 5) })) } : {}),
  };
}

export function buildBillingCyclesView(db: Database, filter: { provider?: string | null; account?: string | null } = {}, now = Date.now(), context=false): BillingCyclesView {
  return withFinalContext(db,context,source=>withReadSnapshot(source, () => billingCyclesView(source, filter, now, source===db)),{account:filter.account,billing:true});
}

function billingCyclesView(db: Database, filter: { provider?: string | null; account?: string | null }, now: number, legacyContext=true): BillingCyclesView {
  if (!hasBillingCycles(db)) return { accounts: [] };
  const provider = filter.provider ? normEraVendor(filter.provider) : null, account = filter.account ? normEraKey(filter.account) : null;
  const rows = db.query(`SELECT * FROM billing_cycles WHERE (?1 IS NULL OR provider=?1) AND (?2 IS NULL OR account=?2) ORDER BY provider, account, start_ts`)
    .all(provider, account) as StoredCycleRow[];
  const groups = new Map<string, BillingCyclesAccount>();
  const contextRows = new Map<string, ReturnType<typeof readContextRows>>();
  for (const row of rows) {
    const key = `${row.provider}|${row.account}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { provider: row.provider, account: row.account, counter: row.counter, stale: false, cycles: [] });
    const cycle = billingCycleOf(row, Boolean(provider && account));
    if (legacyContext && row.provider === "codex" && row.counter) {
      const contextKey = JSON.stringify([row.account, row.counter]);
      if (!contextRows.has(contextKey)) {
        const same = rows.filter(other => other.provider === "codex" && other.account === row.account && other.counter === row.counter);
        contextRows.set(contextKey, readContextRows(db, row.account, row.counter, same[0]!.start_ts, same.at(-1)!.end_ts));
      }
      const price = billingContextPrice(contextRows.get(contextKey)!, row.start_ts, row.end_ts, row.api_usd);
      // Retained stale producer rows must not inherit a split from newer, differently scoped sums.
      if (price && (!cycle.used_units || matchingContextPrice(price, cycle.used_units.api_usd))) cycle.context_price = price;
    }
    group.cycles.push(cycle);
  }
  // An account the producer has queued but not filled yet is listed without cycles.
  if (provider && account && !groups.size) groups.set(`${provider}|${account}`, { provider, account, counter: null, stale: true, cycles: [] });
  for (const group of groups.values()) {
    group.pending = billingCyclesPending(db, group, now);
    group.stale = group.pending !== null;
  }
  return { accounts: [...groups.values()] };
}
