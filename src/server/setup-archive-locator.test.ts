import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function run(script:string,env:Record<string,string|undefined>){
  const proc=Bun.spawn([process.execPath,script],{cwd:process.cwd(),env,stdout:"pipe",stderr:"pipe"});
  const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  return {exit,stdout:stdout.trim(),stderr};
}

test("archive-only setup needs no envFile and a fresh process resolves its durable choice",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-setup-local-"));
  const state=path.join(root,"state"),target=path.join(root,"selected"),oneDrive=path.join(root,"OneDrive");
  const legacy=path.join(oneDrive,"_Hub","02_PRODUCTS","tokenUsage","config");fs.mkdirSync(legacy,{recursive:true});
  fs.writeFileSync(path.join(legacy,"accounts.json"),JSON.stringify({version:2,sources:[],subscriptions:[]}));
  const first=path.join(root,"first.ts"),second=path.join(root,"second.ts");
  fs.writeFileSync(first,`import {saveSetup} from ${JSON.stringify(path.join(import.meta.dir,"setup.ts"))};
    console.log(JSON.stringify(saveSetup({archive:process.env.TARGET!,archiveAction:"create",subscriptions:[]},
      {dbPath:process.env.DB!})));`);
  fs.writeFileSync(second,`import {resolveArchiveRootFromEnv} from ${JSON.stringify(path.resolve(import.meta.dir,"../config/path-environment.ts"))};
    console.log(resolveArchiveRootFromEnv(process.env));`);
  const env={...process.env,NODE_ENV:"test",TOKENATLAS_ARCHIVE:"",TOKENATLAS_CONFIG:"",
    TOKENATLAS_LOCAL_STATE:state,OneDrive:oneDrive,TARGET:target,DB:path.join(root,"db","atlas.sqlite")};
  try {
    const saved=await run(first,env);expect({exit:saved.exit,stderr:saved.stderr}).toEqual({exit:0,stderr:""});
    const result=JSON.parse(saved.stdout) as {restart_required:boolean;wrote:string[]};
    expect(result.restart_required).toBe(true);
    expect(result.wrote).toContain(path.join(state,"archive-location.sqlite"));
    expect(fs.existsSync(path.join(root,".env"))).toBe(false);
    const reopened=await run(second,env);
    expect({exit:reopened.exit,stderr:reopened.stderr,root:reopened.stdout})
      .toEqual({exit:0,stderr:"",root:path.resolve(target)});
  } finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);

test("connect preserves foreign config and env settings while removing a stale launcher archive hint",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-setup-connect-"));
  const state=path.join(root,"state"),archive=path.join(root,"archive"),config=path.join(root,"foreign-config");
  const inventory=path.join(archive,".archive-inventory");fs.mkdirSync(inventory,{recursive:true});fs.mkdirSync(config);
  fs.writeFileSync(path.join(inventory,"identity.json"),JSON.stringify({schema:1,archiveId:"connect-id"}));
  const accounts=JSON.stringify({version:2,sources:[],subscriptions:[],foreign_setting:"preserve exactly"});
  fs.writeFileSync(path.join(config,"accounts.json"),accounts);
  const envFile=path.join(root,"launcher.env");fs.writeFileSync(envFile,"FOREIGN_SETTING=keep\nTOKENATLAS_ARCHIVE=C:/stale/archive\nTOKENATLAS_CONFIG="+config+"\n");
  const script=path.join(root,"connect.ts");fs.writeFileSync(script,`
    import fs from "node:fs";import {saveSetup} from ${JSON.stringify(path.join(import.meta.dir,"setup.ts"))};
    const before=fs.readFileSync(process.env.TOKENATLAS_CONFIG+"/accounts.json","utf8");
    const result=saveSetup({archive:process.env.ARCHIVE!,archiveAction:"connect",config:process.env.TOKENATLAS_CONFIG!,
      subscriptions:[{id:"ignored",home:"ignored"}]},{envFile:process.env.ENV_FILE!,dbPath:process.env.DB!});
    const after=fs.readFileSync(process.env.TOKENATLAS_CONFIG+"/accounts.json","utf8");
    console.log(JSON.stringify({result,same:before===after,environment:fs.readFileSync(process.env.ENV_FILE!,"utf8")}));`);
  try {
    const result=await run(script,{...process.env,NODE_ENV:"test",TOKENATLAS_ARCHIVE:"",TOKENATLAS_CONFIG:config,
      TOKENATLAS_LOCAL_STATE:state,ARCHIVE:archive,ENV_FILE:envFile,DB:path.join(root,"atlas.sqlite")});
    expect({exit:result.exit,stderr:result.stderr}).toEqual({exit:0,stderr:""});
    const value=JSON.parse(result.stdout);
    expect(value.same).toBe(true);expect(value.environment).toContain("FOREIGN_SETTING=keep");
    expect(value.environment).toContain(`TOKENATLAS_CONFIG=${config}`);
    expect(value.environment).not.toContain("TOKENATLAS_ARCHIVE=");
    expect(value.result.wrote).toContain(path.join(state,"archive-location.sqlite"));
  } finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);

test("an inherited archive override blocks a different requested root before it is created",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-setup-shadow-"));
  const requested=path.join(root,"requested"),inherited=path.join(root,"inherited"),config=path.join(root,"config");
  fs.mkdirSync(config);fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,sources:[],subscriptions:[]}));
  const script=path.join(root,"shadow.ts");fs.writeFileSync(script,`import {saveSetup} from ${JSON.stringify(path.join(import.meta.dir,"setup.ts"))};
    try{saveSetup({archive:process.env.REQUESTED!,archiveAction:"create",config:process.env.TOKENATLAS_CONFIG!,subscriptions:[]},
      {dbPath:process.env.DB!});console.log("accepted");}catch(e){console.error(String(e));process.exit(9);}`);
  try {
    const result=await run(script,{...process.env,NODE_ENV:"test",TOKENATLAS_ARCHIVE:inherited,TOKENATLAS_CONFIG:config,
      TOKENATLAS_LOCAL_STATE:path.join(root,"state"),REQUESTED:requested,DB:path.join(root,"atlas.sqlite")});
    expect(result.exit).toBe(9);expect(result.stderr).toContain("TOKENATLAS_ARCHIVE is inherited");
    expect(fs.existsSync(requested)).toBe(false);
  } finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);

// The first-run screen sends "create" for a missing or empty default folder and nothing otherwise.
async function firstSave(prepare:(archive:string)=>void){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-setup-first-"));
  const home=path.join(root,"home"),archive=path.join(home,"tokenAtlas"),envFile=path.join(root,"launcher.env");
  fs.mkdirSync(home);fs.writeFileSync(envFile,"FOREIGN_SETTING=keep\n");prepare(archive);
  const script=path.join(root,"first.ts");fs.writeFileSync(script,`
    import {saveSetup,buildSetupState} from ${JSON.stringify(path.join(import.meta.dir,"setup.ts"))};
    const db=process.env.DB!,state=buildSetupState(db),kind=state.archive.kind;
    const create=kind==="missing"||kind==="empty";
    let result=null,refused="";
    try{result=saveSetup({...(create?{archive:state.archive.root,archiveAction:"create" as const}:{}),subscriptions:[]},
      {envFile:process.env.ENV_FILE!,dbPath:db});}catch(e){refused=String(e);}
    console.log(JSON.stringify({root:state.archive.root,kind,result,refused}));`);
  try {
    const run1=await run(script,{...process.env,NODE_ENV:"test",TOKENATLAS_ARCHIVE:"",TOKENATLAS_CONFIG:"",TOKENATLAS_DB:"",
      USERPROFILE:home,OneDrive:"",ONEDRIVE:"",LOCALAPPDATA:path.join(root,"local"),TOKENATLAS_LOCAL_STATE:path.join(root,"state"),
      ENV_FILE:envFile,DB:path.join(root,"db","atlas.sqlite")});
    expect({exit:run1.exit,stderr:run1.stderr}).toEqual({exit:0,stderr:""});
    const value=JSON.parse(run1.stdout);
    expect(value.root).toBe(archive);
    expect(fs.readFileSync(envFile,"utf8")).toBe("FOREIGN_SETTING=keep\n");
    return {...value,archive,accounts:path.join(archive,"config","accounts.json"),files:fs.existsSync(archive)?fs.readdirSync(archive).sort():null};
  } finally {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test("first save creates a local default archive in one step without a restart",async()=>{
  const value=await firstSave(()=>{});
  expect(value.kind).toBe("missing");expect(value.refused).toBe("");
  expect(value.result.restart_required).toBe(false);expect(value.result.wrote).toContain(value.accounts);
},30000);

test("first save adopts an empty default folder",async()=>{
  const value=await firstSave(archive=>fs.mkdirSync(archive));
  expect(value.kind).toBe("empty");expect(value.refused).toBe("");
  expect(value.result.restart_required).toBe(false);expect(value.result.wrote).toContain(value.accounts);
},30000);

test("first save leaves a folder of unknown files untouched and says why",async()=>{
  const value=await firstSave(archive=>{fs.mkdirSync(archive);fs.writeFileSync(path.join(archive,"notes.txt"),"mine");});
  expect(value.kind).toBe("other");expect(value.result).toBeNull();
  expect(value.refused).toContain("nie jest pusty");expect(value.files).toEqual(["notes.txt"]);
},30000);

test("first save keeps using an archive that is already there",async()=>{
  const value=await firstSave(archive=>{fs.mkdirSync(path.join(archive,"config"),{recursive:true});
    fs.writeFileSync(path.join(archive,"config","accounts.json"),JSON.stringify({version:2,sources:[],subscriptions:[]}));});
  expect(value.kind).toBe("archive");expect(value.refused).toBe("");
  expect(value.result.restart_required).toBe(false);expect(value.result.wrote).toContain(value.accounts);
},30000);
