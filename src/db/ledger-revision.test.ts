import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { ledgerRevision } from "./ledger-revision";
import { createAnalysisSourceRevisions } from "./analysis-source-revisions.fixture";

test("pre-projection snapshot manifests retain their exact derived revision", () => {
  const db = new Database(":memory:");
  try {
    // Captured from the pre-0081 implementation for a database without a published usage ledger.
    const manifestDerived = 127694991306727;
    expect(ledgerRevision(db)).toBe(manifestDerived);
    createAnalysisSourceRevisions(db);
    db.exec("INSERT INTO analysis_source_revisions VALUES('window-usage','*',7)");
    expect(ledgerRevision(db)).toBe(manifestDerived);
    db.exec("INSERT INTO analysis_source_revisions VALUES('capacity_cycle_results','*',1)");
    const first = ledgerRevision(db);
    expect(first).not.toBe(manifestDerived);
    db.exec("UPDATE analysis_source_revisions SET revision=2 WHERE source='capacity_cycle_results'");
    expect(ledgerRevision(db)).not.toBe(first);
  } finally { db.close(); }
});
