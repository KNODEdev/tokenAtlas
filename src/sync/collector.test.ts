import { expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { collectArchiveSources } from "./collector";
import { VENDOR_IDS } from "./contracts";

test("remote collection covers all local collectors and persists truthful failures",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-collector-"));
  try {
    const calls:string[]=[];
    const report=await collectArchiveSources(process.cwd(),{archiveRoot:root,mirror:async vendor=>{
      calls.push(vendor);
      if(vendor==="opencode")throw new Error("Snapshot unavailable");
      return {copied:vendor==="claude"?1:0,skipped:0,warnings:vendor==="grok"?["Optional installation absent"]:[],errors:[]};
    }});
    expect(calls).toEqual([...VENDOR_IDS]);expect(report.status).toBe("failure");
    expect(report.remoteDelivery).toBe("unconfirmed");
    const saved=JSON.parse(fs.readFileSync(path.join(root,".archive-inventory","collections",`${report.id}.json`),"utf8"));
    expect(saved).toEqual(report);expect(saved.vendors.find((v:any)=>v.vendor==="opencode").errors).toEqual(["Snapshot unavailable"]);
    expect(saved.vendors.find((v:any)=>v.vendor==="claude").copied).toBe(1);
  }finally{
    if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error("Unsafe fixture cleanup");
    removeTestFixture(root,{recursive:true,force:true});
  }
});
