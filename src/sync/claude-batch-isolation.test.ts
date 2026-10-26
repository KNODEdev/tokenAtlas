import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

test('queued Claude initializes once and preserves bad-file facts/bookmarks while good peers finish',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-batch-'));
  const module=(name:string)=>JSON.stringify(pathToFileURL(path.resolve(import.meta.dir,name)).href);
  try{
    const archive=path.join(root,'archive'),config=path.join(root,'config');fs.mkdirSync(config,{recursive:true});fs.writeFileSync(path.join(config,'accounts.json'),'{"subscriptions":[]}');
    const script=path.join(root,'test.ts');
    fs.writeFileSync(script,`
      import fs from 'node:fs';import path from 'node:path';
      import {Database} from ${module('../db/sqlite.ts')};
      import {createTestDatabase} from ${module('test-support.ts')};
      import {createProductionAdapters} from ${module('adapters.ts')};
      import {ingestClaude} from ${module('../ingest/claude.ts')};
      const f=createTestDatabase();
      const directory=path.join(process.env.TOKENATLAS_ARCHIVE!,'claude','PC-user');fs.mkdirSync(directory,{recursive:true});
      const files=['good-a','bad','good-b'].map(name=>path.join(directory,name+'.jsonl'));
      const line=(id:string,tokens:number)=>JSON.stringify({type:'assistant',timestamp:'2026-09-19T12:00:00Z',message:{id,model:'fixture',usage:{input_tokens:tokens,output_tokens:1}}})+'\\n';
      try{
        for(const [i,file] of files.entries())fs.writeFileSync(file,line(['good-a','bad','good-b'][i]!,10));
        await ingestClaude({dbPath:f.dbPath,files:[files[1]!],skipMigrations:true});
        const db=new Database(f.dbPath);const old=db.query("SELECT * FROM claude_files WHERE path=?").get(files[1]!);
        db.exec("CREATE TRIGGER fail_bad BEFORE INSERT ON claude_events WHEN NEW.call_id='bad' BEGIN SELECT RAISE(ABORT,'synthetic bad input'); END");db.close();
        fs.writeFileSync(files[1]!,line('bad',999));
        let startups=0;const log=console.log;console.log=(...args:any[])=>{if(String(args[0]).includes('Claude Ingest Starting'))startups++;};
        let result;try{result=await createProductionAdapters().claude({activeDbPath:f.dbPath,stageDbPath:f.dbPath,mode:'incremental',rootDir:process.cwd(),changedFiles:files});}finally{console.log=log;}
        const check=new Database(f.dbPath),rows=check.query('SELECT call_id,in_uncached FROM claude_events ORDER BY call_id').all(),bookmark=check.query('SELECT * FROM claude_files WHERE path=?').get(files[1]!);check.close();
        const quiet=await ingestClaude({dbPath:f.dbPath,files:[files[0]!,files[2]!],skipMigrations:true});
        const missing=await ingestClaude({dbPath:f.dbPath,files:[path.join(directory,'missing.jsonl'),files[0]!],skipMigrations:true,isolateSelectedFiles:true});
        console.log('RESULT:'+JSON.stringify({startups,result,rows,preserved:JSON.stringify(old)===JSON.stringify(bookmark),quiet,missing}));
      }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
    `);
    const child=Bun.spawn([process.execPath,script],{env:{...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(root,'state')},stdout:'pipe',stderr:'pipe'});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({exit,err}).toEqual({exit:0,err:''});
    const value=JSON.parse(out.split(/\r?\n/).find(line=>line.startsWith('RESULT:'))!.slice(7));
    expect(value.startups).toBe(1);expect(value.result.processedInputs).toBe(2);expect(value.result.failedInputs).toHaveLength(1);
    expect(value.result.failedInputs[0].error).toContain('synthetic bad input');expect(value.result.processedFiles).toHaveLength(2);
    expect(value.rows).toEqual([{call_id:'bad',in_uncached:10},{call_id:'good-a',in_uncached:10},{call_id:'good-b',in_uncached:10}]);expect(value.preserved).toBe(true);
    expect(value.quiet).toMatchObject({processed:0,skipped:2,writtenRows:0,dirtyRange:null});
    expect(value.missing).toMatchObject({processed:0,skipped:1,writtenRows:0});expect(value.missing.failedInputs).toHaveLength(1);expect(value.missing.processedFiles).toHaveLength(1);
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);
