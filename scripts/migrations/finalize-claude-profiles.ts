import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "../../src/db/sqlite";
import { acquireArchiveWriterFence } from "../../src/sync/archive-writers";
import { atomicWrite, assertDirectory } from "./archive-layout-migration";
import { ARCHIVE_LAYOUT_FILE, readArchiveLayout } from "./archive-layout";
import { readCanonicalArchiveRoot } from "../../src/config/archive-paths";
import { migrateClaudeProfileDatabase, type ProfileBinding } from "./claude-profile-database";
import { fileDigest } from "../../src/sync/archive-publication";

type Receipt={schema:1;kind:"claude-profile-conversion";archiveId:string;jobId:string;entries:ProfileBinding[]};
function outsideArchive(root:string, candidate:string) {
  let existing=path.resolve(candidate);
  while(!fs.existsSync(existing))existing=path.dirname(existing);
  const physical=path.join(fs.realpathSync(existing),path.relative(existing,path.resolve(candidate)));
  const relative=path.relative(root,physical);
  if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!==".."&&!path.isAbsolute(relative)))
    throw new Error("Database and migration working files must remain outside the archive");
}

/** Explicit offline conversion; the application never reads this migration receipt. */
export function finalizeClaudeProfiles(options:{archiveRoot:string;database:string;stateDirectory:string;checkpoint?:(phase:string)=>void}) {
  const root=fs.realpathSync(options.archiveRoot);
  outsideArchive(root,options.database); outsideArchive(root,options.stateDirectory);
  const identity=JSON.parse(fs.readFileSync(path.join(root,".archive-inventory/identity.json"),"utf8"));
  const receiptFile=path.join(options.stateDirectory,`${identity.archiveId}.canonical-profiles.json`);
  const layout=readArchiveLayout(root,true);
  let receipt:Receipt;
  if(layout) {
    if(layout.schema!==2||layout.phase!=="complete")throw new Error("Complete physical profile consolidation before converting the database");
    receipt={schema:1,kind:"claude-profile-conversion",archiveId:layout.archiveId,jobId:layout.jobId,entries:layout.entries};
  } else {
    receipt=JSON.parse(fs.readFileSync(receiptFile,"utf8"));
    if(receipt.schema!==1||receipt.kind!=="claude-profile-conversion")throw new Error("Invalid profile conversion receipt");
  }
  if(identity.archiveId!==receipt.archiveId)throw new Error("Migration receipt belongs to a different archive");
  if(!Array.isArray(receipt.entries)||receipt.entries.length!==2
    ||receipt.entries.some(e=>!e||!((e.logical==="projects"&&e.store==="hub")||(e.logical==="projectAsus"&&e.store==="asus"))
      ||!/^claude\/[^/\\:.]+$/.test(e.physical)||e.physical.includes("legacy-"))
    ||new Set(receipt.entries.map(e=>e.logical)).size!==2
    ||new Set(receipt.entries.map(e=>e.physical.toLowerCase())).size!==2)throw new Error("Invalid profile conversion bindings");
  const fence=acquireArchiveWriterFence(root,receipt.jobId); fence.assertDrained();
  const db=new Database(options.database,{readwrite:true,create:false});
  let complete=false;
  try {
    if(db.query("SELECT 1 FROM sqlite_master WHERE name='sync_runs'").get()&&db.query("SELECT 1 FROM sync_runs WHERE status='running'").get())throw new Error("Synchronization must be stopped");
    if(!fs.existsSync(options.stateDirectory))fs.mkdirSync(options.stateDirectory,{recursive:true});
    const backup=path.join(options.stateDirectory,"before-canonical-profiles.sqlite");
    if(!fs.existsSync(backup)) {
      const temporary=`${backup}.${randomUUID()}.tmp`;
      try {
        db.exec(`VACUUM INTO '${temporary.replaceAll("'","''")}'`);
        const check=new Database(temporary,{readonly:true});
        try { if(JSON.stringify(check.query("PRAGMA quick_check").values())!==JSON.stringify([["ok"]]))throw new Error("Migration backup integrity failure"); }
        finally { check.close(); }
        fs.renameSync(temporary,backup);
      } finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
    }
    if(layout) {
      atomicWrite(path.join(options.stateDirectory,"source-layout-before-finalization.json"),layout);
      const evidence=JSON.parse(fs.readFileSync(path.join(options.stateDirectory,`${receipt.archiveId}.profiles.json`),"utf8"));
      for(const move of evidence.moves as {logical:string;destination:string;digest:string;bytes:number;retained:boolean}[]) {
        if(!move.retained)continue;
        const entry=receipt.entries.find(e=>move.logical.startsWith(e.logical+"/"));
        if(!entry||move.destination!==`.source-versions/blobs/${move.digest}`||!/^[a-f0-9]{64}$/.test(move.digest))throw new Error("Invalid retained attachment provenance");
        const relative=entry.physical+move.logical.slice(entry.logical.length);
        const current=path.join(root,...relative.split("/"));
        const blob=path.join(root,...move.destination.split("/"));
        const info=fs.lstatSync(blob);
        if(!info.isFile()||info.isSymbolicLink()||info.size!==move.bytes||fileDigest(blob)!==move.digest)
          throw new Error(`Retained attachment is not verified: ${move.logical}`);
        if(fs.existsSync(current)&&fileDigest(current)===move.digest)continue;
        const extension=path.extname(current);
        const recovered=current.slice(0,current.length-extension.length)+`.conflict-${move.digest}`+extension;
        assertDirectory(root,path.relative(root,path.dirname(recovered)).split(path.sep).join("/"));
        if(!fs.existsSync(recovered)) {
          const temporary=`${recovered}.tmp-${randomUUID()}`;
          try {
            fs.copyFileSync(blob,temporary,fs.constants.COPYFILE_EXCL);
            if(fileDigest(temporary)!==move.digest)throw new Error("Attachment recovery verification failed");
            const fd=fs.openSync(temporary,"r+");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
            fs.renameSync(temporary,recovered);
          } finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
        }
        if(fileDigest(recovered)!==move.digest)throw new Error("Recovered attachment content changed");
      }
    }
    atomicWrite(receiptFile,receipt); options.checkpoint?.("metadata");
    const logicalRoot=readCanonicalArchiveRoot(root)?.originalLogicalRoot??root;
    const result=migrateClaudeProfileDatabase(db,logicalRoot,receipt.entries,`claude-profiles:${receipt.archiveId}`);
    options.checkpoint?.("database");
    if(fs.existsSync(path.join(root,ARCHIVE_LAYOUT_FILE)))fs.unlinkSync(path.join(root,ARCHIVE_LAYOUT_FILE));
    options.checkpoint?.("complete"); complete=true;
    return {phase:"complete",backup,...result};
  } finally { db.close(); if(complete)fence.release(); }
}
