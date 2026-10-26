import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSyncProcess } from "./api";
import { removeTestFixture } from "../test-cleanup";

test("sync stderr reaches the server before child exit, preserves split UTF-8 and flushes its last line", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-sync-process-"));
  const seen = path.join(directory, "diagnostic-seen");
  const lines: string[] = [];
  const log = spyOn(console, "error").mockImplementation(line => {
    lines.push(String(line));
    if (line === "[tokenAtlas sync] first warning") fs.writeFileSync(seen, "seen");
  });
  try {
    fs.mkdirSync(path.join(directory,"src/sync"),{recursive:true});
    fs.writeFileSync(path.join(directory,"src/sync/runner.ts"), `
      import fs from "node:fs";
      process.stderr.write("first warning\\r\\n");
      const deadline=Date.now()+3000;
      while(!fs.existsSync(${JSON.stringify(seen)}) && Date.now()<deadline) await Bun.sleep(10);
      if(!fs.existsSync(${JSON.stringify(seen)})) { process.stderr.write("diagnostic was buffered"); process.exit(7); }
      const bytes=Buffer.from("żółć\\n");
      process.stderr.write(bytes.subarray(0,1)); await Bun.sleep(10);
      process.stderr.write(bytes.subarray(1)); process.stderr.write("final warning");
      console.log("stdout diagnostic");
      console.log('TOKENATLAS_SYNC_RESULT:'+JSON.stringify({runId:"fixture",status:"success"}));
    `);
    const result = await runSyncProcess(directory,path.join(directory,"unused.sqlite"),{trigger:"manual",scope:{kind:"all"},mode:"incremental"});
    expect(result.runId).toBe("fixture");
    expect(result.status).toBe("success");
    expect(lines).toEqual(["[tokenAtlas sync] first warning","[tokenAtlas sync] żółć","[tokenAtlas sync] final warning"]);
  } finally {log.mockRestore();removeTestFixture(directory,{recursive:true,force:true});}
});

test("sync stderr forwarding retains the original failure detail", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-sync-process-"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    fs.mkdirSync(path.join(directory,"src/sync"),{recursive:true});
    fs.writeFileSync(path.join(directory,"src/sync/runner.ts"), `
      console.log("stdout failure detail");
      process.stderr.write("first failure\\r\\nlast failure"); process.exitCode=2;
    `);
    await expect(runSyncProcess(directory,path.join(directory,"unused.sqlite"),{trigger:"manual",scope:{kind:"all"},mode:"incremental"}))
      .rejects.toThrow("Sync worker failed: first failure\r\nlast failure");
    expect(log.mock.calls.map(call=>call[0])).toEqual(["[tokenAtlas sync] first failure","[tokenAtlas sync] last failure"]);
  } finally {log.mockRestore();removeTestFixture(directory,{recursive:true,force:true});}
});
