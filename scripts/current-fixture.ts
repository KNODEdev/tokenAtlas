/** Synthetic, read-only browser fixture for the restored overview and current APIs.
 * No user configuration, live providers, archive, polling workers or sync subprocesses.
 */
import "./test-environment";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { createFetchHandler, rebuildSubscriptionMaps, type AppContext } from "../src/server/api";
import { buildEraIndex } from "../src/server/eras";
import { currentRegistry } from "../src/server/current/registry";
import { publishCurrentBatch } from "../src/server/current/store";
import { ARCHIVE_LOGICAL_ROOT } from "../src/config/paths";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../src/db/period-store";
import { fixtureCodexRateCard } from "../src/server/codex-ledger.fixture";
import { prepareUsageRegisters } from "../src/server/usage-register.fixture";
import { prepareProbeReaderFixture } from "../src/server/probe-reader.fixture";
import { prepareLimitWindowsFixture } from "../src/server/limit-windows.fixture";
import { prepareWindowUsageFixture } from "../src/server/window-usage.fixture";

const sqlite = new Database(":memory:");
applyDrizzleMigrations(drizzle(sqlite));
const subscriptions = [
  { id: "codex1", vendor: "codex", account: "alpha@example.test", status: "active" as const },
  { id: "codex2", vendor: "codex", account: "beta@example.test", status: "active" as const },
];
const sources = [
  { vendor: "codex", machine: "PC-A", login: "review-a", home: `${ARCHIVE_LOGICAL_ROOT}/codex/a`, source_home: "C:/Users/review-a/.codex" },
  { vendor: "codex", machine: "PC-B", login: "review-b", home: `${ARCHIVE_LOGICAL_ROOT}/codex/b`, source_home: "C:/Users/review-b/.codex" },
];
const accounts = { version: 2 as const, subscriptions, sources };
const now = Date.now();
const day = 86400_000;
sqlite.exec(`
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, home TEXT NOT NULL, path TEXT NOT NULL,
    ts TEXT NOT NULL, surface TEXT, model TEXT, project_id TEXT, cwd TEXT,
    in_tok INTEGER NOT NULL DEFAULT 0, cached_in INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
    reasoning_out INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE ratelimit (home TEXT NOT NULL, path TEXT, ts TEXT NOT NULL,
    window_minutes INTEGER NOT NULL, limit_id TEXT NOT NULL, used_percent REAL NOT NULL,
    resets_at INTEGER, plan_type TEXT, limit_name TEXT);
`);
sqlite.transaction(() => {
  for (const [index, sub] of subscriptions.entries()) {
    for (let cycle = 0; cycle < 3; cycle++) {
      const reset = now + 3 * day - (2 - cycle) * 7 * day;
      for (let point = 0; point < 5; point++) {
        const ts = new Date(reset - 7 * day + point * day - 60_000).toISOString();
        sqlite.query(`INSERT INTO events(home, path, ts, surface, model, project_id, in_tok, cached_in, out_tok)
          VALUES (?, ?, ?, 'cli', 'gpt-5', 'review-project', ?, ?, ?)`)
        .run(sources[index]!.home, `${sources[index]!.home}/cycle-${cycle}.jsonl`, ts, 1000 + point * 100, 800, 200);
        sqlite.query(`INSERT INTO ratelimit VALUES (?, ?, ?, 10080, 'codex', ?, ?, 'pro', 'weekly')`)
          .run(sources[index]!.home, `${sources[index]!.home}/cycle-${cycle}.jsonl`, ts, 5 + point * 8 + index * 10, Math.floor(reset / 1000));
      }
    }
    sqlite.query(`INSERT INTO probe_windows(provider, subject, ts, kind, limit_group, scope,
      reported_percent_side, used_percent, window_minutes, resets_at, machine, profile, extra)
      VALUES ('codex', ?, ?, 'secondary', 'codex', 'subscription', 'used', ?, 10080, ?, ?, ?, ?)`)
      .run(sub.id, new Date(now - 60_000).toISOString(), 37 + index * 10, new Date(now + 3 * day).toISOString(),
        sources[index]!.machine, sources[index]!.login, JSON.stringify({ home: sources[index]!.source_home }));
  }
  sqlite.exec("UPDATE sync_revisions SET data_revision=1 WHERE id=1");
})();
replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, sources.map((source, index) => ({ provider: "codex",
  subject: `codex/${String.fromCharCode(97 + index)}`, value: subscriptions[index]!.id, from: "2000-01-01", until: null,
  origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "synthetic current fixture" })));
const ctx: AppContext = {
  sqlite, accounts, eraErrors: [], homeConflict: null,
  homeToSubId: new Map(), subIdToHomes: new Map(), eras: buildEraIndex(subscriptions),
  rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {
    openai: { models: { "gpt-5": { in_uncached: 1.25, in_cache_read: 0.125, in_cache_write: 0, out_total: 10 } } },
  } },
  claudeGauge: {} as AppContext["claudeGauge"], grokGauge: {} as AppContext["grokGauge"],
  cycles: {} as AppContext["cycles"], plans: {} as AppContext["plans"],
  plansCatalog: {} as AppContext["plansCatalog"], rootDir: import.meta.dir,
  probeSourceExists: () => false,
};
rebuildSubscriptionMaps(ctx);
ctx.rateCards=fixtureCodexRateCard(ctx.rateCards);
const declaredSources=sources.map((source,index)=>({...source,id:subscriptions[index]!.id}));
prepareUsageRegisters(sqlite,ctx.rateCards,declaredSources,ctx.homeToSubId);
prepareProbeReaderFixture(sqlite,declaredSources);
// The maintenance worker stores windows and their sums before screens read them; this fixture has no worker.
prepareLimitWindowsFixture(sqlite,{sources:declaredSources,subscriptions});
prepareWindowUsageFixture(sqlite,{rateCards:ctx.rateCards,subscriptions,manualCapacity:()=>[],cycles:{windows:[]}});
const projectionTime=new Date().toISOString();
for (let step=0;step<1000;step++) {
  if (!publishCurrentBatch(sqlite,currentRegistry(subscriptions,projectionTime),projectionTime,32,accounts)) break;
  if (step===999) throw new Error("Synthetic current fixture did not settle");
}
const fetch = createFetchHandler(ctx);
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (!["GET", "HEAD"].includes(req.method)) return new Response("Read-only fixture", { status: 405 });
    // Setup reads files in normal operation; never use the operator's filesystem here.
    if (url.pathname === "/api/setup") return Response.json({ configured: true });
    return fetch(req);
  },
});
console.log(`CURRENT_FIXTURE_URL=http://127.0.0.1:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.stop(true); sqlite.close(true); process.exit(0);
});
