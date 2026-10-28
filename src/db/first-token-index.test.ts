import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { Database } from "./sqlite";
import { replaceFirstTokenFile } from "./first-token";

test("canonical turn lookup stays indexed by provider AND turn as historical copies grow", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(new URL("../../drizzle/0095_first_token.sql", import.meta.url), "utf8"));
  db.exec(fs.readFileSync(new URL("../../drizzle/0096_model_execution_timings.sql", import.meta.url), "utf8"));
  try {
    const insert = db.query("INSERT INTO response_time_copies(provider,owner,path,turn_id,source,model,ts,ms,billing,reason,mode_known) VALUES('codex','owner',?,?,'codex/pc','model','2026-10-25T10:00:00.000Z',1000,'allowance',NULL,1)");
    db.transaction(() => { for (let i = 0; i < 20000; i++) insert.run(`file-${i}`, `turn-${i}`); })();
    db.exec(`INSERT INTO response_time_turns SELECT provider,turn_id,source,model,ts,ms,billing,reason,service_tier,effort,mode_known FROM response_time_copies;
      INSERT INTO response_time_hours(provider,source,model,billing,hour,ms,turns,mode_known) SELECT provider,source,model,billing,CAST(strftime('%s',ts)/3600 AS INTEGER),ms,COUNT(*),1
      FROM response_time_copies GROUP BY provider,source,model,billing,ms`);
    const query = db.query.bind(db), plans: string[] = [];
    const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
      if (sql.includes("FROM response_time_copies INDEXED BY response_time_copies_turn")) {
        const rows = query("EXPLAIN QUERY PLAN " + sql).all("codex", "turn-12345") as { detail: string }[];
        plans.push(...rows.map(row => row.detail));
      }
      return query(sql);
    }) as typeof db.query);
    try {
      replaceFirstTokenFile(db, "codex", "duplicate", "copy", "codex/pc", [
        { id: "turn-12345", model: "model", ts: "2026-10-25T10:00:00.000Z", ms: 1000, billing: "allowance", reason: null },
      ]);
    } finally { spy.mockRestore(); }
    expect(plans.some(plan => plan.includes("provider=? AND turn_id=?"))).toBe(true);
    expect(plans.some(plan => plan.endsWith("(provider=?)"))).toBe(false);
    expect(db.query("SELECT COUNT(*) n FROM response_time_turns").get()).toEqual({ n: 20000 });
    expect(db.query("SELECT SUM(turns) n FROM response_time_hours").get()).toEqual({ n: 20000 });
    expect(db.query("SELECT COUNT(*) n FROM response_time_copies").get()).toEqual({ n: 20001 });
  } finally { db.close(); }
});
