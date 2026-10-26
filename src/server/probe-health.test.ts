import { describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../db/probe-facts";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { allProbeHealth, probeFreshMinutes, probeHealth } from "./probe-health";

function database(): Database {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite, { schema }));
  const period = (provider: string, machine: string, account: string, from: string, until: string | null = null) => ({
    provider, subject: provider === "claude" ? `claude/${machine}`.toLowerCase() : `codex/${machine}-${LOGIN}`.toLowerCase(),
    value: account, from, until, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture",
  });
  replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [
    period("codex", "EXAMPLE-MAIN", "codex3", "2026-08-01", "2026-09-01"),
    period("codex", "EXAMPLE-MAIN", "codex1", "2026-09-01"),
    period("codex", "EXAMPLE-LAPTOP-A", "codex1", "2026-09-01"),
    period("codex", "A", "codex1", "2026-09-01"), period("codex", "B", "codex1", "2026-09-01"),
    period("claude", "A", "claude", "2026-09-01"),
  ]);
  return sqlite;
}
const declarations = [{ id: "codex1", vendor: "codex" }, { id: "codex3", vendor: "codex" }, { id: "claude", vendor: "claude" }];
const config = splitProbeReaderFixtureConfig([
  ...declarations,
  ...["EXAMPLE-MAIN", "EXAMPLE-LAPTOP-A", "A", "B"].map(machine => ({ id: "codex1", vendor: "codex",
    machine, login: LOGIN, home: `${ARCHIVE_LOGICAL_ROOT}/codex/${machine}-${LOGIN}`, source_home: `C:/Users/${LOGIN}/.codex` })),
  { id: "claude", vendor: "claude", machine: "A", login: LOGIN,
    home: `${ARCHIVE_LOGICAL_ROOT}/claude/A`, source_home: `C:/Users/${LOGIN}/.claude` },
]);
function settle(sqlite: Database) {
  for (let n = 0; n < 30; n++) if (!publishCurrentBatch(sqlite, currentRegistry(config.subscriptions, new Date(NOW).toISOString()),
    new Date(NOW).toISOString(), 32, config)) return;
  throw new Error("current projection did not settle");
}

function sample(
  sqlite: Database,
  row: { provider?: string; subject?: string; ts: string; machine: string | null; ok?: boolean; error?: string | null }
): void {
  const failed = row.ok === false;
  const home = `C:/Users/${LOGIN}/.${row.provider ?? "codex"}`;
  const id = Number(sqlite
    .query(
      `INSERT INTO probe_windows (provider, subject, ts, kind, limit_group, reported_percent_side, used_percent, ok, error, machine, extra)
       VALUES (?, ?, ?, ?, ?, 'used', ?, ?, ?, ?, ?)`
    )
    .run(
      row.provider ?? "codex",
      row.subject ?? "codex1",
      row.ts,
      failed ? "error" : "primary",
      failed ? "-" : "codex",
      failed ? null : 42,
      failed ? 0 : null,
      row.error ?? null,
      row.machine,
      JSON.stringify({ home }),
    ).lastInsertRowid);
  const projected = sqlite.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
  const fact = createProbeCollection([{ ...projected, raw_subject: null, login: LOGIN, source_home: home }])[0]!;
  sqlite.transaction(() => { acceptProbeFact(sqlite, fact); mapProbeLegacy(sqlite, fact, id, "fixture-linked"); }).immediate();
}

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

describe("probeHealth", () => {
  test("newest good sample wins across machines; errors are reported per machine", () => {
    const sqlite = database();
    sample(sqlite, { ts: "2026-09-02T11:50:00.000Z", machine: "EXAMPLE-LAPTOP-A" });
    sample(sqlite, { ts: "2026-09-02T11:56:00.000Z", machine: "EXAMPLE-MAIN" });
    sample(sqlite, { ts: "2026-09-02T11:58:00.000Z", machine: "EXAMPLE-LAPTOP-A", ok: false, error: "app-server timeout" });
    settle(sqlite);
    const health = probeHealth(sqlite, "codex", "CODEX1", NOW, 15);
    expect(health.state).toBe("fresh");
    expect(health.reading).toEqual({ ts: "2026-09-02T11:56:00.000Z", age_minutes: 4, machine: "EXAMPLE-MAIN" });
    expect(health.machines).toEqual([
      { machine: "EXAMPLE-LAPTOP-A", last_ok_ts: "2026-09-02T11:50:00.000Z", last_error_ts: "2026-09-02T11:58:00.000Z", last_error: "app-server timeout" },
      { machine: "EXAMPLE-MAIN", last_ok_ts: "2026-09-02T11:56:00.000Z", last_error_ts: null, last_error: null },
    ]);
  });

  test("a reading older than the fresh window is stale; only errors is none with reasons", () => {
    const sqlite = database();
    sample(sqlite, { ts: "2026-09-01T20:00:00.000Z", machine: "EXAMPLE-MAIN" });
    settle(sqlite);
    expect(probeHealth(sqlite, "codex", "codex1", NOW, 15).state).toBe("stale");
    sample(sqlite, { subject: "codex3", ts: "2026-08-30T08:00:00.000Z", machine: "EXAMPLE-MAIN", ok: false, error: "auth.json missing" });
    settle(sqlite);
    const none = probeHealth(sqlite, "codex", "codex3", NOW, 15);
    expect(none.state).toBe("none");
    expect(none.reading).toBeNull();
    expect(none.machines).toEqual([
      { machine: "EXAMPLE-MAIN", last_ok_ts: null, last_error_ts: "2026-08-30T08:00:00.000Z", last_error: "auth.json missing" },
    ]);
  });

  test("unknown physical machine stays unassigned and a proven sample with stale subject is readable", () => {
    const sqlite = database();
    sample(sqlite, { ts: "2026-09-02T11:59:00.000Z", machine: null });
    sample(sqlite, { subject: "codex3", ts: "2026-09-02T11:59:30.000Z", machine: "EXAMPLE-MAIN" });
    settle(sqlite);
    const health = probeHealth(sqlite, "codex", "codex1", NOW, 15);
    expect(health.reading?.ts).toBe("2026-09-02T11:59:30.000Z");
    expect(health.machines.map(row => row.machine)).toEqual(["EXAMPLE-MAIN"]);
  });

  test("allProbeHealth lists every probed pair once", () => {
    const sqlite = database();
    sample(sqlite, { ts: "2026-09-02T11:50:00.000Z", machine: "A" });
    sample(sqlite, { ts: "2026-09-02T11:51:00.000Z", machine: "B", subject: "Codex1" });
    sample(sqlite, { provider: "claude", subject: "claude", ts: "2026-09-02T11:52:00.000Z", machine: "A" });
    settle(sqlite);
    expect(allProbeHealth(sqlite, NOW).map((h) => `${h.provider}/${h.subject.toLowerCase()}`)).toEqual(["claude/claude", "codex/codex1"]);
  });

  test("fresh window follows the poller interval", () => {
    expect(probeFreshMinutes("codex", { TOKENATLAS_PROBE_MINUTES: "5" })).toBe(15);
    expect(probeFreshMinutes("gemini", { TOKENATLAS_GEMINI_MINUTES: "30" })).toBe(90);
    expect(probeFreshMinutes("claude", { TOKENATLAS_PROBE_MINUTES: "garbage" })).toBe(30);
    expect(probeFreshMinutes("claude", {})).toBe(30);
  });
});
