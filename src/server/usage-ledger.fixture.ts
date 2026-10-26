import { usagePlaceSql } from "../projects/rules-now";
import { projectRulesFromRawRows } from "../projects/rules.fixture";
import type { Database } from "bun:sqlite";
import { ledgerMoneyDecimal } from "../db/usage-ledger";
import { analysisHash } from "../db/analysis";
import { canonicalJson } from "../config/canonical-json";
import { isAccountingDay, priceCodexEvent, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { advanceUsageLedger } from "./usage-ledger-producer";
import type { RateCard } from "./pricing";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { UsageLedgerProvider } from "../db/usage-ledger";
import { modelRateKey, priceSubscriptionEvent, subscriptionAccountingAdapter, subscriptionEventFromRow, TOKEN_BUCKETS, usageLedgerProviderIds,
  type SubscriptionEvent } from "./subscription-accounting-adapters";

/**
 * Test support for the usage ledger: its day rows in a comparable shape, an independent full
 * reference of the same rows, and a full fill.
 */
const VARIANTS = { api_standard: "std", api_actual: "act", api_global: "glb" } as const;
const QUALITY = ["duplicates", "conflicts", "conflicted_identities", "approximate_time_events", "invalid_token_events",
  "unknown_speed_tokens", "source_events", "attribution_conflicts"] as const;
const BUCKETS = { in_uncached: "t_uncached", in_cache_read: "t_cache_read", in_cache_write_5m: "t_write_5m",
  in_cache_write_1h: "t_write_1h", in_cache_write_unknown: "t_write_unknown", out_total: "t_out", reasoning_out: "t_thinking" } as const;
export type ComparableDay = { calls: number; first_ts: string; first_key: string; last_ts: string; tokens: Record<string, number>;
  tokens_reported: number; quality: Record<string, number>;
  variants: Record<string, { pricedEvents: number; unpricedEvents: number; pricedTokens: number; unpricedTokens: number;
    reasons: Record<string, [number, number]>; subtotal: string; pricedSubtotal: string }> };
const dayKey = (row: Record<string, unknown>) =>
  JSON.stringify([row.day, row.source, row.identity, row.model, row.speed, row.subject, row.vendor]);

export function ledgerDays(db: Database, provider: string): Map<string, ComparableDay> {
  const reasons = new Map<string, Record<string, [number, number]>>();
  for (const r of db.query("SELECT day,dim_id,variant,reason,events,tokens FROM usage_ledger_day_reasons WHERE provider=?").all(provider) as
    Array<{ day: string; dim_id: number; variant: string; reason: string; events: number; tokens: number }>) {
    const key = `${r.day}|${r.dim_id}|${r.variant}`;
    (reasons.get(key) ?? reasons.set(key, {}).get(key)!)[r.reason] = [r.events, r.tokens];
  }
  const days = new Map<string, ComparableDay>();
  // A row's subject follows the project rules over its place (projects/rules-now.ts).
  for (const row of db.query(`SELECT d.*,m.source,m.identity,m.model,m.speed,${usagePlaceSql(db, provider, "m", "d.day").subject} subject,m.vendor FROM usage_ledger_days d
      JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider=?`).all(provider) as Array<Record<string, string | number | null>>)
    // The ledger also splits by the place of a call (home, project, cwd); the reference does not, so those rows merge.
    mergeDay(days, dayKey(row), { calls: Number(row.calls), first_ts: String(row.first_ts), first_key: String(row.first_key), last_ts: String(row.last_ts),
      tokens: Object.fromEntries(Object.entries(BUCKETS).map(([key, column]) => [key, Number(row[column])])),
      tokens_reported: Number(row.tokens_reported), quality: Object.fromEntries(QUALITY.map(key => [key, Number(row[key])])),
      variants: Object.fromEntries(Object.entries(VARIANTS).map(([variant, p]) => [variant, {
        pricedEvents: Number(row[`${p}_priced_events`]), unpricedEvents: Number(row[`${p}_unpriced_events`]),
        pricedTokens: Number(row[`${p}_priced_tokens`]), unpricedTokens: Number(row[`${p}_unpriced_tokens`]),
        reasons: reasons.get(`${row.day}|${row.dim_id}|${variant}`) ?? {},
        subtotal: ledgerMoneyDecimal(row[`${p}_sub_usd`]!, row[`${p}_sub_nano`]!, row[`${p}_sub_femto`]!),
        pricedSubtotal: ledgerMoneyDecimal(row[`${p}_priced_usd`]!, row[`${p}_priced_nano`]!, row[`${p}_priced_femto`]!) }])) });
  return days;
}
const femto = (decimal: string) => { const [whole, fraction = ""] = decimal.split("."); return BigInt(whole!) * 10n ** 15n + BigInt(fraction.padEnd(15, "0")); };
const decimalOf = (value: bigint) => ledgerMoneyDecimal(0n, 0n, value);
function mergeDay(days: Map<string, ComparableDay>, key: string, day: ComparableDay): void {
  const current = days.get(key);
  if (!current) { days.set(key, day); return; }
  current.calls += day.calls; current.tokens_reported += day.tokens_reported;
  for (const k in day.tokens) current.tokens[k] = (current.tokens[k] ?? 0) + day.tokens[k]!;
  for (const k in day.quality) current.quality[k] = (current.quality[k] ?? 0) + day.quality[k]!;
  for (const [variant, amount] of Object.entries(day.variants)) {
    const target = current.variants[variant]!;
    for (const field of ["pricedEvents", "unpricedEvents", "pricedTokens", "unpricedTokens"] as const) target[field] += amount[field];
    target.subtotal = decimalOf(femto(target.subtotal) + femto(amount.subtotal));
    target.pricedSubtotal = decimalOf(femto(target.pricedSubtotal) + femto(amount.pricedSubtotal));
    for (const [reason, [events, tokens]] of Object.entries(amount.reasons)) {
      const prior = target.reasons[reason] ?? [0, 0];
      target.reasons[reason] = [prior[0] + events, prior[1] + tokens];
    }
  }
  if (day.first_ts < current.first_ts || (day.first_ts === current.first_ts && day.first_key < current.first_key)) {
    current.first_ts = day.first_ts; current.first_key = day.first_key;
  }
  if (day.last_ts > current.last_ts) current.last_ts = day.last_ts;
}

/**
 * An independent full reference for a provider's day rows, computed from its source rows with the
 * per-event pricing functions and the canonical-copy rule the old fact index and register applied:
 * copies with different fingerprints are a conflict (one marker per identity and day, the identity
 * counted once), agreeing copies keep the lexically least row id, an invalid counter is unpriced
 * with `invalid_usage`, and global usage reprices a row under the vendor it names. Money is float
 * here; `compareDays` allows for that.
 */
export function referenceDays(db: Database, provider: UsageLedgerProvider, card: RateCard, archiveRoot = ARCHIVE_LOGICAL_ROOT): Map<string, ComparableDay> {
  const adapter = subscriptionAccountingAdapter(provider);
  type Copy = { event: SubscriptionEvent; key: string; fingerprint: string };
  const identities = new Map<string, Copy[]>();
  for (const row of db.query(`SELECT * FROM ${adapter.table} ORDER BY id`).all() as Array<Record<string, string | number | null>>) {
    const event = subscriptionEventFromRow(adapter, row, archiveRoot);
    if (!event) continue;
    event.ts = new Date(event.ts).toISOString();
    const fingerprint = analysisHash([event.ts, event.model, event.speed, event.quantities, event.precise_time, event.usage_valid]);
    (identities.get(event.identity) ?? identities.set(event.identity, []).get(event.identity)!).push({ event, key: String(row.id), fingerprint });
  }
  const days = new Map<string, ComparableDay>();
  const blankAmount = () => ({ pricedEvents: 0, unpricedEvents: 0, pricedTokens: 0, unpricedTokens: 0, reasons: {} as Record<string, [number, number]>,
    subtotal: "0", pricedSubtotal: "0" });
  const add = (day: string, event: SubscriptionEvent, marker: boolean, contribution: Omit<ComparableDay, "first_ts" | "first_key" | "last_ts">,
    ts: string, key: string) => {
    const dim = { day, source: event.source, identity: event.account_key, model: marker ? null : event.model ?? null,
      speed: marker ? null : event.speed ?? null, subject: event.subject ?? null, vendor: event.eligible ? null : event.vendor };
    const id = dayKey(dim), current = days.get(id);
    if (!current) { days.set(id, { ...structuredClone(contribution), first_ts: ts, first_key: key, last_ts: ts }); return; }
    current.calls += contribution.calls; current.tokens_reported += contribution.tokens_reported;
    for (const k in contribution.tokens) current.tokens[k] = (current.tokens[k] ?? 0) + contribution.tokens[k]!;
    for (const k in contribution.quality) current.quality[k] = (current.quality[k] ?? 0) + contribution.quality[k]!;
    for (const [variant, amount] of Object.entries(contribution.variants)) {
      const target = current.variants[variant]!;
      for (const field of ["pricedEvents", "unpricedEvents", "pricedTokens", "unpricedTokens"] as const) target[field] += amount[field];
      target.subtotal = String(Number(target.subtotal) + Number(amount.subtotal));
      target.pricedSubtotal = String(Number(target.pricedSubtotal) + Number(amount.pricedSubtotal));
      for (const [reason, [events, tokens]] of Object.entries(amount.reasons)) {
        const prior = target.reasons[reason] ?? [0, 0];
        target.reasons[reason] = [prior[0] + events, prior[1] + tokens];
      }
    }
    if (ts < current.first_ts || (ts === current.first_ts && key < current.first_key)) { current.first_ts = ts; current.first_key = key; }
    if (ts > current.last_ts) current.last_ts = ts;
  };
  const quality = (values: Partial<Record<typeof QUALITY[number], number>>) => Object.fromEntries(QUALITY.map(k => [k, values[k] ?? 0]));
  const zeroTokens = () => Object.fromEntries(Object.keys(BUCKETS).map(k => [k, 0]));
  for (const copies of identities.values()) {
    copies.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (new Set(copies.map(copy => copy.fingerprint)).size > 1) {
      const byDay = new Map<string, Copy[]>();
      for (const copy of copies) { const day = copy.event.ts.slice(0, 10); (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(copy); }
      [...byDay.keys()].sort().forEach((day, index) => {
        const list = byDay.get(day)!, first = list[0]!;
        add(day, first.event, true, { calls: 1, tokens: zeroTokens(), tokens_reported: 0,
          quality: quality({ conflicts: 1, conflicted_identities: index === 0 ? 1 : 0, source_events: list.length,
            attribution_conflicts: list.filter(copy => copy.event.identity_conflict).length }),
          variants: Object.fromEntries(Object.keys(VARIANTS).map(v => [v, blankAmount()])) }, `${day}T00:00:00.000Z`, first.key);
      });
      continue;
    }
    const { event, key } = copies[0]!, day = event.ts.slice(0, 10);
    if (!isAccountingDay(day)) continue;
    const valid = event.usage_valid !== false;
    const total = TOKEN_BUCKETS.reduce((sum, bucket) => sum + event.quantities[bucket], 0), reported = valid ? total : 0;
    const record = (price: { amount: number | null; subtotal?: number; reason?: string | null } | null, fallback: string) => {
      const amount = blankAmount();
      if (price && price.amount !== null) {
        amount.pricedEvents = 1; amount.pricedTokens = reported;
        amount.subtotal = amount.pricedSubtotal = String(price.subtotal ?? price.amount);
      } else {
        amount.unpricedEvents = 1; amount.unpricedTokens = reported; amount.subtotal = String(price?.subtotal ?? 0);
        amount.reasons[price?.reason ?? fallback] = [1, reported];
      }
      return amount;
    };
    const own = (standard: boolean) => !valid ? record({ amount: null, subtotal: 0, reason: "invalid_usage" }, "invalid_usage")
      : record(priceSubscriptionEvent(card, adapter, event, standard), "missing_rate");
    const variants: ComparableDay["variants"] = { api_standard: event.eligible ? own(true) : blankAmount(),
      api_actual: event.eligible ? own(false) : blankAmount() };
    const vendor = event.eligible ? adapter.modelRateVendor?.(event.model) ?? adapter.rateVendor : event.vendor;
    const model = adapter.modelFamilyKeys ? modelRateKey(card, vendor, event.model) : event.model;
    const q = event.quantities, write = q.in_cache_write_unknown + q.in_cache_write_5m + q.in_cache_write_1h;
    variants.api_global = event.eligible && vendor === adapter.rateVendor && model === event.model ? structuredClone(variants.api_actual!)
      : vendor === "openai" ? record(priceCodexEvent(resolveCodexAccountingConfig(card), { model: event.model, speed: event.speed, ts: event.ts,
        in_tok: q.in_uncached + q.in_cache_read + write, cached_in: q.in_cache_read, cache_write: write, out_tok: q.out_total }, "api_equivalent_usd"), "missing_rate")
      : record(priceSubscriptionEvent(card, { rateVendor: vendor, speed: adapter.speed }, { ...event, model }), "missing_rate");
    add(day, event, false, { calls: 1, tokens: { ...Object.fromEntries(TOKEN_BUCKETS.map(b => [b, q[b]])), reasoning_out: q.out_thinking },
      tokens_reported: reported, variants, quality: quality({ source_events: copies.length, duplicates: copies.length - 1,
        invalid_token_events: valid ? 0 : 1, approximate_time_events: event.precise_time ? 0 : 1,
        attribution_conflicts: copies.filter(copy => copy.event.identity_conflict).length,
        unknown_speed_tokens: adapter.speed && event.speed !== "standard" && event.speed !== "fast" ? reported : 0 }) }, event.ts, key);
  }
  return days;
}

/**
 * Differences between the ledger and a reference. The reference's amounts are float sums, so money
 * agrees within `tolerance` relative; every count must be identical.
 */
export function compareDays(ledger: Map<string, ComparableDay>, register: Map<string, ComparableDay>, tolerance = 1e-9): unknown[] {
  const differences: unknown[] = [];
  for (const key of new Set([...ledger.keys(), ...register.keys()])) {
    const a = structuredClone(register.get(key)), b = structuredClone(ledger.get(key));
    if (!a || !b) { differences.push({ key, missing: a ? "ledger" : "reference" }); continue; }
    for (const variant of Object.keys(VARIANTS)) for (const field of ["subtotal", "pricedSubtotal"] as const) {
      const x = Number(a.variants[variant]![field]), y = Number(b.variants[variant]![field]);
      if (Math.abs(x - y) > tolerance * Math.max(1, Math.abs(y))) differences.push({ key, variant, field, register: x, ledger: y });
      a.variants[variant]![field] = b.variants[variant]![field] = "";
    }
    if (canonicalJson(a) !== canonicalJson(b)) differences.push({ key, reference: a, ledger: b });
  }
  return differences;
}

/** Steps a provider's ledger until it is ready. */
export function fillUsageLedger(db: Database, provider: UsageLedgerProvider, card: RateCard, archiveRoot: string, limit = 2000): void {
  // Fixtures name projects in the raw rows; readers take them from the rules.
  projectRulesFromRawRows(db);
  for (let turn = 0; turn < 10_000; turn++) {
    const step = advanceUsageLedger(db, provider, card, archiveRoot, { limit, budgetMs: 60_000 });
    if (step.complete) return;
  }
  throw new Error("usage ledger did not become ready");
}

/**
 * Every ledger provider whose source table exists, filled as a fresh installation fills it. An
 * empty source table without the stable row id gets one, as the importers create it.
 */
export function fillUsageLedgerFixture(db: Database, card: RateCard, providers: readonly UsageLedgerProvider[] = usageLedgerProviderIds(),
  limit = 2000): void {
  for (const provider of providers) {
    const table = subscriptionAccountingAdapter(provider).table;
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    if (!(db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === "id")) {
      if (db.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN id INTEGER`);
    }
    fillUsageLedger(db, provider, card, ARCHIVE_LOGICAL_ROOT, limit);
  }
}
