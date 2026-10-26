import fs from "node:fs";
import { fileDigest } from "../sync/archive-publication";

function stamp(file:string):string {
  const stat=fs.lstatSync(file,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`Invalid archived SQLite file: ${file}`);
  return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
}
function requireStandalone(file:string):void {
  try {if(fs.statSync(file+'-wal').size>0)throw new Error(`Archive database has uncheckpointed WAL; consistent snapshot required: ${file}`);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** Fence native reads too: hydration precedes the stamp, and failures still verify the input. */
export async function verifySourceSqliteRead<T>(file: string, read: () => Promise<T>,
  digestFile: () => Promise<string> = async () => fileDigest(file)): Promise<T> {
  requireStandalone(file);
  const digest = await digestFile(), before = stamp(file);
  try { return await read(); }
  finally {
    requireStandalone(file);
    if (stamp(file) !== before || await digestFile() !== digest || stamp(file) !== before)
      throw new Error(`Archived SQLite changed during read: ${file}`);
  }
}
