import { projectRulesFromRawRows } from "../projects/rules.fixture";
import type { Database } from "bun:sqlite";
import { installAnalysisTracking } from "../db/analysis";
import type { EraDeclaration } from "./eras";
import type { RateCard } from "./pricing";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";

/**
 * Test support: prepare every provider scope as the maintenance worker would, so
 * account-period readers see the shared price register ready for `rates`.
 */
export function prepareUsageRegisters(db: Database, rates: RateCard, sources: readonly EraDeclaration[] = [],
  homeToSubId?: Map<string, string>): void {
  // Every real database has the Codex events table (bootstrap creates it); a fixture without Codex
  // traffic gets the empty one, so its Codex usage is prepared and empty rather than unavailable.
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
    model TEXT, effort TEXT, project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning_out INTEGER, cwd TEXT, project_id TEXT)`);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  // Fixtures name projects in the raw rows; readers take them from the rules.
  projectRulesFromRawRows(db);
  prepareCodexLedgerFixture(db, rates, homeToSubId, sources.length ? sources : undefined);
  fillUsageLedgerFixture(db, rates);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
}
