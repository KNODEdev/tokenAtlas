import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareGlobalFixture } from "./global-usage.fixture";
const ARCHIVE_HOME=`${ARCHIVE_LOGICAL_ROOT}/codex/test`;
import { expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { buildEraIndex } from "./eras";
import { indexSubscriptionHomes, codexSourceHomes } from "./capacity-equivalents";
import { buildGlobalUsage } from "./global-usage";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import rateCards from "../../rate-cards.json";
import type { RateCard } from "./pricing";

const card = rateCards as unknown as RateCard;
const declarations = [{ id: "acct", vendor: "codex", home: ARCHIVE_HOME, source_home: "live", from: "2025-01-01" }];
const RANGE = { since: "2026-09-01", until: "2026-09-10" };

interface Shape {
  model: string; speed: string | null; in_tok: number; cached_in: number; cache_write: number;
  out_tok: number; nested?: string; billing_mode?: string;
}
const SHAPES: Shape[] = [
  { model: "gpt-6-astra", speed: "standard", in_tok: 100_000, cached_in: 80_000, cache_write: 0, out_tok: 10_000 },
  { model: "gpt-6-astra", speed: "fast", in_tok: 50_000, cached_in: 0, cache_write: 0, out_tok: 4_000 },
  { model: "gpt-5.3-codex", speed: "standard", in_tok: 60_000, cached_in: 1_000, cache_write: 5_000, out_tok: 4_000 },
  { model: "gpt-5.4-mini", speed: "standard", in_tok: 40_000, cached_in: 0, cache_write: 0, out_tok: 3_000 },
  { model: "gpt-5.3-codex", speed: null, in_tok: 20_000, cached_in: 0, cache_write: 0, out_tok: 1_500 },
  // The two records global usage counts as internal traffic instead of pricing it.
  { model: "codex-auto-review", speed: "standard", in_tok: 7_000, cached_in: 0, cache_write: 0, out_tok: 500 },
  { model: "gpt-6-astra", speed: "standard", in_tok: 9_000, cached_in: 0, cache_write: 0, out_tok: 600, nested: "guardian_review" },
  { model: "gpt-5.5", speed: "fast", in_tok: 25_000, cached_in: 0, cache_write: 0, out_tok: 2_000, billing_mode: "business_credits" },
];

function fixture(withRegister: boolean, invalidRow = false): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,source_offset INTEGER,home TEXT NOT NULL,
    path TEXT NOT NULL,ts TEXT NOT NULL,model TEXT,speed TEXT,billing_mode TEXT,project_id TEXT,repo TEXT,
    surface TEXT,nested TEXT,meter_reset INTEGER,plan_type TEXT,account_id TEXT,in_tok INTEGER NOT NULL,
    cached_in INTEGER NOT NULL,cache_write INTEGER NOT NULL,out_tok INTEGER NOT NULL,reasoning_out INTEGER,
    cache_write_status TEXT,usage_status TEXT);
    CREATE INDEX events_ts ON events(ts);`);
  const insert = db.prepare(`INSERT INTO events(source_offset,home,path,ts,model,speed,billing_mode,surface,nested,
    in_tok,cached_in,cache_write,out_tok,reasoning_out,cache_write_status,usage_status)
    VALUES(?,?,?,?,?,?,?,'chat',?,?,?,?,?,7,'known','complete')`);
  let offset = 0;
  const add = (home: string, file: string, ts: string, shape: Shape) => {
    insert.run(offset++, home, file, ts, shape.model, shape.speed, shape.billing_mode ?? "subscription",
      shape.nested ?? null, shape.in_tok, shape.cached_in, shape.cache_write, shape.out_tok);
  };
  for (let day = 1; day <= 10; day++) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    SHAPES.forEach((shape, index) => {
      const mirrored = index % 3 === 0;
      for (const home of mirrored ? ["live", ARCHIVE_HOME] : ["live"])
        add(home, `${home}/sessions/${date}-${mirrored ? "shared" : `s${index}`}.jsonl`,
          `${date}T${String(1 + index).padStart(2, "0")}:05:00Z`, shape);
    });
  }
  // A record whose cache counters exceed its input: the pre-register path refused the whole report.
  if (invalidRow) add("live", "live/sessions/broken.jsonl", "2026-09-05T23:00:00Z",
    { model: "gpt-6-astra", speed: "standard", in_tok: 10, cached_in: 900, cache_write: 0, out_tok: 5 });
  db.exec("INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,readings,evidence) VALUES('codex','codex/test','acct','2024-01-01T00:00:00Z',NULL,'declared',0,'test')");
  installAnalysisTracking(db);
  if (!withRegister) return db;
  prepareGlobalFixture(db,card,declarations,200);
  return db;
}

const usage = (db: Database) => buildGlobalUsage({ sqlite: db, rateCards: card,
  homeToSubId: indexSubscriptionHomes(declarations), accounts:{subscriptions:declarations}, eras: buildEraIndex(declarations) },
  { ...RANGE, vendors: ["codex"] });

test("global usage is identical across batch sizes and reads the Codex register without changing a row", () => {
  const legacy = fixture(false), registered = fixture(true);
  try {
    prepareGlobalFixture(legacy,card,declarations,10000);
    const before = usage(legacy), after = usage(registered);
    expect({ rows: before.rows.length > 0, excluded: before.excluded_duplicates > 0,
      internal: before.rows.some(row => (row.internal_tokens ?? 0) > 0) })
      .toEqual({ rows: true, excluded: true, internal: true });
    for (const [index, row] of after.rows.entries()) {
      const expected = before.rows[index]!;
      expect({ index, ...row, api_usd: null, credits: null })
        .toEqual({ index, ...expected, api_usd: null, credits: null });
      for (const measure of ["api_usd", "credits"] as const) {
        expect({ index, measure, priced: row[measure].priced_calls, unpriced: row[measure].unpriced_calls })
          .toEqual({ index, measure, priced: expected[measure].priced_calls, unpriced: expected[measure].unpriced_calls });
        // Exact decimal sums round differently from a running double, and no further.
        expect(Math.abs(row[measure].subtotal - expected[measure].subtotal))
          .toBeLessThanOrEqual(Math.max(1e-9, Math.abs(expected[measure].subtotal) * 1e-9));
      }
    }
    expect({ rows: after.rows.length, events: after.sources[0]!.events, excluded: after.excluded_duplicates })
      .toEqual({ rows: before.rows.length, events: before.sources[0]!.events, excluded: before.excluded_duplicates });
  } finally { legacy.close(); registered.close(); }
});

test("a record with impossible cache counters no longer fails the whole global report", () => {
  const legacy = fixture(false, true), registered = fixture(true, true);
  try {
    expect(() => usage(legacy)).toThrow(SubscriptionFactsPending);
    const after = usage(registered);
    // The register clamps the unusable counter to zero and records the row's quality instead,
    // exactly as the Codex accounting report has always treated it.
    const broken = after.rows.find(row => row.day === "2026-09-05" && row.model === "gpt-6-astra");
    expect(broken).toBeDefined();
    expect(after.sources[0]!.events).toBeGreaterThan(0);
  } finally { legacy.close(); registered.close(); }
});

test("a register that exists but is behind states its preparation instead of scanning events",()=>{
  const db = fixture(true);
  try {
    expect(usage(db).rows.length).toBeGreaterThan(0);
    // The native publication exists but has not caught up with its source revision.
    db.query("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'").run();
    const query = db.query.bind(db), seen: string[] = [];
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => { seen.push(sql); return query(sql); }) as typeof db.query);
    try { expect(() => usage(db)).toThrow(SubscriptionFactsPending); } finally { spy.mockRestore(); }
    // No per-event pass: the answer is a state, not a slower report.
    expect(seen.some(sql => /FROM events e/i.test(sql))).toBe(false);
    // A database the register never ran on keeps the pre-register path until WP4f.
    const legacy = fixture(false);
    try { expect(() => usage(legacy)).toThrow(SubscriptionFactsPending); } finally { legacy.close(); }
  } finally { db.close(); }
});
