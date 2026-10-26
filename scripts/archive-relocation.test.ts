import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureArchiveIdentity } from "../src/sync/archive-inventory";
import { relocationOptions, runArchiveRelocationCli } from "./archive-relocation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("relocation CLI persists progress, resumes in a fresh process and does not switch the archive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-relocation-cli-"));
  roots.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "destination"), state = path.join(root, "state");
  fs.mkdirSync(source);
  ensureArchiveIdentity(source);
  fs.writeFileSync(path.join(source, "evidence.jsonl"), '{"tokens":123}\n');
  const messages: string[] = [];
  await runArchiveRelocationCli(["start", "--from", source, "--to", destination, "--state-dir", state], line => messages.push(line));
  const started = JSON.parse(messages.at(-1)!);
  expect(started.phase).toBe("copying");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "archive-relocation.ts"),
    "run", "--job", started.jobId, "--state-dir", state], {
      env: { ...process.env, TOKENATLAS_LOCAL_STATE: path.join(root, "local"), TOKENATLAS_ARCHIVE: source, TOKENATLAS_CONFIG: path.join(source, "config") },
      stdout: "pipe", stderr: "pipe",
    });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const finished = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  expect(finished).toMatchObject({ phase: "ready-to-switch", switched: false, jobId: started.jobId });
  expect(finished.verifiedFiles).toBe(finished.files);
  expect(fs.readFileSync(path.join(destination, "evidence.jsonl"), "utf8")).toBe('{"tokens":123}\n');
  expect(fs.existsSync(path.join(source, "evidence.jsonl"))).toBe(true);
  messages.length = 0;
  await runArchiveRelocationCli(["status", "--job", started.jobId, "--state-dir", state], line => messages.push(line));
  expect(JSON.parse(messages[0]!)).toEqual(finished);
}, 30000);

test.each([
  [], ["switch", "--job", "x"], ["start", "--from", "a"],
  ["run", "--job", "x", "--from", "a"], ["run", "--job", "x", "--job", "y"],
  ["status", "--job", "x", "--state-dir"],
])("invalid relocation CLI arguments are rejected: %j", (...args) => {
  expect(() => relocationOptions(args as string[])).toThrow();
});
