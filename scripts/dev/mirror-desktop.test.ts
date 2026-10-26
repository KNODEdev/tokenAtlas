import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorDesktop } from "./mirror-desktop";
import { ensureArchiveIdentity } from "../../src/sync/archive-inventory";
const fixtures:string[]=[];
afterEach(()=>{for(const root of fixtures.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-desktop-"));fixtures.push(root);
 const source=path.join(root,"source"),archive=path.join(root,"archive");fs.mkdirSync(archive);ensureArchiveIdentity(archive);
 const file=path.join(source,"local_1234abcd-abcd/audit.jsonl");fs.mkdirSync(path.dirname(file),{recursive:true});
 const destination=path.join(archive,"claude/machine-desktop");return {source,file,archive,destination,latest:path.join(destination,"1234abcd-audit.jsonl")};
}
test("desktop complete lines append one file, shrink retains archive, rewrite conflicts",()=>{
 const f=fixture();fs.writeFileSync(f.file,'{}\n{"partial":');expect(mirrorDesktop(f.source,f.destination,f.archive)).toEqual({copied:1,unchanged:0});
 expect(fs.readFileSync(f.latest,"utf8")).toBe('{}\n');fs.appendFileSync(f.file,'1}\n');expect(mirrorDesktop(f.source,f.destination,f.archive).copied).toBe(1);
 fs.writeFileSync(f.file,'{}\n');expect(mirrorDesktop(f.source,f.destination,f.archive).unchanged).toBe(1);expect(fs.readFileSync(f.latest,"utf8")).toBe('{}\n{"partial":1}\n');
 fs.writeFileSync(f.file,'{"diverged":true}\n');expect(()=>mirrorDesktop(f.source,f.destination,f.archive)).toThrow("Unresolved archive source conflict");
 expect(fs.existsSync(path.join(f.archive,".source-versions"))).toBe(false);
});
test("selected desktop transcript does not discover other histories and reports target",()=>{
 const f=fixture();fs.writeFileSync(f.file,'{}\n');const published:string[]=[];
 const spy=spyOn(fs,"readdirSync").mockImplementation(()=>{throw new Error("unexpected discovery");});
 try {expect(mirrorDesktop(f.source,f.destination,f.archive,[f.file],file=>published.push(file))).toEqual({copied:1,unchanged:0});}finally{spy.mockRestore();}
 expect(published).toEqual([f.latest]);expect(()=>mirrorDesktop(f.source,f.destination,f.archive,[path.join(f.archive,"outside.jsonl")])).toThrow("outside source root");
});
test("incomplete first record is deferred",()=>{
 const f=fixture();fs.writeFileSync(f.file,'{"partial":');expect(()=>mirrorDesktop(f.source,f.destination,f.archive)).toThrow("publication deferred");expect(fs.existsSync(f.latest)).toBe(false);
});
