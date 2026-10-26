import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  advanceArchiveRelocation,
  readArchiveRelocation,
  startArchiveRelocation,
  type ArchiveRelocationState,
} from "./archive-relocation";
import { ensureArchiveIdentity } from "./archive-inventory";
import { allocateLocalIdentity, readLocalMachineId } from "../config/local-identity";

const temporary: string[] = [];
const inheritedLocalState = process.env.TOKENATLAS_LOCAL_STATE;
afterEach(() => {
  for (const directory of temporary.splice(0)) removeTestFixture(directory, { recursive: true, force: true });
  if (inheritedLocalState === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
  else process.env.TOKENATLAS_LOCAL_STATE = inheritedLocalState;
});

interface Fixture {
  source: string;
  destination: string;
  stateDirectory: string;
  localState: string;
  jobId: string;
  stateFile: string;
  lockFile: string;
}

function fixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-relocation-lock-"));
  temporary.push(base);
  const source = path.join(base, "source");
  const destination = path.join(base, "destination");
  const stateDirectory = path.join(base, "relocation-state");
  const localState = path.join(base, "local-state");
  // Isolate the durable machine instance before any guard reads it.
  process.env.TOKENATLAS_LOCAL_STATE = localState;
  allocateLocalIdentity("archive-relocation-lock-test", "test", { machine: "fixture", profile: "fixture-test" });
  fs.mkdirSync(path.join(source, "codex", "profile"), { recursive: true });
  fs.writeFileSync(path.join(source, "codex", "profile", "events.jsonl"), "{\"tokens\":1}\n");
  fs.writeFileSync(path.join(source, "codex", "profile", "later.jsonl"), "{\"tokens\":2}\n");
  ensureArchiveIdentity(source);
  const started = startArchiveRelocation(source, destination, { stateDirectory });
  const stateFile = path.join(stateDirectory, `${started.jobId}.json`);
  return { source, destination, stateDirectory, localState, jobId: started.jobId, stateFile, lockFile: `${stateFile}.lock` };
}

const relocationModule = JSON.stringify(path.join(import.meta.dir, "archive-relocation.ts"));

function child(code: string, localState: string) {
  return Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, TOKENATLAS_LOCAL_STATE: localState },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Kill the child exactly at the lock publication boundary, before or after the link. */
function dying(f: Fixture, exitCode: number, afterPublication: boolean): string {
  return `import fs from 'node:fs';
    const lock = ${JSON.stringify(f.lockFile)};
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      const publishing = String(to) === lock;
      if (publishing && !${afterPublication}) process.exit(${exitCode});
      const result = link(from, to);
      if (publishing) process.exit(${exitCode});
      return result;
    };`;
}

function advancingChild(f: Fixture, exitCode: number, afterPublication: boolean) {
  return child(`${dying(f, exitCode, afterPublication)}
    const { advanceArchiveRelocation } = await import(${relocationModule});
    await advanceArchiveRelocation(${JSON.stringify(f.jobId)}, { stateDirectory: ${JSON.stringify(f.stateDirectory)} });
    console.log('unexpected-completion');`, f.localState);
}

function lockArtifacts(f: Fixture): string[] {
  const prefix = path.basename(f.lockFile);
  return fs.readdirSync(f.stateDirectory).filter(name => name.startsWith(prefix)).sort();
}

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
        return text.split("\n")[0]!.trim();
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Child readiness timeout")), 30_000); }),
    ]);
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}

async function drive(f: Fixture): Promise<ArchiveRelocationState> {
  let state = readArchiveRelocation(f.stateDirectory, f.jobId);
  for (let attempt = 0; attempt < 100 && state.phase !== "ready-to-switch"; attempt++) {
    state = await advanceArchiveRelocation(f.jobId, { stateDirectory: f.stateDirectory, maxFiles: 4 });
  }
  return state;
}

test("process death at the publication boundary leaves no public lock and the job still resumes", async () => {
  const f = fixture();
  const worker = advancingChild(f, 41, false);
  try {
    expect(await worker.exited).toBe(41);
    expect(fs.existsSync(f.lockFile)).toBe(false);
    // Only private claim candidates may survive; they are never read as the public record.
    expect(lockArtifacts(f).filter(name => !name.endsWith(".claim"))).toEqual([]);
    expect(readArchiveRelocation(f.stateDirectory, f.jobId).lastError).toBeUndefined();
    const resumed = await drive(f);
    expect(resumed.phase).toBe("ready-to-switch");
    expect(lockArtifacts(f).filter(name => !name.endsWith(".claim"))).toEqual([]);
    expect(fs.readFileSync(path.join(f.destination, "codex", "profile", "events.jsonl"), "utf8")).toBe("{\"tokens\":1}\n");
  } finally { worker.kill(); await worker.exited; }
}, 60_000);

test("competing resumes of a dead local lock let exactly one process into the protected work", async () => {
  const f = fixture();
  const crashed = advancingChild(f, 43, true);
  const crashedPid = crashed.pid;
  expect(await crashed.exited).toBe(43);
  const published = JSON.parse(fs.readFileSync(f.lockFile, "utf8"));
  expect(published).toEqual({
    schema: 1,
    token: expect.any(String),
    host: os.hostname(),
    pid: crashedPid,
    machineId: readLocalMachineId(),
  });

  const code = `const { acknowledgeUncopiedRelocationDisappearance } = await import(${relocationModule});
    try {
      await acknowledgeUncopiedRelocationDisappearance(${JSON.stringify(f.jobId)}, {
        stateDirectory: ${JSON.stringify(f.stateDirectory)},
        writerFence: { runWhileAllWritersFenced: async operation => {
          console.log('entered'); await Bun.stdin.text(); return operation();
        } },
      });
    } catch (error) { console.log('refused: ' + (error && error.message)); process.exit(0); }
    console.log('released');`;
  const workers = [child(code, f.localState), child(code, f.localState)];
  try {
    const announced = await Promise.all(workers.map(firstLine));
    expect(announced.filter(line => line === "entered")).toHaveLength(1);
    const refused = announced.filter(line => line.startsWith("refused: "));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/lock/i);
    // A live local owner is never reclaimed, not even by this process.
    await expect(advanceArchiveRelocation(f.jobId, { stateDirectory: f.stateDirectory })).rejects.toThrow(/lock/i);

    workers.forEach(worker => worker.stdin.end());
    expect(await Promise.all(workers.map(worker => worker.exited))).toEqual([0, 0]);
    expect(fs.existsSync(f.lockFile)).toBe(false);
    expect(lockArtifacts(f).filter(name => name.includes(".resume-"))).toEqual([]);

    const resumed = await drive(f);
    expect(resumed.phase).toBe("ready-to-switch");
    expect(fs.readFileSync(path.join(f.destination, "codex", "profile", "later.jsonl"), "utf8")).toBe("{\"tokens\":2}\n");
    expect(fs.readFileSync(path.join(f.source, "codex", "profile", "later.jsonl"), "utf8")).toBe("{\"tokens\":2}\n");
  } finally {
    workers.forEach(worker => worker.kill());
    await Promise.all(workers.map(worker => worker.exited));
  }
}, 60_000);

test("a delayed recovery cannot enter after its dead chain was released and a new owner took the root", async () => {
  const f = fixture();
  const crashed = advancingChild(f, 45, true);
  expect(await crashed.exited).toBe(45);
  const gate = path.join(f.stateDirectory, "resume-delayed-test");
  const work = `const { acknowledgeUncopiedRelocationDisappearance } = await import(${relocationModule});
    try {
      await acknowledgeUncopiedRelocationDisappearance(${JSON.stringify(f.jobId)}, {
        stateDirectory: ${JSON.stringify(f.stateDirectory)},
        writerFence: { runWhileAllWritersFenced: async operation => {
          console.log('entered'); await Bun.stdin.text(); return operation();
        } },
      });
      console.log('released');
    } catch (error) { console.log('refused: ' + error.message); }`;
  const delayed = child(`import fs from 'node:fs';
    const link = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (String(to).includes('.resume-')) {
        console.log('delayed');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 10);
      }
      return link(from, to);
    };
    ${work}`, f.localState);
  const workers = [delayed];
  try {
    expect(await firstLine(delayed)).toBe("delayed");
    const winner = child(work, f.localState); workers.push(winner);
    expect(await firstLine(winner)).toBe("entered");
    winner.stdin.end();
    expect(await winner.exited).toBe(0);
    expect(fs.existsSync(f.lockFile)).toBe(false);
    const fresh = child(work, f.localState); workers.push(fresh);
    expect(await firstLine(fresh)).toBe("entered");
    const current = fs.readFileSync(f.lockFile, "utf8");
    fs.writeFileSync(gate, "resume");
    expect(await firstLine(delayed)).toMatch(/^refused: .*lock ownership changed/);
    expect(await delayed.exited).toBe(0);
    expect(fs.readFileSync(f.lockFile, "utf8")).toBe(current);
    fresh.stdin.end();
    expect(await fresh.exited).toBe(0);
    expect((await drive(f)).phase).toBe("ready-to-switch");
  } finally {
    workers.forEach(worker => worker.kill());
    await Promise.all(workers.map(worker => worker.exited));
  }
}, 60_000);

test("private candidate cleanup failure after publication does not strand a live job lock", async () => {
  const f = fixture();
  const worker = child(`import fs from 'node:fs';
    const unlink = fs.unlinkSync;
    fs.unlinkSync = file => {
      if (String(file).startsWith(${JSON.stringify(f.lockFile)}) && String(file).endsWith('.claim'))
        throw Object.assign(new Error('simulated sharing violation'), {code:'EPERM'});
      return unlink(file);
    };
    const { advanceArchiveRelocation } = await import(${relocationModule});
    await advanceArchiveRelocation(${JSON.stringify(f.jobId)}, {stateDirectory:${JSON.stringify(f.stateDirectory)},maxFiles:1});`, f.localState);
  const exit = await worker.exited;
  expect(exit, await new Response(worker.stderr).text()).toBe(0);
  expect(fs.existsSync(f.lockFile)).toBe(false);
  expect(lockArtifacts(f).some(name => name.endsWith(".claim"))).toBe(true);
  expect((await drive(f)).phase).toBe("ready-to-switch");
}, 60_000);

test("foreign, legacy, malformed and orphaned lock records are preserved instead of reclaimed", async () => {
  const f = fixture();
  const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  const deadPid = exited.pid;
  expect(await exited.exited).toBe(0);
  const localMachineId = readLocalMachineId();
  expect(typeof localMachineId).toBe("string");

  const preserved: [string, string][] = [
    ["another machine", JSON.stringify({ schema: 1, token: randomUUID(), host: os.hostname(), pid: deadPid, machineId: randomUUID() })],
    ["legacy host and pid", JSON.stringify({ host: os.hostname(), pid: deadPid })],
    ["malformed record", "{\"schema\":1,\"token\":"],
  ];
  for (const [label, content] of preserved) {
    fs.writeFileSync(f.lockFile, content);
    await expect(advanceArchiveRelocation(f.jobId, { stateDirectory: f.stateDirectory })).rejects.toThrow(/lock/i);
    expect(fs.readFileSync(f.lockFile, "utf8"), label).toBe(content);
    expect(lockArtifacts(f).filter(name => name.includes(".resume-")), label).toEqual([]);
    expect(readArchiveRelocation(f.stateDirectory, f.jobId).lastError, label).toBeUndefined();
  }

  fs.unlinkSync(f.lockFile);
  // An unrelated chain fragment is never swept: that name can be a competitor's live successor.
  const orphan = `${f.lockFile}.resume-${randomUUID()}.json`;
  fs.writeFileSync(orphan, JSON.stringify({ schema: 1, token: randomUUID(), host: os.hostname(), pid: deadPid, machineId: localMachineId }));
  const deadToken = randomUUID();
  fs.writeFileSync(f.lockFile, JSON.stringify({ schema: 1, token: deadToken, host: os.hostname(), pid: deadPid, machineId: localMachineId }));
  const state = await advanceArchiveRelocation(f.jobId, { stateDirectory: f.stateDirectory, maxFiles: 1, maxBytes: 1 });
  expect(state.phase).toBe("copying");
  expect(fs.existsSync(f.lockFile)).toBe(false);
  expect(fs.existsSync(`${f.lockFile}.resume-${deadToken}.json`)).toBe(false);
  expect(fs.existsSync(orphan)).toBe(true);
}, 60_000);
