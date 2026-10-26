import { expandProbeJournal } from "../core/journal-compact";
import { dailyJournalFile } from "../core/journal-files";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARCHIVE_LOGICAL_ROOT, LOGIN, MACHINE } from "../../config/paths";
import { applyDrizzleMigrations } from "../../db/migrate";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../../db/period-store";
import { currentRegistry } from "../../server/current/registry";
import { publishCurrentBatch } from "../../server/current/store";
import { splitProbeReaderFixtureConfig } from "../../server/probe-reader.fixture";
import { ingestGaugesAsync } from "../../ingest/gauges";
import { configureGaugeJournal, flushGaugeJournal, pendingGaugeJournalLines } from "../core/journal";
import {
  CLAUDE_CODE_SHARE_EXTRA,
  CLAUDE_CODE_SHARE_KEY,
  CLAUDE_RAW_USAGE_PREFIX,
  claudeCodeProductShareFromExtra,
  claudeProbeAdapter,
  claudeProductBreakdownFromExtra,
  decodeClaudeAccountMeters,
  parseClaudeCodeProductShare,
  parseClaudeProductBreakdown,
  parseUsagePayload,
  readClaudeProbe,
  type ClaudeCodeProductShare,
  type ClaudeProductBreakdown,
} from "./claude";

const AS_OF = "2026-09-17T00:06:36.239074+00:00";
const WINDOW_STARTED = "2026-09-13T10:59:59.225126+00:00";
const RESETS_AT = "2026-09-20T10:59:59.225126+00:00";
const COLLECTED_AT = "2026-09-17T00:07:00.000Z";
const SHARE: ClaudeCodeProductShare = {
  schema: 1,
  key: "claude_code",
  percent: 12,
  as_of: AS_OF,
  window_started_at: WINDOW_STARTED,
  display_name: "Claude Code",
};
const BREAKDOWN = {
  as_of: AS_OF,
  window_started_at: WINDOW_STARTED,
  rows: [
    { key: "claude_code", display_name: "Claude Code", percent: 12 },
    { key: "chat", display_name: "Chats", percent: 0 },
    { key: "cowork", display_name: "Cowork", percent: 0 },
    { key: "other", display_name: "Other", percent: 88 },
  ],
};
// Decoded rows come back ordered by share, so the biggest surface reads first.
const BREAKDOWN_DECODED: ClaudeProductBreakdown = {
  schema: 1,
  as_of: AS_OF,
  window_started_at: WINDOW_STARTED,
  rows: [
    { key: "other", percent: 88, display_name: "Other" },
    { key: "claude_code", percent: 12, display_name: "Claude Code" },
    { key: "chat", percent: 0, display_name: "Chats" },
    { key: "cowork", percent: 0, display_name: "Cowork" },
  ],
};
const MIGRATIONS = path.resolve(import.meta.dir, "../../../drizzle");
const temporary: string[] = [];

afterEach(() => {
  configureGaugeJournal(null);
  for (const dir of temporary.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handle */ }
  }
});

function observedPayload(overrides: Record<string, unknown> = {}) {
  return {
    limits: [
      { kind: "session", group: "session", percent: 5, resets_at: "2026-09-17T05:59:59.225126+00:00", is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 24, resets_at: RESETS_AT, severity: "ok" },
      { kind: "weekly_scoped", group: "weekly", percent: 8, resets_at: RESETS_AT, scope: { model: { display_name: "Sonnet" } } },
    ],
    five_hour: { utilization: 5, resets_at: "2026-09-17T05:59:59.225126+00:00" },
    seven_day: { utilization: 24, resets_at: RESETS_AT },
    seven_day_breakdown: BREAKDOWN,
    ...overrides,
  };
}

function parse(usage: Record<string, unknown>, plan = "pro") {
  return claudeProbeAdapter.parse({ usage, plan });
}

function extraOf(readings: ReturnType<typeof parse>["readings"], kind: string, scope: string | null = null) {
  return readings.find((row) => row.kind === kind && (row.scope ?? null) === scope)?.extra ?? null;
}

function shareKeys(extra: Record<string, string | number | boolean | null> | null) {
  return extra ? Object.keys(extra).filter((key) => key.startsWith("claude.share.")) : [];
}

function breakdownKeys(extra: Record<string, string | number | boolean | null> | null) {
  return extra ? Object.keys(extra).filter((key) => key.startsWith("claude.breakdown.")) : [];
}

describe("Claude Code product share parser", () => {
  test("attaches Code share to the modern weekly_all reading without dropping limits[] or other counters", () => {
    const parsed = parse(observedPayload());
    expect(parseUsagePayload(observedPayload()).map((limit) => limit.kind)).toEqual(["session", "weekly_all", "weekly_scoped"]);
    expect(parsed.readings.map((row) => [row.kind, row.usedPercent, row.scope])).toEqual([
      ["session", 5, null],
      ["weekly_all", 24, null],
      ["weekly_scoped", 8, "Sonnet"],
    ]);
    expect(parsed.meta.product_share).toEqual(SHARE);
    const weekly = extraOf(parsed.readings, "weekly_all");
    expect(claudeCodeProductShareFromExtra(weekly)).toEqual(SHARE);
    expect(weekly).toMatchObject({ severity: "ok", is_active: false, [CLAUDE_CODE_SHARE_EXTRA.percent]: 12 });
    expect(shareKeys(extraOf(parsed.readings, "session"))).toEqual([]);
    expect(shareKeys(extraOf(parsed.readings, "weekly_scoped", "Sonnet"))).toEqual([]);
    // Every surface of the week travels with the account-wide bar, and only with it.
    expect(parsed.meta.product_breakdown).toEqual({ ...BREAKDOWN_DECODED, rows: BREAKDOWN.rows.map(
      (row) => ({ key: row.key, percent: row.percent, display_name: row.display_name })) });
    expect(claudeProductBreakdownFromExtra(weekly)).toEqual(BREAKDOWN_DECODED);
    expect(breakdownKeys(extraOf(parsed.readings, "session"))).toEqual([]);
    expect(breakdownKeys(extraOf(parsed.readings, "weekly_scoped", "Sonnet"))).toEqual([]);
  });

  test("legacy seven_day payload still receives the matching weekly_all share", () => {
    const parsed = parse({
      seven_day: { utilization: 24, resets_at: RESETS_AT },
      seven_day_breakdown: BREAKDOWN,
    });
    expect(parsed.readings).toHaveLength(1);
    expect(parsed.readings[0]!.kind).toBe("weekly_all");
    expect(parsed.readings[0]!.usedPercent).toBe(24);
    expect(claudeCodeProductShareFromExtra(parsed.readings[0]!.extra)).toEqual(SHARE);
  });

  test("missing, null, or unusable breakdowns stay absent and never become 0 or 100", () => {
    const cases: unknown[] = [undefined, null, {}, { as_of: AS_OF }, { rows: BREAKDOWN.rows }];
    for (const seven_day_breakdown of cases) {
      const usage = observedPayload({ seven_day_breakdown });
      expect(parseClaudeCodeProductShare(usage)).toBeNull();
      expect(parse(usage).meta.product_share).toBeNull();
      expect(shareKeys(extraOf(parse(usage).readings, "weekly_all"))).toEqual([]);
      expect(parse(usage).readings.find((row) => row.kind === "weekly_all")!.usedPercent).toBe(24);
    }
  });

  test("malformed, NaN, out-of-range, duplicate Code rows, and mismatched windows stay absent", () => {
    const weeklyStillValid = (usage: Record<string, unknown>) => {
      const parsed = parse(usage);
      expect(parsed.readings.find((row) => row.kind === "weekly_all")!.usedPercent).toBe(24);
      expect(parsed.meta.product_share).toBeNull();
      expect(shareKeys(extraOf(parsed.readings, "weekly_all"))).toEqual([]);
    };
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, as_of: 1 } }));
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, window_started_at: "not-a-date" } }));
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, rows: "nope" } }));
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, rows: [{ key: CLAUDE_CODE_SHARE_KEY, percent: Number.NaN }] } }));
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, rows: [{ key: CLAUDE_CODE_SHARE_KEY, percent: 101 }] } }));
    weeklyStillValid(observedPayload({ seven_day_breakdown: { ...BREAKDOWN, rows: [{ key: CLAUDE_CODE_SHARE_KEY, percent: -1 }] } }));
    weeklyStillValid(observedPayload({
      seven_day_breakdown: { ...BREAKDOWN, rows: [...BREAKDOWN.rows, { key: CLAUDE_CODE_SHARE_KEY, percent: 9 }] },
    }));
    weeklyStillValid(observedPayload({
      limits: [
        { kind: "weekly_all", group: "weekly", percent: 24, resets_at: "2026-09-16T10:59:59.225126+00:00" },
      ],
    }));
    weeklyStillValid(observedPayload({
      seven_day_breakdown: { ...BREAKDOWN, as_of: "2026-09-12T00:00:00.000Z" },
    }));
    const twoWeekly = observedPayload({
      limits: [
        { kind: "weekly_all", group: "weekly", percent: 24, resets_at: RESETS_AT },
        { kind: "weekly_all", group: "weekly", percent: 24, resets_at: RESETS_AT },
      ],
    });
    weeklyStillValid(twoWeekly);
  });

  test("exact zero Code share is stored as observed and is not a usable capacity denominator", () => {
    const parsed = parse(observedPayload({
      seven_day_breakdown: { ...BREAKDOWN, rows: [{ key: CLAUDE_CODE_SHARE_KEY, display_name: "Claude Code", percent: 0 }] },
    }));
    const share = parsed.meta.product_share;
    expect(share?.percent).toBe(0);
    expect(claudeCodeProductShareFromExtra(extraOf(parsed.readings, "weekly_all"))?.percent).toBe(0);
    expect(parsed.readings.find((row) => row.kind === "weekly_all")!.usedPercent).toBe(24);
  });
});

describe("Claude Code product share persistence roundtrip", () => {
  test("compact cycles preserve all surface extras byte-for-byte as time and shares change", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-claude-compact-")); temporary.push(root);
    const archiveRoot = path.join(root, "archive"), journalRoot = path.join(archiveRoot, "gauges", "producer");
    fs.mkdirSync(archiveRoot);
    const source = open(path.join(root, "producer.sqlite")), receiverPath = path.join(root, "receiver.sqlite");
    const receiver = open(receiverPath);
    try {
      configureGaugeJournal(journalRoot, { archiveRoot });
      for (let cycle = 0; cycle < 3; cycle++) {
        const asOf = `2026-09-17T00:0${cycle + 6}:36.239074+00:00`;
        const breakdown = { ...BREAKDOWN, as_of: asOf, rows: BREAKDOWN.rows.map(row => ({ ...row,
          percent: cycle === 2 ? row.percent + (row.key === "claude_code" ? 1 : row.key === "other" ? -1 : 0) : row.percent,
        })) };
        const parsed = parse(observedPayload({ seven_day_breakdown: breakdown }));
        expect(claudeProbeAdapter.persist(source, parsed.readings, {
          target: { subscription: "seat" }, credentials: { token: "fixture", expires_at: null, subscription_type: "pro" },
          ts: `2026-09-17T00:0${cycle + 7}:00.000Z`, meta: parsed.meta,
        })).toBe(3);
      }
      flushAll(source, journalRoot, archiveRoot);
      const raw = fs.readFileSync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())), "utf8").trim().split("\n");
      const records = raw.map(line => JSON.parse(line) as Record<string, unknown>);
      expect(records.map(row => "p" in row)).toEqual([true, true, true, false, false, false, false, false, false]);
      const weekly = expandProbeJournal(raw).map((row, index) => ({ row, wire: records[index]! }))
        .filter(({ row }) => row.kind === "weekly_all");
      expect(weekly).toHaveLength(3);
      for (const { wire } of weekly.slice(1)) expect(wire.x).toBeDefined();
      const extras = weekly.map(({ row }) => String(row.extra));
      expect(extras[1]).not.toBe(extras[0]); expect(extras[2]).not.toBe(extras[1]);
      for (const [i, extra] of extras.entries()) {
        const decoded = claudeProductBreakdownFromExtra(JSON.parse(extra));
        expect(decoded?.rows.map(row => [row.key, row.percent])).toEqual([
          ["other", i === 2 ? 87 : 88], ["claude_code", i === 2 ? 13 : 12], ["chat", 0], ["cowork", 0],
        ]);
        expect(claudeCodeProductShareFromExtra(JSON.parse(extra))?.percent).toBe(i === 2 ? 13 : 12);
      }
      expect((await ingestGaugesAsync({ atlasPath: receiverPath, archiveRoot, ownStore: "receiver", force: false })).rows).toBe(9);
      expect(receiver.query("SELECT ts, kind, scope, extra FROM probe_windows ORDER BY id").all()).toEqual(
        source.query("SELECT ts, kind, scope, extra FROM probe_windows ORDER BY id").all());
      expect(receiver.query("SELECT id, payload FROM probe_counters ORDER BY id").all()).toEqual(
        source.query("SELECT id, payload FROM probe_counters ORDER BY id").all());
    } finally { source.close(true); receiver.close(true); }
  });

  function open(file: string) {
    const sqlite = new Database(file, { create: true });
    applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
    return sqlite;
  }

  function flushAll(sqlite: Database, journalRoot: string, archiveRoot: string) {
    for (let n = 0; n < 8 && pendingGaugeJournalLines(sqlite) > 0; n++) {
      const result = flushGaugeJournal(sqlite, { journalRoot, archiveRoot });
      expect(result.error).toBeNull();
    }
    expect(pendingGaugeJournalLines(sqlite)).toBe(0);
  }

  test("persists extra through probe facts and journal, replays to a fresh DB, and does not duplicate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-claude-share-"));
    temporary.push(root);
    const archiveRoot = path.join(root, "archive");
    const journalRoot = path.join(archiveRoot, "gauges", `${MACHINE}-share-fixture`);
    fs.mkdirSync(archiveRoot, { recursive: true });
    const sourcePath = path.join(root, "source.sqlite");
    const replayPath = path.join(root, "replay.sqlite");
    const parsed = parse(observedPayload());
    const sourceHome = `C:/Users/${LOGIN}/.claude`;
    const readings = parsed.readings.map(reading => ({ ...reading, extra: { ...(reading.extra ?? {}), home: sourceHome } }));
    const weeklyExtra = extraOf(readings, "weekly_all");
    expect(claudeCodeProductShareFromExtra(weeklyExtra)).toEqual(SHARE);
    const declarations = [{ id: "seat", vendor: "claude", machine: MACHINE, login: LOGIN,
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/${MACHINE}`, source_home: sourceHome }];
    const config = splitProbeReaderFixtureConfig(declarations);
    const prepare = (db: Database) => {
      replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [{ provider: "claude", subject: `claude/${MACHINE}`.toLowerCase(),
        value: "seat", from: "2026-09-01T00:00:00.000Z", until: null, origin: "declared",
        firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
      for (let n = 0; n < 20; n++) if (!publishCurrentBatch(db, currentRegistry(config.subscriptions, COLLECTED_AT), COLLECTED_AT, 32, config)) break;
    };

    const source = open(sourcePath);
    configureGaugeJournal(journalRoot, { archiveRoot });
    expect(claudeProbeAdapter.persist(source, readings, {
      target: { subscription: "seat" },
      credentials: { token: "fixture", expires_at: null, subscription_type: "pro" },
      ts: COLLECTED_AT,
      meta: parsed.meta,
    })).toBe(3);
    flushAll(source, journalRoot, archiveRoot);
    const live = source.query(
      "SELECT ts, kind, scope, used_percent, extra FROM probe_windows WHERE provider='claude' AND kind='weekly_all'"
    ).get() as { ts: string; kind: string; scope: string | null; used_percent: number; extra: string };
    expect(live.ts).toBe(COLLECTED_AT);
    expect(live.ts).not.toBe(AS_OF);
    expect(live.used_percent).toBe(24);
    expect(JSON.parse(live.extra)).toEqual(weeklyExtra);
    const fact = source.query("SELECT payload FROM probe_counters WHERE json_extract(payload,'$.kind')='weekly_all'").get() as { payload: string };
    expect(JSON.parse(JSON.parse(fact.payload).extra as string)).toEqual(weeklyExtra);
    const journalFile = path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date()));
    const journalLines = expandProbeJournal(fs.readFileSync(journalFile, "utf8").trim().split("\n"));
    const weeklyJournal = journalLines.find((line) => line.kind === "weekly_all")!;
    expect(weeklyJournal.ts).toBe(COLLECTED_AT);
    expect(JSON.parse(weeklyJournal.extra as string)).toEqual(weeklyExtra);
    expect(weeklyJournal.canonical_probe).toMatchObject({ version: 1 });
    prepare(source);
    expect(readClaudeProbe(source, "seat").find((row) => row.kind === "weekly_all")).toMatchObject({
      percent: 24, resets_at: RESETS_AT, product_share: SHARE,
    });
    source.close();

    open(replayPath).close();
    const first = (await ingestGaugesAsync({ atlasPath: replayPath, archiveRoot, ownStore: "not-this-machine", force: false }));
    const replay = new Database(replayPath);
    expect(first.rows).toBe(3);
    expect(first.malformed).toBe(0);
    const replayed = replay.query(
      "SELECT ts, used_percent, extra FROM probe_windows WHERE provider='claude' AND kind='weekly_all'"
    ).get() as { ts: string; used_percent: number; extra: string };
    expect(replayed.ts).toBe(COLLECTED_AT);
    expect(replayed.used_percent).toBe(24);
    expect(JSON.parse(replayed.extra)).toEqual(weeklyExtra);
    expect(claudeCodeProductShareFromExtra(replayed.extra)).toEqual(SHARE);
    const replayFact = replay.query("SELECT payload FROM probe_counters WHERE json_extract(payload,'$.kind')='weekly_all'").get() as { payload: string };
    expect(JSON.parse(JSON.parse(replayFact.payload).extra as string)).toEqual(weeklyExtra);
    prepare(replay);
    expect(readClaudeProbe(replay, "seat").find((row) => row.kind === "weekly_all")?.product_share).toEqual(SHARE);
    const second = (await ingestGaugesAsync({ atlasPath: replayPath, archiveRoot, ownStore: "not-this-machine", force: true }));
    expect(second.rows).toBe(0);
    expect(replay.query("SELECT count(*) n FROM probe_windows WHERE provider='claude'").get()).toEqual({ n: 3 });
    replay.close();

    const reopened = new Database(replayPath);
    expect(readClaudeProbe(reopened, "seat").find((row) => row.kind === "weekly_all")).toEqual({
      ts: COLLECTED_AT, kind: "weekly_all", scope_label: null, percent: 24, resets_at: RESETS_AT,
      product_share: SHARE, product_breakdown: BREAKDOWN_DECODED,
    });
    reopened.close();
  });
});

describe("Claude weekly surface breakdown", () => {
  test("keeps every surface row, not only Claude Code", () => {
    expect(parseClaudeProductBreakdown(observedPayload())?.rows.map((row) => [row.key, row.percent])).toEqual([
      ["claude_code", 12],
      ["chat", 0],
      ["cowork", 0],
      ["other", 88],
    ]);
  });

  test("an ambiguous or unusable breakdown is dropped whole rather than partially believed", () => {
    const cases: unknown[] = [
      { ...BREAKDOWN, rows: [...BREAKDOWN.rows, { key: "cowork", display_name: "Cowork", percent: 5 }] },
      { ...BREAKDOWN, rows: [...BREAKDOWN.rows, { key: "Claude Code", percent: 5 }] },
      { ...BREAKDOWN, rows: [...BREAKDOWN.rows, { key: "surface", percent: 101 }] },
      { ...BREAKDOWN, rows: [...BREAKDOWN.rows, { display_name: "No key", percent: 5 }] },
      { ...BREAKDOWN, rows: [] },
      { ...BREAKDOWN, window_started_at: "not-a-date" },
    ];
    for (const seven_day_breakdown of cases) {
      expect(parseClaudeProductBreakdown(observedPayload({ seven_day_breakdown }))).toBeNull();
    }
  });

  test("a breakdown from another window is parsed but never attached to this one", () => {
    const foreign = { ...BREAKDOWN, as_of: "2026-09-12T00:00:00.000Z", window_started_at: "2026-09-06T10:59:59.225126+00:00" };
    const parsed = parse(observedPayload({ seven_day_breakdown: foreign }));
    expect(parseClaudeProductBreakdown(observedPayload({ seven_day_breakdown: foreign }))).not.toBeNull();
    expect(parsed.meta.product_breakdown).toBeNull();
    expect(breakdownKeys(extraOf(parsed.readings, "weekly_all"))).toEqual([]);
  });
});

describe("Claude raw usage meters", () => {
  // Shape observed on 2026-09-22: most meters are dormant nulls, a few are live.
  const dormantAndLive = {
    seven_day_opus: null,
    seven_day_oauth_apps: null,
    nimbus_quill: { utilization: 0, resets_at: null, limit_dollars: null, locked_reason: null },
    extra_usage: { is_enabled: false, monthly_limit: null, user_disabled: true, daily: null },
    spend: {
      used: { amount_minor: 0, currency: "USD", exponent: 2 },
      percent: 0,
      enabled: false,
      disclaimer: "Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com)",
    },
    member_dashboard_available: false,
  };

  test("keeps every live meter on the account weekly bar only, skipping nulls and prose", () => {
    const parsed = parse(observedPayload(dormantAndLive));
    const weekly = extraOf(parsed.readings, "weekly_all")!;
    const raw = Object.fromEntries(Object.entries(weekly).filter(([key]) => key.startsWith(CLAUDE_RAW_USAGE_PREFIX)));
    expect(raw).toEqual({
      "claude.raw.five_hour.utilization": 5,
      "claude.raw.five_hour.resets_at": "2026-09-17T05:59:59.225126+00:00",
      "claude.raw.seven_day.utilization": 24,
      "claude.raw.seven_day.resets_at": RESETS_AT,
      "claude.raw.nimbus_quill.utilization": 0,
      "claude.raw.extra_usage.is_enabled": false,
      "claude.raw.extra_usage.user_disabled": true,
      "claude.raw.spend.used.amount_minor": 0,
      "claude.raw.spend.used.currency": "USD",
      "claude.raw.spend.used.exponent": 2,
      "claude.raw.spend.percent": 0,
      "claude.raw.spend.enabled": false,
      "claude.raw.member_dashboard_available": false,
    });
    for (const [kind, scope] of [["session", null], ["weekly_scoped", "Sonnet"]] as const) {
      expect(Object.keys(extraOf(parsed.readings, kind, scope) ?? {}).some((key) => key.startsWith(CLAUDE_RAW_USAGE_PREFIX))).toBe(false);
    }
    // Decoded parts are not duplicated, and the share contract is unchanged.
    expect(Object.keys(raw).some((key) => key.includes("limits") || key.includes("breakdown"))).toBe(false);
    expect(claudeCodeProductShareFromExtra(weekly)).toEqual(SHARE);
    expect(claudeProductBreakdownFromExtra(weekly)).toEqual(BREAKDOWN_DECODED);
  });

  test("a newly enabled meter is preserved before any parser knows it", () => {
    const weekly = extraOf(parse(observedPayload({
      seven_day_opus: { utilization: 41, resets_at: RESETS_AT, used_dollars: 12.5 },
    })).readings, "weekly_all");
    expect(weekly).toMatchObject({
      "claude.raw.seven_day_opus.utilization": 41,
      "claude.raw.seven_day_opus.resets_at": RESETS_AT,
      "claude.raw.seven_day_opus.used_dollars": 12.5,
    });
  });

  test("raw meters survive a rejected product share", () => {
    const weekly = extraOf(parse(observedPayload({ seven_day_breakdown: null, nimbus_quill: { utilization: 3 } })).readings, "weekly_all");
    expect(claudeCodeProductShareFromExtra(weekly)).toBeNull();
    expect(weekly).toMatchObject({ "claude.raw.nimbus_quill.utilization": 3 });
  });
});

describe("account meters of a stored reading", () => {
  test("lists live meters without windows and the paid usage beyond the plan", () => {
    const weekly = extraOf(parse(observedPayload({
      iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 },
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, user_disabled: true },
      spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 } },
    })).readings, "weekly_all")!;
    const decoded = decodeClaudeAccountMeters(weekly, COLLECTED_AT);
    // Five-hour and seven-day meters have limit windows, so they are not repeated here.
    expect(decoded.meters).toEqual([
      { key: "iguana_necktie", utilization_percent: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 },
      { key: "nimbus_quill", utilization_percent: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
    ]);
    expect(decoded.extra_usage).toEqual({ enabled: false, user_disabled: true, spent_minor: 0, currency: "USD", exponent: 2 });
    expect(decoded.read_at).toBe(COLLECTED_AT);
  });

  test("a reading without raw fields has no meters", () => {
    expect(decodeClaudeAccountMeters({ severity: "normal" }, COLLECTED_AT)).toEqual({ read_at: COLLECTED_AT, meters: [], extra_usage: null });
  });
});
