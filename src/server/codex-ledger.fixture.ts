import { projectRulesFromRawRows } from "../projects/rules.fixture";
import type { Database } from "../db/sqlite";
import { Database as FixtureDatabase } from "../db/sqlite";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { readCodexEventRange } from "./codex-priced-events";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { codexHomeSource } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { RateCard } from "./pricing";
import type { CodexAccountingConfig, CodexAccountingEvent } from "./codex-accounting-pricing";
import type { SourceDeclaration } from "./archive-source";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { installAnalysisTracking } from "../db/analysis";
import { enqueueCodexLedgerRuleChanges, processCodexLedgerBatch } from "../db/codex-ledger-producer";
import { CODEX_LEDGER_PROVIDER, readCodexLedgerState } from "../db/codex-ledger-state";
import { ensureUsageLedgerSchema } from "../db/usage-ledger";
import type { LedgerBaseBand } from "../db/codex-price-ledger";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";
import { installFactDayRevisions } from "../db/fact-day-revisions";

/**
 * Fills an empty ledger (schema created) from `events` through the production producer and drains
 * it until ready. A fixture has no archive binding: `sourceOf` (else the home) stands for the
 * declared source and the physical path for the archive-relative one.
 */
export function fillCodexLedgerFixture(db: Database, options: { bands: readonly LedgerBaseBand[]; policy?: CodexLedgerPolicy;
  factsRevision: number; rulesRevision: string; sourceOf?: (home: string | null, path: string) => string | null }): { events: number; copies: number } {
  ensureUsageLedgerSchema(db);
  // Fixtures name projects in the raw rows; readers take them from the rules.
  projectRulesFromRawRows(db);
  const producer = { ...options, anchorOf: (home: string | null, file: string) =>
    ({ archiveId: "fixture", sourceId: options.sourceOf?.(home, file) ?? home ?? "", relativePath: file }) };
  enqueueCodexLedgerRuleChanges(db, producer);
  for (let batch = 0; !processCodexLedgerBatch(db, producer).ready; batch++) {
    if (batch >= 100000) throw new Error("Fixture ledger did not become ready");
  }
  const count = (table: string) => (db.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { events: count("codex_price_ledger_events"), copies: count("codex_price_ledger_copies") };
}

/** Synthetic legacy vendor cards explicitly declare the dated API prices the ledger will publish. */
export function fixtureCodexRateCard(rates: RateCard): RateCard {
  const models = rates.vendors.openai?.models;
  if (rates.codex_accounting || !models) return rates;
  const config = resolveCodexAccountingConfig(rates);
  const template = config.rules.find(rule=>rule.billing_basis==="api_equivalent_usd" && rule.speed==="standard")!;
  return {...rates,codex_accounting:{version:1,rules:[
    ...config.rules.filter(rule=>rule.billing_basis!=="api_equivalent_usd" || !models[rule.model]),
    ...Object.entries(models).map(([model,prices])=>({...template,id:`fixture-api-${model}`,model,
      valid_from:"2000-01-01",valid_until:undefined,long_context:undefined,speed:"standard" as const,multiplier:1,
      rates:{in_uncached:prices.in_uncached!,in_cache_read:prices.in_cache_read!,out_total:prices.out_total!,
        ...(prices.in_cache_write == null ? {} : {in_cache_write:prices.in_cache_write})} })),
  ]}};
}

const prepared = new WeakMap<Database,string>();
const acceptedFacts = new WeakMap<Database,string>();
const declaredTiers = new WeakSet<Database>();
/** Revalue a genuine rule edit from accepted bases even when the fixture has removed raw events. */
export function repriceCodexLedgerFixture(db: Database, card: RateCard): void {
  const context=codexLedgerReadContext(card);
  const options={bands:context.policy.baseBands,rulesRevision:context.rulesRevision!,policy:context.policy.policy,
    factsRevision:readCodexLedgerState(db)!.covered,anchorOf:()=>{throw new Error("Rule fixture must not parse source files");}};
  enqueueCodexLedgerRuleChanges(db,options);
  for(let batch=0;batch<1000;batch++) {
    if(processCodexLedgerBatch(db,options).ready)return;
  }
  throw new Error("Fixture rule publication did not become ready");
}
/** Synthetic fixtures explicitly declare their legacy speed; production never infers a raw tier this way. */
export function prepareCodexLedgerFixture(db: Database, card: RateCard, homes: Map<string,string> = new Map(),
  sources?: readonly SourceDeclaration[]): void {
  // Fixtures name projects in the raw rows; readers take them from the rules.
  projectRulesFromRawRows(db);
  const fields = new Set((db.query("PRAGMA table_info(events)").all() as {name:string}[]).map(row=>row.name));
  if (!fields.has("source_offset")) {
    db.exec("ALTER TABLE events ADD COLUMN source_offset INTEGER");
    db.exec("UPDATE events SET source_offset=rowid");
  }
  db.exec("UPDATE events SET source_offset=rowid WHERE source_offset IS NULL");
  if (!fields.has("service_tier")) {
    db.exec("ALTER TABLE events ADD COLUMN service_tier TEXT");
    declaredTiers.add(db);
  }
  if (declaredTiers.has(db)) {
    db.exec(fields.has("speed") ? "UPDATE events SET service_tier=CASE speed WHEN 'standard' THEN 'default' WHEN 'fast' THEN 'priority' END WHERE service_tier IS NOT CASE speed WHEN 'standard' THEN 'default' WHEN 'fast' THEN 'priority' END" : "UPDATE events SET service_tier=NULL WHERE service_tier IS NOT NULL");
  }
  const context = codexLedgerReadContext(card), declarations = sources ?? subscriptionDeclarations(homes);
  const factStamp=JSON.stringify([db.query("SELECT * FROM events ORDER BY rowid").all(),declarations]);
  const hasRevisions=!!db.query("SELECT 1 FROM sqlite_master WHERE name='vendor_sync_revisions'").get();
  const oldRevision=hasRevisions
    ? (db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as {revision:number}|null)?.revision ?? 0 : 0;
  const prior=acceptedFacts.get(db);
  // A real importer advances its durable source generation before publishing changed facts.
  // Reusing a generation would make an existing reader keep a different stamp from a new worker.
  let factsRevision=oldRevision;
  if (prior!==undefined && prior!==factStamp) {
    if (hasRevisions) {
      const changed=db.query("UPDATE vendor_sync_revisions SET data_revision=data_revision+1 WHERE vendor='codex'").run();
      if (!changed.changes) {
        const dated=(db.query("PRAGMA table_info(vendor_sync_revisions)").all() as {name:string}[]).some(column=>column.name==="updated_at");
        db.query(`INSERT INTO vendor_sync_revisions(vendor,data_revision${dated?",updated_at":""}) VALUES('codex',1${dated?",'fixture'":""})`).run();
      }
      factsRevision=(db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as {revision:number}).revision;
    } else {
      factsRevision=(readCodexLedgerState(db)?.covered ?? 0)+1;
    }
  } else if (!hasRevisions && prior!==undefined) {
    factsRevision=readCodexLedgerState(db)!.covered;
  }
  const stamp = JSON.stringify([factStamp,context.rulesRevision,[...homes],factsRevision]);
  if (prepared.get(db) === stamp) return;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='codex_price_ledger_events'").get()) createCodexLedgerSchema(db);
  else {
    ensureUsageLedgerSchema(db);
    for (const table of ["codex_price_ledger_aggregates","codex_price_ledger_file_models","codex_price_ledger_events","codex_price_ledger_dims","codex_price_ledger_copies","codex_price_ledger_bands"])
      db.exec(`DELETE FROM ${table}`);
    for (const table of ["usage_ledger_state","usage_ledger_dirty","usage_ledger_keys"])
      db.query(`DELETE FROM ${table} WHERE provider=?`).run(CODEX_LEDGER_PROVIDER);
  }
  fillCodexLedgerFixture(db,{bands:context.policy.baseBands,rulesRevision:context.rulesRevision!,factsRevision,policy:context.policy.policy,
    sourceOf:home=>home===null?null:codexHomeSource(home,declarations,ARCHIVE_LOGICAL_ROOT)});
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  prepared.set(db,stamp);
  acceptedFacts.set(db,factStamp);
}

/** Pure comparison fixtures receive published values before invoking the read-only comparison. */
export function publishedCodexComparisonFixture<T extends CodexAccountingEvent & {account:string|null;home?:string|null;service_tier?:string|null}>(config:CodexAccountingConfig,rows:readonly T[],referenceDay?:string): T[] {
  if (!rows.length) return [];
  const db=new FixtureDatabase(":memory:");
  const card={version:1,currency:"USD",unit:"per 1M",vendors:{},codex_accounting:config} as RateCard;
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,in_tok INTEGER,cached_in INTEGER,
      cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,speed TEXT,billing_mode TEXT,meter_reset INTEGER,plan_type TEXT,service_tier TEXT)`);
    const insert=db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)");
    rows.forEach((row,index)=>insert.run(row.home ?? null,`fixture-${index}.jsonl`,index+1,row.ts,row.model,row.in_tok,row.cached_in,row.cache_write,row.out_tok,
      row.speed ?? null,row.billing_mode ?? null,row.meter_reset ?? null,row.plan_type ?? null,
      Object.hasOwn(row,"service_tier") ? row.service_tier ?? null : row.speed === "fast" ? "priority" : row.speed === "standard" ? "default" : null));
    prepareCodexLedgerFixture(db,card);
    const ledger=codexLedgerReadContext(card);
    const events=readCodexEventRange(db,config,"0000-01-01","9999-12-31",event=>rows[event.source_offset!-1]!.account,
      referenceDay?{...ledger,referenceDay}:ledger);
    return events.map(event=>({...rows[event.source_offset!-1],...event})) as unknown as T[];
  } finally {db.close();}
}
