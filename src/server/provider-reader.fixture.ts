import type { Database } from "bun:sqlite";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import type { EraIndex } from "./eras";
import { installAnalysisTracking } from "../db/analysis";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import type { RateCard } from "./pricing";
import { installFactDayRevisions } from "../db/fact-day-revisions";

/** Translate explicit synthetic fixture ownership into the v8 source/period input contract. */
export function prepareProviderReaderFacts(db: Database, provider: string, account?: string, eras?: EraIndex, limit=100,
  rates: RateCard = {version:1,currency:'USD',unit:'per 1M',vendors:{}}) {
  const table=provider==='glm'?'oc_events':`${provider}_events`;
  const columns=new Set((db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
  if(!columns.size)return {complete:true,processed:0};
  if(!columns.has('id')) {db.exec(`ALTER TABLE ${table} ADD COLUMN id INTEGER`);db.exec(`UPDATE ${table} SET id=rowid`);}
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,account TEXT,
      origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT)`);
  if(provider!=='glm'&&!columns.has('path'))db.exec(`ALTER TABLE ${table} ADD COLUMN path TEXT`);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  const sourceColumn=provider==='claude'&&columns.has('subscription_id')?'subscription_id':columns.has('store')?'store':null;
  const stores=sourceColumn?(db.query(`SELECT DISTINCT ${sourceColumn} store FROM ${table} WHERE ${sourceColumn} IS NOT NULL`).all() as {store:string}[]).map(row=>row.store):['fixture'];
  let periodChanges=0;
  for(const store of stores) {
    const entries=eras?.erasFor(provider,store)??[];
    const declarations=entries.length?entries.map(entry=>({account:entry.id,from:entry.from??'2000-01-01',until:entry.until??null}))
      :eras?[]:[{account:account&&stores.includes(account)?store:account??store,from:'2000-01-01',until:null}];
    const source=`${provider}/${store.toLowerCase()}`;
    if(provider!=='glm') {
      const filter=sourceColumn?`${sourceColumn} IS ?`:'1=1';
      db.query(`UPDATE ${table} SET path=? || '/' || id || '.jsonl' WHERE ${filter} AND (path IS NULL OR path NOT LIKE ?)`)
        .run(`${ARCHIVE_LOGICAL_ROOT}/${source}`,...(sourceColumn?[store]:[]),`${ARCHIVE_LOGICAL_ROOT}/%`);
    }
    for(const declaration of declarations) {
      periodChanges+=db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,readings,evidence)
        SELECT ?,?,?,?,?,'declared',0,'fixture' WHERE NOT EXISTS(SELECT 1 FROM account_periods WHERE provider=? AND source=? AND from_ts=? AND until_ts IS ? AND account=?)`)
        .run(provider,source,declaration.from,declaration.until,declaration.account.toLowerCase(),provider,source,declaration.from,declaration.until,declaration.account.toLowerCase()).changes;
    }
  }
  if(periodChanges)db.query("INSERT INTO meta VALUES('account_periods_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  // This provider's ledger and, as a fresh installation has them, the other providers' (empty) ones.
  fillUsageLedgerFixture(db,rates);
  const processed=(db.query(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n;
  return {complete:true,processed};
}
