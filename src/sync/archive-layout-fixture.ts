import fs from "node:fs";
import path from "node:path";
import { expect } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { archive, archiveProfiles, toArchiveLogicalPath, toArchivePhysicalPath } from "../config/paths";
import { consolidateArchiveLayout } from "../../scripts/migrations/archive-layout-migration";
import { consolidateArchiveProfiles } from "../../scripts/migrations/archive-profile-consolidation";
import { finalizeClaudeProfiles } from "../../scripts/migrations/finalize-claude-profiles";
import { readArchiveLayout } from "../../scripts/migrations/archive-layout";
import { initializeArchiveWriterIdentity, withArchiveWriter } from "./archive-writers";
import { publishArchiveFile } from "./archive-publication";

const root = process.env.TOKENATLAS_ARCHIVE!;
const database = process.env.TOKENATLAS_DB!;
const state = process.env.LAYOUT_STATE ?? path.join(path.dirname(database), "layout-state");
const mode = process.argv[2];
initializeArchiveWriterIdentity();
if(mode==="finalize") {
  finalizeClaudeProfiles({archiveRoot:root,database,stateDirectory:state,
    checkpoint:phase=>{if(phase===process.env.FINALIZE_CRASH)process.exit(77);}});
  console.log("PASS");process.exit(0);
}
if (mode === "merge") {
  consolidateArchiveProfiles({ archiveRoot: root, database, stateDirectory: state,
    targets: {hub:process.env.PROFILE_TARGET_HUB ?? "claude/PC-main",asus:"claude/PC-asus"},
    checkpoint: phase => { if (phase === process.env.PROFILE_CRASH) process.exit(77); } });
  console.log("PASS"); process.exit(0);
}
if (mode === "move") {
  if (process.env.LAYOUT_EXISTING_PARENT) {
    const original = fs.mkdirSync;
    fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      if (String(args[0]) === path.join(root, "claude") && fs.existsSync(args[0]))
        throw Object.assign(new Error("Existing cloud directory"), { code: "EEXIST" });
      return Reflect.apply(original, fs, args);
    }) as typeof fs.mkdirSync;
  }
  if (process.env.LAYOUT_METADATA_CHANGE) {
    const original = fs.statSync;
    let changed = 0;
    fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
      const stat = Reflect.apply(original, fs, args);
      if (stat && String(args[0]).endsWith("session.jsonl") && (process.env.LAYOUT_METADATA_CHANGE === "continuous" || changed === 0))
        Object.assign(stat, { ctimeMs: Number(stat.ctimeMs) + ++changed });
      return stat;
    }) as typeof fs.statSync;
  }
  const crash = process.env.LAYOUT_CRASH;
  consolidateArchiveLayout({ archiveRoot: root, database, stateDirectory: state,
    checkpoint: phase => {
      if (phase === "fenced" && process.env.LAYOUT_READY) {
        fs.writeFileSync(process.env.LAYOUT_READY, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      }
      if (phase === crash) process.exit(77);
    },
    afterMove: folder => { if (folder === crash) process.exit(77); } });
  console.log("PASS");
  process.exit(0);
}
const { ingestClaude, getStoreRoots } = await import("../ingest/claude");
const { prepareReparse } = await import("./reparse");
const { applyDrizzleMigrations } = await import("../db/migrate");
const tables = ["claude_events", "claude_files", "meta"];
function rows() {
  const db = new Database(database, { readonly: true });
  try { return Object.fromEntries(tables.map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
if (mode === "seed") {
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(root, "claude"), { recursive: true });
  const db = new Database(database);
  applyDrizzleMigrations(drizzle(db));
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('completed','keep');");
  db.close();
  for (const folder of ["projects", "projectAsus"]) {
    fs.mkdirSync(path.join(root,folder),{recursive:true});
    const source = path.join(path.dirname(database), `${folder}.jsonl`);
    fs.writeFileSync(source, JSON.stringify({ type: "assistant", timestamp: "2026-09-01T12:00:00Z", sessionId: folder,
      requestId: folder, message: { id: folder, model: "claude-sonnet-4", usage: { input_tokens: 5, output_tokens: 3 } } }) + "\n");
    fs.copyFileSync(source, path.join(root, folder, "session.jsonl"));
    fs.writeFileSync(path.join(root, folder, "saved-original.txt"), "preserved original attachment");
  }
  if (process.env.LAYOUT_PROFILES) {
    for (const profile of ["PC-main", "PC-asus"]) {
      fs.mkdirSync(path.join(root,"claude",profile),{recursive:true});
      fs.writeFileSync(path.join(root,"claude",profile,"saved-original.txt"),process.env.LAYOUT_IDENTICAL_ATTACHMENT ? "preserved original attachment" : "current attachment");
    }
    fs.writeFileSync(path.join(root,"claude/PC-main/current.jsonl"),JSON.stringify({type:"assistant",timestamp:"2026-09-02T12:00:00Z",sessionId:"current",
      requestId:"current",message:{id:"current",model:"claude-sonnet-4",usage:{input_tokens:7,output_tokens:4}}})+"\n");
  }
  const result = await ingestClaude({ dbPath: database, skipMigrations: true,
    exclusiveInputs:[{store:"hub",path:path.join(root,"projects")},{store:"asus",path:path.join(root,"projectAsus")},
      ...(process.env.LAYOUT_PROFILES?[{store:"live",path:path.join(root,"claude/PC-main")}]:[])] });
  expect(result.processed).toBe(process.env.LAYOUT_PROFILES ? 3 : 2);
  fs.writeFileSync(path.join(state, "before-db.json"), JSON.stringify(rows()));
} else if(mode==="verify-move") {
  expect(rows()).toEqual(JSON.parse(fs.readFileSync(path.join(state,"before-db.json"),"utf8")));
  for(const name of ["projects","projectAsus"]) {
    expect(fs.existsSync(path.join(root,name))).toBe(false);
    expect(fs.readFileSync(path.join(root,"claude",`legacy-${name}`,"session.jsonl"),"utf8"))
      .toBe(fs.readFileSync(path.join(path.dirname(database),`${name}.jsonl`),"utf8"));
  }
} else if (mode === "verify") {
  const before = JSON.parse(fs.readFileSync(path.join(state, "before-db.json"), "utf8"));
  for(const table of ["claude_events","claude_files"])for(const row of before[table]) {
    for(const [old,target] of [["projects","PC-main"],["projectAsus","PC-asus"]]) {
      const prefix=path.join(root,old!)+path.sep;
      if(row.path?.startsWith(prefix)) {row.path=path.join(root,"claude",target!,row.path.slice(prefix.length));row.store="live";}
    }
  }
  expect(rows()).toEqual(before);
  const merged = !readArchiveLayout(root);
  expect(archiveProfiles("claude")).toEqual(process.env.LAYOUT_PROFILES ? ["PC-asus","PC-main"] : []);
  if (!merged) expect(getStoreRoots("live")).not.toContain(archive("projects"));
  if (merged) {
    expect(fs.existsSync(path.join(root,"claude/legacy-projects"))).toBe(false);
    expect(fs.existsSync(path.join(root,"claude/legacy-projectAsus"))).toBe(false);
    expect(fs.readFileSync(path.join(root,"claude/PC-main/saved-original.txt"),"utf8")).toBe(process.env.LAYOUT_IDENTICAL_ATTACHMENT ? "preserved original attachment" : "current attachment");
  }
  for (const folder of ["projects", "projectAsus"]) {
    expect(fs.existsSync(path.join(root, folder))).toBe(false);
    const logical = path.join(root,"claude",folder==="projects"?"PC-main":"PC-asus","session.jsonl");
    const physical = logical;
    expect(toArchivePhysicalPath(logical)).toBe(physical);
    expect(toArchiveLogicalPath(physical)).toBe(logical);
    const attachmentDigest=(await import("node:crypto")).createHash("sha256").update("preserved original attachment").digest("hex");
    const attachment=process.env.LAYOUT_IDENTICAL_ATTACHMENT?"saved-original.txt":`saved-original.conflict-${attachmentDigest}.txt`;
    expect(fs.readFileSync(path.join(root,"claude",folder==="projects"?"PC-main":"PC-asus",attachment),"utf8")).toBe("preserved original attachment");
  }
  const result = await ingestClaude({ dbPath: database, skipMigrations: true });
  expect(result.processed).toBe(0); expect(result.skipped).toBe(process.env.LAYOUT_PROFILES ? 3 : 2); expect(result.writtenRows).toBe(0);
  expect(rows()).toEqual(before);
  const active = new Database(database);
  const stagePath = path.join(path.dirname(database), "reparse.sqlite");
  active.exec(`VACUUM INTO '${stagePath.replaceAll("'", "''")}'`);
  const stage = new Database(stagePath);
  try {
    const reparse = prepareReparse(active, stage, { identity: ["store", "path"], bookmarkTable: "claude_files" }, [], {});
    expect(reparse.unavailable).toEqual([]); expect(reparse.sources).toHaveLength(process.env.LAYOUT_PROFILES ? 3 : 2);
  } finally { stage.close(); active.close(); }
  // A rebuild reads the consolidated archive in place into an empty index.
  const transcripts = fs.readdirSync(path.join(root, "claude"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
  expect(transcripts).toHaveLength(3);
  const restored = path.join(path.dirname(database), "restored.sqlite");
  const restoredDb = new Database(restored); applyDrizzleMigrations(drizzle(restoredDb)); restoredDb.close();
  await ingestClaude({ dbPath: restored, skipMigrations: true,
    exclusiveInputs: archiveProfiles("claude").map(profile => ({ store: "live", path: archive("claude", profile) })) });
  const reference = new Database(restored, { readonly: true }), old = new Database(database, { readonly: true });
  try { expect(reference.query("SELECT store,path,call_id,in_uncached,out_total FROM claude_events ORDER BY call_id").all())
    .toEqual(old.query("SELECT store,path,call_id,in_uncached,out_total FROM claude_events ORDER BY call_id").all()); }
  finally { reference.close(); old.close(); }
  withArchiveWriter(root, () => {});
} else if (mode === "correct") {
  const logical = path.join(root, "claude/PC-main/session.jsonl"), physical = toArchivePhysicalPath(logical);
  const source = path.join(path.dirname(database), "projects.jsonl");
  const corrected = JSON.parse(fs.readFileSync(source, "utf8")); corrected.message.usage.input_tokens = 17;
  fs.writeFileSync(source, JSON.stringify(corrected) + "\n");
  // An explicit correction to the accepted archived source is reparsed at the canonical identity.
  fs.copyFileSync(source, physical);
  const result = await ingestClaude({ dbPath: database, skipMigrations: true });
  expect(result.processed).toBe(1); expect(result.skipped).toBe(process.env.LAYOUT_PROFILES ? 2 : 1);
  const db = new Database(database, { readonly: true });
  try { expect(db.query("SELECT store,path,in_uncached FROM claude_events WHERE path=?").get(logical)).toEqual({ store: "live", path: logical, in_uncached: 17 }); }
  finally { db.close(); }
} else if (mode === "arrival") {
  const destination = archive("claude","PC-main","arrival.jsonl");
  const source = path.join(path.dirname(database),"arrival.jsonl");
  fs.writeFileSync(source,JSON.stringify({type:"assistant",timestamp:"2026-09-03T12:00:00Z",sessionId:"arrival",requestId:"arrival",
    message:{id:"arrival",model:"claude-sonnet-4",usage:{input_tokens:9,output_tokens:2}}})+"\n");
  publishArchiveFile(source,destination,{archiveRoot:root,jsonl:true});
  const result=await ingestClaude({dbPath:database,skipMigrations:true});
  expect(result.processed).toBe(1); expect(result.skipped).toBe(3);
  const db=new Database(database,{readonly:true});
  try { expect(db.query("SELECT store,path,in_uncached FROM claude_events WHERE call_id LIKE 'arrival%'").get())
    .toEqual({store:"live",path:destination,in_uncached:9}); }
  finally { db.close(); }
}
console.log("PASS");
