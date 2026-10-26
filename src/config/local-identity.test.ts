import { Database } from "../db/sqlite";
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allocateLocalIdentity, localStateRoot } from "./local-identity";

test("local identities survive process restart, alias rename and concurrent initialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-identity-"));
  const script = path.join(root, "allocate.ts");
  fs.writeFileSync(script, `import { allocateLocalIdentity } from ${JSON.stringify(path.join(import.meta.dir, "local-identity.ts"))}; console.log(JSON.stringify(allocateLocalIdentity("cli-main","cli",{machine:process.env.ALIAS!,profile:process.env.ALIAS!})))`);
  const run = async (directory: string, alias: string) => {
    const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, TOKENATLAS_LOCAL_STATE: directory, ALIAS: alias }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0); return JSON.parse(output);
  };
  try {
    const a = path.join(root, "a"), b = path.join(root, "b");
    const initial = await Promise.all([run(a, "A"), run(a, "A"), run(a, "A")]);
    expect(initial[0]).toEqual(initial[1]); expect(initial[1]).toEqual(initial[2]);
    expect(await run(a, "renamed")).toEqual(initial[0]);
    expect((await run(b, "A")).machine_id).not.toBe(initial[0].machine_id);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
test("transferable overrides and corrupted allocator fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-corrupt-"));
  const old = process.env.TOKENATLAS_LOCAL_STATE;
  try {
    expect(() => localStateRoot({ ...process.env, TOKENATLAS_ARCHIVE: root, TOKENATLAS_LOCAL_STATE: path.join(root, "identity") })).toThrow("outside");
    process.env.TOKENATLAS_LOCAL_STATE = root;
    fs.writeFileSync(path.join(root, "identity.sqlite"), "not-sqlite");
    expect(() => allocateLocalIdentity("cli", "cli", { machine: "A", profile: "A" })).toThrow();
    expect(fs.readFileSync(path.join(root, "identity.sqlite"), "utf8")).toBe("not-sqlite");
  } finally { if (old === undefined) delete process.env.TOKENATLAS_LOCAL_STATE; else process.env.TOKENATLAS_LOCAL_STATE = old; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("established SQLite allocator corruption refuses allocation without mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-invalid-rows-"));
  const old = process.env.TOKENATLAS_LOCAL_STATE;
  try {
    for (const [index, mutation] of ["DELETE FROM local_machine", "UPDATE local_machine SET id='bad'", "UPDATE local_runtimes SET id='bad'", "UPDATE local_aliases SET entity_id='orphan' WHERE entity_id=(SELECT id FROM local_machine)"].entries()) {
      process.env.TOKENATLAS_LOCAL_STATE = path.join(root, String(index));
      allocateLocalIdentity("cli", "cli", { machine: "A", profile: "A" });
      const file = path.join(process.env.TOKENATLAS_LOCAL_STATE, "identity.sqlite");
      const db = new Database(file); db.exec(mutation); db.close();
      const before = fs.readFileSync(file);
      expect(() => allocateLocalIdentity("new", "cli", { machine: "B", profile: "B" })).toThrow("Invalid local identity state");
      expect(fs.readFileSync(file)).toEqual(before);
    }
  } finally { if (old === undefined) delete process.env.TOKENATLAS_LOCAL_STATE; else process.env.TOKENATLAS_LOCAL_STATE = old; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
