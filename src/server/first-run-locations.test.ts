import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fresh database holds its first import until the first-run screen confirms the folders
// (user decision 2026-10-11); the confirmation is stored in that database, so a restart does not ask again.
async function startOnce(root: string, database: string, env: Record<string, string> = {}, confirm = false) {
  const script = path.join(root, `start-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, `import {startServer} from ${JSON.stringify(path.join(import.meta.dir, "api.ts"))};
    const running = startServer(0, ${JSON.stringify(database)});
    const base = "http://127.0.0.1:" + running.server.port;
    const status = async () => (await (await fetch(base + "/api/setup?summary=1")).json()).locations_confirmed;
    const sync = async () => (await (await fetch(base + "/api/sync")).json());
    const before = await status();
    const syncBefore = await sync();
    let confirmed = null, foreign = null;
    if (${confirm}) {
      // A simple cross-site form post and a foreign origin are refused; the app page's JSON request is accepted.
      foreign = [(await fetch(base + "/api/setup/confirm", { method: "POST" })).status,
        (await fetch(base + "/api/setup/confirm", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: "{}" })).status];
      confirmed = (await (await fetch(base + "/api/setup/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).locations_confirmed;
    }
    const after = await status();
    running.close?.();
    process.stdout.write(JSON.stringify({ before, running: Boolean(syncBefore.running), foreign, confirmed, after }));
    process.exit(0);`);
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_ARCHIVE: path.join(root, "archive"),
      TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_SYNC_MINUTES: "0", TOKENATLAS_PROBE_MINUTES: "0",
      TOKENATLAS_GEMINI_MINUTES: "0", TOKENATLAS_CONFIRM_LOCATIONS: "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`server exited ${code}: ${stderr}`);
  return JSON.parse(stdout.slice(stdout.lastIndexOf("{\"before\"")));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-first-run-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "archive"));
  fs.writeFileSync(path.join(root, "config", "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
  return { root, database: path.join(root, "atlas.sqlite") };
}

test("a fresh database waits for confirmation, then remembers it across restarts", async () => {
  const { root, database } = fixture();
  try {
    const first = await startOnce(root, database, {}, true);
    expect(first).toEqual({ before: false, running: false, foreign: [403, 403], confirmed: true, after: true });
    const restarted = await startOnce(root, database);
    expect(restarted.before).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 60_000);

test("TOKENATLAS_CONFIRM_LOCATIONS=0 starts a fresh database without waiting", async () => {
  const { root, database } = fixture();
  try {
    expect((await startOnce(root, database, { TOKENATLAS_CONFIRM_LOCATIONS: "0" })).before).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 60_000);
