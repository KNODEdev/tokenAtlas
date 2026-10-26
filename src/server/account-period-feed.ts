import type { Database } from "bun:sqlite";
import { newestPlanProfile, planOfTier } from "../providers/vendor-identity";
import { canonicalPeriodPlan, looksLikeNoPlan } from "../shared/period-end";
import { observedPeriods, periodInstant, periodSubjectKey, type DatedPeriod, type PeriodReading } from "./account-periods";
import type { SourceDeclaration } from "./archive-source";
import { probeArchiveSourceOf, probeSourceTupleOf, sourceOfProbeTuple, type ProbeSourceOptions, type ProbeSourceTuple } from "./probe-source";
import { probeSourcesPublished } from "../db/probe-sources";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, moveObservedStart, recordPeriodReading, replaceObservedPeriods, type PeriodTable } from "../db/period-store";
import { normEraKey, normEraVendor } from "./eras";
import { ledgerSourceFirstCall } from "./ledger-sums";
import { codexIdentityAliases, rememberedCodexAccounts, type CodexDeclaration } from "./codex-discovery";

/**
 * Feeds observed account periods from probe readings. Every reading names the signed-in account
 * and reaches this database from both computers through the gauge journal, so one pass over new
 * `probe_windows` rows serves live readings, the other PC's journal and the first fill alike.
 *
 * Work is bounded by the new rows since the stored cursor. A reading older than its subject's
 * last one queues that subject durably; one provider scan rebuilds pending subjects after catch-up.
 */
export interface AccountPeriodFeedOptions {
  declarations: readonly SourceDeclaration[];
  archiveRoot: string;
  /** Windows account the application runs under; owns Claude's login-less archive folder. */
  defaultLogin: string;
  /** Declared subscriptions; a Codex reading stamped with a minted id of a declared login counts for that login. */
  subscriptions?: readonly CodexDeclaration[];
  /** Minted id -> declared id (lower-case keys); derived from `subscriptions` and the readings when absent. */
  codexAliases?: ReadonlyMap<string, string>;
  batch?: number;
}
export interface AccountPeriodFeedResult { rows: number; readings: number; planReadings: number; unmapped: number; rebuilt: string[]; done: boolean }

const CURSOR_KEY = "account_periods_probe_cursor";
const PENDING_KEY = "account_periods_probe_pending";
interface PendingSubject { provider: string; subject: string }
interface PendingPeriods { accounts: PendingSubject[]; plans: PendingSubject[] }
/**
 * Which readings feed plan periods. Bumped when a rule changes (4: a fetch instant showing two plans
 * dates its readings by when they were taken; 3: catalog plan names;
 * 2: Codex's plan from its rate-limit
 * answers), so the plan track is rebuilt once from the readings the cursor already passed instead of
 * waiting for new ones; the table is ~30 rows and the readings are all here.
 */
const PLAN_RULES_KEY = "plan_periods_rules", PLAN_RULES = "4";
/**
 * The same for account periods. 2: Antigravity pool readings map to their worker's source, outrank
 * a Gemini CLI account read on that source, and every account a source showed is remembered.
 */
const ACCOUNT_RULES_KEY = "account_periods_rules", ACCOUNT_RULES = "2";
/** Every account any reading named per subject (lower case), whether or not it defines a period. */
const SEEN_KEY = "account_periods_seen_accounts";
type SeenAccounts = Record<string, string[]>;
/**
 * `probedAt`: when a profile reading was taken; its `ts` is when the CLI fetched that profile.
 * `failed`: the probe that took it could not read the account.
 */
type FeedReading = PeriodReading & { evidence?: string; probedAt?: string; failed?: boolean };
/**
 * The source declarations the readings the cursor passed were read under. A reading of an undeclared
 * profile is unmapped and passed; once a declaration maps the profile, the sources it moves between are
 * rebuilt from their readings, so their periods start at the first reading, not at the next one.
 */
const SOURCES_KEY = "account_periods_sources";
/**
 * The Codex aliases the readings the cursor passed were read under (`codexIdentityAliases`). When they
 * change, only the sources that showed an affected id and the affected ids' plan subjects are rebuilt.
 */
const ALIASES_KEY = "account_periods_codex_aliases";
const aliasesOf = (sqlite: Database, options: AccountPeriodFeedOptions): ReadonlyMap<string, string> =>
  options.codexAliases ?? (options.subscriptions?.some(s => (s.vendor ?? "codex") === "codex" && !s.id.includes("::"))
    // Without a declared Codex login there is nothing to resolve to, so the readings are not consulted.
    ? codexIdentityAliases(rememberedCodexAccounts(sqlite), options.subscriptions) : new Map());
const aliasText = (aliases: ReadonlyMap<string, string>): string => JSON.stringify([...aliases].sort(([a], [b]) => a.localeCompare(b)));
/** Ids whose alias appeared, vanished or moved, with the declared ids on either side (lower case). */
function changedAliasIds(before: string | null, now: ReadonlyMap<string, string>): Set<string> {
  const prior = new Map<string, string>(before ? JSON.parse(before) as Array<[string, string]> : []), out = new Set<string>();
  for (const id of new Set([...prior.keys(), ...now.keys()])) {
    const a = prior.get(id), b = now.get(id);
    if (a === b) continue;
    out.add(id);
    if (a) out.add(a.toLowerCase());
    if (b) out.add(b.toLowerCase());
  }
  return out;
}
/** What decides a reading's archive source (`archiveSourceOf`), in a stable order. */
function sourceMapping(options: AccountPeriodFeedOptions): string {
  const declarations = options.declarations.map(d => ({ vendor: normEraVendor(d.vendor), machine: d.machine ?? null,
    home: d.home ?? null, source_home: d.source_home ?? null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ archiveRoot: options.archiveRoot, defaultLogin: options.defaultLogin, declarations });
}
/** The physical profiles readings were taken under: the evidence's few dozen tuples, or the readings themselves before it is written. */
function physicalProfiles(sqlite: Database): Array<{ provider: string; tuple: ProbeSourceTuple }> {
  if (probeSourcesPublished(sqlite))
    return (sqlite.query("SELECT provider, machine, home, login FROM probe_source_tuples").all() as Array<ProbeSourceTuple & { provider: string }>)
      .map(({ provider, ...tuple }) => ({ provider, tuple }));
  const out = new Map<string, { provider: string; tuple: ProbeSourceTuple }>();
  for (const row of sqlite.query(`SELECT ${PROBE_COLUMNS} FROM probe_windows`).iterate() as Iterable<ProbeRow>) {
    const tuple = probeSourceTupleOf(row);
    if (tuple) out.set(JSON.stringify([row.provider, normEraKey(tuple.machine), normEraKey(tuple.home), normEraKey(tuple.login)]), { provider: row.provider, tuple });
  }
  return [...out.values()];
}
/**
 * The sources whose readings change with the declarations: those a known profile maps to before and
 * after. Without the earlier declarations (fed before they were kept), the sources a profile maps to
 * that have no observed period yet: a declaration added before this rule ran.
 */
function remappedSources(sqlite: Database, before: ProbeSourceOptions | null, after: ProbeSourceOptions): PendingSubject[] {
  const out = new Map<string, PendingSubject>();
  const add = (provider: string, source: string | null) => { if (source) out.set(periodSubjectKey(provider, source), { provider, subject: source }); };
  const observed = sqlite.query("SELECT 1 FROM account_periods WHERE provider = ? AND source = ? COLLATE NOCASE AND origin = 'observed' LIMIT 1");
  for (const { provider, tuple } of physicalProfiles(sqlite)) {
    const next = sourceOfProbeTuple(provider, tuple, after);
    if (before) {
      const prior = sourceOfProbeTuple(provider, tuple, before);
      if (normEraKey(prior) !== normEraKey(next)) { add(provider, prior); add(provider, next); }
    } else if (next && !observed.get(normEraVendor(provider), next)) add(provider, next);
  }
  return [...out.values()].sort((a, b) => periodSubjectKey(a.provider, a.subject).localeCompare(periodSubjectKey(b.provider, b.subject)));
}

/**
 * Which identity speaks for a source that two surfaces read. A Gemini archive folder keeps the
 * Antigravity CLI's conversations (`antigravity-cli/conversations`, `sync/mirror.ts`), and Antigravity
 * signs in on its own (`antigravity-cli/antigravity-oauth-token`), apart from Gemini CLI's
 * `google_accounts.json`. The pool's Antigravity login therefore outranks the Gemini CLI account read
 * in the same Windows profile; without a pool login the Gemini CLI account is the only evidence and stands.
 */
export const POOL_LOGIN_EVIDENCE = "antigravity-pool-login";
const rankOf = (evidence: string | null | undefined): number => evidence === POOL_LOGIN_EVIDENCE ? 1 : 0;
/** The readings of one subject that define its periods: those of the highest rank it has. */
export function admissibleReadings<T extends FeedReading>(readings: readonly T[]): T[] {
  const top = Math.max(...readings.map(r => rankOf(r.evidence)));
  return readings.filter(r => rankOf(r.evidence) === top);
}
function observedFeedPeriods(readings: readonly FeedReading[]) {
  return observedPeriods(readings).map(period => {
    const reading = readings.find(r => periodSubjectKey(r.provider, r.subject) === periodSubjectKey(period.provider, period.subject)
      && r.ts === period.from && r.value === period.value);
    return reading?.evidence ? { ...period, evidence: reading.evidence } : period;
  });
}
/** `ok`: 0 when the probe failed (an error answer); null or 1 when it read the account. */
interface ProbeRow { id: number; provider: string; ts: string; plan: string | null; machine: string | null; profile: string | null; extra: string | null; ok?: number | null }
const PROBE_COLUMNS = "id, provider, ts, plan, machine, profile, extra, ok";

function parse(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** The account reading a probe row carries, or null when it names no account or its profile has no archive folder. */
export function accountReadingOf(row: ProbeRow, options: AccountPeriodFeedOptions): FeedReading | "unmapped" | null {
  const extra = parse(row.extra);
  if (!extra) return null;
  // Codex and the other vendors record the same fact under two names.
  const codex = parse(extra.codex_account), vendor = parse(extra.vendor_account);
  const stamped = codex ? text(codex.subscription) : vendor ? text(vendor.id) : null;
  if (!stamped) return null;
  const account = codex ? options.codexAliases?.get(stamped.toLowerCase()) ?? stamped : stamped;
  const subject = probeArchiveSourceOf(row, options);
  if (!subject) return "unmapped";
  const pooled = !codex && /^pool:/i.test(text(extra.home) ?? "");
  return { provider: row.provider, subject, ts: row.ts, value: account, ...(pooled ? { evidence: POOL_LOGIN_EVIDENCE } : {}) };
}

/** A reading's plan in catalog spelling; the reserved "no subscription" value is the owner's to declare, never read. */
const observedPlan = (raw: string): string | null => { const value = planOfTier(raw) ?? raw; return looksLikeNoPlan(value) ? null : value; };

/**
 * The plan reading a probe row carries, normalized to the catalog with raw wording in evidence.
 * Codex reports the plan with every
 * rate-limit answer, so the reading is dated by the answer. Claude's comes from the profile's rate-limit
 * tier, dated by when the CLI fetched that profile, so a stale profile repeats one instant and adds nothing.
 */
export function planReadingOf(row: ProbeRow, codexAliases?: ReadonlyMap<string, string>): FeedReading | null {
  const extra = parse(row.extra);
  const codex = parse(extra?.codex_account);
  if (codex) {
    const stamped = text(codex.subscription), plan = text(row.plan);
    const account = stamped ? codexAliases?.get(stamped.toLowerCase()) ?? stamped : null;
    return account && plan && observedPlan(plan) ? { provider: row.provider, subject: account, ts: row.ts, value: observedPlan(plan)!,
      evidence: JSON.stringify({ kind: "profile-reading", rawPlan: plan }) } : null;
  }
  const vendor = parse(extra?.vendor_account);
  const account = text(vendor?.id), home = text(extra?.home);
  if (!vendor || !account || !home || !Array.isArray(vendor.profiles)) return null;
  const profile = newestPlanProfile(vendor.profiles.map(parse)
    .filter((p): p is NonNullable<typeof p> => !!p && text(p.home) === home && (!row.machine || text(p.machine) === row.machine))
    .map((p): Record<string, unknown> & { planReadAt?: string } => ({ ...p, planReadAt: text(p.planReadAt) ?? undefined })));
  const tier = text(profile?.planTier), at = text(profile?.planReadAt);
  return tier && at && observedPlan(tier) ? { provider: row.provider, subject: account, ts: at, value: observedPlan(tier)!,
    evidence: JSON.stringify({ kind: "profile-reading", rawPlan: tier }), probedAt: row.ts, ...(row.ok === 0 ? { failed: true } : {}) } : null;
}

/** A profile reading dated by when it was taken; `fetchedAt` keeps the instant the CLI left unchanged. */
function takenAt(reading: FeedReading): FeedReading {
  return { ...reading, ts: reading.probedAt!, evidence: JSON.stringify({ ...parse(reading.evidence), fetchedAt: reading.ts }) };
}
/**
 * The CLI can rewrite a profile's tier without a new fetch time (24.10.2026: Pro under the instant
 * Max 20x was read at). An instant that shows two plans dates no change, so every reading under it
 * is dated by when it was taken: the old plan runs to its last reading, the new one from its first.
 * Only readings that reached the account count then: a refused probe repeats a cached tier and
 * proves no access (24.10: Max showed until 12:45, usage was refused from 10:03).
 */
export function splitSharedFetch<T extends FeedReading>(readings: readonly T[]): T[] {
  const plans = new Map<string, Set<string>>();
  const key = (r: T) => `${periodSubjectKey(r.provider, r.subject)}|${r.ts}`;
  for (const r of readings) if (r.probedAt) (plans.get(key(r)) ?? plans.set(key(r), new Set()).get(key(r))!).add(canonicalPeriodPlan(r.value));
  return readings.flatMap(r => !r.probedAt || plans.get(key(r))!.size < 2 ? [r] : r.failed ? [] : [takenAt(r) as T]);
}

function meta(sqlite: Database, key: string): string | null {
  sqlite.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  return (sqlite.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}
function setMeta(sqlite: Database, key: string, value: string): void {
  sqlite.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

interface Track {
  table: PeriodTable; label: string; readingOf(row: ProbeRow): FeedReading | "unmapped" | null;
  /** The readings of one subject that define its periods; all of them when absent. */
  select?(readings: readonly FeedReading[]): FeedReading[];
}

interface PreparedSubject extends PendingSubject { track: Track; periods: ReturnType<typeof observedFeedPeriods> }
const prepare = (track: Track, readings: readonly FeedReading[]) => observedFeedPeriods(track.select?.(readings) ?? readings);
function addSeen(seen: SeenAccounts, reading: FeedReading): boolean {
  const key = periodSubjectKey(reading.provider, reading.subject), value = reading.value.toLowerCase(), list = seen[key] ??= [];
  if (list.includes(value)) return false;
  list.push(value);
  list.sort();
  return true;
}
/** Read and calculate before acquiring the writer. */
function rebuildTrack(sqlite: Database, track: Track, upTo: number): { prepared: PreparedSubject[]; seen: SeenAccounts } {
  const bySubject = new Map<string, FeedReading[]>(), seen: SeenAccounts = {};
  for (const row of sqlite.query(`SELECT ${PROBE_COLUMNS} FROM probe_windows WHERE id <= ? ORDER BY id`).iterate(upTo) as Iterable<ProbeRow>) {
    const reading = track.readingOf(row);
    if (!reading || reading === "unmapped") continue;
    const key = periodSubjectKey(reading.provider, reading.subject);
    const list = bySubject.get(key) ?? [];
    list.push(reading);
    bySubject.set(key, list);
    addSeen(seen, reading);
  }
  return { seen, prepared: [...bySubject.values()].map(readings => ({ provider: readings[0]!.provider, subject: readings[0]!.subject,
    track, periods: prepare(track, readings) })) };
}

/** Who is signed in at one source, as its latest reading names it. */
export interface ObservedIdentity {
  provider: string;
  /** Archive source of the observed period, e.g. `codex/example-main-sample_a`. */
  source: string;
  account: string;
  machine: string | null;
  home: string | null;
  identity_kind: "email" | "profile";
  identity: string;
  /** Start of the running period: the first reading of this account at this source. */
  since: string;
  /** The period's `last_seen`. */
  ts: string;
}

/**
 * The identity behind every running observed account period: the reading at its `last_seen` carries
 * the vendor's email (or profile key). A few period rows and one indexed lookup each; the readings
 * stay the evidence, so no separate observation log is kept.
 */
export function observedIdentities(sqlite: Database, feedOptions: AccountPeriodFeedOptions): ObservedIdentity[] {
  const options = { ...feedOptions, codexAliases: aliasesOf(sqlite, feedOptions) };
  const periods = sqlite.query(`SELECT provider, source, account, from_ts, last_seen FROM account_periods
    WHERE origin = 'observed' AND until_ts IS NULL AND last_seen IS NOT NULL ORDER BY provider, source`)
    .all() as Array<{ provider: string; source: string; account: string; from_ts: string; last_seen: string }>;
  const readingsAt = sqlite.query(`SELECT ${PROBE_COLUMNS} FROM probe_windows WHERE provider = ? AND ts = ? ORDER BY id DESC`);
  const out: ObservedIdentity[] = [];
  for (const period of periods) {
    const key = periodSubjectKey(period.provider, period.source);
    for (const row of readingsAt.all(period.provider, period.last_seen) as ProbeRow[]) {
      const reading = accountReadingOf(row, options);
      if (!reading || reading === "unmapped" || periodSubjectKey(reading.provider, reading.subject) !== key
        || reading.value.toLowerCase() !== period.account.toLowerCase()) continue;
      const extra = parse(row.extra), account = parse(extra?.codex_account) ?? parse(extra?.vendor_account);
      const email = text(account?.email), profile = text(account?.key) ?? period.account;
      out.push({ provider: period.provider, source: period.source, account: period.account,
        machine: row.machine ?? text(account?.machine), home: text(account?.home) ?? text(extra?.home),
        identity_kind: email ? "email" : "profile", identity: email ?? profile, since: period.from_ts, ts: period.last_seen });
      break;
    }
  }
  return out;
}

/** Limit readings the period feed has not read yet, for the progress register; one primary-key range count. */
function feedCursor(db: Database): number | null {
  if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('probe_windows','meta')").all().length !== 2) return null;
  return Number((db.query("SELECT value FROM meta WHERE key=?").get(CURSOR_KEY) as { value: string } | null)?.value ?? 0) || 0;
}
export function accountPeriodBacklog(db: Database): number | null {
  const cursor = feedCursor(db);
  return cursor === null ? null : (db.query("SELECT count(*) n FROM probe_windows WHERE id>?").get(cursor) as { n: number }).n;
}
/** Readings past the feed's cursor exist: one primary-key seek. */
export function accountPeriodFeedBehind(db: Database): boolean {
  const cursor = feedCursor(db);
  return cursor !== null && !!db.query("SELECT 1 FROM probe_windows WHERE id>? LIMIT 1").get(cursor);
}

export interface ObservedStart { provider: string; subject: string; from: string }
/**
 * Where the earliest observed period of each source should start. A source whose readings named one
 * account on every surface, and whose owner declared nothing, keeps that account back to its first
 * call: before the first reading nobody else was ever seen there (proposal, model doc §11). Any second
 * account or declaration on the source keeps the observed start, the first reading. Codex is excluded:
 * its history before readings rests on declarations and reset anchors (model doc §3).
 * Returns only the periods whose start differs; `firstCall` undefined leaves a source as it is.
 */
export function observedStarts(periods: readonly DatedPeriod[], seen: SeenAccounts,
  firstCall: (provider: string, source: string) => string | null | undefined): ObservedStart[] {
  const declared = new Set(periods.filter(p => p.origin === "declared").map(p => periodSubjectKey(p.provider, p.subject)));
  const earliest = new Map<string, DatedPeriod>(), accounts = new Map<string, Set<string>>();
  for (const period of periods) {
    if (period.origin !== "observed") continue;
    const key = periodSubjectKey(period.provider, period.subject), first = earliest.get(key);
    if (!first || periodInstant(period.from, "from") < periodInstant(first.from, "from")) earliest.set(key, period);
    accounts.set(key, (accounts.get(key) ?? new Set()).add(period.value.toLowerCase()));
  }
  const out: ObservedStart[] = [];
  for (const [key, period] of earliest) {
    const firstSeen = period.firstSeen ?? period.from;
    let start = firstSeen;
    const shown = new Set([...(seen[key] ?? []), ...accounts.get(key)!]);
    if (normEraVendor(period.provider) !== "codex" && !declared.has(key) && shown.size === 1) {
      const call = firstCall(period.provider, period.subject);
      if (call === undefined) continue;
      if (call !== null && periodInstant(call, "first call") < periodInstant(firstSeen, "first reading")) start = call;
    }
    if (periodInstant(start, "start") !== periodInstant(period.from, "from")) out.push({ provider: period.provider, subject: period.subject, from: start });
  }
  return out;
}

export function advanceAccountPeriods(sqlite: Database, feedOptions: AccountPeriodFeedOptions): AccountPeriodFeedResult {
  const aliases = aliasesOf(sqlite, feedOptions), options = { ...feedOptions, codexAliases: aliases };
  const batch = options.batch ?? 5000, cursorBefore = meta(sqlite, CURSOR_KEY), from = Number(cursorBefore) || 0;
  const pendingBefore = meta(sqlite, PENDING_KEY), rulesBefore = meta(sqlite, PLAN_RULES_KEY);
  const accountRulesBefore = meta(sqlite, ACCOUNT_RULES_KEY), seenBefore = meta(sqlite, SEEN_KEY);
  const pending: PendingPeriods = pendingBefore ? JSON.parse(pendingBefore) : { accounts: [], plans: [] };
  const rows = sqlite.query(`SELECT ${PROBE_COLUMNS} FROM probe_windows WHERE id > ? ORDER BY id LIMIT ?`)
    .all(from, batch) as ProbeRow[];
  const caughtUp = rows.length < batch;
  const result: AccountPeriodFeedResult = { rows: rows.length, readings: 0, planReadings: 0, unmapped: 0, rebuilt: [], done: false };
  const tracks: Array<Track & { pending: PendingSubject[]; count(): void }> = [
    { table: ACCOUNT_PERIODS, label: "", readingOf: row => accountReadingOf(row, options), select: admissibleReadings,
      pending: pending.accounts, count: () => { result.readings++; } },
    { table: PLAN_PERIODS, label: "plan:", readingOf: row => planReadingOf(row, aliases), select: splitSharedFetch,
      pending: pending.plans, count: () => { result.planReadings++; } },
  ];
  const planRulesChanged = from > 0 && rulesBefore !== PLAN_RULES;
  const planRebuild = planRulesChanged ? rebuildTrack(sqlite, tracks[1]!, from).prepared : [];
  // Readings the cursor already passed are read again under the new account rules, once (~30 rows).
  const accountRulesChanged = from > 0 && accountRulesBefore !== ACCOUNT_RULES;
  const accountRebuild = accountRulesChanged ? rebuildTrack(sqlite, tracks[0]!, from) : null;
  const seen: SeenAccounts = accountRebuild?.seen ?? (seenBefore ? JSON.parse(seenBefore) : {});
  let seenChanged = accountRulesChanged;
  // Readings the cursor passed under other declarations: the sources they move between are rebuilt after catch-up.
  const sourcesBefore = meta(sqlite, SOURCES_KEY), sourcesNow = sourceMapping(options), sourcesChanged = sourcesBefore !== sourcesNow;
  const remapped = from > 0 && sourcesChanged && !accountRulesChanged
    ? remappedSources(sqlite, sourcesBefore ? JSON.parse(sourcesBefore) as ProbeSourceOptions : null, options) : [];
  // Readings the cursor passed under other Codex aliases: the sources and plan subjects that showed an affected id.
  const aliasesBefore = meta(sqlite, ALIASES_KEY), aliasesNow = aliasText(aliases), aliasesChanged = aliasesBefore !== aliasesNow;
  const realiased = from > 0 && aliasesChanged ? changedAliasIds(aliasesBefore, aliases) : new Set<string>();
  const readingsByTrack = tracks.map(track => {
    const readings: FeedReading[] = [];
    for (const row of rows) {
      const reading = track.readingOf(row);
      if (reading === "unmapped") result.unmapped++;
      else if (reading) readings.push(reading);
    }
    return readings.sort((a, b) => a.ts.localeCompare(b.ts));
  });
  const publish = (prepared: readonly PreparedSubject[]) => {
    for (const { track, provider, subject, periods } of prepared) {
      replaceObservedPeriods(sqlite, track.table, provider, subject, periods);
      result.rebuilt.push(`${track.label}${provider}/${subject}`);
    }
  };
  // The rank of the readings behind a subject's stored observed rows; null when it has none.
  const ranks = new Map<string, number | null>();
  const heldRank = (reading: FeedReading): number | null => {
    const key = periodSubjectKey(reading.provider, reading.subject);
    if (!ranks.has(key)) {
      const rows = sqlite.query(`SELECT evidence FROM account_periods WHERE provider = ? AND source = ? COLLATE NOCASE AND origin = 'observed'`)
        .all(normEraVendor(reading.provider), reading.subject) as Array<{ evidence: string }>;
      ranks.set(key, rows.length ? Math.max(...rows.map(row => rankOf(row.evidence))) : null);
    }
    return ranks.get(key)!;
  };
  if (rows.length || planRulesChanged || accountRulesChanged || sourcesChanged || aliasesChanged) {
    const applied = sqlite.transaction(() => {
      if (meta(sqlite, CURSOR_KEY) !== cursorBefore || meta(sqlite, PENDING_KEY) !== pendingBefore
        || meta(sqlite, PLAN_RULES_KEY) !== rulesBefore || meta(sqlite, ACCOUNT_RULES_KEY) !== accountRulesBefore
        || meta(sqlite, SEEN_KEY) !== seenBefore || meta(sqlite, SOURCES_KEY) !== sourcesBefore
        || meta(sqlite, ALIASES_KEY) !== aliasesBefore) return false;
      publish(planRebuild);
      publish(accountRebuild?.prepared ?? []);
      const queue = (list: PendingSubject[], subject: PendingSubject) => {
        const key = periodSubjectKey(subject.provider, subject.subject);
        if (!list.some(p => periodSubjectKey(p.provider, p.subject) === key)) list.push(subject);
      };
      for (const subject of remapped) queue(pending.accounts, subject);
      if (realiased.size) {
        for (const [key, accounts] of Object.entries(seen)) {
          const [provider, ...rest] = key.split("|");
          if (provider !== "codex" || !accounts.some(a => realiased.has(a))) continue;
          if (!accountRulesChanged) queue(pending.accounts, { provider, subject: rest.join("|") });
          // What the source showed, under the ids it now counts for.
          const next = [...new Set(accounts.map(a => aliases.get(a)?.toLowerCase() ?? a))].sort();
          if (JSON.stringify(next) !== JSON.stringify(accounts)) { seen[key] = next; seenChanged = true; }
        }
        if (!planRulesChanged) for (const id of realiased) queue(pending.plans, { provider: "codex", subject: id });
      }
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]!, keys = new Set(track.pending.map(p => periodSubjectKey(p.provider, p.subject)));
        const accounts = track.table === ACCOUNT_PERIODS;
        for (const reading of readingsByTrack[i]!) {
          track.count();
          const key = periodSubjectKey(reading.provider, reading.subject);
          if (accounts && addSeen(seen, reading)) seenChanged = true;
          if (keys.has(key)) continue;
          if (accounts) {
            const held = heldRank(reading), rank = rankOf(reading.evidence);
            // A weaker identity never moves a source a stronger one speaks for.
            if (held !== null && rank < held) continue;
            // A stronger identity replaces the weaker one's periods: rebuilt from all readings after catch-up.
            if (held !== null && rank > held) {
              track.pending.push({ provider: reading.provider, subject: reading.subject });
              keys.add(key);
              continue;
            }
          }
          let fed = reading;
          if (!accounts && reading.probedAt) {
            const latest = sqlite.query(`SELECT plan, last_seen, evidence FROM plan_periods WHERE provider = ? AND account = ? COLLATE NOCASE
              AND origin = 'observed' ORDER BY from_ts DESC LIMIT 1`)
              .get(normEraVendor(reading.provider), reading.subject) as { plan: string; last_seen: string | null; evidence: string | null } | null;
            // An instant already known to show two plans (`splitSharedFetch`) dates nothing, and a refused probe under it proves nothing.
            if (latest && parse(latest.evidence)?.fetchedAt === reading.ts) {
              if (reading.failed) continue;
              fed = takenAt(reading);
            }
            // The instant just showed a second plan: its earlier readings move too, so rebuilt from all readings after catch-up.
            else if (latest?.last_seen === reading.ts && canonicalPeriodPlan(latest.plan) !== canonicalPeriodPlan(reading.value)) {
              track.pending.push({ provider: reading.provider, subject: reading.subject });
              keys.add(key);
              continue;
            }
          }
          const outcome = recordPeriodReading(sqlite, track.table, fed, fed.evidence);
          if (outcome === "out-of-order") {
            track.pending.push({ provider: reading.provider, subject: reading.subject });
            keys.add(key);
          } else if (accounts) ranks.set(key, rankOf(reading.evidence));
        }
      }
      if (rows.length) setMeta(sqlite, CURSOR_KEY, String(rows.at(-1)!.id));
      setMeta(sqlite, PENDING_KEY, JSON.stringify(pending));
      setMeta(sqlite, PLAN_RULES_KEY, PLAN_RULES);
      setMeta(sqlite, ACCOUNT_RULES_KEY, ACCOUNT_RULES);
      setMeta(sqlite, SOURCES_KEY, sourcesNow);
      setMeta(sqlite, ALIASES_KEY, aliasesNow);
      if (seenChanged) setMeta(sqlite, SEEN_KEY, JSON.stringify(seen));
      return true;
    }).immediate();
    if (!applied) { result.rows = 0; return result; }
  }
  if (!caughtUp) return result;
  if (pending.accounts.length || pending.plans.length) {
    const cursor = rows.length ? String(rows.at(-1)!.id) : cursorBefore;
    const pendingSnapshot = rows.length || planRulesChanged || accountRulesChanged || sourcesChanged || aliasesChanged
      ? JSON.stringify(pending) : pendingBefore;
    const upTo = Number(cursor) || 0, prepared: PreparedSubject[] = [], shown: FeedReading[] = [];
    // Both tracks share one ordered pass per provider, regardless of the number of late subjects.
    const providers = new Set([...pending.accounts, ...pending.plans].map(p => p.provider));
    for (const provider of providers) {
      const groups = tracks.map(track => new Map(track.pending.filter(p => p.provider === provider)
        .map(p => [periodSubjectKey(p.provider, p.subject), { ...p, readings: [] as FeedReading[] }])));
      for (const row of sqlite.query(`SELECT ${PROBE_COLUMNS} FROM probe_windows WHERE provider = ? AND id <= ? ORDER BY id`)
        .iterate(provider, upTo) as Iterable<ProbeRow>) {
        for (let i = 0; i < tracks.length; i++) {
          if (!groups[i]!.size) continue;
          const reading = tracks[i]!.readingOf(row);
          const group = reading && reading !== "unmapped" ? groups[i]!.get(periodSubjectKey(reading.provider, reading.subject)) : undefined;
          if (!group) continue;
          group.readings.push(reading as FeedReading);
          if (tracks[i]!.table === ACCOUNT_PERIODS) shown.push(reading as FeedReading);
        }
      }
      for (let i = 0; i < tracks.length; i++) for (const { provider, subject, readings } of groups[i]!.values())
        prepared.push({ track: tracks[i]!, provider, subject, periods: prepare(tracks[i]!, readings) });
    }
    const applied = sqlite.transaction(() => {
      // A concurrent feed cannot publish a result calculated for an older durable queue.
      if (meta(sqlite, CURSOR_KEY) !== cursor || meta(sqlite, PENDING_KEY) !== pendingSnapshot) return false;
      publish(prepared);
      setMeta(sqlite, PENDING_KEY, JSON.stringify({ accounts: [], plans: [] } satisfies PendingPeriods));
      // A remapped source's earlier readings are remembered as seen there, as if fed in order.
      const stored = meta(sqlite, SEEN_KEY), merged: SeenAccounts = stored ? JSON.parse(stored) : {};
      let added = false;
      for (const reading of shown) { addSeen(seen, reading); if (addSeen(merged, reading)) added = true; }
      if (added) setMeta(sqlite, SEEN_KEY, JSON.stringify(merged));
      return true;
    }).immediate();
    if (!applied) return result;
  }
  // Caught up: the starts of whole-history sources follow the readings, declarations and calls of now.
  const startsNow = () => observedStarts(loadPeriods(sqlite, ACCOUNT_PERIODS), seen, (provider, source) => ledgerSourceFirstCall(sqlite, provider, source));
  // Decided again under the writer, which is taken only when something moves.
  if (startsNow().length) sqlite.transaction(() => {
    for (const start of startsNow()) {
      moveObservedStart(sqlite, ACCOUNT_PERIODS, start.provider, start.subject, start.from);
      result.rebuilt.push(`start:${start.provider}/${start.subject}`);
    }
  }).immediate();
  result.done = true;
  return result;
}
