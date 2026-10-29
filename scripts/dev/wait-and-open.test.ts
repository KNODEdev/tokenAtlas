import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = test.skipIf(process.platform !== "win32");
const script = fs.readFileSync(path.join(import.meta.dir, "wait-and-open.bat"), "utf8");

for (const firstRun of [true, false]) {
  windows(`browser opening ${firstRun ? "waits through preparation handoff on a new installation" : "keeps preparation progress on an existing installation"}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-browser-start-"));
    const marker = path.join(root, "opened"), harness = path.join(root, "open.bat");
    const requests: string[] = [];
    let server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      return new Response("preparing", { status: url.pathname === "/" ? 200 : 503 });
    } });
    const port = server.port;
    fs.writeFileSync(harness, script.replace('start "" "http://127.0.0.1:%PORT%/"', 'echo opened>"%ATLAS_OPEN_MARKER%"')
      .replace(/^timeout /gm, "call timeout "));
    fs.writeFileSync(path.join(root, "timeout.cmd"), "@exit /b 0\r\n");
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    const child = Bun.spawn([process.env.ComSpec ?? "cmd.exe", "/d", "/c", harness, String(port),
      ...(firstRun ? ["setup"] : [])], {
      cwd: root, env: { ...inherited, PATH: `${root};${process.env.PATH}`, ATLAS_OPEN_MARKER: marker },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      const deadline = Date.now() + 5_000;
      while (!requests.length && Date.now() < deadline) await Bun.sleep(20);
      expect(requests[0]).toBe(firstRun ? "/api/setup?summary=1" : "/");
      if (firstRun) {
        await Bun.sleep(100);
        expect(fs.existsSync(marker)).toBe(false);
        server.stop(true);
        await Bun.sleep(150);
        expect(fs.existsSync(marker)).toBe(false);
        server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ configured: false }) });
      }
      expect(await child.exited).toBe(0);
      expect(fs.readFileSync(marker, "utf8").trim()).toBe("opened");
      await output;
    } finally {
      child.kill(); await child.exited; await output;
      server.stop(true);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 15_000);
}
