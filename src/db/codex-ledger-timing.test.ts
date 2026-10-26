import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { enqueueCodexLedgerRuleChanges, markCodexLedgerCopiesDirty, processCodexLedgerBatch, type LedgerProducerOptions } from "./codex-ledger-producer";
import type { LedgerCopyAnchor } from "./codex-ledger-copies";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { TIMED_SUMS } from "./usage-ledger";

/**
 * Codex response times in the per-call ledger (docs/verification/model-speed-2026-10-06.md): a call's time is stored
 * beside its facts but never compared with them, so a change of the time alone moves only the timed sums of its day,
 * never the values, the resolution or the window sums.
 */
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const home = "archive", file = "archive/sessions/a.jsonl";
const anchorOf = (_home: string | null, path: string): LedgerCopyAnchor =>
  ({ archiveId: "archive-id", sourceId: "codex/pc/profile", relativePath: path.replace(/^archive\//, "codex/") });
const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
  base_rules: [{ id: "api", model: "m", billing_basis: "api_equivalent_usd", valid_from: "2026-01-01", multiplier: "1",
    rates: { in_uncached: "1.875", in_cache_read: "0.125", out_total: "1.75" }, ...provenance }],
  tier_rules: [{ id: "api-standard", model: "m", billing_basis: "api_equivalent_usd", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance }] };
const options = (): LedgerProducerOptions => ({ bands: compileCodexLedgerPolicy(policy).baseBands, policy, factsRevision: 0,
  rulesRevision: sha(JSON.stringify(policy)), anchorOf, batchSize: 2 });
interface Call { response: string; ts?: string; output?: number; ms: number | null }

function ledger() {
  const db = new Database(":memory:");
  createCodexLedgerSchema(db);
  // Window answers, so a test can see whether a write marked any window stale.
  db.exec(fs.readFileSync(new URL("../../drizzle/0063_window_answers.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,cache_write ANY,out_tok ANY,
    reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,billing_mode TEXT,response_id TEXT,resp_ms INTEGER,
    UNIQUE(home,path,source_offset)) STRICT`);
  const write = (calls: Call[], notify: boolean) => db.transaction(() => {
    db.query("DELETE FROM events WHERE home=? AND path=?").run(home, file);
    calls.forEach((call, index) => db.query(`INSERT INTO events VALUES(?,?,?,'m',?,10,2,0,?,0,'valid','missing','default','standard','allowance',?,?)`)
      .run(home, file, index * 100, call.ts ?? "2026-04-01T12:00:00Z", call.output ?? 300, call.response, call.ms));
    if (notify) markCodexLedgerCopiesDirty(db, [{ home, path: file }]);
  }).immediate();
  const drain = () => {
    for (let step = 0; step < 200; step++) {
      const result = processCodexLedgerBatch(db, options());
      if (result.ready || !result.progressed) return result;
    }
    throw new Error("Producer did not finish");
  };
  return {
    db, drain,
    fill(calls: Call[]) { write(calls, false); enqueueCodexLedgerRuleChanges(db, options()); return drain(); },
    publish(calls: Call[]) { write(calls, true); return drain(); },
    /** The calls with their values and resolution, without their times. */
    calls: () => db.query(`SELECT id,source_offset,day,dim_id,identity,copy_state,CAST(api_whole AS TEXT) w,CAST(api_fraction_hi AS TEXT) h,
      CAST(api_fraction_lo AS TEXT) l FROM codex_price_ledger_events ORDER BY id`).all(),
    times: () => db.query("SELECT source_offset,resp_ms FROM codex_price_ledger_events ORDER BY source_offset").all(),
    marks: () => (db.query("SELECT COUNT(*) n FROM window_answer_marks").get() as { n: number }).n,
    /** Every aggregate column keyed by the dimension's key, untimed and timed apart. */
    sums: () => {
      const rows = db.query(`SELECT a.*,d.key dim FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
        ORDER BY a.grain,a.day,a.hour,d.key,a.copy_state,a.api_reason`).all() as Record<string, unknown>[];
      const pick = (timed: boolean) => rows.map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => key !== "dim_id" && (TIMED_SUMS as readonly string[]).includes(key) === timed || key === "grain" || key === "day")));
      return { untimed: pick(false), timed: pick(true) };
    },
  };
}
/** The same calls filled into an empty ledger: the full reference. */
function reference(calls: Call[]) {
  const f = ledger();
  try { expect(f.fill(calls).ready).toBe(true); return f.sums(); } finally { f.db.close(); }
}

test("Codex timed sums: ratio of sums, long calls apart, invalid counters and unknown times untimed", () => {
  const f = ledger();
  try {
    expect(f.fill([{ response: "a", ms: 2000 }, { response: "b", output: 3, ms: 1000 }, { response: "c", ms: null }]).ready).toBe(true);
    const day = f.db.query(`SELECT calls,${TIMED_SUMS.join(",")} FROM codex_price_ledger_aggregates WHERE grain='day'`).get();
    expect(day).toEqual({ calls: 3, timed_calls: 2, timed_out: 303, timed_ms: 3000, timed_long_calls: 1, timed_long_out: 300, timed_long_ms: 2000 });
    const hours = f.db.query(`SELECT SUM(timed_calls) c,SUM(timed_ms) ms FROM codex_price_ledger_aggregates WHERE grain='hour'`).get();
    expect(hours).toEqual({ c: 2, ms: 3000 });
  } finally { f.db.close(); }
});

test("a time-only change moves only times and timed sums; a retry changes nothing; corrections equal a full rebuild", () => {
  const f = ledger();
  try {
    const first: Call[] = [{ response: "a", ms: 2000 }, { response: "b", ts: "2026-04-02T08:00:00Z", output: 3, ms: 1000 }];
    f.fill(first);
    const calls = f.calls(), sums = f.sums(), marks = f.marks();
    // New times only (a file read again by the new parser): values, resolution, untimed sums and window marks stay.
    const timed: Call[] = [{ response: "a", ms: 4000 }, { response: "b", ts: "2026-04-02T08:00:00Z", output: 3, ms: null }];
    expect(f.publish(timed).ready).toBe(true);
    expect(f.calls()).toEqual(calls);
    expect(f.times()).toEqual([{ source_offset: 0, resp_ms: 4000 }, { source_offset: 100, resp_ms: null }]);
    expect(f.sums().untimed).toEqual(sums.untimed);
    expect(f.sums().timed).not.toEqual(sums.timed);
    expect(f.marks()).toBe(marks);
    expect(f.sums()).toEqual(reference(timed));
    // The identical file again: nothing changes.
    const settled = f.sums();
    expect(f.publish(timed).ready).toBe(true);
    expect(f.sums()).toEqual(settled); expect(f.marks()).toBe(marks); expect(f.calls()).toEqual(calls);
    // A corrected call (tokens and time) and a retracted one: their days are rebuilt, equal to a full rebuild.
    const corrected: Call[] = [{ response: "a", output: 500, ms: 2500 }];
    expect(f.publish(corrected).ready).toBe(true);
    expect(f.marks()).toBeGreaterThan(marks);
    expect(f.sums()).toEqual(reference(corrected));
  } finally { f.db.close(); }
});
