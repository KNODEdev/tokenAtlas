import fs from "node:fs";
import { createHash } from "node:crypto";

// Pure archive-file reads (no queue, database or writers), so parse workers can run them.
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function fileDigest(file: string): string {
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytes: number;
    while ((bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytes));
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}

export function fileStamp(file: string): string | null {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    // Hydration and pin/attribute changes update ctime without changing content.
    // Keep the same content identity as the file queue; hashes verify the bytes.
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export interface JsonlInspection {
  stamp: string;
  bytes: number;
  publishableBytes: number;
  publishableDigest: string;
  incompleteTail: boolean;
  prefixDigest?: string;
}

/** Parses complete records while retaining at most one record plus one fixed-size chunk. */
export function inspectJsonl(file: string, destination = false, verifiedPrefixBytes = 0): JsonlInspection {
  const before = fileStamp(file);
  if (!before) throw new Error(`Archive source disappeared: ${file}`);
  const hash = createHash("sha256");
  const prefixHash = verifiedPrefixBytes ? createHash("sha256") : null;
  const descriptor = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let publishableBytes = 0;
  try {
    let count: number;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      if(prefixHash&&bytes<verifiedPrefixBytes)prefixHash.update(chunk.subarray(0,Math.min(count,verifiedPrefixBytes-bytes)));
      bytes += count;
      pending = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, count)])
        : Buffer.from(chunk.subarray(0, count));
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const record = pending.subarray(0, newline + 1);
        const body = publishableBytes+record.length<=verifiedPrefixBytes ? "" : record.subarray(0, record.length - 1).toString("utf8").trim();
        if (body) {
          try { JSON.parse(body); }
          catch { throw new Error(`Invalid JSONL record in ${file} at byte ${publishableBytes}`); }
        }
        hash.update(record);
        publishableBytes += record.length;
        pending = pending.subarray(newline + 1);
      }
    }
  } finally { fs.closeSync(descriptor); }
  let incompleteTail = false;
  if (pending.length) {
    const body = pending.toString("utf8").trim();
    try {
      if (body) JSON.parse(body);
      hash.update(pending);
      publishableBytes += pending.length;
    } catch {
      incompleteTail = true;
    }
  }
  if (destination && incompleteTail) throw new Error(`Accepted archive contains an incomplete JSONL record: ${file}`);
  if (fileStamp(file) !== before) throw new Error(`Archive ${destination ? "destination" : "source"} changed while reading: ${file}`);
  return { stamp: before, bytes, publishableBytes, publishableDigest: hash.digest("hex"), incompleteTail,
    prefixDigest:prefixHash&&bytes>=verifiedPrefixBytes?prefixHash.digest("hex"):undefined };
}

export function validateArchivedJsonl(file: string): void {
  const before=fileStamp(file);
  if(!before)throw new Error(`Archive source disappeared: ${file}`);
  const descriptor=fs.openSync(file,"r"),chunk=Buffer.allocUnsafe(1<<20);
  let pending:Buffer[]=[],bytes=0,pendingBytes=0;
  try {
    for(;;){
      const count=fs.readSync(descriptor,chunk,0,chunk.length,null);if(!count)break;
      const data=chunk.subarray(0,count),last=data.lastIndexOf(10),start=bytes-pendingBytes;bytes+=count;
      if(last<0){pending.push(Buffer.from(data));pendingBytes+=count;continue;}
      // Validation needs no second SHA or per-record Buffer/hash operation: the queue owns identity.
      const complete=pending.length?Buffer.concat([...pending,data.subarray(0,last)]):data.subarray(0,last);
      const lines=complete.toString("utf8").split("\n");
      for(let index=0;index<lines.length;index++){
        const body=lines[index]!.trim();if(!body)continue;
        try{JSON.parse(body);}catch{const offset=start+Buffer.byteLength(lines.slice(0,index).join("\n"))+(index?1:0);throw new Error(`Invalid JSONL record in ${file} at byte ${offset}`);}
      }
      pending=last+1<count?[Buffer.from(data.subarray(last+1))]:[];pendingBytes=count-last-1;
    }
    if(pending.length){const body=Buffer.concat(pending).toString("utf8").trim();try{if(body)JSON.parse(body);}catch{throw new Error(`Accepted archive contains an incomplete JSONL record: ${file}`);}}
  } finally {fs.closeSync(descriptor);}
  if(fileStamp(file)!==before)throw new Error(`Archive destination changed while reading: ${file}`);
}
