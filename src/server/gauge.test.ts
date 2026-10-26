import { afterEach, expect, test } from "bun:test";
import { handleGauge, type AppContext } from "./api";
import { database, opened } from "./window-usage-codex.fixture";

/** /api/gauge reads the account's meter samples by home and each sampled file's models from the Codex ledger's file rows. */
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

test("a cluster lists the models its sampled files used, as the files' calls recorded them", async () => {
  const db = database();
  db.exec(`CREATE TABLE ratelimit(home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL, resets_at INTEGER,
    plan_type TEXT, limit_id TEXT, limit_name TEXT, source_offset INTEGER, source_slot TEXT)`);
  const files = db.query("SELECT home, path, ts FROM events ORDER BY ts").all() as Array<{ home: string; path: string; ts: string }>;
  const reset = (ts: string) => Math.floor((Date.parse(ts) / 1000 + 7 * 86400) / 604800) * 604800;
  for (const file of files) db.query(`INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,resets_at,plan_type,limit_id)
    VALUES(?,?,?,10080,10,?,'pro','codex')`).run(file.home.toUpperCase(), file.path, file.ts, reset(file.ts));
  // Stored under another spelling of the home: the same file of the same home.
  db.query("UPDATE events SET home=upper(home)").run();
  db.query("UPDATE codex_price_ledger_copies SET home=upper(home)").run();
  const ctx = { sqlite: db, subIdToHomes: new Map([["codex1", ["/archive", "/laptop"]]]) } as unknown as AppContext;
  const body = await handleGauge(ctx, new URL("http://local/api/gauge?account=codex1")).json() as
    { clusters: Array<{ anchor: number; models: string[]; sample_count: number }> };
  expect(body.clusters.reduce((sum, cluster) => sum + cluster.sample_count, 0)).toBe(files.length);
  const expected = new Map<number, Set<string>>();
  for (const row of db.query("SELECT r.resets_at anchor, e.model FROM ratelimit r JOIN events e ON e.path=r.path").all() as Array<{ anchor: number; model: string }>)
    expected.set(row.anchor, (expected.get(row.anchor) ?? new Set()).add(row.model));
  expect(body.clusters.map(cluster => [cluster.anchor, cluster.models]))
    .toEqual([...expected].map(([anchor, models]) => [anchor, [...models].sort()]));
  expect(body.clusters.some(cluster => cluster.models.length > 1)).toBe(true);
});
