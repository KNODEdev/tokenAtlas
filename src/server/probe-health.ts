import type { Database } from "bun:sqlite";
import { ProbeAccountIndexUnavailable, preparedProbeAccountIndexReady, readPreparedProbeAccountRows, readPreparedProbeMachines } from "./current/probe-account-reader";
import type { CardActivity, CardHealth } from "./current/v2";
import { normEraVendor } from "./eras";
import { probeErrorCode, type ProbeNotice } from "../shared/probe-error";

/**
 * What the roster needs to know about a subscription's probe, across every
 * machine: the newest good sample (whoever took it) and, per machine, when it
 * last succeeded and last failed. Cards use it to tell "fresh" from "stale"
 * from "nobody probes this anywhere" without ever showing a raw API error as
 * the whole card.
 */
export type ProbeReadingState = "fresh" | "stale" | "none";

export interface ProbeReading {
  ts: string;
  age_minutes: number;
  machine: string | null;
}

export interface ProbeMachineStatus {
  machine: string | null;
  last_ok_ts: string | null;
  last_error_ts: string | null;
  last_error: string | null;
}

export interface ProbeHealth {
  provider: string;
  subject: string;
  state: ProbeReadingState;
  fresh_minutes: number;
  reading: ProbeReading | null;
  machines: ProbeMachineStatus[];
}

/** Minutes between account probes unless `TOKENATLAS_PROBE_MINUTES` says otherwise. */
export const DEFAULT_PROBE_MINUTES = 10;

/**
 * "Fresh" is three missed cycles of that provider's poller: the Gemini sweep
 * runs on its own, slower clock.
 */
export function probeFreshMinutes(provider: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = provider === "gemini" ? env.TOKENATLAS_GEMINI_MINUTES ?? "30" : env.TOKENATLAS_PROBE_MINUTES ?? String(DEFAULT_PROBE_MINUTES);
  const minutes = Number(raw);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : provider === "gemini" ? 30 : DEFAULT_PROBE_MINUTES) * 3;
}

function ageMinutes(ts: string, nowMs: number): number {
  return Math.round(((nowMs - new Date(ts).getTime()) / 60_000) * 10) / 10;
}

export function probeHealth(
  sqlite: Database,
  provider: string,
  subject: string,
  nowMs = Date.now(),
  freshMinutes = probeFreshMinutes(provider)
): ProbeHealth {
  const empty: ProbeHealth = { provider, subject, state: "none", fresh_minutes: freshMinutes, reading: null, machines: [] };
  const latest = readPreparedProbeAccountRows(sqlite, provider, subject, { index: "success", limit: 1 });
  const machines = readPreparedProbeMachines(sqlite, provider, subject);
  if (!latest || !machines) throw new ProbeAccountIndexUnavailable();
  const statuses: ProbeMachineStatus[] = [];
  for (const machine of machines.sort((a,b) => a === null ? -1 : b === null ? 1 : a.localeCompare(b))) {
    const ok = readPreparedProbeAccountRows(sqlite, provider, subject, { index: "machine-ok", machine, limit: 1 });
    const failed = readPreparedProbeAccountRows(sqlite, provider, subject, { index: "machine-error", machine, limit: 1 });
    if (!ok || !failed) throw new ProbeAccountIndexUnavailable();
    statuses.push({ machine, last_ok_ts: ok.rows[0]?.ts ?? null, last_error_ts: failed.rows[0]?.ts ?? null,
      last_error: failed.rows[0]?.error as string | null ?? null });
  }
  const newest = latest.rows[0] as { ts: string; machine: string | null } | undefined;
  if (!newest) return { ...empty, machines: statuses };
  const age = ageMinutes(newest.ts, nowMs);
  return {
    provider,
    subject,
    state: age <= freshMinutes ? "fresh" : "stale",
    fresh_minutes: freshMinutes,
    reading: { ts: newest.ts, age_minutes: age, machine: newest.machine },
    machines: statuses,
  };
}

/** The activity and health a published current card keeps of all its account's readings (`current/v2.ts`). */
export interface CardHistory { provider: string; subject: string; activity: CardActivity; health: CardHealth }
/**
 * Every published card's activity and health, one row per account. Until the first projection is
 * published, or while cards of an older format fold again, readers answer "preparing".
 */
export function readCardHistories(sqlite: Database): Map<string, CardHistory> {
  if (!preparedProbeAccountIndexReady(sqlite)) throw new ProbeAccountIndexUnavailable();
  const state = sqlite.query("SELECT generated_at FROM current_projection_state WHERE id=1").get() as { generated_at: string | null } | null;
  if (!state?.generated_at) throw new ProbeAccountIndexUnavailable();
  const rows = sqlite.query(`SELECT provider, subject, json_extract(data,'$.__activity') AS activity,
    json_extract(data,'$.__health') AS health FROM current_probe_subjects WHERE subject NOT LIKE ?`)
    .all("\u0001stage:%") as Array<{ provider: string; subject: string; activity: string | null; health: string | null }>;
  const out = new Map<string, CardHistory>();
  for (const row of rows) {
    if (row.activity === null || row.health === null) throw new ProbeAccountIndexUnavailable();
    out.set(cardKey(row.provider, row.subject), { provider: row.provider, subject: row.subject,
      activity: JSON.parse(row.activity) as CardActivity, health: JSON.parse(row.health) as CardHealth });
  }
  return out;
}
const cardKey = (provider: string, subject: string) => `${normEraVendor(provider)}\u0000${subject.toLowerCase()}`;
/** One account's stored activity; none when the account has no card (it owns no reading). */
/** Whether an account's published card holds a successful reading (none: the account has no qualifying reading). */
export const cardHasSuccess = (cards: ReadonlyMap<string, CardHistory>, provider: string, subject: string): boolean =>
  !!cards.get(cardKey(provider, subject))?.health.success;
export const cardActivity = (cards: ReadonlyMap<string, CardHistory>, provider: string, subject: string): CardActivity | null =>
  cards.get(cardKey(provider, subject))?.activity ?? null;
/** `probeHealth` from the account's published card; an account without a card owns no reading. */
export function cardProbeHealth(cards: ReadonlyMap<string, CardHistory>, provider: string, subject: string,
  nowMs = Date.now(), freshMinutes = probeFreshMinutes(provider)): ProbeHealth {
  const health = cards.get(cardKey(provider, subject))?.health ?? { success: null, machines: {} };
  const entries = Object.entries(health.machines);
  if (entries.length > 512) throw new ProbeAccountIndexUnavailable();
  const machines: ProbeMachineStatus[] = entries.map(([key, machine]) => ({ machine: JSON.parse(key) as string | null,
    last_ok_ts: machine.ok?.ts ?? null, last_error_ts: machine.err?.ts ?? null, last_error: machine.err?.error ?? null }))
    .sort((a, b) => a.machine === null ? -1 : b.machine === null ? 1 : a.machine.localeCompare(b.machine));
  const newest = health.success;
  if (!newest) return { provider, subject, state: "none", fresh_minutes: freshMinutes, reading: null, machines };
  const age = ageMinutes(newest.ts, nowMs);
  return { provider, subject, state: age <= freshMinutes ? "fresh" : "stale", fresh_minutes: freshMinutes,
    reading: { ts: newest.ts, age_minutes: age, machine: newest.machine }, machines };
}
/**
 * First and last reading per account id, across providers, from the published cards, and its cycles: the
 * distinct starts `cycles` gives for each of its cards (the stored limit windows, `cycleStarts`).
 */
export function cardSubscriptionActivity(cards: ReadonlyMap<string, CardHistory>,
  cycles: (provider: string, subject: string) => readonly string[]): Map<string, { first_seen: string | null;
  last_seen: string | null; cycle_count: number }> {
  const merged = new Map<string, { first: string; last: string; starts: Set<string> }>();
  for (const { provider, subject, activity } of cards.values()) {
    if (!activity.first || !activity.last) continue;
    const key = subject.toLowerCase(), entry = merged.get(key) ?? { first: activity.first.ts, last: activity.last.ts, starts: new Set() };
    if (activity.first.ts < entry.first) entry.first = activity.first.ts;
    if (activity.last.ts > entry.last) entry.last = activity.last.ts;
    for (const start of cycles(provider, subject)) entry.starts.add(start);
    merged.set(key, entry);
  }
  return new Map([...merged].map(([key, entry]) => [key, { first_seen: entry.first, last_seen: entry.last, cycle_count: entry.starts.size }]));
}

/**
 * The status bar's sign-in notices: per account and computer, a newest failure (newer than its last success)
 * whose error carries a code the user can fix. Read from the published cards' health, one row per account.
 */
export function probeNotices(cards: ReadonlyMap<string, CardHistory>,
  accountName: (provider: string, subject: string) => string | null = () => null): ProbeNotice[] {
  const notices: ProbeNotice[] = [];
  for (const { provider, subject, health } of cards.values()) {
    for (const [key, machine] of Object.entries(health.machines)) {
      const failed = machine.err;
      if (!failed || (machine.ok && machine.ok.ts >= failed.ts)) continue;
      const code = probeErrorCode(failed.error);
      if (!code) continue;
      notices.push({ provider, subject, account: accountName(provider, subject), machine: JSON.parse(key) as string | null,
        code, since: machine.ok?.ts ?? null, failed_at: failed.ts });
    }
  }
  return notices.sort((a, b) => a.provider.localeCompare(b.provider) || (a.account ?? a.subject).localeCompare(b.account ?? b.subject)
    || (a.machine ?? "").localeCompare(b.machine ?? ""));
}

/**
 * Every (provider, subject) pair that owns a reading, for the Sources screen: from the published cards, the same
 * health `probeHealth` reads from all the account's readings (each computer's every reading took ~1 s per request).
 */
export function allProbeHealth(sqlite: Database, nowMs = Date.now()): ProbeHealth[] {
  const cards = readCardHistories(sqlite);
  const pairs = (sqlite.query("SELECT provider,subject FROM current_probe_subjects ORDER BY provider,subject")
    .all() as Array<{ provider: string; subject: string }>).filter(row => !row.subject.startsWith("\u0001stage:")
      && Object.keys(cards.get(cardKey(row.provider, row.subject))?.health.machines ?? {}).length > 0);
  return pairs.map((pair) => cardProbeHealth(cards, pair.provider, pair.subject, nowMs));
}
