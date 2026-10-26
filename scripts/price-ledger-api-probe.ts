import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { constants } from "bun:sqlite";
import { Database } from "../src/db/sqlite";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";
import { createFetchHandler, type AppContext } from "../src/server/api";
import { buildAccountResolver } from "../src/server/account-resolver";
import { codexLedgerReadContext } from "../src/db/codex-ledger-adapters";
import { readCodexLedgerState } from "../src/db/codex-ledger-state";
import type { RateCard } from "../src/server/pricing";
import assert from "node:assert/strict";

const [input, contextInput, order = "whole-first"] = process.argv.slice(2);
if (!input || !contextInput) throw new Error("Usage: bun scripts/price-ledger-api-probe.ts <closed-candidate.sqlite> <closed-context.sqlite>");
const frozen = frozenLedgerCopy(input), directory = path.dirname(frozen.copy);
const frozenContext = frozenLedgerCopy(contextInput);
const policy = JSON.parse(fs.readFileSync(path.join(directory, "policy.json"), "utf8"));
const rates: RateCard = { version: 2, currency: "USD", unit: "per million", vendors: {}, codex_ledger_policy: policy };
const db = new Database(pathToFileURL(frozen.copy).href + "?mode=ro&immutable=1",
  constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
db.exec("PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
// The archive-only candidate omits application periods. Borrow their frozen copy through temporary views.
db.query("ATTACH DATABASE ? AS report_context").run(pathToFileURL(frozenContext.copy).href + "?mode=ro&immutable=1");
for (const table of ["account_periods", "plan_periods"]) {
  db.exec(`CREATE TEMP VIEW ${table} AS SELECT * FROM report_context.${table}`);
}
const head = readCodexLedgerState(db), ledger = codexLedgerReadContext(rates);
if (!head || head.rules_digest !== ledger.rulesRevision || head.status !== "ready") throw new Error("Candidate policy is not published");
const ctx = { sqlite: db, dbPath: ":memory:", rateCards: rates, accounts: { version: 2, subscriptions: [], sources: [] },
  homeToSubId: new Map(), subIdToHomes: new Map(), resolver: buildAccountResolver([]),
  rootDir: path.resolve(import.meta.dir, ".."), plans: {}, plansCatalog: { provider_groups: [] },
  cycles: {}, claudeGauge: {}, grokGauge: {} } as unknown as AppContext;
const fetch = createFetchHandler(ctx);
const selectedPath = path.join(directory, "selected-report.json");
const selected = fs.existsSync(selectedPath) ? JSON.parse(fs.readFileSync(selectedPath, "utf8")) : undefined;
if (selected) {
  assert.equal(fs.realpathSync(selected.candidate), frozen.copy);
  assert.equal(selected.candidateBytes, frozen.before.size);
  assert.equal(selected.rulesRevision, ledger.rulesRevision);
  assert.equal(selected.mismatches, 0);
}
const day = selected?.representativeDay ?? (db.query("SELECT MAX(day) day FROM codex_price_ledger_aggregates WHERE grain='day'").get() as { day: string }).day;
const results: unknown[] = [];
try {
  const ranges = [["whole-history", ""], ["one-day", `&since=${day}&until=${day}`]];
  if (order === "day-first") ranges.reverse();
  for (const [name, suffix] of ranges) {
    for (let trial = 0; trial < 3; trial++) {
      const started = performance.now(), response = await fetch(new Request(`http://local/api/summary?vendor=codex${suffix}`));
      const body = await response.json() as { totals?: { calls: number; usd: number }; unpriced?: { tokens: number } };
      const expected = selected?.results.find((result: { name: string }) => result.name === (name === "whole-history" ? "whole_history" : "lexical_day"))?.groups.total;
      if (expected) {
        assert.equal(body.totals?.calls, Number(expected.calls));
        // These reference totals are away from half-cent boundaries; dedicated regressions cover exact ties.
        assert.equal(body.totals?.usd, Math.round(Number(expected.variants.api_standard.pricedSubtotal.decimal) * 100) / 100);
        assert.equal(body.unpriced?.tokens ?? 0, Number(expected.variants.api_standard.unpricedTokens));
      }
      const entry = { range: name, trial, status: response.status, elapsed_ms: performance.now() - started,
        cache: response.headers.get("X-Cache"), analysis: response.headers.get("X-Analysis"), totals: body.totals,
        unpriced: body.unpriced, independent_counter_match: !!expected };
      results.push(entry); console.log(JSON.stringify(entry));
      if (response.status !== 200) throw new Error(`Prepared ${name} API returned ${response.status}`);
    }
  }
  fs.writeFileSync(path.join(directory, `api-report-${order}-${Date.now()}.json`), JSON.stringify({ runtime: Bun.version, candidate: frozen.copy,
    context: frozenContext.copy, selectedReference: selected ? selectedPath : null, cacheKiB: 65536, mmap: db.query("PRAGMA mmap_size").get(), day, results, limitations: ["Read-only closed candidate and period context; no active source writer",
      "Fresh process and initially empty response cache; OS cache is uncontrolled",
      "Synthetic empty ownership declarations test aggregate summary, not account/capacity configuration",
      "Reference comparison checks summary calls, cents and unpriced tokens; exact ties and other response fields use separate regressions"] }, null, 2));
  frozen.assertUnchanged();
  frozenContext.assertUnchanged();
} finally { ctx.analysisReader?.close(); db.close(true); frozen.assertUnchanged(); frozenContext.assertUnchanged(); }
