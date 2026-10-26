import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { SINGLE_SOURCE_ALLOWED } from "./single-source-allowlist";
import { countSingleSource, singleSourceFiles } from "./single-source-scan";

/**
 * Single-source guard (plan U4.7, §7a criterion 8, golden rules §1): every number screens show comes
 * from the ledgers through their read modules. A file outside the allow-list that reads a fact table
 * or a ledger, or sums tokens or amounts in SQL, fails here; so does a listed file whose reads or sums
 * changed. The fix is to read through `server/ledger-sums.ts` or `server/window-usage.ts` (extending
 * the ledger when a result is missing), or, for a producer, an ingest step or a detail read, to update
 * its line in `single-source-allowlist.ts` with a reason.
 */
const root = path.resolve(import.meta.dir, "..");

test("only listed files read the fact tables and ledgers or sum tokens and amounts, exactly as listed", () => {
  const found = new Map<string, { reads: number; sums: number }>();
  for (const file of singleSourceFiles(root)) {
    const count = countSingleSource(fs.readFileSync(path.join(root, file), "utf8"));
    if (count.reads || count.sums) found.set(file, count);
  }
  const problems: string[] = [];
  for (const [file, count] of found) {
    const allowed = SINGLE_SOURCE_ALLOWED[file];
    if (!allowed) problems.push(`${file}: ${count.reads} reads, ${count.sums} sums of facts outside the read modules (use ledger-sums.ts / window-usage.ts)`);
    else if (allowed.reads !== count.reads || allowed.sums !== count.sums)
      problems.push(`${file}: found ${count.reads} reads, ${count.sums} sums; listed ${allowed.reads}, ${allowed.sums}`);
  }
  for (const file of Object.keys(SINGLE_SOURCE_ALLOWED))
    if (!found.has(file)) problems.push(`${file}: listed but reads no facts any more; remove its line`);
  expect(problems).toEqual([]);
});

test("the read modules and every listed reason are in place", () => {
  expect(SINGLE_SOURCE_ALLOWED["server/ledger-sums.ts"]?.kind).toBe("register");
  expect(SINGLE_SOURCE_ALLOWED["server/window-usage-read.ts"]?.kind).toBe("register");
  for (const [file, entry] of Object.entries(SINGLE_SOURCE_ALLOWED)) {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
    expect(entry.reason.trim().length).toBeGreaterThan(10);
  }
});

test("the guard recognizes fact reads and token sums in the forms the code uses", () => {
  const count = (sql: string) => countSingleSource(sql);
  expect(count("SELECT ts FROM claude_events WHERE id=?")).toEqual({ reads: 1, sums: 0 });
  expect(count("SELECT * FROM events e JOIN codex_price_ledger_copies c ON c.id=e.id")).toEqual({ reads: 2, sums: 0 });
  expect(count("SELECT SUM(in_tok), SUM(l.out_total), TOTAL(std_sub_usd) FROM x")).toEqual({ reads: 0, sums: 3 });
  expect(count("SUM(CASE WHEN ok THEN cached_in END)")).toEqual({ reads: 0, sums: 1 });
  expect(count("SUM(CASE WHEN ok THEN l.${field} END), SUM(${gross})")).toEqual({ reads: 0, sums: 2 });
  // A table named by an expression counts where the file names a fact table or uses the provider adapters.
  expect(count(`const t = "gemini_events"; db.query(\`SELECT 1 FROM \${t}\`)`)).toEqual({ reads: 1, sums: 0 });
  expect(count("db.query(`SELECT 1 FROM ${t}`)")).toEqual({ reads: 0, sums: 0 });
  // Moving the shared publication schema out of a caller must not hide its dynamic reads.
  for (const schema of ["VENDOR_TABLES", "vendorSourceTables", "DELTA_SPECS", "DeltaSpec", "REMAPPED_TABLES"]) {
    const imported = `import { ${schema} } from "../sync/vendor-publication-schema";`;
    expect(count(`${imported} const tables = ${schema}; db.query(\`SELECT 1 FROM \${table}\`)`))
      .toEqual({ reads: 1, sums: 0 });
    expect(count(`${imported} db.query(\`SELECT 1 FROM \${table}\`)`)).toEqual({ reads: 0, sums: 0 });
  }
  // Neighbouring tables and counts are not facts or token sums.
  expect(count("SELECT COUNT(*), SUM(calls) FROM probe_windows JOIN events_meta ON 1 JOIN usage_ledger_state")).toEqual({ reads: 0, sums: 0 });
});
