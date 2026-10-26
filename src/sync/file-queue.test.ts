import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {fingerprint} from "./file-fingerprint";
import { SyncFileQueue, acceptedArchiveFingerprint, type SyncFileRoot, type SyncFileQueueOptions } from "./file-queue";
import type { Database } from "../db/sqlite";
import { mirrorInputFailed } from "./coordinator";

const directories:string[]=[];
const queues=new Set<SyncFileQueue>();
afterEach(()=>{
  for(const queue of queues)queue.close();queues.clear();
  for(const directory of directories.splice(0)) {
    if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith("ta-file-queue-"))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ta-file-queue-"));directories.push(directory);
  const archive=path.join(directory,"archive"),source=path.join(directory,"source"),state=path.join(directory,"state");
  fs.mkdirSync(archive);fs.mkdirSync(source);
  const roots:SyncFileRoot[]=[{path:source,vendor:"claude",kind:"source"},{path:archive,vendor:"claude",kind:"archive"}];
  const open=(options?:SyncFileQueueOptions)=>{const queue=new SyncFileQueue(archive,state,options);queues.add(queue);return queue;};
  return {directory,archive,source,roots,open};
}
function close(queue:SyncFileQueue){queue.close();queues.delete(queue);}

test("pending revision planning is read-only, scoped and retains unverified hints",()=>{
  const f=fixture(),queue=f.open();
  const source=path.join(f.source,"new.jsonl"),archived=path.join(f.archive,"remote.jsonl");
  fs.writeFileSync(source,"local");fs.writeFileSync(archived,"remote");
  queue.enqueue(source,"claude");
  const sourceRevision=queue.pendingRevision("claude",f.roots)!;
  queue.enqueue(archived,"claude");
  const archiveRevision=queue.pendingRevision("claude",f.roots.filter(root=>root.kind==="archive"))!;
  const opened=spyOn(fs,"openSync");
  try {
    expect(queue.pendingRevision("claude",f.roots)).toBe(archiveRevision);
    expect(queue.pendingRevision("claude",f.roots.filter(root=>root.kind==="source"))).toBe(sourceRevision);
    expect(queue.pendingRevision("codex",f.roots)).toBeNull();
    expect(queue.pendingRevision("claude",[])).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  }finally{opened.mockRestore();}
  expect(queue.hasPending("claude",source)).toBe(true);
  expect(queue.hasPending("claude",archived)).toBe(true);
  fs.unlinkSync(archived);
  expect(queue.pendingRevision("claude",f.roots)).toBe(archiveRevision);
  const rows=queue.take("claude",f.roots.filter(root=>root.kind==="archive"));
  expect(rows.map(row=>row.fingerprint)).toEqual(["missing"]);
  expect(queue.hasPending("claude",source)).toBe(true);
});

test("a deferred first-fill witness resolves to the queue's exact SHA and still verifies changed bytes",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.archive,"first.jsonl");
  const bytes='{"tokens":1}\n';fs.writeFileSync(file,bytes);queue.prepare(f.roots);
  const [pending]=queue.take("claude",f.roots,()=>true);
  expect(JSON.parse(pending!.fingerprint)[1]).toBeNull();
  const sha=createHash("sha256").update(bytes).digest("hex");
  const proof=queue.resolveParsedFingerprint(pending!,sha,Buffer.byteLength(bytes));
  expect(proof.fingerprint).toBe(fingerprint(file));
  expect(()=>queue.resolveParsedFingerprint(pending!,sha,0)).toThrow("identity changed");
  const stat=fs.statSync(file);
  fs.writeFileSync(file,'{"tokens":2}\n');fs.utimesSync(file,stat.atime,stat.mtime);
  queue.acknowledge([proof]);expect(queue.hasPending("claude",file)).toBe(true);
  const [changed]=queue.take("claude",f.roots);expect(changed!.fingerprint).not.toBe(proof.fingerprint);
  queue.acknowledge([changed!]);expect(queue.take("claude",f.roots)).toEqual([]);
});

test("a file a first import accepted by its listed stamp is not read again when queued unchanged, only when it changed",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.archive,"stamped.db");
  fs.writeFileSync(file,"conversation");queue.prepare(f.roots);
  // A provider without parser digests keeps the listed stamp as its witness (no digest).
  const [witness]=queue.take("claude",f.roots,()=>true);
  expect(JSON.parse(witness!.fingerprint)[1]).toBeNull();
  expect(queue.acknowledge([witness!])).toEqual([]);
  // A watcher event for it without a content change (an importer opening it updates its access time) queues nothing.
  queue.signal(file,f.roots);expect(queue.hasPending("claude",file)).toBe(false);
  // Queued again without a change (a rescan): the same stamp is the same file.
  queue.enqueue(file,"claude");
  expect(queue.take("claude",f.roots)).toEqual([]);
  expect(queue.hasPending("claude",file)).toBe(false);
  // A content change is still read.
  fs.writeFileSync(file,"conversation, longer");queue.signal(file,f.roots);expect(queue.hasPending("claude",file)).toBe(true);
  queue.reconcileLater();queue.prepare(f.roots);
  const [changed]=queue.take("claude",f.roots);
  expect(changed?.path).toBe(path.resolve(file));expect(JSON.parse(changed!.fingerprint)[1]).toMatch(/^[a-f0-9]{64}$/);
});

test("a changed digest becomes a pending checkpoint instead of rejecting other accepted files",()=>{
  const f=fixture(),queue=f.open(),moving=path.join(f.archive,"moving.jsonl"),stable=path.join(f.archive,"stable.jsonl");
  fs.writeFileSync(moving,'{"tokens":1}\n');fs.writeFileSync(stable,'{"tokens":3}\n');queue.prepare(f.roots);
  const rows=queue.take("claude",f.roots),stamp=fs.statSync(moving);
  fs.writeFileSync(moving,'{"tokens":2}\n');fs.utimesSync(moving,stamp.atime,stamp.mtime);
  const failed=queue.acknowledge(rows);
  expect(failed).toEqual([{path:moving,error:"Error: Source digest changed before checkpoint; kept for retry"}]);
  expect(queue.hasPending("claude",moving)).toBe(true);expect(queue.hasPending("claude",stable)).toBe(false);
  expect(queue.acknowledge(queue.take("claude",f.roots))).toEqual([]);
});

test("a pending queue alone cannot prove ranged discovery before a watcher delivers a late file",()=>{
  const f=fixture(),queue=f.open();
  queue.prepare(f.roots,1000);
  const late=path.join(f.archive,"late-range.jsonl");
  fs.writeFileSync(late,'{"ts":"2026-08-28T12:00:00Z"}\n');
  // A recent reconciliation is not a filesystem snapshot; a watch event can still be in flight.
  queue.prepare(f.roots,1001);
  expect(queue.take("claude",f.roots)).toEqual([]);
  expect(fs.existsSync(late)).toBe(true);
  queue.signal(late,f.roots);
  expect(queue.take("claude",f.roots).map(row=>row.path)).toEqual([late]);
});

test("remote archive arrivals, failed publication and newer generations survive restart",()=>{
  const f=fixture();let queue=f.open();queue.prepare(f.roots,1000);
  const file=path.join(f.archive,"second-pc.jsonl");fs.writeFileSync(file,"one");queue.signal(file,f.roots);
  const old=queue.take("claude",f.roots);expect(old).toHaveLength(1);expect(old[0]!.kind).toBe("archive");
  close(queue);queue=f.open();expect(queue.take("claude",f.roots)).toEqual(old);
  queue.signal(file,f.roots);queue.acknowledge(old);
  const db=(queue as unknown as {db:Database}).db;
  expect((db.query("SELECT revision FROM pending").get() as {revision:number}).revision).toBeGreaterThan(old[0]!.revision);
  expect(queue.take("claude",f.roots)).toEqual([]);
  fs.writeFileSync(file,"two");queue.signal(file,f.roots);const newer=queue.take("claude",f.roots);
  fs.writeFileSync(file,"three");queue.acknowledge(newer);
  const retry=queue.take("claude",f.roots);expect(retry).toHaveLength(1);expect(retry[0]!.revision).toBeGreaterThan(newer[0]!.revision);
  queue.acknowledge(retry);close(queue);queue=f.open();expect(queue.take("claude",f.roots)).toEqual([]);
});

test("ordinary cycles do not scan or read unselected content; same-content touches only save metadata",()=>{
  const f=fixture(),queue=f.open();
  const a=path.join(f.source,"a.jsonl"),b=path.join(f.source,"b.jsonl");fs.writeFileSync(a,"a");fs.writeFileSync(b,"b");
  queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  const scan=spyOn(fs,"readdirSync").mockImplementation(()=>{throw new Error("Unexpected directory scan");});
  const read=spyOn(fs,"openSync");
  try {
    queue.prepare(f.roots,2000);expect(queue.take("claude",f.roots)).toEqual([]);expect(read).not.toHaveBeenCalled();
    fs.utimesSync(a,new Date(),new Date(Date.now()+10000));queue.signal(a,f.roots);
    expect(queue.take("claude",f.roots)).toEqual([]);
    expect(read.mock.calls.map(call=>String(call[0]))).toEqual([a]);
  } finally {read.mockRestore();scan.mockRestore();}
  const readAgain=spyOn(fs,"openSync");
  try {queue.reconcileLater();queue.prepare(f.roots,3000);expect(queue.take("claude",f.roots)).toEqual([]);expect(readAgain).not.toHaveBeenCalled();}
  finally{readAgain.mockRestore();}
});

test("an archive observation cannot acknowledge a pending watcher generation",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.archive,"observed.jsonl");fs.writeFileSync(file,"accepted");
  const observed=queue.observe(file,"claude");queue.signal(file,f.roots);queue.acknowledge([observed]);
  const db=(queue as unknown as {db:Database}).db;
  expect((db.query("SELECT revision FROM pending").get() as {revision:number}).revision).toBeGreaterThan(0);
  const hash=spyOn(fs,"openSync");
  try {expect(queue.take("claude",f.roots)).toEqual([]);expect(hash).toHaveBeenCalled();}finally{hash.mockRestore();}
});

test("archive-only selection retains pending original sources until they are copied",()=>{
  const f=fixture(),queue=f.open(),source=path.join(f.source,"local.jsonl"),archived=path.join(f.archive,"remote.jsonl");
  fs.writeFileSync(source,"local");fs.writeFileSync(archived,"remote");queue.signal(source,f.roots);queue.signal(archived,f.roots);
  const selected=queue.take("claude",f.roots.filter(root=>root.kind==="archive"));
  expect(selected.map(row=>row.path)).toEqual([archived]);queue.acknowledge(selected);
  expect(queue.take("claude",f.roots).map(row=>row.path)).toEqual([source]);
});

test("a new Atlas index requeues previously accepted archive bytes once without losing original collection work",()=>{
  const f=fixture(),archived=path.join(f.archive,"history.jsonl"),source=path.join(f.source,"pending.jsonl");
  fs.writeFileSync(archived,"history");fs.writeFileSync(source,"new");
  let queue=f.open();queue.prepare(f.roots,1000);
  queue.acknowledge(queue.take("claude",f.roots.filter(root=>root.kind==="archive")));
  const proof=acceptedArchiveFingerprint(f.archive,archived,path.join(f.directory,"state"));
  expect(proof).toBeTruthy();
  close(queue);queue=f.open();
  const archiveRoots=f.roots.filter(root=>root.kind==="archive");
  queue.revisitAcceptedForTask("bootstrap:database-b",archiveRoots,()=>true);
  expect(acceptedArchiveFingerprint(f.archive,archived,path.join(f.directory,"state"))).toBe(proof);
  const recovery=queue.take("claude",archiveRoots);
  expect(recovery.map(row=>row.path)).toEqual([archived]);
  queue.acknowledge(recovery);
  queue.revisitAcceptedForTask("bootstrap:database-b",archiveRoots,()=>true);
  expect(queue.take("claude",archiveRoots)).toEqual([]);
  expect(queue.take("claude",f.roots.filter(root=>root.kind==="source")).map(row=>row.path)).toEqual([source]);
});

test("failed base database publication keeps an unchanged WAL-only source queued for retry",()=>{
  const f=fixture(),roots:SyncFileRoot[]=[{path:f.source,vendor:"opencode",kind:"source"},{path:f.archive,vendor:"opencode",kind:"archive"}];
  const base=path.join(f.source,"opencode.db"),wal=`${base}-wal`;
  fs.writeFileSync(base,"base");fs.writeFileSync(wal,"pending WAL");
  let queue=f.open();queue.prepare(roots,1000);
  queue.acknowledge(queue.take("opencode",roots).filter(row=>row.path===base));
  const first=queue.take("opencode",roots);
  expect(first.map(row=>row.path)).toEqual([wal]);
  const failed=new Set([process.platform==="win32"?path.resolve(base).toLowerCase():path.resolve(base)]);
  queue.acknowledge(first.filter(row=>!mirrorInputFailed(row.path,failed)));
  close(queue);queue=f.open();
  const retry=queue.take("opencode",roots);
  expect(retry.map(row=>row.path)).toEqual([wal]);
  queue.acknowledge(retry.filter(row=>!mirrorInputFailed(row.path,new Set())));
  expect(queue.take("opencode",roots)).toEqual([]);
});

test("a recorded missing observation is not proof of accepted archive bytes",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.archive,"never-published.jsonl");
  queue.acknowledge([queue.observe(file,"claude")]);
  expect(acceptedArchiveFingerprint(f.archive,file,path.join(f.directory,"state"))).toBeNull();
});

test("reconciliation batches writes without holding transactions during filesystem discovery",()=>{
  const f=fixture(),queue=f.open(),db=(queue as unknown as {db:Database}).db;
  for(let i=0;i<1025;i++)fs.writeFileSync(path.join(f.source,`${i}.jsonl`),"a");
  const transaction=spyOn(db,"transaction"),original=fs.lstatSync;
  const stat=spyOn(fs,"lstatSync").mockImplementation(((...args:Parameters<typeof fs.lstatSync>)=>{
    expect(db.inTransaction).toBe(false);return Reflect.apply(original,fs,args);
  }) as typeof fs.lstatSync);
  const content=spyOn(fs,"openSync");
  try {
    queue.prepare(f.roots,1000);
    expect(transaction.mock.calls.length).toBe(4);
    expect((db.query("SELECT COUNT(*) n FROM pending").get() as {n:number}).n).toBe(1025);
    expect(content).not.toHaveBeenCalled();
  } finally {content.mockRestore();stat.mockRestore();transaction.mockRestore();}
});

test("lost notifications and directory signals reconcile; scan failures preserve retry requests",()=>{
  const f=fixture();let queue=f.open();queue.prepare(f.roots,1000);
  fs.writeFileSync(path.join(f.source,"lost.jsonl"),"lost");close(queue);queue=f.open();
  queue.reconcileLater();
  const scan=spyOn(fs,"readdirSync").mockImplementation(()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});});
  try {
    expect(()=>queue.prepare(f.roots,2000)).not.toThrow();
    expect(queue.reconciliationFailures("claude").map(row=>row.error)).toEqual(["denied","denied"]);
  }finally{scan.mockRestore();}
  queue.prepare(f.roots,2001);queue.acknowledge(queue.take("claude",f.roots));
  const nested=path.join(f.source,"nested");fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,"new.jsonl"),"new");
  queue.signal(nested,f.roots);expect(queue.take("claude",f.roots)).toEqual([]);
  queue.prepare(f.roots,3000);expect(queue.take("claude",f.roots).map(row=>path.basename(row.path))).toEqual(["new.jsonl"]);
  queue.acknowledge(queue.take("claude",f.roots));
  fs.writeFileSync(path.join(f.archive,"periodic.jsonl"),"remote");queue.prepare(f.roots,3603001);
  expect(queue.take("claude",f.roots).map(row=>path.basename(row.path))).toEqual(["periodic.jsonl"]);
});

test("conflict files, temporary files and junctions never become import work",()=>{
  const f=fixture(),queue=f.open();
  const external=path.join(f.directory,"outside");fs.mkdirSync(external);fs.writeFileSync(path.join(external,"secret.jsonl"),"outside");
  const link=path.join(f.source,"junction");fs.symlinkSync(external,link,process.platform==="win32"?"junction":"dir");
  for(const name of [`a.conflict-${"a".repeat(64)}.jsonl`,"a.jsonl.tmp-test"]) {
    const file=path.join(f.source,name);fs.writeFileSync(file,"ignore");queue.signal(file,f.roots);queue.enqueue(file,"claude");
  }
  queue.signal(link,f.roots);queue.signal(path.join(link,"secret.jsonl"),f.roots);
  queue.prepare(f.roots,1000);expect(queue.take("claude",f.roots)).toEqual([]);
  expect(queue.reconciliationFailures("claude")).toHaveLength(1);
  expect(queue.takeFailures("claude")).toHaveLength(2);
  expect(queue.takeFailures("claude").map(row=>row.path).sort()).toEqual([link,path.join(link,"secret.jsonl")].sort());
});

test("a source deletion is durable missing work and mutations during hashing remain pending",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.source,"input.jsonl");fs.writeFileSync(file,"before");queue.signal(file,f.roots);
  const original=fs.readSync;let changed=false;
  const read=spyOn(fs,"readSync").mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
    const size=Reflect.apply(original,fs,args);if(!changed){changed=true;fs.writeFileSync(file,"changed while hashing");}return size;
  }) as typeof fs.readSync);
  try {
    expect(queue.take("claude",f.roots)).toEqual([]);
    expect(queue.takeFailures("claude")[0]?.error).toContain("changed during verification");
  }finally{read.mockRestore();}
  queue.acknowledge(queue.take("claude",f.roots));fs.unlinkSync(file);queue.signal(file,f.roots);
  expect(queue.takeFailures("claude")).toEqual([]);
  const removed=queue.take("claude",f.roots);expect(removed[0]!.fingerprint).toBe("missing");queue.acknowledge(removed);
  queue.reconcileLater();queue.prepare(f.roots,1000);expect(queue.take("claude",f.roots)).toEqual([]);
});

test("one unreadable queued file does not block same-vendor peers or another vendor",()=>{
  const f=fixture();let queue=f.open();
  const bad=path.join(f.source,"bad.jsonl"),good=path.join(f.source,"good.jsonl"),remote=path.join(f.archive,"remote.jsonl");
  for(const file of [bad,good,remote])fs.writeFileSync(file,"content");
  const roots:SyncFileRoot[]=[f.roots[0]!,{...f.roots[1]!,vendor:"codex"}];
  for(const file of [bad,good,remote])queue.signal(file,roots);
  const original=fs.openSync;
  const read=spyOn(fs,"openSync").mockImplementation(((file:any,...args:any[])=>{
    if(String(file)===bad)throw Object.assign(new Error("unreadable file"),{code:"EACCES"});
    return Reflect.apply(original,fs,[file,...args]);
  }) as typeof fs.openSync);
  try {
    const selected=queue.take("claude",roots);expect(selected.map(row=>row.path)).toEqual([good]);queue.acknowledge(selected);
    expect(queue.takeFailures("claude")).toEqual([{path:bad,error:"unreadable file"}]);
    const other=queue.take("codex",roots);expect(other.map(row=>row.path)).toEqual([remote]);queue.acknowledge(other);
    expect(queue.takeFailures("codex")).toEqual([]);
    expect(queue.takeFailures("claude")).toHaveLength(1);
  } finally {read.mockRestore();}
  close(queue);queue=f.open();
  const retry=queue.take("claude",roots);expect(retry.map(row=>row.path)).toEqual([bad]);
  expect(queue.takeFailures("claude")).toEqual([]);queue.acknowledge(retry);
  expect(queue.take("claude",roots)).toEqual([]);
});

test("inaccessible reconciliation subtrees retain their work and allow peer imports before retry",()=>{
  const f=fixture();let queue=f.open();
  const blocked=path.join(f.source,"blocked"),known=path.join(blocked,"known.jsonl");fs.mkdirSync(blocked);fs.writeFileSync(known,"old");
  const roots:SyncFileRoot[]=[f.roots[0]!,{...f.roots[1]!,vendor:"codex"}];
  queue.prepare(roots,1000);queue.acknowledge(queue.take("claude",roots));
  const good=path.join(f.source,"good.jsonl"),remote=path.join(f.archive,"remote.jsonl");fs.writeFileSync(good,"good");fs.writeFileSync(remote,"remote");
  queue.reconcileLater();const original=fs.readdirSync;
  const scan=spyOn(fs,"readdirSync").mockImplementation(((file:any,...args:any[])=>{
    if(String(file)===blocked)throw Object.assign(new Error("unavailable subtree"),{code:"EACCES"});
    return Reflect.apply(original,fs,[file,...args]);
  }) as typeof fs.readdirSync);
  try {
    queue.prepare(roots,2000);
    expect(queue.reconciliationFailures("claude")).toEqual([{path:blocked,error:"unavailable subtree"}]);
    expect(queue.reconciliationFailures("codex")).toEqual([]);
    const selected=queue.take("claude",roots);expect(selected.map(row=>row.path)).toEqual([good]);queue.acknowledge(selected);
    const other=queue.take("codex",roots);expect(other.map(row=>row.path)).toEqual([remote]);queue.acknowledge(other);
    // The root with the unlisted folder stays due; the peer root answered the request.
    const db=(queue as unknown as {db:Database}).db;
    const state=db.query("SELECT key,value FROM state WHERE key LIKE 'root:%'").all() as Array<{key:string;value:string}>;
    expect(state.find(row=>row.key.endsWith("|claude|source"))?.value).toBe("0|1000");
    expect(state.find(row=>row.key.endsWith("|codex|archive"))?.value).toBe("1|2000");
  } finally {scan.mockRestore();}
  fs.unlinkSync(known);close(queue);queue=f.open();queue.prepare(roots,2001);
  expect(queue.reconciliationFailures("claude")).toEqual([]);
  const missing=queue.take("claude",roots);expect(missing.map(row=>({path:row.path,fingerprint:row.fingerprint}))).toEqual([{path:known,fingerprint:"missing"}]);
});

test("metadata reconciliation interval is configurable with a positive value and defaults to one hour",()=>{
  for(const [minutes,interval] of [[2,120000],[0,3600000],[-1,3600000],[Number.NaN,3600000]]) {
    const f=fixture(),queue=f.open({reconcileMinutes:minutes});queue.prepare(f.roots,1000);
    const file=path.join(f.source,"lost.jsonl");fs.writeFileSync(file,"lost");
    queue.prepare(f.roots,1000+interval!-1);expect(queue.take("claude",f.roots)).toEqual([]);
    queue.prepare(f.roots,1000+interval!);expect(queue.take("claude",f.roots).map(row=>row.path)).toEqual([file]);
  }
});

test("an attribute touch is not a content change while a same-size rewrite still is",()=>{
  const f=fixture(),queue=f.open(),file=path.join(f.archive,"input.jsonl");
  fs.writeFileSync(file,"before");queue.signal(file,f.roots);
  queue.acknowledge(queue.take("claude",f.roots));
  // A cloud client updating attributes, pin state or hydration only moves ctime.
  let touched=false;
  const shift=(stat:fs.Stats)=>touched
    ? Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{ctimeMs:stat.ctimeMs+5000,ctime:new Date(stat.ctimeMs+5000)})
    : stat;
  const lstat=spyOn(fs,"lstatSync"),fstat=spyOn(fs,"fstatSync"),read=spyOn(fs,"readSync");
  const originalLstat=lstat.getMockImplementation()??fs.lstatSync,originalFstat=fstat.getMockImplementation()??fs.fstatSync;
  const originalRead=read.getMockImplementation()??fs.readSync;
  lstat.mockImplementation(((...args:Parameters<typeof fs.lstatSync>)=>shift(Reflect.apply(originalLstat,fs,args) as fs.Stats)) as typeof fs.lstatSync);
  fstat.mockImplementation(((...args:Parameters<typeof fs.fstatSync>)=>shift(Reflect.apply(originalFstat,fs,args) as fs.Stats)) as typeof fs.fstatSync);
  read.mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{touched=true;return Reflect.apply(originalRead,fs,args);}) as typeof fs.readSync);
  try {
    queue.signal(file,f.roots);
    expect(queue.takeFailures("claude")).toEqual([]);
    expect(queue.take("claude",f.roots)).toEqual([]);
    expect(queue.takeFailures("claude")).toEqual([]);
    // Nor does it make the reconciliation rehash an archive nobody wrote.
    queue.reconcileLater();queue.prepare(f.roots,2000);
    expect(queue.take("claude",f.roots)).toEqual([]);
    // Content that changes without growing is still work.
    fs.writeFileSync(file,"BEFORE");queue.reconcileLater();queue.prepare(f.roots,3000);
    const selected=queue.take("claude",f.roots);
    expect(selected.map(row=>row.path)).toEqual([file]);
    queue.acknowledge(selected);
  } finally {read.mockRestore();fstat.mockRestore();lstat.mockRestore();}
});

test("a link or unreadable entry finishes the reconciliation while an unlisted directory keeps it due",()=>{
  const f=fixture(),queue=f.open();
  const external=path.join(f.directory,"outside");fs.mkdirSync(external);
  const link=path.join(f.source,"junction");fs.symlinkSync(external,link,process.platform==="win32"?"junction":"dir");
  const blocked=path.join(f.source,"blocked");fs.mkdirSync(blocked);
  queue.prepare(f.roots,1000);
  expect(queue.reconciliationFailures("claude").map(row=>row.path)).toEqual([link]);
  // A permanent link report must not rewalk every root on the next cycle.
  const later=path.join(f.source,"later.jsonl");fs.writeFileSync(later,"later");
  queue.prepare(f.roots,2000);expect(queue.take("claude",f.roots)).toEqual([]);
  queue.prepare(f.roots,1000+3600001);
  expect(queue.take("claude",f.roots).map(row=>path.basename(row.path))).toEqual(["later.jsonl"]);
  queue.acknowledge(queue.take("claude",f.roots));
  // A directory that could not be listed hides its contents, so it stays due.
  const readdir=spyOn(fs,"readdirSync");
  const original=readdir.getMockImplementation()??fs.readdirSync;
  readdir.mockImplementation(((...args:Parameters<typeof fs.readdirSync>)=>{
    if(path.resolve(String(args[0]))===path.resolve(blocked))throw Object.assign(new Error("EACCES: permission denied"),{code:"EACCES"});
    return Reflect.apply(original,fs,args);
  }) as typeof fs.readdirSync);
  let unlisted:string[];
  try {
    queue.prepare(f.roots,1000+7200002);
    unlisted=queue.reconciliationFailures("claude").map(row=>row.path);
  } finally {readdir.mockRestore();}
  expect(unlisted).toContain(blocked);
  const hidden=path.join(f.source,"hidden.jsonl");fs.writeFileSync(hidden,"hidden");
  queue.prepare(f.roots,1000+7200003);
  expect(queue.take("claude",f.roots).map(row=>path.basename(row.path))).toEqual(["hidden.jsonl"]);
});

test("a pass reports how many files it has listed and selected",()=>{
  const f=fixture(),queue=f.open(),listed:Array<[number,number|null]>=[],selected:Array<[number,number|null]>=[];
  for(const name of ["one.jsonl","two.jsonl","three.jsonl"])fs.writeFileSync(path.join(f.source,name),name);
  queue.prepare(f.roots,1000,(done,total)=>listed.push([done,total]));
  expect(listed.at(-1)).toEqual([3,3]);
  expect(listed.slice(0,-1).every(([,total])=>total===null)).toBe(true);
  const taken=queue.take("claude",f.roots,false,(done,total)=>selected.push([done,total]));
  expect(taken).toHaveLength(3);expect(selected.at(-1)).toEqual([3,3]);
  queue.acknowledge(taken);
  // A second walk estimates its total from the last completed one.
  listed.length=0;fs.writeFileSync(path.join(f.source,"four.jsonl"),"four");
  queue.reconcileLater();queue.prepare(f.roots,2000,(done,total)=>listed.push([done,total]));
  expect(listed[0]).toEqual([1,3]);expect(listed.at(-1)).toEqual([4,4]);
});

test("a reconciliation over a large queue with many unreadable entries is linear and reports progress",()=>{
  const f=fixture(),queue=f.open(),db=(queue as unknown as {db:Database}).db;
  // Links are skipped and reported as unreadable: each one is a folder whose contents stay unknown.
  const target=path.join(f.directory,"target");fs.mkdirSync(target);
  for(let i=0;i<150;i++)fs.symlinkSync(target,path.join(f.source,`link-${i}`),process.platform==="win32"?"junction":"dir");
  const kept=path.join(f.source,"kept.jsonl");fs.writeFileSync(kept,"kept");
  // ~50k accepted files of other roots, as in the live queue; three of these roots' own.
  const other=path.join(f.directory,"other-archive"),stamp='[1,1,1,1,1]';
  const vanished=path.join(f.source,"vanished.jsonl"),hidden=path.join(f.source,"link-7","hidden.jsonl");
  db.transaction(()=>{
    const insert=db.query("INSERT INTO files VALUES(?,?,?,?,?)");
    for(let i=0;i<50000;i++){const file=path.join(other,`d${i%97}`,`s-${i}.jsonl`);insert.run(process.platform==="win32"?file.toLowerCase():file,file,"codex",stamp,"x");}
    for(const file of [vanished,hidden])insert.run(process.platform==="win32"?file.toLowerCase():file,file,"claude",stamp,"x");
  })();
  const progress:Array<[number,number|null]>=[];
  const started=performance.now();
  queue.prepare(f.roots,1000,(done,total)=>progress.push([done,total]));
  // Comparing every accepted file with every unreadable entry took ~90 s here.
  expect(performance.now()-started).toBeLessThan(5000);
  expect(queue.reconciliationFailures("claude")).toHaveLength(150);
  expect(progress.at(-1)).toEqual([1,1]);
  // A vanished file of a walked root is work; one below an unreadable entry and other roots' files are not.
  const pending=(db.query("SELECT path FROM pending").all() as Array<{path:string}>).map(row=>row.path).sort();
  expect(pending).toEqual([kept,vanished].sort());
},30_000);

test("a folder event walks only a folder the queue knows nothing below; other signals never rewalk every root",()=>{
  const f=fixture(),queue=f.open(),db=(queue as unknown as {db:Database}).db;
  const known=path.join(f.archive,"2026","10","06");fs.mkdirSync(known,{recursive:true});
  fs.writeFileSync(path.join(known,"a.jsonl"),"a");
  queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  const requests=()=>(db.query("SELECT value FROM state WHERE key='reconcile_request'").get() as {value:string}|null)?.value;
  const before=requests();
  // Writing a file reports the file, its folder and the folder's parents.
  const written=path.join(known,"b.jsonl");fs.writeFileSync(written,"b");
  for(const event of [written,known,path.dirname(known),f.archive])queue.signal(event,f.roots);
  // The shared configuration is watched too; its files are no queue input.
  queue.signal(path.join(f.directory,"config","accounts.json"),f.roots);
  expect(requests()).toBe(before);
  const listed:string[]=[],readdir=spyOn(fs,"readdirSync"),original=readdir.getMockImplementation()??fs.readdirSync;
  readdir.mockImplementation(((...args:Parameters<typeof fs.readdirSync>)=>{listed.push(path.resolve(String(args[0])));return Reflect.apply(original,fs,args);}) as typeof fs.readdirSync);
  try {
    queue.prepare(f.roots,2000);
    expect(listed).toEqual([]);
    const taken=queue.take("claude",f.roots);expect(taken.map(row=>row.path)).toEqual([written]);queue.acknowledge(taken);
    // A folder that arrives whole (moved in, or a new day of sessions) is walked alone.
    const fresh=path.join(f.archive,"2026","10","07");fs.mkdirSync(fresh);
    const arrived=path.join(fresh,"c.jsonl");fs.writeFileSync(arrived,"c");
    queue.signal(fresh,f.roots);expect(requests()).toBe(before);
    queue.prepare(f.roots,3000);
    expect(listed).toEqual([path.resolve(fresh)]);
  } finally {readdir.mockRestore();}
  expect(queue.take("claude",f.roots).map(row=>path.basename(row.path))).toEqual(["c.jsonl"]);
  // A lost notification still asks for a full walk.
  queue.signal(null,f.roots);expect(requests()).not.toBe(before);
});

test("a vanished archive copy wakes its original from one listing per folder, with progress",()=>{
  const f=fixture(),queue=f.open();
  const names=["one.jsonl","two.jsonl","three.jsonl"];
  for(const name of names){fs.writeFileSync(path.join(f.archive,name),name);fs.writeFileSync(path.join(f.source,name),name);}
  queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  fs.unlinkSync(path.join(f.archive,"two.jsonl"));
  const progress:Array<[number,number|null]>=[],exists=spyOn(fs,"existsSync");
  try {
    queue.requeueMissingArchiveSources(f.roots,(_vendor,file)=>path.join(f.source,path.basename(file)),(done,total)=>progress.push([done,total]));
    // Only the original of the vanished copy is asked about; the archive copies are not stated one by one.
    expect(exists.mock.calls.map(call=>path.basename(String(call[0])))).toEqual(["two.jsonl"]);
  } finally {exists.mockRestore();}
  expect(progress.at(-1)).toEqual([3,3]);
  expect(queue.take("claude",f.roots).map(row=>row.path)).toEqual([path.join(f.source,"two.jsonl")]);
});

for(const [vendor,relative] of [
  ["codex","codex/laptop/sessions/2026/10/14/history.jsonl"],
  ["claude","claude/laptop/project/history.jsonl"],
  ["grok","grok/laptop/sessions/project/session/updates.jsonl"],
] as const) {
  test(`${vendor}: a codec transition does not requeue unchanged originals after reconciliation or restart`,()=>{
    const f=fixture(),roots=f.roots.map(root=>({...root,vendor}));
    const source=path.join(f.source,path.basename(relative)),plain=path.join(f.archive,relative),compressed=`${plain}.zst`;
    const bytes='{"tokens":1}\n';
    fs.mkdirSync(path.dirname(plain),{recursive:true});fs.writeFileSync(source,bytes);fs.writeFileSync(plain,bytes);
    let queue=f.open();queue.prepare(roots,1000);queue.acknowledge(queue.take(vendor,roots));
    fs.writeFileSync(compressed,Bun.zstdCompressSync(Buffer.from(bytes)));fs.unlinkSync(plain);
    const original=spyOn({find:()=>source},"find"),opened=spyOn(fs,"openSync");
    try {
      // The old physical name remains known until the importer accepts its replacement.
      queue.requeueMissingArchiveSources(roots,original);
      expect(queue.take(vendor,roots.filter(root=>root.kind==="source"))).toEqual([]);
      expect(original).not.toHaveBeenCalled();expect(opened).not.toHaveBeenCalled();
    } finally {opened.mockRestore();original.mockRestore();}
    queue.reconcileLater();queue.prepare(roots,2000);
    const changedArchive=queue.take(vendor,roots);
    expect(changedArchive.map(row=>row.path).sort()).toEqual([plain,compressed].sort());
    queue.acknowledge(changedArchive);close(queue);queue=f.open();
    queue.requeueMissingArchiveSources(roots,()=>source);
    expect(queue.take(vendor,roots)).toEqual([]);
    // A real append still selects only the changed source.
    fs.appendFileSync(source,'{"tokens":2}\n');queue.signal(source,roots);
    expect(queue.take(vendor,roots).map(row=>row.path)).toEqual([source]);
  });
}

test("a vanished compressed name retains a plain sibling, but losing both wakes the original",()=>{
  const f=fixture(),plain=path.join(f.archive,"claude/laptop/project/history.jsonl"),compressed=`${plain}.zst`;
  const source=path.join(f.source,"history.jsonl"),bytes='{"tokens":1}\n';
  fs.mkdirSync(path.dirname(plain),{recursive:true});fs.writeFileSync(source,bytes);
  fs.writeFileSync(compressed,Bun.zstdCompressSync(Buffer.from(bytes)));
  const queue=f.open();queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  fs.writeFileSync(plain,bytes);fs.unlinkSync(compressed);
  queue.requeueMissingArchiveSources(f.roots,()=>source);
  expect(queue.take("claude",f.roots.filter(root=>root.kind==="source"))).toEqual([]);
  fs.unlinkSync(plain);queue.requeueMissingArchiveSources(f.roots,()=>source);
  expect(queue.take("claude",f.roots.filter(root=>root.kind==="source")).map(row=>row.path)).toEqual([source]);
});

test("a codec-like sibling outside the supported archive paths does not hide a missing copy",()=>{
  const f=fixture(),file=path.join(f.archive,"history.jsonl"),source=path.join(f.source,"history.jsonl");
  fs.writeFileSync(file,"history");fs.writeFileSync(source,"history");
  const queue=f.open();queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  fs.renameSync(file,`${file}.zst`);queue.requeueMissingArchiveSources(f.roots,()=>source);
  expect(queue.take("claude",f.roots.filter(root=>root.kind==="source")).map(row=>row.path)).toEqual([source]);
});

test("a directory with the codec sibling's name does not hide a missing archive file",()=>{
  const f=fixture(),plain=path.join(f.archive,"claude/laptop/project/history.jsonl"),source=path.join(f.source,"history.jsonl");
  fs.mkdirSync(path.dirname(plain),{recursive:true});fs.writeFileSync(plain,"history");fs.writeFileSync(source,"history");
  const queue=f.open();queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  fs.unlinkSync(plain);fs.mkdirSync(`${plain}.zst`);
  queue.requeueMissingArchiveSources(f.roots,()=>source);
  expect(queue.take("claude",f.roots.filter(root=>root.kind==="source")).map(row=>row.path)).toEqual([source]);
});

test("an unlistable archive folder checks both codec names without reading file content",()=>{
  const f=fixture(),plain=path.join(f.archive,"claude/laptop/project/history.jsonl"),source=path.join(f.source,"history.jsonl");
  fs.mkdirSync(path.dirname(plain),{recursive:true});fs.writeFileSync(plain,"history");fs.writeFileSync(source,"history");
  const queue=f.open();queue.prepare(f.roots,1000);queue.acknowledge(queue.take("claude",f.roots));
  fs.renameSync(plain,`${plain}.zst`);
  const list=spyOn(fs,"readdirSync").mockImplementation(()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});});
  const opened=spyOn(fs,"openSync");
  try {
    queue.requeueMissingArchiveSources(f.roots,()=>source);
    expect(queue.take("claude",f.roots.filter(root=>root.kind==="source"))).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  } finally {opened.mockRestore();list.mockRestore();}
});
