import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";
import { windowCreditPools } from "./api-window-rail";
import type { AppContext } from "./app-context-types";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import path from "node:path";

test("the application pool reader includes the predecessor, preserves corrections and writes no rows", () => {
  const db = new Database(":memory:");
  try {
    applyDrizzleMigrations(drizzle(db), path.resolve(import.meta.dir, "../../drizzle"));
    const add = (day: number, used: number) => db.run(`INSERT INTO probe_windows(provider,subject,ts,kind,ok,extra,reported_percent_side)
      VALUES('claude','pool-seat',?,'weekly_all',1,?,'used')`, [`2026-10-${day}T12:00:00.000Z`, JSON.stringify({
        "claude.raw.grant.limit_dollars": 250, "claude.raw.grant.used_dollars": used, "claude.raw.grant.remaining_dollars": 250 - used,
      })]);
    add(10, 3); add(12, 8); add(13, 20);
    prepareProbeReaderFixture(db, [probeReaderFixtureSource("claude", "pool-seat")]);
    const ctx = { sqlite: db } as AppContext;
    const segment = { id: "window", start: "2026-10-11T12:00:00.000Z", end: "2026-10-14T12:00:00.000Z" } as ProbeLimitWindow;
    const before = db.query("SELECT total_changes() AS n").get() as { n: number };
    const read = () => windowCreditPools(ctx, "claude", "pool-seat", [segment]).get("window")!;
    const result = read();
    expect(result.flows[0]).toMatchObject({ since: "2026-10-10T12:00:00.000Z", spent: 17 });
    expect(result.timelines?.[0]!.movements.map(step => step.spent)).toEqual([5, 12]);
    expect(read()).toEqual(result);
    expect((db.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before.n);
    db.run("UPDATE probe_windows SET extra=? WHERE ts='2026-10-12T12:00:00.000Z'", [JSON.stringify({
      "claude.raw.grant.limit_dollars": 250, "claude.raw.grant.used_dollars": 10, "claude.raw.grant.remaining_dollars": 240,
    })]);
    expect(read().timelines?.[0]!.movements.map(step => step.spent)).toEqual([7, 10]);
    expect(read().flows[0]!.spent).toBe(17);
  } finally { db.close(); }
});
