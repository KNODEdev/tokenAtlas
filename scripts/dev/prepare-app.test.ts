import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPreparation } from "./prepare-app";
import { atlasIndexSnapshotPool } from "../../src/config/paths";

test("serves the application and live snapshot status while preparation is blocked, then releases the port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-preparation-"));
  const publicDirectory = path.join(root, "public"), release = path.join(root, "release"), snapshot = path.join(root, "copy.sqlite");
  fs.mkdirSync(publicDirectory);
  fs.writeFileSync(path.join(publicDirectory, "index.html"), "real application bundle");
  const script = path.join(root, "prepare.ts");
  fs.writeFileSync(script, `import fs from "node:fs";
    fs.writeFileSync(${JSON.stringify(snapshot)}, new Uint8Array(2048));
    console.log('[tokenAtlas startup] '+JSON.stringify({phase:"snapshot-wait",snapshotMigrations:["0085_activity_intervals"]}));
    console.log('[tokenAtlas startup] '+JSON.stringify({phase:"snapshot-copy",snapshotFile:${JSON.stringify(snapshot)},snapshotTotalBytes:8192}));
    const signal=new Int32Array(new SharedArrayBuffer(4));
    while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(signal,0,0,20);
    console.log('[tokenAtlas startup] '+JSON.stringify({phase:"snapshot-validation",snapshotFile:${JSON.stringify(snapshot)}}));`);
  const preparation = startPreparation({ port: 0, dbPath: path.join(root, "source.sqlite"), publicDirectory,
    commands: [{ phase: "migration-check", cmd: [process.execPath, script] }] });
  const port = preparation.server.port;
  const base = `http://127.0.0.1:${port}`;
  try {
    expect(await (await fetch(base)).text()).toBe("real application bundle");
    expect((await fetch(`${base}/api/accounts`)).status).toBe(503);
    expect((await fetch(`${base}/api/startup`, { method: "POST" })).status).toBe(405);
    let status;
    const deadline = Date.now() + 5_000;
    do {
      status = await (await fetch(`${base}/api/startup`)).json();
      if (Date.now() > deadline) throw new Error("Snapshot progress was not delivered");
      if (status.phase !== "snapshot-copy") await Bun.sleep(20);
    } while (status.phase !== "snapshot-copy");
    expect(status).toMatchObject({ phase: "snapshot-copy", snapshotBytes: 2048, snapshotTotalBytes: 8192,
      snapshotMigrations: ["0085_activity_intervals"], error: null,
      snapshotDirectory: atlasIndexSnapshotPool(path.join(root, "source.sqlite")) });
    expect(fs.existsSync(path.join(root, "source.sqlite"))).toBe(false);
    fs.writeFileSync(release, "continue");
    expect(await preparation.done).toBe(0);
    const next = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ready") });
    try { expect(await (await fetch(base)).text()).toBe("ready"); } finally { next.stop(true); }
  } finally { preparation.close(); await preparation.done; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
}, 10_000);

test("retains a preparation failure in the application and never runs the following command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-preparation-failure-"));
  const marker = path.join(root, "unexpected"), publicDirectory = path.join(root, "public");
  fs.mkdirSync(publicDirectory);
  fs.writeFileSync(path.join(publicDirectory, "index.html"), "application");
  const preparation = startPreparation({ port: 0, dbPath: path.join(root, "source.sqlite"), publicDirectory,
    commands: [
      { phase: "migration-check", cmd: [process.execPath, "--eval", "console.error('safety snapshot rejected');process.exit(7)"] },
      { phase: "configuration", cmd: [process.execPath, "--eval", `await Bun.write(${JSON.stringify(marker)},'unexpected')`] },
    ] });
  try {
    expect(await preparation.done).toBe(1);
    const response = await fetch(`http://127.0.0.1:${preparation.server.port}/api/startup`);
    expect(await response.json()).toMatchObject({ phase: "failed", error: "safety snapshot rejected" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(root, "source.sqlite"))).toBe(false);
  } finally { preparation.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
