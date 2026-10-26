import type { Database } from "bun:sqlite";
import { tableExists } from "./window-usage-meta";

/** The revision clock of all stored window sums; cached responses that show them depend on it. */
export const WINDOW_USAGE_CLOCK = "window-usage";

/** The revision clock of one account's stored window sums. */
export const windowUsageDependency = (provider: string, account: string) =>
  ({ source: `${WINDOW_USAGE_CLOCK}:${provider.toLowerCase()}:${account.toLowerCase()}` });

/** Inside a write transaction of the producer: the rows of an account changed. */
export function bumpWindowUsageClocks(db: Database, provider: string, account: string): void {
  if (!tableExists(db, "analysis_source_revisions")) return;
  const bump = db.query(`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES(?,'*',1)
    ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1`);
  bump.run(WINDOW_USAGE_CLOCK); bump.run(windowUsageDependency(provider, account).source);
}
