import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { applyDrizzleMigrations } from "../../db/migrate";
import { buildEraIndex, type EraDeclaration } from "../../server/eras";
import { parseGrokBilling, readLatestGrokBilling, runGrokProbeCycle } from "./grok";
const MIGRATIONS = path.resolve(import.meta.dir, "../../../drizzle");
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("Grok Billing adapter", () => {
  it("reads the newest official CLI snapshot without touching credentials", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-grok-"));
    temporary.push(home);
    fs.mkdirSync(path.join(home, "logs"));
    fs.writeFileSync(
      path.join(home, "logs", "unified.jsonl"),
      [
        JSON.stringify({
          ts: "2026-08-27T19:00:00.000Z",
          msg: "billing: fetched credits config",
          ctx: { config: { creditUsagePercent: 31 } },
        }),
        JSON.stringify({ ts: "2026-08-27T19:01:00.000Z", msg: "shell.turn.inference_done", ctx: {} }),
        JSON.stringify({
          ts: "2026-08-27T20:30:45.478Z",
          msg: "billing: fetched credits config",
          ctx: {
            config: {
              creditUsagePercent: 33,
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: "2026-08-25T20:23:41.4225+02:00",
                end: "2026-09-01T20:23:41.4225+02:00",
              },
              isUnifiedBillingUser: true,
            },
            subscriptionTier: "SuperGrok",
          },
        }),
        "",
      ].join("\n")
    );
    const snapshot = readLatestGrokBilling(home);
    expect(snapshot?.ts).toBe("2026-08-27T20:30:45.478Z");
    const [window] = parseGrokBilling(snapshot!.billing);
    expect(window?.usedPercent).toBe(33);
    expect(window?.kind).toBe("weekly");
    expect(window?.plan).toBe("SuperGrok");
    expect(window?.resetsAt).toBe("2026-09-01T18:23:41.422Z");
    expect(window?.windowMinutes).toBe(10_080);
  });
  it("keeps compatibility with the legacy allowance/used shape", () => {
    const [window] = parseGrokBilling({
      config: {
        monthlyLimit: { val: "2000" },
        used: { val: 500 },
        billingPeriodStart: "2026-08-01T00:00:00Z",
        billingPeriodEnd: "2026-09-01T00:00:00Z",
      },
    });
    expect(window?.usedPercent).toBe(25);
    expect(window?.allowance).toBe(2000);
    expect(window?.used).toBe(500);
  });

  it("does not resurrect an old snapshot under the current era once it carries its own era", async () => {
    const sqlite = new Database(":memory:");
    applyDrizzleMigrations(drizzle(sqlite), MIGRATIONS);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-grok-era-"));
    temporary.push(home);
    fs.mkdirSync(path.join(home, "logs"));
    fs.writeFileSync(
      path.join(home, "logs", "unified.jsonl"),
      JSON.stringify({
        ts: "2026-08-26T20:30:45.478Z",
        msg: "billing: fetched credits config",
        ctx: {
          config: { creditUsagePercent: 33 },
          subscriptionTier: "SuperGrok",
        },
      }) + "\n"
    );
    const declarations: EraDeclaration[] = [
      { id: "grok-old", vendor: "grok", home, source_home: home, until: "2026-08-27" },
      { id: "grok-new", vendor: "grok", home, source_home: home, from: "2026-08-27" },
    ];
    await runGrokProbeCycle(sqlite, "grok-new", home);
    // A row stamped before its era was declared, as the retired era restamp left them.
    sqlite.exec("UPDATE probe_windows SET subject = 'grok-old' WHERE provider = 'grok'");

    const eras = buildEraIndex(declarations);
    const repeated = await runGrokProbeCycle(
      sqlite,
      "grok-new",
      home,
      undefined,
      (sourceTs) => eras.resolve("grok", home, sourceTs)
    );
    expect(repeated.rows).toBe(0);
    expect(
      sqlite.query(`SELECT subject, ts FROM probe_windows WHERE provider = 'grok'`).all()
    ).toEqual([{ subject: "grok-old", ts: "2026-08-26T20:30:45.478Z" }]);
    sqlite.close();
  });
});
