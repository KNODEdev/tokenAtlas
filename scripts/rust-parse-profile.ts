// Read-only profiling of the same pure producers used by ParsePool; no DB or archive writes.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ParsePool, nativeParserBinary, parseWorkerCount } from "../src/ingest/parse-pool";
interface Input { file: string; size: number; mtime: string }
const args=process.argv.slice(2);
function option(key: string, fallback?: string): string | undefined { const i=args.indexOf(key); return i<0?fallback:args[i+1]; }
const manifest=path.resolve(option("--manifest") ?? (()=>{throw new Error("--manifest PATH required");})());
const workers=Number(option("--workers",String(parseWorkerCount()))), window=Number(option("--window","0"));
if (!Number.isInteger(workers)||workers<1||workers>256||!Number.isInteger(window)||window!==0&&window<workers) throw new Error("invalid workers/window");
const binary=path.resolve(option("--binary",nativeParserBinary())!);
if (args.includes("--capture")) {
  const {archive,archiveProfiles}=await import("../src/config/paths");
  const {iterRollouts}=await import("../src/ingest/codex");
  const files=archiveProfiles("codex").filter(p=>p!=="_ledger").flatMap(p=>[...iterRollouts(archive("codex",p))]);
  const inputs=files.map(file=>{const s=fs.statSync(file,{bigint:true});return {file,size:Number(s.size),mtime:String(s.mtimeNs)};});
  fs.writeFileSync(manifest,JSON.stringify(inputs));
}
const inputs=JSON.parse(fs.readFileSync(manifest,"utf8")) as Input[];
function verify() { for (const input of inputs) { const s=fs.statSync(input.file,{bigint:true}); if (Number(s.size)!==input.size||String(s.mtimeNs)!==input.mtime) throw new Error("Changed input: "+input.file); } }
verify();
console.log(JSON.stringify({entryPoint:"ParsePool.run('codex') / codex::prepare", mode:"read-only, no DB",
  files:inputs.length,sourceBytes:inputs.reduce((s,i)=>s+i.size,0),workers,availableCores:os.availableParallelism(),window,
  includes:"read, SHA-256, parse, reconciliation and preparation; summed worker elapsed times overlap and include IO; pipe write is blocked syscall time; clone delivery includes send and receive",
  excludes:"manifest/discovery/stability stat, DB, archive writes, correctness hashing, GC of previous phases; no result-shape reconstruction for JSON (already final rows)"}));
async function standalone(threads:number,serialize:boolean) {
  const proc=Bun.spawn([binary,"--bench",manifest,String(threads),serialize?"serialize":"parse"],{stdout:"pipe",stderr:"inherit",windowsHide:true});
  const output=await new Response(proc.stdout).text();
  if (await proc.exited!==0) throw new Error("standalone native benchmark failed");
  const value=JSON.parse(output);
  console.log(JSON.stringify({phase:serialize?"native serialization":"native parse only",...value}));
  verify();
}
async function phase() {
  Bun.gc(true);
  const pool=new ParsePool(workers,{binary,profile:true});
  let events=0,limits=0;
  const start=performance.now();
  try {
    const lookahead=window || pool.prefetchWindow;
    // The application consumes an ordered bounded lookahead, rather than stopping
    // every lane at fixed eight-file barriers.
    const work=new Map<number,ReturnType<typeof pool.run<"codex">>>();
    let next=0;
    const fill=()=> {
      while(next<inputs.length && work.size<lookahead) {
        const index=next++, input=inputs[index]!;
        const pending=pool.run("codex",{file:input.file,size:input.size});
        pending.catch(()=>undefined);
        work.set(index,pending);
      }
    };
    fill();
    for (let i=0;i<inputs.length;i++) {
      const v=await work.get(i)!; work.delete(i); fill();
      if (v.kind!=="ok") throw new Error(v.message);
      events+=v.parse.events.length;limits+=v.parse.rateLimits.length;
      if((i+1)%1000===0) console.log("Rust"+": "+(i+1)+"/"+inputs.length);
    }
    const seconds=(performance.now()-start)/1000;
    const backend=await pool.profileSnapshot();
    console.log(JSON.stringify({phase:"Rust IPC",seconds,lookahead,events,limits,backend,bun:pool.timings}));
  } finally { await pool.close(); }
  verify();
}
if (!args.includes("--pool-only")) {
  if (!args.includes("--skip-single-thread")) await standalone(1,false);
  await standalone(workers,false);
  await standalone(workers,true);
}
if (!args.includes("--standalone-only")) { await phase(); if (args.includes("--repeat-native")) await phase(); }
