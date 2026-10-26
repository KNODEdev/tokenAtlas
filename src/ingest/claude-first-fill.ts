import type { Database, SQLQueryBindings } from "../db/sqlite";
import type { NewClaudeEvent } from "../db/schema";
import { CLAUDE_CLOUD_ENTRYPOINT } from "./claude-cloud";

/** Ordered first-fill copies; no file has an earlier projection to replace. */
export class ClaudeFirstFill {
  private sequence = 0;
  private readonly columns: Array<{ name: string; dflt_value: string | null; notnull:number }>;
  private readonly statements = new Map<number, ReturnType<Database["query"]>>();
  constructor(private readonly sqlite: Database) {
    if (sqlite.query("SELECT 1 FROM claude_events LIMIT 1").get()) throw new Error("Claude first fill requires an empty stage");
    this.sequence=(sqlite.query("SELECT seq FROM sqlite_sequence WHERE name='claude_events'").get() as {seq:number}|null)?.seq??0;
    this.columns = (sqlite.query("PRAGMA table_info(claude_events)").all() as Array<{name:string;dflt_value:string|null;notnull:number}>).filter(c => c.name !== "id");
    sqlite.exec("CREATE TEMP TABLE claude_first_fill AS SELECT *, 0 AS sequence FROM claude_events WHERE 0");
  }
  checkpoint():number{return this.sequence;}
  restore(sequence:number):void{this.sequence=sequence;}
  append(events: readonly NewClaudeEvent[]): void {
    for (let offset = 0; offset < events.length; offset += 100) {
      const rows = events.slice(offset, offset + 100);
      let statement = this.statements.get(rows.length);
      if (!statement) {
        statement = this.sqlite.query(`INSERT INTO claude_first_fill (${this.columns.map(c => `"${c.name}"`).join(",")},sequence)
          VALUES ${rows.map(() => `(${Array(this.columns.length + 1).fill("?").join(",")})`).join(",")}`);
        this.statements.set(rows.length, statement);
      }
      const bindings: SQLQueryBindings[] = [];
      for (const event of rows) {
        for (const c of this.columns) {
          const value = event[c.name as keyof NewClaudeEvent];
          const stored=value === undefined ? c.dflt_value === "0" ? 0 : null : value as SQLQueryBindings;
          if(c.notnull && stored===null)throw new Error(`NULL Claude first-fill ${c.name}`);
          bindings.push(stored);
        }
        bindings.push(++this.sequence);
      }
      statement.run(...bindings);
    }
  }
  finish(): void {
    const tokens = new Set(["in_uncached", "in_cache_read", "in_cache_write", "cache_write_5m", "cache_write_1h", "out_total", "out_thinking", "path", "resp_ms"]);
    const conflict = "g.conflict=1 OR g.accounts>1";
    const select = this.columns.map(c => c.name === "subscription_conflict" ? `CASE WHEN ${conflict} THEN 1 ELSE f.subscription_conflict END`
      : c.name === "subscription_id" ? `CASE WHEN ${conflict} THEN NULL ELSE COALESCE(a.subscription_id, CASE WHEN g.account_sequence IS NULL THEN f.subscription_id END) END`
      : c.name === "account_key" ? "a.account_key"
      // A cloud reading wins whole, place included (claude-cloud.ts); otherwise the first copy keeps the place.
      : tokens.has(c.name) ? `w."${c.name}"` : `CASE WHEN w.entrypoint IS '${CLAUDE_CLOUD_ENTRYPOINT}' THEN w."${c.name}" ELSE f."${c.name}" END`).join(",");
    this.sqlite.exec(`WITH ranked AS (
        SELECT *,row_number() OVER (PARTITION BY store,call_id ORDER BY entrypoint IS '${CLAUDE_CLOUD_ENTRYPOINT}' DESC,out_total DESC,sequence) AS winner FROM claude_first_fill
      ), grouped AS (
        SELECT store,call_id,min(sequence) AS first_sequence,max(CASE WHEN account_key IS NOT NULL THEN sequence END) AS account_sequence,
          count(DISTINCT account_key) AS accounts,max(CASE WHEN coalesce(subscription_conflict,0)=1 THEN 1 ELSE 0 END) AS conflict
        FROM claude_first_fill GROUP BY store,call_id
      ) INSERT INTO claude_events (id,${this.columns.map(c => `"${c.name}"`).join(",")})
      SELECT g.first_sequence,${select} FROM grouped g JOIN claude_first_fill f ON f.sequence=g.first_sequence
        JOIN ranked w ON w.store=g.store AND w.call_id=g.call_id AND w.winner=1
        LEFT JOIN claude_first_fill a ON a.sequence=g.account_sequence ORDER BY g.first_sequence`);
    if(this.sqlite.query("SELECT 1 FROM sqlite_sequence WHERE name='claude_events'").get())
      this.sqlite.query("UPDATE sqlite_sequence SET seq=? WHERE name='claude_events'").run(this.sequence);
  }
  close(): void { this.sqlite.exec("DROP TABLE IF EXISTS temp.claude_first_fill"); }
}
