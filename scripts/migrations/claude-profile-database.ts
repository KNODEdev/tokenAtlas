import path from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type ProfileBinding = { logical: string; physical: string; store: string };
const quoted = (name:string) => `"${name.replaceAll('"','""')}"`;
const exists = (db:Database,name:string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** One-time data conversion. Ordinary ingestion has no aliases for these old locations. */
export function migrateClaudeProfileDatabase(db:Database, root:string, bindings:ProfileBinding[], migrationId:string) {
  const prefixes = bindings.map(b=>({from:path.join(root,b.logical),to:path.join(root,b.physical),store:b.store}));
  const pathPrefixes=prefixes.flatMap(p=>["\\","/"].map(slash=>({from:p.from.replace(/[\\/]/g,slash),to:p.to.replace(/[\\/]/g,slash),slash})));
  const convertPath = (value:string) => {
    for(const {from,to,slash} of pathPrefixes) {
      if(value===from||value.startsWith(from+slash))return to+value.slice(from.length);
    }
    return value;
  };
  const tables=["claude_events","claude_files"].filter(t=>exists(db,t));
  const transformedRow=(table:string,row:Record<string,unknown>)=>{
    const next={...row};
    if(typeof next.path==="string")next.path=convertPath(next.path);
    if(prefixes.some(p=>p.store===row.store))next.store="live";
    return next;
  };
  const fingerprint=(table:string,transform:boolean)=>{
    const hash=createHash("sha256");
    // Stable rowids are retained; the change is only a source location/store rekey.
    for(const row of db.query(`SELECT * FROM ${quoted(table)} ORDER BY rowid`).iterate() as Iterable<Record<string,unknown>>)
      hash.update(JSON.stringify(transform?transformedRow(table,row):row)+"\n");
    return hash.digest("hex");
  };
  return db.transaction(()=>{
    db.exec("CREATE TABLE IF NOT EXISTS archive_data_migrations(id TEXT PRIMARY KEY,completed_at TEXT NOT NULL)");
    if(db.query("SELECT 1 FROM archive_data_migrations WHERE id=?").get(migrationId))return {alreadyComplete:true};
    if(exists(db,"sync_runs")&&db.query("SELECT 1 FROM sync_runs WHERE status='running'").get())throw new Error("Stop synchronization before migrating source identities");
    const before=new Map(tables.map(t=>[t,fingerprint(t,true)]));
    const triggers=db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;sql:string}[];
    // Metadata-only rekey must not enqueue repricing or invalidate completed work.
    for(const trigger of triggers)db.exec(`DROP TRIGGER ${quoted(trigger.name)}`);
    for(const table of tables) {
      const col="path";
      for(const p of pathPrefixes) {
        db.query(`UPDATE ${quoted(table)} SET ${quoted(col)}=?||substr(${quoted(col)},?) WHERE ${quoted(col)}=? OR substr(${quoted(col)},1,?)=?`)
          .run(p.to,p.from.length+1,p.from,p.from.length+1,p.from+p.slash);
      }
      for(const p of prefixes)db.query(`UPDATE ${quoted(table)} SET store='live' WHERE store=?`).run(p.store);
    }
    for(const table of tables)if(fingerprint(table,false)!==before.get(table))throw new Error(`Calculated values changed during source migration: ${table}`);
    for(const trigger of triggers)db.exec(trigger.sql);
    db.query("INSERT INTO archive_data_migrations VALUES(?,?)").run(migrationId,new Date().toISOString());
    return {alreadyComplete:false,tables:tables.length};
  }).immediate();
}
