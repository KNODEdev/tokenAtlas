import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateArchiveMoveDestination } from "./archive-move";

async function run(script: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn([process.execPath, script], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exit, stdout: stdout.trim(), stderr };
}

test("a move is refused before copying when the switch would refuse it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-move-check-"));
  try {
    const source = path.join(root, "archive"), database = path.join(root, "db", "atlas.sqlite"), busy = path.join(root, "busy");
    fs.mkdirSync(source); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, "notes.txt"), "mine");
    const env = { TOKENATLAS_LOCAL_STATE: path.join(root, "state") };
    expect(() => validateArchiveMoveDestination(source, "relative", database, env)).toThrow("pełną ścieżkę");
    expect(() => validateArchiveMoveDestination(source, path.join(source, "inner"), database, env)).toThrow("poza obecnym");
    expect(() => validateArchiveMoveDestination(source, root, database, env)).toThrow("poza obecnym");
    expect(() => validateArchiveMoveDestination(source, path.join(root, "db"), database, env)).toThrow("Baza");
    expect(() => validateArchiveMoveDestination(source, busy, database, env)).toThrow("pusty");
    expect(validateArchiveMoveDestination(source, path.join(root, "new"), database, env)).toBe(path.join(root, "new"));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test("moving copies in the background, switches between processes and leaves the old folder as a copy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-move-"));
  const source = path.join(root, "archive"), destination = path.join(root, "moved"), database = path.join(root, "db", "atlas.sqlite");
  const script = path.join(root, "move.ts");
  fs.writeFileSync(script, `
    import fs from "node:fs";
    import { Database } from "bun:sqlite";
    import { ensureArchiveIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../sync/archive-inventory.ts"))};
    import { persistLocalArchiveSelection, readLocalArchiveSelection } from ${JSON.stringify(path.resolve(import.meta.dir, "../config/archive-locator.ts"))};
    import { initializeArchiveWriterIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../sync/archive-writers.ts"))};
    import { createArchiveMove } from ${JSON.stringify(path.join(import.meta.dir, "archive-move.ts"))};
    import { activateArchiveSwitch } from ${JSON.stringify(path.join(import.meta.dir, "supervisor.ts"))};
    const [source, destination, database] = [process.env.SOURCE!, process.env.DESTINATION!, process.env.DB!];
    fs.mkdirSync(source + "/codex/PC-user", { recursive: true });
    fs.writeFileSync(source + "/codex/PC-user/rollout.jsonl", '{"tokens":7}\\n');
    fs.mkdirSync(source + "/config"); fs.writeFileSync(source + "/config/accounts.json", '{"version":2,"subscriptions":[],"sources":[]}');
    initializeArchiveWriterIdentity();
    const archiveId = ensureArchiveIdentity(source);
    persistLocalArchiveSelection({ root: source, archiveId });
    fs.mkdirSync(database.replace(/[\\\\/][^\\\\/]+$/, ""), { recursive: true });
    const db = new Database(database);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO meta VALUES('archive:identity', ?)").run(archiveId); db.close();
    let requested: { jobId: string; stateDirectory: string } | null = null;
    const move = createArchiveMove({ archiveRoot: source, database, activate: (jobId, stateDirectory) => { requested = { jobId, stateDirectory }; } });
    const started = move.start(destination);
    for (let wait = 0; !requested && wait < 600; wait++) await Bun.sleep(50);
    const copied = move.status();
    if (!requested) throw new Error("copy never asked for the switch: " + JSON.stringify(copied));
    await move.close();
    const result = await activateArchiveSwitch({ type: "activate-archive", ...requested }, database);
    console.log(JSON.stringify({ started: started.job?.phase, copied: copied.job, result, selected: readLocalArchiveSelection()?.root ?? null }));
  `);
  try {
    const result = await run(script, { ...process.env, NODE_ENV: "test", TOKENATLAS_ARCHIVE: "", TOKENATLAS_CONFIG: "", TOKENATLAS_DB: "",
      TOKENATLAS_LOCAL_STATE: path.join(root, "state"), USERPROFILE: path.join(root, "home"), LOCALAPPDATA: path.join(root, "local"),
      SOURCE: source, DESTINATION: destination, DB: database });
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
    const value = JSON.parse(result.stdout.split(/\r?\n/).pop()!);
    expect(value.started).toBe("copying");
    expect(value.copied.phase).toBe("ready-to-switch");
    expect(value.copied.copiedFiles).toBe(value.copied.files);
    expect(value.result).toEqual({ jobId: expect.any(String), destination, error: null });
    expect(value.selected).toBe(destination);
    expect(fs.readFileSync(path.join(destination, "codex", "PC-user", "rollout.jsonl"), "utf8")).toBe('{"tokens":7}\n');
    expect(fs.existsSync(path.join(destination, "config", "accounts.json"))).toBe(true);
    // The old folder keeps every original as a recovery copy.
    expect(fs.readFileSync(path.join(source, "codex", "PC-user", "rollout.jsonl"), "utf8")).toBe('{"tokens":7}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 60000);
