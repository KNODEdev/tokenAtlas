import type { Database } from "bun:sqlite";
import { installAnalysisTracking } from "../db/analysis";
import { subscriptionAccountingAdapters } from "./subscription-accounting-adapters";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { currentSubscriptionHomes } from "./capacity-equivalents";
import type { SourceDeclaration } from "./archive-source";
import type { RateCard } from "./pricing";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";

/** Test setup: run the background producer explicitly before exercising a read-only report. */
export function prepareGlobalFixture(db:Database,rates:RateCard,sources:readonly (SourceDeclaration & {id?:string})[]=[],limit=100) {
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  if(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) {
    const homes=currentSubscriptionHomes(sources.map(source=>({...source,id:source.id??source.home??""})));
    prepareCodexLedgerFixture(db,rates,homes,sources);
  }
  for(const adapter of subscriptionAccountingAdapters()) {
    if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(adapter.table))continue;
    fillUsageLedger(db,adapter.id,rates,ARCHIVE_LOGICAL_ROOT,limit);
  }
  installAnalysisTracking(db);
  installFactDayRevisions(db);
}
