import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("an empty Claude archive never falls back to unarchived local transcripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-claude-archive-only-"));
  const archive = path.join(root, "archive");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(archive);
  const script = `import {getStoreRoots} from ${JSON.stringify(path.resolve(import.meta.dir, "claude.ts"))}; console.log(JSON.stringify(getStoreRoots("live")));`;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env,
      USERPROFILE: home, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_MACHINE: "fixture-machine",
      TOKENATLAS_STORE_LIVE: "", TOKENATLAS_LOCAL_STATE: path.join(root, "state") }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual([path.join(archive, "claude", "fixture-machine")]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
