import { projectRulesFromRawRows } from "../projects/rules.fixture";
/**
 * The repository history stays readable while the ledgers catch up (golden rules §9): once the Codex ledger and its
 * activity were published, appended calls queue copy, day, session and activity work, yet the ranking and the details
 * answer 200 from the committed rows; after the producer catches up they equal the D2 oracle. Synthetic database.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "../db/sqlite";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty, processCodexLedgerBatch } from "../db/codex-ledger-producer";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { readCodexLedgerState } from "../db/codex-ledger-state";
import { installAnalysisTracking } from "../db/analysis";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
import { buildEraIndex } from "./eras";
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { handleRepoHistory, type AppContext } from "./api";
import type { RateCard } from "./pricing";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";

const evidence = { verified_at: "2026-01-01", sources: ["https://example.test/prices"], confidence: "official" as const };
const policy = (): CodexLedgerPolicy => ({ version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(billing_basis => ({ id: billing_basis, model: "model", billing_basis,
    valid_from: "2026-01-01", multiplier: "1", rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "5" }, ...evidence })),
  tier_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(billing_basis => ({ id: `${billing_basis}-standard`, model: "model",
    billing_basis, tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...evidence })) });

test("ranking and details answer from committed rows while calls are appended, and equal the oracle once caught up", async () => {
  const db = new Database(":memory:");
  const card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
      speed TEXT,service_tier TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
      project_id TEXT,repo TEXT,repo_group TEXT,gap_seconds REAL);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
    db.exec(readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/main','accounta','2026-01-01T00:00:00Z','declared','fixture')").run();
    const insert = db.query(`INSERT INTO events(home,path,source_offset,ts,model,speed,service_tier,in_tok,cached_in,cache_write,out_tok,reasoning_out,project_id,repo,repo_group)
      VALUES('/archive','/archive/a.jsonl',?,?,'model','standard','default',1000,0,0,10,0,'a','repo-a','test')`);
    // Two calls 4 minutes apart.
    insert.run(1, "2026-04-01T12:00:00Z"); insert.run(2, "2026-04-01T12:04:00Z");
    createCodexLedgerSchema(db);
    const context = codexLedgerReadContext(card);
    const options = { bands: context.policy.baseBands, policy: context.policy.policy, rulesRevision: context.rulesRevision!, factsRevision: 0,
      anchorOf: (home: string | null, file: string) => ({ archiveId: "fixture", sourceId: "codex/main", relativePath: file }) };
    fillCodexLedgerFixture(db, { ...options, sourceOf: () => "codex/main" });
    enqueueCodexLedgerRuleChanges(db, options);
    createAnalysisSourceRevisions(db); installAnalysisTracking(db);
    expect(readCodexLedgerState(db)).toMatchObject({ status: "ready", activity_published: 1 });
    const ctx = { sqlite: db, rateCards: card, homeToSubId: new Map(), eras: buildEraIndex([]), accounts: { version: 2, subscriptions: [], sources: [] } } as unknown as AppContext;
    const read = async (query: string) => {
      const response = await handleRepoHistory(ctx, new URL(`http://test/api/repo-history?since=2026-04-01&until=2026-04-01&idle_gap=15${query}`));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ subjects?: Array<{ id: string; calls: number; active_seconds: number }>;
        totals?: { calls: number; active_seconds: number } }>;
    };
    const ranking = async () => (await read("")).subjects!.find(row => row.id === "a")!;
    const details = async () => (await read("&project=a&granularity=day&by=account")).totals!;
    expect(await ranking()).toMatchObject({ calls: 2, active_seconds: 240 });
    expect(await details()).toMatchObject({ calls: 2, active_seconds: 240 });
    // A late call between the two and one after them: the file is published again and its copy queued.
    db.transaction(() => {
      insert.run(3, "2026-04-01T12:01:00Z"); insert.run(4, "2026-04-01T12:30:00Z");
      // Their place names project a, as the earlier calls' (rules.fixture.ts).
      projectRulesFromRawRows(db);
      markCodexLedgerCopiesDirty(db, [{ home: "/archive", path: "/archive/a.jsonl" }]);
    }).immediate();
    expect(await ranking()).toMatchObject({ calls: 2, active_seconds: 240 });
    // One step writes the copy and queues its days, gaps and activity: still the committed rows.
    processCodexLedgerBatch(db, { ...options, batchSize: 1 });
    const queued = (db.query("SELECT kind FROM usage_ledger_dirty WHERE provider='codex' ORDER BY kind").all() as Array<{ kind: string }>).map(row => row.kind);
    expect(queued.length).toBeGreaterThan(0);
    expect(readCodexLedgerState(db)?.status).toBe("ready");
    await ranking(); await details();
    for (let step = 0; step < 100 && !processCodexLedgerBatch(db, options).ready; step++);
    expect(db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='codex'").get()).toEqual({ n: 0 });
    // D2: 12:00, 12:01 (60 s), 12:04 (180 s), 12:30 (26 min, capped at 15) = 1140 s.
    expect(await ranking()).toMatchObject({ calls: 4, active_seconds: 60 + 180 + 900 });
    expect(await details()).toMatchObject({ calls: 4, active_seconds: 60 + 180 + 900 });
  } finally { db.close(); }
});
