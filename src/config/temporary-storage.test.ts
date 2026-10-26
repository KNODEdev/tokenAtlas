import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTemporaryWorkspace, saveTemporaryDirectory, temporaryDirectory, validateTemporaryDirectory } from "./temporary-storage";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-temp-setting-"));
  roots.push(root);
  const env = { TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_ARCHIVE: path.join(root, "archive"),
    TOKENATLAS_CONFIG: path.join(root, "config"), OneDrive: path.join(root, "cloud") };
  const database = path.join(root, "data", "atlas.sqlite");
  fs.mkdirSync(path.dirname(database)); fs.writeFileSync(database, "durable facts");
  return { root, env, database };
}

test("local selection survives restart; clearing scratch preserves facts and unfinished work", async () => {
  const f = fixture();
  const scratch = path.join(f.root, "scratch # żółć");
  expect(saveTemporaryDirectory(scratch, f.database, f.env)).toBe(scratch);
  const recovery = path.join(path.dirname(f.database), "sync-staging");
  fs.mkdirSync(recovery); fs.writeFileSync(path.join(recovery, "unfinished.sqlite"), "recovery evidence");
  const workspace = createTemporaryWorkspace("test-copy", f.database, f.env);
  expect(path.dirname(workspace.directory)).toBe(scratch);
  fs.writeFileSync(path.join(workspace.directory, "working.sqlite"), "scratch");
  workspace.dispose();
  fs.rmSync(scratch, { recursive: true });
  expect(fs.readFileSync(f.database, "utf8")).toBe("durable facts");
  expect(fs.readFileSync(path.join(recovery, "unfinished.sqlite"), "utf8")).toBe("recovery evidence");
  const child = Bun.spawn([process.execPath, "--eval", `import {temporaryDirectory} from ${JSON.stringify(path.resolve(import.meta.dir, "temporary-storage.ts"))}; console.log(temporaryDirectory(${JSON.stringify(f.database)}));`],
    { env: { ...process.env, ...f.env, TOKENATLAS_TEMP_DIR: path.join(f.root, "old-launcher-choice") }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe(scratch);
  expect(fs.existsSync(scratch)).toBe(false);
  const next = createTemporaryWorkspace("new-copy", f.database, f.env);
  expect(fs.existsSync(next.directory)).toBe(true); next.dispose();
});

test("rejects overlapping, relative, network, file and symlink locations before publishing a selection", () => {
  const f = fixture();
  const scratch = path.join(f.root, "scratch");
  saveTemporaryDirectory(scratch, f.database, f.env);
  const alias = path.join(f.root, "alias");
  fs.mkdirSync(f.env.TOKENATLAS_ARCHIVE);
  fs.symlinkSync(f.env.TOKENATLAS_ARCHIVE, alias, "junction");
  for (const candidate of [f.root, f.env.TOKENATLAS_ARCHIVE, path.join(alias, "temp"), f.env.TOKENATLAS_CONFIG,
    path.dirname(f.database), f.database, path.join(path.dirname(f.database), "sync-staging", "nested"),
    path.join(path.dirname(f.database), "atlas-index-snapshots"), f.env.TOKENATLAS_LOCAL_STATE,
    path.join(f.env.OneDrive, "temp"), "relative", "\\\\host\\share", "bad\npath"]) {
    expect(() => saveTemporaryDirectory(candidate, f.database, f.env)).toThrow();
  }
  expect(temporaryDirectory(f.database, f.env)).toBe(scratch);
  expect(() => validateTemporaryDirectory(scratch, path.join(scratch, "new.sqlite"), f.env)).toThrow();
});

test("changing scratch leaves the running workspace usable and corrupt settings fail explicitly", () => {
  const f = fixture();
  const first = createTemporaryWorkspace("first", f.database, f.env);
  const changed = path.join(f.root, "other-temp");
  saveTemporaryDirectory(changed, f.database, f.env);
  const second = createTemporaryWorkspace("second", f.database, f.env);
  expect(fs.existsSync(first.directory)).toBe(true);
  expect(path.dirname(second.directory)).toBe(changed);
  first.dispose(); second.dispose();
  fs.writeFileSync(path.join(f.env.TOKENATLAS_LOCAL_STATE, "temporary-storage.json"), "{}");
  expect(() => temporaryDirectory(f.database, f.env)).toThrow();
});
