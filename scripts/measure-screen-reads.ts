/**
 * Measures the screen reads that starved the live server on 2026-11-14 (codex-accounting answers,
 * the cycle-breakdown batch, the roster and the sync read-refresh check) on a synthetic file database.
 *
 *   bun scripts/measure-screen-reads.ts build   --root <dir> [--accounts 2] [--days 420] [--calls 450] [--probe-minutes 20] [--seed 7]
 *   bun scripts/measure-screen-reads.ts measure --root <dir> --label before [--samples 3] [--wal-mb 0,256,768]
 *   bun scripts/measure-screen-reads.ts compare --root <dir> --label after [--golden before]
 *
 * Every path resolves inside --root (database, config, archive, local state, snapshots); the script
 * refuses to run otherwise. `measure` works on a fresh copy of the fixture and deletes it afterwards,
 * so the fixture stays byte-identical between "before" and "after" runs. The clock is frozen at
 * FIXTURE_NOW in both commands so response bodies are reproducible.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const [command, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i]!.replace(/^--/, ""), rest[i + 1] ?? "");
function simpleName(name: string, option: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..")
    throw new Error(`--${option} must be a simple name using letters, digits, '.', '_' or '-', excluding '.' and '..'`);
  return name;
}
function namedPath(directory: string, name: string, option: string): string {
  const resolved = path.resolve(directory, simpleName(name, option)), relative = path.relative(directory, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`--${option} must resolve inside ${directory}`);
  return resolved;
}
for (const option of ["label", "golden"]) if (args.has(option)) simpleName(args.get(option)!, option);
const ROOT = path.resolve(args.get("root") ?? "");
if (!args.get("root") || !path.isAbsolute(args.get("root")!)) throw new Error("--root <absolute dir> is required");
// Only an empty folder or one this script built: never a folder holding an installation's data.
if (fs.existsSync(ROOT) && fs.readdirSync(ROOT).length && !fs.existsSync(path.join(ROOT, "fixture", "fixture.json")))
  throw new Error("Refusing a non-empty root this script did not build");
const REPO = path.resolve(import.meta.dir, "..");
if (ROOT.toLowerCase().startsWith(REPO.toLowerCase())) throw new Error("Refusing a root inside the repository");

const P = {
  fixture: path.join(ROOT, "fixture", "atlas.sqlite"), meta: path.join(ROOT, "fixture", "fixture.json"),
  config: path.join(ROOT, "config"), archive: path.join(ROOT, "archive"), state: path.join(ROOT, "state"),
  snapshots: path.join(ROOT, "snapshots"), userprofile: path.join(ROOT, "userprofile"), work: path.join(ROOT, "work"),
  results: path.join(ROOT, "results"), golden: path.join(ROOT, "golden"),
};
for (const dir of [path.dirname(P.fixture), P.config, P.archive, P.state, P.snapshots, P.userprofile, P.work, P.results, P.golden])
  fs.mkdirSync(dir, { recursive: true });
const RUN_DB = path.join(P.work, `run-${process.pid}.sqlite`);
// Bound before any src module reads its environment-derived paths.
Object.assign(process.env, { TOKENATLAS_DB: command === "build" ? P.fixture : RUN_DB, TOKENATLAS_CONFIG: P.config,
  TOKENATLAS_ARCHIVE: P.archive, TOKENATLAS_LOCAL_STATE: P.state, TOKENATLAS_SNAPSHOT_DIR: P.snapshots,
  TOKENATLAS_MACHINE: "SYNTHETIC-PC", TOKENATLAS_LOGIN: "review", TOKENATLAS_FROZEN_CONFIG: "0" });

/* ---------- frozen clock ---------- */
const HISTORY_END = "2026-11-10";
const FIXTURE_NOW = Date.parse("2026-11-11T06:00:00.000Z");
{
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a: unknown[]) { if (a.length === 0) super(FIXTURE_NOW); else super(...(a as [number])); }
    static override now() { return FIXTURE_NOW; }
  }
  (globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
}

/* ---------- small helpers ---------- */
const round = (ms: number) => Math.round(ms * 10) / 10;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);

/* ---------- SQL instrumentation (patches one connection's statements in place) ---------- */
type SqlStat = { n: number; ms: number; rows: number };
class Recorder {
  n = 0; ms = 0; rows = 0; by = new Map<string, SqlStat>();
  add(sql: string, ms: number, rows: number) {
    this.n++; this.ms += ms; this.rows += rows;
    const key = sql.replace(/\s+/g, " ").trim().slice(0, 140);
    const s = this.by.get(key) ?? { n: 0, ms: 0, rows: 0 }; s.n++; s.ms += ms; s.rows += rows; this.by.set(key, s);
  }
  snapshot() { return { n: this.n, ms: this.ms, rows: this.rows }; }
  top(limit = 8) {
    return [...this.by].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit)
      .map(([sql, s]) => ({ sql, n: s.n, ms: round(s.ms), rows: s.rows }));
  }
}
let recorder: Recorder | null = null;
const patched = new WeakSet<object>();
function patchStatement(statement: any, sql: string) {
  if (!statement || patched.has(statement)) return statement;
  patched.add(statement);
  for (const method of ["all", "get", "run", "values"] as const) {
    const original = statement[method];
    if (typeof original !== "function") continue;
    statement[method] = function (...a: unknown[]) {
      if (!recorder) return original.apply(statement, a);
      const r = recorder, t = performance.now();
      const out = original.apply(statement, a);
      r.add(sql, performance.now() - t, Array.isArray(out) ? out.length : out ? 1 : 0);
      return out;
    };
  }
  const iterate = statement.iterate;
  if (typeof iterate === "function") statement.iterate = function (...a: unknown[]) {
    const inner = iterate.apply(statement, a);
    if (!recorder) return inner;
    const r = recorder;
    return (function* () {
      let ms = 0, rows = 0;
      try {
        while (true) { const t = performance.now(); const step = inner.next(); ms += performance.now() - t; if (step.done) break; rows++; yield step.value; }
      } finally { r.add(sql, ms, rows); }
    })();
  };
  return statement;
}
function instrument<T extends object>(db: T): T {
  const d = db as any, query = d.query, prepare = d.prepare;
  d.prepare = function (sql: string, ...a: unknown[]) { return patchStatement(prepare.call(d, sql, ...a), sql); };
  d.query = function (sql: string) { return patchStatement(query.call(d, sql), sql); };
  return db;
}
async function recorded<T>(work: () => Promise<T> | T): Promise<{ value: T; ms: number; sql: Recorder }> {
  const r = new Recorder(), previous = recorder; recorder = r;
  const t = performance.now();
  try { const value = await work(); return { value, ms: performance.now() - t, sql: r }; }
  finally { recorder = previous; }
}

/* ---------- long-transaction warnings ---------- */
const warnings: string[] = [];
const warn = console.warn.bind(console);
console.warn = (...a: unknown[]) => { const line = a.map(String).join(" "); if (line.includes("transaction held")) warnings.push(line.slice(0, 300)); else warn(...a); };

/* ======================================================================================= */
/* build                                                                                    */
/* ======================================================================================= */
interface FixtureParams { accounts: number; days: number; calls: number; probeMinutes: number; seed: number; ratelimitEvery: number;
  projects: number; homes: number; sessions: number }
const ACCOUNTS = [
  { id: "codex1", plan: "pro", homes: ["c1-main", "c1-laptop"], weeklyAnchor: Date.parse("2025-09-01T05:17:00Z"), capacity: 9.0e8, capacity5h: 1.1e8 },
  { id: "codex2", plan: "plus", homes: ["c2-main"], weeklyAnchor: Date.parse("2025-09-03T13:41:00Z"), capacity: 3.5e8, capacity5h: 0.5e8 },
];
// Models by the day they appear (dated rules of the shipped rate card), with weights.
const MODEL_ERAS: Array<[string, Array<[string, number]>]> = [
  ["2025-09-16", [["gpt-5-codex", 6], ["gpt-5", 2]]],
  ["2025-11-21", [["gpt-5.1-codex", 4], ["gpt-5.1-codex-max", 3], ["gpt-5.1-codex-mini", 1]]],
  ["2025-12-20", [["gpt-5.2-codex", 6], ["gpt-5.1-codex-max", 2]]],
  ["2026-02-12", [["gpt-5.3-codex", 7], ["gpt-5.3-codex-spark", 1], ["gpt-5.2-codex", 1]]],
  ["2026-04-23", [["gpt-5.5", 6], ["gpt-5.4", 2], ["gpt-5.3-codex-spark", 1]]],
  ["2026-07-09", [["gpt-5.5", 4], ["gpt-5.6-sol", 3], ["gpt-5.6-terra", 2], ["gpt-5.3-codex-spark", 1]]],
  ["2026-09-08", [["gpt-6-astra", 5], ["gpt-5.6-sol", 2], ["gpt-5.5", 1], ["gpt-5.3-codex-spark", 1]]],
  ["2026-09-22", [["gpt-6-sol", 4], ["gpt-6-astra", 3], ["gpt-6-luna", 1], ["gpt-5.3-codex-spark", 1]]],
  ["2026-10-26", [["gpt-6.1-terra", 4], ["gpt-6-sol", 3], ["gpt-6.1-sol", 2], ["gpt-5.3-codex-spark", 1]]],
];
const PROJECTS = ["atlas", "landing", "billing", "probe", "infra", "docs", "mobile", "research"];

async function build(params: FixtureParams) {
  if (fs.existsSync(P.fixture)) throw new Error(`Fixture exists: ${P.fixture} (delete the root to rebuild)`);
  const { Database } = await import("../src/db/sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { applyDrizzleMigrations } = await import("../src/db/migrate");
  const { ACCOUNT_PERIODS, replaceDeclaredPeriods } = await import("../src/db/period-store");
  const { resolveDbPath } = await import("../src/db");
  if (path.resolve(resolveDbPath()).toLowerCase() !== P.fixture.toLowerCase()) throw new Error("Database path does not resolve to the fixture");
  const started = performance.now(), timings: Record<string, number> = {};
  const step = (name: string, t: number) => { timings[name] = Math.round(performance.now() - t); console.log(`[build] ${name}: ${timings[name]} ms`); };
  const rand = mulberry32(params.seed);
  // Defaults reproduce the reference fixture; --projects/--homes widen the dimensions of a denser one.
  const projects = [...PROJECTS, ...Array.from({ length: Math.max(0, params.projects - PROJECTS.length) }, (_, i) => `p${PROJECTS.length + i + 1}`)];
  const accounts = ACCOUNTS.slice(0, params.accounts).map(account => params.homes > 0
    ? { ...account, homes: Array.from({ length: account.id === "codex1" ? params.homes : Math.max(1, params.homes - 1) }, (_, i) => `${account.id}-h${i + 1}`) } : account);
  const sourceRows = accounts.flatMap(account => account.homes.map(suffix => ({ account: account.id, suffix,
    home: path.join(P.archive, "codex", `SYNTHETIC-PC-review-${suffix}`), source_home: path.join(P.userprofile, `.codex-${suffix}`) })));
  // Frozen inputs: the shipped rate card is copied so a later card edit does not move the golden bodies.
  fs.copyFileSync(path.join(REPO, "rate-cards.json"), path.join(P.config, "rate-cards.json"));
  fs.writeFileSync(path.join(P.config, "accounts.json"), JSON.stringify({ version: 2,
    subscriptions: accounts.map(a => ({ id: a.id, vendor: "codex", status: "active", account: `${a.id}@example.test` })),
    sources: sourceRows.map(s => ({ vendor: "codex", machine: "SYNTHETIC-PC", login: "review", home: s.home, source_home: s.source_home })),
  }, null, 2) + "\n");

  let t = performance.now();
  const sqlite = new Database(P.fixture, { create: true });
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA cache_size=-262144");
  applyDrizzleMigrations(drizzle(sqlite));
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, sourceRows.map(s => ({ provider: "codex", subject: `codex/${path.basename(s.home)}`,
    value: s.account, from: "2000-01-01", until: null, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0,
    evidence: "synthetic-measure-fixture" })));
  sqlite.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT, model TEXT,
      effort TEXT, project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, reasoning_out INTEGER,
      cwd TEXT, project_id TEXT, service_tier TEXT, speed TEXT NOT NULL DEFAULT 'unknown', source_offset INTEGER, plan_type TEXT,
      billing_mode TEXT NOT NULL DEFAULT 'unknown', meter_reset INTEGER);
    CREATE INDEX events_ts ON events(home, ts); CREATE INDEX events_global_ts ON events(ts);
    CREATE INDEX events_path ON events(home, path); CREATE INDEX events_project_id ON events(project_id);
    CREATE TABLE ratelimit (home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL, resets_at INTEGER, plan_type TEXT,
      limit_id TEXT, limit_name TEXT);
    CREATE INDEX rl_ts ON ratelimit(home, limit_id, window_minutes, ts); CREATE INDEX ratelimit_global_ts ON ratelimit(ts);
    CREATE INDEX rl_path ON ratelimit(home, path);`);
  // The server's startup indexes of the raw tables (ranges, analysis days, source evidence).
  const { ensureRawSyncIndexes } = await import("../src/db/migrate");
  ensureRawSyncIndexes(sqlite);
  step("schema", t);

  /* Synthetic traffic: sessions per account and day, weekly windows on a fixed anchor, 5h windows from first use. */
  t = performance.now();
  const endMs = Date.parse(HISTORY_END) + DAY, startMs = endMs - params.days * DAY;
  const insertEvent = sqlite.query(`INSERT INTO events(home,path,ts,surface,model,project,in_tok,cached_in,cache_write,out_tok,reasoning_out,cwd,
    project_id,service_tier,speed,source_offset,plan_type,billing_mode,meter_reset) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,'unknown',?)`);
  const insertRate = sqlite.query(`INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,resets_at,plan_type,limit_id,limit_name)
    VALUES (?,?,?,?,?,?,?,'codex',NULL)`);
  const insertProbe = sqlite.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,scope,plan,reported_percent_side,used_percent,
    window_minutes,resets_at,machine,ok) VALUES ('codex',?,?,?,'codex','subscription',?,'used',?,?,?,'SYNTHETIC-PC',1)`);
  const pick = <T,>(items: Array<[T, number]>) => { const total = items.reduce((s, [, w]) => s + w, 0); let x = rand() * total;
    for (const [v, w] of items) { x -= w; if (x <= 0) return v; } return items.at(-1)![0]; };
  const modelsOn = (day: string) => [...MODEL_ERAS].reverse().find(([from]) => day >= from)?.[1] ?? MODEL_ERAS[0]![1];
  let eventCount = 0, probeCount = 0, rateCount = 0;
  for (const account of accounts) {
    const homes = sourceRows.filter(s => s.account === account.id);
    type Call = { at: number; home: string; file: string; model: string; project: string; tier: string | null; in: number; cached: number; out: number; surface: string };
    const calls: Call[] = [];
    for (let day = startMs; day < endMs; day += DAY) {
      const date = dayOf(day), weekday = new Date(day).getUTCDay();
      if (rand() < 0.04) continue; // a day off
      const volume = Math.round(params.calls * (weekday === 0 || weekday === 6 ? 0.35 : 1) * (0.6 + 0.8 * rand()) * (account.id === "codex2" ? 0.5 : 1));
      const sessions = params.sessions + Math.floor(rand() * (params.sessions + 3));
      for (let s = 0; s < sessions; s++) {
        const home = rand() < 0.8 ? homes[0]! : homes[homes.length - 1]!;
        const begin = day + Math.floor((7 + rand() * 16) * HOUR + rand() * HOUR), length = (20 + rand() * 160) * MIN;
        const file = path.join(home.home, "sessions", date.slice(0, 4), date.slice(5, 7), date.slice(8, 10), `rollout-${date}-${s}.jsonl`);
        const model = pick(modelsOn(date)), project = projects[Math.floor(rand() * projects.length)]!;
        const tier = rand() < 0.15 ? "priority" : rand() < 0.1 ? null : "default", surface = rand() < 0.7 ? "cli" : "vscode";
        const n = Math.max(1, Math.round(volume / sessions * (0.5 + rand())));
        let context = 20_000 + rand() * 30_000;
        for (let c = 0; c < n; c++) {
          const at = Math.floor(begin + (length * c) / n + rand() * 30_000);
          if (at >= endMs) break;
          context = Math.min(260_000, context + rand() * 6_000);
          const input = Math.round(context), cached = Math.round(input * (0.7 + 0.25 * rand())), out = Math.round(300 + rand() * 9_000);
          calls.push({ at, home: home.home, file, model, project, tier, in: input, cached, out, surface });
        }
      }
    }
    calls.sort((a, b) => a.at - b.at);
    // Meter state as the account's calls advance: a weekly window on a fixed anchor and 5h windows from first use.
    const weight = (c: Call) => (c.in - c.cached) * 1.0 + c.cached * 0.1 + c.out * 6;
    const weekOf = (at: number) => Math.floor((at - account.weeklyAnchor) / (7 * DAY));
    const weeklyReset = (at: number) => account.weeklyAnchor + (weekOf(at) + 1) * 7 * DAY;
    let week = -1, weekUsed = 0, fiveStart = -Infinity, fiveUsed = 0, callIndex = 0, offset = 0;
    const advance = (until: number, emit: boolean) => {
      for (; callIndex < calls.length && calls[callIndex]!.at <= until; callIndex++) {
        const c = calls[callIndex]!;
        if (weekOf(c.at) !== week) { week = weekOf(c.at); weekUsed = 0; }
        if (c.at >= fiveStart + 5 * HOUR) { fiveStart = c.at - (c.at % MIN); fiveUsed = 0; }
        weekUsed += weight(c); fiveUsed += weight(c);
        if (!emit) continue;
        const meterReset = Math.floor(weeklyReset(c.at) / 1000);
        insertEvent.run(c.home, c.file, iso(c.at), c.surface, c.model, c.project, c.in, c.cached, c.out, Math.round(c.out * 0.4),
          `C:/work/${c.project}`, c.project, c.tier, c.tier === "priority" ? "fast" : c.tier === "default" ? "standard" : "unknown",
          ++offset, account.plan, meterReset);
        eventCount++;
        if (offset % params.ratelimitEvery === 0) {
          insertRate.run(c.home, c.file, iso(c.at), 300, pct(fiveUsed, account.capacity5h), Math.floor((fiveStart + 5 * HOUR) / 1000), account.plan);
          insertRate.run(c.home, c.file, iso(c.at), 10080, pct(weekUsed, account.capacity), meterReset, account.plan);
          rateCount += 2;
        }
      }
    };
    const pct = (used: number, capacity: number) => Math.min(100, Math.round((used / capacity) * 1000) / 10);
    sqlite.transaction(() => {
      for (let poll = startMs; poll < endMs; poll += params.probeMinutes * MIN) {
        advance(poll, true);
        const hour = new Date(poll).getUTCHours();
        if (hour < 7) continue; // the polling machine is off at night
        const currentWeek = weekOf(poll) === week ? weekUsed : 0;
        const fiveActive = poll < fiveStart + 5 * HOUR;
        insertProbe.run(account.id, iso(poll), "primary", account.plan, fiveActive ? pct(fiveUsed, account.capacity5h) : 0, 300,
          iso(fiveActive ? fiveStart + 5 * HOUR : poll - (poll % MIN) + 5 * HOUR));
        insertProbe.run(account.id, iso(poll), "secondary", account.plan, pct(currentWeek, account.capacity), 10080, iso(weeklyReset(poll)));
        probeCount += 2;
      }
      advance(Infinity, true);
    })();
  }
  step("synthetic rows", t);
  console.log(`[build] events=${eventCount} probe_windows=${probeCount} ratelimit=${rateCount}`);
  sqlite.close();

  /* Producers, as the maintenance worker runs them: ledger, probe facts and current cards, limit windows, window sums. */
  const api = await import("../src/server/api");
  const ctx = api.createAppContext(P.fixture);
  ctx.sqlite.exec("PRAGMA synchronous=OFF; PRAGMA cache_size=-262144");
  const sources = ctx.accounts.sources.map((source, index) => ({ ...source, id: sourceRows[index]!.account }));
  t = performance.now();
  await publishLedger(ctx.sqlite, ctx.rateCards, ctx.homeToSubId, sources);
  step("codex ledger", t);
  t = performance.now();
  const { fillUsageLedgerFixture } = await import("../src/server/usage-ledger.fixture");
  fillUsageLedgerFixture(ctx.sqlite, ctx.rateCards);
  const { prepareProbeReaderFixture } = await import("../src/server/probe-reader.fixture");
  const { currentRegistry } = await import("../src/server/current/registry");
  const { publishCurrentBatch } = await import("../src/server/current/store");
  const now = new Date().toISOString();
  // The fixture links every reading, then gives the projection 1000 batches; this history needs more.
  try { prepareProbeReaderFixture(ctx.sqlite, sources); }
  catch (error) { if (!String(error).includes("did not settle")) throw error; }
  for (let i = 0; i < 1_000_000 && publishCurrentBatch(ctx.sqlite, currentRegistry(ctx.accounts.subscriptions, now), now, 4096, ctx.accounts); i++);
  const { preparedProbeAccountIndexReady } = await import("../src/server/current/probe-account-reader");
  if (!preparedProbeAccountIndexReady(ctx.sqlite)) throw new Error("Probe account index did not become ready");
  step("probe facts + current cards", t);
  t = performance.now();
  const { prepareLimitWindowsFixture } = await import("../src/server/limit-windows.fixture");
  prepareLimitWindowsFixture(ctx.sqlite, { sources, subscriptions: ctx.accounts.subscriptions });
  step("limit windows", t);
  t = performance.now();
  const { prepareWindowUsageFixture } = await import("../src/server/window-usage.fixture");
  prepareWindowUsageFixture(ctx.sqlite, { rateCards: ctx.rateCards, subscriptions: ctx.accounts.subscriptions, manualCapacity: () => [], cycles: { windows: [] } });
  step("window sums", t);
  const { ensureWindowAnswersSchema } = await import("../src/db/window-answers");
  ensureWindowAnswersSchema(ctx.sqlite);
  ctx.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const counts = tableCounts(ctx.sqlite);
  ctx.sqlite.close();
  const meta = { params, history: { since: dayOf(startMs), until: HISTORY_END }, fixture_now: iso(FIXTURE_NOW),
    accounts: accounts.map(a => ({ id: a.id, homes: a.homes.length })), build_ms: Math.round(performance.now() - started), timings,
    file_bytes: fs.statSync(P.fixture).size, file_sha256: createHash("sha256").update(fs.readFileSync(P.fixture)).digest("hex"), counts };
  fs.writeFileSync(P.meta, JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify({ file_bytes: meta.file_bytes, build_ms: meta.build_ms }));
}

/** The production ledger producer over the fixture's events (prepareCodexLedgerFixture without its whole-table stamp). */
async function publishLedger(db: any, card: any, homes: Map<string, string>, sources: any[]) {
  const { projectRulesFromRawRows } = await import("../src/projects/rules.fixture");
  const { createCodexLedgerSchema } = await import("../src/db/codex-price-ledger");
  const { codexLedgerReadContext } = await import("../src/db/codex-ledger-adapters");
  const { fillCodexLedgerFixture } = await import("../src/server/codex-ledger.fixture");
  const { codexHomeSource } = await import("../src/server/event-source");
  const { ARCHIVE_LOGICAL_ROOT } = await import("../src/config/paths");
  const { installAnalysisTracking } = await import("../src/db/analysis");
  const { installFactDayRevisions } = await import("../src/db/fact-day-revisions");
  projectRulesFromRawRows(db);
  const context = codexLedgerReadContext(card);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='codex_price_ledger_events'").get()) createCodexLedgerSchema(db);
  const revision = db.query("SELECT 1 FROM sqlite_master WHERE name='vendor_sync_revisions'").get()
    ? (db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get()?.revision ?? 0) : 0;
  fillCodexLedgerFixture(db, { bands: context.policy.baseBands, rulesRevision: context.rulesRevision!, factsRevision: revision,
    policy: context.policy.policy, sourceOf: (home: string | null) => home === null ? null : codexHomeSource(home, sources, ARCHIVE_LOGICAL_ROOT) });
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  void homes;
}

function tableCounts(db: any) {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(r => r.name);
  const out: Record<string, number> = {};
  for (const name of tables) {
    const n = (db.query(`SELECT COUNT(*) n FROM "${name}"`).get() as { n: number }).n;
    if (n) out[name] = n;
  }
  return out;
}

/* ======================================================================================= */
/* measure                                                                                  */
/* ======================================================================================= */
async function measure(label: string, samples: number, walTargets: number[]) {
  const goldenDir = namedPath(P.golden, label, "label"), out = namedPath(P.results, `${label}.json`, "label");
  if (!fs.existsSync(P.fixture)) throw new Error("Build the fixture first");
  const meta = JSON.parse(fs.readFileSync(P.meta, "utf8"));
  fs.copyFileSync(P.fixture, RUN_DB);
  fs.rmSync(goldenDir, { recursive: true, force: true }); fs.mkdirSync(goldenDir, { recursive: true });
  const report: Record<string, unknown> = { label, fixture: { file_bytes: meta.file_bytes, counts: meta.counts, history: meta.history, params: meta.params },
    bun: Bun.version, platform: `${process.platform}/${process.arch}`, cpus: os.cpus().length, samples };
  const opened: Array<{ close(): void }> = [];
  try {
    const { Database } = await import("../src/db/sqlite");
    const { resolveDbPath } = await import("../src/db");
    if (path.resolve(resolveDbPath()).toLowerCase() !== RUN_DB.toLowerCase()) throw new Error("Database path does not resolve to the run copy");
    const api = await import("../src/server/api");
    const { loadAccountResolver } = await import("../src/server/account-resolver");
    const { buildEraIndex } = await import("../src/server/eras");
    const { periodEras } = await import("../src/server/subscription-maps");
    const { withReadSnapshotAsync, withReadSnapshot } = await import("../src/db/analysis");
    const { WINDOW_SCREENS, storedScopeOf } = await import("../src/server/window-screens");
    const { buildCodexAccountingReport, codexAccountingRequest } = await import("../src/server/codex-accounting");
    const { createDataRead, storedAnswerConfiguration, OPEN_ANSWER_REFRESH_MS } = await import("../src/server/data-read");
    const { readRefreshCheck, readSyncRows, syncReadRows } = await import("../src/server/read-refresh");
    const { createDirectRead } = await import("../src/server/direct-read");
    const { handleRoster } = await import("../src/server/api-roster");
    const { latestAccountState } = await import("../src/server/account-probes");
    const { dataConfigurationStamp, readsWindowSums, DATA_VIEWS } = await import("../src/server/data-views");
    const { dataVersion } = await import("../src/server/data-version");
    const { PREPARED_AT_HEADER, preparedAtMs, clockBoundaryMs, presentClockFields } = await import("../src/server/data-clock");
    const { cacheKey } = await import("../src/server/cache");
    const { serveCycleReadBatch } = await import("../src/server/cycle-read-batch");
    const { readWindowAnswerBatch, storeWindowAnswers, windowAnswerMarkSeq, markWindowAnswersDirty, windowAnswerMarkedSince } = await import("../src/db/window-answers");
    const { readCodexLimitWindows } = await import("../src/server/codex-limit-windows");

    const main = api.createAppContext(RUN_DB);
    instrument(main.sqlite);
    opened.push(main.sqlite);
    const subscriptions = main.accounts.subscriptions;
    const readOnly = () => {
      const db = instrument(new Database(RUN_DB, { readonly: true }));
      opened.push(db);
      db.exec("PRAGMA busy_timeout=3000; PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
      return db;
    };
    const workerCtx = (db: any) => ({ ...main, sqlite: db, dbPath: RUN_DB, resolver: loadAccountResolver(db, subscriptions),
      eras: buildEraIndex(periodEras(db, main.accounts), "instant"), homeConflict: null }) as typeof main;

    const historyEnd = meta.history.until as string;
    const minus = (days: number) => dayOf(Date.parse(historyEnd) - (days - 1) * DAY);
    const accountingUrl = (account: string, days: number, minutes?: number) => {
      const url = new URL("/api/codex-accounting", "http://local");
      url.searchParams.set("account", account); url.searchParams.set("since", minus(days)); url.searchParams.set("until", historyEnd);
      if (minutes) url.searchParams.set("window_minutes", String(minutes));
      return url;
    };

    /* ---- 1. /api/codex-accounting: the data worker's build of one stored answer ---- */
    const accounting: Array<Record<string, unknown>> = [], accountingAnswers: any[] = [];
    const scenarios: Array<[string, number, number | undefined]> = [["codex1", 30, undefined], ["codex1", 90, undefined], ["codex1", 365, undefined],
      ["codex1", 30, 300], ["codex1", 90, 300], ["codex1", 365, 300], ...(subscriptions.length > 1 ? [["codex2", 90, undefined] as [string, number, undefined]] : [])];
    for (const [account, days, minutes] of scenarios) {
      const url = accountingUrl(account, days, minutes);
      const db = readOnly(), ctx = workerCtx(db);
      const runs: Array<{ txn_ms: number; build_ms: number; status: number; bytes: number; sql_n: number; sql_ms: number; hash: string }> = [];
      let body = "", snapshot: { checked: number; version: string } | null = null;
      for (let sample = 0; sample < samples; sample++) {
        const before = warnings.length;
        const r = await recorded(async () => {
          let built = 0;
          const answer = await withReadSnapshotAsync(db, async () => {
            const snapshot = { checked: windowAnswerMarkSeq(db), version: dataVersion(db, { windowSums: readsWindowSums(url.pathname),
              capacityCycles: DATA_VIEWS[url.pathname]?.sources.includes("capacity_cycle_results") ?? false, firstTokenTimes: false, contextPrices: false }) };
            const t = performance.now();
            const response = await WINDOW_SCREENS[url.pathname]!.produce(ctx, url);
            const json = await response.json();
            built = performance.now() - t;
            return { snapshot, status: response.status, body: JSON.stringify(json) };
          });
          return { ...answer, built };
        });
        body = r.value.body; snapshot ??= r.value.snapshot;
        runs.push({ txn_ms: round(r.ms), build_ms: round(r.value.built), status: r.value.status, bytes: body.length, sql_n: r.sql.n, sql_ms: round(r.sql.ms), hash: sha(body) });
        void before;
      }
      // The same build with its phase hook, SQL attributed to the phase that ran it (one warm sample).
      const request = codexAccountingRequest(url.searchParams);
      if ("error" in request) throw new Error(request.error);
      const phases: Array<{ phase: string; ms: number; sql_n: number; sql_ms: number; sql_rows: number }> = [];
      const phaseTop: Record<string, unknown> = {};
      const r = new Recorder(); recorder = r;
      let last = r.snapshot(), lastTop = new Map<string, SqlStat>();
      const t = performance.now();
      try {
        buildCodexAccountingReport(db, ctx.rateCards, { ...request.options, contextPreview: false }, ctx.homeToSubId, ctx.eras, true,
          (phase, ms) => {
            const now = r.snapshot();
            phases.push({ phase, ms: round(ms), sql_n: now.n - last.n, sql_ms: round(now.ms - last.ms), sql_rows: now.rows - last.rows });
            phaseTop[phase] = [...r.by].map(([sql, s]) => [sql, s.ms - (lastTop.get(sql)?.ms ?? 0), s.n - (lastTop.get(sql)?.n ?? 0)] as const)
              .filter(([, ms]) => ms > 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([sql, ms, n]) => ({ sql, ms: round(ms), n }));
            last = now; lastTop = new Map([...r.by].map(([k, v]) => [k, { ...v }]));
          }, ctx.plans, ctx.plansCatalog, ctx.resolver, ctx.accounts.sources);
      } finally { recorder = null; }
      const directMs = performance.now() - t;
      const parsed = JSON.parse(body) as { windows?: unknown[]; traffic_periods?: Array<{ start: string; end: string }>; breakdown?: unknown[]; events?: number };
      const edgeDays = new Set((parsed.traffic_periods ?? []).flatMap(p => [p.start, p.end]).filter(b => Date.parse(b) !== Date.parse(b.slice(0, 10))).map(b => b.slice(0, 10)));
      const name = `codex-accounting_${account}_${days}d${minutes ? `_w${minutes}` : ""}`;
      fs.writeFileSync(path.join(goldenDir, `${name}.json`), body);
      if (!minutes) {
        // Kept as the stored answer the main thread serves while a newer one is computed (section 2b).
        const { family, ...scope } = storedScopeOf(main, url)!;
        accountingAnswers.push({ route: url.pathname, key: cacheKey(url), family, scope, configuration: storedAnswerConfiguration(main, url),
          checked: snapshot!.checked, builtAt: Date.now(), expiresAt: Date.now() + OPEN_ANSWER_REFRESH_MS, status: 200, version: snapshot!.version,
          headers: [[PREPARED_AT_HEADER, iso(Date.now())]], body });
      }
      accounting.push({ name, url: `${url.pathname}${url.search}`, runs, cold_txn_ms: runs[0]!.txn_ms, warm_txn_ms_median: median(runs.slice(1).map(x => x.txn_ms)),
        deterministic: new Set(runs.map(x => x.hash)).size === 1, events: parsed.events, windows: parsed.windows?.length ?? 0,
        traffic_periods: parsed.traffic_periods?.length ?? 0, edge_days: edgeDays.size, breakdown_rows: parsed.breakdown?.length ?? 0,
        direct_ms: round(directMs), phases, phase_top_sql: phaseTop, top_sql: r.top(10) });
      console.log(`[measure] ${name}: cold ${runs[0]!.txn_ms} ms, warm ${median(runs.slice(1).map(x => x.txn_ms))} ms, edge days ${edgeDays.size}`);
      db.close();
    }
    report.codex_accounting = accounting;

    /* ---- 1b. The same builds while a price-rule revaluation is queued (one scope outside every range) ---- */
    {
      const value = JSON.stringify({ model: "gpt-measure-none", basis: "api_equivalent_usd", fromDay: "2099-01-01", untilDay: null,
        inputAbove: null, inputUntil: null, after: 0 });
      main.sqlite.query("INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules',?)").run(value);
      const queued: unknown[] = [];
      for (const [account, days, minutes] of [["codex1", 90, undefined], ["codex1", 365, undefined], ["codex1", 365, 300]] as const) {
        const url = accountingUrl(account, days, minutes), db = readOnly(), ctx = workerCtx(db), times: number[] = [];
        let status = 0, sqlN = 0, same = false;
        for (let sample = 0; sample < Math.max(2, samples); sample++) {
          const r = await recorded(() => withReadSnapshotAsync(db, async () => { const response = await WINDOW_SCREENS[url.pathname]!.produce(ctx, url);
            return { status: response.status, body: JSON.stringify(await response.json()) }; }));
          times.push(r.ms); status = r.value.status; sqlN = r.sql.n;
          same = r.value.body === fs.readFileSync(path.join(goldenDir, `codex-accounting_${account}_${days}d${minutes ? `_w${minutes}` : ""}.json`), "utf8");
        }
        queued.push({ url: `${url.pathname}${url.search}`, status, same_body_as_unqueued: same, cold_ms: round(times[0]!), warm_ms: round(median(times.slice(1))), sql_n: sqlN });
        db.close();
      }
      main.sqlite.query("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind='rules' AND value=?").run(value);
      report.codex_accounting_with_queued_rule = queued;
      console.log("[measure] queued rule:", JSON.stringify(queued));
    }

    /* ---- 2. /api/cycle-breakdowns: the main thread's batch read of stored answers ---- */
    const windows = readCodexLimitWindows(main.sqlite, "codex1", 10080).slice(-12);
    const batchUrls = windows.map(w => {
      const url = new URL("/api/cycle-breakdown", "http://local");
      for (const [k, v] of Object.entries({ account: "codex1", since_ts: w.start, until_ts: w.end, limit_id: "codex", valuation: "dated" })) url.searchParams.set(k, v);
      return url;
    });
    const readPaths = [
      ...batchUrls.map(u => `${u.pathname}${u.search}`),
      ...subscriptions.flatMap(s => [30, 90, 365].map(d => { const u = accountingUrl(s.id, d); return `${u.pathname}${u.search}`; })),
      ...subscriptions.flatMap(s => [10080, 300, 43200].map(w => `/api/usage-series?account=${s.id}&window=${w}&points=900`)),
      ...subscriptions.map(s => `/api/windows?account=${s.id}`),
      ...windows.slice(-4).map(w => `/api/window-projects?account=codex1&from=${encodeURIComponent(w.start)}&until=${encodeURIComponent(w.end)}`),
    ].slice(0, 30);
    const fsCalls = { n: 0, ms: 0 };
    const fsModule = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
    const originals = Object.fromEntries(["readFileSync", "readdirSync", "existsSync", "statSync"].map(name => [name, fsModule[name]!]));
    // Counts synchronous file reads made inside a read snapshot (configuration stamps read config files).
    const countFs = (on: boolean) => { if (on) { fsCalls.n = 0; fsCalls.ms = 0; }
      for (const [name, original] of Object.entries(originals)) try { fsModule[name] = on ? (...a: unknown[]) => {
        const t = performance.now(); try { return original(...a); } finally { fsCalls.n++; fsCalls.ms += performance.now() - t; } } : original; } catch { /* not writable */ } };
    const refreshUrl = (cursor: number) => new URL(`http://local/api/sync?read_paths=${encodeURIComponent(JSON.stringify(readPaths))}&read_cursor=${cursor}`);
    {
      const db = readOnly(), ctx = workerCtx(db), answers: any[] = [];
      const t = performance.now();
      for (const url of batchUrls) {
        const scope = storedScopeOf(main, url)!;
        const { family, ...answerScope } = scope;
        const built = await withReadSnapshotAsync(db, async () => {
          const builtAt = Date.now(), response = await WINDOW_SCREENS[url.pathname]!.produce(ctx, url);
          const body = await response.json();
          return { checked: windowAnswerMarkSeq(db), version: dataVersion(db, { windowSums: readsWindowSums(url.pathname), capacityCycles: false,
            firstTokenTimes: false, contextPrices: false }), status: response.status, body,
            headers: [...[...response.headers].filter(([n]) => n.toLowerCase() !== PREPARED_AT_HEADER.toLowerCase()), [PREPARED_AT_HEADER, iso(builtAt)]] as Array<[string, string]> };
        });
        if (built.status !== 200) throw new Error(`cycle-breakdown answered ${built.status}: ${JSON.stringify(built.body).slice(0, 300)}`);
        const builtAt = preparedAtMs(built.headers) ?? Date.now(), clock = WINDOW_SCREENS[url.pathname]!.clock ? clockBoundaryMs(built.body, builtAt) : null;
        const end = answerScope.untilMs, open = end === null || end > builtAt ? builtAt + OPEN_ANSWER_REFRESH_MS : null;
        answers.push({ route: url.pathname, key: cacheKey(url), family, scope: answerScope, configuration: storedAnswerConfiguration(main, url),
          checked: built.checked, builtAt, expiresAt: clock === null ? open : open === null ? clock : Math.min(clock, open), status: 200,
          version: built.version, headers: built.headers, body: JSON.stringify(built.body) });
      }
      const produceMs = performance.now() - t;
      storeWindowAnswers(main.sqlite, answers);
      db.close();
      fs.writeFileSync(path.join(goldenDir, "cycle-breakdown_answers.json"), JSON.stringify(answers.map(a => ({ key: a.key, body: JSON.parse(a.body) }))));
      report.cycle_breakdown_answers = { count: answers.length, produce_ms_total: round(produceMs),
        body_bytes: answers.map(a => a.body.length), expires: answers.map(a => a.expiresAt === null ? null : iso(a.expiresAt)) };
    }
    const stubWorkers: string[] = [];
    const stubFactory = () => ({ postMessage(work: { request?: { url: string } }) { stubWorkers.push(work.request?.url ?? "?"); },
      terminate() {}, onmessage: null, onerror: null }) as unknown as Worker;
    const batchOnce = async (dataRead: ReturnType<typeof createDataRead>) => {
      const request = new Request(`http://local/api/cycle-breakdowns?requests=${encodeURIComponent(JSON.stringify(batchUrls.map(u => `${u.pathname}${u.search}`)))}`);
      const before = warnings.length;
      countFs(true);
      const r = await recorded(() => serveCycleReadBatch(request, (urls, signal) => dataRead.batch(main, urls, signal)));
      countFs(false);
      const text = await r.value.text();
      const envelopes = (JSON.parse(text) as { responses: Array<{ status: number; headers: Array<[string, string]> }> }).responses;
      return { ms: round(r.ms), sql_n: r.sql.n, sql_ms: round(r.sql.ms), fs_calls: fsCalls.n, fs_ms: round(fsCalls.ms),
        states: envelopes.map(e => e.headers.find(([n]) => n.toLowerCase() === "x-analysis")?.[1]),
        bytes: text.length, top_sql: r.sql.top(6), warnings: warnings.slice(before), text };
    };
    /*
     * The lookup lane (direct-read.ts `light`, a real worker): the calling thread runs only the call up to its first await
     * and the continuation after the worker's answer; `main_ms` is their sum (plus serializing the batch), `latency_ms` the wait.
     */
    const directRead = createDirectRead();
    const lane = { syncMs: 0, resolvedAt: 0 };
    const timedLight: NonNullable<Parameters<typeof createDataRead>[1]>["light"] = (ctx, read, signal) => {
      const t = performance.now(), promise = directRead.light(ctx, read, signal);
      lane.syncMs += performance.now() - t;
      return promise.then(value => { lane.resolvedAt = performance.now(); return value; });
    };
    const laneTimed = async <T,>(start: () => Promise<T>) => {
      lane.syncMs = 0;
      const r = new Recorder(), previous = recorder; recorder = r;
      try {
        const t0 = performance.now(), promise = start(), callMs = performance.now() - t0;
        const value = await promise, done = performance.now();
        return { value, t0, done, main: callMs + Math.max(0, done - lane.resolvedAt), sql: r };
      } finally { recorder = previous; }
    };
    const lightBatchOnce = async (dataRead: ReturnType<typeof createDataRead>) => {
      const run = await laneTimed(() => dataRead.batch(main, batchUrls));
      const t = performance.now();
      const text = JSON.stringify({ responses: await Promise.all(run.value.map(async response => ({ status: response.status,
        headers: [...response.headers] as Array<[string, string]>, body: await response.text() }))) });
      const serialize = performance.now() - t;
      return { main_ms: round(run.main + serialize), latency_ms: round(run.done - run.t0 + serialize), main_sql_n: run.sql.n, main_sql_ms: round(run.sql.ms), text };
    };
    const lightSyncOnce = async (cursor: number) => {
      const run = await laneTimed(() => readSyncRows(main, refreshUrl(cursor), timedLight));
      return { main_ms: round(run.main), latency_ms: round(run.done - run.t0), main_sql_n: run.sql.n, result: run.value?.read_changes };
    };
    const refreshOnce = async (cursor: number) => {
      countFs(true);
      const r = await recorded(() => readRefreshCheck(main, refreshUrl(cursor)));
      countFs(false);
      return { ms: round(r.ms), sql_n: r.sql.n, sql_ms: round(r.sql.ms), fs_calls: fsCalls.n, fs_ms: round(fsCalls.ms), top_sql: r.sql.top(6), result: r.value };
    };
    // The batch's parts, timed separately in one snapshot as `batch` runs them.
    const batchParts = () => withReadSnapshot(main.sqlite, () => {
      const keys = batchUrls.map(cacheKey);
      let t = performance.now();
      const rows = readWindowAnswerBatch(main.sqlite, "/api/cycle-breakdown", keys);
      const read = performance.now() - t; t = performance.now();
      const latest = latestAccountState(main);
      const latestMs = performance.now() - t; t = performance.now();
      let cached: typeof latest | undefined;
      const configs = batchUrls.map(url => storedAnswerConfiguration(main, url, () => cached ??= latest));
      const configMs = performance.now() - t; t = performance.now();
      for (const [index, url] of batchUrls.entries()) {
        const answer = rows.get(keys[index]!)?.answer;
        if (!answer) continue;
        const body = JSON.parse(answer.body), built = preparedAtMs(answer.headers);
        const presented = WINDOW_SCREENS[url.pathname]?.clock && built !== null && Date.now() !== built ? presentClockFields(body, Date.now(), built) : body;
        JSON.stringify(presented);
        void configs;
      }
      const respondMs = performance.now() - t;
      return { readWindowAnswerBatch_ms: round(read), latestAccountState_ms: round(latestMs), configuration_ms: round(configMs),
        parse_present_serialize_ms: round(respondMs), stored_rows: rows.size, marked: [...rows.values()].filter(r => r.marked).length };
    });
    {
      const dataRead = createDataRead(stubFactory, { workers: 3 });
      const stored: unknown[] = [];
      let first = "";
      for (let sample = 0; sample < samples; sample++) { const b = await batchOnce(dataRead); first ||= b.text; stored.push({ ...b, text: undefined }); }
      const parts = []; for (let sample = 0; sample < samples; sample++) parts.push(batchParts());
      fs.writeFileSync(path.join(goldenDir, "cycle-breakdowns_batch.json"), first);
      // The same batch through the lookup lane (the server's path since the light lane).
      const lightRead = createDataRead(stubFactory, { workers: 3, light: timedLight });
      const lightStored: unknown[] = [];
      for (let sample = 0; sample < samples + 1; sample++) {
        const { text, ...run } = await lightBatchOnce(lightRead);
        lightStored.push({ ...run, same_body_as_in_place: text === first });
      }

      /* 2b. Single stored codex-accounting reads on the main thread (`read` -> `readStored`), current and stale. */
      storeWindowAnswers(main.sqlite, accountingAnswers);
      const single = async (label: string) => {
        const out: unknown[] = [];
        for (const answer of accountingAnswers) {
          const times: number[] = [];
          let state: string | null = null, bytes = 0;
          for (let sample = 0; sample < samples; sample++) {
            const t = performance.now();
            const response = await dataRead(main, new Request(`http://local${answer.key}`));
            times.push(performance.now() - t);
            state = response.headers.get("X-Analysis"); bytes = (await response.text()).length;
          }
          out.push({ key: answer.key, state, bytes, stored_body_bytes: answer.body.length, main_ms: times.map(round) });
        }
        return { label, reads: out };
      };
      const accountingSingle = [await single("stored")];

      /* 2c. A backlog of unfolded marks of another account: the batch's EXISTS and the refresh check scan it. */
      const backlog: unknown[] = [];
      const cursorBefore = windowAnswerMarkSeq(main.sqlite);
      for (const count of [50_000, 200_000]) {
        main.sqlite.transaction(() => {
          const put = main.sqlite.query("INSERT INTO window_answer_marks(provider,account,from_ms,until_ms,created_ms) VALUES('codex','zz-other',?,?,?)");
          const have = (main.sqlite.query("SELECT COUNT(*) n FROM window_answer_marks WHERE account='zz-other'").get() as { n: number }).n;
          for (let i = have; i < count; i++) put.run(FIXTURE_NOW - DAY, FIXTURE_NOW, Date.now());
        }).immediate();
        const batches: unknown[] = [], refreshes: unknown[] = [];
        for (let sample = 0; sample < samples; sample++) { const b = await batchOnce(dataRead); batches.push({ ms: b.ms, sql_ms: b.sql_ms, states: [...new Set(b.states)] }); }
        for (let sample = 0; sample < samples; sample++) { const q = await refreshOnce(cursorBefore); refreshes.push({ ms: q.ms, sql_ms: q.sql_ms }); }
        const lightBatches: unknown[] = [], lightSyncs: unknown[] = [];
        for (let sample = 0; sample < samples; sample++) { const { text: _text, ...run } = await lightBatchOnce(lightRead); lightBatches.push(run); }
        for (let sample = 0; sample < samples; sample++) { const { result: _result, ...run } = await lightSyncOnce(cursorBefore); lightSyncs.push(run); }
        backlog.push({ marks: count, batch: batches, refresh_check_from_old_cursor: refreshes, light_batch: lightBatches, light_sync_from_old_cursor: lightSyncs });
      }
      main.sqlite.exec("DELETE FROM window_answer_marks WHERE account='zz-other'");

      // A new mark over the account makes every answer stale: each read queues its recomputation (on the stub worker).
      main.sqlite.transaction(() => markWindowAnswersDirty(main.sqlite, { provider: "codex", account: "codex1", fromMs: Date.parse(windows[0]!.start) - 400 * DAY, untilMs: null })).immediate();
      const stale: unknown[] = [];
      for (let sample = 0; sample < samples; sample++) stale.push({ ...(await batchOnce(dataRead)), text: undefined });
      const lightStale: unknown[] = [];
      for (let sample = 0; sample < samples; sample++) { const { text: _text, ...run } = await lightBatchOnce(lightRead); lightStale.push(run); }
      accountingSingle.push(await single("stale"));
      report.cycle_breakdowns_batch = { urls: batchUrls.length, stored, parts, stale, light_stored: lightStored, light_stale: lightStale,
        queued_on_stub_worker: stubWorkers.length, marks_backlog: backlog };
      report.codex_accounting_stored_reads = accountingSingle;
      await dataRead.close(); await lightRead.close();
    }

    /* ---- 3. /api/roster?window=10080: the direct-read worker's build ---- */
    {
      const runs: unknown[] = [];
      const db = readOnly();
      let body = "", top: unknown = null, coldTop: unknown = null;
      for (let sample = 0; sample < samples; sample++) {
        const r = await recorded(() => withReadSnapshotAsync(db, async () => {
          const ctx = workerCtx(db);
          const response = await handleRoster(ctx, new URL("http://local/api/roster?window=10080"));
          return { status: response.status, body: await response.text() };
        }));
        body = r.value.body; top = r.sql.top(10); coldTop ??= r.sql.top(6);
        runs.push({ txn_ms: round(r.ms), status: r.value.status, bytes: body.length, sql_n: r.sql.n, sql_ms: round(r.sql.ms), hash: sha(body) });
      }
      db.close();
      fs.writeFileSync(path.join(goldenDir, "roster_10080.json"), body);
      report.roster = { runs, top_sql_cold: coldTop, top_sql: top };
    }

    /* ---- 4. readRefreshCheck on GET /api/sync with 30 read paths ---- */
    {
      const cursor = windowAnswerMarkSeq(main.sqlite);
      const runs: unknown[] = [];
      let result: unknown = null;
      for (let sample = 0; sample < samples; sample++) {
        const { result: value, ...run } = await refreshOnce(cursor);
        result = value; runs.push(run);
      }
      // GET /api/sync's rows: in place (as before the light lane) and through the lookup lane.
      const inPlace: number[] = [], light: unknown[] = [];
      for (let sample = 0; sample < samples; sample++) { const t = performance.now(); syncReadRows(main, refreshUrl(cursor)); inPlace.push(round(performance.now() - t)); }
      let lightResult: unknown = null;
      for (let sample = 0; sample < samples + 1; sample++) { const { result: value, ...run } = await lightSyncOnce(cursor); lightResult = value; light.push(run); }
      const syncRows = { in_place_ms: inPlace, light, same_result_as_in_place: JSON.stringify(lightResult) === JSON.stringify(result) };
      // Its parts, separately.
      countFs(true);
      let t = performance.now(); dataConfigurationStamp(main, false); const stampMs = performance.now() - t; const stampFs = { ...fsCalls };
      countFs(false);
      t = performance.now(); const latest = latestAccountState(main); const latestMs = performance.now() - t;
      t = performance.now();
      const scopes = readPaths.map(p => storedScopeOf(main, new URL(p, "http://local")));
      const scopeMs = performance.now() - t; t = performance.now();
      for (const p of readPaths) { const u = new URL(p, "http://local"); WINDOW_SCREENS[u.pathname]?.configuration?.(main, u, () => latest); }
      const configMs = performance.now() - t; t = performance.now();
      for (const scope of scopes) if (scope) windowAnswerMarkedSince(main.sqlite, scope, cursor);
      const markMs = performance.now() - t;
      await directRead.close();
      report.read_refresh_check = { paths: readPaths.length, runs, result, sync_rows: syncRows,
        parts: { dataConfigurationStamp_ms: round(stampMs), dataConfigurationStamp_fs_calls: stampFs.n, dataConfigurationStamp_fs_ms: round(stampFs.ms),
          latestAccountState_ms: round(latestMs), storedScopeOf_ms: round(scopeMs), screen_configuration_ms: round(configMs), windowAnswerMarkedSince_ms: round(markMs) } };
      fs.writeFileSync(path.join(goldenDir, "read-refresh-check.json"), JSON.stringify(result));
    }

    /* ---- 5. The same reads while a long read transaction pins the WAL and a writer appends to it ---- */
    const wal: unknown[] = [];
    const walFile = `${RUN_DB}-wal`;
    const walBytes = () => fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
    const triggerTables = new Set((main.sqlite.query("SELECT tbl_name FROM sqlite_master WHERE type='trigger'").all() as Array<{ tbl_name: string }>).map(r => r.tbl_name));
    const touchable = ["codex_price_ledger_aggregates", "codex_price_ledger_events", "limit_windows", "window_usage_sums", "window_answers", "probe_windows"]
      .filter(name => !triggerTables.has(name) && main.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    main.sqlite.exec("CREATE TABLE IF NOT EXISTS measure_wal_filler(id INTEGER PRIMARY KEY, payload BLOB)");
    const pinned = new Database(RUN_DB, { readonly: true });
    opened.unshift(pinned);
    let pinOpen = false;
    const quick = async () => {
      const out: Record<string, number> = {};
      for (const [name, url] of [["accounting_90d", accountingUrl("codex1", 90)], ["accounting_365d", accountingUrl("codex1", 365)]] as const) {
        const db = readOnly(), ctx = workerCtx(db), times: number[] = [];
        for (let s = 0; s < Math.max(2, samples); s++) {
          const t = performance.now();
          await withReadSnapshotAsync(db, async () => { await (await WINDOW_SCREENS[url.pathname]!.produce(ctx, url)).text(); });
          times.push(performance.now() - t);
        }
        out[`${name}_cold_ms`] = round(times[0]!); out[`${name}_warm_ms`] = round(median(times.slice(1)));
        db.close();
      }
      {
        const db = readOnly(), times: number[] = [];
        for (let s = 0; s < Math.max(2, samples); s++) {
          const t = performance.now();
          await withReadSnapshotAsync(db, async () => { await (await handleRoster(workerCtx(db), new URL("http://local/api/roster?window=10080"))).text(); });
          times.push(performance.now() - t);
        }
        out.roster_cold_ms = round(times[0]!); out.roster_warm_ms = round(median(times.slice(1)));
        db.close();
      }
      const dataRead = createDataRead(stubFactory);
      const times: number[] = [];
      for (let s = 0; s < Math.max(2, samples); s++) times.push((await batchOnce(dataRead)).ms);
      await dataRead.close();
      out.batch_ms = round(median(times));
      const cursor = windowAnswerMarkSeq(main.sqlite);
      const url = new URL(`http://local/api/sync?read_paths=${encodeURIComponent(JSON.stringify(readPaths))}&read_cursor=${cursor}`);
      const refresh: number[] = [];
      for (let s = 0; s < Math.max(2, samples); s++) { const t = performance.now(); readRefreshCheck(main, url); refresh.push(performance.now() - t); }
      out.refresh_check_ms = round(median(refresh));
      return out;
    };
    const rand = mulberry32(99);
    for (const target of walTargets) {
      if (target > 0 && !pinOpen) {
        pinned.exec("BEGIN");
        pinned.query("SELECT COUNT(*) n FROM codex_price_ledger_aggregates").get();
        pinOpen = true;
      }
      const t = performance.now();
      let commits = 0;
      const blob = new Uint8Array(4096);
      while (walBytes() < target * 1024 * 1024) {
        main.sqlite.transaction(() => {
          for (let i = 0; i < 256; i++) { for (let j = 0; j < blob.length; j += 64) blob[j] = Math.floor(rand() * 256); main.sqlite.query("INSERT INTO measure_wal_filler(payload) VALUES (?)").run(blob); }
          // Rewritten pages of the tables the screens read: a reader then finds them in the WAL.
          for (const table of [...touchable]) try {
            main.sqlite.query(`UPDATE "${table}" SET rowid=rowid WHERE rowid IN (SELECT rowid FROM "${table}" ORDER BY random() LIMIT 64)`).run();
          } catch { touchable.splice(touchable.indexOf(table), 1); }
        }).immediate();
        commits++;
      }
      const fill = performance.now() - t;
      const times = await quick();
      wal.push({ target_mb: target, wal_mb: Math.round(walBytes() / 1048576), pinned: pinOpen, commits, fill_ms: Math.round(fill), ...times });
      console.log(`[measure] WAL ${Math.round(walBytes() / 1048576)} MB:`, JSON.stringify(times));
    }
    if (pinOpen) pinned.exec("COMMIT");
    pinned.close();
    report.wal_pinning = { touched_tables: touchable, runs: wal };
    report.long_transaction_warnings = warnings;
    main.sqlite.close();
  } catch (error) {
    console.error("[measure] failed:", error);
    process.exitCode = 1;
  } finally {
    for (const db of opened) try { db.close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) try { fs.rmSync(RUN_DB + suffix, { force: true }); } catch (error) { console.error(String(error)); }
  }
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`[measure] results: ${out}\n[measure] golden bodies: ${goldenDir}`);
}

/* ---------- compare: whole bodies of a run against a golden run ---------- */
function compare(label: string, golden: string) {
  const left = namedPath(P.golden, golden, "golden"), right = namedPath(P.golden, label, "label");
  const firstDifference = (a: unknown, b: unknown, at = ""): string | null => {
    if (Object.is(a, b)) return null;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return at || "/";
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return `${at}/length`;
    for (const key of keys) { const d = firstDifference((a as any)[key], (b as any)[key], `${at}/${key}`); if (d) return d; }
    return null;
  };
  let failed = 0;
  for (const name of fs.readdirSync(left).sort()) {
    const a = fs.readFileSync(path.join(left, name), "utf8"), file = path.join(right, name);
    if (!fs.existsSync(file)) { console.log(`MISSING ${name}`); failed++; continue; }
    const b = fs.readFileSync(file, "utf8");
    if (a === b) { console.log(`IDENTICAL ${name}`); continue; }
    // The batch envelope and the refresh result carry instants of the run; their stored bodies are compared whole.
    const d = firstDifference(JSON.parse(a), JSON.parse(b));
    console.log(d ? `DIFFERENT ${name} at ${d}` : `EQUAL-JSON ${name}`); if (d) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

if (command === "build") {
  await build({ accounts: Number(args.get("accounts") ?? 2), days: Number(args.get("days") ?? 420), calls: Number(args.get("calls") ?? 450),
    probeMinutes: Number(args.get("probe-minutes") ?? 20), seed: Number(args.get("seed") ?? 7), ratelimitEvery: Number(args.get("ratelimit-every") ?? 10),
    projects: Number(args.get("projects") ?? PROJECTS.length), homes: Number(args.get("homes") ?? 0),
    // Rollout files per account and day: from `sessions` to 2*sessions+2 (3..8 by default).
    sessions: Number(args.get("sessions") ?? 3) });
} else if (command === "measure") {
  await measure(args.get("label") ?? "before", Number(args.get("samples") ?? 3), (args.get("wal-mb") ?? "0,256,768").split(",").map(Number));
} else if (command === "compare") {
  compare(args.get("label") ?? "after", args.get("golden") ?? "before");
} else {
  console.error("Usage: build | measure | compare (see the header)");
  process.exitCode = 2;
}
// Data-read timers of stub workers would keep the process alive for their 600 s timeout.
process.exit(process.exitCode ?? 0);
