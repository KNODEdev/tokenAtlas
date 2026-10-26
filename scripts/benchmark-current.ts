/** Synthetic P0 benchmark; never reads an operator's database or private configuration. */
import "./test-environment";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { currentRegistry } from "../src/server/current/registry";
import { publishCurrentBatch } from "../src/server/current/store";
import { handleCurrentRequest } from "../src/server/current/http";
import { ARCHIVE_LOGICAL_ROOT } from "../src/config/paths";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../src/db/period-store";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-current-bench-"));
const dbPath = path.join(directory, "atlas.sqlite");
const count = 100_000;
const now = "2026-09-05T12:00:00.000Z";
const subscriptions = Array.from({ length: 20 }, (_, i) => ({ id: `subscription-${i}`, vendor: "codex" }));
const sources = subscriptions.flatMap((subscription, i) => ["PC-A", "PC-B"].map(machine => ({
  vendor: "codex", machine, login: "fixture", home: `${ARCHIVE_LOGICAL_ROOT}/codex/${subscription.id}-${machine}`,
  source_home: `C:/probe-bench/${i}/.codex`,
})));
const accounts = { version: 2 as const, subscriptions, sources };
let sqlite = new Database(dbPath);
try {
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
  applyDrizzleMigrations(drizzle(sqlite));
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, sources.map(source => ({ provider: "codex",
    subject: source.home.slice(ARCHIVE_LOGICAL_ROOT.length + 1), value: source.home.includes("subscription-")
      ? source.home.slice(source.home.indexOf("subscription-"), source.home.lastIndexOf("-")) : "",
    from: "2000-01-01", until: null, origin: "declared" as const, firstSeen: null, lastSeen: null,
    readings: 0, evidence: "synthetic benchmark" })));
  const insert = sqlite.query(`INSERT INTO probe_windows(provider, subject, ts, kind, limit_group, reported_percent_side,
    used_percent, window_minutes, resets_at, machine, profile, extra) VALUES ('codex', ?, ?, ?, 'main', 'used', ?, ?, ?, ?, 'fixture', ?)`);
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const subscription = subscriptions[i % 20]!;
      const machine = i % 3 ? "PC-A" : "PC-B";
      insert.run(subscriptions[i % 20]!.id, new Date(Date.parse(now) - (count - i) * 1000).toISOString(),
        Math.floor(i / 20) % 2 ? "primary" : "secondary", i % 100, Math.floor(i / 20) % 2 ? 300 : 10080,
        "2026-09-05T15:00:00Z", machine, JSON.stringify({ home: `C:/probe-bench/${i % 20}/.codex` }));
    }
  })();
  const buildStart = performance.now();
  while (publishCurrentBatch(sqlite, currentRegistry(subscriptions, now), now, 32, accounts)) {}
  const projectionMs = performance.now() - buildStart;
  const context = () => ({ sqlite, accounts });
  let payloadBytes = 0;
  const measure = async () => {
    const start = performance.now();
    const response = handleCurrentRequest(context(), new Request("http://localhost/api/bootstrap"), now)!;
    payloadBytes = (await response.arrayBuffer()).byteLength;
    return performance.now() - start;
  };
  const warm: number[] = [], cold: number[] = [];
  for (let i = 0; i < 200; i++) warm.push(await measure());
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (let i = 0; i < 30; i++) {
    sqlite.close(true); sqlite = new Database(dbPath, { readonly: true });
    cold.push(await measure());
  }
  const p95 = (samples: number[]) => samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]!;
  const result = { fixture: { subscriptions: 20, raw_probe_rows: count, machines: 2 }, projection_ms: projectionMs,
    warm_p95_ms: p95(warm), reopened_connection_p95_ms: p95(cold), payload_bytes: payloadBytes,
    scope: "Saved projection GET only; excludes migration, process start, archive bootstrap and browser paint." };
  console.log(JSON.stringify(result, null, 2));
  if (result.warm_p95_ms > 100 || result.reopened_connection_p95_ms > 200 || payloadBytes > 64 * 1024)
    throw new Error("Synthetic P0 budget exceeded");
} finally { sqlite.close(true); fs.rmSync(directory, { recursive: true, force: true }); }
