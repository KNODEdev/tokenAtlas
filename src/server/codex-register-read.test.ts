import { registerFreshness } from "../db/read-freshness";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadAccountResolver } from "./account-resolver";
const ARCHIVE_HOME = `${ARCHIVE_LOGICAL_ROOT}/codex/test`;
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { indexSubscriptionHomes, codexSourceHomes } from "./capacity-equivalents";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { codexUsagePriceReadiness, usagePriceSourcesStamp } from "../db/usage-price-read-subscription";
import { readCodexRegisterDays, readCodexMeterModels,
  sumCodexRegisterAmounts } from "../db/usage-price-read-codex";
import rateCards from "../../rate-cards.json";
import type { RateCard } from "./pricing";

const card = rateCards as unknown as RateCard;
const declarations = [{ id: "acct", vendor: "codex", home: ARCHIVE_HOME, source_home: "live", from: "2026-01-01" }];
const SPARK = "gpt-5.3-codex-spark";

interface Row {
  home: string; path: string; ts: string; model: string; speed: string | null;
  in_tok: number; cached_in: number; cache_write: number; out_tok: number;
  meter_reset: number | null; billing_mode: string;
}

/** A mirrored rollout, a live-only rollout and an archive-only rollout, over several days. */
function events(): Row[] {
  const rows: Row[] = [];
  const push = (home: string, name: string, day: number, hour: number, patch: Partial<Row> = {}) =>
    rows.push({ home, path: `${home}/sessions/${name}.jsonl`,
      ts: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
      model: "gpt-5.3-codex", speed: "standard", in_tok: 1000 + hour * 10, cached_in: 0,
      cache_write: 0, out_tok: 200 + hour, meter_reset: null, billing_mode: "subscription", ...patch });
  for (const day of [6, 9, 12, 15, 20]) {
    // The mirrored pair: identical on most days, and the live copy pulls ahead on one, so the
    // winner genuinely depends on which days the range covers.
    push("live", "shared", day, 9, { meter_reset: 1_700_000_000 });
    push(ARCHIVE_HOME, "shared", day, 9, { meter_reset: 1_700_000_000 });
    if (day === 6) push("live", "shared", day, 11, { model: SPARK, speed: "fast" });
    if (day === 20) push(ARCHIVE_HOME, "shared", day, 13, { out_tok: 5_000 });
    push("live", "solo", day, 10, { meter_reset: 1_700_600_000 });
    push(ARCHIVE_HOME, "kept", day, 8, { speed: null, billing_mode: "business_credits" });
  }
  // An unusable counter and a spark-only rollout, to exercise both meter-model flags.
  push("live", "broken", 12, 7, { in_tok: 5, cached_in: 9, cache_write: 0 });
  push("live", "sparkonly", 12, 6, { model: SPARK, meter_reset: 1_700_300_000 });
  return rows;
}

function fixture(): { db: Database; homes: Map<string, string>; scope: string } {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,source_offset INTEGER,
    home TEXT NOT NULL,path TEXT NOT NULL,ts TEXT NOT NULL,model TEXT,speed TEXT,billing_mode TEXT,
    project_id TEXT,repo TEXT,surface TEXT,nested TEXT,meter_reset INTEGER,plan_type TEXT,account_id TEXT,
    in_tok INTEGER NOT NULL,cached_in INTEGER NOT NULL,cache_write INTEGER NOT NULL,out_tok INTEGER NOT NULL,
    reasoning_out INTEGER,cache_write_status TEXT,usage_status TEXT);
    CREATE INDEX events_ts ON events(ts);`);
  const insert = db.prepare(`INSERT INTO events(source_offset,home,path,ts,model,speed,billing_mode,project_id,
    surface,meter_reset,in_tok,cached_in,cache_write,out_tok,reasoning_out,cache_write_status,usage_status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'known','complete')`);
  let offset = 0;
  for (const row of events()) {
    insert.run(offset++, row.home, row.path, row.ts, row.model, row.speed, row.billing_mode, "p1",
      "chat", row.meter_reset, row.in_tok, row.cached_in, row.cache_write, row.out_tok, 17);
  }
  db.exec("INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,readings,evidence) VALUES('codex','codex/test','acct','2024-01-01T00:00:00Z',NULL,'declared',0,'test')");
  installAnalysisTracking(db);
  const homes = indexSubscriptionHomes(declarations);
  prepareCodexLedgerFixture(db, card, homes);
  const readiness = codexUsagePriceReadiness(db, {
    rulesRevision: codexLedgerReadContext(card).rulesRevision,
    sourcesStamp: usagePriceSourcesStamp(codexSourceHomes(homes),declarations,ARCHIVE_LOGICAL_ROOT) });
  expect(readiness.state).toBe("ready");
  return { db, homes, scope: readiness.head!.scope };
}

const RANGES = [
  { label: "report range", since: "2026-09-09", until: "2026-09-15" },
  { label: "cycle-expanded range", since: "2026-09-02", until: "2026-09-22" },
  { label: "single day", since: "2026-09-20", until: "2026-09-20" },
];
/**
 * The two copies of `shared` diverge (offsets differ, and each holds one call the other lacks): their common
 * calls match by fingerprint and count once; a call present in only one copy is a conflict, not usage.
 */
function canonicalEvents(range: { since: string; until: string }): Row[] {
  const toExclusive = new Date(Date.parse(range.until) + 86400000).toISOString().slice(0, 10);
  const inRange = events().filter(row => row.ts >= range.since && row.ts < toExclusive);
  const shared = (row: Row) => row.path.endsWith("/sessions/shared.jsonl");
  const key = (row: Row) => JSON.stringify([row.ts, row.model, row.in_tok, row.out_tok, row.meter_reset]);
  const archived = new Set(inRange.filter(row => shared(row) && row.home !== "live").map(key));
  return inRange.filter(row => !shared(row) || row.home === "live" && archived.has(key(row)));
}

test("duplicate copies are resolved at build time: every range counts each call once and the rest is excluded", () => {
  const { db, scope } = fixture();
  try {
    for (const range of RANGES) {
      const rows = readCodexRegisterDays(db, scope, range, loadAccountResolver(db));
      const reference = canonicalEvents(range);
      const kept = rows.filter(row => row.selected);
      expect({ range: range.label, calls: kept.reduce((sum, row) => sum + row.calls, 0) }).toEqual({ range: range.label, calls: reference.length });
      expect(kept.reduce((sum, row) => sum + row.tokensReported, 0)).toBe(reference.reduce((sum, row) => sum + row.in_tok + row.out_tok, 0));
      // Duplicate and conflicting copies are returned too, because the report publishes them as excluded.
      const toExclusive = new Date(Date.parse(range.until) + 86400000).toISOString().slice(0, 10);
      const excluded = rows.filter(row => !row.selected).reduce((sum, row) => sum + row.calls, 0);
      expect(excluded).toBe(events().filter(row => row.ts >= range.since && row.ts < toExclusive).length - reference.length);
      expect(excluded).toBeGreaterThan(0);
      // `reasoning_out` is nested inside `out_total`, so it is reported beside the buckets.
      expect(kept.reduce((sum, row) => sum + (row.tokens.reasoning_out ?? 0), 0)).toBe(reference.length * 17);
      const api = sumCodexRegisterAmounts(kept.map(row => row.variants.api_standard));
      expect(Number(api.pricedSubtotal)).toBeGreaterThan(0);
      expect(BigInt(api.pricedEvents) + BigInt(api.unpricedEvents)).toBe(BigInt(reference.length));
    }
    const states = db.query("SELECT copy_state,COUNT(*) n FROM codex_price_ledger_events GROUP BY copy_state ORDER BY copy_state").all();
    expect(states).toEqual([{ copy_state: "canonical", n: 17 }, { copy_state: "conflict", n: 2 }, { copy_state: "duplicate", n: 5 }]);
  } finally { db.close(); }
});

test("meter models reproduce the report's spark and main evidence per path and reset", () => {
  const { db, scope } = fixture();
  try {
    const range = { since: "2026-09-01", until: "2026-09-30" };
    const actual = new Map<string, { spark: boolean; main: boolean }>();
    for (const row of readCodexMeterModels(db, scope, range,loadAccountResolver(db))) {
      const key = JSON.stringify(row.meter_reset === -1 ? [row.home, row.path] : [row.home, row.path, row.meter_reset]);
      const current = actual.get(key) ?? { spark: false, main: false };
      current.spark ||= row.spark; current.main ||= row.main;
      actual.set(key, current);
    }
    // The same rule `collectDay` applies: every event feeds its path, and an event that
    // declares a meter reset also feeds that reset.
    const expected = new Map<string, { spark: boolean; main: boolean }>();
    for (const row of events()) {
      const keys = [JSON.stringify([row.home, row.path]),
        ...(row.meter_reset != null ? [JSON.stringify([row.home, row.path, row.meter_reset])] : [])];
      for (const key of keys) {
        const current = expected.get(key) ?? { spark: false, main: false };
        if (row.model === SPARK) current.spark = true; else if (row.model && row.model !== "?") current.main = true;
        expected.set(key, current);
      }
    }
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(actual.get(JSON.stringify(["live", "live/sessions/sparkonly.jsonl"])))
      .toEqual({ spark: true, main: false });
  } finally { db.close(); }
});

test("a published register behind its inputs stays readable, marked pending; a rate card change is its own state", () => {
  const { db, homes } = fixture();
  try {
    // The price ledger's rules identity is its published rules revision.
    const stamps = { rulesRevision: codexLedgerReadContext(card).rulesRevision,
      sourcesStamp: usagePriceSourcesStamp(codexSourceHomes(homes),declarations,ARCHIVE_LOGICAL_ROOT) };
    expect(codexUsagePriceReadiness(db, stamps).state).toBe("ready");
    // A changed rate card is its own explicit state, distinct from an unread journal.
    expect(codexUsagePriceReadiness(db, { ...stamps, rulesRevision: "other" }).reason).toBe("usage-price-rules-pending");
    db.query(`INSERT INTO events(source_offset,home,path,ts,model,speed,billing_mode,
      in_tok,cached_in,cache_write,out_tok) VALUES(999,'live','live/sessions/solo.jsonl',
      '2026-09-21T09:00:00Z','gpt-5.3-codex','standard','subscription',1000,0,0,100)`).run();
    // Publication advances the Codex data revision with the rows; the ledger has not read it yet.
    db.query("INSERT INTO vendor_sync_revisions(vendor,data_revision,updated_at) VALUES('codex',1,'2026-09-21T09:00:01Z')").run();
    expect(codexUsagePriceReadiness(db, stamps).state).toBe("ready");
    expect(registerFreshness(db, "codex")).toMatchObject({ published: true, pending: true });
  } finally { db.close(); }
});
