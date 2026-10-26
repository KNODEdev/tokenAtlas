import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "./migrate";
import { installAnalysisTracking } from "./analysis";
import { compareDays, fillUsageLedger, ledgerDays, referenceDays } from "../server/usage-ledger.fixture";
import { usageLedgerState } from "../server/usage-ledger-producer";
import type { RateCard } from "../server/pricing";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dir, "../..");
const PRE_W9 = "a74fad86cf609bfac05054eb74718fd613d91da5";
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

function command(args: string[], cwd: string): void {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
}

test("a pre-W9 database upgrades to the usage ledger and one later correction stays incremental", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-w9-price-upgrade-"));
  const oldRoot = path.join(root, "pre-w9"), dbFile = path.join(root, "register.sqlite");
  const archiveRoot = path.join(root, "archive"), dumpFile = path.join(root, "pre-w9.json");
  const dependencies = path.join(oldRoot, "node_modules");
  let db: Database | null = null;
  try {
    fs.mkdirSync(oldRoot);
    fs.mkdirSync(archiveRoot);
    const tar = path.join(root, "pre-w9.tar");
    command(["git", "archive", "--format=tar", `--output=${tar}`, PRE_W9, "src", "drizzle", "rate-cards.json", "package.json"], REPO);
    // GNU tar treats a drive-letter archive path as a remote host. Both paths are local to root.
    command(["tar", "-xf", "pre-w9.tar", "-C", "pre-w9"], root);
    fs.symlinkSync(path.join(REPO, "node_modules"), dependencies, process.platform === "win32" ? "junction" : "dir");
    const script = path.join(oldRoot, "seed.ts");
    fs.writeFileSync(script, `import {Database} from "./src/db/sqlite";
      import {drizzle} from "drizzle-orm/bun-sqlite";
      import {applyDrizzleMigrations} from "./src/db/migrate";
      import {installAnalysisTracking} from "./src/db/analysis";
      import {prepareSubscriptionFacts} from "./src/db/subscription-facts";
      import {prepareUsagePriceTotals} from "./src/db/usage-price-totals";
      import fs from "node:fs"; import path from "node:path";
      const db=new Database(${JSON.stringify(dbFile)}), archiveRoot=${JSON.stringify(archiveRoot)};
      const events=${JSON.stringify(EVENTS)}, rates=${JSON.stringify(RATES)};
      try { applyDrizzleMigrations(drizzle(db)); installAnalysisTracking(db);
        for(const account of ["selected","foreign"]) db.query("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('claude',?,'2020-01-01',?,'declared','test')").run("claude/"+account,account);
        for(const event of events) db.query("INSERT INTO claude_events(store,call_id,path,ts,model,in_uncached,out_total) VALUES(?,?,?,?,?,?,0)").run(event.account,event.call,path.join(archiveRoot,"claude",event.account,"session.jsonl"),event.ts,"fixture",event.input);
        for(let n=0;n<100;n++) if(prepareSubscriptionFacts(db,"claude",archiveRoot,100).complete) break;
        let ready=false; for(let n=0;n<100;n++){const result=prepareUsagePriceTotals(db,"claude",{rates,archiveRoot},{limit:100});if(result.reason)throw Error(result.reason);if(result.complete){ready=true;break;}}
        if(!ready)throw Error("old register did not settle");
        const values=db.query("SELECT provider,identity,variant,day,facts_stamp,rules_stamp,source_stamp,value FROM event_valuations ORDER BY provider,identity,variant").all();
        const days=db.query("SELECT d.day,m.home AS source,d.calls,d.tokens,d.tokens_reported,d.counts,d.quality FROM usage_price_days d JOIN usage_price_dims m USING(scope,dim) ORDER BY d.day,m.home,d.counts").all();
        fs.writeFileSync(${JSON.stringify(dumpFile)},JSON.stringify({values,days}));
      } finally {db.close();}`);
    const child = Bun.spawnSync([process.execPath, script], { cwd: oldRoot,
      env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_DB: dbFile,
        TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_LOCAL_STATE: path.join(root, "state") },
      stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    expect(child.exitCode).toBe(0);
    const old = JSON.parse(fs.readFileSync(dumpFile, "utf8")) as { values: unknown[]; days: unknown[] };
    expect(old.values.length).toBeGreaterThan(0);
    expect(old.days.length).toBeGreaterThan(0);
    db = new Database(dbFile);
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
    if (fs.existsSync(dependencies)) fs.unlinkSync(dependencies);
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(temporary)) throw new Error("Temporary fixture escaped its root");
    Bun.gc(true);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60000);
