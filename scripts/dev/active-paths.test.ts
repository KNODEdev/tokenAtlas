import { expect, test } from "bun:test";
import { Database } from "../../src/db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const scenario of ["new", "unfinished", "completed", "configured", "connected"] as const) {
  test(`browser readiness uses the shared first-run decision for ${scenario} installations`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-browser-readiness-"));
    const config = path.join(root, "config"), file = path.join(root, "atlas.sqlite");
    fs.mkdirSync(config);
    try {
      if (scenario === "unfinished" || scenario === "completed" || scenario === "configured") {
        const db = new Database(file);
        try {
          db.exec("CREATE TABLE sync_runs(status TEXT)");
          db.query("INSERT INTO sync_runs VALUES(?)").run(scenario === "unfinished" ? "failed" : "success");
        } finally { db.close(true); }
      }
      if (scenario === "configured" || scenario === "connected") fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
      const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "active-paths.ts"), "browser-ready"], {
        env: { ...process.env, TOKENATLAS_CONFIG: config, TOKENATLAS_DB: file }, stdout: "pipe", stderr: "pipe",
      });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, error }).toEqual({ code: 0, error: "" });
      expect(output.trim()).toBe(scenario === "completed" || scenario === "configured" ? "shell" : "setup");
      expect(fs.existsSync(file) ? fs.readFileSync(file) : null).toEqual(before);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
  });
}
