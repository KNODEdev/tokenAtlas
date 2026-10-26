import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { markBillingCyclesDirty } from "../db/billing-cycles";
import { ANSWER_SCOPE_ALL, ANSWER_SCOPE_NONE } from "../db/window-answers";
import {
  END_CAUSES_ALL, END_CAUSES_BEGINNING, WINDOW_END_CAUSE_COLUMNS, hasWindowEndCauses, markWindowEndCausesDirty,
  type BankedOrigin, type WindowEndCause, type WindowEndCauseRow,
} from "../db/window-end-causes";
import { PROVIDER_RESETS, type ProviderReset } from "../shared/provider-resets";
import { canonicalPeriodPlan } from "../shared/period-end";
import { AFTER_PAGE, clearPage, coveredByEntry, longestWindowMs, readPage, writePage, type PageKey } from "./dirty-pages";
import { preparedProbeAccountIndexReady, probeReadContext, selectOwnedProbes, type ProbeReadContext } from "./current/probe-account-reader";
import { probeSourcesPending } from "../db/probe-sources";
import { isCorrectable, overrideKey, type OverrideCause, type WindowEndOverride } from "../shared/window-end-overrides";
import { currentWindowEndOverrides } from "./window-end-overrides";

/**
 * The cause of each limit window's end (docs/reset-capacity-plan-2026-10-11.md, step 2, with the rules after the review
 * of 11.10), checked in this order:
 * 1. `open` — the window has not ended;
 * 2. `scheduled` — it ended within `SCHEDULED_SLACK_MS` of its planned reset;
 * 3. `plan_change` — the next window belongs to another plan (an upgrade or a downgrade, paid for): a new allowance, no
 *    bonus, never joined to this one;
 *    `not_reset` — the % did not drop materially: the next window's first reading is at least this one's last − 2 pp, or
 *    it keeps the same planned reset (±2 min) while this one ended under 10 pp or fell less than 10 pp; a split of one
 *    allowance (billing joins the two), no bonus. A same-reset end where the % fell from far up is a real reset (4–8);
 * 4. `banked` (Codex) — the account's reset-credit count fell across the end (readings ±30 min, within 2 h); since the
 *    credit list exists (09.10) a consumed credit is one that vanished before its expiry, and expiry alone is never banked;
 * 5. `provider` — another account of the provider and counter had a real early end within ±1 h, or an announced reset
 *    lies within [end − 12 h, end + 2 h] (tracker times are post or propagation times);
 * 6. `provider_probable` — such an early end within ±12 h, or an approximate announcement within ±24 h;
 * 7. `single` (Codex) — other accounts were observed around the end (readings within an hour on both sides) without a
 *    reset, and the account's own credit readings around the end show no credit used;
 * 8. `unknown` — otherwise: no other account observed, no credit evidence, or Claude (provider or unknown only); screens
 *    count it as probably the provider's.
 * A real early reset (4–8) gives the bonus 1 − f, f being the elapsed share of the window's planned span.
 *
 * Stored per window by a background step from stored rows only (`limit_windows`, `probe_windows` reset credits) and the
 * announced list. A row reads other accounts' windows within ±12 h and credit readings within ±2 h, so a window mark
 * queues the provider's windows of the mark's range widened by 12 h on both sides; a row whose evidence may still change
 * (before end + 2 h for credits, end + 12 h for other accounts) is queued again at those instants.
 */
export const WINDOW_END_CAUSES_RULE = "window-end-causes-4";
// Automatic classification is unchanged; retain its revisions when adding optional corrections.
const AUTOMATIC_RULE = "window-end-causes-3";
const MIN = 60_000, HOUR = 3_600_000;
export const SCHEDULED_SLACK_MS = 15 * MIN;
export const SAME_RESET_MS = 2 * MIN;
export const NO_DROP_PP = 2;
/** A same-reset split is one allowance only when the % was low or fell little: a fall from far up is a real reset. */
export const MATERIAL_DROP_PP = 10;
export const CREDIT_GAP_MS = 30 * MIN, CREDIT_REACH_MS = 2 * HOUR;
export const PROVIDER_SURE_MS = HOUR, PROVIDER_PROBABLE_MS = 12 * HOUR;
export const ANNOUNCED_BEFORE_MS = 12 * HOUR, ANNOUNCED_AFTER_MS = 2 * HOUR, ANNOUNCED_APPROXIMATE_MS = 24 * HOUR;
export const OBSERVED_MS = HOUR;
export const ORIGIN_GRANT_MS = 2 * HOUR, ORIGIN_ANNOUNCED_MS = 12 * HOUR;
/** How far a row's evidence reaches past the window's end, and so how long other accounts' changes re-queue it. */
export const DEPENDENCY_MS = PROVIDER_PROBABLE_MS;

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 86_400_000;
const minutes = (ms: number) => Math.round(ms / MIN);

// ---------------------------------------------------------------- one window

export interface EndWindow {
  provider: string; account: string; counter: string; seq: number;
  start: number; end: number; reset: number;
  /** The window's plan; a window whose plan changed inside it is `mixed:<label>`. */
  plan: string | null;
  /** First and last % reading; null without readings. */
  first: number | null; last: number | null;
  endBasis?: string;
}
export interface ResetCredit { id: string; granted_at: string; expires_at: string }
export interface CreditReading { ts: number; count: number; list: ResetCredit[] | null }
export interface CreditEvidence {
  before: { ts: string; count: number };
  after: { ts: string; count: number };
  /** The credit that vanished before its expiry, when both readings carry the list. */
  consumed: ResetCredit | null;
  /** Whether the readings show a reset credit used at this end. */
  used: boolean;
}

/**
 * The account's reset-credit readings around an end: the last at least 30 min before it (else the last before it) and the
 * first at least 30 min after it (else the first after it), each within 2 h; null without both.
 */
export function creditEvidence(readings: readonly CreditReading[], end: number): CreditEvidence | null {
  const sorted = [...readings].sort((a, b) => a.ts - b.ts);
  const within = (r: CreditReading) => r.ts >= end - CREDIT_REACH_MS && r.ts <= end + CREDIT_REACH_MS;
  const earlier = sorted.filter((r) => within(r) && r.ts <= end);
  const later = sorted.filter((r) => within(r) && r.ts > end);
  const before = earlier.filter((r) => r.ts <= end - CREDIT_GAP_MS).at(-1) ?? earlier.at(-1);
  const after = later.find((r) => r.ts >= end + CREDIT_GAP_MS) ?? later[0];
  if (!before || !after) return null;
  let consumed: ResetCredit | null = null, used: boolean;
  if (before.list && after.list) {
    const kept = new Set(after.list.map((credit) => credit.id));
    // A credit that may have expired before the after-reading is no evidence of use.
    consumed = before.list.find((credit) => !kept.has(credit.id) && Date.parse(credit.expires_at) > after.ts) ?? null;
    used = consumed !== null;
  } else used = after.count < before.count;
  return { before: { ts: iso(before.ts), count: before.count }, after: { ts: iso(after.ts), count: after.count }, consumed, used };
}

/**
 * Whether the plan changes where `next` begins: a successor of another plan, or one whose plan changes inside it (the
 * split starts with it). A window whose own plan changed inside it ends in its last plan.
 */
function planChangesAt(window: EndWindow, next: EndWindow): boolean {
  if (!window.plan || !next.plan) return false;
  if (next.plan.startsWith("mixed:")) return true;
  const last = window.plan.startsWith("mixed:") ? window.plan.split("→").at(-1)!.trim() : window.plan;
  return canonicalPeriodPlan(last) !== canonicalPeriodPlan(next.plan);
}

export type OwnEnd = "open" | "scheduled" | "plan_change" | "not_reset" | "banked" | "early";
/** What a window's own data says about its end, before other accounts are looked at. */
export function ownEnd(window: EndWindow, next: EndWindow | null, credits: CreditEvidence | null, now: number):
  { kind: OwnEnd; notReset?: "same_reset" | "no_drop" | "capacity_change" } {
  if (window.end > now) return { kind: "open" };
  if (window.endBasis === "plan_change") return { kind: "plan_change" };
  if (window.endBasis === "capacity_change") return { kind: "not_reset", notReset: "capacity_change" };
  if (window.reset - window.end <= SCHEDULED_SLACK_MS) return { kind: "scheduled" };
  if (next && planChangesAt(window, next)) return { kind: "plan_change" };
  if (next && window.last !== null && next.first !== null && next.first >= window.last - NO_DROP_PP) return { kind: "not_reset", notReset: "no_drop" };
  if (next && Math.abs(next.reset - window.reset) <= SAME_RESET_MS
    && (window.last === null || next.first === null || window.last < MATERIAL_DROP_PP || window.last - next.first < MATERIAL_DROP_PP))
    return { kind: "not_reset", notReset: "same_reset" };
  if (window.provider === "codex" && credits?.used) return { kind: "banked" };
  return { kind: "early" };
}

/**
 * The origin of a banked credit: `all_accounts` when other accounts of the provider got a credit within 2 h of its grant
 * (a matching `granted_at` in their lists, or their count rising then) or an announced banked grant lies within 12 h;
 * `unknown` otherwise, and always without the consumed credit's identity (before the list existed).
 */
export function bankedOrigin(consumed: ResetCredit | null, others: ReadonlyArray<{ account: string; readings: readonly CreditReading[] }>,
  announced: readonly ProviderReset[], provider: string): { origin: BankedOrigin; by: string | null } {
  if (!consumed) return { origin: "unknown", by: null };
  const granted = Date.parse(consumed.granted_at);
  const event = announced.find((reset) => reset.provider === provider && reset.kind === "banked" && Math.abs(Date.parse(reset.at) - granted) <= ORIGIN_ANNOUNCED_MS);
  if (event) return { origin: "all_accounts", by: event.id };
  for (const other of others) {
    if (other.readings.some((r) => r.list?.some((credit) => Math.abs(Date.parse(credit.granted_at) - granted) <= ORIGIN_GRANT_MS)))
      return { origin: "all_accounts", by: other.account };
    const near = [...other.readings].filter((r) => Math.abs(r.ts - granted) <= ORIGIN_GRANT_MS).sort((a, b) => a.ts - b.ts);
    if (near.some((r, i) => i > 0 && r.count > near[i - 1]!.count)) return { origin: "all_accounts", by: other.account };
  }
  return { origin: "unknown", by: null };
}

export interface EndCauseInput {
  window: EndWindow;
  next: EndWindow | null;
  credits: CreditEvidence | null;
  /** Origin of the consumed credit (`bankedOrigin`), when the window is banked. */
  origin: { origin: BankedOrigin; by: string | null } | null;
  /** Other accounts' windows of the provider and counter that end within ±12 h, with what their own data says. */
  others: ReadonlyArray<{ window: EndWindow; own: OwnEnd }>;
  /** Other accounts with readings of the counter within an hour before and after the end (asked only when needed). */
  observers: () => string[];
  announced: readonly ProviderReset[];
  now: number;
}
export interface EndCause {
  cause: WindowEndCause; f: number | null; bonus: number; banked_origin: BankedOrigin | null;
  evidence: Record<string, unknown>;
}

/** The cause, elapsed share, bonus and evidence of one window's end. Pure. */
export function classifyWindowEnd(input: EndCauseInput): EndCause {
  const { window, next, credits, now } = input;
  const span = window.reset - window.start;
  const f = span > 0 ? Math.min(1, Math.max(0, (window.end - window.start) / span)) : null;
  const own = ownEnd(window, next, credits, now);
  // Evidence that may still arrive: credit readings for 2 h, other accounts' ends for 12 h.
  const pendingUntil = window.end > now ? null : now < window.end + CREDIT_REACH_MS ? iso(window.end + CREDIT_REACH_MS)
    : now < window.end + DEPENDENCY_MS ? iso(window.end + DEPENDENCY_MS) : null;
  const evidence: Record<string, unknown> = { pending_until: pendingUntil };
  if (credits) evidence.credits = { before: credits.before, after: credits.after };
  if (credits?.consumed) evidence.consumed = credits.consumed;
  const result = (cause: WindowEndCause, bonus: boolean, origin: BankedOrigin | null = null): EndCause =>
    ({ cause, f: f === null ? null : Math.round(f * 1e6) / 1e6, bonus: bonus && f !== null ? Math.round((1 - f) * 1e6) / 1e6 : 0, banked_origin: origin, evidence });
  if (own.kind === "open" || own.kind === "scheduled") return result(own.kind, false);
  if (own.kind === "plan_change") {
    evidence.next = next && { start: iso(next.start), reset: iso(next.reset), first: next.first, plan: next.plan };
    return result("plan_change", false);
  }
  if (own.kind === "not_reset") {
    evidence.not_reset = own.notReset;
    evidence.next = next && { start: iso(next.start), reset: iso(next.reset), first: next.first, plan: next.plan };
    return result("not_reset", false);
  }
  if (own.kind === "banked") {
    if (input.origin?.by) evidence.origin_by = input.origin.by;
    return result("banked", true, input.origin?.origin ?? "unknown");
  }
  const early = input.others.filter((other) => other.own === "early" && other.window.account !== window.account)
    .map((other) => ({ account: other.window.account, end: iso(other.window.end), dt_min: minutes(other.window.end - window.end) }))
    .sort((a, b) => Math.abs(a.dt_min) - Math.abs(b.dt_min) || a.account.localeCompare(b.account));
  const announced = input.announced.filter((reset) => reset.provider === window.provider && reset.kind === "reset");
  const sure = announced.find((reset) => !reset.approximate && Date.parse(reset.at) >= window.end - ANNOUNCED_BEFORE_MS
    && Date.parse(reset.at) <= window.end + ANNOUNCED_AFTER_MS);
  const near = early.filter((match) => Math.abs(match.dt_min) * MIN <= PROVIDER_SURE_MS);
  const describe = (reset: ProviderReset) => ({ id: reset.id, at: reset.at, approximate: reset.approximate, dt_min: minutes(Date.parse(reset.at) - window.end) });
  if (near.length || sure) {
    if (near.length) evidence.matched = near;
    if (sure) evidence.announced = describe(sure);
    return result("provider", true);
  }
  const probable = early.filter((match) => Math.abs(match.dt_min) * MIN <= PROVIDER_PROBABLE_MS);
  const approximate = announced.find((reset) => reset.approximate && Math.abs(Date.parse(reset.at) - window.end) <= ANNOUNCED_APPROXIMATE_MS);
  if (probable.length || approximate) {
    if (probable.length) evidence.matched = probable;
    if (approximate) evidence.announced = describe(approximate);
    return result("provider_probable", true);
  }
  // A single-account reset needs the account's own credit readings around it (no credit used) and other accounts observed.
  if (window.provider !== "codex" || !credits) return result("unknown", true);
  const observers = input.observers();
  if (observers.length) { evidence.observers = observers; return result("single", true); }
  return result("unknown", true);
}

// ---------------------------------------------------------------- the producer step

export interface EndCauseOptions {
  now?: number;
  budgetMs?: number;
  canWrite?: () => boolean;
  /** The announced list (tests replace it). */
  announced?: readonly ProviderReset[];
  /** The person's corrections (window-end-overrides.ts; tests replace them); null keeps the ones applied. */
  overrides?: readonly WindowEndOverride[] | null;
}
export interface EndCauseTurn { progressed: boolean; pending: boolean; written: number; removed: number; backlog: number }

const MARKS_KEY = "window_end_causes_marks";
const PAGE_KEY = "window_end_causes_page";
const CONFIG_KEY = "window_end_causes_config";
/** The corrections the stored rows follow, as sorted [key, cause] pairs: a change queues only the windows it names. */
const OVERRIDES_KEY = "window_end_causes_overrides";
// Smaller than the point values: each window reads its neighbours and owned credit readings.
const CHUNK = 32;
const OPEN_END = "9999-12-31T23:59:59.999Z";

export function endCauseConfigDigest(announced: readonly ProviderReset[], rule = WINDOW_END_CAUSES_RULE): string {
  return createHash("sha256").update(JSON.stringify([rule, announced])).digest("hex").slice(0, 16);
}

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const meta = (db: Database, key: string) => tableExists(db, "meta")
  ? (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null : null;
const setMeta = (db: Database, key: string, value: string) =>
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);

interface DirtyEntry { provider: string; account: string; from_ms: number; until_ms: number | null; sequence: number }
interface WindowRow { provider: string; account: string; counter: string; seq: number; start_ts: string; end_ts: string; reset_ts: string;
  plan: string | null; plan_detail: string | null; first: number | null; last: number | null; cycle_end_basis?: string }
const WINDOW_COLUMNS = `provider, account, counter, seq, start_ts, end_ts, reset_ts, plan, plan_detail, cycle_end_basis,
  json_extract(readings,'$[0].percent') AS first, json_extract(readings,'$[#-1].percent') AS last`;
// A window overlapping the range starts at most the longest stored window before it (`longestWindowMs`, read per turn): a
// bound that lets the (start, provider, account, counter) index serve the ordered page read.
const ENTRY_SCOPE = `(?1='*' OR l.provider=?1) AND (?2='*' OR l.account=?2) AND l.end_ts > ?3 AND l.start_ts < ?4 AND l.start_ts >= ?5`;
const entryArgs = (entry: DirtyEntry, longest: number) => [entry.provider, entry.account, iso(Math.max(entry.from_ms, -8.64e15)),
  entry.until_ms === null ? OPEN_END : iso(entry.until_ms), iso(Math.max(entry.from_ms - longest, -8.64e15))] as const;
function planOf(row: WindowRow): string | null {
  if (row.plan) return row.plan;
  try {
    const detail = row.plan_detail ? JSON.parse(row.plan_detail) as { label?: string; status?: string } : null;
    return detail?.status === "mixed" ? `mixed:${detail.label ?? ""}` : null;
  } catch { return null; }
}
const toWindow = (row: WindowRow): EndWindow => ({ provider: row.provider, account: row.account, counter: row.counter, seq: row.seq,
  start: Date.parse(row.start_ts), end: Date.parse(row.end_ts), reset: Date.parse(row.reset_ts), plan: planOf(row), endBasis: row.cycle_end_basis,
  first: typeof row.first === "number" ? row.first : null, last: typeof row.last === "number" ? row.last : null });

/**
 * The stored inputs of a chunk, read in bounded queries: windows by key, the provider's windows of a counter ending near
 * the chunk's ends, and the reset-credit readings an account owned (probe ownership through its dated account periods
 * and physical sources, as every probe reader resolves it).
 */
class Inputs {
  private byKey = new Map<string, EndWindow | null>();
  private byCounter = new Map<string, { from: number; until: number; windows: EndWindow[] }>();
  private credits = new Map<string, CreditReading[]>();
  private accountList = new Map<string, string[]>();
  private probes: ProbeReadContext | null | undefined;
  constructor(private db: Database) {}
  get(provider: string, account: string, counter: string, seq: number): EndWindow | null {
    const key = `${provider}|${account}|${counter}|${seq}`;
    if (!this.byKey.has(key)) {
      const row = this.db.query(`SELECT ${WINDOW_COLUMNS} FROM limit_windows WHERE provider=? AND account=? AND counter=? AND seq=?`)
        .get(provider, account, counter, seq) as WindowRow | null;
      this.byKey.set(key, row ? toWindow(row) : null);
    }
    return this.byKey.get(key)!;
  }
  next(window: EndWindow): EndWindow | null { return this.get(window.provider, window.account, window.counter, window.seq + 1); }
  /** Loads the provider's windows of a counter ending within `[from, until]` (once per chunk and counter). */
  prepare(provider: string, counter: string, from: number, until: number): void {
    const key = `${provider}|${counter}`, loaded = this.byCounter.get(key);
    if (loaded && loaded.from <= from && loaded.until >= until) return;
    const lower = Math.min(from, loaded?.from ?? from), upper = Math.max(until, loaded?.until ?? until);
    const rows = this.db.query(`SELECT ${WINDOW_COLUMNS} FROM limit_windows WHERE provider=? AND counter=? AND end_ts >= ? AND end_ts <= ?`)
      .all(provider, counter, iso(lower), iso(upper)) as WindowRow[];
    this.byCounter.set(key, { from: lower, until: upper, windows: rows.map(toWindow) });
  }
  /** Other accounts' windows of the provider and counter ending within `reach` of the window's end. */
  around(window: EndWindow, reach: number): EndWindow[] {
    this.prepare(window.provider, window.counter, window.end - reach, window.end + reach);
    return this.byCounter.get(`${window.provider}|${window.counter}`)!.windows
      .filter((other) => other.account !== window.account && Math.abs(other.end - window.end) <= reach);
  }
  accounts(provider: string): string[] {
    if (!this.accountList.has(provider))
      this.accountList.set(provider, (this.db.query("SELECT DISTINCT account FROM limit_windows WHERE provider=? ORDER BY account").all(provider) as Array<{ account: string }>)
        .map((row) => row.account));
    return this.accountList.get(provider)!;
  }
  /** Reset-credit readings an account owned within `reach` of `at` (Codex only; none before the probe index is ready). */
  creditsOf(provider: string, account: string, at: number, reach = CREDIT_REACH_MS): CreditReading[] {
    if (provider !== "codex") return [];
    if (this.probes === undefined) this.probes = tableExists(this.db, "probe_windows") && preparedProbeAccountIndexReady(this.db) ? probeReadContext(this.db) : null;
    if (!this.probes) return [];
    const readings: CreditReading[] = [];
    // Read by whole UTC days and kept for the turn: neighbouring windows and accounts share the same days.
    for (let day = Math.floor((at - reach) / DAY_MS) * DAY_MS; day <= at + reach; day += DAY_MS)
      for (const reading of this.creditDay(account, day)) if (reading.ts >= at - reach && reading.ts <= at + reach) readings.push(reading);
    return readings.sort((a, b) => a.ts - b.ts);
  }
  private creditDay(account: string, day: number): CreditReading[] {
    const key = `${account}|${day}`;
    const cached = this.credits.get(key);
    if (cached) return cached;
    const rows = selectOwnedProbes(this.db, this.probes!, "codex", account, { from: day, until: day + DAY_MS,
      where: "p.reset_credits IS NOT NULL", columns: `p.id, p.ts, p.reset_credits, json_extract(p.extra, '$."codex.reset_credits"') AS credit_list` })
      .map(({ row }) => row as unknown as { ts: string; reset_credits: number; credit_list: string | null });
    const readings = rows.map((row) => {
      let list: ResetCredit[] | null = null;
      try { list = row.credit_list ? JSON.parse(row.credit_list) as ResetCredit[] : null; } catch { /* Not a list. */ }
      return { ts: Date.parse(row.ts), count: row.reset_credits, list: Array.isArray(list) ? list : null };
    });
    this.credits.set(key, readings);
    return readings;
  }
  evidenceOf(window: EndWindow): CreditEvidence | null {
    return window.provider === "codex" ? creditEvidence(this.creditsOf(window.provider, window.account, window.end), window.end) : null;
  }
  /** Other accounts with readings of the counter within an hour before and within an hour after the end. */
  observers(window: EndWindow): string[] {
    const found = new Set<string>();
    const rows = this.db.query(`SELECT account, readings FROM limit_windows WHERE provider=? AND counter=? AND account<>? AND end_ts >= ? AND start_ts <= ?`)
      .all(window.provider, window.counter, window.account, iso(window.end - OBSERVED_MS), iso(window.end + OBSERVED_MS)) as Array<{ account: string; readings: string }>;
    const byAccount = new Map<string, number[]>();
    for (const row of rows) for (const reading of JSON.parse(row.readings) as Array<{ ts: string }>)
      (byAccount.get(row.account) ?? byAccount.set(row.account, []).get(row.account)!).push(Date.parse(reading.ts));
    for (const [account, times] of byAccount)
      if (times.some((t) => t >= window.end - OBSERVED_MS && t < window.end) && times.some((t) => t > window.end && t <= window.end + OBSERVED_MS)) found.add(account);
    return [...found].sort();
  }
}

/** The stored columns `joinsPrevious` reads of a limit window (alias-free, as `WINDOW_COLUMNS` selects them). */
export type JoinRow = Pick<WindowRow, "start_ts" | "end_ts" | "reset_ts" | "plan" | "plan_detail" | "first" | "last" | "cycle_end_basis">;
/**
 * Whether percentages continue from the previous fragment. A changed denominator can share a billing
 * period but cannot borrow the old percentage baseline.
 */
export function joinsPrevious(previous: JoinRow, window: JoinRow): boolean {
  if (previous.cycle_end_basis === "capacity_change") return false;
  const as = (row: JoinRow, seq: number) => toWindow({ ...row, provider: "", account: "", counter: "", seq });
  return ownEnd(as(previous, 0), as(window, 1), null, Infinity).kind === "not_reset";
}

type CauseValue = Omit<WindowEndCauseRow, "inputs_rev" | "computed_at">;
/**
 * A person's correction of a real early reset's kind: the bonus stays the evidence's, the automatic cause is kept in the
 * evidence. A correction of an end that is no longer an early reset is ignored until it is one again.
 */
export function corrected(value: CauseValue, chosen: ReadonlyMap<string, OverrideCause>): CauseValue {
  const cause = chosen.get(overrideKey(value));
  if (!cause || cause === value.cause || !isCorrectable(value.cause)) return value;
  const evidence = { ...JSON.parse(value.evidence) as Record<string, unknown>, manual: { auto: value.cause } };
  return { ...value, cause, banked_origin: cause === "banked" ? value.banked_origin ?? "unknown" : null, evidence: JSON.stringify(evidence) };
}

/** The stored row of one window from the turn's inputs. */
function causeOf(inputs: Inputs, window: EndWindow, announced: readonly ProviderReset[], now: number): CauseValue {
  const next = inputs.next(window);
  const credits = inputs.evidenceOf(window);
  const own = ownEnd(window, next, credits, now);
  const origin = own.kind === "banked" ? bankedOrigin(credits?.consumed ?? null,
    inputs.accounts(window.provider).filter((account) => account !== window.account).map((account) => ({ account,
      readings: [...inputs.creditsOf(window.provider, account, Date.parse(credits!.consumed?.granted_at ?? iso(window.end)), ORIGIN_GRANT_MS),
        ...inputs.creditsOf(window.provider, account, window.end)] })), announced, window.provider) : null;
  const others = own.kind === "early" ? inputs.around(window, PROVIDER_PROBABLE_MS).map((other) => ({ window: other,
    own: ownEnd(other, inputs.next(other), inputs.evidenceOf(other), now).kind })) : [];
  const cause = classifyWindowEnd({ window, next, credits, origin, others, observers: () => inputs.observers(window), announced, now });
  return { provider: window.provider, account: window.account, counter: window.counter, window_start: iso(window.start), window_end: iso(window.end),
    planned_reset: iso(window.reset), f: cause.f, bonus: cause.bonus, cause: cause.cause, banked_origin: cause.banked_origin,
    evidence: JSON.stringify(cause.evidence) };
}

const inputsRev = (value: CauseValue) => createHash("sha256")
  .update(JSON.stringify([JSON.parse(value.evidence)?.manual ? WINDOW_END_CAUSES_RULE : AUTOMATIC_RULE, ...WINDOW_END_CAUSE_COLUMNS.slice(0, -2).map((column) => value[column as keyof typeof value])]))
  .digest("hex").slice(0, 16);

/** One bounded turn; null on a database without the tables it reads or writes. */
export function advanceWindowEndCauses(db: Database, options: EndCauseOptions = {}): EndCauseTurn | null {
  if (!hasWindowEndCauses(db) || !tableExists(db, "limit_windows")) return null;
  const now = options.now ?? Date.now(), started = performance.now(), budget = options.budgetMs ?? 500;
  const canWrite = options.canWrite ?? (() => true);
  const announced = options.announced ?? PROVIDER_RESETS;
  const turn: EndCauseTurn = { progressed: false, pending: false, written: 0, removed: 0, backlog: 0 };
  if (!canWrite()) return { ...turn, pending: true, backlog: backlogOf(db) };
  queueChanges(db, endCauseConfigDigest(announced), now, endCauseConfigDigest(announced, AUTOMATIC_RULE));
  const chosen = queueOverrides(db, options.overrides !== undefined ? options.overrides : currentWindowEndOverrides());
  const entries = db.query("SELECT provider, account, from_ms, until_ms, sequence FROM window_end_cause_dirty ORDER BY provider, account").all() as DirtyEntry[];
  if (!entries.length) return turn;
  // Credit-dependent causes are not published from evidence that is not available yet: the work stays queued (stale).
  if (!creditsReady(db) && entries.some((entry) => entry.provider === "codex" || entry.provider === END_CAUSES_ALL))
    return { ...turn, pending: true, backlog: backlogOf(db) };
  const inputs = new Inputs(db), longest = longestWindowMs(db);
  const select = db.query(`SELECT l.provider, l.account, l.counter, l.seq, l.start_ts, l.end_ts, l.reset_ts, l.plan, l.plan_detail, NULL AS first, NULL AS last
    FROM limit_windows l WHERE ${ENTRY_SCOPE} AND ${AFTER_PAGE} ORDER BY l.start_ts, l.provider, l.account, l.counter LIMIT ?10`);
  const storedOf = db.query("SELECT * FROM window_end_causes WHERE provider=? AND account=? AND counter=? AND window_start=?");
  outer: for (const entry of entries) {
    for (;;) {
      if (turn.progressed && performance.now() - started > budget || !canWrite()) { turn.pending = true; break outer; }
      const rows = select.all(...entryArgs(entry, longest), ...readPage(db, PAGE_KEY, entry), CHUNK + 1) as WindowRow[];
      const chunk = rows.slice(0, CHUNK), next = rows[CHUNK] ?? null;
      const last = chunk.at(-1);
      // The chunk's neighbourhood in one bounded read per provider and counter.
      const ends = new Map<string, [string, string, number, number]>();
      for (const row of chunk) {
        const key = `${row.provider}|${row.counter}`, at = Date.parse(row.end_ts), range = ends.get(key);
        ends.set(key, [row.provider, row.counter, Math.min(range?.[2] ?? at, at), Math.max(range?.[3] ?? at, at)]);
      }
      for (const [provider, counter, from, until] of ends.values()) inputs.prepare(provider, counter, from - PROVIDER_PROBABLE_MS, until + PROVIDER_PROBABLE_MS);
      const values = chunk.map((row) => corrected(causeOf(inputs, inputs.get(row.provider, row.account, row.counter, row.seq) ?? toWindow(row), announced, now), chosen));
      if (!canWrite()) { turn.pending = true; break outer; }
      db.transaction(() => {
        const billing: Array<[string, string, number, number]> = [];
        const gone = db.query(`SELECT * FROM window_end_causes l WHERE ${ENTRY_SCOPE.replaceAll("l.end_ts", "l.window_end").replaceAll("l.start_ts", "l.window_start")}
          AND NOT EXISTS (SELECT 1 FROM limit_windows w WHERE w.provider=l.provider AND w.account=l.account AND w.counter=l.counter AND w.start_ts=l.window_start)`)
          .all(...entryArgs(entry, longest)) as WindowEndCauseRow[];
        for (const row of gone) {
          db.query("DELETE FROM window_end_causes WHERE provider=? AND account=? AND counter=? AND window_start=?").run(row.provider, row.account, row.counter, row.window_start);
          if (row.bonus > 0) billing.push([row.provider, row.account, Date.parse(row.window_end), Math.max(Date.parse(row.window_end), Date.parse(row.planned_reset)) + 1]);
          turn.removed++;
        }
        const put = db.query(`INSERT OR REPLACE INTO window_end_causes(${WINDOW_END_CAUSE_COLUMNS.join(",")}) VALUES(${WINDOW_END_CAUSE_COLUMNS.map(() => "?").join(",")})`);
        for (const value of values) {
          const rev = inputsRev(value);
          const before = storedOf.get(value.provider, value.account, value.counter, value.window_start) as WindowEndCauseRow | null;
          if (before?.inputs_rev === rev) continue;
          const row: WindowEndCauseRow = { ...value, inputs_rev: rev, computed_at: iso(now) };
          put.run(...WINDOW_END_CAUSE_COLUMNS.map((column) => row[column]));
          turn.written++;
          // Window details carry the cause too: refresh cycles holding any part of the old or new window.
          // A reset's bonus belongs to the time between its end and its planned reset (cycleResets): the cycles over it follow.
          if (!before || before.cause !== row.cause || before.bonus !== row.bonus || before.window_end !== row.window_end
            || before.planned_reset !== row.planned_reset || before.banked_origin !== row.banked_origin) {
            const times = [row.window_start, row.window_end, row.planned_reset, ...(before ? [before.window_start, before.window_end, before.planned_reset] : [])].map(Date.parse);
            billing.push([row.provider, row.account, Math.min(...times), Math.max(...times) + 1]);
          }
        }
        for (const [provider, account, from, until] of billing) markBillingCyclesDirty(db, provider, account, from, until);
        // A partly done entry resumes after its last window done (dirty-pages.ts); a merged newer mark restarts it.
        if (next && last) writePage(db, PAGE_KEY, entry, [last.start_ts, last.provider, last.account, last.counter] as PageKey);
        else {
          db.query("DELETE FROM window_end_cause_dirty WHERE provider=? AND account=? AND sequence=?").run(entry.provider, entry.account, entry.sequence);
          clearPage(db, PAGE_KEY, entry);
        }
      }).immediate();
      turn.progressed = true;
      if (!next) break;
    }
  }
  turn.backlog = backlogOf(db);
  turn.pending = turn.backlog > 0 || !!db.query("SELECT 1 FROM window_end_cause_dirty LIMIT 1").get();
  return turn;
}

function backlogOf(db: Database): number {
  const entries = db.query("SELECT provider, account, from_ms, until_ms, sequence FROM window_end_cause_dirty").all() as DirtyEntry[];
  const count = db.query(`SELECT count(*) AS n FROM limit_windows l WHERE ${ENTRY_SCOPE}`);
  const longest = longestWindowMs(db);
  return entries.reduce((total, entry) => total + (count.get(...entryArgs(entry, longest)) as { n: number }).n, 0);
}

type Mark = { seq: number; provider: string; account: string; from_ms: number; until_ms: number | null };
type DueRow = { provider: string; account: string; counter: string; window_start: string; window_end: string };
/**
 * What is due for the step, read without writing (the producer queues it, the freshness check reports it): window marks
 * after the cursor (or marks folded away before it saw them), a new configuration, open windows the clock has closed,
 * and rows whose evidence checkpoint has passed.
 *
 * Credit evidence is queued directly by the probe ownership writer (`queueCreditEvidence`), never as window marks, so the
 * step never reads raw readings ahead of their ownership and a credit poll invalidates nothing else.
 */
function dueWork(db: Database, digest: string | null, now: number, compatibleDigest?: string) {
  const hasMarks = tableExists(db, "window_answer_marks");
  const cursor = Number(meta(db, MARKS_KEY) ?? 0);
  const marks = hasMarks ? db.query("SELECT seq, provider, account, from_ms, until_ms FROM window_answer_marks WHERE seq > ? ORDER BY seq LIMIT 5000")
    .all(cursor) as Mark[] : [];
  const folded = hasMarks ? (db.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0 : 0;
  const config = meta(db, CONFIG_KEY);
  const full = config === null || (digest !== null && config !== digest && config !== compatibleDigest) || folded > cursor;
  const rows = (db.query(`SELECT provider, account, counter, window_start, window_end, cause, json_extract(evidence,'$.pending_until') AS pending FROM window_end_causes
    WHERE cause='open' OR json_extract(evidence,'$.pending_until') IS NOT NULL`).all() as Array<DueRow & { cause: string; pending: string | null }>)
    .filter((row) => row.cause === "open" ? Date.parse(row.window_end) <= now : row.pending !== null && Date.parse(row.pending) <= now);
  return { marks, cursor, folded, full, rows };
}

/**
 * Whether credit evidence can be read: the probe ownership index is published and holds every reading written so far, or
 * there are no Codex credit readings at all. Before that, an empty read means "not available yet", not "no evidence".
 */
function creditsReady(db: Database): boolean {
  if (!tableExists(db, "probe_windows") || !db.query("SELECT 1 FROM probe_windows WHERE provider='codex' AND reset_credits IS NOT NULL LIMIT 1").get()) return true;
  return preparedProbeAccountIndexReady(db) && !probeSourcesPending(db);
}

/**
 * Inside the probe ownership writer's transaction (current/v2.ts `writeProbeSources`): Codex readings at `instants` were
 * written, corrected or removed, so the causes of every Codex window ending within 2 h of them are work again (their
 * own and, through `single`, other accounts' evidence), and so are banked ends whose consumed credit was granted within
 * 2 h of them (their origin reads other accounts' readings then). One range per batch; work already queued ahead of the
 * page cursor is not queued again.
 */
export function queueCreditEvidence(db: Database, instants: readonly number[]): void {
  if (!hasWindowEndCauses(db) || !instants.length) return;
  const from = Math.min(...instants) - CREDIT_REACH_MS, until = Math.max(...instants) + CREDIT_REACH_MS;
  if (!coveredByEntry(db, "window_end_cause_dirty", PAGE_KEY, "codex", END_CAUSES_ALL, from, until, longestWindowMs(db)))
    markWindowEndCausesDirty(db, "codex", END_CAUSES_ALL, from, until);
  for (const row of db.query(`SELECT provider, account, window_end FROM window_end_causes WHERE provider='codex' AND cause='banked'
      AND json_extract(evidence,'$.consumed.granted_at') >= ? AND json_extract(evidence,'$.consumed.granted_at') <= ?`)
    .all(iso(from - ORIGIN_GRANT_MS + CREDIT_REACH_MS), iso(until + ORIGIN_GRANT_MS - CREDIT_REACH_MS)) as Array<{ provider: string; account: string; window_end: string }>)
    markWindowEndCausesDirty(db, row.provider, row.account, Date.parse(row.window_end) - 1, Date.parse(row.window_end) + 1);
}

/** Clock work that is already held by a queued entry (and not behind its page cursor) is not queued again. */
function coverDue(db: Database, provider: string, account: string, fromMs: number, untilMs: number, window: PageKey): void {
  if (!coveredByEntry(db, "window_end_cause_dirty", PAGE_KEY, provider, account, fromMs, untilMs, longestWindowMs(db), window))
    markWindowEndCausesDirty(db, provider, account, fromMs, untilMs);
}

/** Queue entries from what is due (`dueWork`), in one short transaction. */
function queueChanges(db: Database, digest: string, now: number, compatibleDigest: string): void {
  const due = dueWork(db, digest, now, compatibleDigest);
  if (!due.marks.length && !due.full && !due.rows.length && meta(db, CONFIG_KEY) === digest) return;
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    if (due.full) markWindowEndCausesDirty(db, END_CAUSES_ALL, END_CAUSES_ALL, END_CAUSES_BEGINNING, null);
    else {
      for (const mark of due.marks) {
        if (mark.account === ANSWER_SCOPE_NONE) continue;
        // Other accounts' rows within 12 h read this account's windows: the whole provider's range is queued.
        markWindowEndCausesDirty(db, mark.provider === ANSWER_SCOPE_ALL ? END_CAUSES_ALL : mark.provider, END_CAUSES_ALL,
          mark.from_ms - DEPENDENCY_MS, mark.until_ms === null ? null : mark.until_ms + DEPENDENCY_MS);
      }
    }
    // Clock work stays due until done: queued once, so it never restarts an entry worked page by page.
    for (const row of due.rows) coverDue(db, row.provider, END_CAUSES_ALL, Date.parse(row.window_end) - 1, Date.parse(row.window_end) + 1,
      [row.window_start, row.provider, row.account, row.counter]);
    const last = Math.max(due.cursor, due.folded, due.marks.at(-1)?.seq ?? 0);
    if (last !== due.cursor) setMeta(db, MARKS_KEY, String(last));
    if (meta(db, CONFIG_KEY) !== digest) setMeta(db, CONFIG_KEY, digest);
  }).immediate();
}

/**
 * The corrections to apply this turn. Windows whose correction was added, changed or removed since the last turn are
 * queued (one instant each), in one short transaction with the new applied set; unreadable corrections keep the applied set.
 */
function queueOverrides(db: Database, overrides: readonly WindowEndOverride[] | null): Map<string, OverrideCause> {
  let applied: Array<[string, OverrideCause]> = [];
  try { applied = JSON.parse(meta(db, OVERRIDES_KEY) ?? "[]") as Array<[string, OverrideCause]>; } catch { /* Nothing applied yet. */ }
  if (overrides === null) return new Map(applied);
  const next = overrides.map((o) => [overrideKey(o), o.cause] as [string, OverrideCause]).sort((a, b) => a[0].localeCompare(b[0]));
  const before = new Map(applied), after = new Map(next);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
  if (!changed.length) return after;
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    for (const key of changed) {
      // Keys are provider|account|counter|start; a JSON counter may itself hold "|", the start never does.
      const [provider, account] = key.split("|"), start = Date.parse(key.slice(key.lastIndexOf("|") + 1));
      if (provider && account && Number.isFinite(start)) markWindowEndCausesDirty(db, provider, account, start, start + 1);
    }
    setMeta(db, OVERRIDES_KEY, JSON.stringify(next));
  }).immediate();
  return after;
}

/**
 * Whether the step still has queued or due work for an account (the billing view reports it as `stale`): the producer's
 * own predicates (`dueWork`) narrowed to what can change this account's rows.
 */
export function windowEndCausesStale(db: Database, provider: string, account: string, now = Date.now()): boolean {
  if (!hasWindowEndCauses(db)) return true;
  if (db.query("SELECT 1 FROM window_end_cause_dirty WHERE provider IN (?, '*') AND account IN (?, '*') LIMIT 1").get(provider, account)) return true;
  // A changed announced list is caught by the next turn; only a step that never ran is stale by configuration.
  const due = dueWork(db, null, now);
  if (due.full) return true;
  if (due.rows.some((row) => row.provider === provider)) return true;
  // Codex causes wait for credit evidence whose ownership is not written yet.
  if (provider === "codex" && !creditsReady(db)) return true;
  if (due.marks.some((mark) => (mark.provider === provider || mark.provider === "*") && (mark.account === account || mark.account === "*"))) return true;
  // Another account's change reaches only this account's early ends within 12 h of it (their causes read other accounts).
  const ends = (db.query(`SELECT window_end FROM window_end_causes WHERE provider=? AND account=? AND cause IN ('provider','provider_probable','single','unknown')`)
    .all(provider, account) as Array<{ window_end: string }>).map((row) => Date.parse(row.window_end));
  return due.marks.some((mark) => (mark.provider === provider || mark.provider === "*") && mark.account !== ANSWER_SCOPE_NONE
    && ends.some((at) => at >= mark.from_ms - DEPENDENCY_MS && (mark.until_ms === null || at <= mark.until_ms + DEPENDENCY_MS)));
}
