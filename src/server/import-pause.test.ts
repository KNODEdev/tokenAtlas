import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureArchiveIdentity } from "../sync/archive-inventory";

// TALK-001 D12: Pause stops the first import within moments and keeps what was published; a restart keeps it
// paused; Resume finishes it, and the result equals an import that was never interrupted, row for row.
type Phase = "reference" | "pause" | "restart" | "resume";
interface Report {
  phase: Phase; paused?: boolean; running?: boolean; atPause?: number; events?: number;
  archiveAfterStop?: number[]; eventsAfterStop?: number[]; rows?: Record<string, unknown>[];
}

const FILES = 600, LINES = 120;

async function run(root: string, phase: Phase): Promise<Report> {
  const script = path.join(root, `phase-${phase}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, `
    import { Database } from "bun:sqlite";
    import fs from "node:fs"; import path from "node:path";
    const { startServer } = await import(${JSON.stringify(path.join(import.meta.dir, "api.ts"))});
    const root = ${JSON.stringify(root)}, phase = ${JSON.stringify(phase)};
    const database = path.join(root, "atlas.sqlite");
    const running = startServer(0, database);
    const base = "http://127.0.0.1:" + running.server.port;
    const json = { "content-type": "application/json" };
    const sync = async () => await (await fetch(base + "/api/sync")).json();
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const archived = () => { let n = 0; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") && n++; };
      try { walk(path.join(root, "archive", "claude")); } catch {} return n; };
    const events = () => { try { const db = new Database(database, { readonly: true });
      try { return db.query("SELECT count(*) AS n FROM claude_events").get().n; } finally { db.close(); } } catch { return 0; } };
    const rows = () => { const db = new Database(database, { readonly: true });
      try { return db.query("SELECT * FROM claude_events ORDER BY call_id").all().map(row => Object.fromEntries(Object.entries(row)
        .filter(([key, value]) => !/path|_at$|rowid|revision/i.test(key) && !(typeof value === "string" && value.includes(root))))); }
      finally { db.close(); } };
    const complete = async () => { for (let i = 0; i < 2400; i++) { const s = await sync();
      if (!s.running && s.bootstrap?.stage === "complete" && s.bootstrap?.ok === true) return; await sleep(100); }
      throw new Error("import did not complete: " + JSON.stringify((await sync()).bootstrap)); };
    const report = { phase };
    if (phase === "reference" || phase === "pause")
      await fetch(base + "/api/setup/confirm", { method: "POST", headers: json, body: JSON.stringify({ limit_readings: false, cloud_import: false }) });
    if (phase === "reference") { await complete(); report.rows = rows(); }
    if (phase === "pause") {
      for (let i = 0; i < 600 && archived() === 0; i++) await sleep(20);
      report.atPause = archived();
      report.paused = (await (await fetch(base + "/api/sync/pause", { method: "POST", headers: json, body: JSON.stringify({ paused: true }) })).json()).paused;
      for (let i = 0; i < 100 && (await sync()).running; i++) await sleep(50);
      report.running = (await sync()).running;
      report.archiveAfterStop = [archived()]; report.eventsAfterStop = [events()];
      await sleep(3000);
      report.archiveAfterStop.push(archived()); report.eventsAfterStop.push(events());
    }
    if (phase === "restart") {
      const before = [archived(), events()];
      await sleep(4000);
      const s = await sync();
      report.paused = s.paused; report.running = s.running;
      report.archiveAfterStop = [before[0], archived()]; report.eventsAfterStop = [before[1], events()];
    }
    if (phase === "resume") {
      report.paused = (await (await fetch(base + "/api/sync/pause", { method: "POST", headers: json, body: JSON.stringify({ paused: false }) })).json()).paused;
      await complete(); report.rows = rows(); report.events = events();
    }
    running.close?.();
    process.stdout.write("REPORT" + JSON.stringify(report));
    process.exit(0);`);
  const profile = path.join(root, "profile");
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, TOKENATLAS_CONFIG: path.join(root, "config"), TOKENATLAS_ARCHIVE: path.join(root, "archive"),
      TOKENATLAS_LOCAL_STATE: path.join(root, "state"), TOKENATLAS_SYNC_MINUTES: "0", TOKENATLAS_PROBE_MINUTES: "0",
      TOKENATLAS_GEMINI_MINUTES: "0", TOKENATLAS_CLOUD_MINUTES: "0", TOKENATLAS_CONFIRM_LOCATIONS: "",
      USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"), CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", GROK_HOME: "", OneDrive: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${phase} exited ${code}: ${stderr.slice(-4000)}`);
  return JSON.parse(stdout.slice(stdout.lastIndexOf("REPORT") + 6));
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-import-pause-"));
  const profile = path.join(root, "profile");
  for (const dir of ["config", "archive", "state", "profile/AppData/Roaming", "profile/AppData/Local", "profile/.claude/projects/demo"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
  // The first-run screen creates the archive with its identity; this test starts after that step.
  ensureArchiveIdentity(path.join(root, "archive"));
  for (let file = 0; file < FILES; file++) {
    let text = "";
    for (let line = 0; line < LINES; line++) {
      const at = new Date(Date.UTC(2026, 9, 1) + (file * LINES + line) * 60_000).toISOString();
      text += JSON.stringify({ type: "assistant", sessionId: `session-${file}`, timestamp: at,
        message: { id: `msg_${file}_${line}`, model: "claude-sonnet-4-5", usage: { input_tokens: 100 + line, output_tokens: 10 + file % 7 } } }) + "\n";
    }
    const target = path.join(profile, ".claude", "projects", "demo", `session-${file}.jsonl`);
    fs.writeFileSync(target, text);
    // Finished sessions: a file written moments ago is still growing and waits for a later run.
    fs.utimesSync(target, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  }
  return root;
}
const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

test("Pause stops the first import, survives a restart, and Resume ends with the same rows as an uninterrupted import", async () => {
  const reference = fixture(), paused = fixture();
  try {
    const expected = (await run(reference, "reference")).rows!;
    expect(expected.length).toBe(FILES * LINES);

    const stop = await run(paused, "pause");
    expect(stop.paused).toBe(true);
    expect(stop.running).toBe(false);
    // Nothing new is copied or published once the import has stopped.
    expect(stop.archiveAfterStop![1]).toBe(stop.archiveAfterStop![0]);
    expect(stop.eventsAfterStop![1]).toBe(stop.eventsAfterStop![0]);
    // The pause landed mid-import, so the comparison below is not vacuous.
    expect(stop.eventsAfterStop![0]).toBeLessThan(FILES * LINES);

    const restarted = await run(paused, "restart");
    expect(restarted.paused).toBe(true);
    expect(restarted.running).toBe(false);
    expect(restarted.archiveAfterStop![1]).toBe(restarted.archiveAfterStop![0]);
    expect(restarted.eventsAfterStop![1]).toBe(restarted.eventsAfterStop![0]);

    const resumed = await run(paused, "resume");
    expect(resumed.paused).toBe(false);
    expect(resumed.rows).toEqual(expected);
  } finally { cleanup(reference); cleanup(paused); }
}, 900_000);
