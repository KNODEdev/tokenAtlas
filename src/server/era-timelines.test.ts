import { describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import path from "path";
import { applyDrizzleMigrations } from "../db/migrate";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { recordObservedReading } from "./observed-reading-fixture";
import { buildEraIndex, eraCovers, validateEras, type EraDeclaration } from "./eras";
import { buildEraTimelines, dayInEra, handleEraTimelines, type AppContext } from "./api";
import { periodEras } from "./api";
import { archiveFolderOf } from "./event-source";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { subscriptionDailyUsage } from "./subscription-usage";
import { prepareProbeReaderFixture, type ProbeReaderFixtureSource } from "./probe-reader.fixture";
import type { RateCard } from "./pricing";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");
const HOME = "C:/Users/x/.claude";
const ARCHIVE = ARCHIVE_LOGICAL_ROOT.replace(/\\/g, "/");
/** The archive folder a Claude profile's sessions are kept in: the source an account period names. */
const folder = (name: string) => `${ARCHIVE_LOGICAL_ROOT}/claude/${name}`;
const ARCHIVED = folder("pc-x");

/** One subscription, two eras: it moved from one Konto vendora to another. */
const HANDOVER: EraDeclaration[] = [
  { id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME, account: "shared@example.com", until: "2026-03-01" },
  { id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME, account: "shared@example.com", from: "2026-03-01" },
];

/** Two subscriptions living in parallel on one Konto vendora. */
const PARALLEL: EraDeclaration[] = [
  { id: "claude1", vendor: "claude", home: folder("a"), source_home: "C:/a", account: "shared@example.com" },
  { id: "claude2", vendor: "claude", home: folder("b"), source_home: "C:/b", account: "shared@example.com" },
];

function migratedDb(): Database {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
  return sqlite;
}

function prepareTimelineProbeReader(sqlite: Database, subscriptions: EraDeclaration[]): void {
  const probes = sqlite.query("SELECT id, provider, subject, ts, machine, extra FROM probe_windows").all() as Array<{
    id: number; provider: string; subject: string; ts: string; machine: string | null; extra: string | null;
  }>;
  const sources = new Map<string, ProbeReaderFixtureSource>();
  for (const row of probes) {
    let home: string | null = null;
    try {
      const extra = row.extra ? JSON.parse(row.extra) as { home?: unknown } : null;
      home = typeof extra?.home === "string" ? extra.home : null;
    } catch { /* An invalid home is not source evidence. */ }
    if (!home) continue;
    for (const declaration of subscriptions) {
      if ((declaration.vendor ?? "codex").toLowerCase() !== row.provider.toLowerCase()
        || declaration.source_home?.toLowerCase().replace(/\\/g, "/") !== home.toLowerCase().replace(/\\/g, "/")
        || !declaration.home?.toLowerCase().replace(/\\/g, "/").startsWith(`${ARCHIVE.toLowerCase()}/`)) continue;
      const login = /^\w:\/users\/([^/]+)\//i.exec(home.replace(/\\/g, "/"))?.[1] ?? LOGIN;
      const machine = row.machine ?? `FIXTURE-${row.provider}-${declaration.id}`;
      const source: ProbeReaderFixtureSource = { id: declaration.id, vendor: row.provider, machine, login,
        home: declaration.home, source_home: home };
      sources.set(JSON.stringify([source.vendor, source.id, source.machine, source.home, source.source_home]), source);
    }
  }
  const periods = loadPeriods(sqlite, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  prepareProbeReaderFixture(sqlite, [...sources.values()], row => {
    const physical = probes.find(probe => probe.id === row.id);
    if (!physical) return null;
    let sourceHome: string | null = null;
    try {
      const extra = physical.extra ? JSON.parse(physical.extra) as { home?: unknown } : null;
      sourceHome = typeof extra?.home === "string" ? extra.home : null;
    } catch { /* Invalid source evidence has no account period. */ }
    if (!sourceHome) return null;
    const declaration = subscriptions.find(candidate => (candidate.vendor ?? "codex").toLowerCase() === physical.provider.toLowerCase()
      && candidate.source_home?.toLowerCase().replace(/\\/g, "/") === sourceHome!.toLowerCase().replace(/\\/g, "/"));
    const source = declaration?.home ? archiveFolderOf(declaration.home, ARCHIVE_LOGICAL_ROOT)?.key : null;
    const at = Date.parse(physical.ts);
    if (!source || !Number.isFinite(at)) return null;
    const owner = periods.find(period => period.provider.toLowerCase() === physical.provider.toLowerCase()
      && period.subject.toLowerCase() === source.toLowerCase() && Date.parse(period.from) <= at
      && (period.until === null || at < Date.parse(period.until)));
    return owner?.value ?? null;
  });
}

/** The context of a read; the shared price register is prepared first, as the maintenance worker does. */
function stubCtx(sqlite: Database, subscriptions: EraDeclaration[]): AppContext {
  const rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as RateCard;
  const homeToSubId = indexSubscriptionHomes(subscriptions.filter((s) => eraCovers(s, new Date().toISOString())));
  const sources = [...new Map(subscriptions.filter(row => row.home).map(row => [
    `${row.vendor}|${row.home}`, { vendor: row.vendor ?? "codex", home: row.home!,
      ...(row.machine ? { machine: row.machine } : {}), ...(row.source_home ? { source_home: row.source_home } : {}) },
  ])).values()];
  const identities = [...new Map(subscriptions.map(row => [row.id, { id: row.id, vendor: row.vendor ?? "codex",
    ...(row.account ? { account: row.account } : {}) }])).values()];
  const periods = subscriptions.flatMap(row => {
    const source = archiveFolderOf(row.home, ARCHIVE_LOGICAL_ROOT)?.key;
    return source ? [{ provider: row.vendor ?? "codex", subject: source, from: row.from ?? "2000-01-01",
      until: row.until ?? null, value: row.id, origin: "declared" as const, firstSeen: null, lastSeen: null,
      readings: 0, evidence: "fixture" }] : [];
  });
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, periods);
  prepareTimelineProbeReader(sqlite, subscriptions);
  prepareUsageRegisters(sqlite, rateCards, subscriptions, homeToSubId);
  const accounts = { version: 2 as const, subscriptions: identities, sources };
  return {
    sqlite,
    accounts,
    homeToSubId,
    eras: buildEraIndex(periodEras(sqlite, accounts), "instant"),
    eraErrors: [],
    claudeGauge: {},
    grokGauge: {},
    rateCards,
  } as unknown as AppContext;
}

let call = 0;
/** A session without its own identity in `archive`, which a declared account period gives to `account`. */
function claudeCall(
  sqlite: Database,
  account: string,
  ts: string,
  tokens: number,
  archive = ARCHIVED
): void {
  sqlite
    .query(
      `INSERT INTO claude_events (store, call_id, ts, model, path, in_uncached, out_total)
       VALUES ('live', ?, ?, 'sonnet', ?, ?, 0)`
    )
    .run(`call-${call++}`, ts, `${archive}/a.jsonl`, tokens);
  const source = archive.slice(ARCHIVE_LOGICAL_ROOT.length + 1).toLowerCase();
  const declared = loadPeriods(sqlite, ACCOUNT_PERIODS).filter((p) => p.origin === "declared");
  if (declared.some((p) => p.subject === source)) return;
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [...declared, { provider: "claude", subject: source, from: "2000-01-01",
    until: null, value: account, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
}

function geminiCall(sqlite: Database, store: string, ts: string, tokens: number, profile = "profile-old"): void {
  const generation = call++;
  sqlite
    .query(
      `INSERT INTO gemini_events
         (store, conversation_id, gen_idx, ts, ts_basis, path, fresh_in, cached_in, out_total, usd)
       VALUES (?, ?, ?, ?, 'event', ?, ?, 0, 0, 0)`
    )
    .run(store, `conversation-${generation}`, generation, ts,
      `${ARCHIVE_LOGICAL_ROOT}/gemini/${profile}/conversations/${generation}.json`, tokens);
}

function weeklyProbe(sqlite: Database, subject: string, ts: string, resetsAt: string): void {
  sqlite
    .query(
      `INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, window_minutes, resets_at, extra)
       VALUES ('claude', ?, ?, 'weekly', 'used', 10080, ?, ?)`
    )
    .run(subject, ts, resetsAt, JSON.stringify({ home: HOME }));
}

describe("dayInEra", () => {
  it("keeps the era convention: from inclusive, until exclusive", () => {
    expect(dayInEra("2026-03-01", "2026-03-01", null)).toBe(true);
    expect(dayInEra("2026-03-01", null, "2026-03-01")).toBe(false);
    expect(dayInEra("2026-02-28", null, "2026-03-01")).toBe(true);
  });
});

it("resolves an intraday account handover at the exact period instant", () => {
  const sqlite = migratedDb();
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [
    { provider:"claude", subject:"claude/pc-x", from:"2026-03-01T00:00:00.000Z", until:"2026-03-01T12:00:00.000Z",
      value:"claude1", origin:"declared", firstSeen:null, lastSeen:null, readings:0, evidence:"fixture" },
    { provider:"claude", subject:"claude/pc-x", from:"2026-03-01T12:00:00.000Z", until:null,
      value:"claude2", origin:"declared", firstSeen:null, lastSeen:null, readings:0, evidence:"fixture" },
  ]);
  const accounts = {version:2 as const, subscriptions:[{id:"claude1",vendor:"claude"},{id:"claude2",vendor:"claude"}],
    sources:[{vendor:"claude",home:ARCHIVED,source_home:HOME}]};
  const index = buildEraIndex(periodEras(sqlite, accounts),"instant");
  expect(index.resolve("claude",ARCHIVED,"2026-03-01T11:59:59.999Z")).toBe("claude1");
  expect(index.resolve("claude",ARCHIVED,"2026-03-01T12:00:00.000Z")).toBe("claude2");
  sqlite.close();
});

describe("buildEraTimelines", () => {
  it("splits one subscription's usage between its own eras, summing nothing across them", () => {
    const sqlite = migratedDb();
    claudeCall(sqlite, "claude1", "2026-02-10T10:00:00Z", 100);
    claudeCall(sqlite, "claude1", "2026-02-11T10:00:00Z", 200);
    claudeCall(sqlite, "claude1", "2026-04-10T10:00:00Z", 700);
    weeklyProbe(sqlite, "claude1", "2026-02-10T10:00:00Z", "2026-02-15T00:00:00Z");
    weeklyProbe(sqlite, "claude1", "2026-02-11T10:00:00Z", "2026-02-15T00:00:00Z");
    weeklyProbe(sqlite, "claude1", "2026-04-10T10:00:00Z", "2026-04-15T00:00:00Z");
    const payload = buildEraTimelines(stubCtx(sqlite, HANDOVER));
    const [first, second] = payload.subscriptions[0]!.segments;
    expect(first!.from).toBe("2000-01-01");
    expect(first!.until).toBe("2026-03-01");
    expect(first!.stats).toMatchObject({ tokens: 300, calls: 2, cycles: 1 });
    expect(second!.from).toBe("2026-03-01");
    expect(second!.stats).toMatchObject({ tokens: 700, calls: 1, cycles: 1 });
  });

  it("scopes same-subscription segments to their own homes instead of repeating the total", () => {
    const sqlite = migratedDb();
    const homeA = folder("vendor-a");
    const homeB = folder("vendor-b");
    const declarations: EraDeclaration[] = [
      { id: "claude1", vendor: "claude", home: homeA, source_home: "C:/vendor/a", account: "same@example.com" },
      { id: "claude1", vendor: "claude", home: homeB, source_home: "C:/vendor/b", account: "same@example.com" },
    ];
    claudeCall(sqlite, "claude1", "2026-04-10T10:00:00Z", 100, homeA);
    claudeCall(sqlite, "claude1", "2026-04-10T11:00:00Z", 900, homeB);

    const payload = buildEraTimelines(stubCtx(sqlite, declarations));
    const segments = payload.subscriptions[0]!.segments;
    expect(segments.map((segment) => segment.stats.tokens)).toEqual([100, 900]);
    expect(payload.vendor_accounts[0]!.lanes[0]!.segments.map(segment => segment.stats.tokens)).toEqual([100, 900]);
  });

  it("keeps store-keyed Gemini segments scoped by store id and split by era dates", async () => {
    const sqlite = migratedDb();
    const store = "gemini-main";
    const declarations: EraDeclaration[] = [
      {
        id: store,
        vendor: "gemini",
        home: `${ARCHIVE_LOGICAL_ROOT}/gemini/profile-old`,
        account: "shared@example.com",
        until: "2026-03-01",
      },
      {
        id: store,
        vendor: "gemini",
        home: `${ARCHIVE_LOGICAL_ROOT}/gemini/profile-new`,
        account: "shared@example.com",
        from: "2026-03-01",
      },
    ];
    geminiCall(sqlite, store, "2026-02-10T10:00:00Z", 100);
    geminiCall(sqlite, store, "2026-04-10T10:00:00Z", 900, "profile-new");

    const response = handleEraTimelines(stubCtx(sqlite, declarations));
    const payload = (await response.json()) as {
      subscriptions: Array<{ segments: Array<{ stats: { tokens: number; calls: number } }> }>;
    };
    expect(payload.subscriptions[0]!.segments.map((segment) => segment.stats)).toEqual([
      expect.objectContaining({ tokens: 100, calls: 1 }),
      expect.objectContaining({ tokens: 900, calls: 1 }),
    ]);
  });

  it("serializes missing rate coverage as absence with a visible reason, never zero dollars", () => {
    const sqlite = migratedDb();
    claudeCall(sqlite, "claude1", "2026-02-10T10:00:00Z", 100);
    const stats = buildEraTimelines(stubCtx(sqlite, HANDOVER)).subscriptions[0]!.segments[0]!.stats;
    expect(stats.usd).toBeNull();
    expect(stats.unpriced_calls).toBe(1);
    expect(stats.unpriced_tokens).toBe(100);
    expect(stats.usd_reason).toBe("missing-rate-card");
  });

  it("keeps physically proven readings when the stored subject is stale", () => {
    const sqlite = migratedDb();
    weeklyProbe(sqlite, "old-stamped-account", "2026-02-10T10:00:00Z", "2026-02-15T00:00:00Z");
    const original = sqlite.query("SELECT subject, extra FROM probe_windows").get();
    const payload = buildEraTimelines(stubCtx(sqlite, HANDOVER));
    expect(payload.subscriptions[0]!.segments[0]!.stats.cycles).toBe(1);
    expect(sqlite.query("SELECT subject, extra FROM probe_windows").get()).toEqual(original);
  });

  it("keeps subscription metadata across all its dated source periods", () => {
    const payload = buildEraTimelines(stubCtx(migratedDb(), HANDOVER));
    const segments = payload.subscriptions[0]!.segments;
    expect(segments.map((s) => s.vendor_account)).toEqual(["shared@example.com", "shared@example.com"]);
    expect(segments.every((s) => s.vendor_account_source === "declared")).toBe(true);
  });

  it("groups both periods under the one declared Konto vendora", () => {
    const payload = buildEraTimelines(stubCtx(migratedDb(), HANDOVER));
    expect(payload.vendor_accounts.map((a) => a.key)).toEqual(["shared@example.com"]);
    for (const account of payload.vendor_accounts) {
      expect(account.lanes).toHaveLength(1);
      expect(account.lanes[0]!.segments).toHaveLength(2);
    }
  });

  it("keeps two subscriptions on one Konto vendora as two lanes, never merged", () => {
    const payload = buildEraTimelines(stubCtx(migratedDb(), PARALLEL));
    expect(payload.vendor_accounts).toHaveLength(1);
    const account = payload.vendor_accounts[0]!;
    expect(account.key).toBe("shared@example.com");
    expect(account.lanes.map((l) => l.subscription_id)).toEqual(["claude1", "claude2"]);
  });

  it("falls back to the observed identity when an era declares no Konto vendora", () => {
    const sqlite = migratedDb();
    const undeclared: EraDeclaration[] = [{ id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME }];
    recordObservedReading(sqlite, undeclared, {
      provider: "claude", account: "claude1", email: "seen@example.com", ts: "2026-04-01T09:00:00Z", home: HOME, login: LOGIN,
    });
    const payload = buildEraTimelines(stubCtx(sqlite, undeclared));
    const segment = payload.subscriptions[0]!.segments[0]!;
    expect(segment.vendor_account).toBe("seen@example.com");
    expect(segment.vendor_account_source).toBe("observed");
    expect(payload.vendor_accounts[0]!.source).toBe("observed");
  });

  it("marks a subscription inactive once every one of its eras is closed", () => {
    const closed: EraDeclaration[] = [
      { id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME, account: "old@example.com", until: "2026-03-01" },
    ];
    const payload = buildEraTimelines(stubCtx(migratedDb(), closed));
    expect(payload.subscriptions[0]!.active).toBe(false);
  });

  it("serialises to JSON unchanged, so the client sees exactly this shape", () => {
    const payload = buildEraTimelines(stubCtx(migratedDb(), HANDOVER));
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});


it("keeps exact intraday account segments, probes and correction without repricing", () => {
  const sqlite = migratedDb();
  const declarations: EraDeclaration[] = [
    { id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME, machine: "PC-X", from: "2026-03-01", until: "2026-03-01T12:00:00.000Z" },
    { id: "claude2", vendor: "claude", home: ARCHIVED, source_home: HOME, machine: "PC-X", from: "2026-03-01T12:00:00.000Z", until: "2026-03-01T18:00:00.000Z" },
    { id: "claude1", vendor: "claude", home: ARCHIVED, source_home: HOME, machine: "PC-X", from: "2026-03-01T18:00:00.000Z", until: "2026-03-02" },
  ];
  try {
    for (const [ts, account, tokens, reset] of [
      ["2026-03-01T11:59:59.999Z", "claude1", 100, "2026-03-08T00:00:00Z"],
      ["2026-03-01T12:00:00Z", "claude2", 200, "2026-03-09T00:00:00Z"],
      ["2026-03-01T17:00:00Z", "claude2", 300, "2026-03-09T00:00:00Z"],
      ["2026-03-01T18:00:00Z", "claude1", 400, "2026-03-10T00:00:00Z"],
      ["2026-03-01T20:00:00Z", "claude1", 500, "2026-03-10T00:00:00Z"],
    ] as const) {
      claudeCall(sqlite, account, ts, tokens);
      weeklyProbe(sqlite, account, ts, reset);
    }
    claudeCall(sqlite, "claude1", "2025-03-01T10:00:00Z", 700);
    claudeCall(sqlite, "claude1", "2027-03-01T10:00:00Z", 800);
    sqlite.exec("UPDATE probe_windows SET machine='PC-X'");
    const ctx = stubCtx(sqlite, declarations);
    // The ledger's stored valuations: reads and period corrections must never reprice them.
    const stored = () => sqlite.query("SELECT * FROM usage_ledger_facts ORDER BY provider,row_id").all();
    const before = stored();
    expect(before.length).toBeGreaterThan(0);
    const ranges: unknown[][] = [], query = sqlite.query;
    sqlite.query = function(this: Database, sql: string, ...args: unknown[]) {
      const statement = query.call(this, sql, ...args as []);
      if (sql.includes("FROM usage_ledger_days WHERE provider=? AND day>=? AND day<=?")) {
        const all = statement.all.bind(statement), wrapped = Object.create(statement);
        wrapped.all = (...params: unknown[]) => { ranges.push(params); return all(...params as []); };
        return wrapped;
      }
      return statement;
    } as typeof sqlite.query;
    let payload: ReturnType<typeof buildEraTimelines>;
    try { payload = buildEraTimelines(ctx); } finally { sqlite.query = query; }
    expect(ranges[0]!.slice(1)).toEqual(["2025-03-01", "2027-03-01"]);
    expect(ranges.slice(1)).toHaveLength(3);
    for (const range of ranges.slice(1)) {
      expect(String(range[1]) >= "2026-02-28").toBe(true);
      expect(String(range[2]) <= "2026-03-03").toBe(true);
    }
    const firstAccount = payload.subscriptions.find(row => row.subscription_id === "claude1")!;
    const secondAccount = payload.subscriptions.find(row => row.subscription_id === "claude2")!;
    expect(firstAccount.segments.map(row => [row.from,row.until,row.stats.tokens,row.stats.calls,row.stats.cycles])).toEqual([
      ["2026-03-01", "2026-03-01T12:00:00.000Z", 100, 1, 1],
      ["2026-03-01T18:00:00.000Z", "2026-03-02", 900, 2, 1],
    ]);
    expect(secondAccount.segments[0]!.stats).toMatchObject({tokens:500,calls:2,cycles:1,first_seen:"2026-03-01T12:00:00Z",last_seen:"2026-03-01T17:00:00Z"});
    expect(firstAccount.segments[0]!.stats.last_seen).toBe("2026-03-01T11:59:59.999Z");
    expect(firstAccount.segments[1]!.stats.first_seen).toBe("2026-03-01T18:00:00Z");
    expect(buildEraTimelines(ctx)).toEqual(payload);
    expect(stored()).toEqual(before);
    // An exact interval read for one account is exactly that account's part of the full interval read.
    for (const [account, from, until, tokens] of [["claude1", "2026-03-01", "2026-03-01T12:00:00.000Z", 100],
      ["claude2", "2026-03-01T12:00:00.000Z", "2026-03-01T18:00:00.000Z", 500],
      ["claude1", "2026-03-01T18:00:00.000Z", "2026-03-02", 900]] as const) {
      const within = { from: Date.parse(from), until: Date.parse(until) };
      const scoped = subscriptionDailyUsage(ctx, { within, only: { provider: "claude", account } }).get(account);
      expect(scoped?.reduce((sum, day) => sum + day.tokens, 0)).toBe(tokens);
      expect(scoped).toEqual(subscriptionDailyUsage(ctx, { within }).get(account));
    }
    const periods = loadPeriods(sqlite,ACCOUNT_PERIODS).filter(row=>row.origin==="declared");
    replaceDeclaredPeriods(sqlite,ACCOUNT_PERIODS,periods.map(row=>({...row,
      from: row.from === "2026-03-01T12:00:00.000Z" ? "2026-03-01T13:00:00.000Z" : row.from,
      until: row.until === "2026-03-01T12:00:00.000Z" ? "2026-03-01T13:00:00.000Z" : row.until,
    })));
    prepareTimelineProbeReader(sqlite,declarations);
    const corrected = buildEraTimelines(ctx);
    expect(corrected.subscriptions.find(row=>row.subscription_id==="claude1")!.segments.map(row=>row.stats.tokens)).toEqual([300,900]);
    expect(corrected.subscriptions.find(row=>row.subscription_id==="claude2")!.segments[0]!.stats).toMatchObject({tokens:300,calls:1,cycles:1,first_seen:"2026-03-01T17:00:00Z"});
    expect(stored()).toEqual(before);
  } finally { sqlite.close(); }
});
