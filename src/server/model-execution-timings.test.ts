import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { advanceModelSpeeds } from "../db/model-speed-register";
import { replaceFirstTokenFile } from "../db/first-token";
import { TIMED_SUMS } from "../db/usage-ledger";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS } from "./claude-code-capacity.fixture";
import { loadAccountResolver, buildAccountResolver } from "./account-resolver";
import { modelSpeedSeries } from "./model-speed";
import { readModeSpeedHours } from "./model-speed-read";
import { readFirstTokenTimes, attachFirstTokenTimes } from "./first-token-read";
import { executionKey } from "../shared/model-execution";
import { firstTokenSummary } from "../shared/first-token";

function drain(db: Database) {
  for (let i = 0; i < 1000; i++) if (!advanceModelSpeeds(db, { budgetMs: 10000, limit: 3 }).pending) return;
  throw new Error("Timing projection did not finish");
}

test("mode migration preserves every completed TTFT measurement and marks legacy mode attribution as pending", () => {
  const db = new Database(":memory:");
  try {
    db.exec(fs.readFileSync(new URL("../../drizzle/0095_first_token.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO response_time_copies VALUES('codex','h','p','turn','codex/pc','same','2026-10-25T10:00:00.000Z',1234,'allowance',NULL);
      INSERT INTO response_time_turns SELECT provider,turn_id,source,model,ts,ms,billing,reason FROM response_time_copies;
      INSERT INTO response_time_hours VALUES('codex','codex/pc','same','allowance',498034,1234,1);
      INSERT INTO response_time_queue(provider,owner,path,priority) VALUES('codex','h','already-pending',42)`);
    const rows = db.query("SELECT * FROM response_time_turns").all(), queue = db.query("SELECT * FROM response_time_queue").all();
    db.exec(fs.readFileSync(new URL("../../drizzle/0096_model_execution_timings.sql", import.meta.url), "utf8"));
    expect(db.query("SELECT provider,turn_id,source,model,ts,ms,billing,reason FROM response_time_turns").all()).toEqual(rows);
    expect(db.query("SELECT mode_known,ms,turns FROM response_time_hours").all()).toEqual([{ mode_known: 0, ms: 1234, turns: 1 }]);
    expect(db.query("SELECT * FROM response_time_queue").all()).toEqual(queue);
  } finally { db.close(); }
});
test("execution timing projection preserves canonical calls, separates settings, resumes and corrects without repricing", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const db = f.db;
    db.exec(`UPDATE claude_events SET effort=CASE WHEN id%3=0 THEN 'ultra' WHEN id%3=1 THEN 'high' ELSE NULL END,
      resp_ms=1000+id*100,speed=CASE WHEN id%2=0 THEN 'fast' ELSE 'standard' END`);
    f.prepareFacts();
    const before = db.query("SELECT row_id,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto FROM usage_ledger_facts ORDER BY row_id").all();
    expect(advanceModelSpeeds(db, { limit: 1, budgetMs: 10000 }).pending).toBe(true);
    f.reopen(); drain(f.db);
    const reference = f.db.query(`SELECT f.speed,e.effort,COUNT(*) calls,SUM(f.q_out) output,SUM(f.resp_ms) ms
      FROM usage_ledger_facts f JOIN claude_events e ON e.id=f.row_id
      WHERE f.provider='claude' AND f.accounting=1 AND f.copy_state='canonical' GROUP BY f.speed,e.effort ORDER BY f.speed,e.effort`).all();
    expect(f.db.query(`SELECT speed,effort,SUM(calls) calls,SUM(timed_out) output,SUM(timed_ms) ms
      FROM model_speed_hours WHERE provider='claude' GROUP BY speed,effort ORDER BY speed,effort`).all()).toEqual(reference);
    expect(f.db.query("SELECT row_id,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto FROM usage_ledger_facts ORDER BY row_id").all()).toEqual(before);
    const read = () => modelSpeedSeries(readModeSpeedHours(f.db, loadAccountResolver(f.db), "claude", ACCOUNTS.a).hours, "day");
    expect(new Set(read().map(s => executionKey(s.model, s))).size).toBe(read().length);
    expect(read().some(s => s.effort === "ultra")).toBe(true);
    const canonical = f.db.query("SELECT row_id FROM usage_ledger_facts WHERE provider='claude' AND copy_state='canonical' AND accounting=1 LIMIT 1").get() as { row_id: number };
    f.db.query("UPDATE claude_events SET effort='max' WHERE id=?").run(canonical.row_id);
    drain(f.db);
    expect(f.db.query("SELECT effort FROM model_speed_facts WHERE provider='claude' AND event_id=?").get(canonical.row_id)).toEqual({ effort: "max" });
    const snapshot = f.db.query("SELECT * FROM model_speed_hours ORDER BY provider,key,hour").all();
    f.db.exec("DELETE FROM model_speed_facts; DELETE FROM model_speed_hours; INSERT INTO model_speed_queue SELECT provider,row_id FROM usage_ledger_facts");
    drain(f.db);
    expect(f.db.query("SELECT * FROM model_speed_hours ORDER BY provider,key,hour").all()).toEqual(snapshot);
    const changes = f.db.query("SELECT total_changes() n").get();
    read(); drain(f.db); read();
    expect(f.db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { f.teardown(); }
});

test("TTFT modes, unknown effort, conflicting copies and timing-only variants never mix percentiles", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(new URL("../../drizzle/0095_first_token.sql", import.meta.url), "utf8"));
  db.exec(fs.readFileSync(new URL("../../drizzle/0096_model_execution_timings.sql", import.meta.url), "utf8"));
  const resolver = buildAccountResolver([{ provider: "codex", subject: "codex/pc", from: "2026-01-01", until: null,
    value: "a", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
  const sample = (id: string, tier: string | null, effort: string | null, ms: number) =>
    ({ id, model: "same", service_tier: tier, effort, ts: "2026-10-25T10:00:00.000Z", ms, billing: "allowance", reason: null });
  try {
    const turns = [sample("a", "default", "high", 1000), sample("b", "priority", "high", 2000),
      sample("c", "priority", "ultra", 9000), sample("d", null, null, 3000), sample("e", "new-tier", "ultra", 7000)];
    replaceFirstTokenFile(db, "codex", "h", "p", "codex/pc", turns);
    replaceFirstTokenFile(db, "codex", "h", "duplicate", "codex/pc", turns);
    const read = () => readFirstTokenTimes(db, resolver, "codex", "a", { grain: "day" });
    const attached = attachFirstTokenTimes([], read());
    expect(attached.map(s => [s.speed, s.effort, firstTokenSummary(s.total.first_token).median_ms]).sort()).toEqual([
      ["standard", "high", 1000], ["fast", "high", 2000], ["fast", "ultra", 9000], ["standard", null, 3000], ["unknown:new-tier", "ultra", 7000],
    ].sort());
    expect(attached.every(s => s.total.first_token?.turns === 1)).toBe(true);
    replaceFirstTokenFile(db, "codex", "h", "conflict", "codex/pc", [sample("c", "default", "high", 9000)]);
    expect(attachFirstTokenTimes([], read()).find(s => s.speed === "mixed")?.total.first_token?.histogram).toEqual([[9000, 1]]);
    replaceFirstTokenFile(db, "codex", "h", "conflict", "codex/pc", []);
    expect(attachFirstTokenTimes([], read()).sort((a,b) => executionKey(a.model,a).localeCompare(executionKey(b.model,b))))
      .toEqual(attached.sort((a,b) => executionKey(a.model,a).localeCompare(executionKey(b.model,b))));
    expect(db.query("SELECT SUM(turns) n FROM response_time_hours").get()).toEqual({ n: 5 });
  } finally { db.close(); }
});
