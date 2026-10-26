import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("wizard re-save preserves v2 metadata and an unowned physical source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"atlas-setup-v2-"));
  const config = path.join(root,"config"), archive = path.join(root,"archive");
  fs.mkdirSync(config); fs.mkdirSync(archive);
  const accountsFile = path.join(config,"accounts.json");
  const source = {vendor:"codex",machine:"PC",login:"user",home:"${ARCHIVE}/codex/PC-user",source_home:"C:/Users/user/.codex"};
  const original = {version:2,subscriptions:[{id:"seat",vendor:"codex",account:"owner@example.test",note:"keep"}],sources:[source]};
  fs.writeFileSync(accountsFile,JSON.stringify(original));
  const script = path.join(root,"save.ts");
  fs.writeFileSync(script,`import { saveSetup } from ${JSON.stringify(path.join(import.meta.dir,"setup.ts"))};
    saveSetup({subscriptions:[],sources:[${JSON.stringify(source)}]}, {dbPath:${JSON.stringify(path.join(root,"atlas.sqlite"))}});`);
  try {
    const child = Bun.spawn([process.execPath,script],{env:{...process.env,TOKENATLAS_CONFIG:config,TOKENATLAS_ARCHIVE:archive,
      TOKENATLAS_LOCAL_STATE:path.join(root,"state")},stdout:"pipe",stderr:"pipe"});
    const stderr = await new Response(child.stderr).text();
    expect({code:await child.exited,stderr}).toEqual({code:0,stderr:""});
    expect(JSON.parse(fs.readFileSync(accountsFile,"utf8"))).toEqual(original);
  } finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});
