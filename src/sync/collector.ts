import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ARCHIVE_ROOT, MACHINE, LOGIN } from "../config/paths";
import { VENDOR_IDS, type VendorId } from "./contracts";
import { mirrorVendorSources, type MirrorResult } from "./mirror";
import { ensureArchiveIdentity } from "./archive-inventory";
import { atomicArchiveWrite } from "./archive-publication";
import { initializeArchiveWriterIdentity } from "./archive-writers";

export interface CollectionReport {
  schema:1; id:string; archiveId:string; machine:string; login:string;
  startedAt:string; finishedAt:string; status:"success"|"failure";
  vendors:Array<MirrorResult & {vendor:VendorId}>;
  durability:"local-verified-publication";
  remoteDelivery:"unconfirmed";
}
/** Local and remote entry points share the same version-preserving collectors. */
export async function collectArchiveSources(rootDir:string,options:{archiveRoot?:string;mirror?:typeof mirrorVendorSources}={}):Promise<CollectionReport> {
  const archiveRoot=options.archiveRoot??ARCHIVE_ROOT;
  if(!fs.existsSync(archiveRoot))throw new Error("Archive unavailable. Create or connect the intended archive in setup before collecting.");
  const archiveId=ensureArchiveIdentity(archiveRoot),startedAt=new Date().toISOString();
  const vendors:CollectionReport["vendors"]=[];
  for(const vendor of VENDOR_IDS) {
    try {vendors.push({vendor,...await (options.mirror??mirrorVendorSources)(vendor,rootDir,"incremental")});}
    catch(error) {vendors.push({vendor,copied:0,skipped:0,warnings:[],errors:[error instanceof Error?error.message:String(error)]});}
  }
  const report:CollectionReport={schema:1,id:randomUUID(),archiveId,machine:MACHINE,login:LOGIN,startedAt,finishedAt:new Date().toISOString(),
    status:vendors.some(vendor=>vendor.errors.length)?"failure":"success",vendors,durability:"local-verified-publication",remoteDelivery:"unconfirmed"};
  atomicArchiveWrite(path.join(archiveRoot,".archive-inventory","collections",`${report.id}.json`),JSON.stringify(report,null,2)+"\n");
  return report;
}
if(import.meta.main) {
  try {
    initializeArchiveWriterIdentity();
    const result=await collectArchiveSources(path.resolve(import.meta.dir,"../.."));
    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.status==="success"?0:1;
  } catch(error) {console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
