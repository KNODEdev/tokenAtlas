import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "../db/sqlite";
import { remap, remapRepos } from "./remap";
import { overrideProjectRules } from "./resolve";
import { deriveRepo } from "./repo";
import { createCodexLedgerSchema, metadataColumns, withPlaceProjects } from "../db/codex-price-ledger";
import { enqueueCodexLedgerRuleChanges,
  processCodexLedgerBatch, type LedgerProducerOptions } from "../db/codex-ledger-producer";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const home = "archive", alpha = "C:/repos/internal/alpha/app", beta = "C:/repos/other/beta/app";
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(basis => ({ id: basis, model: "m", billing_basis: basis,
    valid_from: "2026-01-01", multiplier: "1", rates: { in_uncached: "1.875", in_cache_read: "0.125", out_total: "1.7999999999999998" }, ...provenance })),
  tier_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map(basis => ({ id: `${basis}-standard`, model: "m", billing_basis: basis,
    tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance })) };
function fixture(run: (db: Database, drain: () => { processed: number; repricedApi: number; repricedCredits: number; aggregatePartitions: number }) => void,
  legacyProject: number | null = null): void {
  const db = new Database(":memory:");
  try {
    createCodexLedgerSchema(db);
    db.exec(`CREATE TABLE account_periods(id INTEGER PRIMARY KEY,provider TEXT,source TEXT,from_ts TEXT,until_ts TEXT,
      account TEXT,origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT) STRICT`);
    db.exec(`INSERT INTO account_periods VALUES(1,'codex','codex/pc/profile','2026-01-01T00:00:00Z',NULL,
      'declared-owner','declared','2026-01-01T00:00:00Z','2026-04-02T12:00:00Z',1,'fixture');
      CREATE TRIGGER protect_project_account_periods BEFORE UPDATE ON account_periods BEGIN SELECT RAISE(ABORT,'project remap changed account periods'); END`);
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,
      reasoning_out INTEGER,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,billing_mode TEXT,
      cwd TEXT,project TEXT,project_id ANY,repo TEXT,repo_group TEXT,UNIQUE(home,path,source_offset)) STRICT`);
    for (const [file, cwd, count] of [["a", alpha, 2], ["b", beta, 1]] as const) {
      const pathname = `archive/${file}.jsonl`, repo = deriveRepo(cwd);
      for (let index = 0; index < count; index++) {
        db.query("INSERT INTO events VALUES(?,?,?,'m','2026-04-02T12:00:00Z',?,2,0,3,1,'valid','missing','default','standard','allowance',?,?,?,?,?)")
          .run(home, pathname, index * 100, 10 + index, cwd, file === "a" ? "alpha" : "beta", file === "a" ? legacyProject : null, repo.repo, repo.group);
      }
    }
    const compiled = compileCodexLedgerPolicy(policy);
    const options: LedgerProducerOptions = { bands: compiled.baseBands, policy, rulesRevision: sha(JSON.stringify(policy)),
      factsRevision: 0, batchSize: 2, anchorOf: (_home, pathname) => ({ archiveId: "archive-id", sourceId: "codex/pc/profile",
        relativePath: pathname }) };
    const drain = () => {
      let processed = 0, repricedApi = 0, repricedCredits = 0, aggregatePartitions = 0;
      for (let step = 0; step < 20; step++) {
        const result = processCodexLedgerBatch(db, options);
        processed += result.processed; repricedApi += result.repricedApi; repricedCredits += result.repricedCredits; aggregatePartitions += result.aggregatePartitions;
        if (result.ready) return { processed, repricedApi, repricedCredits, aggregatePartitions };
        if (!result.progressed) throw new Error(JSON.stringify(result.blocked));
      }
      throw new Error("remap ledger work did not finish");
    };
    enqueueCodexLedgerRuleChanges(db, options); drain();
    run(db, drain);
  } finally { db.close(); }
}
const queue = (db: Database) => (db.query("SELECT value FROM usage_ledger_dirty WHERE provider='codex' AND kind='copy' ORDER BY value").all() as
  Array<{ value: string }>).map(row => { const [home, path] = JSON.parse(row.value) as [string, string]; return { home, path }; });
const amounts = (db: Database) => db.query(`SELECT id,identity,api_band,credit_band,api_reason,credit_reason,
  CAST(api_whole AS TEXT) api_whole,CAST(api_fraction_hi AS TEXT) api_fraction_hi,CAST(api_fraction_lo AS TEXT) api_fraction_lo,
  CAST(credit_whole AS TEXT) credit_whole,CAST(credit_fraction_hi AS TEXT) credit_fraction_hi,CAST(credit_fraction_lo AS TEXT) credit_fraction_lo
  FROM codex_price_ledger_events ORDER BY id`).all();
// Sums have no copy dimension; per-file metadata is read from the canonical events. Subject and project follow the
// project rules over the dimension's place (migration 0069), so they are read through `withPlaceProjects`.
function dimensions(db: Database) {
  const rows = withPlaceProjects(db, db.query(`SELECT c.path,e.day,d.home,${metadataColumns()}
    FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id JOIN codex_price_ledger_copies c ON c.id=e.copy_id
    WHERE e.admitted=1 AND e.copy_state='canonical'`).all() as Array<{ path: string; day: string; home: string; cwd: string | null; project: string | null;
    repo: string | null; project_id: string | number | null; subject: string | null }>);
  const out = new Map<string, { path: string; subject: string | null; project_id: string | number | null; repo: string | null; calls: number }>();
  for (const row of rows) {
    const key = JSON.stringify([row.path, row.subject, row.project_id, row.repo]);
    const entry = out.get(key) ?? out.set(key, { path: row.path, subject: row.subject, project_id: row.project_id, repo: row.repo, calls: 0 }).get(key)!;
    entry.calls++;
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}
const changes = (db: Database) => (db.query("SELECT total_changes() n").get() as { n: number }).n;
const alphaRules = { projects: [{ id: "alpha-slug", name: "Alpha", matches: [{ cwd: alpha }] }] };

test("a project rule change writes nothing, queues no copy and is read at once without repricing", () => fixture((db, drain) => {
  const before = amounts(db), written = changes(db);
  overrideProjectRules(db, { projects: [] });
  expect(dimensions(db)).toEqual([
    { path: "archive/a.jsonl", subject: "r:alpha", project_id: null, repo: "alpha", calls: 2 },
    { path: "archive/b.jsonl", subject: "r:beta", project_id: null, repo: "beta", calls: 1 },
  ]);
  overrideProjectRules(db, alphaRules);
  expect(dimensions(db)).toEqual([
    { path: "archive/a.jsonl", subject: "p:alpha-slug", project_id: "alpha-slug", repo: "alpha", calls: 2 },
    { path: "archive/b.jsonl", subject: "r:beta", project_id: null, repo: "beta", calls: 1 },
  ]);
  expect(changes(db)).toBe(written); expect(queue(db)).toEqual([]); expect(drain().processed).toBe(0); expect(amounts(db)).toEqual(before);
  overrideProjectRules(db, null);
}));

test("a full remap writes repositories only: unchanged repositories queue nothing whatever the project rules", () => fixture((db, drain) => {
  const before = amounts(db);
  remap(db, alphaRules); expect(queue(db)).toEqual([]);
  remap(db, { projects: [] }); expect(queue(db)).toEqual([]);
  expect(drain().processed).toBe(0); expect(amounts(db)).toEqual(before);
  expect(db.query("SELECT COUNT(*) n FROM events WHERE project_id IS NOT NULL").get()).toEqual({ n: 0 });
}));

test("actual repository remap queues its changed copy, not unrelated projects or repeated metadata", () => fixture((db, drain) => {
  const before = amounts(db);
  remapRepos(db, { nested_groups: ["internal"] }); expect(queue(db)).toEqual([{ home, path: "archive/a.jsonl" }]);
  const changed = drain(); expect(changed.repricedApi).toBe(0); expect(changed.repricedCredits).toBe(0); expect(amounts(db)).toEqual(before);
  overrideProjectRules(db, { projects: [] });
  expect(dimensions(db)[0]).toEqual({ path: "archive/a.jsonl", subject: "r:alpha/app", project_id: null, repo: "alpha/app", calls: 2 });
  overrideProjectRules(db, null);
  remapRepos(db, { nested_groups: ["internal"] }); expect(queue(db)).toEqual([]);
}));

test("a legacy project id in the raw rows is not read: the rules decide", () => fixture((db) => {
  overrideProjectRules(db, { projects: [] });
  expect(dimensions(db).map(row => (row as { subject: string }).subject)).toEqual(["r:alpha", "r:beta"]);
  overrideProjectRules(db, null);
}, 7));

test("repository remap and durable ledger notification roll back together when queue publication fails", () => fixture((db) => {
  db.exec("CREATE TRIGGER reject_remap_queue BEFORE INSERT ON usage_ledger_dirty WHEN NEW.kind='copy' BEGIN SELECT RAISE(ABORT,'queue failure'); END");
  const repos = db.query("SELECT DISTINCT repo FROM events ORDER BY repo").all();
  expect(() => remapRepos(db, { nested_groups: ["internal"] })).toThrow("queue failure");
  expect(db.query("SELECT DISTINCT repo FROM events ORDER BY repo").all()).toEqual(repos); expect(queue(db)).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_temp_master WHERE name LIKE 'remap_%'").all()).toEqual([]);
}));
