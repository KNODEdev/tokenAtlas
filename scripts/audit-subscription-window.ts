import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../src/db/sqlite";
import { resolveDbPath } from "../src/db";
import { ARCHIVE_LOGICAL_ROOT, configFile, expandPath } from "../src/config/paths";
import { readAccountsV2 } from "../src/config/accounts-document";
import type { SourceV2 } from "../src/config/accounts-v2";
import { normEraKey } from "../src/server/eras";
import { codexHomeSource } from "../src/server/event-source";
import { loadAccountResolver, type AccountResolution } from "../src/server/account-resolver";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FROZEN_REPORT = path.join(REPO_ROOT, "scripts", "fixtures", "codex-five-hour-window.json");
const EVIDENCE_FILE = path.join(REPO_ROOT, "docs", "verification", "codex-five-hour-independent-2026-09-12.json");

const FROZEN_SCENARIO = {
  account: "codex1",
  counter: "five_hour",
  window_minutes: 300,
  reset: "2026-08-31T11:21:00Z",
};

type JsonRecord = Record<string, unknown>;
type RawEvent = {
  rowid: number;
  home: string | null;
  path: string | null;
  ts: string;
  model: string | null;
  speed: string | null;
  billing_mode: string | null;
  meter_reset: number | null;
  plan_type: string | null;
  in_tok: number | null;
  cached_in: number | null;
  cache_write: number | null;
  out_tok: number | null;
};
type CopyCandidate = { events: number; last: string; tokens: number; key: string };
type CopyBucket = { source?: CopyCandidate; archive?: CopyCandidate };
type IndependentRate = {
  id: string;
  model: string;
  speed: "standard" | "fast";
  billing_basis: "api_equivalent_usd" | "chatgpt_credits";
  valid_from: string;
  valid_until?: string;
  multiplier: number;
  rates: { in_uncached: number; in_cache_read: number; out_total: number };
  long_context?: { above_input_tokens: number; rates: { in_uncached: number; in_cache_read: number; out_total: number } };
};
type PriceResult = { amount: number | null; reason: string | null; rule_id: string | null };
type ModelUsage = { events: number; tokens: number; input: number; cached: number; output: number; cache_write: number };
type Usage = ModelUsage & {
  fast_tokens: number;
  unknown_tokens: number;
  priced_tokens: number;
  unpriced_events: number;
  invalid_token_events: number;
  api_standard: number;
  credits_low: number;
  credits_high: number;
  models: Record<string, ModelUsage>;
  speeds: Record<string, { events: number; tokens: number }>;
  unpriced_reasons: Record<string, number>;
  rate_rule_ids: string[];
};

function valueOf(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function usageHelp(): void {
  console.log([
    "Bounded read-only Codex window audit.",
    "Defaults to the frozen reset 2026-08-31T11:21:00Z / codex1 / five_hour scenario.",
    "Options: --db PATH. This regression checks the committed frozen scenario; it does not replace its baseline.",
  ].join("\n"));
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requireDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function requireTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function utcDayStart(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`)).toISOString();
}

function field(columns: Set<string>, name: string, alias = name): string {
  return columns.has(name) ? `e."${name}" AS "${alias}"` : `NULL AS "${alias}"`;
}

function sqlToken(columns: Set<string>, name: string): string {
  return columns.has(name) ? `COALESCE(e."${name}", 0)` : "0";
}

function normalizePath(value: string | null): string {
  return normEraKey(value);
}

function copyKey(home: string | null, sourcePath: string | null): string {
  return JSON.stringify([normalizePath(home), (sourcePath ?? "").replaceAll("\\", "/").toLowerCase()]);
}

function rolloutRelativePath(home: string | null, sourcePath: string | null): string {
  const h = home ?? "";
  const p = sourcePath ?? "";
  const name = p.split(/[\\/]/).at(-1) ?? "";
  const dated = /^rollout-(\d{4})-(\d{2})-(\d{2}).*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.exec(name);
  if (dated) return `sessions/${dated[1]}/${dated[2]}/${dated[3]}/${name.toLowerCase()}`;
  if (p.length > h.length) return p.slice(h.length + 1).split("\\").join("/").toLowerCase();
  return p.split("\\").join("/").toLowerCase();
}

function isSourceCopy(home: string | null, sourceHomes: Set<string>): boolean {
  const normalized = normalizePath(home);
  if (sourceHomes.has(normalized)) return true;
  if (sourceHomes.size > 0) return false;
  return /\/\.codex$/i.test(normalized);
}

function preferCopy(a: CopyCandidate, b: CopyCandidate | undefined): boolean {
  if (!b) return true;
  if (a.events !== b.events) return a.events > b.events;
  if (a.last !== b.last) return a.last > b.last;
  if (a.tokens !== b.tokens) return a.tokens > b.tokens;
  return false;
}

function buildLocalMirrorSelection(db: Database, columns: Set<string>, sources: SourceV2[], from: string, toExclusive: string) {
  const sourceHomes = new Set(sources.map((item) => normalizePath(item.source_home ?? null)).filter(Boolean));
  const inTokens = sqlToken(columns, "in_tok");
  const cacheWrite = sqlToken(columns, "cache_write");
  const outTokens = sqlToken(columns, "out_tok");
  const rows = db.query(`SELECT e.home,e.path,COUNT(*) AS calls,MAX(e.ts) AS last,
    SUM(${inTokens}+${cacheWrite}+${outTokens}) AS tokens
    FROM events e WHERE e.ts >= ? AND e.ts < ? GROUP BY e.home,e.path`).all(from, toExclusive) as Array<JsonRecord>;
  const byRelative = new Map<string, CopyBucket>();
  for (const row of rows) {
    const calls = Number(row.calls ?? 0);
    if (!calls) continue;
    const home = asString(row.home);
    const sourcePath = asString(row.path);
    const relative = rolloutRelativePath(home, sourcePath);
    const side = isSourceCopy(home, sourceHomes) ? "source" : "archive";
    const candidate: CopyCandidate = {
      events: calls,
      last: asString(row.last) ?? "",
      tokens: asNumber(row.tokens) ?? 0,
      key: copyKey(home, sourcePath),
    };
    const bucket = byRelative.get(relative) ?? {};
    if (preferCopy(candidate, bucket[side])) bucket[side] = candidate;
    byRelative.set(relative, bucket);
  }
  const selectedPathByRelative = new Map<string, string>();
  let mirroredRelativePaths = 0;
  let sourceWins = 0;
  let archiveWins = 0;
  for (const [relative, bucket] of byRelative) {
    const chosen = bucket.source && preferCopy(bucket.source, bucket.archive) ? "source" : "archive";
    const candidate = bucket[chosen];
    if (!candidate) continue;
    selectedPathByRelative.set(relative, candidate.key);
    if (bucket.source && bucket.archive) mirroredRelativePaths++;
    if (chosen === "source") sourceWins++;
    else archiveWins++;
  }
  return {
    sourceHomes,
    selectedPathByRelative,
    sourceWins,
    archiveWins,
    mirroredRelativePaths,
    candidatePaths: rows.length,
  };
}

function usageEmpty(): Usage {
  return {
    events: 0,
    tokens: 0,
    input: 0,
    cached: 0,
    output: 0,
    cache_write: 0,
    fast_tokens: 0,
    unknown_tokens: 0,
    priced_tokens: 0,
    unpriced_events: 0,
    invalid_token_events: 0,
    api_standard: 0,
    credits_low: 0,
    credits_high: 0,
    models: {},
    speeds: {},
    unpriced_reasons: {},
    rate_rule_ids: [],
  };
}

function addModelUsage(target: ModelUsage, event: RawEvent, tokens: number, valid: boolean): void {
  target.events++;
  target.tokens += tokens;
  if (valid) {
    target.input += event.in_tok!;
    target.cached += event.cached_in!;
    target.output += event.out_tok!;
  }
  target.cache_write += Number.isSafeInteger(event.cache_write) && event.cache_write! >= 0 ? event.cache_write! : 0;
}

function safeTokenVector(event: RawEvent): boolean {
  return [event.in_tok, event.cached_in, event.out_tok].every((value) => Number.isSafeInteger(value) && value! >= 0)
    && event.cached_in! <= event.in_tok!
    && Number.isSafeInteger(event.in_tok! + event.out_tok!);
}

function rawRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRates(card: JsonRecord): IndependentRate[] {
  const config = card.codex_accounting;
  if (!config || typeof config !== "object") return [];
  const rules = (config as JsonRecord).rules;
  if (!Array.isArray(rules)) return [];
  const result: IndependentRate[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as JsonRecord;
    const rates = item.rates;
    if (!rates || typeof rates !== "object") continue;
    const inUncached = rawRate((rates as JsonRecord).in_uncached);
    const inCacheRead = rawRate((rates as JsonRecord).in_cache_read);
    const outTotal = rawRate((rates as JsonRecord).out_total);
    const model = asString(item.model);
    const speed = asString(item.speed);
    const basis = asString(item.billing_basis);
    const id = asString(item.id);
    const from = asString(item.valid_from);
    const multiplier = rawRate(item.multiplier);
    if (!model || !id || !from || multiplier == null || inUncached == null || inCacheRead == null || outTotal == null
      || (speed !== "standard" && speed !== "fast")
      || (basis !== "api_equivalent_usd" && basis !== "chatgpt_credits")) continue;
    let longContext: IndependentRate["long_context"];
    if (item.long_context && typeof item.long_context === "object") {
      const long = item.long_context as JsonRecord;
      const longRates = long.rates;
      const threshold = asNumber(long.above_input_tokens);
      if (longRates && typeof longRates === "object" && threshold != null) {
        const lu = rawRate((longRates as JsonRecord).in_uncached);
        const lc = rawRate((longRates as JsonRecord).in_cache_read);
        const lo = rawRate((longRates as JsonRecord).out_total);
        if (lu != null && lc != null && lo != null) longContext = { above_input_tokens: threshold, rates: { in_uncached: lu, in_cache_read: lc, out_total: lo } };
      }
    }
    result.push({
      id,
      model,
      speed,
      billing_basis: basis,
      valid_from: from,
      ...(asString(item.valid_until) ? { valid_until: asString(item.valid_until)! } : {}),
      multiplier,
      rates: { in_uncached: inUncached, in_cache_read: inCacheRead, out_total: outTotal },
      ...(longContext ? { long_context: longContext } : {}),
    });
  }
  return result;
}

function independentPrice(rates: IndependentRate[], event: RawEvent, basis: IndependentRate["billing_basis"], speed: "standard" | "fast"): PriceResult {
  if (!safeTokenVector(event)) return { amount: null, reason: "invalid_tokens", rule_id: null };
  if (!Number.isSafeInteger(event.cache_write) || event.cache_write! < 0) return { amount: null, reason: "invalid_tokens", rule_id: null };
  if (event.cache_write! > 0) return { amount: null, reason: "cache_write_semantics_unknown", rule_id: null };
  const day = event.ts.slice(0, 10);
  const rule = rates.find((candidate) => candidate.model === event.model && candidate.speed === speed
    && candidate.billing_basis === basis && day >= candidate.valid_from && (!candidate.valid_until || day < candidate.valid_until));
  if (!rule) return { amount: null, reason: "missing_rate", rule_id: null };
  const selected = rule.long_context && event.in_tok! > rule.long_context.above_input_tokens ? rule.long_context.rates : rule.rates;
  const amount = ((event.in_tok! - event.cached_in!) * selected.in_uncached
    + event.cached_in! * selected.in_cache_read + event.out_tok! * selected.out_total) / 1e6 * rule.multiplier;
  return Number.isFinite(amount) ? { amount, reason: null, rule_id: rule.id } : { amount: null, reason: "invalid_tokens", rule_id: rule.id };
}

function addIndependentUsage(target: Usage, event: RawEvent, rates: IndependentRate[]): void {
  const valid = safeTokenVector(event);
  const tokens = valid ? event.in_tok! + event.out_tok! : 0;
  target.events++;
  target.tokens += tokens;
  if (valid) {
    target.input += event.in_tok!;
    target.cached += event.cached_in!;
    target.output += event.out_tok!;
  } else target.invalid_token_events++;
  if (Number.isSafeInteger(event.cache_write) && event.cache_write! >= 0) target.cache_write += event.cache_write!;
  const speed = event.speed === "fast" || event.speed === "standard" ? event.speed : "unknown";
  const speedUsage = target.speeds[speed] ?? { events: 0, tokens: 0 };
  speedUsage.events++;
  speedUsage.tokens += tokens;
  target.speeds[speed] = speedUsage;
  if (speed === "fast") target.fast_tokens += tokens;
  if (speed === "unknown") target.unknown_tokens += tokens;
  const model = event.model ?? "?";
  const modelUsage = target.models[model] ?? { events: 0, tokens: 0, input: 0, cached: 0, output: 0, cache_write: 0 };
  addModelUsage(modelUsage, event, tokens, valid);
  target.models[model] = modelUsage;

  const actualSpeed = speed === "fast" || speed === "standard" ? speed : null;
  const api = independentPrice(rates, { ...event, speed: "standard" }, "api_equivalent_usd", "standard");
  const low = independentPrice(rates, { ...event, speed: actualSpeed ?? "standard" }, "chatgpt_credits", actualSpeed ?? "standard");
  const high = independentPrice(rates, { ...event, speed: actualSpeed ?? "fast" }, "chatgpt_credits", actualSpeed ?? "fast");
  if (api.amount != null && low.amount != null && high.amount != null) {
    target.api_standard += api.amount;
    target.credits_low += low.amount;
    target.credits_high += high.amount;
    target.priced_tokens += tokens;
    for (const id of [api.rule_id, low.rule_id, high.rule_id]) if (id && !target.rate_rule_ids.includes(id)) target.rate_rule_ids.push(id);
  } else {
    target.unpriced_events++;
    const reason = api.reason ?? low.reason ?? high.reason ?? "missing_rate";
    target.unpriced_reasons[reason] = (target.unpriced_reasons[reason] ?? 0) + 1;
  }
}

function eventDigest(events: RawEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(JSON.stringify([
      event.rowid, event.home, event.path, event.ts, event.model, event.speed, event.billing_mode,
      event.meter_reset, event.plan_type, event.in_tok, event.cached_in, event.cache_write, event.out_tok,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function readFrozenWindow(): JsonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(FROZEN_REPORT, "utf8")) as JsonRecord;
    const scope = parsed.scope as JsonRecord | undefined;
    const windows = Array.isArray(parsed.windows) ? parsed.windows : [];
    const window = windows.find((item) => item && typeof item === "object"
      && (item as JsonRecord).account === FROZEN_SCENARIO.account
      && (item as JsonRecord).reset === FROZEN_SCENARIO.reset) as JsonRecord | undefined ?? null;
    return window ? { ...window, scope } : null;
  } catch {
    return null;
  }
}

function numberEqual(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9;
}

function compareUsage(report: JsonRecord | null, independent: Usage): JsonRecord | null {
  if (!report) return null;
  const fields = ["events", "tokens", "input", "cached", "output", "fast_tokens", "unknown_tokens", "priced_tokens", "unpriced_events", "api_standard", "credits_low", "credits_high"] as const;
  const result: JsonRecord = {};
  for (const fieldName of fields) {
    const expected = report[fieldName];
    const actual = independent[fieldName];
    result[fieldName] = { report: expected ?? null, independent: actual, match: numberEqual(expected, actual) };
  }
  return result;
}

export function auditComparisonPassed(comparison: unknown): boolean {
  if (!comparison || typeof comparison !== "object") return false;
  return ["observed", "cycle"].every(key => {
    const rows = (comparison as JsonRecord)[key];
    return !!rows && typeof rows === "object" && Object.keys(rows).length === 12
      && Object.values(rows).every(value => !!value && typeof value === "object" && (value as JsonRecord).match === true);
  });
}

function meterEvidence(db: Database, columns: Set<string>, accountAt: (home: string | null, ts: string) => AccountResolution,
  account: string, windowMinutes: number, resetMs: number, from: string, toExclusive: string): JsonRecord | null {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ratelimit' LIMIT 1").get();
  if (!table) return null;
  const meterColumns = new Set((db.query("PRAGMA table_info(ratelimit)").all() as Array<{ name: string }>).map((row) => row.name));
  const required = ["home", "path", "ts", "window_minutes", "limit_id", "used_percent", "resets_at"];
  if (!required.every((name) => meterColumns.has(name))) return { available: false, reason: "ratelimit schema lacks required columns" };
  const planExpr = meterColumns.has("plan_type") ? "plan_type" : "NULL";
  const rows = db.query(`SELECT home,path,ts,window_minutes,limit_id,used_percent,resets_at,${planExpr} AS plan_type
    FROM ratelimit WHERE ts >= ? AND ts < ? AND limit_id='codex' AND window_minutes=?
    AND used_percent BETWEEN 0 AND 100 AND resets_at IS NOT NULL ORDER BY ts`).all(from, toExclusive, windowMinutes) as Array<JsonRecord>;
  let accountRows = 0;
  let resetMatches = 0;
  let minPercent = 100;
  let maxPercent = 0;
  const plans = new Set<string>();
  for (const row of rows) {
    const ts = asString(row.ts) ?? "";
    const owner = accountAt(asString(row.home), ts).account;
    if (owner !== account) continue;
    accountRows++;
    const used = asNumber(row.used_percent);
    if (used != null) { minPercent = Math.min(minPercent, used); maxPercent = Math.max(maxPercent, used); }
    const plan = asString(row.plan_type);
    if (plan) plans.add(plan);
    const reset = asNumber(row.resets_at);
    if (reset != null && Math.abs(reset * 1000 - resetMs) <= 120000) resetMatches++;
  }
  return {
    available: true,
    bounded_rows: rows.length,
    account_rows: accountRows,
    target_reset_rows: resetMatches,
    account_percent_min: accountRows ? minPercent : null,
    account_percent_max: accountRows ? maxPercent : null,
    account_plans: [...plans].sort(),
  };
}

function makeRawEvent(row: JsonRecord): RawEvent {
  return {
    rowid: asNumber(row.rowid) ?? 0,
    home: asString(row.home),
    path: asString(row.path),
    ts: asString(row.ts) ?? "",
    model: asString(row.model),
    speed: asString(row.speed),
    billing_mode: asString(row.billing_mode),
    meter_reset: asNumber(row.meter_reset),
    plan_type: asString(row.plan_type),
    in_tok: asNumber(row.in_tok),
    cached_in: asNumber(row.cached_in),
    cache_write: asNumber(row.cache_write),
    out_tok: asNumber(row.out_tok),
  };
}

function main(): JsonRecord {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { usageHelp(); return {}; }
  if (args.some((arg, i) => arg.startsWith("--") && arg !== "--db" && !arg.startsWith("--db="))) throw new Error("Only --db PATH is supported for the frozen regression audit");
  const frozen = readFrozenWindow();
  if (!frozen) throw new Error("Committed frozen window fixture unavailable");
  const account = (valueOf(args, "--account") ?? FROZEN_SCENARIO.account).trim().toLowerCase();
  const windowMinutes = Number(valueOf(args, "--window-minutes") ?? FROZEN_SCENARIO.window_minutes);
  const counter = valueOf(args, "--counter") ?? (windowMinutes === 300 ? "five_hour" : "weekly");
  if ((windowMinutes !== 300 && windowMinutes !== 10080) || (counter !== "five_hour" && counter !== "weekly")) {
    throw new Error("counter must be five_hour/weekly with window-minutes 300/10080");
  }
  const reportScope = (frozen?.scope && typeof frozen.scope === "object" ? frozen.scope as JsonRecord : {});
  const since = requireDate(valueOf(args, "--since") ?? asString(reportScope.since) ?? "2026-08-01", "since");
  const until = requireDate(valueOf(args, "--until") ?? asString(reportScope.until) ?? "2026-09-12", "until");
  if (since > until) throw new Error("since must not be after until");
  const reset = valueOf(args, "--reset") ?? asString(frozen?.reset) ?? FROZEN_SCENARIO.reset;
  const resetMs = requireTimestamp(reset, "reset");
  const defaultCycleStart = new Date(resetMs - windowMinutes * 60000).toISOString();
  const cycleStart = valueOf(args, "--cycle-start") ?? asString(frozen?.cycle_start) ?? defaultCycleStart;
  const cycleEnd = valueOf(args, "--cycle-end") ?? asString(frozen?.cycle_end) ?? new Date(resetMs).toISOString();
  const observedStart = valueOf(args, "--observed-start") ?? asString(frozen?.start) ?? cycleStart;
  const observedEnd = valueOf(args, "--observed-end") ?? asString(frozen?.end) ?? cycleEnd;
  const cycleStartMs = requireTimestamp(cycleStart, "cycle-start");
  const cycleEndMs = requireTimestamp(cycleEnd, "cycle-end");
  const observedStartMs = requireTimestamp(observedStart, "observed-start");
  const observedEndMs = requireTimestamp(observedEnd, "observed-end");
  if (cycleEndMs <= cycleStartMs || observedEndMs < observedStartMs) throw new Error("window bounds are not ordered");
  const targetPlan = (valueOf(args, "--plan") ?? asString(frozen?.plan) ?? "").trim().toLowerCase() || null;
  const toExclusive = addDays(until, 1);
  const scanSince = addDays(since, -7);
  const scanUntil = addDays(toExclusive, 7);
  const scanFromIso = utcDayStart(scanSince);
  const scanToIso = utcDayStart(scanUntil);
  const dbPath = valueOf(args, "--db");
  const db = new Database(resolveDbPath(dbPath), { readonly: true });
  db.exec("PRAGMA query_only = ON");
  try {
    const eventColumns = new Set((db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!eventColumns.has("ts")) throw new Error("events.ts is unavailable");
    const config = readAccountsV2(configFile("accounts.json"));
    const sources = config.sources.filter(source => source.vendor === "codex").map(source => ({ ...source, home: expandPath(source.home),
      ...(source.source_home ? { source_home: expandPath(source.source_home) } : {}) }));
    const resolver = loadAccountResolver(db, config.subscriptions);
    const accountAt = (home: string | null, ts: string): AccountResolution =>
      resolver.resolve("codex", codexHomeSource(home, sources, ARCHIVE_LOGICAL_ROOT), null, ts);
    const mirror = buildLocalMirrorSelection(db, eventColumns, sources, scanFromIso, scanToIso);
    const rows = db.query(`SELECT e.rowid AS rowid,${field(eventColumns, "home")},${field(eventColumns, "path")},${field(eventColumns, "ts")},
      ${field(eventColumns, "model")},${field(eventColumns, "speed")},${field(eventColumns, "billing_mode")},${field(eventColumns, "meter_reset")},${field(eventColumns, "plan_type")},
      ${field(eventColumns, "in_tok")},${field(eventColumns, "cached_in")},${field(eventColumns, "cache_write")},${field(eventColumns, "out_tok")}
      FROM events e WHERE e.ts >= ? AND e.ts < ? ORDER BY e.ts,e.rowid`).all(scanFromIso, scanToIso) as Array<JsonRecord>;
    const ratesCard = JSON.parse(fs.readFileSync(configFile("rate-cards.json"), "utf8")) as JsonRecord;
    const rates = parseRates(ratesCard);
    const cycleUsage = usageEmpty();
    const observedUsage = usageEmpty();
    const cycleEvents: RawEvent[] = [];
    const observedEvents: RawEvent[] = [];
    const ownerReasons: Record<string, number> = {};
    const exclusions: Record<string, number> = {};
    let accountCandidateRows = 0;
    let mirrorKeptRows = 0;
    let invalidTimestampRows = 0;
    const bump = (map: Record<string, number>, key: string): void => { map[key] = (map[key] ?? 0) + 1; };
    for (const row of rows) {
      const event = makeRawEvent(row);
      const time = Date.parse(event.ts);
      if (!Number.isFinite(time)) { invalidTimestampRows++; bump(exclusions, "invalid_timestamp"); continue; }
      const resolution = accountAt(event.home, event.ts);
      if (resolution.basis !== "declared" && resolution.basis !== "observed") bump(ownerReasons, resolution.basis);
      let owner = resolution.account;
      if (event.billing_mode === "business_credits") owner = `${owner ?? "codex-unassigned"}::business`;
      if (owner !== account) continue;
      accountCandidateRows++;
      const relative = rolloutRelativePath(event.home, event.path);
      const selectedPath = mirror.selectedPathByRelative.get(relative);
      if (selectedPath && selectedPath !== copyKey(event.home, event.path)) {
        bump(exclusions, "mirror_duplicate");
        continue;
      }
      mirrorKeptRows++;
      if (time < cycleStartMs || time >= cycleEndMs) continue;
      if (event.model === "gpt-5.3-codex-spark") { bump(exclusions, "spark_counter_excluded"); continue; }
      if (event.billing_mode === "business_credits" || event.billing_mode === "credits") { bump(exclusions, "separate_billing_pool"); continue; }
      if (targetPlan && event.plan_type && event.plan_type !== targetPlan) { bump(exclusions, "plan_mismatch"); continue; }
      cycleEvents.push(event);
      addIndependentUsage(cycleUsage, event, rates);
      const paired = event.ts && (time >= observedStartMs && time <= observedEndMs);
      if (paired) {
        observedEvents.push(event);
        addIndependentUsage(observedUsage, event, rates);
      }
    }
    const selectedFrozenUsage = frozen?.usage && typeof frozen.usage === "object" ? frozen.usage as JsonRecord : null;
    const selectedFrozenCycle = frozen?.cycle_usage && typeof frozen.cycle_usage === "object" ? frozen.cycle_usage as JsonRecord : null;
    const evidence: JsonRecord = {
      schema_version: 1,
      generated_at_utc: new Date().toISOString(),
      scenario: {
        account,
        counter,
        window_minutes: windowMinutes,
        reset,
        cycle_start: new Date(cycleStartMs).toISOString(),
        cycle_end: new Date(cycleEndMs).toISOString(),
        observed_start: new Date(observedStartMs).toISOString(),
        observed_end: new Date(observedEndMs).toISOString(),
        plan: targetPlan,
        report_scope: { since, until, inclusive_until: true },
      },
      method: {
        database: "local atlas.sqlite",
        read_only: true,
        sqlite_query_only: true,
        era_resolution: "physical source mapping + account_periods resolver at event timestamp",
        mirror_selection: "local source/archive relative-path winners: events, last timestamp, then token tie-break; flat home index intentionally not used",
        event_sql_range: { from: scanSince, to_exclusive: scanUntil },
        event_sql_rows: rows.length,
        pricing: "local dated rate-cards.json rules; API standard and credits low/high are independently calculated per event",
        no_conversation_content: true,
        application_window_builder_reused: false,
      },
      frozen_report: frozen ? {
        observed: selectedFrozenUsage,
        cycle: selectedFrozenCycle,
        source: "scripts/fixtures/codex-five-hour-window.json",
      } : null,
      independent_sql: {
        observed: {
          ...observedUsage,
          event_hash: { algorithm: "sha256", canonical_fields: "rowid,home,path,ts,model,speed,billing_mode,meter_reset,plan_type,token counters", value: eventDigest(observedEvents) },
        },
        cycle: {
          ...cycleUsage,
          event_hash: { algorithm: "sha256", canonical_fields: "rowid,home,path,ts,model,speed,billing_mode,meter_reset,plan_type,token counters", value: eventDigest(cycleEvents) },
        },
        selection: {
          queried_rows: rows.length,
          account_candidate_rows: accountCandidateRows,
          mirror_kept_rows: mirrorKeptRows,
          selected_cycle_events: cycleEvents.length,
          selected_observed_events: observedEvents.length,
          owner_reason_counts: ownerReasons,
          exclusions,
          invalid_timestamp_rows: invalidTimestampRows,
          source_home_count: mirror.sourceHomes.size,
          mirror_candidate_paths: mirror.candidatePaths,
          mirrored_relative_paths: mirror.mirroredRelativePaths,
          mirror_source_wins: mirror.sourceWins,
          mirror_archive_wins: mirror.archiveWins,
        },
        meter: meterEvidence(db, eventColumns, accountAt, account, windowMinutes, resetMs, scanFromIso, scanToIso),
      },
      comparison: {
        observed: compareUsage(selectedFrozenUsage, observedUsage),
        cycle: compareUsage(selectedFrozenCycle, cycleUsage),
      },
      limitations: [
        "This proves the selected indexed events and dated arithmetic on this SQLite snapshot; it cannot prove that the original session archive was complete before indexing.",
        "The source/archive policy removes a lower-ranked mirror copy but cannot detect a missing machine or an unindexed event.",
        "A 5h reset anchor is corroborated only by bounded ratelimit rows; absent historical readings would be a coverage gap, not proof that the plan lacked a counter.",
        "Positive cache_write is retained in token metadata but left unpriced because its overlap with input is unspecified; reasoning_out is not added separately to output.",
        "Plan and Pro multiplier are metadata from the frozen report/configuration; this audit does not infer a billed contract tier.",
      ],
    };
    fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    if (!auditComparisonPassed(evidence.comparison)) throw new Error("Independent window audit does not match the frozen baseline; inspect evidence JSON. Baseline was not changed.");
    return evidence;
  } finally {
    db.close();
  }
}

if (import.meta.main) try {
  const result = main();
  if (Object.keys(result).length > 0) console.log(JSON.stringify({ passed: true, scenario: result.scenario, evidence: EVIDENCE_FILE }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
