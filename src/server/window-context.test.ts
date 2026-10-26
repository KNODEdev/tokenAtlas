import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { loadAccountResolver } from "./account-resolver";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { computeWindowUsageFull, readWindowSums, windowEventReader, windowSumsFromLedgers } from "./window-usage";
import { addEvent, card, COUNTER, database, opened, publishLedger, settle, storeWindows } from "./window-usage-codex.fixture";

afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const rates = (enabled = true) => {
  const config = structuredClone(resolveCodexAccountingConfig(card));
  config.long_context_premium = enabled;
  for (const rule of config.rules) if (rule.model === "gpt-6-astra" && rule.billing_basis === "api_equivalent_usd") {
    rule.rates = { in_uncached: 2, in_cache_read: 0.2, out_total: 10 };
    rule.long_context = { above_input_tokens: 272000, rates: { in_uncached: 4, in_cache_read: 0.4, out_total: 15 } };
  }
  return { ...card, codex_accounting: config };
};
function fixture(enabled = true) {
  const db = database();
  db.exec("DELETE FROM events");
  // Same file/time: the disabled-premium read must still split this cohort at the original threshold.
  addEvent(db, { ts: "2026-09-09T00:00:00.000Z", input: 272000 });
  addEvent(db, { ts: "2026-09-09T00:00:00.000Z", input: 272001 });
  addEvent(db, { ts: "2026-09-09T01:00:00.000Z", model: "codex-auto-review", input: 300000 });
  addEvent(db, { ts: "2026-09-09T02:00:00.000Z", input: 400000, billing: "credits" });
  addEvent(db, { ts: "2026-09-09T03:00:00.000Z", input: 400000, reset: Date.parse("2026-09-08") / 1000 });
  addEvent(db, { ts: "2026-09-14T01:00:00.000Z", input: 300000 });
  const pricing = rates(enabled); publishLedger(db, pricing); settle(db, pricing);
  const row = db.query("SELECT * FROM limit_windows WHERE seq=1").get() as LimitWindowRow;
  return { db, pricing, row, sums: readWindowSums(db, "codex", "codex1", COUNTER, [{ id: row.window_id }], ["cycle", "rail", "readings", "slices"]).get(row.window_id)! };
}
test("stores full-request context counts and a same-cohort API split, preserving exclusions and saturation", () => {
  const { sums } = fixture();
  const u = sums.cycle.usage;
  expect(u.events).toBe(3);
  expect(u.context_known_tokens).toBe(564001);
  expect(u.context_long_tokens).toBe(282001);
  expect(u.context_long_events).toBe(1);
  expect(u.context_priced_tokens).toBe(u.priced_tokens);
  expect(u.context_api_base).toBeCloseTo(1.216002, 9);
  expect(u.context_api_extra).toBeCloseTo(0.558002, 9);
  expect(u.context_api_base! + u.context_api_extra!).toBeCloseTo(u.api_normalized!, 9);
  expect(sums.cycle.cycle_usage.context_long_events).toBe(2);
  expect(sums.cycle.cycle_usage.context_long_tokens).toBe(592001);
  expect(sums.readings.at(-1)!.usage.context_long_tokens).toBe(282001);
});
test("disabled API uplift retains per-request classification and still measures the uplift it leaves out", () => {
  const { db, pricing, row, sums } = fixture(false);
  expect(sums.cycle.usage.context_long_events).toBe(1);
  // The value stays at normal rates; the uplift is the same amount the enabled premium adds, for a preview.
  expect(sums.cycle.usage.context_api_extra).toBeCloseTo(0.558002, 9);
  expect(sums.cycle.usage.context_api_base).toBeCloseTo(sums.cycle.usage.api_normalized!, 9);
  expect(sums.cycle.usage.context_api_base).toBeCloseTo(1.216002, 9);
  const reader = windowEventReader(db, pricing, loadAccountResolver(db));
  const ordinary = { ...reader, codexCohorts: undefined };
  const direct = windowSumsFromLedgers(ordinary, pricing, "codex", limitWindowFromRow(row), []).sums;
  expect(direct.cycle.usage).toEqual(sums.cycle.usage);
});
test("context components preserve the same Fast burden as the displayed API capacity", () => {
  const { db, pricing, row } = fixture();
  db.query("UPDATE events SET speed='fast' WHERE model='gpt-6-astra'").run();
  publishLedger(db, pricing); settle(db, pricing);
  const u = readWindowSums(db, "codex", "codex1", COUNTER, [{ id: row.window_id }], ["cycle"]).get(row.window_id)!.cycle.usage;
  expect(u.api_normalized).toBeCloseTo(1.774004 * 2.5, 9);
  expect(u.context_api_base).toBeCloseTo(1.216002 * 2.5, 9);
  expect(u.context_api_extra).toBeCloseTo(0.558002 * 2.5, 9);
  expect(u.context_long_tokens).toBe(282001);
});
test("API-only history before credit billing still has a context value split", () => {
  const db = database(), pricing = rates();
  db.exec("DELETE FROM events");
  addEvent(db, { ts: "2026-03-01T01:00:00.000Z", input: 280000 });
  publishLedger(db, pricing);
  const [window] = storeWindows(db, [["2026-03-01T00:00:00.000Z", 0, "2026-03-08T00:00:00.000Z"],
    ["2026-03-02T00:00:00.000Z", 100, "2026-03-08T00:00:00.000Z"]]);
  settle(db, pricing);
  const u = readWindowSums(db, "codex", "codex1", COUNTER, [window!], ["cycle"]).get(window!.id)!.cycle.usage;
  expect(u.context_api_base).toBeCloseTo(0.624, 9);
  expect(u.context_api_extra).toBeCloseTo(0.574, 9);
  expect(u.context_api_base! + u.context_api_extra!).toBeCloseTo(u.api_normalized!, 9);
});
test("late correction agrees with full reference and stored context survives a new read-only connection", () => {
  const { db, pricing, row } = fixture();
  db.query("UPDATE events SET in_tok=272000 WHERE model='gpt-6-astra' AND in_tok=272001").run();
  publishLedger(db, pricing); settle(db, pricing);
  const stored = readWindowSums(db, "codex", "codex1", COUNTER, [{ id: row.window_id }], ["cycle", "rail", "readings", "slices"]).get(row.window_id)!;
  expect(stored.cycle.usage.context_long_events).toBe(0);
  expect(stored.cycle.usage.context_api_extra).toBe(0);
  expect(stored.cycle.usage).toEqual(computeWindowUsageFull(db, { rateCards: pricing }).get(JSON.stringify(["codex", "codex1", COUNTER, row.window_id]))!.cycle.usage);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-context-"));
  const file = path.join(dir, "snapshot.sqlite");
  try {
    db.query("VACUUM INTO ?").run(file);
    const reopened = new Database(file, { readonly: true });
    try {
      expect(readWindowSums(reopened, "codex", "codex1", COUNTER, [{ id: row.window_id }], ["cycle"]).get(row.window_id)!.cycle.usage).toEqual(stored.cycle.usage);
    } finally { reopened.close(); }
  } finally { fs.rmSync(dir, { recursive: true }); }
});
