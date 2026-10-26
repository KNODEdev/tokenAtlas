import type { Database } from "bun:sqlite";
import { advanceClaudeCardMetadata } from "./claude-card-metadata";

/** Publish the same bounded metadata turns that precede ready roster reads in the worker. */
export function prepareClaudeCardMetadataFixture(db: Database, accounts?: readonly string[]): void {
  for (let turn = 0; turn < 10_000; turn++) {
    if (!advanceClaudeCardMetadata(db, { accounts }).pending) return;
  }
  throw new Error("Claude card metadata fixture did not settle");
}
