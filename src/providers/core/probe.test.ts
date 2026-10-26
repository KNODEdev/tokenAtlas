import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../../db/migrate";
import * as schema from "../../db/schema";
import type { WindowReading } from "../types";
import { configureGaugeJournal } from "./journal";
import { persistProbeWindows } from "./probe";

it("all five provider persistence boundaries retain independent good/error facts without a journal sink", () => {
  const sqlite = new Database(":memory:"); applyDrizzleMigrations(drizzle(sqlite)); configureGaugeJournal(null);
  try {
    for (const provider of ["claude", "codex", "gemini", "glm", "grok"] as const) {
      persistProbeWindows(sqlite, provider, "fixture", "2026-09-01T12:00:00Z", [reading("primary", 42)]);
      persistProbeWindows(sqlite, provider, "fixture", "2026-09-01T12:00:01Z", [{ ...reading("primary", 42), kind: "error", ok: false, usedPercent: null, error: "synthetic-error" }]);
    }
    const rows = sqlite.query("SELECT payload FROM probe_counters").all() as { payload: string }[];
    expect(rows).toHaveLength(10);
    expect(rows.map(r => JSON.parse(r.payload)).filter(p => p.error === "synthetic-error" && p.used_percent === null)).toHaveLength(5);
    expect(sqlite.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
  } finally { sqlite.close(true); }
});

const directories: string[] = [];

function reading(group: string, usedPercent: number): WindowReading {
  return {
    kind: "weekly_scoped",
    group,
    scope: "Fable",
    plan: "Max",
    reportedPercentSide: "used",
    usedPercent,
    remainingPercent: null,
    allowance: null,
    used: null,
    remaining: null,
    vendorPercent: usedPercent,
    windowMinutes: 10_080,
    resetsAt: "2026-09-08T00:00:00.000Z",
    rateLimitReached: false,
    resetCredits: null,
    profile: null,
    ok: true,
    error: null,
    extra: null,
  };
}

afterEach(() => {
  configureGaugeJournal(null);
  const tempRoot = path.resolve(os.tmpdir());
  while (directories.length > 0) {
    const directory = path.resolve(directories.pop()!);
    if (path.dirname(directory) !== tempRoot || !path.basename(directory).startsWith("tokenatlas-probe-test-")) continue;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can retain a SQLite handle until process teardown.
    }
  }
});

describe("probe window persistence identity", () => {
  it("migrates the production Claude key without rewriting rows and persists same-scope limit groups separately", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-probe-test-"));
    directories.push(directory);
    const sqlite = new Database(path.join(directory, "atlas.sqlite"), { create: true });
    applyDrizzleMigrations(drizzle(sqlite, { schema }));
    configureGaugeJournal(null);

    // Recreate the pre-0019 index on the otherwise production-migrated table,
    // seed an existing row, then exercise the actual migration statements.
    sqlite.exec("DROP INDEX probe_windows_claude_sample_unique");
    sqlite.exec(`CREATE UNIQUE INDEX probe_windows_claude_sample_unique
      ON probe_windows (provider, subject, kind, scope, ts) WHERE provider = 'claude'`);
    persistProbeWindows(sqlite, "claude", "claude-work", "2026-09-01T12:00:00.000Z", [reading("primary", 10)]);
    const before = sqlite.query(
      "SELECT id, provider, subject, kind, limit_group, scope, ts, used_percent FROM probe_windows WHERE provider = 'claude'"
    ).all();
    const migration = fs.readFileSync(
      path.resolve(import.meta.dir, "../../../drizzle/0019_fix_claude_probe_identity.sql"),
      "utf8"
    );
    sqlite.exec(migration.replace(/--> statement-breakpoint/g, ";"));
    expect(sqlite.query(
      "SELECT id, provider, subject, kind, limit_group, scope, ts, used_percent FROM probe_windows WHERE provider = 'claude'"
    ).all()).toEqual(before);

    persistProbeWindows(sqlite, "claude", "claude-work", "2026-09-01T12:00:00.000Z", [
      reading("primary", 20),
      reading("secondary", 30),
    ]);
    expect(sqlite.query(
      "SELECT limit_group, used_percent FROM probe_windows WHERE provider = 'claude' ORDER BY limit_group"
    ).all()).toEqual([
      { limit_group: "primary", used_percent: 20 },
      { limit_group: "secondary", used_percent: 30 },
    ]);
    const indexSql = sqlite.query(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'probe_windows_claude_sample_unique'"
    ).get() as { sql: string };
    expect(indexSql.sql).toContain("`limit_group`");
    sqlite.close();
  });
});
