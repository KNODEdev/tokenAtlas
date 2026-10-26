import fs from "node:fs";
import path from "node:path";
import { constants } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import { Database } from "../src/db/sqlite";
import { activeDatabasePath } from "../src/db";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { CODEX_SOURCE_LOCATOR_INDEX_SQL } from "../src/db/codex-source-evidence";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";

const [input] = process.argv.slice(2);
if (!input) throw new Error("Usage: bun scripts/price-ledger-locator-probe.ts <closed-candidate.sqlite>");
const frozen = frozenLedgerCopy(input), directory = createTemporaryWorkspace("price-ledger-locator", activeDatabasePath()).directory;
const file = path.join(directory, "candidate.sqlite");
fs.copyFileSync(frozen.copy, file); frozen.assertUnchanged();
let db = new Database(file);
try {
  db.exec("PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
  const biggest = db.query("SELECT home,path,COUNT(*) n FROM events GROUP BY home,path ORDER BY n DESC LIMIT 1").get() as {home:string;path:string;n:number};
  const selected = db.query("SELECT home,path,source_offset FROM events WHERE home=? AND path=? LIMIT 1000").all(biggest.home,biggest.path) as {home:string;path:string;source_offset:number}[];
  const probe = () => {
    const started = performance.now(); let matches = 0;
    for (const row of selected) {
      const answer = db.query("SELECT home,path,source_offset FROM events WHERE home IS ? AND path IS ? AND source_offset=?").all(row.home,row.path,row.source_offset);
      if (answer.length !== 1) throw new Error("Physical source lookup is ambiguous"); matches += answer.length;
    }
    return { lookups:selected.length,matches,elapsed_ms:performance.now()-started };
  };
  const before = probe(), changes = (db.query("SELECT total_changes() n").get() as {n:number}).n;
  const indexStart = performance.now(); db.exec(CODEX_SOURCE_LOCATOR_INDEX_SQL); const indexMs = performance.now() - indexStart;
  if ((db.query("SELECT total_changes() n").get() as {n:number}).n !== changes) throw new Error("Index installation changed source rows");
  const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM events WHERE home IS ? AND path IS ? AND source_offset=?").all(selected[0]!.home,selected[0]!.path,selected[0]!.source_offset) as {detail:string}[];
  if (!plan.some(row=>row.detail.includes("events_source_locator") && row.detail.includes("source_offset=?"))) throw new Error("Complete locator index was not chosen");
  const after = probe(); db.close(true);
  const guard = frozenLedgerCopy(file);
  db = new Database(pathToFileURL(guard.copy).href+"?mode=ro&immutable=1", constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_URI);
  const originalUri = pathToFileURL(frozen.copy).href+"?mode=ro&immutable=1";
  db.query("ATTACH DATABASE ? AS original").run(originalUri);
  const count = (sql:string) => (db.query(sql).get() as {n:number}).n;
  const common = count("SELECT COUNT(*) n FROM events o JOIN original.events n ON n.rowid=o.rowid");
  const original = count("SELECT COUNT(*) n FROM original.events");
  const columns = (db.query("PRAGMA table_info(events)").all() as {name:string}[]).map(row=>row.name);
  if (columns.some(column=>!/^[a-z_]+$/.test(column))) throw new Error("Unexpected source column");
  const equality = columns.map(column=>`(typeof(n.${column}) IS typeof(o.${column}) AND n.${column} IS o.${column})`).join(" AND ");
  const changed = count(`SELECT COUNT(*) n FROM events o JOIN original.events n ON n.rowid=o.rowid WHERE NOT (${equality})`);
  if (common !== original || count("SELECT COUNT(*) n FROM events") !== original || changed) throw new Error("Original typed source rows changed");
  guard.assertUnchanged(); frozen.assertUnchanged();
  const output={bun:Bun.version,original:frozen.copy,directory,events:original,typed_rows_changed:changed,largest_copy_events:biggest.n,
    before,index_ms:indexMs,after,plan,candidate_bytes:fs.statSync(file).size,
    limitations:["Index-only disposable-copy experiment; migration/restore gate is verified separately", "1,000 locator reads are not full HTTP latency"]};
  fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(output,null,2)); console.log(JSON.stringify(output));
} finally { db.close(true); frozen.assertUnchanged(); }
