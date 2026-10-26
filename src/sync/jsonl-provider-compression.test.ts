import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureArchiveIdentity } from "./archive-inventory";
import { advanceArchiveCompression, planArchiveCompression, startArchiveCompression } from "./archive-compression";
import { publishArchiveFile } from "./archive-publication";
import { archiveCodecSource } from "../shared/archive-codec-path";
import { selectArchiveRepresentation, withDecodedArchiveFiles } from "../ingest/archive-codec";

const content = JSON.stringify({message:"history ".repeat(2000)}) + "\n";
test("publication checks only the matching archive name, leaving unrelated compressed conversations unread",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"provider-name-match-"));
  try {
    const archiveRoot=path.join(root,"archive"),destination=path.join(archiveRoot,"claude/PC/project/current.jsonl");
    fs.mkdirSync(path.dirname(destination),{recursive:true});ensureArchiveIdentity(archiveRoot);
    const unrelated=path.join(path.dirname(destination),"other.jsonl.zst");fs.writeFileSync(unrelated,"invalid-frame-never-read");
    const source=path.join(root,"provider.jsonl");fs.writeFileSync(source,content);
    expect(publishArchiveFile(source,destination,{archiveRoot,localStateRoot:path.join(root,"state"),jsonl:true})).toBe("copied");
    expect(fs.readFileSync(destination,"utf8")).toBe(content);expect(fs.readFileSync(unrelated,"utf8")).toBe("invalid-frame-never-read");
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
for (const relative of ["claude/PC/project/session.jsonl", "grok/PC/sessions/repo/session/updates.jsonl"]) {
  test(`${relative}: cold compression, interruption, identical/shorter original, append and conflict`, async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"provider-compression-"));
    const options={archiveRoot:path.join(root,"archive"), localStateRoot:path.join(root,"state"),
      databasePath:path.join(root,"copy.sqlite"), vendors:[archiveCodecSource(relative)!.vendor],
      env:{...process.env,TOKENATLAS_TEMP_DIR:path.join(root,"scratch")}};
    try {
      fs.mkdirSync(options.archiveRoot);ensureArchiveIdentity(options.archiveRoot);
      const destination=path.join(options.archiveRoot,relative), source=path.join(root,"provider.jsonl");
      fs.writeFileSync(source,content);publishArchiveFile(source,destination,{...options,jsonl:true});
      fs.utimesSync(destination,new Date("2020-01-01"),new Date("2020-01-01"));
      const job=startArchiveCompression(options), unlink=fs.unlinkSync.bind(fs);
      const stop=spyOn(fs,"unlinkSync").mockImplementation((file=>{
        unlink(file);if(String(file)===destination)throw new Error("stop after archive retirement");
      }) as typeof fs.unlinkSync);
      try { expect((await advanceArchiveCompression(options,job.jobId)).status).toBe("waiting"); }
      finally {stop.mockRestore();}
      expect((await advanceArchiveCompression(options,job.jobId)).status).toBe("complete");
      const read=()=>withDecodedArchiveFiles([selectArchiveRepresentation(destination)],([file])=>fs.readFileSync(file!,"utf8"),false,options);
      expect(read()).toBe(content);expect(fs.readFileSync(source,"utf8")).toBe(content);
      expect(publishArchiveFile(source,destination,{...options,jsonl:true})).toBe("unchanged");
      expect(fs.existsSync(destination)).toBe(false);
      const compressedTime=fs.statSync(destination+".zst").mtimeMs;
      expect(publishArchiveFile(source,destination,{...options,jsonl:true})).toBe("unchanged");
      expect(fs.statSync(destination+".zst").mtimeMs).toBe(compressedTime);
      fs.writeFileSync(source,"");publishArchiveFile(source,destination,{...options,jsonl:true});expect(read()).toBe(content);
      fs.writeFileSync(source,content+'{"new":1}\n');publishArchiveFile(source,destination,{...options,jsonl:true});
      expect(fs.existsSync(destination+".zst")).toBe(false);expect(read()).toBe(content+'{"new":1}\n');
      fs.writeFileSync(source,content.replace("history","changed"));
      expect(()=>publishArchiveFile(source,destination,{...options,jsonl:true})).toThrow("conflict");
      expect(read()).toBe(content+'{"new":1}\n');
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
}

test("provider opt-in excludes databases, gauges, audits, metadata, evidence and warm JSONL",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"provider-plan-"));
  try {
    ensureArchiveIdentity(root);
    for(const file of ["claude/PC/project/session.jsonl","claude/PC/1234abcd-audit.jsonl","claude/PC/session.json",
      "claude/PC/warm.jsonl","grok/PC/sessions/repo/session/updates.jsonl","grok/PC/log.jsonl",
      "gemini/PC/conversations/one.db","opencode/PC/opencode.sqlite","gauges/PC/counters.jsonl"]) {
      const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
      if(!file.includes("warm"))fs.utimesSync(target,new Date("2020-01-01"),new Date("2020-01-01"));
    }
    expect(planArchiveCompression({archiveRoot:root,env:{}}).files).toEqual([]);
    expect(planArchiveCompression({archiveRoot:root,vendors:["claude","grok"]}).files.map(f=>f.relative))
      .toEqual(["claude/PC/project/session.jsonl","grok/PC/sessions/repo/session/updates.jsonl"]);
    expect(()=>planArchiveCompression({archiveRoot:root,env:{TOKENATLAS_ARCHIVE_COMPRESSION_PROVIDERS:"gemini"}})).toThrow("providers");
    expect(archiveCodecSource("claude/PC/f.jsonl.conflict-"+"a".repeat(64)+".jsonl")).toBeNull();
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("Claude/Grok production pipeline preserves prices through codec transitions, restart and full reference",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"jsonl-codec-trial-"));
  try {
    const user=path.join(root,"user"),archive=path.join(root,"archive"),config=path.join(root,"config");
    fs.mkdirSync(user);fs.mkdirSync(config);fs.writeFileSync(path.join(root,"fixture-only"),"1");
    fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[
      ...["claude","grok"].map(vendor=>({vendor,home:path.join(archive,vendor,"PC"),source_home:path.join(user,"."+vendor),machine:"fixture-pc"}))]}));
    const child=Bun.spawn([process.execPath,path.resolve("scripts/acceptance/jsonl-archive-codec-trial.ts")],{
      cwd:process.cwd(),env:{...process.env,TOKENATLAS_JSONL_TRIAL_ROOT:root,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,
        TOKENATLAS_DB:path.join(root,"copy.sqlite"),TOKENATLAS_LOCAL_STATE:path.join(root,"local"),TOKENATLAS_TEMP_DIR:path.join(root,"scratch"),
        TOKENATLAS_FROZEN_CONFIG:"1",USERPROFILE:user,APPDATA:path.join(user,"AppData","Roaming"),LOCALAPPDATA:path.join(user,"AppData","Local"),TOKENATLAS_MACHINE:"fixture-pc",TOKENATLAS_LOGIN:"fixture"},stdout:"pipe",stderr:"pipe"});
    const watchdog=setTimeout(()=>child.kill(),90_000);
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    clearTimeout(watchdog);expect({exit,stdout,stderr}).toMatchObject({exit:0});
    const report=JSON.parse(fs.readFileSync(path.join(root,"result.json"),"utf8"));
    for(const vendor of ["claude","grok"]) {
      expect(report[vendor]).toMatchObject({conversionChanged:false,conversionWork:0,restartProcessed:0,reference:"identical",calls:2});
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},100_000);
