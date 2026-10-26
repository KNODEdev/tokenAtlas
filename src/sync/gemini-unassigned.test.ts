import {test,expect} from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";

test("unassigned Gemini rebuild and selected archive imports agree, then assignment preserves valued facts",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-unassigned-"));
  const module=(name:string)=>JSON.stringify(pathToFileURL(path.resolve(import.meta.dir,name)).href);
  try {
    const archive=path.join(root,"archive"),config=path.join(root,"config");fs.mkdirSync(config,{recursive:true});
    fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[{vendor:"gemini",id:"mapped"}],
      sources:[{vendor:"gemini",machine:"PC",login:"known",home:path.join(archive,"gemini","PC-known")}]}));
    const script=path.join(root,"run.ts");
    fs.writeFileSync(script,`
      import fs from 'node:fs';import path from 'node:path';
      import {Database} from ${module('../db/sqlite.ts')};
      import {createTestDatabase} from ${module('test-support.ts')};
      import {createProductionAdapters} from ${module('adapters.ts')};
      import {ingestGeminiAsync} from ${module('../ingest/gemini.ts')};
      import {subscriptionEventFromRow,subscriptionAccountingAdapter} from ${module('../server/subscription-accounting-adapters.ts')};
      import {buildAccountResolver,loadAccountResolver} from ${module('../server/account-resolver.ts')};
      const archive=process.env.TOKENATLAS_ARCHIVE!;
      const files=['PC-known','PC-unknown'].map(profile=>path.join(archive,'gemini',profile,'conversations','chat.db'));
      for(const file of files){fs.mkdirSync(path.dirname(file),{recursive:true});const db=new Database(file);db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');db.query('INSERT INTO gen_metadata VALUES(0,?)').run(new Uint8Array([10,4,34,2,16,123]));db.close();}
      const a=createTestDatabase(),b=createTestDatabase();
      try{
        const adapter=createProductionAdapters().gemini;
        // A rebuild reads every archived profile in place; the queued import reads the selected files.
        const full=await adapter({activeDbPath:a.dbPath,stageDbPath:a.dbPath,rootDir:process.cwd(),mode:'full',rebuild:true});
        const queued=await adapter({activeDbPath:b.dbPath,stageDbPath:b.dbPath,rootDir:process.cwd(),mode:'incremental',changedFiles:files});
        const unknownStore='source:gemini:PC-unknown',knownStore='source:gemini:PC-known';
        const dbA=new Database(a.dbPath),dbB=new Database(b.dbPath);
        let same=false,excluded=false,assigned=false,ts='';
        try{
          const select='SELECT store,conversation_id,gen_idx,path,fresh_in,ts,usd FROM gemini_events ORDER BY store';
          same=JSON.stringify(dbA.query(select).all())===JSON.stringify(dbB.query(select).all());
          const unassigned=dbB.query('SELECT * FROM gemini_events WHERE store=?').get(unknownStore);
          const event=subscriptionEventFromRow(subscriptionAccountingAdapter('gemini'),unassigned,archive)!;
          ts=unassigned.ts;
          excluded=event.account===null&&buildAccountResolver([]).resolve('gemini',event.source,event.account_key,event.ts).account===null;
          dbB.query("UPDATE gemini_events SET usd=17.25,project_id='kept' WHERE store=?").run(unknownStore);
          dbB.query("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('gemini','gemini/pc-unknown','2020-01-01','new-account','declared','test')").run();
          assigned=loadAccountResolver(dbB,[]).resolve('gemini',event.source,event.account_key,event.ts).account==='new-account';
        }finally{dbA.close();dbB.close();}
        const file=files[1]!;
        const reimport=await ingestGeminiAsync(path.dirname(file),unknownStore,{ archivedInput: true,atlasPath:b.dbPath,files:[file]});
        const restart=await ingestGeminiAsync(path.dirname(file),unknownStore,{ archivedInput: true,atlasPath:b.dbPath,files:[file]});
        const check=new Database(b.dbPath);
        let retainedUnknown,bookmarks;
        try{
          retainedUnknown=check.query('SELECT store,fresh_in,usd,project_id FROM gemini_events WHERE store=?').all(unknownStore);
          bookmarks=check.query('SELECT count(*) n FROM gemini_files WHERE store=?').get(unknownStore);
        }finally{check.close();}
        // Two physical profiles cannot publish the same persisted store identity.
        let collision=false;try{await ingestGeminiAsync(path.dirname(files[0]!),unknownStore,{ archivedInput: true,atlasPath:b.dbPath,files:[files[0]!],force:false});}catch(e){collision=String(e).includes('identity conflicts');}
        const sparse=createTestDatabase();let sparseCollision=false;
        try{try{await ingestGeminiAsync(path.dirname(files[0]!),unknownStore,{ archivedInput: true,atlasPath:sparse.dbPath,sourceAtlasPath:b.dbPath,files:[files[0]!],force:true});}catch(e){sparseCollision=String(e).includes('identity conflicts');}}finally{fs.rmSync(sparse.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
        const afterCollision=new Database(b.dbPath);const retained=afterCollision.query('SELECT store,fresh_in,usd FROM gemini_events ORDER BY store').all();afterCollision.close();
        console.log('RESULT:'+JSON.stringify({same,full:Object.keys(full.diagnostics.stores),queued:Object.keys(queued.diagnostics.stores),excluded,reimport,restart,assigned,retainedUnknown,bookmarks,collision,sparseCollision,retained,ts,knownStore,unknownStore}));
      }finally{fs.rmSync(a.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});fs.rmSync(b.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
    `);
    const child=Bun.spawn([process.execPath,script],{env:{...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_TEMP_DIR:path.join(root,"scratch")},stdout:"pipe",stderr:"pipe"});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,err}).toEqual({exit:0,err:""});
    const result=JSON.parse(out.split(/\r?\n/).find(line=>line.startsWith("RESULT:"))!.slice(7));
    expect(result.same).toBe(true);expect(result.full).toEqual(result.queued);expect(result.full).toHaveLength(2);
    expect(result.excluded).toBe(true);expect(result.assigned).toBe(true);
    expect(result.reimport).toMatchObject({skipped:1,reassigned:0,generations:0,dirtyRange:null});
    expect(result.restart).toMatchObject({skipped:1,reassigned:0,generations:0,dirtyRange:null});
    expect(result.retainedUnknown).toEqual([{store:result.unknownStore,fresh_in:123,usd:17.25,project_id:"kept"}]);
    expect(result.bookmarks).toEqual({n:1});expect(result.collision).toBe(true);
    expect(result.sparseCollision).toBe(true);
    expect(result.retained.map((row:any)=>({store:row.store,tokens:row.fresh_in}))).toEqual([{store:result.knownStore,tokens:123},{store:result.unknownStore,tokens:123}]);
    expect(result.retained.find((row:any)=>row.store===result.unknownStore).usd).toBe(17.25);
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);
