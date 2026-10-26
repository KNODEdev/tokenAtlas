/**
 * U1.1 acceptance, part 2: incremental limit windows = full segmentation after each kind of change, on a copy.
 *
 * Writers are the application's own: probe readings are published by the probe projection
 * (publishCurrentBatch), periods by the period store (replaceDeclaredPeriods); a transcript reading is
 * inserted together with the dirty mark the sync publication writes (markLimitWindowFilesDirty), because
 * running the sync here would need a stage database. Manual measurements and cadence configuration enter
 * through the producer's seams (Codex manual measurements cannot be written today).
 *
 * After each change: the projection settles, the maintenance producer settles (timed, with read counters),
 * and the table is compared with computeLimitWindowsFull for every account and counter.
 *
 *   bun scripts/acceptance/limit-windows-scenarios.ts --db <copy> --config <dir> --archive <dir> --out <file>
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

const { values: args } = parseArgs({ options: {
  db: { type: "string" }, config: { type: "string" }, archive: { type: "string" }, out: { type: "string" },
  only: { type: "string" }, verify: { type: "boolean", default: true },
} });
for (const key of ["db", "config", "archive", "out"] as const) if (!args[key]) throw new Error(`Required --${key}`);
const dbPath = path.resolve(args.db!);
Object.assign(process.env, { TOKENATLAS_DB: dbPath, TOKENATLAS_CONFIG: path.resolve(args.config!),
  TOKENATLAS_ARCHIVE: path.resolve(args.archive!), TOKENATLAS_FROZEN_CONFIG: "1" });
const powerPlan = (() => { try { return execFileSync("powercfg", ["/getactivescheme"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const { Database } = await import("../../src/db/sqlite");
const locations = await import("../../src/config/paths");
const { readAccountsV2 } = await import("../../src/config/accounts-document");
const { currentRegistry } = await import("../../src/server/current/registry");
const { publishCurrentBatch } = await import("../../src/server/current/store");
const { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } = await import("../../src/db/period-store");
const { markLimitWindowFilesDirty, readLimitWindows } = await import("../../src/db/limit-windows");
const { loadCycles } = await import("../../src/server/cycles");
const { readManualCapacity } = await import("../../src/server/manual-capacity");
const producer = await import("../../src/server/limit-window-producer");
const { acceptProbeFact, createProbeCollection, mapProbeLegacy } = await import("../../src/db/probe-facts");
type Measurement = import("../../src/shared/manual-capacity").ManualCapacityMeasurement;
type Cycles = import("../../src/server/cycles").CyclesConfig;

const accounts = readAccountsV2(locations.configFile("accounts.json"));
accounts.sources = accounts.sources.map(s => ({ ...s, home: locations.expandPath(s.home),
  ...(s.source_home ? { source_home: locations.expandPath(s.source_home) } : {}) }));
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL");
let cycles: Cycles = loadCycles();
const manual = new Map<string, Measurement[]>();
const measurements = (provider: string): Measurement[] => {
  if (manual.has(provider)) return manual.get(provider)!;
  try { return readManualCapacity(provider).measurements; } catch { return []; }
};
const options = () => ({ sources: accounts.sources, subscriptions: accounts.subscriptions, cycles, manualCapacity: measurements, budgetMs: 1000 });
const config = { subscriptions: accounts.subscriptions, sources: accounts.sources };
const physical = { archiveRoot: locations.ARCHIVE_LOGICAL_ROOT, defaultLogin: locations.LOGIN };

function project(): { ms: number; batches: number } {
  const started = performance.now();
  let batches = 0;
  while (publishCurrentBatch(db, currentRegistry(accounts.subscriptions), undefined, 1000, config, physical)) batches++;
  return { ms: Math.round(performance.now() - started), batches };
}
function settle() {
  const stats = producer.emptyLimitWindowStats();
  const started = performance.now();
  let turns = 0;
  for (;;) {
    turns++;
    const result = producer.advanceLimitWindows(db, { ...options(), stats });
    if (!result.pending) break;
    if (!result.progressed) throw new Error("producer blocked (probe index preparing?)");
  }
  return { ms: Math.round(performance.now() - started), turns, stats: { ...stats, slowestStep: { ...stats.slowestStep, ms: Math.round(stats.slowestStep.ms) },
    slowestWriteMs: Math.round(stats.slowestWriteMs) } };
}
function verify(): { registers: number; windows: number; mismatches: unknown[]; ms: number } {
  const started = performance.now();
  const full = producer.computeLimitWindowsFull(db, options());
  const mismatches: unknown[] = [];
  let windows = 0;
  for (const [key, expected] of full) {
    const [provider, account, counter] = JSON.parse(key) as [string, string, string];
    const actual = readLimitWindows(db, provider, account, counter);
    windows += expected.length;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const first = expected.findIndex((window, index) => JSON.stringify(window) !== JSON.stringify(actual[index]));
      mismatches.push({ key, expected: expected.length, actual: actual.length, first, expectedWindow: expected[first], actualWindow: actual[first] });
    }
  }
  for (const row of db.query("SELECT DISTINCT provider, account, counter FROM limit_windows").all() as Array<{ provider: string; account: string; counter: string }>)
    if (!full.has(JSON.stringify([row.provider, row.account, row.counter]))) mismatches.push({ extra: [row.provider, row.account, row.counter] });
  return { registers: full.size, windows, mismatches, ms: Math.round(performance.now() - started) };
}
const totals = () => ({
  probeRows: (db.query("SELECT count(*) n FROM probe_windows").get() as { n: number }).n,
  sessionRows: (db.query("SELECT count(*) n FROM ratelimit").get() as { n: number }).n,
  inputRows: (db.query("SELECT count(*) n FROM limit_window_inputs").get() as { n: number }).n,
});

const results: Array<Record<string, unknown>> = [];
const output = () => fs.writeFileSync(args.out!, JSON.stringify({ header: {
  schema: "limit-windows-scenarios/v1", entry: "advanceLimitWindows after the application's writers (see file header)",
  mode: "write to copy", db: dbPath, config: process.env.TOKENATLAS_CONFIG, archive: process.env.TOKENATLAS_ARCHIVE, powerPlan,
  sample: "every account and counter (verification); changes listed per scenario",
  exclusions: ["sync coordinator (dirty mark written as it does)", "HTTP", "window sums (U1.2)", "live database"],
  totals: totals() }, results }, null, 1));

async function scenario(name: string, change: () => Record<string, unknown> | void) {
  if (args.only && !args.only.split(",").includes(name)) return;
  console.error(`SCENARIO ${name}`);
  const detail = change() ?? {};
  const projection = project();
  const update = settle();
  const check = args.verify ? verify() : null;
  results.push({ name, detail, projection, update, verification: check && { ...check, mismatches: check.mismatches.length,
    firstMismatches: check.mismatches.slice(0, 2) } });
  output();
  console.error(JSON.stringify({ name, update: { ms: update.ms, stats: update.stats }, mismatches: check?.mismatches.length }));
}

type Row = Record<string, string | number | null>;
const insertRow = (table: string, row: Row) => {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(c => row[c] ?? null));
};
const shift = (ts: string, ms: number) => new Date(Date.parse(ts) + ms).toISOString();
/**
 * A probe reading written as persistProbeWindows writes it (projection row, canonical fact, legacy link),
 * copied from an existing reading of the same profile, without the archive journal file.
 */
function insertProbe(source: Row, changes: Row): string {
  const linked = db.query(`SELECT c.payload FROM probe_fact_legacy_map m JOIN probe_counters c ON c.id=m.counter_id
    WHERE m.legacy_id=? LIMIT 1`).get(source.id ?? null) as { payload: string } | null;
  if (!linked) throw new Error(`Probe ${source.id} has no canonical fact`);
  const payload = { ...JSON.parse(linked.payload) as Row, ...changes };
  const fact = createProbeCollection([payload])[0]!;
  const fields = ["provider", "subject", "ts", "plan", "kind", "limit_group", "scope", "reported_percent_side", "used_percent",
    "remaining_percent", "vendor_percent", "window_minutes", "allowance", "used", "remaining", "resets_at", "rate_limit_reached",
    "reset_credits", "profile", "ok", "error", "extra", "machine"];
  db.transaction(() => {
    acceptProbeFact(db, fact);
    const row = db.query(`INSERT INTO probe_windows(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) RETURNING id`)
      .get(...fields.map(field => (field in payload ? payload[field] : source[field]) ?? null)) as { id: number };
    mapProbeLegacy(db, fact, row.id, "local-collection");
  }).immediate();
  return String(payload.ts);
}

// Baseline: the table must already be filled and equal to the full result.
await scenario("baseline", () => ({ note: "no change; projection and producer idle" }));

await scenario("appended-readings", () => {
  const codex = db.query(`SELECT * FROM probe_windows WHERE provider='codex' AND limit_group='codex' AND window_minutes=10080
    AND used_percent IS NOT NULL ORDER BY ts DESC LIMIT 1`).get() as Row;
  const claude = db.query(`SELECT * FROM probe_windows WHERE provider='claude' AND kind='weekly_all' AND used_percent IS NOT NULL
    ORDER BY ts DESC LIMIT 1`).get() as Row;
  const session = db.query("SELECT * FROM ratelimit WHERE limit_id='codex' AND window_minutes=10080 ORDER BY ts DESC LIMIT 1").get() as Row;
  db.transaction(() => {
    for (const row of [codex, claude]) { const { id: _id, ...rest } = row;
      insertRow("probe_windows", { ...rest, ts: shift(String(row.ts), 300_000), used_percent: Math.min(100, Number(row.used_percent) + 1) }); }
    insertRow("ratelimit", { ...session, ts: shift(String(session.ts), 60_000), used_percent: Math.min(100, Number(session.used_percent) + 1) });
    markLimitWindowFilesDirty(db, [{ home: String(session.home), path: String(session.path) }]);
  }).immediate();
  return { codexProbe: codex.ts, claudeProbe: claude.ts, session: [session.home, session.path, session.ts] };
});

await scenario("appended-probes", () => {
  // The newest periodic readings of Codex and Claude, written as the probe writer writes them.
  const latest = (provider: string, kind: string) => db.query(`SELECT * FROM probe_windows WHERE provider=? AND kind=?
    AND used_percent IS NOT NULL AND id IN (SELECT legacy_id FROM probe_fact_legacy_map) AND EXISTS (SELECT 1 FROM probe_sources s WHERE s.probe_id=probe_windows.id
    AND s.basis IN ('projection','matched') AND s.machine IS NOT NULL) ORDER BY ts DESC LIMIT 1`).get(provider, kind) as Row;
  const codex = latest("codex", "secondary"), claude = latest("claude", "weekly_all");
  return { codex: insertProbe(codex, { ts: shift(String(codex.ts), 240_000), used_percent: Math.min(100, Number(codex.used_percent) + 1) }),
    claude: insertProbe(claude, { ts: shift(String(claude.ts), 240_000), used_percent: Math.min(100, Number(claude.used_percent) + 1) }) };
});

await scenario("late-probe-second-machine", () => {
  // A Claude laptop reading of nine days ago that arrives late.
  const old = db.query(`SELECT * FROM probe_windows WHERE provider='claude' AND kind='weekly_all' AND used_percent IS NOT NULL
    AND lower(machine) LIKE '%laptop%' AND ts < ? AND id IN (SELECT legacy_id FROM probe_fact_legacy_map) AND EXISTS (SELECT 1 FROM probe_sources s WHERE s.probe_id=probe_windows.id
    AND s.basis IN ('projection','matched') AND s.machine IS NOT NULL) ORDER BY ts DESC LIMIT 1`)
    .get(shift("2026-10-04T13:00:00.000Z", -9 * 86_400_000)) as Row;
  return { claude: insertProbe(old, { ts: shift(String(old.ts), 13_000) }) };
});

await scenario("late-second-machine", () => {
  // A transcript reading from the laptop, ten days old, arriving now; and a Claude laptop reading of last week.
  const laptop = db.query(`SELECT * FROM ratelimit WHERE limit_id='codex' AND window_minutes=10080 AND lower(home) LIKE '%laptop%'
    AND ts < ? ORDER BY ts DESC LIMIT 1`).get(shift(new Date().toISOString(), -10 * 86_400_000)) as Row | null;
  const source = laptop ?? db.query(`SELECT * FROM ratelimit WHERE limit_id='codex' AND window_minutes=10080 ORDER BY ts DESC LIMIT 1 OFFSET 2000`).get() as Row;
  const claude = db.query(`SELECT * FROM probe_windows WHERE provider='claude' AND kind='weekly_all' AND used_percent IS NOT NULL
    AND lower(machine) LIKE '%laptop%' ORDER BY ts DESC LIMIT 1 OFFSET 300`).get() as Row | null;
  db.transaction(() => {
    insertRow("ratelimit", { ...source, ts: shift(String(source.ts), 7_000), path: `${String(source.path)}.late` });
    markLimitWindowFilesDirty(db, [{ home: String(source.home), path: `${String(source.path)}.late` }]);
    if (claude) { const { id: _id, ...rest } = claude; insertRow("probe_windows", { ...rest, ts: shift(String(claude.ts), 9_000) }); }
  }).immediate();
  return { session: [source.home, source.ts], claudeProbe: claude?.ts ?? null };
});

await scenario("account-period", () => {
  // The owner of one Codex source changes for three days in July (a correction of the kind §3.3 asks for).
  const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(p => p.origin === "declared");
  const target = periods.find(p => p.provider === "codex" && p.value === "codex1"
    && Date.parse(p.from) < Date.parse("2026-07-17T00:00:00Z") && (!p.until || Date.parse(p.until) > Date.parse("2026-07-20T00:00:00Z")));
  if (!target) throw new Error("No declared codex1 period spans July 17–20");
  const next = [...periods.filter(p => p !== target),
    { ...target, until: "2026-07-17T00:00:00.000Z" },
    { ...target, from: "2026-07-17T00:00:00.000Z", until: "2026-07-20T00:00:00.000Z", value: "codex2" },
    { ...target, from: "2026-07-20T00:00:00.000Z" }];
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, next);
  return { source: target.subject, changed: ["2026-07-17", "2026-07-20", "codex1 → codex2"] };
});

await scenario("plan-period", () => {
  const plans = loadPeriods(db, PLAN_PERIODS).filter(p => p.origin === "declared");
  replaceDeclaredPeriods(db, PLAN_PERIODS, [...plans, { provider: "codex", subject: "codex1", from: "2026-08-01T00:00:00.000Z",
    until: "2026-09-01T00:00:00.000Z", value: "pro", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "u1.1-scenario" }]);
  return { added: "codex1 pro 2026-08-01 → 2026-09-01" };
});

const claudeMain = (db.query("SELECT account FROM limit_window_state WHERE provider='claude' AND account<>'' ORDER BY account DESC LIMIT 1").get() as { account: string }).account;
const weekly = readLimitWindows(db, "claude", claudeMain, '["weekly_all","weekly",10080]');
const target = weekly.at(-3)!;
await scenario("manual-added", () => {
  const added: Measurement = { id: "u11-scenario", account: claudeMain, counter: '["weekly_all","weekly",10080]',
    start: shift(target.start, 3_600_000), end: shift(target.start, 2 * 86_400_000), start_percent: 1, end_percent: 30,
    approximate_time: false, note: "U1.1 scenario", updated_at: new Date().toISOString() };
  manual.set("claude", [...measurements("claude"), added]);
  return { account: claudeMain, window: target.id, measurement: added.id };
});
await scenario("manual-removed", () => {
  manual.set("claude", measurements("claude").filter(m => m.id !== "u11-scenario"));
  return { removed: "u11-scenario" };
});

await scenario("cycles", () => {
  // A declared cadence for the main Claude account's weekly counter changes its period.
  cycles = { ...cycles, windows: [...(cycles.windows ?? []), { subscription: claudeMain, kind: "weekly_all", period_hours: 167,
    anchor_ts: null } as never] };
  return { account: claudeMain, declared: "weekly_all period_hours 167" };
});
output();
console.error(`written ${args.out}`);
