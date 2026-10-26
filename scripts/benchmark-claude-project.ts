/** Two-year synthetic Claude project report; never opens a production database. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_LOGICAL_ROOT } from "../src/config/paths";
import { Database } from "../src/db/sqlite";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../src/db/period-store";
import { fillUsageLedger } from "../src/server/usage-ledger.fixture";
import { buildProjectCost } from "../src/server/project-cost";
import { ACCOUNTS, RATES, TIMES, createClaudeCodeAcceptanceFixture, measureAnalysis } from "../src/server/claude-code-capacity.fixture";

const days = 730, callsPerDay = 20;
const until = TIMES.asOf.slice(0, 10);
const since = new Date(Date.parse(TIMES.asOf) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
const period = { since, until };
const round = (n: number) => Math.round(n * 1000) / 1000;
function sample(db: Database) {
  const started = performance.now();
  const measured = measureAnalysis(db, () => buildProjectCost(db, RATES, new Map(), period));
  return { ms: round(performance.now() - started), raw_or_fact_queries: measured.rawOrFactQueries.length,
    tokens: measured.value.totals.tokens, calls: measured.value.totals.calls,
    api_usd: measured.value.totals.api_usd, subjects: measured.value.subjects.length,
    weekly_capacity_a: measured.value.subscriptions.find(row => row.id === ACCOUNTS.a)?.capacity?.weekly_window_value_usd };
}

if (process.argv[2] === "--prepared-child") {
  const db = new Database(process.argv[3]!);
  try { console.log(JSON.stringify(sample(db))); } finally { db.close(true); }
} else {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const insert = fixture.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,
      subscription_id,entrypoint,cc_version,project_id,in_uncached,out_total)
      VALUES('benchmark',?,?,?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',?,800,200)`);
    fixture.db.transaction(() => {
      for (let day = 0; day < days; day++) for (let call = 0; call < callsPerDay; call++) {
        const ts = new Date(Date.parse(since) + day * 86_400_000 + (call + 1) * 60_000).toISOString();
        const account = call % 2 ? ACCOUNTS.a : ACCOUNTS.b;
        insert.run(`benchmark-${day}-${call}`, path.join(ARCHIVE_LOGICAL_ROOT,"claude",`benchmark-${account}`,"synthetic.jsonl"),ts,account, `synthetic-project-${call % 5}`);
      }
    })();
    insert.finalize();
    // Declared through the store, so the account resolver sees the new revision.
    replaceDeclaredPeriods(fixture.db, ACCOUNT_PERIODS, [...loadPeriods(fixture.db, ACCOUNT_PERIODS).filter(period => period.origin === "declared"),
      ...Object.values(ACCOUNTS).map(account => ({ provider: "claude", subject: `claude/benchmark-${account}`, value: account,
        from: "2020-01-01", until: null, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "synthetic" }))]);
    const preparationStart = performance.now();
    fillUsageLedger(fixture.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT, 500);
    const factPreparationMs = round(performance.now() - preparationStart);
    const first = sample(fixture.db);
    // Original fixture: 1,077,000 canonical tokens and 11 calls before the exclusive end.
    assert.equal(first.tokens, 1_077_000 + days * callsPerDay * 1000);
    assert.equal(first.calls, 11 + days * callsPerDay);
    assert.equal(first.api_usd, Math.round(first.tokens * 5.4 / 1e6 * 100) / 100);
    fixture.changeShare(15);
    fixture.reopen();
    const changedShare = sample(fixture.db);
    assert.notEqual(changedShare.weekly_capacity_a, first.weekly_capacity_a, "Share correction must update the estimate");
    const children = [];
    for (let i = 0; i < 3; i++) {
      const child = Bun.spawn([process.execPath, import.meta.path, "--prepared-child", fixture.dbPath], { stdout: "pipe", stderr: "inherit" });
      const output = await new Response(child.stdout).text();
      assert.equal(await child.exited, 0, "Prepared child failed");
      children.push(JSON.parse(output.trim().split("\n").at(-1)!) as ReturnType<typeof sample>);
    }
    for (const ready of [changedShare, ...children]) {
      assert.equal(ready.tokens, first.tokens);
      assert.equal(ready.calls, first.calls);
      assert.equal(ready.api_usd, first.api_usd);
    }
    const report = { kind: "synthetic-claude-project-two-year-read", generated_at: new Date().toISOString(),
      production_data_used: false, period, days, calls_per_day_added: callsPerDay,
      accounts: Object.values(ACCOUNTS), fact_preparation_ms: factPreparationMs,
      first_preparation: first, changed_share_after_reopen: changedShare, new_process_reads: children,
      limitations: ["14,600 added synthetic events; not a production workload.",
        "Measures the backend report, not desktop rendering, HTTP queuing or concurrent import.",
        "Read timing starts after module imports and opening SQLite; it excludes process startup.",
        "Parent and children reuse the operating system's filesystem cache."] };
    const output = process.argv[2] ?? ".dev-cache/claude-project-benchmark.json";
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally { fixture.teardown(); }
}
