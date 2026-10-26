import { buildEraIndex } from "./eras";
import { describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { installAnalysisTracking } from "../db/analysis";
import { prepareProviderReaderFacts as prepareSubscriptionFacts } from "./provider-reader.fixture";
import { createFetchHandler, periodEras, type AppContext } from "./api";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import {
  buildRepoHistory,
  buildRepoHistoryCancellable,
  HistoryAbortedError,
} from "./repo-history";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const emptyCards = {
  version: 1,
  currency: "USD",
  unit: "per 1M",
  vendors: {},
  subscriptions: {},
};

const histOpts = {
  repo: null as string | null,
  projectId: "my-app",
  granularity: "day" as const,
  by: "none" as const,
  idleGapMinutes: 15,
  since: "2026-08-01",
  until: "2026-08-31",
  rateCards: emptyCards as never,
  homeToSubId: new Map<string, string>(),
};

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE events (
      ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
      in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
      reasoning_out INTEGER, path TEXT, gap_seconds REAL
    );
    CREATE TABLE claude_events (
      id INTEGER PRIMARY KEY,
      call_id TEXT NOT NULL,
      ts TEXT, repo TEXT, project_id TEXT, model TEXT, speed TEXT,
      in_uncached INTEGER, in_cache_read INTEGER, cache_write_5m INTEGER,
      cache_write_1h INTEGER, in_cache_write INTEGER, out_total INTEGER,
      session_id TEXT, store TEXT, subscription_id TEXT,
      subscription_conflict INTEGER NOT NULL DEFAULT 0, gap_seconds REAL
    );
    CREATE TABLE oc_events (
      id INTEGER PRIMARY KEY, store TEXT DEFAULT 'opencode', message_id TEXT DEFAULT 'o1',
      ts TEXT, repo TEXT, project_id TEXT, model TEXT, provider TEXT, directory TEXT,
      in_tok INTEGER, cache_read INTEGER, cache_write INTEGER, out_tok INTEGER,
      session_id TEXT, cost_ticks INTEGER, gap_seconds REAL
    );
    CREATE TABLE grok_events (
      id INTEGER PRIMARY KEY, prompt_id TEXT DEFAULT 'g1',
      ts TEXT, repo TEXT, project_id TEXT, model TEXT,
      in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
      reasoning INTEGER, cost_ticks INTEGER, session_id TEXT, store TEXT, gap_seconds REAL
    );
  `);
  db.run(
    `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
     VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000, 0, 0, 100, 0, 'sess-1')`,
  );
  db.run(
    `INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
     VALUES (1, 'c1', '2026-08-12T12:00:00Z', 'my-repo', 'my-app', 'claude-3-5-sonnet', 'standard', 1000, 0, 0, 0, 0, 100, 'c1', 'claude', 'claude', 0)`,
  );
  db.run(
    `INSERT INTO oc_events (ts, repo, project_id, model, provider, in_tok, cache_read, cache_write, out_tok, session_id)
     VALUES ('2026-08-11T12:00:00Z', 'my-repo', 'my-app', 'glm-4.6', 'zai', 1000, 0, 0, 100, 'o1')`,
  );
  db.run(
    `INSERT INTO grok_events (ts, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning, cost_ticks, session_id, store)
     VALUES ('2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'grok-4', 1000, 0, 0, 100, 0, 1000, 'g1', 'grok')`,
  );
  createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  for (const [provider, account] of [["claude", "claude"], ["grok", "grok"], ["glm", "opencode"]] as const) {
    let steps = 0;
    while (!prepareSubscriptionFacts(db, provider, account, undefined, 100,emptyCards).complete) {
      if (++steps > 100) throw new Error("Synthetic facts did not finish bounded preparation");
    }
  }
  prepareCodexLedgerFixture(db,emptyCards as never);
  return db;
}

function stubCtx(sqlite: Database): AppContext {
  return {
    sqlite,
    rateCards: emptyCards,
    eras: buildEraIndex(periodEras(sqlite, { version: 2, subscriptions: [], sources: [] }), "instant"),
    accounts: { version: 2, subscriptions: [], sources: [] },
    homeToSubId: new Map(), subIdToHomes: new Map(),
    homeConflict: null,
  } as unknown as AppContext;
}

describe("repo-history cancellation", () => {
  it("matches the synchronous payload when not aborted", async () => {
    const db = createTestDb();
    const sync = buildRepoHistory(db, histOpts);
    const async = await buildRepoHistoryCancellable(db, histOpts);
    expect(async).toEqual(sync);
    expect(async.subject).toEqual({ kind: "project", id: "my-app" });
    expect(async.points.length).toBeGreaterThan(0);
  });

  it("stops remaining SQLite/JS aggregation after work has begun", async () => {
    const db = createTestDb();
    const ac = new AbortController();
    const phases: string[] = [];
    const started = { query: false };
    const origQuery = db.query.bind(db);
    Object.assign(db, {
      query(sql: string) {
        started.query = true;
        if (ac.signal.aborted) {
          throw new Error(`query ran after abort: ${sql.slice(0, 80)}`);
        }
        return origQuery(sql);
      },
    });

    const run = buildRepoHistoryCancellable(db, histOpts, {
      signal: ac.signal,
      onCheckpoint(phase) {
        phases.push(phase);
        if (phase === "sources:claude") ac.abort();
      },
    });

    await expect(run).rejects.toBeInstanceOf(HistoryAbortedError);
    expect(started.query).toBe(true);
    expect(phases).toEqual(["sources:claude"]);
    expect(phases).not.toContain("sources:codex");
    expect(phases).not.toContain("dollars:codex");
  });

  it("does not cache an aborted repo-history response", async () => {
    const fetch = createFetchHandler(stubCtx(createTestDb()));
    const url = "http://127.0.0.1/api/repo-history?project=my-app&granularity=day&by=none";
    const ac = new AbortController();
    ac.abort();
    const aborted = await fetch(new Request(url, { signal: ac.signal }));
    expect(aborted.status).toBe(499);
    const abortedText = await aborted.text();
    expect(abortedText).toBe("");

    const miss = await fetch(new Request(url));
    expect(miss.status).toBe(200);
    expect(miss.headers.get("X-Cache")).toBe("miss");
    const body = (await miss.json()) as { subject?: { id: string }; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.subject?.id).toBe("my-app");

    const hit = await fetch(new Request(url));
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Cache")).toBe("hit");
  });
});
