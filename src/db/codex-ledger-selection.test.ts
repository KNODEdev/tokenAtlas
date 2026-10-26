import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, valueCodexLedgerBand, type LedgerBaseBand } from "./codex-price-ledger";

test("incremental valuation starts from selected event IDs and leaves the rest of a large model untouched", () => {
  const db = new Database(":memory:");
  try {
    createCodexLedgerSchema(db);
    db.exec(`INSERT INTO codex_price_ledger_dims(id,key,model) VALUES(1,'fixture','model');
      WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<3000)
      INSERT INTO codex_price_ledger_events(id,copy_id,source_offset,dim_id,ts,day,admitted,in_tok,cached_in,cache_write,out_tok,
        reported,uncached,cached,writes,output,reasoning,window_input,window_cached,window_output,invalid_tokens)
      SELECT n,1,n,1,'2026-04-02T12:00:00Z','2026-04-02',1,10,0,0,1,11,10,0,0,1,0,10,0,1,0 FROM seq`);
    const band: LedgerBaseBand = { id: "fixture", model: "model", basis: "api_equivalent_usd", validFrom: "2026-01-01",
      band: "normal", rates: { in_uncached: "2", in_cache_read: "0", out_total: "4" }, multiplier: "1", evidence: "fixture" };
    const query = db.query.bind(db);
    let valuationSql = "";
    db.query = ((sql: string) => { if (sql.startsWith("WITH input AS")) valuationSql = sql; return query(sql); }) as typeof db.query;
    db.transaction(() => expect(valueCodexLedgerBand(db, band, [2999, 3000])).toBe(2)).immediate();
    const input = valuationSql.slice("WITH input AS (".length, valuationSql.indexOf(")\n    INSERT INTO temp.codex_ledger_valued"));
    const plan = query(`EXPLAIN QUERY PLAN ${input}`).all("model", "2026-01-01", JSON.stringify([2999, 3000])) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("SEARCH e USING INTEGER PRIMARY KEY"))).toBe(true);
    expect(plan.some(row => row.detail.startsWith("SCAN e"))).toBe(false);
    expect(query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE api_whole IS NOT NULL").get()).toEqual({ n: 2 });
    expect(query("SELECT api_whole FROM codex_price_ledger_events WHERE id=2999").get()).toEqual({ api_whole: 24_000 });
    expect(query("SELECT api_whole FROM codex_price_ledger_events WHERE id=1").get()).toEqual({ api_whole: null });
  } finally { db.close(); }
});
