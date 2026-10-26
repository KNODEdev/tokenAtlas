import fs from "node:fs";
import { createHash } from "node:crypto";

// Pure file identity for the sync queue: reads files only, so parse workers can compute it.
export const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==="ENOENT";
export const stamp=(stat:fs.Stats)=>JSON.stringify([stat.size,stat.mtimeMs,stat.ctimeMs,stat.dev,stat.ino]);
/**
 * Content identity of a queued input: which file it is, how many bytes it holds
 * and when they were written. The change time is deliberately left out. A cloud
 * client updating attributes, pin state or hydration rewrites `ctime` across an
 * archive nobody wrote, and reading that as a content change fails verification
 * of untouched files and re-hashes the whole tree. The vendor bookmarks compare
 * size and mtime, so the queue must not be stricter than the parser position it
 * protects; a content change that keeps both is still caught by the hash below.
 */
export const contentStamp=(value:string)=>{
  if(value==="missing")return value;
  const [size,mtime,,device,inode]=JSON.parse(value) as unknown[];
  return JSON.stringify([size,mtime,device,inode]);
};
export function metadata(file:string):string {
  try {
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||!stat.isFile())throw new Error(`Queued input is not an ordinary file: ${file}`);
    return stamp(stat);
  } catch(error) {if(missing(error))return "missing";throw error;}
}
export function fingerprint(file:string):string {
  const before=metadata(file);
  if(before==="missing")return before;
  const hash=createHash("sha256"),chunk=Buffer.allocUnsafe(1024*1024),fd=fs.openSync(file,"r");
  try {
    const identity=contentStamp(before);
    if(contentStamp(stamp(fs.fstatSync(fd)))!==identity)throw new Error(`Queued input changed before verification: ${file}`);
    let size:number;while((size=fs.readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,size));
    if(contentStamp(stamp(fs.fstatSync(fd)))!==identity)throw new Error(`Queued input changed during verification: ${file}`);
  }
  finally {fs.closeSync(fd);}
  if(contentStamp(metadata(file))!==contentStamp(before))throw new Error(`Queued input changed during verification: ${file}`);
  return JSON.stringify([before,hash.digest("hex")]);
}
