import { describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";
import {
  latestAccountState,
  selectCodexPlanState,
  type AccountStateRow,
} from "./api";
function state(overrides: Partial<AccountStateRow>): AccountStateRow {
  return {
    account: "codex2",
    limit_id: "codex",
    limit_name: null,
    plan_type: "plus",
    slot: "primary",
    window_minutes: 300,
    used_percent: 12,
    resets_at: 1_800_000_000,
    resets_at_iso: "2027-01-15T08:00:00.000Z",
    rate_limit_reached: false,
    reset_credits: 0,
    ts: "2026-08-27T18:00:00.000Z",
    age_minutes: 0,
    machine: null,
    ...overrides,
  };
}
describe("selectCodexPlanState", () => {
  it("puts the Free 30-day meter in the headline without inventing a weekly or 5h reading", () => {
    const monthly = state({ plan_type: "free", window_minutes: 43200, used_percent: 100, rate_limit_reached: true });
    expect(selectCodexPlanState([monthly], "codex2", 10080)).toEqual({ live: monthly, other: [] });
    expect(selectCodexPlanState([monthly], "codex2", 300)).toEqual({ live: null, other: [monthly] });
  });
  it("uses duration, not the primary slot, and keeps plan 5h separate", () => {
    const short = state({ slot: "primary", window_minutes: 300, used_percent: 61 });
    const weekly = state({ slot: "secondary", window_minutes: 10_080, used_percent: 24 });
    const reserve = state({
      limit_id: "base_model_inference",
      limit_name: "gpt-reserve",
      slot: "primary",
      window_minutes: 10_080,
    });
    const selected = selectCodexPlanState([short, weekly, reserve], "codex2", 10_080);
    expect(selected.live).toBe(weekly);
    expect(selected.other).toEqual([short, reserve]);
  });
});
describe("latestAccountState", () => {
  it("drops an optional window absent from the newest successful snapshot", () => {
    const sqlite = new Database(":memory:");
    applyDrizzleMigrations(drizzle(sqlite));
    const insert = sqlite.prepare(`
      INSERT INTO probe_windows
        (provider, subject, ts, plan, kind, limit_group, scope, used_percent,
         window_minutes, resets_at, rate_limit_reached, reset_credits, reported_percent_side)
      VALUES ('codex', 'codex2', ?, 'plus', ?, 'codex', NULL, ?, ?, ?, 0, 0, 'used')
    `);
    insert.run("2026-08-27T17:00:00.000Z", "primary", 40, 300, "2026-08-27T22:00:00.000Z");
    insert.run("2026-08-27T17:00:00.000Z", "secondary", 20, 10_080, "2026-09-03T17:00:00.000Z");
    insert.run("2026-08-27T18:00:00.000Z", "primary", 5, 10_080, "2026-09-03T18:00:00.000Z");
    prepareProbeReaderFixture(sqlite, [probeReaderFixtureSource("codex", "codex2")]);
    const rows = latestAccountState({ sqlite } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.window_minutes).toBe(10_080);
    expect(rows[0]!.used_percent).toBe(5);
    sqlite.close();
  });
});
