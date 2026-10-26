/**
 * Credit pools: packages a subscription receives beside its windows (grants, purchased credits, a credit
 * balance, free limit resets). They are read from the stored extra of a limit reading: Claude carries a
 * grant as a codenamed raw meter with `limit_dollars`, Codex the balance and reset credits written by its
 * probe. A pool does not renew; what it lost between two readings was spent, what it gained was received.
 */

export type CreditPoolKind = "grant" | "purchase" | "balance" | "resets";
export type CreditPoolUnit = "usd" | "credits" | "resets";

export interface CreditResetItem {
  id: string;
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
  title: string | null;
}

export interface CreditPoolState {
  /** Stable within the account: `claude:<meter>`, `claude:spend`, `codex:credits`, `codex:resets`. */
  key: string;
  kind: CreditPoolKind;
  unit: CreditPoolUnit;
  /** Granted amount when the vendor states it; a bare balance has none. */
  granted: number | null;
  used: number | null;
  remaining: number | null;
  /** The vendor's exact decimal text when it sends one (the Codex balance). */
  remaining_text: string | null;
  unlimited: boolean;
  granted_at: string | null;
  expires_at: string | null;
  items: CreditResetItem[] | null;
}

export interface CreditPoolFlow {
  key: string;
  unit: CreditPoolUnit;
  /** The reading the range's first change is measured from; before the range when readings had a gap. */
  since: string;
  /** Remaining at `since` and at the range's last reading. */
  start_remaining: number | null;
  end_remaining: number | null;
  /** Sum of decreases between consecutive readings (resets: items gone before their expiry). */
  spent: number;
  /** Sum of increases (a new grant, a top-up, a new reset). */
  added: number;
  /** Resets that disappeared at or after their expiry: lost, not spent. */
  expired: number;
}

export interface CreditPoolsOfRange {
  read_at: string;
  pools: CreditPoolState[];
  flows: CreditPoolFlow[];
  /** Absent in older responses: no timeline is known, rather than zero spending. */
  timelines?: CreditPoolTimeline[];
}

export interface CreditPoolMovement {
  since: string;
  observed_at: string;
  spent: number;
  added: number;
  expired: number;
}

export interface CreditPoolTimeline {
  key: string;
  kind: CreditPoolKind;
  unit: CreditPoolUnit;
  baseline_at: string;
  through: string;
  /** A predecessor at/before the range exists; intervals crossing the boundary still retain `since`. */
  opening_known: boolean;
  complete: boolean;
  movements: CreditPoolMovement[];
}

export const CLAUDE_RAW_PREFIX = "claude.raw.";
export const CODEX_CREDITS_BALANCE = "codex.credits.balance";
export const CODEX_CREDITS_HAS = "codex.credits.has_credits";
export const CODEX_CREDITS_UNLIMITED = "codex.credits.unlimited";
export const CODEX_RESET_CREDITS = "codex.reset_credits";
/** The Codex probe records credits from this day on; earlier readings carry none, so readers skip them. */
export const CODEX_CREDITS_RECORDED_FROM = Date.parse("2026-10-09T00:00:00.000Z");

const POOL_MARKERS = ["limit_dollars", `${CLAUDE_RAW_PREFIX}spend.`, CODEX_CREDITS_BALANCE, CODEX_RESET_CREDITS];
/** Meters that already are limit windows, never pools. */
const WINDOW_METERS = new Set(["five_hour", "seven_day"]);

const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
};
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;

function claudePools(extra: Record<string, unknown>): CreditPoolState[] {
  const meters = new Map<string, Map<string, unknown>>();
  for (const [path, value] of Object.entries(extra)) {
    if (!path.startsWith(CLAUDE_RAW_PREFIX)) continue;
    const [meter, ...rest] = path.slice(CLAUDE_RAW_PREFIX.length).split(".");
    if (!meter || rest.length === 0) continue;
    const fields = meters.get(meter) ?? new Map<string, unknown>();
    fields.set(rest.join("."), value);
    meters.set(meter, fields);
  }
  const pools: CreditPoolState[] = [];
  for (const [meter, fields] of meters) {
    if (WINDOW_METERS.has(meter)) continue;
    const limit = num(fields.get("limit_dollars"));
    if (limit == null) continue;
    const used = num(fields.get("used_dollars"));
    const remaining = num(fields.get("remaining_dollars")) ?? (used == null ? null : limit - used);
    pools.push({ key: `claude:${meter}`, kind: "grant", unit: "usd", granted: limit, used, remaining,
      remaining_text: null, unlimited: false, granted_at: null, expires_at: text(fields.get("resets_at")), items: null });
  }
  // Purchased extra usage is billed from `spend`; it is a pool only while extra usage is on.
  const usage = meters.get("extra_usage"), spend = meters.get("spend");
  if (usage?.get("is_enabled") === true && spend) {
    const scale = 10 ** (num(spend.get("used.exponent")) ?? 2);
    const usedMinor = num(spend.get("used.amount_minor")), limitMinor = num(spend.get("limit.amount_minor"));
    const used = usedMinor == null ? null : usedMinor / scale, granted = limitMinor == null ? null : limitMinor / scale;
    pools.push({ key: "claude:spend", kind: "purchase", unit: "usd", granted, used,
      remaining: granted == null || used == null ? null : granted - used, remaining_text: null, unlimited: false,
      granted_at: null, expires_at: null, items: null });
  }
  return pools.sort((a, b) => a.key.localeCompare(b.key));
}

/** The reset list as the Codex probe stores it: a JSON array text. */
export function decodeCodexResetItems(value: unknown): CreditResetItem[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item): CreditResetItem[] => {
      if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") return [];
      const row = item as Record<string, unknown>;
      return [{ id: row.id as string, status: text(row.status), granted_at: text(row.granted_at),
        expires_at: text(row.expires_at), title: text(row.title) }];
    });
  } catch { return null; }
}

function codexPools(extra: Record<string, unknown>): CreditPoolState[] {
  const pools: CreditPoolState[] = [];
  const balanceText = text(extra[CODEX_CREDITS_BALANCE]);
  const unlimited = extra[CODEX_CREDITS_UNLIMITED] === true;
  const balance = num(balanceText);
  // An account without credits reports has_credits=false and no balance; that is no pool, not a zero one.
  if (unlimited || (balance != null && (extra[CODEX_CREDITS_HAS] === true || balance > 0)))
    pools.push({ key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: balance,
      remaining_text: balanceText, unlimited, granted_at: null, expires_at: null, items: null });
  const items = decodeCodexResetItems(extra[CODEX_RESET_CREDITS]);
  // An empty list is kept: the last reset used or lost must still show as a movement to zero.
  if (items) {
    const available = items.filter(item => item.status == null || item.status === "available");
    const expiries = available.map(item => item.expires_at).filter((at): at is string => at != null).sort();
    pools.push({ key: "codex:resets", kind: "resets", unit: "resets", granted: null, used: null,
      remaining: available.length, remaining_text: null, unlimited: false, granted_at: null,
      expires_at: expiries[0] ?? null, items: available });
  }
  return pools;
}

/**
 * Whether a stored reading states pools at all, so an empty decode means "no pools" rather than "not
 * known". Claude puts its raw meters only on the account weekly reading; the Codex probe writes the
 * credit keys on every reading since 09.10. Older readings state nothing.
 */
export function statesCreditPools(provider: string, extra: Record<string, unknown> | null): boolean {
  if (!extra) return false;
  if (provider === "claude") return Object.keys(extra).some(path => path.startsWith(CLAUDE_RAW_PREFIX));
  if (provider === "codex") return CODEX_RESET_CREDITS in extra || CODEX_CREDITS_HAS in extra;
  return false;
}

/** The pools stated by one stored reading's extra. */
export function decodeCreditPools(provider: string, extra: Record<string, unknown> | null): CreditPoolState[] {
  if (!extra) return [];
  if (provider === "claude") return claudePools(extra);
  if (provider === "codex") return codexPools(extra);
  return [];
}

export interface CreditPoolReading { ts: string; pools: CreditPoolState[] }

/** The readings that carry pools, decoded and in time order. */
export function creditPoolReadings(provider: string,
  samples: ReadonlyArray<{ ts: string; extra?: string | null }>): CreditPoolReading[] {
  const readings: CreditPoolReading[] = [];
  for (const sample of samples) {
    // Most stored readings predate pools; a substring check spares parsing them.
    if (!sample.extra || !POOL_MARKERS.some(marker => sample.extra!.includes(marker))) continue;
    let extra: Record<string, unknown>;
    try { extra = JSON.parse(sample.extra) as Record<string, unknown>; } catch { continue; }
    const pools = decodeCreditPools(provider, extra);
    if (pools.length > 0) readings.push({ ts: sample.ts, pools });
  }
  return readings.sort((a, b) => a.ts.localeCompare(b.ts));
}

type Step = { spent: number; added: number; expired: number };
const DECIMAL = /^-?\d+(\.\d+)?$/;
/** The difference of two vendor decimal texts without binary rounding (the Codex balance has 10 places). */
function exactDelta(before: string | null, after: string | null): number | null {
  if (before == null || after == null || !DECIMAL.test(before) || !DECIMAL.test(after)) return null;
  const places = Math.max(before.split(".")[1]?.length ?? 0, after.split(".")[1]?.length ?? 0);
  const scaled = (value: string) => { const [whole, fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(places, "0")); };
  const diff = scaled(after) - scaled(before);
  const negative = diff < 0n, digits = (negative ? -diff : diff).toString().padStart(places + 1, "0");
  return Number(`${negative ? "-" : ""}${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places) || "0"}`);
}
function stepBetween(prior: CreditPoolState, pool: CreditPoolState, at: string): Step {
  const step: Step = { spent: 0, added: 0, expired: 0 };
  if (pool.kind === "resets") {
    const before = new Map((prior.items ?? []).map(item => [item.id, item]));
    const now = new Set((pool.items ?? []).map(item => item.id));
    for (const item of pool.items ?? []) if (!before.has(item.id)) step.added += 1;
    for (const [id, item] of before) {
      if (now.has(id)) continue;
      if (item.expires_at != null && Date.parse(item.expires_at) <= Date.parse(at)) step.expired += 1;
      else step.spent += 1;
    }
  } else if ((pool.kind === "grant" || pool.kind === "purchase") && prior.used != null && pool.used != null) {
    // A grant states its use directly; a larger limit is a top-up of the same grant.
    step.spent = Math.max(0, pool.used - prior.used);
    if (prior.granted != null && pool.granted != null) step.added = Math.max(0, pool.granted - prior.granted);
  } else if (prior.remaining != null && pool.remaining != null) {
    const delta = exactDelta(prior.remaining_text, pool.remaining_text) ?? pool.remaining - prior.remaining;
    if (delta < 0) step.spent = -delta; else step.added = delta;
  }
  return step;
}

/**
 * Received, spent and lost amounts of the readings in `[fromMs, untilMs]`. Each change between two
 * consecutive readings of a pool belongs to the range of the later one, so a change across a gap between
 * windows (the app was off) is counted once, in the window it was first seen; `since` then precedes the range.
 * A pool missing from a reading (an older probe, an expired grant) is no movement.
 */
function foldCreditPools(readings: readonly CreditPoolReading[], fromMs: number, untilMs: number):
  { flows: CreditPoolFlow[]; timelines: CreditPoolTimeline[] } {
  const last = new Map<string, { pool: CreditPoolState; ts: string }>();
  const flows = new Map<string, CreditPoolFlow>();
  const timelines = new Map<string, CreditPoolTimeline>();
  for (const reading of readings) {
    const at = Date.parse(reading.ts);
    if (at > untilMs) break;
    const inside = at >= fromMs;
    for (const pool of reading.pools) {
      const prior = last.get(pool.key);
      const readable = pool.kind === "resets" ? pool.items != null : pool.used != null || pool.remaining != null;
      if (!readable) {
        const timeline = timelines.get(pool.key);
        if (inside && timeline) timeline.complete = false;
        continue;
      }
      last.set(pool.key, { pool, ts: reading.ts });
      if (!inside) continue;
      let flow = flows.get(pool.key);
      if (!flow) {
        flow = { key: pool.key, unit: pool.unit, since: prior?.ts ?? reading.ts,
          start_remaining: prior?.pool.remaining ?? pool.remaining, end_remaining: pool.remaining, spent: 0, added: 0, expired: 0 };
        flows.set(pool.key, flow);
        timelines.set(pool.key, { key: pool.key, kind: pool.kind, unit: pool.unit,
          baseline_at: prior?.ts ?? reading.ts, through: reading.ts,
          opening_known: prior != null && Date.parse(prior.ts) <= fromMs || Date.parse(reading.ts) === fromMs,
          complete: true, movements: [] });
      }
      const timeline = timelines.get(pool.key)!;
      timeline.through = reading.ts;
      if (prior) {
        const comparable = pool.kind === "resets" ? prior.pool.items != null
          : (pool.kind === "grant" || pool.kind === "purchase") && prior.pool.used != null && pool.used != null
            || prior.pool.remaining != null && pool.remaining != null;
        if (!comparable) timeline.complete = false;
        if ((pool.kind === "grant" || pool.kind === "purchase") && prior.pool.used != null && pool.used != null && pool.used < prior.pool.used)
          timeline.complete = false;
        const step = stepBetween(prior.pool, pool, reading.ts);
        flow.spent += step.spent; flow.added += step.added; flow.expired += step.expired;
        if (step.spent !== 0 || step.added !== 0 || step.expired !== 0)
          timeline.movements.push({ since: prior.ts, observed_at: reading.ts, ...step });
      }
      flow.end_remaining = pool.remaining;
    }
  }
  // Binary noise below a billionth is not a movement; the exact balance text stays on the pool.
  const clean = (value: number) => Math.round(value * 1e9) / 1e9;
  return { flows: [...flows.values()].map(flow => ({ ...flow, spent: clean(flow.spent), added: clean(flow.added) }))
    .sort((a, b) => a.key.localeCompare(b.key)),
    timelines: [...timelines.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export function creditPoolFlows(readings: readonly CreditPoolReading[], fromMs = -Infinity, untilMs = Infinity): CreditPoolFlow[] {
  return foldCreditPools(readings, fromMs, untilMs).flows;
}

/** Pools at the newest reading of `[fromMs, untilMs]` and their movement within it. */
export function creditPoolsInRange(readings: readonly CreditPoolReading[], fromMs: number, untilMs: number): CreditPoolsOfRange | null {
  let newest: CreditPoolReading | undefined;
  for (const reading of readings) {
    const at = Date.parse(reading.ts);
    if (at > untilMs) break;
    if (at >= fromMs) newest = reading;
  }
  if (!newest) return null;
  return { read_at: newest.ts, pools: newest.pools, ...foldCreditPools(readings, fromMs, untilMs) };
}

/** Pools and movement over all readings given. */
export function creditPoolsOfRange(provider: string,
  samples: ReadonlyArray<{ ts: string; extra?: string | null }>): CreditPoolsOfRange | null {
  return creditPoolsInRange(creditPoolReadings(provider, samples), -Infinity, Infinity);
}
