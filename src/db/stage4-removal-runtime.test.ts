import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateDrizzle } from "drizzle-orm/bun-sqlite/migrator";
import { migrationFixtureThrough } from "./migration-range.fixture";
import { applyDrizzleMigrations } from "./migrate";
import { installAnalysisTracking } from "./analysis";
import { compareDays, fillUsageLedger, ledgerDays, referenceDays } from "../server/usage-ledger.fixture";
import { usageLedgerState } from "../server/usage-ledger-producer";
import type { RateCard } from "../server/pricing";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EVENTS = [
  { account: "selected", call: "selected-one", ts: "2026-09-01T12:00:00.000Z", input: 1_000_000 },
  { account: "selected", call: "selected-two", ts: "2026-09-02T12:00:00.000Z", input: 2_000_000 },
  { account: "foreign", call: "foreign-one", ts: "2026-09-01T13:00:00.000Z", input: 9_000_000 },
] as const;
const RATES: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  anthropic: { models: { fixture: { in_uncached: 1, in_cache_read: 0.1,
    in_cache_write_5m: 1.25, in_cache_write_1h: 2, out_total: 3 } } },
} } as RateCard;

/** Every table of the old register, the fact index and the valuation cache that migration 0047 drops. */
const legacyTables = (db: Database) => db.query(`SELECT name FROM sqlite_master WHERE type='table'
  AND (name GLOB 'usage_price_*' OR name GLOB 'subscription_fact_*' OR name='event_valuations')
  ORDER BY name`).all();
const facts = (db: Database) => db.query(`SELECT * FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all() as
  Array<{ source: string; row_id: number }>;
const foreignFacts = (db: Database) => facts(db).filter(row => row.source === "claude/foreign");

function seed(db: Database, archiveRoot: string, corrected: boolean): void {
  installAnalysisTracking(db);
  for (const account of ["selected", "foreign"]) db.query(`INSERT INTO account_periods
    (provider,source,from_ts,account,origin,evidence) VALUES('claude',?,'2020-01-01',?,'declared','test')`)
    .run(`claude/${account}`, account);
  for (const event of EVENTS) db.query(`INSERT INTO claude_events
    (store,call_id,path,ts,model,in_uncached,out_total) VALUES(?,?,?,?,?,?,0)`)
    .run(event.account, event.call, path.join(archiveRoot, "claude", event.account, "session.jsonl"),
      event.ts, "fixture", corrected && event.call === "selected-one" ? 1_500_000 : event.input);
}

function prepare(db: Database, archiveRoot: string): void {
  fillUsageLedger(db, "claude", RATES, archiveRoot, 100);
}

test("a pre-W9 database upgrades to the usage ledger and one later correction stays incremental", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-w9-price-upgrade-"));
  const dbFile = path.join(root, "register.sqlite"), archiveRoot = path.join(root, "archive");
  let db: Database | null = null;
  try {
    fs.mkdirSync(archiveRoot);
    db = new Database(dbFile);
    migrateDrizzle(drizzle(db), { migrationsFolder: migrationFixtureThrough(root, "0040_account_periods") });
    seed(db, archiveRoot, false);
    // Freeze a populated retired register independently of the replacement producer and private Git history.
    const scope = "usage-price-8-claude";
    db.query("INSERT INTO usage_price_scopes(scope,provider,version,cursor,phase,status,bookmark,rules_digest,sources,attribution,mirror_policy) VALUES(?,'claude',8,3,'replay','ready','','fixture','fixture','',1)").run(scope);
    for (const event of EVENTS) {
      db.query("INSERT OR IGNORE INTO usage_price_dims(scope,dim,account,home,model,speed) VALUES(?,?,?,?,'fixture','standard')")
        .run(scope,event.account,event.account,"claude/"+event.account);
      db.query("INSERT INTO usage_price_days(scope,day,dim,calls,first_ts,last_ts,tokens,tokens_reported,counts,quality) VALUES(?,?,?,1,?,?,?,?,'{}','{}')")
        .run(scope,event.ts.slice(0,10),event.account,event.ts,event.ts,JSON.stringify([event.input]),JSON.stringify([event.input]));
      db.query("INSERT INTO event_valuations(provider,identity,variant,day,facts_stamp,rules_stamp,source_stamp,value) VALUES('claude',?,'dated-actual-api',?,'fixture','fixture','fixture',?)")
        .run(JSON.stringify([event.account,event.call]),event.ts.slice(0,10),JSON.stringify({usd:event.input/1_000_000}));
    }
    const old = { values: db.query("SELECT value FROM event_valuations").all() as Array<{value:string}>,
      days: db.query("SELECT * FROM usage_price_days").all() };
    expect(old.values.length).toBeGreaterThan(0);
    expect(old.days.length).toBeGreaterThan(0);
    expect(old.values.reduce((sum,row)=>sum+JSON.parse(row.value).usd,0)).toBe(12);
    applyDrizzleMigrations(drizzle(db));
    // The old register is dropped with its data; the ledger values the retained source rows.
    expect(legacyTables(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) n FROM claude_events").get()).toEqual({ n: EVENTS.length });
    expect(usageLedgerState(db, "claude")).toBeNull();
    prepare(db, archiveRoot);
    const upgraded = ledgerDays(db, "claude");
    expect(upgraded.size).toBeGreaterThan(0);
    expect(compareDays(upgraded, referenceDays(db, "claude", RATES, archiveRoot))).toEqual([]);
    const settled = usageLedgerState(db, "claude")!;
    expect(settled.status).toBe("ready");
    const retained = foreignFacts(db);
    expect(retained.length).toBeGreaterThan(0);
    // A restart with nothing changed finds nothing to do.
    db.close();
    db = new Database(dbFile);
    prepare(db, archiveRoot);
    expect(usageLedgerState(db, "claude")).toEqual(settled);
    expect(ledgerDays(db, "claude")).toEqual(upgraded);
    db.query("UPDATE claude_events SET in_uncached=1500000 WHERE call_id='selected-one'").run();
    prepare(db, archiveRoot);
    expect(foreignFacts(db)).toEqual(retained);
    const correctedHead = usageLedgerState(db, "claude")!;
    expect(correctedHead.covered).toBeGreaterThan(settled.covered);
    expect(correctedHead.revision).toBeGreaterThan(settled.revision);
    expect(correctedHead.status).toBe("ready");
    const corrected = ledgerDays(db, "claude");
    expect(corrected).not.toEqual(upgraded);
    const reference = new Database(":memory:");
    try {
      applyDrizzleMigrations(drizzle(reference));
      seed(reference, archiveRoot, true);
      prepare(reference, archiveRoot);
      expect(corrected).toEqual(ledgerDays(reference, "claude"));
    } finally { reference.close(); }
  } finally {
    db?.close();
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporary)) throw new Error("Temporary fixture escaped its root");
    Bun.gc(true);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60000);
