import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyFileToArchive, isMissingSourceError } from "./mirror";
import { ensureArchiveIdentity } from "./archive-inventory";
import { removeTestFixture } from "../test-cleanup";

test("mirror retries a destination that changes on its first inspection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mirror-retry-"));
  try {
    const source = path.join(root, "source.jsonl"), archive = path.join(root, "archive");
    fs.mkdirSync(archive); ensureArchiveIdentity(archive);
    const destination = path.join(archive, "claude/machine/session.jsonl");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(source, '{"first":1}\n{"second":2}\n');
    fs.writeFileSync(destination, '{"first":1}\n');
    const open = fs.openSync.bind(fs);
    let changed = false;
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === destination && !changed) {
        changed = true;
        fs.utimesSync(destination, new Date(), new Date("2026-01-01"));
      }
      return (open as Function)(file, ...args);
    }) as typeof fs.openSync);
    const result = { copied: 0, skipped: 0, warnings: [] as string[], errors: [] as string[] };
    try { copyFileToArchive(source, destination, result, archive); }
    finally { spy.mockRestore(); }
    expect(changed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.copied).toBe(1);
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(source));
  } finally { removeTestFixture(root, { recursive: true, force: true }); }
});
test("a persistently changing destination exhausts three attempts and preserves the accepted bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mirror-bounded-retry-"));
  try {
    const source = path.join(root, "source.jsonl"), archive = path.join(root, "archive");
    fs.mkdirSync(archive); ensureArchiveIdentity(archive);
    const destination = path.join(archive, "claude/machine/session.jsonl");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(source, '{"first":1}\n{"second":2}\n');
    const accepted = '{"first":1}\n';
    fs.writeFileSync(destination, accepted);
    const open = fs.openSync.bind(fs);
    let attempts = 0;
    const spy = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === destination) {
        attempts++;
        fs.utimesSync(destination, new Date(), new Date(Date.UTC(2026, 0, attempts)));
      }
      return (open as Function)(file, ...args);
    }) as typeof fs.openSync);
    const result = { copied: 0, skipped: 0, warnings: [] as string[], errors: [] as string[],
      failedFiles: undefined as string[] | undefined };
    try { copyFileToArchive(source, destination, result, archive); }
    finally { spy.mockRestore(); }
    expect(attempts).toBe(3);
    expect(result.copied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Archive destination changed while reading");
    expect(result.failedFiles).toEqual([source]);
    expect(fs.readFileSync(destination, "utf8")).toBe(accepted);
    const recovered = { copied: 0, skipped: 0, warnings: [] as string[], errors: [] as string[] };
    copyFileToArchive(source, destination, recovered, archive);
    expect(recovered.errors).toEqual([]);
    expect(recovered.copied).toBe(1);
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(source));
  } finally { removeTestFixture(root, { recursive: true, force: true }); }
});

test("append/no-op use one source; divergent rewrite remains archived with explicit error",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-mirror-"));
 try {
  const source=path.join(root,"source.jsonl"),archive=path.join(root,"archive");fs.mkdirSync(archive);ensureArchiveIdentity(archive);
  const destination=path.join(archive,"claude/machine/session.jsonl"),result={copied:0,skipped:0,warnings:[] as string[],errors:[] as string[]};
  fs.writeFileSync(source,'{}\n');copyFileToArchive(source,destination,result,archive);copyFileToArchive(source,destination,result,archive);
  fs.appendFileSync(source,'{"next":1}\n');copyFileToArchive(source,destination,result,archive);
  expect(result.copied).toBe(2);expect(result.skipped).toBe(1);expect(result.errors).toEqual([]);
  fs.writeFileSync(source,'{"rewrite":true}\n');copyFileToArchive(source,destination,result,archive);
  expect(result.errors[0]).toContain("Unresolved archive source conflict");expect(fs.readFileSync(destination,"utf8")).toBe('{}\n{"next":1}\n');
  expect(fs.existsSync(path.join(archive,".source-versions"))).toBe(false);expect(fs.readdirSync(path.dirname(destination)).filter(name=>name.includes(".conflict-")).length).toBe(1);
 } finally {removeTestFixture(root,{recursive:true,force:true});}
});
test("only missing optional source is a warning",()=>{
 expect(isMissingSourceError(Object.assign(new Error(),{code:"ENOENT"}))).toBe(true);
 expect(isMissingSourceError(Object.assign(new Error(),{code:"EACCES"}))).toBe(false);
});
test("Codex mirror visits each source/destination pair once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-codex-mirror-dedup-"));
  const users = path.join(root, "users");
  const home = path.join(users, "fixture");
  const archive = path.join(root, "archive");
  const config = path.join(root, "config");
  const state = path.join(root, "state");
  const sessions = path.join(home, ".codex", "sessions");
  const archived = path.join(home, ".codex", "archived_sessions");
  const ledger = path.join(home, ".codex", "delegate-ledger.jsonl");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  fs.mkdirSync(archive);
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[]}));
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(sessions, "live.jsonl"), '{}\n');
  fs.writeFileSync(path.join(archived, "old.jsonl"), '{}\n');
  fs.writeFileSync(ledger, '{}\n');
  const modulePath = path.resolve(import.meta.dir, "mirror.ts");
  const archivePublicationPath = path.resolve(import.meta.dir, "archive-publication.ts");
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const script = [
    'import { mock } from "bun:test";',
    'import fs from "node:fs";',
    `const actual=await import(${JSON.stringify(archivePublicationPath)});const calls=[];let failDestination=null;mock.module(${JSON.stringify(archivePublicationPath)},()=>({...actual,publishArchiveFile:(source,destination)=>{calls.push({source:String(source),destination:String(destination)});if(destination===failDestination)throw new Error("publication failed");return "copied";}}));`,
    `const {mirrorVendorSources}=await import(${JSON.stringify(modulePath)});`,
    // The phase counter: files handled so far, against the queued batch size when there is one.
    `const progress=[],queued=[];const result=await mirrorVendorSources("codex",${JSON.stringify(repoRoot)},"incremental",undefined,(done,total)=>progress.push([done,total]));`,
    `const copies=[...calls];await mirrorVendorSources("codex",${JSON.stringify(repoRoot)},"incremental",[${JSON.stringify(path.join(sessions, "live.jsonl"))}],(done,total)=>queued.push([done,total]));`,
    `const completed=[],partial=[];await mirrorVendorSources("codex",${JSON.stringify(repoRoot)},"incremental",[${JSON.stringify(ledger)}],undefined,(source,archives)=>completed.push({source,archives}));`,
    `failDestination=${JSON.stringify(path.join(archive, "codex", "FIXTURE-fixture", "delegate-ledger.jsonl"))};const failed=await mirrorVendorSources("codex",${JSON.stringify(repoRoot)},"incremental",[${JSON.stringify(ledger)}],undefined,(source,archives)=>partial.push({source,archives}));`,
    `failDestination=null;const checkpointFailed=await mirrorVendorSources("codex",${JSON.stringify(repoRoot)},"incremental",[${JSON.stringify(ledger)}],undefined,()=>{throw new Error("checkpoint failed");});`,
    'console.log(JSON.stringify({result,calls:copies,progress,queued,completed,partial,failed,checkpointFailed}));',
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TOKENATLAS_ARCHIVE: archive,
      TOKENATLAS_CONFIG: config,
      TOKENATLAS_LOCAL_STATE: state,
      TOKENATLAS_MACHINE: "FIXTURE",
      TOKENATLAS_LOGIN: "fixture",
      USERPROFILE: home,
      HOME: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(stdout.trim()) as { result: unknown; calls: Array<{ source: string; destination: string }>;
      progress: Array<[number, number | null]>; queued: Array<[number, number | null]>;
      completed: Array<{source:string;archives:string[]}>; partial: unknown[];
      failed: {errors:string[];failedFiles:string[]}; checkpointFailed: {errors:string[];failedFiles:string[]} };
    expect(result.progress).toEqual([[1, null], [2, null], [3, null], [4, null]]);
    expect(result.queued).toContainEqual([1, 1]);
    expect(result.result).toMatchObject({ copied: 4, skipped: 0, warnings: [], errors: [] });
    expect(result.calls).toEqual([
      { source: path.join(sessions, "live.jsonl"), destination: path.join(archive, "codex", "FIXTURE-fixture", "sessions", "live.jsonl") },
      { source: path.join(archived, "old.jsonl"), destination: path.join(archive, "codex", "FIXTURE-fixture", "archived_sessions", "old.jsonl") },
      { source: ledger, destination: path.join(archive, "codex", "FIXTURE-fixture", "delegate-ledger.jsonl") },
      { source: ledger, destination: path.join(archive, "codex", "_ledger", "delegate-ledger.jsonl") },
    ]);
    expect(result.completed).toEqual([{source:ledger,archives:[
      path.join(archive,"codex","FIXTURE-fixture","delegate-ledger.jsonl"),
      path.join(archive,"codex","_ledger","delegate-ledger.jsonl"),
    ]}]);
    expect(result.partial).toEqual([]);
    expect(result.failed.failedFiles).toEqual([ledger]);
    expect(result.failed.errors).toHaveLength(1);
    expect(result.checkpointFailed.failedFiles).toEqual([ledger]);
    expect(result.checkpointFailed.errors).toHaveLength(1);
  } finally {
    await child.exited;
    removeTestFixture(root, { recursive: true, force: true });
  }
});

test("a divergence already on record is reported every pass without failing the copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mirror-"));
  try {
    const source = path.join(root, "source.jsonl"), archive = path.join(root, "archive");
    fs.mkdirSync(archive); ensureArchiveIdentity(archive);
    const destination = path.join(archive, "claude/machine/session.jsonl");
    const pass = () => {
      const result = { copied: 0, skipped: 0, warnings: [] as string[], errors: [] as string[],
        failedFiles: undefined as string[] | undefined };
      copyFileToArchive(source, destination, result, archive);
      return result;
    };
    fs.writeFileSync(source, '{"first":1}\n');
    expect(pass().copied).toBe(1);
    const accepted = fs.readFileSync(destination, "utf8");
    fs.writeFileSync(source, '{"rewrite":true}\n');
    const raised = pass();
    expect(raised.errors[0]).toContain("Unresolved archive source conflict");
    expect(raised.failedFiles).toEqual([source]);
    // The same bytes are a decision already recorded: reported, never a failure.
    for (let index = 0; index < 2; index++) {
      const repeated = pass();
      expect(repeated.errors).toEqual([]);
      expect(repeated.failedFiles).toBeUndefined();
      expect(repeated.warnings).toEqual([`${source}: source diverges from the accepted archive; kept as evidence`]);
      expect(repeated.skipped).toBe(1);
    }
    expect(fs.readFileSync(destination, "utf8")).toBe(accepted);
    // A further divergence is a new state and is raised again.
    fs.appendFileSync(source, '{"more":1}\n');
    expect(pass().errors[0]).toContain("Unresolved archive source conflict");
    expect(fs.readFileSync(destination, "utf8")).toBe(accepted);
  } finally { removeTestFixture(root, { recursive: true, force: true }); }
});
