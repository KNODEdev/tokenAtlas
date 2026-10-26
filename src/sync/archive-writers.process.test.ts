import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ARCHIVE_WRITERS_DIRECTORY, acquireArchiveWriterFence, withArchiveWriter } from "./archive-writers";
import { ensureArchiveIdentity } from "./archive-inventory";
import { allocateLocalIdentity } from "../config/local-identity";

const directories: string[] = [];
const inheritedLocalState = process.env.TOKENATLAS_LOCAL_STATE;
afterEach(() => {
  for (const directory of directories.splice(0)) removeTestFixture(directory, { recursive: true, force: true });
  if (inheritedLocalState === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
  else process.env.TOKENATLAS_LOCAL_STATE = inheritedLocalState;
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-writer-process-"));
  directories.push(root);
  const archive = path.join(root, "archive");
  const localState = path.join(root, "local-state");
  fs.mkdirSync(archive);
  process.env.TOKENATLAS_LOCAL_STATE = localState;
  allocateLocalIdentity("archive-writer-process-test", "test", { machine: "fixture", profile: "fixture-test" });
  ensureArchiveIdentity(archive);
  return { root, archive, localState };
}
const moduleName = JSON.stringify(path.join(import.meta.dir, "archive-writers.ts"));
const setupModuleName = JSON.stringify(path.resolve(import.meta.dir, "../server/setup.ts"));
const apiModuleName = JSON.stringify(path.resolve(import.meta.dir, "../server/api.ts"));
function child(code: string, env: NodeJS.ProcessEnv = process.env) {
  return Bun.spawn([process.execPath, "-e", code], { env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

test("fenced rate-card save preserves both the file and active rules", async () => {
  const { root, archive, localState } = fixture();
  const config = path.join(archive, "config"), rates = path.join(config, "rate-cards.json");
  fs.mkdirSync(config);
  const original = { version: 2, currency: "USD", unit: "per 1M", vendors: { anthropic: { models: { fixture: { in_uncached: 1 } } } } };
  const bytes = JSON.stringify(original);
  fs.writeFileSync(rates, bytes);
  const fence = acquireArchiveWriterFence(archive, randomUUID());
  const worker = child(`import { handleRateCardsSave } from ${apiModuleName};
    const context = {rateCards:${bytes}};
    const response = await handleRateCardsSave(context,new Request('http://fixture/api/rate-cards',{
      method:'POST',body:JSON.stringify({vendor:'anthropic',model:'fixture',rates:{in_uncached:2}})}));
    console.log(JSON.stringify({status:response.status,rates:context.rateCards,body:await response.json()}));`,
    {...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:localState,TOKENATLAS_DB:path.join(root,"unused.sqlite")});
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(),new Response(worker.stderr).text(),worker.exited]);
    expect({exit,stderr}).toEqual({exit:0,stderr:""});
    const result = JSON.parse(stdout);
    expect(result.status).toBe(500);
    expect(result.rates).toEqual(original);
    expect(result.body.error).toContain("paused");
    expect(fs.readFileSync(rates,"utf8")).toBe(bytes);
  } finally {fence.release();worker.kill();await worker.exited;}
},60_000);
async function firstLine(process: ReturnType<typeof child>): Promise<string> {
  const reader = process.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let text = "";
        while (!text.includes("\n")) {
          const next = await reader.read();
          if (next.done) throw new Error(`Child exited before readiness: ${await new Response(process.stderr).text()}`);
          text += new TextDecoder().decode(next.value);
        }
        return text.trim();
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Child readiness timeout")), 30_000); }),
    ]);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}

test("a different process drains its last write before relocation can proceed", async () => {
  const { archive } = fixture();
  const worker = child(`import fs from 'node:fs'; import {withArchiveWriter} from ${moduleName};
    await withArchiveWriter(${JSON.stringify(archive)}, async () => {
      console.log('writing'); await Bun.stdin.text(); fs.writeFileSync(${JSON.stringify(path.join(archive, "tail.json"))}, 'retained');
    });`);
  try {
    expect(await firstLine(worker)).toBe("writing");
    const fence = acquireArchiveWriterFence(archive, randomUUID());
    expect(() => fence.assertDrained()).toThrow("writer still active");
    worker.stdin.end();
    expect(await worker.exited).toBe(0);
    fence.assertDrained();
    expect(fs.readFileSync(path.join(archive, "tail.json"), "utf8")).toBe("retained");
    fence.release();
  } finally { worker.kill(); await worker.exited; }
}, 60_000);

test("a crashed writer leaves a provably dead local lease that does not lose archived bytes", async () => {
  const { archive } = fixture();
  const worker = child(`import fs from 'node:fs'; import {withArchiveWriter} from ${moduleName};
    withArchiveWriter(${JSON.stringify(archive)}, () => {
      const fd = fs.openSync(${JSON.stringify(path.join(archive, "before-crash.json"))}, 'wx');
      fs.writeFileSync(fd, 'durable'); fs.fsyncSync(fd); process.exit(17);
    });`);
  try {
    expect(await worker.exited).toBe(17);
    const fence = acquireArchiveWriterFence(archive, randomUUID());
    fence.assertDrained();
    expect(fs.readFileSync(path.join(archive, "before-crash.json"), "utf8")).toBe("durable");
    fence.release();
  } finally { worker.kill(); await worker.exited; }
}, 60_000);

test("concurrent resumes of a crashed relocation acquire exactly one successor", async () => {
  const { archive } = fixture();
  const jobId = randomUUID();
  const abandoned = child(`import {acquireArchiveWriterFence} from ${moduleName};
    acquireArchiveWriterFence(${JSON.stringify(archive)}, ${JSON.stringify(jobId)}); process.exit(19);`);
  expect(await abandoned.exited).toBe(19);
  expect(() => withArchiveWriter(archive, () => {})).toThrow("paused");
  const code = `import {acquireArchiveWriterFence} from ${moduleName};
    let fence; try { fence = acquireArchiveWriterFence(${JSON.stringify(archive)}, ${JSON.stringify(jobId)}); }
    catch { console.log('blocked'); process.exit(0); }
    console.log('acquired'); await Bun.stdin.text(); fence.assertDrained(); fence.release();`;
  const workers = [child(code), child(code)];
  try {
    const results = await Promise.all(workers.map(firstLine));
    expect(results.toSorted()).toEqual(["acquired", "blocked"]);
    expect(() => withArchiveWriter(archive, () => {})).toThrow("paused");
    workers.forEach(worker => worker.stdin.end());
    expect(await Promise.all(workers.map(worker => worker.exited))).toEqual([0, 0]);
    let wrote = false;
    withArchiveWriter(archive, () => { wrote = true; });
    expect(wrote).toBe(true);
  } finally {
    workers.forEach(worker => worker.kill());
    await Promise.all(workers.map(worker => worker.exited));
  }
}, 60_000);

test("a delayed resume cannot claim the successor name freed by a released chain", async () => {
  const { root, archive } = fixture();
  const coordination = path.join(archive, ARCHIVE_WRITERS_DIRECTORY);
  const jobId = randomUUID();
  const abandoned = child(`import {acquireArchiveWriterFence} from ${moduleName};
    acquireArchiveWriterFence(${JSON.stringify(archive)}, ${JSON.stringify(jobId)}); process.exit(23);`);
  expect(await abandoned.exited).toBe(23);
  const dead = JSON.parse(fs.readFileSync(path.join(coordination, "barrier.json"), "utf8")) as { token: string };
  const successor = path.join(coordination, `resume-${dead.token}.json`);
  const gate = path.join(root, "delayed-resume-gate");
  // The contender parks inside its own publication, after it already chose the
  // successor name of the dead owner it observed.
  const delayed = child(`import fs from 'node:fs';
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (String(to).includes('resume-')) {
        console.log('delayed');
        const idle = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(idle, 0, 0, 10);
      }
      return link(from, to);
    };
    const {acquireArchiveWriterFence} = await import(${moduleName});
    try { acquireArchiveWriterFence(${JSON.stringify(archive)}, ${JSON.stringify(jobId)}); }
    catch (error) { console.log('refused: ' + error.message); process.exit(0); }
    console.log('acquired'); process.exit(1);`);
  try {
    expect(await firstLine(delayed)).toBe("delayed");
    const winner = acquireArchiveWriterFence(archive, jobId);
    expect(fs.existsSync(successor)).toBe(true);
    winner.assertDrained();
    winner.release();
    // The released chain leaves no record behind, so the name is free again.
    expect(fs.readdirSync(coordination).filter(name => name.endsWith(".json"))).toEqual([]);
    const fresh = acquireArchiveWriterFence(archive, randomUUID());
    const published = fs.readFileSync(path.join(coordination, "barrier.json"), "utf8");
    fs.writeFileSync(gate, "resume");
    expect(await firstLine(delayed)).toBe("refused: Archive relocation fence ownership changed");
    expect(await delayed.exited).toBe(0);
    expect(fs.readFileSync(path.join(coordination, "barrier.json"), "utf8")).toBe(published);
    expect(fs.existsSync(successor)).toBe(false);
    expect(() => withArchiveWriter(archive, () => {})).toThrow("paused");
    fresh.release();
    let wrote = false;
    withArchiveWriter(archive, () => { wrote = true; });
    expect(wrote).toBe(true);
  } finally { delayed.kill(); await delayed.exited; }
}, 60_000);


test("a fenced setup process cannot create the missing archive config directory", async () => {
  const { root, archive, localState } = fixture();
  const fence = acquireArchiveWriterFence(archive, randomUUID());
  const code = `import {saveSetup} from ${setupModuleName};
    try { saveSetup({subscriptions:[]}, {dbPath:${JSON.stringify(path.join(root, "atlas.sqlite"))}}); }
    catch (error) { console.log(error?.name); process.exit(0); }
    console.log('unexpected-success'); process.exit(1);`;
  const worker = child(code, {
    ...process.env,
    TOKENATLAS_ARCHIVE: archive,
    TOKENATLAS_CONFIG: path.join(archive, "config"),
    TOKENATLAS_LOCAL_STATE: localState,
  });
  try {
    const stdout = await new Response(worker.stdout).text();
    expect(await worker.exited).toBe(0);
    expect(stdout.trim()).toBe("ArchiveWritesPausedError");
    expect(fs.existsSync(path.join(archive, "config"))).toBe(false);
    expect(fs.readdirSync(archive).some(name => name.startsWith(".archive-write-check-"))).toBe(false);
  } finally {
    fence.release();
    worker.kill();
    await worker.exited;
  }
}, 60_000);
