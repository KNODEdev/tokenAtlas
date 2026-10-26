import type { Database } from "bun:sqlite";

/** Test fixtures: the revision clocks table as the migrations leave it, without the report tables 0028 also created. */
export function createAnalysisSourceRevisions(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS analysis_source_revisions (
    source TEXT NOT NULL,
    bucket TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (source, bucket)
  )`);
}
