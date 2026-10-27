import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { applyDrizzleMigrations } from "../db/migrate";
import {
  buildEraIndex,
  declaredVendorAccount,
  eraCovers,
  eraFingerprint,
  isSubscriptionActive,
  validateEras,
  type EraDeclaration,
} from "./eras";
import {
  createFetchHandler,
  currentProbeSubscription,
  handleRoster,
  probeSubscriptionGate,
  probeTargets,
  rebuildSubscriptionMaps,
  startServer,
  subscriptionActivity,
  type AppContext,
} from "./api";
import { indexSubscriptionHomes,subscriptionDeclarations,codexSourceHomes } from "./capacity-equivalents";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { prepareClaudeCardMetadataFixture } from "./claude-card-metadata.fixture";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");
const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});
const HOME = "C:/Users/x/.codex";
// Archive folders, so the eras below are also the account periods of their sources.
const ARCHIVE = ARCHIVE_LOGICAL_ROOT.replace(/\\/g, "/");
const ARCHIVE_A = `${ARCHIVE}/codex/a`;
const ARCHIVE_B = `${ARCHIVE}/codex/b`;

/** codex2 held the live home until 2026-05-01, codex3 from that day on. */
const HANDOVER: EraDeclaration[] = [
  { id: "codex2", vendor: "codex", home: ARCHIVE_A, source_home: HOME, account: "old@example.com", until: "2026-05-01" },
  { id: "codex3", vendor: "codex", home: ARCHIVE_B, source_home: HOME, account: "new@example.com", from: "2026-05-01" },
];
// One continuing local profile keeps one archive source while its account changes.
const CONTINUOUS_HANDOVER = [HANDOVER[0]!, { ...HANDOVER[1]!, home: ARCHIVE_A }];

function migratedDb(): Database {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
  return sqlite;
}

/**
 * The migration folder as it stood before `tag`. Everything from `tag` on has to
 * go, not just that one entry: drizzle skips migrations older than the newest
 * already-applied one, so a later entry left in would mask the one under test.
 */
function migrationsBefore(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-era-mig-"));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf-8")) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((e) => e.tag < tag);
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  for (const entry of journal.entries) {
    fs.copyFileSync(path.join(MIGRATIONS, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

function stubCtx(sqlite: Database, subscriptions: EraDeclaration[]): AppContext {
  declareCodexEraPeriods(sqlite, subscriptions);
  const periods = loadPeriods(sqlite, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  for (const sub of subscriptions.filter(sub => sub.vendor === "claude" && sub.home?.startsWith(ARCHIVE + "/"))) {
    const source = sub.home!.slice(ARCHIVE.length + 1).toLowerCase();
    const from = sub.from ?? "2000-01-01", until = sub.until ?? null;
    if (!periods.some(p => p.provider === "claude" && p.subject === source && p.value === sub.id && p.from === from && p.until === until))
      periods.push({ provider: "claude", subject: source, value: sub.id, from, until,
        origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
  }
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, periods);
  return {
    sqlite,
    accounts: splitProbeReaderFixtureConfig(subscriptions),
    homeToSubId: indexSubscriptionHomes(
      subscriptions.filter((s) => eraCovers(s, new Date().toISOString()))
    ),
    subIdToHomes: new Map(),
    eras: buildEraIndex(subscriptions),
    eraErrors: validateEras(subscriptions),
    claudeGauge: {},
    grokGauge: {},
    rateCards: {},
    // Fixture homes are not real directories; the machine-scoped target filter would drop them.
    probeSourceExists: () => true,
  } as unknown as AppContext;
}

function mappedCtx(sqlite: Database, subscriptions: EraDeclaration[]): AppContext {
  const ctx = stubCtx(sqlite, subscriptions);
  ctx.subIdToHomes = new Map();
  ctx.homeConflict = null;
  ctx.cycles = {};
  ctx.plans = {};
  ctx.plansCatalog = { provider_groups: [] };
  ctx.rootDir = "";
  rebuildSubscriptionMaps(ctx);
  return ctx;
}

describe("era resolution", () => {
  it("account reload replaces source metadata and clears it on a conflicting map",()=>{
    const db=migratedDb();
    try {
      const ctx=mappedCtx(db,[{id:"one",vendor:"codex",home:ARCHIVE_A,source_home:HOME}]);
      const next=[{id:"two",vendor:"codex",home:ARCHIVE_B,source_home:"C:/other"}];
      ctx.accounts=splitProbeReaderFixtureConfig(next);rebuildSubscriptionMaps(ctx);
      expect(subscriptionDeclarations(ctx.homeToSubId)).toEqual(ctx.accounts.sources);
      expect(codexSourceHomes(ctx.homeToSubId)).toEqual(["c:/other"]);
      const conflicting = [...next,{...next[0]!,id:"conflict",home:ARCHIVE_A}];
      declareCodexEraPeriods(db, conflicting, { replace: true });
      ctx.accounts=splitProbeReaderFixtureConfig(conflicting);
      rebuildSubscriptionMaps(ctx);
      expect(subscriptionDeclarations(ctx.homeToSubId)).toEqual([]);
      expect(codexSourceHomes(ctx.homeToSubId)).toEqual([]);
    } finally {db.close();}
  });
  const index = buildEraIndex(HANDOVER);

  it("routes a source to the subscription that held it at that instant", () => {
    expect(index.resolve("codex", HOME, "2026-04-30T23:59:59Z")).toBe("codex2");
    expect(index.resolve("codex", HOME, "2026-05-02T08:00:00Z")).toBe("codex3");
  });

  it("treats until as exclusive and from as inclusive on the boundary day", () => {
    // The whole of 2026-05-01 already belongs to codex3: until is exclusive.
    expect(index.resolve("codex", HOME, "2026-05-01T00:00:00Z")).toBe("codex3");
    expect(index.resolve("codex", HOME, "2026-05-01T23:59:59Z")).toBe("codex3");
    expect(index.resolve("codex", HOME, "2026-04-30T00:00:00Z")).toBe("codex2");
  });

  it("leaves a timestamp outside every era unattributed instead of picking the latest", () => {
    const closed: EraDeclaration[] = [
      { id: "codex2", vendor: "codex", source_home: HOME, from: "2026-01-01", until: "2026-05-01" },
    ];
    const only = buildEraIndex(closed);
    expect(only.resolve("codex", HOME, "2025-12-31T12:00:00Z")).toBeNull();
    expect(only.resolve("codex", HOME, "2026-06-01T12:00:00Z")).toBeNull();
    expect(only.resolve("codex", "D:/somewhere/else", "2026-02-01T12:00:00Z")).toBeNull();
  });

  it("keeps entries without dates as one open era", () => {
    const legacy = buildEraIndex([{ id: "codex1", vendor: "codex", source_home: HOME }]);
    expect(legacy.resolve("codex", HOME, "2019-01-01T00:00:00Z")).toBe("codex1");
    expect(legacy.resolve("codex", HOME, "2099-01-01T00:00:00Z")).toBe("codex1");
  });

  it("matches vendors case-insensitively and treats anthropic as claude", () => {
    const claude = buildEraIndex([{ id: "claude1", vendor: "anthropic", source_home: "C:/Users/x/.claude" }]);
    expect(claude.resolve("claude", "C:\\Users\\X\\.claude\\", "2026-05-01T00:00:00Z")).toBe("claude1");
  });

  it("resolves a store-named source by subscription id", () => {
    const grok = buildEraIndex([{ id: "grok", vendor: "grok", until: "2026-05-01" }]);
    expect(grok.resolve("grok", "grok", "2026-04-01T00:00:00Z")).toBe("grok");
    expect(grok.resolve("grok", "grok", "2026-06-01T00:00:00Z")).toBeNull();
  });
});

describe("era declaration validation", () => {
  it("rejects two eras of the same home that overlap, naming both entries", () => {
    const errors = validateEras([
      { id: "codex2", vendor: "codex", source_home: HOME, until: "2026-06-01" },
      { id: "codex3", vendor: "codex", source_home: HOME, from: "2026-05-01" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("codex2 [-inf, 2026-06-01)");
    expect(errors[0]).toContain("codex3 [2026-05-01, +inf)");
  });

  it("accepts a clean handover and parallel subscriptions on distinct homes", () => {
    expect(validateEras(HANDOVER)).toEqual([]);
    expect(
      validateEras([
        { id: "codex1", vendor: "codex", source_home: "C:/Users/a/.codex" },
        { id: "codex2", vendor: "codex", source_home: "C:/Users/b/.codex" },
      ])
    ).toEqual([]);
  });

  it("rejects overlapping eras of one home even when the subscription id is the same", () => {
    const errors = validateEras([
      { id: "codex1", vendor: "codex", source_home: HOME, account: "a@example.com" },
      { id: "codex1", vendor: "codex", source_home: HOME, account: "b@example.com" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("codex1 [-inf, +inf)");
  });

  it("rejects malformed and inverted dates", () => {
    const errors = validateEras([
      { id: "codex2", vendor: "codex", source_home: HOME, from: "01-05-2026" },
      { id: "codex3", vendor: "codex", source_home: ARCHIVE_B, from: "2026-05-01", until: "2026-04-01" },
    ]);
    expect(errors.some((e) => e.includes("nie jest datą"))).toBe(true);
    expect(errors.some((e) => e.includes("nie później niż zaczyna"))).toBe(true);
  });

  it("resolves an overlapping home to nothing rather than to a guess", () => {
    const ambiguous = buildEraIndex([
      { id: "codex2", vendor: "codex", source_home: HOME, until: "2026-06-01" },
      { id: "codex3", vendor: "codex", source_home: HOME, from: "2026-05-01" },
    ]);
    expect(ambiguous.resolve("codex", HOME, "2026-05-15T00:00:00Z")).toBeNull();
    expect(ambiguous.resolve("codex", HOME, "2026-04-15T00:00:00Z")).toBe("codex2");
  });
});

describe("inactive derivation", () => {
  const now = "2026-08-30T00:00:00Z";

  it("is inactive only when every era is closed", () => {
    expect(isSubscriptionActive(HANDOVER, "codex2")).toBe(false);
    expect(isSubscriptionActive(HANDOVER, "codex3")).toBe(true);
  });

  it("is closed by the declaration, not by the clock: a future until already counts", () => {
    const subs: EraDeclaration[] = [{ id: "codex9", vendor: "codex", source_home: HOME, until: "2099-12-01" }];
    expect(isSubscriptionActive(subs, "codex9")).toBe(false);
  });

  it("stays active while any one era is left open", () => {
    const subs: EraDeclaration[] = [
      { id: "codex9", vendor: "codex", source_home: HOME, until: "2026-05-01" },
      { id: "codex9", vendor: "codex", source_home: ARCHIVE_B, from: "2026-05-01" },
    ];
    expect(isSubscriptionActive(subs, "codex9")).toBe(true);
  });

  it("treats an undeclared id and a legacy entry as active", () => {
    expect(isSubscriptionActive(HANDOVER, "gemini-pool-1")).toBe(true);
    expect(isSubscriptionActive([{ id: "codex1", vendor: "codex" }], "codex1")).toBe(true);
  });

  it("reads the vendor account from the era that covers now, else the last declared", () => {
    expect(declaredVendorAccount(HANDOVER, "codex3", now)).toBe("new@example.com");
    expect(declaredVendorAccount(HANDOVER, "codex2", now)).toBe("old@example.com");
    expect(declaredVendorAccount(HANDOVER, "unknown", now)).toBeNull();
  });
});

describe("inactive subscription history lookup", () => {
  /** The sample's account comes from the account period of `home`, not from the row. */
  function seedWindow(
    sqlite: Database,
    home: string,
    pathName: string,
    ts: string,
    usedPercent: number,
    resetTs: string
  ): void {
    const reset = Math.floor(new Date(resetTs).getTime() / 1000);
    sqlite.run(`CREATE TABLE IF NOT EXISTS ratelimit (
      ts TEXT NOT NULL,
      home TEXT NOT NULL,
      window_minutes INTEGER,
      limit_id TEXT,
      resets_at INTEGER,
      used_percent REAL,
      path TEXT,
      plan_type TEXT,
      limit_name TEXT
    )`);
    sqlite.run(
      `INSERT INTO ratelimit (ts, home, window_minutes, limit_id, resets_at, used_percent, path)
       VALUES (?, ?, 10080, 'codex', ?, ?, ?)`,
      [ts, home, reset, usedPercent, pathName]
    );
  }

  it("serves a fully closed subscription's own usage series and windows without a current cycle", async () => {
    const sqlite = migratedDb();
    seedWindow(
      sqlite,
      ARCHIVE_A,
      "closed.jsonl",
      "2026-04-10T10:00:00Z",
      21,
      "2026-04-17T00:00:00Z"
    );
    seedWindow(
      sqlite,
      ARCHIVE_B,
      "open.jsonl",
      "2026-08-29T10:00:00Z",
      91,
      "2026-09-05T00:00:00Z"
    );
    declareCodexEraPeriods(sqlite, HANDOVER);
    prepareProbeReaderFixture(sqlite, [HANDOVER[0]!, probeReaderFixtureSource("glm", "glm")]);
    const ctx = mappedCtx(sqlite, HANDOVER);
    // The maintenance worker publishes the ledger (no calls here) and the window sums the screens read.
    sqlite.exec("CREATE TABLE IF NOT EXISTS events(home TEXT,path TEXT,ts TEXT,model TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER)");
    prepareCodexLedgerFixture(sqlite, ctx.rateCards ?? {}, ctx.homeToSubId);
    prepareWindowUsageFixture(sqlite, { rateCards: ctx.rateCards ?? {} });
    const fetch = createFetchHandler(ctx);

    const usageResponse = await fetch(
      new Request("http://localhost/api/usage-series?account=codex2&window=10080")
    );
    expect(usageResponse.status).toBe(200);
    const usage = (await usageResponse.json()) as {
      account: string;
      sample_count: number;
      points: Array<{ percent: number }>;
      cycles: Array<{ is_active: boolean }>;
    };
    expect(usage).toMatchObject({ account: "codex2", sample_count: 1 });
    expect(usage.points.map((point) => point.percent)).toEqual([21]);
    expect(usage.cycles).toHaveLength(1);
    expect(usage.cycles.every((cycle) => !cycle.is_active)).toBe(true);

    const windowsResponse = await fetch(
      new Request("http://localhost/api/windows?account=codex2")
    );
    expect(windowsResponse.status).toBe(200);
    const windows = (await windowsResponse.json()) as {
      account: string;
      windows: Array<{ isCurrent: boolean; usedPercent: number | null }>;
    };
    expect(windows.account).toBe("codex2");
    expect(windows.windows).toHaveLength(1);
    expect(windows.windows[0]).toMatchObject({ isCurrent: false, usedPercent: 21 });
  });

  it("keeps today's shared source on the open era while retaining the closed archive lookup", () => {
    const ctx = mappedCtx(migratedDb(), HANDOVER);
    expect(ctx.subIdToHomes.get("codex2")).toEqual([ARCHIVE_A]);
    expect(ctx.subIdToHomes.get("codex3")).toEqual([ARCHIVE_B]);
    expect(ctx.homeToSubId.has(ARCHIVE_A.toLowerCase())).toBe(false);
    expect(ctx.homeToSubId.get(ARCHIVE_B.toLowerCase())).toBe("codex3");
    expect(ctx.homeToSubId.get(HOME.toLowerCase())).toBe("codex3");
  });
});

describe("era fingerprint", () => {
  it("changes when a date changes and ignores declaration order", () => {
    const reordered = [HANDOVER[1]!, HANDOVER[0]!];
    expect(eraFingerprint(reordered)).toBe(eraFingerprint(HANDOVER));
    const moved: EraDeclaration[] = [HANDOVER[0]!, { ...HANDOVER[1]!, from: "2026-05-02" }];
    expect(eraFingerprint(moved)).not.toBe(eraFingerprint(HANDOVER));
  });
});

/** Rows written before eras existed, labelled by the declaration of the day. */
function seedHistoricalRows(sqlite: Database): void {
  const claude: Array<[string, string, string]> = [
    ["c1", "2026-04-10T10:00:00Z", `${ARCHIVE_A}/projects/s/a.jsonl`],
    ["c2", "2026-05-10T10:00:00Z", `${ARCHIVE_A}/projects/s/b.jsonl`],
    ["c3", "2026-05-20T10:00:00Z", `${ARCHIVE_B}/projects/s/c.jsonl`],
  ];
  for (const [callId, ts, file] of claude) {
    sqlite.run(
      `INSERT INTO claude_events (store, call_id, ts, path, subscription_id) VALUES ('live', ?, ?, ?, 'claude-old')`,
      [callId, ts, file]
    );
  }
  const probes: Array<[string, string]> = [
    ["2026-04-10T10:00:00Z", "2026-04-17T10:00:00Z"],
    ["2026-05-10T10:00:00Z", "2026-05-17T10:00:00Z"],
    ["2026-05-20T10:00:00Z", "2026-05-27T10:00:00Z"],
  ];
  for (const [ts, resets] of probes) {
    sqlite.run(
      `INSERT INTO probe_windows (provider, subject, ts, kind, limit_group, reported_percent_side,
                                  used_percent, window_minutes, resets_at, extra)
       VALUES ('codex', 'codex2', ?, 'primary', 'codex', 'used', 41, 10080, ?, ?)`,
      [ts, resets, JSON.stringify({ home: HOME })]
    );
  }
}

describe("era_unattributed migration", () => {
  it("preserves old probe samples while the final migration removes their retired attribution flag", () => {
    const sqlite = new Database(":memory:");
    const before = migrationsBefore("0012_");
    applyDrizzleMigrations(drizzle(sqlite), before);
    sqlite.run(
      `INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, used_percent)
       VALUES ('codex', 'codex1', '2026-08-29T10:00:00.000Z', 'primary', 'used', 41)`
    );
    expect(() => sqlite.query(`SELECT era_unattributed FROM probe_windows`).all()).toThrow();

    applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);

    expect(sqlite.query(`SELECT subject, used_percent FROM probe_windows`).all()).toEqual([
      { subject: "codex1", used_percent: 41 },
    ]);
    expect(() => sqlite.query("SELECT era_unattributed FROM probe_windows").all()).toThrow();
    // The original subject survives as evidence; it never proves account ownership.
    prepareProbeReaderFixture(sqlite, []);
    expect(subscriptionActivity(sqlite).has("codex1")).toBe(false);
  });
});

describe("probe call sites", () => {
  const CLOSED: EraDeclaration[] = [
    { id: "claude-old", vendor: "claude", home: `${ARCHIVE}/claude/fixture`, source_home: "C:/Users/x/.claude", until: "2026-05-01" },
  ];

  it("refuses a label once every era of the declared source is closed", () => {
    const ctx = stubCtx(migratedDb(), CLOSED);
    expect(currentProbeSubscription(ctx, "claude", "claude-old")).toBeNull();
  });

  it("keeps the configured id when nothing declares that source", () => {
    const ctx = stubCtx(migratedDb(), CLOSED);
    expect(currentProbeSubscription(ctx, "claude", "claude-undeclared")).toBe("claude-undeclared");
    expect(currentProbeSubscription(stubCtx(migratedDb(), []), "glm", "glm")).toBe("glm");
  });

  it("hands over to the subscription that owns the source today", () => {
    const ctx = stubCtx(migratedDb(), [
      ...CLOSED,
      { id: "claude-new", vendor: "claude", home: `${ARCHIVE}/claude/fixture`, source_home: "C:/Users/x/.claude", from: "2026-05-01" },
    ]);
    expect(currentProbeSubscription(ctx, "claude", "claude-old")).toBe("claude-new");
  });

  it("skips the cycle instead of stamping a closed subscription, and warns once", () => {
    const ctx = stubCtx(migratedDb(), CLOSED);
    const warnings: unknown[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    try {
      const gate = probeSubscriptionGate(ctx, "claude", "claude-old");
      expect(gate()).toBeNull();
      expect(gate()).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("arms no codex target while the declaration is rejected", () => {
    const overlapping: EraDeclaration[] = [
      { id: "codex2", vendor: "codex", source_home: HOME, until: "2026-06-01" },
      { id: "codex3", vendor: "codex", source_home: HOME, from: "2026-05-01" },
    ];
    const ctx = stubCtx(migratedDb(), overlapping);
    expect(ctx.eraErrors).toHaveLength(1);
    // Without the gate the ambiguity resolves to null and a fallback would arm
    // one target per entry, writing the same samples under both subscriptions.
    expect(probeTargets(ctx)).toEqual([]);
    expect(currentProbeSubscription(ctx, "codex", "codex2")).toBeNull();
  });

  it("arms one target per open codex era when the declaration is clean", () => {
    const ctx = stubCtx(migratedDb(), CONTINUOUS_HANDOVER);
    expect(probeTargets(ctx)).toEqual([{ account: "codex3", home: HOME }]);
  });

  it.each([false, true])("the production scheduler rechecks targets across discovery and handover (initially missing: %s)", async (initiallyMissing) => {
    const ctx = mappedCtx(migratedDb(), CONTINUOUS_HANDOVER);
    let sourceExists = !initiallyMissing;
    ctx.probeSourceExists = () => sourceExists;
    const seen: string[][] = [];
    const runner = async (_sqlite: Database, targets: Array<{ account: string }>): Promise<unknown> => {
      seen.push(targets.map((target) => target.account));
      return {};
    };
    let now = "2026-04-30T23:59:59Z";
    let scheduledPoll: (() => unknown) | null = null;
    let nextTimer = 1;
    const timeouts = new Set<number>();
    const intervals = new Set<number>();
    let stopCalls = 0;
    let transportFetch: ((req: Request, server: { timeout: (req: Request, seconds: number) => void }) => unknown) | undefined;
    const previous = {
      sync: process.env.TOKENATLAS_SYNC_MINUTES,
      probe: process.env.TOKENATLAS_PROBE_MINUTES,
      gemini: process.env.TOKENATLAS_GEMINI_MINUTES,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    process.env.TOKENATLAS_SYNC_MINUTES = "0";
    process.env.TOKENATLAS_PROBE_MINUTES = "1";
    process.env.TOKENATLAS_GEMINI_MINUTES = "0";
    try {
      const running = startServer(7331, undefined, {
        context: ctx,
        now: () => now,
        codexProbeRunner: runner,
        serve: ((options: { fetch: typeof transportFetch }) => {
          transportFetch = options.fetch;
          return { port: 7331, stop: () => { stopCalls += 1; } };
        }) as unknown as typeof Bun.serve,
        setTimeout: ((callback: (...args: unknown[]) => unknown, delay?: number) => {
          if (delay === 3_000) scheduledPoll = callback;
          const handle = nextTimer++;
          timeouts.add(handle);
          return handle as never;
        }) as unknown as typeof setTimeout,
        setInterval: (() => {
          const handle = nextTimer++;
          intervals.add(handle);
          return handle as never;
        }) as unknown as typeof setInterval,
        clearTimeout: ((handle: number) => { timeouts.delete(handle); }) as unknown as typeof clearTimeout,
        clearInterval: ((handle: number) => { intervals.delete(handle); }) as unknown as typeof clearInterval,
      });
      const timeoutsForRequests: Array<[Request, number]> = [];
      const transport = { timeout: (req: Request, seconds: number) => { timeoutsForRequests.push([req, seconds]); } };
      const accountingRequest = new Request("http://localhost/api/codex-accounting?since=invalid");
      const invalidAccounting = await transportFetch!(accountingRequest, transport) as Response;
      expect(invalidAccounting.status).toBe(400);
      expect(timeoutsForRequests).toEqual([[accountingRequest, 0]]);
      const historyRequest = new Request("http://localhost/api/repo-history?project=sampleapp&since=invalid");
      const invalidHistory = await transportFetch!(historyRequest, transport) as Response;
      expect(invalidHistory.status).toBe(400);
      expect(timeoutsForRequests).toEqual([[accountingRequest, 0], [historyRequest, 0]]);
      const viewRequest = new Request("http://localhost/api/cycle-breakdown?since_ts=invalid");
      const invalidView = await transportFetch!(viewRequest, transport) as Response;
      expect(invalidView.status).toBe(400);
      expect(timeoutsForRequests).toEqual([[accountingRequest, 0], [historyRequest, 0], [viewRequest, 0]]);
      await transportFetch!(new Request("http://localhost/api/nonexistent"), transport);
      expect(timeoutsForRequests).toHaveLength(3);
      expect(scheduledPoll).not.toBeNull();
      if (initiallyMissing) {
        await scheduledPoll!();
        expect(seen).toEqual([]);
        sourceExists = true;
      }
      await scheduledPoll!();
      now = "2026-05-01T00:00:00Z";
      await scheduledPoll!();
      expect(seen).toEqual([["codex2"], ["codex3"]]);
      expect(intervals.size).toBeGreaterThan(0);
      running.close();
      running.close();
      expect(intervals.size).toBe(0);
      expect(stopCalls).toBe(1);
    } finally {
      log.mockRestore();
      if (previous.sync === undefined) delete process.env.TOKENATLAS_SYNC_MINUTES;
      else process.env.TOKENATLAS_SYNC_MINUTES = previous.sync;
      if (previous.probe === undefined) delete process.env.TOKENATLAS_PROBE_MINUTES;
      else process.env.TOKENATLAS_PROBE_MINUTES = previous.probe;
      if (previous.gemini === undefined) delete process.env.TOKENATLAS_GEMINI_MINUTES;
      else process.env.TOKENATLAS_GEMINI_MINUTES = previous.gemini;
    }
  });
});

describe("roster era fields", () => {
  it("merges a provider payload into its declared row through the public roster handler", async () => {
    const sqlite = migratedDb();
    const ctx = stubCtx(sqlite, [
      { id: "claude-seat", vendor: "claude", home: "C:/Users/x/.claude", account: "me@example.com" },
    ]);
    prepareProbeReaderFixture(sqlite, [
      probeReaderFixtureSource("claude", "claude-seat"), probeReaderFixtureSource("glm", "glm"),
    ]);
    ctx.claudeGauge = { subscription: "claude-seat", vendor: "claude", plan: "wrong-plan" };
    replaceDeclaredPeriods(sqlite, PLAN_PERIODS, [{ provider: "claude", subject: "claude-seat",
      from: "2026-01-01T00:00:00Z", until: null, value: "max", origin: "declared",
      firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);

    prepareProbeReaderFixture(sqlite, [probeReaderFixtureSource("claude", "claude-seat"), probeReaderFixtureSource("glm", "glm")]);
    ctx.rateCards = { version: 1, currency: "USD", unit: "per 1M", vendors: {} };
    fillUsageLedgerFixture(sqlite, ctx.rateCards);
    prepareWindowUsageFixture(sqlite, { rateCards: ctx.rateCards, claudeGauge: ctx.claudeGauge });
    prepareClaudeCardMetadataFixture(sqlite, ["claude-seat"]);
    const body = (await handleRoster(ctx, new URL("http://localhost/api/roster")).then((response) =>
      response.json()
    )) as { accounts: Array<Record<string, unknown>> };
    const rows = body.accounts.filter((account) => String(account.id).toLowerCase() === "claude-seat");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendor: "claude", plan: "max", basis: "declared" });
    expect(rows[0]!.claude).not.toBeNull();
  });

  it("counts weekly cycles and the sampled span per subscription", () => {
    const sqlite = migratedDb();
    seedHistoricalRows(sqlite);
    sqlite.run(
      `INSERT INTO probe_windows (provider, subject, ts, kind, reported_percent_side, used_percent, resets_at)
       VALUES ('claude', 'claude-a', '2026-05-02T10:00:00Z', 'session', 'used', 10, '2026-05-02T15:00:00Z')`
    );
    const codexSource = { ...probeReaderFixtureSource("codex", "codex2"), machine: "fixture-counts",
      login: "x", home: ARCHIVE_A, source_home: HOME };
    const claudeSource = probeReaderFixtureSource("claude", "claude-a");
    sqlite.query("UPDATE probe_windows SET machine=?, profile=?, extra=? WHERE provider='claude'").run(
      claudeSource.machine, claudeSource.login, JSON.stringify({ home: claudeSource.source_home }));
    prepareProbeReaderFixture(sqlite, [codexSource, claudeSource]);
    const activity = subscriptionActivity(sqlite);
    expect(activity.get("codex2")).toEqual({
      first_seen: "2026-04-10T10:00:00Z",
      last_seen: "2026-05-20T10:00:00Z",
      cycle_count: 3,
    });
    // A session window is not a cycle.
    expect(activity.get("claude-a")?.cycle_count).toBe(0);
  });

  it("serialises the additive fields the account timeline consumes", async () => {
    const sqlite = migratedDb();
    seedHistoricalRows(sqlite);
    declareCodexEraPeriods(sqlite, HANDOVER);
    prepareProbeReaderFixture(sqlite, [
      HANDOVER[0]!, probeReaderFixtureSource("codex", "codex3"), probeReaderFixtureSource("glm", "glm"),
    ]);
    const ctx = stubCtx(sqlite, HANDOVER);
    const body = (await handleRoster(ctx, new URL("http://localhost/api/roster")).then((r) =>
      r.json()
    )) as { accounts: Array<Record<string, unknown>> };
    const byId = new Map(body.accounts.map((a) => [String(a.id), a]));
    // The gemini pool and grok stores come from the developer's own machine, so
    // only the declared codex subscriptions are asserted by name.
    expect(byId.has("codex2")).toBe(true);
    expect(byId.has("codex3")).toBe(true);
    const closed = byId.get("codex2")!;
    expect(closed).toMatchObject({
      active: false,
      vendor_account: "old@example.com",
      first_seen: "2026-04-10T10:00:00Z",
      last_seen: "2026-04-10T10:00:00Z",
      cycle_count: 1,
    });
    const open = byId.get("codex3")!;
    expect(open).toMatchObject({
      active: true,
      vendor_account: "new@example.com",
      first_seen: null,
      last_seen: null,
      cycle_count: 0,
    });
    for (const account of body.accounts) {
      expect(Object.keys(account)).toEqual(
        expect.arrayContaining(["active", "vendor_account", "first_seen", "last_seen", "cycle_count"])
      );
      expect(JSON.parse(JSON.stringify(account))).toEqual(account);
    }
  });
});
