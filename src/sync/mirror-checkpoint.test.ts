import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncFileQueue, type SyncFileRoot } from "./file-queue";
import type { Database } from "../db/sqlite";
import { fingerprint } from "./file-fingerprint";
import { removeTestFixture } from "../test-cleanup";

const directories:string[]=[],queues=new Set<SyncFileQueue>();
afterEach(()=>{
  for(const queue of queues)queue.close();queues.clear();
  for(const directory of directories.splice(0))removeTestFixture(directory,{recursive:true,force:true});
});
function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-mirror-checkpoint-"));directories.push(directory);
  const archive=path.join(directory,"archive"),source=path.join(directory,"source"),state=path.join(directory,"state");
  fs.mkdirSync(archive);fs.mkdirSync(source);
  const roots:SyncFileRoot[]=[{path:source,vendor:"codex",kind:"source"},{path:archive,vendor:"codex",kind:"archive"}];
  const a=path.join(source,"a.jsonl"),b=path.join(source,"b.jsonl"),out=path.join(archive,"codex","PC","sessions","a.jsonl");
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(a,'{"a":1}\n');fs.writeFileSync(b,'{"b":2}\n');
  const open=()=>{const queue=new SyncFileQueue(archive,state);queues.add(queue);return queue;};
  const close=(queue:SyncFileQueue)=>{queue.close();queues.delete(queue);};
  const queue=open();queue.prepare(roots);
  const rows=queue.take("codex",roots),row=rows.find(r=>r.path===a)!;
  fs.copyFileSync(a,out);
  return {directory,archive,source,roots,a,b,out,open,close,queue,row};
}

test("a restart retains each archived original while its unimported archive stays pending",()=>{
  const f=fixture();
  const [pending]=f.queue.checkpointMirroredSource(f.row,[f.out]);
  expect(f.queue.hasPending("codex",f.a)).toBe(false);
  expect(f.queue.hasPending("codex",f.out)).toBe(true);
  f.close(f.queue);const queue=f.open();queue.reconcileLater();queue.prepare(f.roots);
  let originalReads=0;const open=fs.openSync;
  const hook=spyOn(fs,"openSync").mockImplementation(((file:fs.PathLike,...args:unknown[])=>{
    if(String(file)===f.a)originalReads++;
    return Reflect.apply(open,fs,[file,...args]);
  }) as typeof fs.openSync);
  let rows:ReturnType<SyncFileQueue["take"]>;
  try{rows=queue.take("codex",f.roots);}finally{hook.mockRestore();}
  expect(originalReads).toBe(0);
  expect(rows!.filter(r=>r.kind==="source").map(r=>r.path)).toEqual([f.b]);
  expect(rows!.find(r=>r.path===f.out)?.revision).toBeGreaterThanOrEqual(pending!.revision);
});

test("enqueueing every archive output and accepting the original commit or roll back together",()=>{
  const f=fixture(),second=path.join(path.dirname(f.out),"second.jsonl");fs.copyFileSync(f.a,second);
  const db=(f.queue as unknown as {db:Database}).db;
  db.query("CREATE TRIGGER fail_second_output BEFORE INSERT ON pending WHEN NEW.path="+"'"+second.replaceAll("'","''")+"' BEGIN SELECT RAISE(ABORT,'queue failure'); END").run();
  expect(()=>f.queue.checkpointMirroredSource(f.row,[f.out,second])).toThrow("queue failure");
  expect(f.queue.hasPending("codex",f.a)).toBe(true);
  expect(f.queue.hasPending("codex",f.out)).toBe(false);
  expect(db.query("SELECT count(*) n FROM state WHERE key LIKE 'mirror-original:%'").get()).toEqual({n:0});
  db.exec("DROP TRIGGER fail_second_output");
  expect(f.queue.checkpointMirroredSource(f.row,[f.out,second])).toHaveLength(2);
  expect(f.queue.hasPending("codex",f.a)).toBe(false);
});

test("a source that grows during mirroring remains queued while its archived prefix is retained",()=>{
  const f=fixture();fs.appendFileSync(f.a,'{"new":3}\n');
  f.queue.checkpointMirroredSource(f.row,[f.out]);
  expect(f.queue.hasPending("codex",f.a)).toBe(true);
  expect(f.queue.hasPending("codex",f.out)).toBe(true);
  expect(f.queue.take("codex",f.roots).find(r=>r.path===f.a)?.fingerprint).toBe(fingerprint(f.a));
});

test("a newer source signal survives acknowledgement of the copied generation",()=>{
  const f=fixture();f.queue.enqueue(f.a,"codex");
  f.queue.checkpointMirroredSource(f.row,[f.out]);
  expect(f.queue.hasPending("codex",f.a)).toBe(true);
  const db=(f.queue as unknown as {db:Database}).db;
  const pending=db.query("SELECT revision FROM pending WHERE path=?").get(f.a) as {revision:number};
  expect(pending.revision).toBeGreaterThan(f.row.revision);
});

test("an archive output lost before import wakes its original without losing pending import work",()=>{
  const f=fixture();f.queue.checkpointMirroredSource(f.row,[f.out]);fs.unlinkSync(f.out);
  f.close(f.queue);const queue=f.open();
  expect(queue.take("codex",f.roots).some(row=>row.path===f.out&&row.fingerprint==="missing")).toBe(true);
  expect(queue.hasPending("codex",f.a)).toBe(true);
  expect(queue.take("codex",f.roots).some(row=>row.path===f.a&&row.kind==="source")).toBe(true);
});

test("a supported codec sibling retains the original checkpoint instead of waking it again",()=>{
  const f=fixture();f.queue.checkpointMirroredSource(f.row,[f.out]);
  fs.writeFileSync(f.out+".zst",Bun.zstdCompressSync(fs.readFileSync(f.out)));fs.unlinkSync(f.out);
  f.queue.take("codex",f.roots);
  expect(f.queue.hasPending("codex",f.a)).toBe(false);
});

test("archive-only recovery defers access to originals until a source-collecting run",()=>{
  const f=fixture();f.queue.checkpointMirroredSource(f.row,[f.out]);fs.unlinkSync(f.out);
  f.queue.take("codex",f.roots.filter(root=>root.kind==="archive"));
  expect(f.queue.hasPending("codex",f.a)).toBe(false);
  expect(f.queue.hasPending("codex",f.out)).toBe(true);
  f.queue.take("codex",f.roots);
  expect(f.queue.hasPending("codex",f.a)).toBe(true);
});

test("a missing or external output cannot acknowledge an original",()=>{
  const f=fixture();
  expect(()=>f.queue.checkpointMirroredSource(f.row,[f.b])).toThrow("output is unavailable");
  fs.unlinkSync(f.out);
  expect(()=>f.queue.checkpointMirroredSource(f.row,[f.out])).toThrow("output is unavailable");
  expect(f.queue.hasPending("codex",f.a)).toBe(true);
});
