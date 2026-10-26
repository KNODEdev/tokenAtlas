import fs from "node:fs";
import path from "node:path";
import { subscriptionAccountingAdapters } from "../server/subscription-accounting-adapters";

/**
 * What the single-source guard counts in a source file (plan U4.7, golden rules §1): reads of the
 * provider fact tables and of the ledgers, and SQL sums over token or amount columns.
 */
export const PROTECTED_TABLES: readonly string[] = [
  // Provider fact tables in native token categories: Codex's and each registered provider's.
  "events", ...subscriptionAccountingAdapters().map(adapter => adapter.table),
  // The ledgers and the window sums built from them.
  "usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours",
  "codex_price_ledger_events", "codex_price_ledger_copies", "codex_price_ledger_aggregates", "codex_price_ledger_file_models",
  "window_usage", "window_usage_intervals",
  "response_time_copies", "response_time_turns", "response_time_hours",
];
const TABLE = PROTECTED_TABLES.join("|");
const READ = new RegExp(String.raw`\b(?:FROM|JOIN)\s+["'` + "`" + String.raw`]?(?:${TABLE})\b(?![\w-])`, "gi");
// A table named by an expression: counted when the file names a protected table as a string, or
// takes one from a provider adapter (`subscriptionAccountingAdapter(...).table`, `adapter.table`); merely
// importing the adapters (for a vendor name, say) does not make a file's other dynamic reads fact reads.
// Sync publication also gets table names and bookmarks from its shared schema and remap definitions.
const DYNAMIC_READ = /\b(?:FROM|JOIN)\s+\$\{[^}]*\}/g;
const NAMES_TABLE = new RegExp(String.raw`["'](?:${TABLE})["']|\b\w*(?:[aA]dapter|[aA]ccounting)\w*(?:\([^)]*\))?\.table\b`);
const PUBLICATION_SCHEMA = /\b(?:VENDOR_TABLES|vendorSourceTables|DELTA_SPECS|DeltaSpec|REMAPPED_TABLES)\b/;
const NAMED_IMPORT = /\bimport\s+(?:type\s+)?\{[^}]*\}\s+from\s+["'][^"']+["']/g;
const QUANTITY = String.raw`(?:tok|in_tok|cached_in|cache_write(?:_5m|_1h)?|cache_read|out_tok|reasoning(?:_out)?|in_uncached|in_cache_read|in_cache_write|out_total|fresh_in|tokens(?:_fresh)?|cost(?:_ticks)?|usd|\w+_usd|\w+_nano|\w+_femto|amount\w*)`;
// SUM(x), SUM(t.x), SUM(CASE ... THEN x END), SUM(${expression}) or SUM(CASE ... THEN t.${column} END).
const SUM = new RegExp(String.raw`\b(?:SUM|TOTAL)\s*\(\s*(?:CASE\b[^()]*?\bTHEN\s+)?(?:\w+\.)?(?:${QUANTITY}\b|\$\{)`, "gi");

export interface SingleSourceCount { reads: number; sums: number }
export function countSingleSource(text: string): SingleSourceCount {
  const namesTable = NAMES_TABLE.test(text) || PUBLICATION_SCHEMA.test(text.replace(NAMED_IMPORT, ""));
  const dynamic = namesTable ? text.match(DYNAMIC_READ)?.length ?? 0 : 0;
  return { reads: (text.match(READ)?.length ?? 0) + dynamic, sums: text.match(SUM)?.length ?? 0 };
}

/** Production sources under src: tests, fixtures, acceptance helpers, this guard and the browser bundle are out of scope. */
export function singleSourceFiles(root: string): string[] {
  const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return (entry.name === "web" || entry.name === "architecture") && directory === root ? [] : walk(file);
    return /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$|acceptance|-fixture\.ts$|test-support/.test(entry.name) ? [file] : [];
  });
  return walk(root).map(file => path.relative(root, file).replaceAll("\\", "/")).sort();
}
