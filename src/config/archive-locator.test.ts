import { afterEach,expect,spyOn,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_ARCHIVE_LOCATOR_FILE,persistLocalArchiveSelection,proveLocalArchiveActivation,readLocalArchiveSelection } from "./archive-locator";
import { resolveArchiveRootFromEnv } from "./path-environment";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
function fixture(name="archive",id="archive-id"){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-locator-"));roots.push(root);
  const state=path.join(root,"state"),archive=path.join(root,name),inventory=path.join(archive,".archive-inventory");
  fs.mkdirSync(inventory,{recursive:true});fs.writeFileSync(path.join(inventory,"identity.json"),JSON.stringify({schema:1,archiveId:id}));
  return {root,state,archive,id,env:{...process.env,TOKENATLAS_ARCHIVE:"",TOKENATLAS_CONFIG:"",
    TOKENATLAS_LOCAL_STATE:state,OneDrive:path.join(root,"OneDrive")}};
}
async function child(code:string,env:Record<string,string|undefined>,args:string[]=[]){
  const proc=Bun.spawn([process.execPath,"-e",code,...args],{cwd:process.cwd(),env,stdout:"pipe",stderr:"pipe"});
  const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  return {exit,stdout:stdout.trim(),stderr};
}

test("pure resolution creates nothing and a missing selected archive never falls back",async()=>{
  const f=fixture();const absentState=path.join(f.root,"absent-state");
  expect(resolveArchiveRootFromEnv({...f.env,TOKENATLAS_LOCAL_STATE:absentState,USERPROFILE:path.join(f.root,"home")}))
    .toBe(path.join(f.root,"home","tokenAtlas"));
  expect(fs.existsSync(absentState)).toBe(false);
  persistLocalArchiveSelection({root:f.archive,archiveId:f.id},f.env);
  fs.renameSync(f.archive,path.join(f.root,"offline"));
  expect(readLocalArchiveSelection(f.env)).toEqual({root:path.resolve(f.archive),archiveId:f.id});
  const module=JSON.stringify(path.join(import.meta.dir,"path-environment.ts"));
  const result=await child(`import {resolveArchiveRootFromEnv} from ${module};console.log(resolveArchiveRootFromEnv(process.env));`,f.env);
  expect({exit:result.exit,stderr:result.stderr,root:result.stdout}).toEqual({exit:0,stderr:"",root:path.resolve(f.archive)});
  expect(fs.existsSync(f.archive)).toBe(false);
});

test("an archive at the legacy guess keeps being found without a local choice",()=>{
  const f=fixture();const legacy=path.join(f.root,"OneDrive","_Hub","02_PRODUCTS","tokenUsage");
  fs.mkdirSync(legacy,{recursive:true});
  expect(resolveArchiveRootFromEnv({...f.env,TOKENATLAS_LOCAL_STATE:path.join(f.root,"absent-state")})).toBe(legacy);
});

test("killed and concurrent first publishers never expose an empty public database",async()=>{
  const f=fixture();const locatorModule=JSON.stringify(path.join(import.meta.dir,"archive-locator.ts"));
  const interrupted=await child(`import fs from "node:fs";(fs as any).linkSync=()=>process.kill(process.pid);
    const {persistLocalArchiveSelection}=await import(${locatorModule});
    persistLocalArchiveSelection({root:process.argv[1],archiveId:process.argv[2]},process.env);`,f.env,[f.archive,f.id]);
  expect(interrupted.exit).not.toBe(0);
  expect(fs.existsSync(path.join(f.state,LOCAL_ARCHIVE_LOCATOR_FILE))).toBe(false);
  expect(fs.readdirSync(f.state).some(name=>name.endsWith(".tmp"))).toBe(true);
  expect(persistLocalArchiveSelection({root:f.archive,archiveId:f.id},f.env)).toMatchObject({changed:true});

  fs.rmSync(path.join(f.state,LOCAL_ARCHIVE_LOCATOR_FILE));
  const archives=Array.from({length:6},(_,index)=>{
    const archive=path.join(f.root,`parallel-${index}`),inventory=path.join(archive,".archive-inventory"),id=`parallel-${index}`;
    fs.mkdirSync(inventory,{recursive:true});fs.writeFileSync(path.join(inventory,"identity.json"),JSON.stringify({schema:1,archiveId:id}));
    return {archive,id};
  });
  const code=`const {persistLocalArchiveSelection}=await import(${locatorModule});
    console.log(JSON.stringify(persistLocalArchiveSelection({root:process.argv[1],archiveId:process.argv[2]},process.env)));`;
  const runs=await Promise.all(archives.map(item=>child(code,f.env,[item.archive,item.id])));
  expect(runs.every(run=>run.exit===0 && run.stderr==="")).toBe(true);
  const selected=readLocalArchiveSelection(f.env)!;
  expect(archives.some(item=>path.resolve(item.archive)===selected.root && item.id===selected.archiveId)).toBe(true);
});

test("malformed public databases fail closed with context while explicit environment still wins",async()=>{
  const f=fixture();fs.mkdirSync(f.state,{recursive:true});
  const file=path.join(f.state,LOCAL_ARCHIVE_LOCATOR_FILE);fs.writeFileSync(file,"not sqlite bytes");
  expect(()=>readLocalArchiveSelection(f.env)).toThrow(`Invalid local archive locator '${file}'`);
  expect(()=>persistLocalArchiveSelection({root:f.archive,archiveId:f.id},f.env)).toThrow(`Invalid local archive locator '${file}'`);
  const explicit=path.join(f.root,"explicit");
  expect(resolveArchiveRootFromEnv({...f.env,TOKENATLAS_ARCHIVE:explicit})).toBe(path.resolve(explicit));
});

test("public persistence rejects missing, unrecognized, mismatched and staged archives",()=>{
  const f=fixture();
  expect(()=>persistLocalArchiveSelection({root:path.join(f.root,"missing"),archiveId:"missing"},f.env)).toThrow("unavailable");
  const unknown=path.join(f.root,"unknown");fs.mkdirSync(unknown);
  expect(()=>persistLocalArchiveSelection({root:unknown,archiveId:"unknown"},f.env)).toThrow("no identity");
  expect(()=>persistLocalArchiveSelection({root:f.archive,archiveId:"different"},f.env)).toThrow("identity mismatch");
  fs.writeFileSync(path.join(f.archive,".archive-relocation-owner.json"),"{}");
  expect(()=>persistLocalArchiveSelection({root:f.archive,archiveId:f.id},f.env)).toThrow("staged");
});

test("an inaccessible committed first locator is unknown rather than an absent uncommitted locator",()=>{
  const f=fixture(),selection={root:f.archive,archiveId:f.id};
  const file=path.join(f.state,LOCAL_ARCHIVE_LOCATOR_FILE);
  expect(proveLocalArchiveActivation(selection,null,f.env).decision).toBe("uncommitted");
  persistLocalArchiveSelection(selection,f.env);
  const originalExists=fs.existsSync,originalStat=fs.statSync;
  const exists=spyOn(fs,"existsSync").mockImplementation(value=>String(value)===file?false:originalExists(value));
  const stat=spyOn(fs,"statSync").mockImplementation(((value:fs.PathLike,options?:unknown)=>{
    if(String(value)===file)throw Object.assign(new Error("locator access denied"),{code:"EACCES"});
    return originalStat(value,options as undefined);
  }) as typeof fs.statSync);
  try {
    expect(proveLocalArchiveActivation(selection,null,f.env)).toEqual({decision:"unknown",reason:"locator access denied"});
  } finally {stat.mockRestore();exists.mockRestore();}
  expect(proveLocalArchiveActivation(selection,null,f.env).decision).toBe("committed");
  expect(readLocalArchiveSelection(f.env)).toEqual(selection);
});
