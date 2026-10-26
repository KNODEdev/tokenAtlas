import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a manual measurement can make a rejected selected counter valid", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-manual-counter-"));
  try {
    const archive = path.join(root, "archive"), config = path.join(root, "config");
    fs.mkdirSync(archive); fs.mkdirSync(config);
    const script = path.join(import.meta.dir, "data-read-manual-counter.fixture.ts");
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_CONFIG: config,
        TOKENATLAS_LOCAL_STATE: path.join(root, "local-state"), TOKENATLAS_DB: path.join(root, "atlas.sqlite") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(stdout.trim()).toBe("PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30_000);
